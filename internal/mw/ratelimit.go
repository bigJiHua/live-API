package mw

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"runtime/debug"

	"live/api/internal/db"
	"live/api/internal/resp"
)

// ================= accountLockCheck（对应 accountLockCheck.js，挂 /auth/login） =================
//
// 🔒 SYNC-001/002（2026-10-11）：对齐 Node 阶段 3 的失败驱动重写。
//
// ## 改造前（keep BUG-052 时代）的行为
// **请求驱动**：每收到一次 /login 就 count++（在密码校验之前）⇒
// 正常用户一分钟连点 10 次也被锁，而真正的暴破反而不受额外惩罚。
//
// ## 现在的行为（与 Node accountLockCheck.js 逐语义对齐）
// - **失败驱动**：只有「用户不存在」或「密码错误」才计数（controller 在确认失败后
//   调 RecordLoginFailure）；查得到用户的正常路径不计数。
// - **key 归一化**：trim + 小写（防 Admin/admin/空格变体绕过）。
// - 阈值：15 分钟内失败 5 次 ⇒ 锁 15 分钟；登录成功即 ClearLoginFailures。
// - 用户不存在**同样计数**（撞库探测也要限），但响应与「密码错误」**逐字一致**（P1-14）。
// - 计数保存在进程内存（对齐 R-3 单实例约束，与 Node 同取舍，不落库）。

const (
	// GenericAuthError / GenericAuthStatus 防枚举统一响应（SYNC-002）：
	// 「用户不存在」与「密码错误」必须完全同构，且都不能暴露账号是否存在。
	GenericAuthError  = "账号或密码错误"
	GenericAuthStatus = 404

	loginMaxFailures = 5              // 连续失败阈值
	loginWindowMS    = 15 * 60 * 1000 // 统计窗口
	loginLockoutMS   = 15 * 60 * 1000 // 锁定时长
)

// loginKey 归一化失败计数的 key（防大小写/空格变体绕过）。
func loginKey(nameOrEmail string) string {
	return strings.ToLower(strings.TrimSpace(nameOrEmail))
}

// LoginFailure 一次失败计数的结果。
type LoginFailure struct {
	Locked      bool
	RemainingMS int64 // 锁定剩余毫秒（Locked=true 时有效）
}

// RecordLoginFailure 记录一次登录失败（**由 controller 在确认密码错误/账号不存在后调用**）。
// 达到阈值 ⇒ 锁定并返回剩余时长；未达阈值只计数。
func RecordLoginFailure(nameOrEmail string) LoginFailure {
	key := loginKey(nameOrEmail)
	if key == "" {
		return LoginFailure{}
	}
	mem.mu.Lock()
	defer mem.mu.Unlock()
	now := time.Now().UnixMilli()
	t := mem.trackers["login:"+key]
	if t == nil || now > t.resetTime {
		t = &lockTracker{count: 0, resetTime: now + loginWindowMS}
		mem.trackers["login:"+key] = t
	}
	// 锁定已到期 ⇒ 清零重给满额度
	if t.lockedUntil != 0 && now >= t.lockedUntil {
		t.lockedUntil = 0
		t.count = 0
		t.resetTime = now + loginWindowMS
	}
	t.count++
	if t.count >= loginMaxFailures {
		t.lockedUntil = now + loginLockoutMS
		// 计数条目过多时清理（对齐 Node sweepIfNeeded 时机：失败计数后）
		if len(mem.trackers) > 1000 {
			for k, v := range mem.trackers {
				if now > v.resetTime && (v.lockedUntil == 0 || now >= v.lockedUntil) {
					delete(mem.trackers, k)
				}
			}
		}
		return LoginFailure{Locked: true, RemainingMS: loginLockoutMS}
	}
	return LoginFailure{}
}

// ClearLoginFailures 登录成功 ⇒ 清零该账号失败计数（否则额度被成功登录占用）。
func ClearLoginFailures(nameOrEmail string) {
	mem.mu.Lock()
	delete(mem.trackers, "login:"+loginKey(nameOrEmail))
	mem.mu.Unlock()
}

// loginLockedRemaining 该账号锁定期剩余毫秒（0 = 未锁定）。
func loginLockedRemaining(nameOrEmail string) int64 {
	key := loginKey(nameOrEmail)
	if key == "" {
		return 0
	}
	mem.mu.Lock()
	defer mem.mu.Unlock()
	now := time.Now().UnixMilli()
	t := mem.trackers["login:"+key]
	if t == nil || t.lockedUntil == 0 || now >= t.lockedUntil {
		return 0
	}
	return t.lockedUntil - now
}

func AccountLockCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := resp.Parse(r)
		// SYNC-A9（2026-10-12）：Node 只读 req.body.data.nameOrEmail（accountLockCheck.js:147），
		//   不接受顶层回落。保持一致，避免放行 Node 会拒的请求形态。
		nameOrEmail := b.Str("data.nameOrEmail")
		if nameOrEmail == "" {
			resp.Say(w, "非法未知参数请求！", 401)
			return
		}

		// 1) 失败锁定检查：锁定期内直接 423，**不再计数也不再查库**
		//    （旧实现每请求都 count++，正常用户先撞锁）
		if remain := loginLockedRemaining(nameOrEmail); remain > 0 {
			sec := (remain + 999) / 1000
			resp.JSON(w, 423, map[string]any{
				"status":  423,
				"message": "登录失败次数过多，请 " + strconv.FormatInt(sec, 10) + " 秒后重试",
				"locked":  true,
			})
			return
		}

		// 2) 查用户
		//    SYNC-A9：Node 是 findByEmail **再** findByUsername 的两条串行查询
		//    （accountLockCheck.js:163-165，邮箱优先）。原 Go 合成一条 OR 查询，
		//    命中哪一行由优化器决定 —— 当 A 的用户名 == B 的邮箱时会与 Node 不同，
		//    导致后续 controller 的邮箱优先查找口径也对不上。改为同序两条查询。
		var (
			id         string
			status     int
			updateTime string
		)
		found := false
		// keep：Node 的 findByEmail/findByUsername 是 `SELECT *` **不过滤 is_deleted**
		//   （model/user.js:24,36），此处照搬，不加软删条件。
		err := db.DB().QueryRow("SELECT id, status, update_time FROM user_info WHERE email = ? LIMIT 1", nameOrEmail).
			Scan(&id, &status, &updateTime)
		if err == nil {
			found = true
		} else {
			err = db.DB().QueryRow("SELECT id, status, update_time FROM user_info WHERE username = ? LIMIT 1", nameOrEmail).
				Scan(&id, &status, &updateTime)
			if err == nil {
				found = true
			}
		}
		if !found {
			// 3) 账号不存在 ⇒ 计数（撞库探测也要限）+ 与「密码错误」**逐字一致**的响应（P1-14）。
			//    SYNC-A9：Node 此处**无条件**返回 GENERIC_AUTH_ERROR（不判 Locked），
			//    原 Go 在达到阈值时改返 423 ⇒ 两条路径响应不同构，
			//    攻击者可用响应码差异区分「账号存在但密码错」与「账号不存在」，破坏防枚举。
			RecordLoginFailure(nameOrEmail)
			resp.Say(w, GenericAuthError, GenericAuthStatus)
			return
		}

		// 4) 管理员锁定状态（12 小时自动解锁）—— 原行为保留
		now := time.Now().UnixMilli()
		if status == 0 {
			unlockAt := parseMSOrDefault(updateTime) + 12*3600*1000
			if now < unlockAt {
				hours := (unlockAt - now + 3599999) / 3600000
				resp.JSON(w, 423, map[string]any{"status": 423, "message": "账户已被锁定，请在 " + strconv.FormatInt(hours, 10) + " 小时后重试", "locked": true})
				return
			}
			_, _ = db.DB().Exec("UPDATE user_info SET status = 1, update_time = ? WHERE id = ?", now, id)
		}
		// SYNC-A45（2026-10-13）：改存**完整 user 行**，并把 id/status/update_time 一并放进去。
		//
		// Node accountLockCheck.js:193 是 req.checkedUser = user（**完整行**），
		// 且 auth/controller/index.js:109-112 复用它避免重复查库（注释明写的）。
		// 旧 Go 只存 {id, status} 且 resp.CheckedUser 全仓零读点 →
		// 下游改为重跑 FindUserByEmail + FindUserByUsername 两次查询，
		// 且若未来直接复用将缺 login_pwd 等必需字段。
		//
		// 注：status 存的仍是自动解锁**前**的值（下方只判锁定用 userID，不影响行为）。
		next.ServeHTTP(w, resp.WithCheckedUser(r, map[string]any{
			"id": id, "status": status, "update_time": updateTime,
		}))
	})
}

func parseMSOrDefault(s string) int64 {
	var n int64
	for _, c := range strings.TrimSpace(s) {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

// ================= emailCodeRateLimit（对应 emailCodeRateLimit.js） =================

// EmailCodeRateLimit 邮箱验证码发送频率限制中间件。
// 🔄 2026-10-12 修复（api.md P1-1/P1-3）：
//  1. userId 一律取 `resp.UID(r)`（服务端鉴权身份），不再读 body.userId
//     —— 原实现允许客户端在 body 里塞 userId 覆盖身份（越权写他人验证码记录）。
//  2. 限流键去掉 scene（目标邮箱），改为按 userId+type 维度聚合：
//     原实现 `WHERE fingerprint=? AND scene=? AND aes_key=?` 把「换邮箱」
//     当成新配额（每用户每邮箱 5 次），可对任意邮箱无限轰炸；
//     现按该用户今日全部 email_verify 记录聚合 attempts，语义 = 每用户每天 5 次。
//     ⚠ device_crypto 主键是 (fingerprint, scene)，没有 id 列 —— 排序用 created_at。
func EmailCodeRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := resp.Parse(r)
		uid := resp.UID(r)
		if uid == "" {
			next.ServeHTTP(w, r)
			return
		}
		typ := b.Str("data.type")
		if typ == "" {
			typ = "email" // Joi default（Node：中间件在 createValidator 之后运行，type 恒有值）
		}
		email := b.Str("data.email")
		if typ == "pwd" {
			_ = db.DB().QueryRow("SELECT email FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1", uid).Scan(&email)
		}
		if email == "" {
			next.ServeHTTP(w, r)
			return
		}
		fingerprint := "email_verify_" + typ
		now := time.Now().UnixMilli()

		// 「今天 0 点」本地时区基准（对应 new Date().setHours(0,0,0,0)）
		todayStart := time.Now()
		todayStart = time.Date(todayStart.Year(), todayStart.Month(), todayStart.Day(), 0, 0, 0, 0, todayStart.Location())

		// 该用户今日全部同类型验证码记录（跨邮箱聚合，换邮箱不重置配额）
		rows, err := db.DB().Query(
			"SELECT captcha_attempts, captcha_expires_at, captcha_verified FROM device_crypto WHERE fingerprint = ? AND aes_key = ? AND created_at >= ? ORDER BY created_at DESC",
			fingerprint, uid, todayStart.UnixMilli())
		if err != nil {
			// keep：Node try/catch 一律 next()（DB 异常不阻断发送）
			next.ServeHTTP(w, r)
			return
		}
		todayTotal := 0
		var coolingExpires *int64
		for rows.Next() {
			var (
				attempts  int
				expiresAt *int64
				verified  sql.NullInt64
			)
			if err := rows.Scan(&attempts, &expiresAt, &verified); err != nil {
				break
			}
			todayTotal += attempts
			// 冷却：任一邮箱存在未验证且未过期的验证码 → 60s 内不让重发
			if coolingExpires == nil && (!verified.Valid || verified.Int64 == 0) &&
				expiresAt != nil && now < *expiresAt {
				coolingExpires = expiresAt
			}
		}
		rows.Close()

		// 今日已发送总量（Σ attempts，与 controller 的计数口径一致）
		if todayTotal >= 5 {
			resp.Say(w, "今日发送次数已达上限，请明天再试", 429)
			return
		}
		if coolingExpires != nil {
			sec := (*coolingExpires - now) / 1000
			resp.Say(w, "【验证码】已发送，请检查你的邮箱（"+strconv.FormatInt(sec, 10)+"秒后可重发）", 429)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ================= errorMiddleware（对应 errorMiddleware.js） =================

// HTTPError 允许业务层抛出带自定义状态码的错误（对齐 Node errorMiddleware.js:5
// 的 `err.status || 500`）。业务代码 panic(HTTPError{...}) 即可走 4xx 而非一律 500。
type HTTPError struct {
	Status int
	Err    error
}

func (e *HTTPError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return http.StatusText(e.Status)
}

// Recover 全局 panic 兜底（Express 无此机制，Go 必须）：500 脱敏。
//
// SYNC-A11（2026-10-12）对齐 errorMiddleware.js：
//  1. 响应体补 code 字段（Node errorHandler 返回 {code, message}）——
//     前端按 code 判错分支，缺了会拿到 undefined。
//  2. 支持 HTTPError 自定义状态码（Node 支持 err.status）。
//  3. 堆栈日志补 method/path/ip/UA（原实现只有 panic 值 + stack，排障缺上下文）。
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				status := 500
				msg := "服务器内部错误"
				var he *HTTPError
				if errors.As(asError(rec), &he) && he.Status >= 400 && he.Status < 600 {
					status = he.Status
					if he.Err != nil {
						msg = he.Err.Error()
					}
				}
				// 🔒 SYNC-004：panic 必须留痕（原实现静默吞掉，故障无法排查）。
				fmt.Fprintf(os.Stderr, "[panic] %v %s %s ip=%s ua=%q\n%s",
					rec, r.Method, r.URL.Path, ClientIP(r), r.Header.Get("User-Agent"), debug.Stack())
				resp.JSON(w, status, map[string]any{
					"code":    status,
					"status":  status,
					"message": msg,
				})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// asError 把任意 panic 值转成 error（供 errors.As 使用）。
func asError(rec any) error {
	if e, ok := rec.(error); ok {
		return e
	}
	return fmt.Errorf("%v", rec)
}
