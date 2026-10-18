package mw

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/sec"
	"live/api/internal/tim"
)

// ================= pinSecurityGuard（对应 pinSecurityGuard.js，678 行的复刻） =================

// memorySweepInterval / memoryMapMax 对应 Node pinSecurityGuard.js:93-99 的
// MEMORY_SWEEP_INTERVAL_MS / MEMORY_MAP_MAX（🔄 2026-10-13 api.md P3-3）：
// freqMap/sensitiveMap/verifiedMap 原实现只写不删（滑动窗口 filter 只清数组内时间戳，
// key 永驻）⇒ 长期运行随用户量线性增长。每 10 分钟清理一次过期 key；
// 条目数超 5000 时整体重置（宁可短暂放宽，不无限增长）。
const (
	memorySweepInterval = 10 * 60 * 1000
	memoryMapMax        = 5000
)

// sweepRiskMaps 对应 Node sweepRiskMaps：清理过期 key + 超量整体重置。
func sweepRiskMaps() {
	mem.mu.Lock()
	defer mem.mu.Unlock()
	now := tim.Now().UnixMilli()
	freqWindow := int64(freqWindowMS())
	for _, m := range []map[string][]int64{mem.freq, mem.sensitive} {
		for key, arr := range m {
			if len(arr) == 0 || now-arr[len(arr)-1] > freqWindow {
				delete(m, key)
			}
		}
	}
	passWindow := int64(passWindowMS())
	for key, s := range mem.verified {
		if now-s.verifiedAt > passWindow {
			delete(mem.verified, key)
		}
	}
	if len(mem.freq)+len(mem.sensitive)+len(mem.verified) > memoryMapMax {
		mem.freq = map[string][]int64{}
		mem.sensitive = map[string][]int64{}
		mem.verified = map[string]*verifiedSession{}
	}
}

func init() {
	// 🔄 2026-10-13（api.md P3-3）：内存 Map 定期回收（对应 Node setInterval(sweepRiskMaps, 10min).unref()）。
	go func() {
		ticker := time.NewTicker(memorySweepInterval * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			sweepRiskMaps()
		}
	}()
}

// PinSecurityGuard 全局 PIN 风控与锁检查。内存态单机（keep BUG-052）。
func PinSecurityGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// 跳过：handshake / lock-system / /security/pin/ / /api/public/
		if strings.Contains(path, "/handshake") || strings.Contains(path, "/lock-system") ||
			strings.Contains(path, "/security/pin/") || strings.Contains(path, "/api/public/") {
			next.ServeHTTP(w, r)
			return
		}
		// 未登录 → next（🔄 SYNC-013：双通道取 token，web Cookie 通道用户不再被漏判）
		uid := extractUID(r)
		if uid == "" {
			next.ServeHTTP(w, r)
			return
		}
		// 未设 PIN → next
		var pinCode *string
		if err := db.DB().QueryRow("SELECT pin_code FROM user_info WHERE id = ? LIMIT 1", uid).Scan(&pinCode); err != nil || pinCode == nil || *pinCode == "" {
			next.ServeHTTP(w, r)
			return
		}
		defer func() {
			if rec := recover(); rec != nil {
				// fail-closed：已登录且已设 PIN 的异常 → 503
				resp.JSON(w, 503, map[string]any{"status": 503, "message": "安全校验异常，请稍后重试"})
			}
		}()
		handlePinGuard(w, r, next, uid, path)
	})
}

// handlePinGuard 主分支逻辑。
func handlePinGuard(w http.ResponseWriter, r *http.Request, next http.Handler, uid, path string) {
	now := tim.Now().UnixMilli()

	// 读取最新记录（非 route_verify）
	var (
		latestID      int64
		latestStatus  int
		latestErrCnt  int
		latestAction  string
		latestCreated time.Time
	)
	err := db.DB().QueryRow(
		"SELECT id, pin_status, error_count, action_type, create_time FROM security_verify_log WHERE user_id = ? AND action_type <> 'route_verify' ORDER BY id DESC LIMIT 1", uid).
		Scan(&latestID, &latestStatus, &latestErrCnt, &latestAction, &latestCreated)
	hasLatest := err == nil

	// 分支1：硬锁 pin_status=3
	if hasLatest && latestStatus == 3 {
		lockMinutes := int64(latestErrCnt)
		if lockMinutes <= 0 {
			lockMinutes = 1
		}
		// keep BUG-054：DB create_time vs 进程 now 双时钟源
		expire := latestCreated.UnixMilli() + lockMinutes*LockMultiplier*60000
		if now < expire {
			remain := (expire - now + 59999) / 60000
			respond(w, CodeLocked, "系统已锁定，请在 "+strconv.FormatInt(remain, 10)+" 分钟后重试", map[string]any{"locked": true})
			return
		}
		// 已过期：必须带 PIN 重验
		pin := extractPinFromBody(r)
		if pin == "" {
			respond(w, CodeNeedVerify, "系统已锁定，请验证 PIN", map[string]any{"locked": true})
			return
		}
		if !verifyUserPin(uid, pin) {
			// keep：重锁固定 error_count=3 → 90 分钟
			_, _ = db.DB().Exec("UPDATE security_verify_log SET remark = CONCAT(remark, ';已重新锁定') WHERE id = ?", latestID)
			_, _ = db.DB().Exec(
				"INSERT INTO security_verify_log (user_id, request_url, action_type, pin_status, error_count, remark, create_time) VALUES (?, ?, 'verify', 3, 3, '锁定90分钟', NOW())",
				uid, "/lock-system")
			respond(w, CodeLocked, "系统已锁定，请在 90 分钟后重试", map[string]any{"locked": true})
			return
		}
		_, _ = db.DB().Exec("UPDATE security_verify_log SET pin_status = 1, remark = '系统已解锁' WHERE id = ?", latestID)
		MarkVerified(uid)
		next.ServeHTTP(w, r)
		return
	}

	// 分支1.5：软锁 action_type='lock' && pin_status=0
	if hasLatest && latestAction == "lock" && latestStatus == 0 {
		if matchProtected(r.Method, path) {
			next.ServeHTTP(w, r)
			return
		}
		pin := extractPinFromBody(r)
		if pin == "" {
			respond(w, CodeNeedVerify, "操作受限，请验证 PIN", map[string]any{"locked": true})
			return
		}
		// 带 PIN 落入下方通用流程
	}

	// token 头存在 → next（pinLockGuard 消费）
	if r.Header.Get("x-route-verify-token") != "" {
		next.ServeHTTP(w, r)
		return
	}
	if strings.Contains(path, "/security/pin/route-verify") {
		next.ServeHTTP(w, r)
		return
	}
	if matchProtected(r.Method, path) {
		if !hasLatest || latestStatus == 1 || latestStatus == 3 {
			next.ServeHTTP(w, r) // 交 pinLockGuard
			return
		}
	}

	// 分支2：!latest 或 status ∈ {0,2}
	if !hasLatest || latestStatus == 0 || latestStatus == 2 {
		if matchProtected(r.Method, path) {
			next.ServeHTTP(w, r)
			return
		}
		if inPassWindow(uid) {
			next.ServeHTTP(w, r)
			return
		}
		if !hasLatest {
			insertPendingRecord(uid, path)
		}
		pin := extractPinFromBody(r)
		if pin != "" {
			if verifyUserPin(uid, pin) {
				markSuccess(uid)
				MarkVerified(uid)
				next.ServeHTTP(w, r)
				return
			}
			cnt := latestErrCnt + 1
			if cnt >= MaxErrorCount {
				markLocked(uid, cnt)
				respond(w, CodeLocked, "PIN 错误次数过多，已锁定90分钟", map[string]any{"locked": true})
				return
			}
			markFailed(uid, cnt)
			respond(w, CodeError, "PIN 错误", map[string]any{"locked": true})
			return
		}
		respond(w, CodeNeedVerify, "请输入 PIN", map[string]any{"needVerify": true})
		return
	}

	// 分支3：status=1 已放行
	if strings.Contains(path, "/security/pin/check") {
		next.ServeHTTP(w, r)
		return
	}
	if inPassWindow(uid) {
		mem.mu.Lock()
		s := mem.verified[uid]
		s.count++
		over := s.count >= freqLimit()
		mem.mu.Unlock()
		if over && riskMode() == "enforce" {
			ensurePendingRecord(uid, path)
			mem.mu.Lock()
			delete(mem.verified, uid)
			mem.mu.Unlock()
			respond(w, CodeNeedVerify, "请求过多，请重新验证", nil)
			return
		}
		next.ServeHTTP(w, r)
		return
	}
	// 窗口外：滑动窗口风控
	mem.mu.Lock()
	delete(mem.verified, uid)
	if riskMode() != "off" {
		win := slidingWindowAppend(&mem.freq, uid, now, int64(freqWindowMS()))
		freqOver := win >= freqLimit()
		var sensOver bool
		if sensitiveMethods[r.Method] {
			sensOver = slidingWindowAppend(&mem.sensitive, uid, now, int64(sensitiveWindowMS())) >= sensitiveLimit()
		}
		mem.mu.Unlock()
		if (freqOver || sensOver) && riskMode() == "enforce" {
			ensurePendingRecord(uid, path)
			respond(w, CodeNeedVerify, "触发安全验证", map[string]any{"reason": "risk_control"})
			return
		}
	} else {
		mem.mu.Unlock()
	}
	next.ServeHTTP(w, r)
}

func inPassWindow(uid string) bool {
	mem.mu.Lock()
	defer mem.mu.Unlock()
	s, ok := mem.verified[uid]
	if !ok {
		return false
	}
	if tim.Now().UnixMilli()-s.verifiedAt > int64(passWindowMS()) {
		delete(mem.verified, uid) // keep：过期不续期，直接失效
		return false
	}
	return true
}

func slidingWindowAppend(m *map[string][]int64, uid string, now, window int64) int {
	arr := (*m)[uid]
	kept := arr[:0]
	for _, t := range arr {
		if now-t < window {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	(*m)[uid] = kept
	return len(kept)
}

func insertPendingRecord(uid, path string) {
	_, _ = db.DB().Exec(
		"INSERT INTO security_verify_log (user_id, request_url, action_type, pin_status, error_count, remark, create_time) VALUES (?, ?, 'verify', 0, 0, '待验证', NOW())",
		uid, path)
}

func ensurePendingRecord(uid, path string) {
	var cnt int
	_ = db.DB().QueryRow(
		"SELECT COUNT(*) FROM security_verify_log WHERE user_id = ? AND pin_status = 0 AND action_type <> 'route_verify'", uid).Scan(&cnt)
	if cnt > 0 {
		return
	}
	insertPendingRecord(uid, path)
}

func markSuccess(uid string) {
	_, _ = db.DB().Exec(
		"UPDATE security_verify_log SET pin_status = 1, error_count = 0, remark = '验证成功' WHERE user_id = ? AND pin_status IN (0, 2) AND action_type <> 'route_verify' ORDER BY id DESC LIMIT 1", uid)
	_, _ = db.DB().Exec(
		"UPDATE security_verify_log SET pin_status = 1, remark = '系统已解锁' WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0", uid)
}

func markFailed(uid string, cnt int) {
	_, _ = db.DB().Exec(
		"UPDATE security_verify_log SET pin_status = 2, error_count = ?, remark = CONCAT('验证失败第', ?, '次') WHERE user_id = ? AND pin_status IN (0, 2) AND action_type <> 'route_verify' ORDER BY id DESC LIMIT 1",
		cnt, cnt, uid)
}

func markLocked(uid string, cnt int) {
	_, _ = db.DB().Exec(
		"UPDATE security_verify_log SET pin_status = 3, error_count = ?, remark = CONCAT('锁定', ?, '分钟') WHERE user_id = ? AND pin_status IN (0, 2) AND action_type <> 'route_verify' ORDER BY id DESC LIMIT 1",
		cnt, cnt*LockMultiplier, uid)
}

func verifyUserPin(uid, pin string) bool {
	var hash *string
	if err := db.DB().QueryRow("SELECT pin_code FROM user_info WHERE id = ? LIMIT 1", uid).Scan(&hash); err != nil || hash == nil {
		return false
	}
	return bcryptCheck(*hash, pin)
}

// extractPinFromBody 从请求体 data.pin 取 PIN（明文或 RSA 数组解密）。
func extractPinFromBody(r *http.Request) string {
	b := resp.Parse(r)
	if !b.Has("data.pin") {
		return ""
	}
	raw := b.Map("data")
	_ = raw
	pin := resolvePinValue(b.Raw["data"])
	return pin
}

// resolvePinValue 对应 rsaKeys.resolvePassword + 6 位数字校验。
func resolvePinValue(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		p, _ := t["pin"]
		return resolvePinValue(p)
	case []any:
		var strs []string
		for _, e := range t {
			if s, ok := e.(string); ok {
				strs = append(strs, s)
			}
		}
		s := sec.DecryptChars(strs)
		return s
	}
	return ""
}

// ================= pinLockGuard（对应 pinLockGuard.js） =================

const (
	routeActionType = "route_verify"
	routeHeaderName = "x-route-verify-token"
	routeTokenPfx   = "route-token:"
	routeExpireMin  = 5
)

// protectedRoutes 风险路由注册表。
// fix（原 B3 鸡生蛋）：Node 版靠首次执行时自动注册，Go 版在启动时静态声明。
var (
	protectedMu       sync.Mutex
	protectedRegistry []protectedRoute
)

type protectedRoute struct {
	method string
	re     *routePattern
}

type routePattern struct {
	raw string
}

// RegisterProtectedRoute 声明风险路由（在模块 Register 时调用）。
// pattern 如 "/api/v1/card/:id"（:x 为单段参数）。
func RegisterProtectedRoute(method, pattern string) {
	protectedMu.Lock()
	defer protectedMu.Unlock()
	protectedRegistry = append(protectedRegistry, protectedRoute{method: method, re: compileRoutePattern(pattern)})
}

func compileRoutePattern(pattern string) *routePattern {
	// :param → [^/]+ ，其余正则转义
	var sb strings.Builder
	sb.WriteString("^")
	for _, seg := range strings.Split(pattern, "/") {
		sb.WriteString("/")
		if strings.HasPrefix(seg, ":") {
			sb.WriteString("[^/]+")
		} else {
			sb.WriteString(regexpQuoteMeta(seg))
		}
	}
	sb.WriteString("/?$")
	return &routePattern{raw: sb.String()}
}

func regexpQuoteMeta(s string) string {
	const special = `\.+*?()|[]{}^$`
	var sb strings.Builder
	for _, c := range s {
		if strings.ContainsRune(special, c) {
			sb.WriteByte('\\')
		}
		sb.WriteRune(c)
	}
	return sb.String()
}

// MatchProtected 去 query 后匹配方法+路径（供 pinSecurityGuard 调用）。
func MatchProtected(method, path string) bool {
	protectedMu.Lock()
	defer protectedMu.Unlock()
	p := path
	if i := strings.Index(p, "?"); i >= 0 {
		p = p[:i]
	}
	p = strings.TrimRight(p, "/")
	if p == "" {
		p = "/"
	}
	for _, pr := range protectedRegistry {
		if pr.method != method {
			continue
		}
		if matchRouteRE(pr.re.raw, p) {
			return true
		}
	}
	return false
}

func matchRouteRE(pattern, path string) bool {
	re, err := compileRegexpCache(pattern)
	if err != nil {
		return false
	}
	return re.MatchString(path)
}

// PinLockGuard 风险路由中间件：无 token → challenge+8303；token → 原子核销。
func PinLockGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid := resp.UID(r)
		if uid == "" {
			next.ServeHTTP(w, r)
			return
		}
		var pinCode *string
		if err := db.DB().QueryRow("SELECT pin_code FROM user_info WHERE id = ? LIMIT 1", uid).Scan(&pinCode); err != nil || pinCode == nil || *pinCode == "" {
			next.ServeHTTP(w, r) // 未设 PIN 放行
			return
		}
		bodyHash := requestBodyHash(r)
		method := strings.ToUpper(r.Method)
		// 🔒 SYNC-A42（2026-10-13）：request_url 必须用 **RequestURI**（path + query），
		// 对齐 Node `normalizeUrl(req) = req.originalUrl || req.baseUrl + req.path || req.path`。
		// 旧实现用 r.URL.Path（**不含 query**）⇒ 带 query 的风险路由
		//（如 DELETE /api/v1/resource/:id?force=1）签发的 challenge 与前端回传的
		// requestUrl 不一致 ⇒ VerifyRoutePin 的 `AND request_url = ?` 匹配不到
		// ⇒ 直接返回「风险验证已过期」。
		// 注意：路由**匹配**仍用 r.URL.Path（见上方跳过判断与 protectedRoutes），此处只影响落库/回传。
		origURL := r.RequestURI
		if origURL == "" {
			origURL = r.URL.Path
		}
		token := r.Header.Get(routeHeaderName)
		if token != "" {
			// 🔒 remark 改为**明文**（Node pinLockGuard.js:32-34 就是明文拼串），
			// 见 security/controller.go 的 tokenRemark 注释。
			tokenRemark := routeTokenPfx + method + ":" + bodyHash + ":" + sec.SHA256Hex([]byte(token))
			res, err := db.DB().Exec(
				"UPDATE security_verify_log SET pin_status = 1, remark = '已验证并已使用' WHERE user_id = ? AND request_url = ? AND action_type = ? AND pin_status = 1 AND verify_expire_time > NOW() AND remark = ? ORDER BY id DESC LIMIT 1",
				uid, origURL, routeActionType, tokenRemark)
			if err == nil && rowsAffected(res) > 0 {
				next.ServeHTTP(w, r) // 一次性核销
				return
			}
			challengeID := getOrCreateChallenge(uid, origURL, method, bodyHash)
			respond(w, CodeNeedVerify, "风险操作验证已失效，请重新验证", map[string]any{
				"action_type": routeActionType, "challengeId": challengeID,
				"requestUrl": origURL, "method": method, "reason": "invalid_token",
			})
			return
		}
		challengeID := getOrCreateChallenge(uid, origURL, method, bodyHash)
		respond(w, CodeNeedVerify, "风险操作需要验证 PIN", map[string]any{
			"action_type": routeActionType, "challengeId": challengeID,
			"requestUrl": origURL, "method": method,
		})
	})
}

func getOrCreateChallenge(uid, url, method, bodyHash string) int64 {
	var id int64
	err := db.DB().QueryRow(
		"SELECT id FROM security_verify_log WHERE user_id = ? AND request_url = ? AND action_type = ? AND pin_status IN (0, 2) AND verify_expire_time > NOW() AND remark LIKE ? AND remark LIKE ? ORDER BY id DESC LIMIT 1",
		uid, url, routeActionType, "method:"+method+";%", "%body:"+bodyHash+"%").Scan(&id)
	if err == nil {
		return id
	}
	res, err := db.DB().Exec(
		"INSERT INTO security_verify_log (user_id, request_url, action_type, pin_status, error_count, verify_expire_time, remark, create_time) VALUES (?, ?, ?, 0, 0, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, NOW())",
		uid, url, routeActionType, routeExpireMin, "method:"+method+";body:"+bodyHash+";待验证")
	if err != nil {
		return 0
	}
	id, _ = lastInsertID(res)
	return id
}

// RequestBodyHash 对应 requestBodyHash：sha256(stableStringify(req.body.data ?? null))。
func requestBodyHash(r *http.Request) string {
	b := resp.Parse(r)
	var v any
	if len(b.Data) > 0 {
		v = b.Data
	}
	return sec.SHA256Hex([]byte(stableStringify(v)))
}

// stableStringify 递归按键排序的 JSON 序列化（对应 stableStringify.js）。
func stableStringify(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var sb strings.Builder
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(jsonQuote(k))
			sb.WriteByte(':')
			sb.WriteString(stableStringify(t[k]))
		}
		sb.WriteByte('}')
		return sb.String()
	case []any:
		var sb strings.Builder
		sb.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(stableStringify(e))
		}
		sb.WriteByte(']')
		return sb.String()
	case string:
		return jsonQuote(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return "null"
}

func jsonQuote(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, c := range s {
		switch c {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			sb.WriteRune(c)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// extractUID 不依赖 AuthGuard 提前解析请求中的 userId（对应 pinSecurityGuard 的验签）。
// 🔄 SYNC-013（2026-10-12）：原 extractBearerUID 只认 Bearer 头 —— P0-5 改造后 web
//
//	只带 httpOnly Cookie，web 登录用户在这里恒判「未登录」直接放行，PIN 风控对 web
//	静默失效（Node 同款问题当天已修）。改用 ExtractAuthToken 双通道，口径单一来源。
func extractUID(r *http.Request) string {
	token := ExtractAuthToken(r)
	if token == "" {
		return ""
	}
	claims, err := sec.Verify(jwtSecret(), token)
	if err != nil || claims == nil {
		return ""
	}
	return claims.UserID
}
