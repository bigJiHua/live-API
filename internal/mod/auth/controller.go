package auth

// from: src/modules/auth/controller/index.js
// 逐函数复刻：响应体/HTTP 状态/文案与 Node 一致；keep/fix 标注同 api.logs。

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/sec"
	"live/api/internal/tim"
)

// rowsAffected 对应 mysql2 result.affectedRows。
func rowsAffected(res sql.Result) int64 {
	n, _ := res.RowsAffected()
	return n
}

// ================= 登录 =================

// Login 对应 authController.login（链路：validate → accountLockCheck → login）。
func Login(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)
	// 🔒 SYNC-003：clientData（客户端整个 body）不再展开进日志 —— 字段一律服务端采集。

	// 🔄 2026-10-13（api.md P2-12）：双路径 `req.body.data || req.body`——
	//    authSecurityData 对明文请求直接放行，login 无 Joi 兜底读法，须双路径（深度防御）。
	d := b.DataOrRaw()
	nameOrEmail := toString(d["nameOrEmail"])
	// 安全键盘字符级 RSA 加密：数组密文逐字符解密；字符串原样（对应 rsaKeys.resolvePassword）
	password := sec.ResolvePassword(d["password"])

	// 1. 基本校验
	if nameOrEmail == "" || password == "" {
		resp.JSON(w, 400, map[string]any{"message": "请输入账号和密码"})
		return
	}

	// 2. 查找用户
	user, _ := FindUserByEmail(nameOrEmail)
	if user == nil {
		user, _ = FindUserByUsername(nameOrEmail)
	}
	if user == nil {
		// 🔒 SYNC-001/002：账号不存在同样计数（撞库探测也要限），
		//    且响应与「密码错误」逐字一致（防枚举）—— 正常路径下中间件已拦截，这里是兜底。
		mw.RecordLoginFailure(nameOrEmail)
		resp.Say(w, mw.GenericAuthError, mw.GenericAuthStatus)
		return
	}

	// 3. 检查设备锁定状态（req.device.locked_until）
	// keep BUG-003：locked_until 全代码无写入点，分支实际不可达（Go 端同样无人写入 device）
	if dev, ok := resp.Device(r).(map[string]any); ok && dev["locked_until"] != nil {
		if ms, ok2 := toInt64(dev["locked_until"]); ok2 && tim.Now().UnixMilli() < ms {
			resp.JSON(w, 423, map[string]any{"message": "由于尝试次数过多，设备已锁定，请稍后再试"})
			return
		}
	}

	// 4. 验证密码
	if !VerifyUserPassword(password, toString(user["login_pwd"])) {
		// 🔴 登录失败统计（SYNC-001：失败驱动 —— 只在确认密码错误后计数）
		lf := mw.RecordLoginFailure(nameOrEmail)

		// ✅ SYNC-003：日志字段服务端采集
		fields := BuildServerSideLogFields(r, toString(user["id"]))
		fields["type"] = "failed"
		fields["status"] = 0
		fields["error_message"] = "密码错误"
		UserLogAppend(fields)

		// 达到阈值 ⇒ 明确告知锁定分钟数；未达阈值用统一文案且**不提示剩余次数**
		//（提示剩余次数会让攻击者精确定位阈值）。
		if lf.Locked {
			mins := (lf.RemainingMS + 59999) / 60000
			resp.JSON(w, 423, map[string]any{
				"status":  423,
				"message": "登录失败次数过多，账号已临时锁定 " + strconv.FormatInt(mins, 10) + " 分钟",
				"locked":  true,
			})
			return
		}
		// ⚠ 与「用户不存在」分支逐字一致（防枚举 P1-14）
		resp.Say(w, mw.GenericAuthError, mw.GenericAuthStatus)
		return
	}

	// 5. 生成 Token（iat 用秒；expiresIn 从 JWT_EXPIRES_IN 解析，默认 7d）
	now := time.Now().Unix()
	token, err := sec.Sign(mw.JWTSecret(), sec.Claims{
		UserID:   toString(user["id"]),
		Username: toString(user["username"]),
		Role:     toString(user["identity"]),
		Avatar:   toString(user["avatar"]),
		Email:    toString(user["email"]),
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(time.Unix(now, 0)),
		},
	}, jwtExpiresIn())
	if err != nil {
		fmt.Fprintln(os.Stderr, "登录异常:", err)
		resp.JSON(w, 500, map[string]any{"message": "服务器内部错误"})
		return
	}

	// 6. 登录成功统计
	//    ✅ SYNC-001：登录成功 ⇒ 清零该账号失败计数（否则额度被成功登录占用）
	mw.ClearLoginFailures(nameOrEmail)

	//    ✅ SYNC-003：服务端采集（token 只存 50 位存根，UserLogAppend 内部截断）
	fields := BuildServerSideLogFields(r, toString(user["id"]))
	fields["type"] = "login"
	fields["token"] = token
	fields["status"] = 1
	UserLogAppend(fields)

	// 🔒 SYNC-A2（2026-10-12）：登录成功同时下发 httpOnly Cookie。
	//   web 端凭此不再需要把 token 放进 localStorage ⇒ XSS 窃取无效。
	//   APP / webview-APP 仍走 Authorization 头（authGuard 是双通道）。
	//   失败不能让登录失败 —— 客户端可退回 Bearer 方式。
	SetAuthCookie(w, token, ResolveTokenTTLSec())

	resp.JSON(w, 200, map[string]any{
		"message": "登录成功!",
		"token":   token,
		"status":  200,
	})
}

// Logout 对应 authController.logout（P1-17）。
// ⚠ 刻意**不挂 authGuard**：即便令牌已失效也要能登出（幂等）。
// 主要效果是清 Cookie（浏览器不再携带 ⇒ 令牌立即不可用）+ 记一条登出审计日志。
// 本阶段不引入 jti 吊销表（Node 同款取舍，残留风险 R-10）。
func Logout(w http.ResponseWriter, r *http.Request) {
	// 尽力解析用户（可能因令牌过期/缺失而拿不到，属正常）
	userID := resp.UID(r)
	if userID == "" {
		// Node: cookie 优先，回落 Bearer（controller/index.js:456-460）
		if tok := mw.ExtractAuthToken(r); tok != "" {
			if claims, err := sec.Verify(mw.JWTSecret(), tok); err == nil {
				userID = claims.UserID
			}
		}
	}

	ClearAuthCookie(w)

	if userID != "" {
		fields := BuildServerSideLogFields(r, userID)
		fields["type"] = "logout"
		fields["status"] = 1
		UserLogAppend(fields)
	}

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "已退出登录"})
}

func itoa(n int) string { return strconv.Itoa(n) }

// ================= 当前用户 =================

// GetCurrentUser 对应 authController.getCurrentUser。
func GetCurrentUser(w http.ResponseWriter, r *http.Request) {
	user := FindUserByID(resp.UID(r))
	if user == nil {
		resp.Say(w, "用户不存在", 404)
		return
	}

	// 邮箱脱敏：前2位 + **** + 后2位 @域名
	email := toString(user["email"])
	atIdx := strings.Index(email, "@")
	maskedEmail := email
	if atIdx > 3 {
		local, domain := email[:atIdx], email[atIdx:]
		maskedEmail = local[:2] + "***" + local[len(local)-2:] + domain
	}

	resp.JSON(w, 200, map[string]any{
		"status":  200,
		"message": "获取用户信息成功",
		"data": map[string]any{
			"username": toString(user["username"]),
			"email":    maskedEmail,
			"avatar":   toString(user["avatar"]),
			"identity": toString(user["identity"]),
		},
	})
}

// ================= 锁定系统 =================

// LockSystem 对应 authController.lockSystem。
func LockSystem(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	// 检查是否已有未解锁的锁定记录（action_type='lock' 且 pin_status=0）
	var id string
	err := db.DB().QueryRow(
		"SELECT id FROM security_verify_log WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0 LIMIT 1", userID).
		Scan(&id)
	if err == nil {
		resp.JSON(w, 200, map[string]any{"status": 200, "message": "系统已经是锁定状态"})
		return
	}

	// 插入待验证记录（pin_status=0 表示待验证）
	if _, err := db.DB().Exec(
		`INSERT INTO security_verify_log (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
         VALUES (?, ?, ?, 0, 0, ?, NOW())`,
		userID, "/lock-system", "lock", "系统锁定"); err != nil {
		resp.JSON(w, 500, map[string]any{"message": "锁定失败", "error": err.Error()})
		return
	}

	// 清掉内存里的 30 秒放行会话，否则锁定后仍会命中放行窗口
	mw.ClearVerifiedSession(userID)

	resp.JSON(w, 200, map[string]any{
		"code":    8303,
		"status":  200,
		"message": "系统已锁定，下次登录需验证PIN",
		"locked":  true,
	})
}

// ================= 登录日志 =================

// GetLoginLogs 对应 authController.getLoginLogs（最近 30 条）。
func GetLoginLogs(w http.ResponseWriter, r *http.Request) {
	rows, err := scanRows(
		`SELECT id, type, login_ip, login_location, login_isp, user_agent, os_info, browser_info, device_model, status, error_message, login_time, create_time
         FROM user_log
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 30`, resp.UID(r))
	if err != nil {
		resp.JSON(w, 500, map[string]any{"message": "获取登录日志失败", "error": err.Error()})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "data": rows})
}

// ================= 刷新 Token =================

// RefreshToken 对应 authController.refreshToken（吊销规则 + 同设备续期，保留原 iat）。
func RefreshToken(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)
	// 🔄 2026-10-13（api.md P2-2/P2-12）：双路径 `req.body.data || req.body`——
	//    web/APP 走 POST 加密时 token 在 data.token，原读 Raw["token"] 恒空。
	token := toString(b.DataOrRaw()["token"])
	if token == "" {
		resp.JSON(w, 400, map[string]any{"message": "Token 不能为空"})
		return
	}

	// 1. 验证旧 Token 签名 + 有效期（过期允许 7 天宽限）
	claims, err := sec.Verify(mw.JWTSecret(), token)
	if err != nil {
		if !errors.Is(err, jwt.ErrTokenExpired) {
			resp.JSON(w, 401, map[string]any{"message": "无效的认证令牌"})
			return
		}
		claims, err = sec.VerifyIgnoreExp(mw.JWTSecret(), token)
		if err != nil || claims == nil || claims.ExpiresAt == nil {
			resp.JSON(w, 401, map[string]any{"message": "无效的认证令牌"})
			return
		}
		expiredAt := claims.ExpiresAt.UnixMilli()
		const gracePeriod = int64(7 * 24 * 60 * 60 * 1000) // 7 天宽限
		if tim.Now().UnixMilli()-expiredAt > gracePeriod {
			resp.JSON(w, 401, map[string]any{"message": "令牌已失效，请重新登录"})
			return
		}
	}

	// 2. 查询用户（带密码变更时间）
	var (
		id, username, email, avatar, identity string
		status                                int
		pwdChangedAt                          *int64
	)
	uerr := db.DB().QueryRow(
		"SELECT id, username, email, avatar, identity, status, password_changed_at FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1",
		claims.UserID).Scan(&id, &username, &email, &avatar, &identity, &status, &pwdChangedAt)
	if uerr != nil {
		// password_changed_at 字段可能尚未迁移，回退基础查询（keep 兼容旧库）
		uerr = db.DB().QueryRow(
			"SELECT id, username, email, avatar, identity, status FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1",
			claims.UserID).Scan(&id, &username, &email, &avatar, &identity, &status)
		if uerr != nil {
			resp.JSON(w, 404, map[string]any{"message": "用户不存在"})
			return
		}
	}

	// 3. 账户锁定检查
	if status == 0 {
		resp.JSON(w, 403, map[string]any{"message": "账户已被锁定"})
		return
	}

	// 4. 密码变更吊销：token.iat 早于密码变更时间 → 拒绝刷新
	if pwdChangedAt != nil && claims.IssuedAt != nil && claims.IssuedAt.UnixMilli() < *pwdChangedAt {
		resp.JSON(w, 401, map[string]any{"message": "密码已变更，请重新登录"})
		return
	}

	// 5. N 月强制重登：从 token.iat 算起（TOKEN_MAX_SESSION_DAYS，默认 90 天）
	maxSessionDays := envInt("TOKEN_MAX_SESSION_DAYS", 90)
	if claims.IssuedAt != nil {
		maxSessionMS := int64(maxSessionDays) * 24 * 60 * 60 * 1000
		if tim.Now().UnixMilli()-claims.IssuedAt.UnixMilli() > maxSessionMS {
			resp.JSON(w, 401, map[string]any{
				"message": "会话已超过 " + itoa(maxSessionDays) + " 天，请重新登录",
				"code":    "SESSION_EXPIRED",
			})
			return
		}
	}

	// 6. 生成新 Token（保留原始 iat 用于会话期限计算）
	originalIat := time.Now().Unix()
	if claims.IssuedAt != nil {
		originalIat = claims.IssuedAt.Unix()
	}
	newToken, err := sec.Sign(mw.JWTSecret(), sec.Claims{
		UserID:   id,
		Username: username,
		Role:     identity,
		Avatar:   avatar,
		Email:    email,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(time.Unix(originalIat, 0)),
		},
	}, jwtExpiresIn())
	if err != nil {
		resp.JSON(w, 401, map[string]any{"message": "Token 无效或已过期", "error": err.Error()})
		return
	}

	// 🔒 SYNC-A2：刷新成功后同步刷新 Cookie 的 maxAge，否则旧 Cookie 会按原
	//   maxAge 提前过期，web 端被莫名登出（对齐 controller/index.js:417-425）。
	SetAuthCookie(w, newToken, ResolveTokenTTLSec())

	resp.JSON(w, 200, map[string]any{
		"message": "Token 刷新成功",
		"token":   newToken,
	})
}

// ================= 管理员 =================

// CheckAdmin 对应 authController.checkAdmin。
func CheckAdmin(w http.ResponseWriter, r *http.Request) {
	count, err := CountUsers()
	if err != nil {
		resp.JSON(w, 500, map[string]any{"message": "检查管理员状态失败", "error": err.Error()})
		return
	}
	hasAdmin := count > 0
	msg := "系统未初始化"
	if hasAdmin {
		msg = "系统已初始化"
	}
	resp.JSON(w, 200, map[string]any{
		"status":  200,
		"message": msg,
		"data":    map[string]any{"hasAdmin": hasAdmin, "count": count},
	})
}

// AdminRegister 对应 authController.adminRegister。
// keep BUG-044：count 不过滤 is_deleted；identity 三元 `count <= 1 ? admin : user` 在
// count>0 已提前返回的前提下恒为 admin —— 两处均原样保留。
func AdminRegister(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)
	// 🔄 2026-10-13（api.md P2-12）：双路径 `const {...} = req.body.data || req.body`
	//   （auth/controller/index.js:554）——data 缺失时回退顶层（无 Joi 兜底读法）。
	d := b.DataOrRaw()
	username := toString(d["username"])
	email := toString(d["email"])
	password := toString(d["password"])

	count, err := CountUsers()
	if err != nil {
		resp.JSON(w, 500, map[string]any{"message": "管理员注册失败", "error": err.Error(), "status": 500})
		return
	}
	if count > 0 {
		resp.JSON(w, 403, map[string]any{"message": "系统已存在用户,无法注册管理员"})
		return
	}
	if existing, _ := FindUserByUsername(username); existing != nil {
		resp.JSON(w, 400, map[string]any{"message": "该用户名已被注册"})
		return
	}
	if existing, _ := FindUserByEmail(email); existing != nil {
		resp.JSON(w, 400, map[string]any{"message": "该邮箱已被注册"})
		return
	}
	// 密码强度统一校验（6-30位 + 大小写数字特殊字符）
	if !passwordOK(password) {
		resp.JSON(w, 400, map[string]any{"message": "密码必须包含大小写字母、数字和特殊字符，且长度为6-30位"})
		return
	}
	hashedPwd, err := mw.BcryptHash(password, saltRounds())
	if err != nil {
		resp.JSON(w, 500, map[string]any{"message": "管理员注册失败", "error": err.Error(), "status": 500})
		return
	}
	identity := "admin" // keep BUG-044：count <= 1 ? "admin" : "user" 恒为 admin
	if _, err := CreateUser(username, email, hashedPwd, identity); err != nil {
		resp.JSON(w, 500, map[string]any{"message": "管理员注册失败", "error": err.Error(), "status": 500})
		return
	}

	// keep：Node create 返回 mysql2 result（无 id/username/email 字段），响应 user 序列化为 {}
	resp.JSON(w, 200, map[string]any{
		"message": "注册成功！",
		"user":    map[string]any{},
	})
}

// ================= 握手 =================

// GetHandshake 对应 authController.getHandshake（AES 临时密钥 + RSA 公钥下发）。
func GetHandshake(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("fp")
	scene := r.URL.Query().Get("scene")
	if scene == "" {
		scene = "login"
	}
	if fp == "" {
		resp.Say(w, "非法设备标识", 400)
		return
	}

	// 对应 CryptoJS.lib.WordArray.random(32).toString()：32 字节随机 hex
	tempKey := randHex(32)
	aesExpires := tim.Now().UnixMilli() + 2*60*60*1000 // 有效期2小时
	now := tim.Now().UnixMilli()

	// 🔒 SYNC-010（2026-10-11）：aes_key **加密后落库**（AES-256-GCM，格式与 Node
	//   fieldCrypto.js 互通）。返回给客户端的仍是明文 tempKey（传输层 = R-1 已接受）。
	//   ⚠ 只加密「握手行」；邮件验证码行的 aes_key 存 userId 且被 WHERE 精确匹配，保持明文。
	storedKey, kerr := sec.EncryptField(tempKey)
	if kerr != nil {
		fmt.Fprintln(os.Stderr, "握手密钥加密失败:", kerr)
		resp.Say(w, "初始化失败", 500)
		return
	}
	sql := `
        INSERT INTO device_crypto (
          fingerprint, scene, aes_key, aes_expires_at,
          client_ip, user_agent, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          aes_key = VALUES(aes_key),
          aes_expires_at = VALUES(aes_expires_at),
          client_ip = VALUES(client_ip),
          updated_at = VALUES(updated_at),
          captcha_verified = 0,
          fail_count = 0
      `
	if _, err := db.DB().Exec(sql,
		fp, scene, storedKey, aesExpires,
		mw.ClientIP(r), r.Header.Get("User-Agent"), now, now); err != nil {
		fmt.Fprintln(os.Stderr, "安全握手异常:", err)
		resp.Say(w, "初始化失败", 500)
		return
	}

	resp.JSON(w, 200, map[string]any{
		"status":       200,
		"key":          tempKey,
		"scene":        scene,
		"rsaPublicKey": sec.PublicKeyPEM(),
	})
}

// ================= 邮箱验证码 =================

// SendEmailCode 对应 authController.sendEmailCode。
// 注意 type 缺省 "email"（Node 解构默认）；BUG-008 已修复为 sec.Digits6。
func SendEmailCode(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)

	// 🔒 2026-10-12 修复（api.md P1-1）：userId 一律取服务端鉴权身份。
	//    原实现 `req.body.userId || req.userId` 允许客户端在 body 塞 userId
	//    覆盖身份（可向任意用户写验证码记录，配合 changeEmail 越权改绑）。
	userID := resp.UID(r)
	if userID == "" {
		resp.Say(w, "用户ID不能为空", 400)
		return
	}

	d := b.Data
	typ := "email"
	if v, ok := d["type"]; ok && v != nil {
		typ = toString(v)
	}

	// 确定发送目标邮箱
	var email string
	if typ == "pwd" {
		// 修改密码场景：从 DB 查用户绑定的邮箱，不信任前端传入
		var dbEmail sql.NullString
		if err := db.DB().QueryRow(
			"SELECT email FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1", userID).Scan(&dbEmail); err != nil || !dbEmail.Valid {
			resp.Say(w, "您的账号未绑定邮箱，无法发送验证码", 400)
			return
		}
		email = dbEmail.String
	} else {
		// 修改邮箱场景：使用前端传入的新邮箱
		email = toString(d["email"])
		if email == "" {
			resp.Say(w, "邮箱不能为空", 400)
			return
		}
		if !emailRe.MatchString(email) {
			resp.Say(w, "邮箱格式不正确", 400)
			return
		}
	}

	now := tim.Now().UnixMilli()
	// type: "email" → fingerprint = "email_verify_email"；"pwd" → "email_verify_pwd"
	fingerprint := "email_verify_" + typ
	scene := email   // scene 存储用户邮箱
	aesKey := userID // aes_key 存储用户ID，用于身份识别

	// fix BUG-008：6 位验证码改用 crypto/rand（原 Math.random 可预测）
	code := sec.Digits6()
	expiresAt := now + 10*60*1000 // 10分钟有效期

	// 「今天 0 点」本地时区基准（对应 new Date().setHours(0,0,0,0) 后按 Y/M/D 比较）
	today := tim.Now()

	// 查询现有记录（fingerprint + scene + aes_key 三条件）
	var (
		recAttempts  int
		recExpiresAt *int64
		recCreatedAt string
	)
	err := db.DB().QueryRow(
		"SELECT captcha_attempts, captcha_expires_at, created_at FROM device_crypto WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
		fingerprint, scene, aesKey).Scan(&recAttempts, &recExpiresAt, &recCreatedAt)
	if err == nil {
		// 有记录：校验当日发送次数
		isToday := sameLocalDay(recCreatedAt, today)
		// 超过 N 次不让发了（与 emailCodeRateLimit 中间件的 >=5 口径统一）
		if isToday && recAttempts >= 5 {
			resp.Say(w, "今日获取验证码次数上限，次日再试！", 400)
			return
		}
		newAttempts := 1
		if isToday {
			newAttempts = recAttempts + 1
		}
		createdAt := now
		if isToday {
			createdAt, _ = toInt64(recCreatedAt) // 是今天则保持原创建时间
		}
		res, err := db.DB().Exec(
			`UPDATE device_crypto
             SET captcha_code = ?, captcha_expires_at = ?, captcha_verified = 0,
                 captcha_attempts = ?, updated_at = ?, created_at = ?
             WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
			code, expiresAt, newAttempts, now, createdAt, fingerprint, scene, aesKey)
		if err != nil {
			// Node：db.execute 抛错 → 外层 catch
			resp.Say(w, "发送验证码失败，请稍后再试", 400)
			return
		}
		if rowsAffected(res) == 0 {
			resp.Say(w, "验证码发送错误", 500)
			return
		}
	} else {
		// 第一次发送验证码：插入新记录（captcha_attempts = 1）
		res, err := db.DB().Exec(
			`INSERT INTO device_crypto (
               fingerprint, scene, aes_key, captcha_code, captcha_expires_at,
               captcha_attempts, captcha_verified, client_ip, user_agent, created_at, updated_at
             )
             VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
			fingerprint, scene, aesKey, code, expiresAt,
			mw.ClientIP(r), r.Header.Get("User-Agent"), now, now)
		if err != nil {
			resp.Say(w, "发送验证码失败，请稍后再试", 400)
			return
		}
		if rowsAffected(res) == 0 {
			resp.Say(w, "验证码发送错误", 500)
			return
		}
	}

	// 发送邮件（失败仅记录，验证码已落库）
	sendMailLogged(email, code)

	data := map[string]any{}
	if config.IsDevelopment() {
		data["code"] = code // Node: NODE_ENV === 'development' 才回显
	}
	resp.JSON(w, 200, map[string]any{
		"status":  200,
		"message": "验证码已发送",
		"data":    data,
	})
}

// sameLocalDay 对应 JS「今日 0 点」本地时区比较（created_at 为毫秒串）。
func sameLocalDay(ms string, now time.Time) bool {
	n, ok := toInt64(ms)
	if !ok || n == 0 {
		return false
	}
	t := time.UnixMilli(n).In(now.Location())
	return t.Year() == now.Year() && t.Month() == now.Month() && t.Day() == now.Day()
}

// ================= 修改邮箱 =================

// ChangeEmail 对应 authController.changeEmail。
func ChangeEmail(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)
	d := b.Map("data")
	email := toString(d["email"])
	code := toString(d["code"])
	userID := resp.UID(r)

	fingerprint := "email_verify_email"
	scene := email
	id := userID // 对应数据库 aes_key 字段

	var (
		recCode      string
		recExpiresAt int64
		recVerified  int
		recAttempts  int
	)
	// 🔒 2026-10-12 修复（api.md P1-2）：SELECT 补 `AND scene = ?`。
	//    原实现只按 (fingerprint, aes_key) 查 ⇒ 用户有多个邮箱的验证码记录时
	//    rows[0] 无序取到旧邮箱记录，新邮箱的验证码永远「验证码错误」
	//    （2026-10-12 修前基线实测复现：S5 changeEmail 报「验证码错误」）。
	//    （SYNC-A21 曾以「对齐 Node」为由回退过该条件；Node 当日已修，此处恢复。）
	err := db.DB().QueryRow(
		`SELECT captcha_code, captcha_expires_at, captcha_verified, captcha_attempts
         FROM device_crypto
         WHERE fingerprint = ? AND scene = ? AND aes_key = ? LIMIT 1`,
		fingerprint, scene, id).Scan(&recCode, &recExpiresAt, &recVerified, &recAttempts)
	if err != nil {
		resp.Say(w, "验证码不存在或已过期", 400)
		return
	}
	now := tim.Now().UnixMilli()

	// 验证验证码
	if recCode != code {
		// 增加失败次数（不增加 captcha_attempts，那是发送次数）
		_, _ = db.DB().Exec(
			`UPDATE device_crypto
             SET fail_count = fail_count + 1, updated_at = ?
             WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
			now, fingerprint, scene, id)
		resp.Say(w, "验证码错误", 400)
		return
	}

	// 检查验证码是否过期
	if now > recExpiresAt {
		resp.Say(w, "验证码已过期", 400)
		return
	}

	if recVerified == 1 {
		resp.Say(w, "验证码已验证过，请重试！", 400)
		return
	}

	// 验证成功，增加使用次数（captcha_attempts 既统计发送次数也统计使用次数）
	newAttempts := recAttempts + 1

	// 检查邮箱是否已被使用
	if existing, _ := FindUserByEmail(email); existing != nil && toString(existing["id"]) != userID {
		resp.Say(w, "该邮箱已被使用", 400)
		return
	}

	// 更新邮箱
	user, _, _ := UpdateUser(userID, map[string]any{"email": email}, nil)

	// 更新使用次数并标记已验证
	_, _ = db.DB().Exec(
		`UPDATE device_crypto
         SET captcha_attempts = ?, captcha_verified = 1, updated_at = ?
         WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
		newAttempts, now, fingerprint, scene, id)

	resp.JSON(w, 200, map[string]any{
		"message": "邮箱修改成功",
		"status":  200,
		"data": map[string]any{
			"user": map[string]any{
				"username": toString(user["username"]),
				"email":    toString(user["email"]),
				"avatar":   toString(user["avatar"]),
			},
		},
	})
}

// ================= 修改密码 =================

// ChangePasswordWithCode 对应 authController.changePasswordWithCode。
// keep BUG-049：update_time 用 UTC（Node toISOString 截断，与全站本地时间混用）。
// fix BUG-050：UPDATE 失败时按列存在性探测走回退 SQL（Node 兜底重试吞掉一切错误）。
func ChangePasswordWithCode(w http.ResponseWriter, r *http.Request) {
	b := resp.Parse(r)
	d := b.Map("data")
	oldPassword := toString(d["oldPassword"])
	newPassword := toString(d["newPassword"])
	code := toString(d["code"])
	userID := resp.UID(r)

	// 内部专用：带密码查询
	var (
		recID       string
		recUsername string
		recEmail    string
		recAvatar   string
		recLoginPwd string
	)
	err := db.DB().QueryRow(
		"SELECT id, username, email, avatar, login_pwd FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1", userID).
		Scan(&recID, &recUsername, &recEmail, &recAvatar, &recLoginPwd)
	if err != nil {
		resp.Say(w, "用户不存在", 404)
		return
	}

	// 校验：新旧密码不能一样
	if oldPassword == newPassword {
		resp.Say(w, "新密码不能与原密码相同", 400)
		return
	}

	// 校验：原密码是否正确（login_pwd 为 NULL 时按空串比较 → 不匹配）
	if !mw.CheckPwd(recLoginPwd, oldPassword) {
		resp.Say(w, "原密码输入错误", 400)
		return
	}

	// 校验：验证码
	fingerprint := "email_verify_pwd"
	scene := recEmail
	var (
		vCode     string
		vExpires  int64
		vVerified int
	)
	if err := db.DB().QueryRow(
		"SELECT captcha_code, captcha_expires_at, captcha_verified FROM device_crypto WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
		fingerprint, scene, userID).Scan(&vCode, &vExpires, &vVerified); err != nil {
		resp.Say(w, "验证码不存在或已过期", 400)
		return
	}
	now := tim.Now().UnixMilli()
	if now > vExpires {
		resp.Say(w, "验证码已过期", 400)
		return
	}
	if vVerified == 1 {
		resp.Say(w, "验证码已被使用", 400)
		return
	}
	if vCode != code {
		_, _ = db.DB().Exec(
			"UPDATE device_crypto SET fail_count = fail_count + 1, updated_at = ? WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
			now, fingerprint, scene, userID)
		resp.Say(w, "验证码错误", 400)
		return
	}

	// 执行更新：直接写 login_pwd + password_changed_at（供旧 token 吊销）
	hashedPwd, err := mw.BcryptHash(newPassword, saltRounds())
	if err != nil {
		resp.Say(w, "服务器错误，修改失败", 500)
		return
	}
	updateTime := tim.UTCNowString() // keep BUG-049：UTC 时间字符串
	passwordChangedAt := now
	var affected int64
	res, err := db.DB().Exec(
		"UPDATE user_info SET login_pwd = ?, update_time = ?, password_changed_at = ? WHERE id = ? AND is_deleted = 0",
		hashedPwd, updateTime, passwordChangedAt, userID)
	if err != nil {
		// fix BUG-050：password_changed_at 未迁移时列不存在才回退，其它错误直接失败
		if !strings.Contains(strings.ToLower(err.Error()), "unknown column") {
			resp.Say(w, "服务器错误，修改失败", 500)
			return
		}
		res, err = db.DB().Exec(
			"UPDATE user_info SET login_pwd = ?, update_time = ? WHERE id = ? AND is_deleted = 0",
			hashedPwd, updateTime, userID)
		if err != nil {
			resp.Say(w, "服务器错误，修改失败", 500)
			return
		}
	}
	affected, _ = res.RowsAffected()
	if affected == 0 {
		resp.Say(w, "服务器错误，修改失败", 500)
		return
	}

	// 核销验证码
	_, _ = db.DB().Exec(
		"UPDATE device_crypto SET captcha_verified = 1, updated_at = ? WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
		now, fingerprint, scene, userID)

	resp.JSON(w, 200, map[string]any{
		"status":  200,
		"message": "密码修改成功，请重新登录",
	})
}

// ================= 用户资料 / 设置（src/modules/user 复用 authController） =================

// UpdateProfile 对应 authController.updateProfile（user 模块 PUT /profile）。
// keep BUG-046：Joi 允许 email 但本函数只消费 username/avatar，email 被静默丢弃。
func UpdateProfile(w http.ResponseWriter, r *http.Request) {
	d := resp.Parse(r).Data // Node: req.body.data || {}
	updateData := map[string]any{}
	if v, ok := d["username"]; ok && v != nil {
		updateData["username"] = v
	}
	if v, ok := d["avatar"]; ok && v != nil {
		updateData["avatar"] = v
	}
	if len(updateData) == 0 {
		resp.Say(w, "没有提供要更新的内容", 400)
		return
	}
	user, status, message := UpdateUser(resp.UID(r), updateData, r)
	if status == 200 {
		resp.JSON(w, 200, map[string]any{
			"status":  200,
			"message": "资料更新成功",
			"data": map[string]any{
				"user": map[string]any{
					"username": toString(user["username"]),
					"email":    toString(user["email"]),
					"avatar":   toString(user["avatar"]),
				},
			},
		})
		return
	}
	resp.Say(w, message, 400)
}

// ================= PIN 相关辅助（供 security 包复用） =================

// ResolvePin 对应 rsaKeys.resolvePassword（PIN 密文字符数组解密，字符串原样）。
func ResolvePin(raw any) string { return sec.ResolvePassword(raw) }
