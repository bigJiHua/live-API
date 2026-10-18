// Package mw 复刻 src/common/middleware 的 9 个中间件与全局内存风控状态。
package mw

import (
	"log"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/sec"
	"live/api/internal/tim"
)

// ================= 全局内存风控状态（单机 Map + mutex，对应 Node 进程内存） =================

type memStore struct {
	mu        sync.Mutex
	nonce     map[string]int64            // nonce → 过期 ms
	freq      map[string][]int64          // userId → 时间戳数组（全局限流）
	sensitive map[string][]int64          // userId → 时间戳数组（敏感操作限流）
	verified  map[string]*verifiedSession // userId → 放行窗口
	trackers  map[string]*lockTracker     // login:xxx → 登录限流
	pwTracker map[string]*pwTracker       // pw:id → 分享密码防爆
	enterLock map[string]*enterLock       // recurring 入账互斥
}

type verifiedSession struct {
	verifiedAt int64
	count      int
}

type lockTracker struct {
	count       int
	resetTime   int64
	lockedUntil int64
}

type pwTracker struct {
	count     int
	resetTime int64
	lockedTo  int64
}

type enterLock struct {
	mu   sync.Mutex
	busy bool
}

var mem = &memStore{
	nonce:     map[string]int64{},
	freq:      map[string][]int64{},
	sensitive: map[string][]int64{},
	verified:  map[string]*verifiedSession{},
	trackers:  map[string]*lockTracker{},
	pwTracker: map[string]*pwTracker{},
	enterLock: map[string]*enterLock{},
}

// MarkVerified 对应 pinSecurityGuard.markVerified：30s 放行窗口 + 清空风控计数。
func MarkVerified(userID string) {
	mem.mu.Lock()
	defer mem.mu.Unlock()
	now := tim.Now().UnixMilli()
	mem.verified[userID] = &verifiedSession{verifiedAt: now, count: 0}
	delete(mem.freq, userID)
	delete(mem.sensitive, userID)
}

// ClearVerifiedSession 对应 clearVerifiedSession(userId)。
func ClearVerifiedSession(userID string) {
	mem.mu.Lock()
	defer mem.mu.Unlock()
	delete(mem.verified, userID)
	delete(mem.freq, userID)
	delete(mem.sensitive, userID)
}

// ================= PIN 业务码与配置（对应 pinSecurityGuard.js 常量） =================

const (
	CodeNeedVerify = 8303
	CodeSuccess    = 8301
	CodeError      = 8302
	CodeLocked     = 8304

	MaxErrorCount  = 3
	LockMultiplier = 30
	PassWindowMS   = 30 * 1000
)

// 🔒 SYNC-007（2026-10-11）：PIN 风控窗口外置 env —— 与 Node 端 pinSecurityGuard.js
//
//	的 PIN_RISK_* 键名逐字对齐（原 FreqWindowMS/SensitiveWindowMS 为硬编码常量，
//	部署者无法按流量规模调参）。
//
// 🔒 SYNC-A16（2026-10-12）：这批值原为**包级变量**，在 main() 的 config.Load()
//
//	之前求值 ⇒ .env 里的 PIN_RISK_* / PIN_PASS_WINDOW / PIN_NONCE_MODE /
//	TRUST_PROXY_HOPS 全部读不到（恒为默认值），改 .env 形同虚设。
//	Node 侧是 require('dotenv').config() 之后才取值，正常生效。
//	现统一改为惰性函数，每次读取时取 env。
func freqWindowMS() int      { return envInt("PIN_RISK_FREQ_WINDOW", 60) * 1000 }
func sensitiveWindowMS() int { return envInt("PIN_RISK_SENSITIVE_WINDOW", 60) * 1000 }
func freqLimit() int         { return envInt("PIN_RISK_FREQ_LIMIT", 60) }
func sensitiveLimit() int    { return envInt("PIN_RISK_SENSITIVE_LIMIT", 10) }
func passWindowMS() int      { return envInt("PIN_PASS_WINDOW", 30) * 1000 }
func riskMode() string       { return strings.ToLower(config.Get("PIN_RISK_MODE", "enforce")) }

func envInt(k string, def int) int {
	if v := config.Get(k, ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

var sensitiveMethods = map[string]bool{"POST": true, "PUT": true, "PATCH": true, "DELETE": true}

func respond(w http.ResponseWriter, code int, message string, data any) {
	body := map[string]any{"code": code, "status": 401, "message": message}
	if data != nil {
		body["data"] = data
	}
	resp.JSON(w, 200, body)
}

// ================= authGuard（对应 authGuard.js） =================

func AuthGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 🔄 SYNC-013（2026-10-12）：改双通道取 token —— web 端（httpOnly Cookie）
		//   不发 Bearer 头，原实现将其恒判「未提供认证令牌」。口径对齐 Node
		//   authGuard.js extractToken：Bearer 优先 → Cookie finance_token 回落。
		token := ExtractAuthToken(r)
		if token == "" {
			resp.JSON(w, 200, map[string]any{"status": 401, "message": "未提供认证令牌"})
			return
		}
		claims, err := sec.Verify(jwtSecret(), token)
		if err != nil {
			if isExpiredErr(err) {
				resp.JSON(w, 200, map[string]any{"status": 401, "message": "令牌已过期"})
			} else {
				resp.JSON(w, 200, map[string]any{"status": 401, "message": "无效的认证令牌"})
			}
			return
		}
		var pwdChanged any
		err = db.DB().QueryRow("SELECT id, password_changed_at FROM user_info WHERE id = ? AND is_deleted = 0", claims.UserID).Scan(new(string), &pwdChanged)
		if err != nil {
			// 回退：不含 password_changed_at 的查询（keep 兼容旧库）
			var id string
			if err2 := db.DB().QueryRow("SELECT id FROM user_info WHERE id = ? AND is_deleted = 0", claims.UserID).Scan(&id); err2 != nil {
				resp.JSON(w, 200, map[string]any{"status": 401, "message": "用户不存在"})
				return
			}
		}
		if pwdChanged != nil && claims.IssuedAt != nil {
			switch v := pwdChanged.(type) {
			case int64:
				if claims.IssuedAt.UnixMilli() < v {
					resp.JSON(w, 200, map[string]any{"status": 401, "message": "密码已变更，请重新登录"})
					return
				}
			case []byte:
				if n, e := strconv.ParseInt(string(v), 10, 64); e == nil && claims.IssuedAt.UnixMilli() < n {
					resp.JSON(w, 200, map[string]any{"status": 401, "message": "密码已变更，请重新登录"})
					return
				}
			}
		}
		next.ServeHTTP(w, resp.WithUID(r, claims.UserID))
	})
}

// authCookieName 对齐 Node common/utils/authCookie.js 的 TOKEN_COOKIE_NAME（改了等于让所有人重新登录）。
const authCookieName = "finance_token"

// ExtractAuthToken 取请求携带的 JWT —— 双通道口径**单一来源**（SYNC-013，2026-10-12）。
//
// ## 为什么需要双通道
//   - Bearer 头：APP（原生 Kotlin）与 webview-APP 只发 Authorization 头，不带 Cookie；
//   - httpOnly Cookie：web 端 token 在 Cookie 里，JS 读不到 ⇒ XSS 窃取无效。
//
// 对齐 Node authGuard.js extractToken：Bearer 头存在但 token 为空 ⇒ 继续回落 Cookie。
//
// ⚠ AuthGuard 与 PinSecurityGuard（extractUID）必须共用本函数 —— Node 侧曾因口径
//
//	分叉（pinSecurityGuard 只认 Bearer）导致 web 用户 PIN 风控静默失效，
//	见 docs/docs/api/auth.md 末尾「2026-10-12 登录 401 风暴」事件记录。
func ExtractAuthToken(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		if t := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer ")); t != "" {
			return t
		}
	}
	if c, err := r.Cookie(authCookieName); err == nil && c.Value != "" {
		return c.Value
	}
	return ""
}

func isExpiredErr(err error) bool {
	return strings.Contains(err.Error(), "token is expired")
}

// ================= securityCheck（对应 securityCheck.js，挂 /api/v1） =================

const (
	nonceTTLMs    = 3 * 60 * 1000
	nonceMaxStore = 5000
	codeNonce     = 8401
)

var nonceRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

func nonceMode() string { return strings.ToLower(config.Get("PIN_NONCE_MODE", "enforce")) }

func SecurityCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.Contains(p, "/uploads/") || strings.Contains(p, "/temp/") || strings.Contains(p, "/share/") {
			next.ServeHTTP(w, r)
			return
		}
		// 🔒 SYNC-A3（2026-10-12）：6 处拦截文案统一回 Node 的 res.say("非法请求！", 400)
		//   （securityCheck.js:90,98,108,112,138,148）。具体原因只进日志 ——
		//   对外文案是攻击面信息（可用于区分「缺 nonce」与「时间戳过期」）。
		if r.Header.Get("x-requested-with") != "XMLHttpRequest" {
			logReject(r, "缺少/错误的 X-Requested-With")
			resp.Say(w, illegalRequest, 400)
			return
		}
		ts, _ := strconv.ParseInt(r.Header.Get("x-client-timestamp"), 10, 64)
		now := tim.Now().UnixMilli()
		if ts == 0 || abs64(now-ts) > 2*60*1000 {
			logReject(r, "时间戳校验失败")
			resp.Say(w, illegalRequest, 400)
			return
		}
		if nonceMode() != "off" {
			nonce := r.Header.Get("x-client-nonce")
			requireNonce := config.Get("REQUIRE_CLIENT_NONCE", "") == "true"
			if nonce == "" && requireNonce {
				logReject(r, "缺少 nonce")
				resp.Say(w, illegalRequest, 400)
				return
			}
			if nonce != "" && !nonceRe.MatchString(nonce) {
				logReject(r, "nonce 格式非法")
				resp.Say(w, illegalRequest, 400)
				return
			}
			if nonce != "" {
				if isNonceUsed(nonce) && nonceMode() == "enforce" {
					resp.JSON(w, 400, map[string]any{"status": 400, "code": codeNonce, "message": "请求重复提交，请稍后重试", "retryable": true})
					return
				}
				// keep BUG-051：复用被拒后仍 markNonceUsed
				markNonceUsed(nonce)
			}
		}
		ip := ClientIP(r)
		// keep BUG-050：Node 为 `if (clientIp && net.isIP(clientIp) === 0)` ——
		//   空 IP 放行，只有**非空且非法**才拒。
		if ip != "" && net.ParseIP(ip) == nil {
			logReject(r, "IP 校验失败")
			resp.Say(w, illegalRequest, 400)
			return
		}
		fp := r.Header.Get("x-fingerprint-hash")
		customUA := r.Header.Get("x-user-agent-custom")
		if fp != "" && customUA != "" && r.Header.Get("User-Agent") != customUA {
			logReject(r, "设备环境校验失败")
			resp.Say(w, illegalRequest, 400)
			return
		}
		secInfo := map[string]any{
			"ip":          ip,
			"fingerprint": fp,
			// SYNC-A3：device-model 也要有 "Unknown" 回落（securityCheck.js:155），
			//   否则缺该头时会拼出 " (Unknown)" 这种畸形描述。
			"deviceDesc": orDefault(r.Header.Get("x-device-model"), "Unknown") + " (" + orDefault(r.Header.Get("x-os-name"), "Unknown") + ")",
			"timestamp":  ts,
			"isMobile":   r.Header.Get("x-device-type") == "mobile",
		}
		// SYNC-A45: 去掉 WithUID(r, UID(r)) —— 它无条件把 keyUID 写成当前值，
		// 在本位置必为空串，等于无条件写 keyUID=""，让"谁写 uid"变成依赖挂载顺序。
		next.ServeHTTP(w, resp.WithSecurity(r, secInfo))
	})
}

// illegalRequest 对齐 Node securityCheck.js 的统一对外文案。
const illegalRequest = "非法请求！"

// logReject 复刻 Node securityCheck.js 的 6 处 console.warn —— 拦截原因只进日志。
func logReject(r *http.Request, reason string) {
	log.Printf("[securityCheck] 拦截 ip=%s path=%s 原因=%s", ClientIP(r), r.URL.Path, reason)
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// 🔒 SYNC-005（2026-10-11）：XFF 信任收敛 —— 对齐 Node 阶段 4 的 TRUST_PROXY_HOPS。
//
//	旧实现无条件取 XFF 首段 ⇒ 客户端可伪造 IP 绕过风控（PIN 限流/nonce 按伪 IP 计数）。
//	语义（对齐 Express trust proxy=N）：hops>0 且带 XFF 时取**右起第 N 个**（最近可信
//	代理报告的客户端）；hops=0 或无 XFF 时用 TCP 远端地址。
//
// 🔒 SYNC-A4（2026-10-12）两处对齐 Node：
//  1. 显式留空（""）⇒ 不信任 XFF（app.js:61 `if (RAW === "") return false`）。
//     原实现走 envInt 的空串回落默认 1 ⇒ 口径相反。
//  2. hops > len(XFF) 段数时不读 XFF，回落 socket 地址（Express 语义）。
//     原实现钳到 idx=0 ⇒ 返回客户端可伪造的最左段，正是 P1-18 要防的场景。
//
// trustProxyHops 惰性读取（SYNC-A16：包级变量在 config.Load() 之前求值，.env 读不到）。
func trustProxyHops() int { return resolveTrustProxyHops() }

// resolveTrustProxyHops 解析 TRUST_PROXY_HOPS（app.js:59-65）。
func resolveTrustProxyHops() int {
	raw := config.Raw("TRUST_PROXY_HOPS")
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 1 // 未设置 ⇒ Node 的 ?? "1"
	}
	// Node 支持 "true"/"loopback" 等 express 特殊值；Go 侧一律按「不信任」处理
	// （宁可少信 XFF，不可多信），非数字一律回落 1 并保持向后兼容。
	if n, err := strconv.Atoi(raw); err == nil {
		if n < 0 {
			return 0
		}
		return n
	}
	return 1
}

// ClientIP 取客户端真实 IP（导出供 mod/auth 等复用，避免多处实现漂移）。
func ClientIP(r *http.Request) string {
	if hops := trustProxyHops(); hops > 0 {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			idx := len(parts) - hops
			// SYNC-A4：段数不足 ⇒ XFF 不可信，回落 socket 地址（不再钳到最左段）
			if idx >= 0 {
				return strings.TrimSpace(parts[idx])
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isNonceUsed(nonce string) bool {
	mem.mu.Lock()
	defer mem.mu.Unlock()
	exp, ok := mem.nonce[nonce]
	if !ok {
		return false
	}
	if tim.Now().UnixMilli() > exp {
		delete(mem.nonce, nonce)
		return false
	}
	return true
}

func markNonceUsed(nonce string) {
	mem.mu.Lock()
	defer mem.mu.Unlock()
	now := tim.Now().UnixMilli()
	if len(mem.nonce) >= nonceMaxStore {
		for k, v := range mem.nonce {
			if now > v {
				delete(mem.nonce, k)
			}
		}
		if len(mem.nonce) >= nonceMaxStore {
			mem.nonce = map[string]int64{}
		}
	}
	mem.nonce[nonce] = now + nonceTTLMs
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
