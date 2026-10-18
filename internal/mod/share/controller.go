package share

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"live/api/internal/db"
	"live/api/internal/mod/auth"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/sec"
	"live/api/internal/tim"
)

// ============================================================================
// 分享查看控制器 —— from: modules/share/controller/index.js
// ============================================================================

// ── 密码模式防暴力破解（内存滑动窗口） ──
// keep BUG-007：tracker 键只含日记 ID（`pw:${id}`，注释写 IP+ID 实际未含 IP），维持原样。
var (
	pwMu      sync.Mutex
	pwTracker = map[string]*pwEntry{}
)

type pwEntry struct {
	count       int
	resetAt     int64 // ms
	lockedUntil int64 // ms，0 表示未锁定
}

var pwLimit = struct {
	maxAttempts int
	windowMs    int64
	lockoutMs   int64
}{maxAttempts: 5, windowMs: 60 * 1000, lockoutMs: 120 * 1000}

// cleanupTracker 对应 cleanupTracker：清理过期追踪条目。
func cleanupTracker(now int64) {
	for key, entry := range pwTracker {
		if entry.lockedUntil != 0 && now >= entry.lockedUntil {
			delete(pwTracker, key)
		} else if entry.lockedUntil == 0 && now >= entry.resetAt+pwLimit.windowMs {
			delete(pwTracker, key)
		}
	}
}

// safeJsonParse 对应 safeJsonParse(val, fallback=null)。
func safeJsonParse(val any, fallback any) any {
	s, ok := val.(string)
	if !ok || s == "" {
		return fallback
	}
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		return fallback
	}
	return v
}

// parseVis 对应 parseVis(moment)：解析 visible_type 为对象。
func parseVis(moment map[string]any) map[string]any {
	if moment == nil {
		return nil
	}
	switch t := moment["visible_type"].(type) {
	case string:
		var m map[string]any
		if err := json.Unmarshal([]byte(t), &m); err != nil {
			return nil
		}
		return m
	case map[string]any:
		return t
	}
	return nil
}

// findMomentById 对应 Moment.findById(id)：
// SELECT m.*, (children 子查询) FROM moment m WHERE m.id = ? AND m.is_deleted = 0
func findMomentById(id string) (map[string]any, error) {
	return queryRow(db.DB(), `
      SELECT m.*, 
      (SELECT GROUP_CONCAT(id ORDER BY create_time ASC) 
       FROM moment 
       WHERE parent_id = m.id AND id != m.id AND is_deleted = 0) as children
      FROM moment m 
      WHERE m.id = ? AND m.is_deleted = 0`, id)
}

// buildResponse 对应 buildResponse(moment)。
func buildResponse(moment map[string]any) map[string]any {
	authorName := "ta"
	// Node: try { User.findById } catch { fallback } —— 查询失败同样回落 "ta"
	user := auth.FindUserByID(toStr(moment["user_id"]))
	if user != nil {
		if u := toStr(user["username"]); u != "" {
			authorName = u
		} else if n := toStr(user["name"]); n != "" {
			authorName = n
		}
	}
	return map[string]any{
		"status": 200,
		"data": map[string]any{
			"id":          moment["id"],
			"content":     moment["content"],
			"img_url":     safeJsonParse(moment["img_url"], nil),
			"mood":        safeJsonParse(moment["mood"], nil),
			"location":    safeJsonParse(moment["location"], nil),
			"create_time": moment["create_time"],
			"author":      map[string]any{"name": authorName},
		},
	}
}

// sharePayload 分享 token 解密后的 payload。
type sharePayload struct {
	Did string  `json:"did"`
	Vs  float64 `json:"vs"`
	Pw  string  `json:"pw"`
	Exp float64 `json:"exp"`
}

// verifyShareToken 对应 verifyShareToken(token)：
// AES-256-GCM 解密（sec.VerifyShareToken + mw.ShareSecret），并做必填字段校验。
func verifyShareToken(token string) (sharePayload, error) {
	plain, err := sec.VerifyShareToken(mw.ShareSecret(), token)
	if err != nil {
		return sharePayload{}, err
	}
	var p sharePayload
	if err := json.Unmarshal([]byte(plain), &p); err != nil {
		return sharePayload{}, err
	}
	// 必填字段校验：!parsed.did || vs===undefined || pw===undefined || !exp
	if p.Did == "" || p.Pw == "" || p.Exp == 0 {
		return sharePayload{}, errInvalidPayload
	}
	return p, nil
}

var errInvalidPayload = &shareError{"INVALID_PAYLOAD"}

type shareError struct{ msg string }

func (e *shareError) Error() string { return e.msg }

// ViewShare GET /share/:token —— Token 模式公开查看。
// from: modules/share/controller/index.js:68-107
func ViewShare(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")

	payload, err := verifyShareToken(token)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "链接无效或已损坏"})
		return
	}

	if int64(payload.Exp) < tim.Now().UnixMilli() {
		resp.JSON(w, 200, map[string]any{"status": 410, "message": "分享链接已过期，请联系分享者重新获取"})
		return
	}

	moment, err := findMomentById(payload.Did)
	if err != nil {
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "查看分享失败"})
		return
	}
	if moment == nil || truthy(moment["is_deleted"]) {
		resp.JSON(w, 200, map[string]any{"status": 404, "message": "内容不存在或已删除"})
		return
	}

	vis := parseVis(moment)
	if vis == nil || toF(vis["vt"]) != 1 {
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "分享已关闭"})
		return
	}
	if toF(vis["vs"]) != payload.Vs {
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "链接已失效，请获取最新链接"})
		return
	}
	if toStr(vis["pw"]) != payload.Pw {
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "链接已失效，请获取最新链接"})
		return
	}

	result := buildResponse(moment)
	data := result["data"].(map[string]any)
	data["expire_at"] = time.UnixMilli(int64(payload.Exp)).UTC().Format("2006-01-02T15:04:05.000Z")
	resp.JSON(w, 200, result)
}

var pwDigitsRe = regexp.MustCompile(`^\d{6}$`)

// VerifyPassword POST /share/password —— 密码模式公开查看。body: { id, pw }
// from: modules/share/controller/index.js:115-199
func VerifyPassword(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)
	id := b.Raw["id"]
	pw := b.Raw["pw"]

	// 参数校验：!id || pw === undefined || pw === null || pw === ""
	// 🔒 SYNC-A43：id 用 JS falsy 判定（Node 是 if (!id || ...)）⇒ id=0 应被拒。
	// 旧实现 toStr(0)=="0" 非空 ⇒ 放行，多查一次库且返回 404 而非 400。
	if !truthy(id) || pw == nil || toStr(pw) == "" {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "参数不完整"})
		return
	}

	// pw 必须是 6 位数字
	if !pwDigitsRe.MatchString(toStr(pw)) {
		resp.JSON(w, 200, map[string]any{"status": 400, "message": "请输入 6 位数字密码"})
		return
	}

	// ── 防爆：速率限制（keep BUG-007：键 pw:${id}，不含 IP） ──
	trackerKey := "pw:" + toStr(id)
	now := tim.Now().UnixMilli()

	pwMu.Lock()
	entry, ok := pwTracker[trackerKey]
	if !ok || now >= entry.resetAt+pwLimit.windowMs {
		// 新窗口：重置计数
		entry = &pwEntry{count: 0, resetAt: now}
		pwTracker[trackerKey] = entry
	}
	// 是否在锁定中
	if entry.lockedUntil != 0 && now < entry.lockedUntil {
		remainSec := (entry.lockedUntil - now + 999) / 1000
		pwMu.Unlock()
		resp.JSON(w, 200, map[string]any{
			"status": 429, "message": "尝试次数过多，请 " + strconv.FormatInt(remainSec, 10) + " 秒后再试",
			"retryAfter": remainSec,
		})
		return
	}
	pwMu.Unlock()

	// 失败计数助手（对应每处 entry.count++ / >= maxAttempts 置锁）
	fail := func() {
		pwMu.Lock()
		entry.count++
		if entry.count >= pwLimit.maxAttempts {
			entry.lockedUntil = now + pwLimit.lockoutMs
		}
		pwMu.Unlock()
	}

	// ── 查询日记 ──
	moment, err := findMomentById(toStr(id))
	if err != nil {
		fail()
		resp.JSON(w, 200, map[string]any{"status": 500, "message": "验证失败"})
		return
	}
	if moment == nil || truthy(moment["is_deleted"]) {
		fail()
		resp.JSON(w, 200, map[string]any{"status": 404, "message": "内容不存在或已删除"})
		return
	}

	vis := parseVis(moment)
	if vis == nil || toF(vis["vt"]) != 1 {
		fail()
		resp.JSON(w, 200, map[string]any{"status": 403, "message": "分享已关闭或链接无效"})
		return
	}

	// 比对密码
	if toStr(vis["pw"]) != toStr(pw) {
		pwMu.Lock()
		entry.count++
		locked := entry.count >= pwLimit.maxAttempts
		if locked {
			entry.lockedUntil = now + pwLimit.lockoutMs
		}
		entryCount := entry.count
		pwMu.Unlock()
		if locked {
			resp.JSON(w, 200, map[string]any{
				"status": 429, "message": "密码错误次数过多，请 " + strconv.FormatInt(pwLimit.lockoutMs/1000, 10) + " 秒后再试",
				"retryAfter": pwLimit.lockoutMs / 1000,
			})
			return
		}
		resp.JSON(w, 200, map[string]any{
			"status": 403, "message": "密码错误，还剩 " + strconv.Itoa(pwLimit.maxAttempts-entryCount) + " 次机会",
		})
		return
	}

	// 验证通过 → 清除追踪记录
	pwMu.Lock()
	delete(pwTracker, trackerKey)
	// 清理过期条目（Map 超过 500 时触发）
	if len(pwTracker) > 500 {
		cleanupTracker(now)
	}
	pwMu.Unlock()

	resp.JSON(w, 200, buildResponse(moment))
}

// ===== 助手 =====

func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	}
	return ""
}

// toF 对应 parseFloat(x) || 0。
func toF(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0
		}
		return f
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	case bool:
		if t {
			return 1
		}
		return 0
	}
	return 0
}

// truthy 对应 JS 真值（is_deleted 判断）。
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != "" && t != "0"
	case float64:
		return t != 0
	case int64:
		return t != 0
	}
	return true
}

// queryRow 查询首行；无行返回 (nil, nil)。
func queryRow(ex db.Commiter, query string, args ...any) (map[string]any, error) {
	rows, err := ex.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		return nil, rows.Err()
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	m := make(map[string]any, len(cols))
	for i, c := range cols {
		m[c] = normVal(vals[i])
	}
	return m, rows.Err()
}

// normVal []byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}
