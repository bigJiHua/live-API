package security

// from: src/modules/security/controller/index.js
// PIN 管理控制器：security_verify_log 全套 SQL 与计数逻辑逐字复刻。

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/mod/auth"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/sec"
	"live/api/internal/tim"
)

// 对应 pinLockGuard.js 常量（mw.PinLockGuard 消费端需与之一致）。
const (
	routeActionType = "route_verify"
	routeHeaderName = "x-route-verify-token"
	routeExpireMin  = 5 // pinLockGuard.CONFIG.EXPIRE_MINUTES
	maxErrorCount   = 3 // pinLockGuard.CONFIG.MAX_ERROR_COUNT
	routeTokenPfx   = "route-token:"
)

var bodyHashRe = regexp.MustCompile(`body:([a-f0-9]{64})`)

// ================= 0. 查看 PIN 状态 =================

// PinStatus 对应 securityController.PinStatus。
func PinStatus(w http.ResponseWriter, r *http.Request) {
	if !auth.UserPinHas(resp.UID(r)) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "请先设置 PIN 码", "ismessage": true})
		return
	}
	resp.Say(w, "状态正常！", 200)
}

// ================= 1. 验证 PIN =================

// VerifyPin 对应 securityController.verifyPin（pin_status 0/1/2/3 状态机复刻）。
func VerifyPin(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	// 🔄 2026-10-13（api.md P2-12）：双路径 `const { pin: rawPin } = req.body.data || req.body`
	//   ——authSecurityData 对明文请求直接放行，须双路径（原 data 缺失 500 与基准不符）。
	d := resp.Parse(r).DataOrRaw()
	pin := auth.ResolvePin(d["pin"]) // 支持 RSA 密文数组解密

	// 校验 PIN 格式
	if pin == "" || len(pin) != 6 || !allDigits(pin) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "PIN 码必须是6位纯数字"})
		return
	}

	// 获取用户 PIN 信息
	pinCode := auth.UserPinCode(userID)
	if pinCode == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "请先设置 PIN 码"})
		return
	}

	// ── 锁定态前置检查：pin_status=3（含系统硬锁）→ 直接拒绝，不再走验证 ──
	var (
		lockID      int64
		lockErrCnt  int
		lockCreated time.Time
	)
	if err := db.DB().QueryRow(
		`SELECT id, error_count, create_time
         FROM security_verify_log
         WHERE user_id = ? AND pin_status = 3 AND action_type <> 'route_verify'
         ORDER BY id DESC LIMIT 1`, userID).Scan(&lockID, &lockErrCnt, &lockCreated); err == nil {
		// lockMinutes = (Number(error_count) || 3) * LOCK_MULTIPLIER(30)
		multiplier := lockErrCnt
		if multiplier == 0 {
			multiplier = 3
		}
		expire := lockCreated.UnixMilli() + int64(multiplier)*mw.LockMultiplier*60000
		if tim.Now().UnixMilli() < expire {
			remainMinutes := (expire - tim.Now().UnixMilli() + 59999) / 60000 // Math.ceil
			resp.JSON(w, 200, map[string]any{
				"code":    mw.CodeLocked,
				"status":  200,
				"message": "PIN 已锁定，剩余 " + strconv.FormatInt(remainMinutes, 10) + " 分钟",
				"data":    map[string]any{"locked": true, "remainMinutes": remainMinutes},
			})
			return
		}
		// 锁定期已过 → 清除锁定状态与错误计数，允许重新验证
		_, _ = db.DB().Exec(
			`UPDATE security_verify_log
             SET pin_status = 0, error_count = 0, remark = '锁定到期，重新验证'
             WHERE id = ?`, lockID)
	}

	// 验证 PIN
	if !mw.CheckPwd(pinCode, pin) {
		// 错误计数：无记录则插入新失败记录，有则对最新一条累加（无论 pin_status 是 0/1/2）
		var (
			latestID     int64
			latestErrCnt int
		)
		hasLatest := db.DB().QueryRow(
			`SELECT id, error_count FROM security_verify_log
             WHERE user_id = ? AND action_type <> 'route_verify'
             ORDER BY id DESC LIMIT 1`, userID).Scan(&latestID, &latestErrCnt) == nil
		if hasLatest {
			_, _ = db.DB().Exec(
				`UPDATE security_verify_log
                 SET pin_status = 2, error_count = error_count + 1, remark = '验证失败'
                 WHERE id = ?`, latestID)
		} else {
			_, _ = db.DB().Exec(
				`INSERT INTO security_verify_log
                 (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
                 VALUES (?, ?, 'verify', 2, 1, '验证失败', NOW())`,
				userID, requestURI(r))
		}

		secErrorCount := 1
		if hasLatest {
			secErrorCount = latestErrCnt + 1
		}

		// 🔄 2026-10-13（api.md P3-6）：补写 user_log 失败记录。
		//    原实现 verifyPin 失败路径只更新 security_verify_log、不写 user_log，
		//    导致下方 `logErrorCount >= 5` 锁账户的兜底在此路径永不触发（死逻辑）。
		//    口径与 changePin 的错误路径一致（type:'pin', status:0）。
		logFields := auth.BuildServerSideLogFields(r, userID)
		logFields["type"] = "pin"
		logFields["status"] = 0
		logFields["error_message"] = "PIN验证失败"
		auth.UserLogAppend(logFields)

		// user_log 的错误次数（账户级兜底）
		logErrorCount := auth.UserLogPinErrorCount(userID)
		if secErrorCount >= maxErrorCount {
			// security_verify_log 达到3次 → 硬锁定
			_, _ = db.DB().Exec(
				`UPDATE security_verify_log
                 SET pin_status = 3, remark = '锁定90分钟'
                 WHERE user_id = ? AND pin_status = 2 AND action_type <> 'route_verify'
                 ORDER BY id DESC LIMIT 1`, userID)
			resp.JSON(w, 200, map[string]any{
				"code":    mw.CodeLocked,
				"status":  200,
				"message": "PIN 错误次数过多，已锁定90分钟",
			})
			return
		}
		if logErrorCount >= 5 {
			auth.LockUser(userID)
			resp.JSON(w, 401, map[string]any{
				"status":      401,
				"message":     "连续输入错误超过5次，账户已被锁定",
				"forceLogout": true,
				"locked":      true,
			})
			return
		}
		resp.JSON(w, 200, map[string]any{
			"code":    mw.CodeError,
			"status":  200,
			"message": "PIN 错误（剩余 " + strconv.Itoa(maxErrorCount-secErrorCount) + " 次）",
		})
		return
	}

	// ✅ PIN 正确 → 同步更新 security_verify_log，解除所有待验证/锁定状态
	// 1. 标记最近一条待验证/失败记录为成功，并重置错误计数（防止历史错误累积误锁）
	_, _ = db.DB().Exec(
		`UPDATE security_verify_log
         SET pin_status = 1, error_count = 0, remark = '验证成功'
         WHERE user_id = ? AND pin_status IN (0,2) AND action_type <> 'route_verify'
         ORDER BY id DESC LIMIT 1`, userID)
	// 2. 清除系统软锁定记录
	_, _ = db.DB().Exec(
		`UPDATE security_verify_log
         SET pin_status = 1, remark = '系统已解锁'
         WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0`, userID)

	// 3. 开启 30 秒放行窗口并重置频率/敏感操作计数
	mw.MarkVerified(userID)

	resp.JSON(w, 200, map[string]any{"code": mw.CodeSuccess, "status": 200, "message": "验证成功", "verified": true})
}

// ================= 风险路由 PIN 验证 =================

// VerifyRoutePin 对应 securityController.verifyRoutePin。
// fix BUG-002：challenge 的 method + bodyHash 强绑定（token 签发时写入 remark，
// 由 mw.PinLockGuard 核销时按原始请求的 method/bodyHash 精确匹配，跨请求复用被拒绝）。
func VerifyRoutePin(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)
	bd := resp.Parse(r)
	d, _ := bd.Raw["data"].(map[string]any) // Node: req.body.data || {}

	pin := auth.ResolvePin(d["pin"])
	normalizedMethod := strings.ToUpper(toString(d["method"]))

	if pin == "" || len(pin) != 6 || !allDigits(pin) {
		resp.JSON(w, 400, map[string]any{
			"code":    mw.CodeError,
			"status":  400,
			"message": "PIN 码格式错误",
		})
		return
	}

	challengeID := toString(d["challengeId"])
	requestURL := toString(d["requestUrl"])
	if challengeID == "" || requestURL == "" || normalizedMethod == "" {
		resp.JSON(w, 400, map[string]any{
			"status":  400,
			"message": "风险验证参数不完整",
		})
		return
	}

	var (
		chID     int64
		chErrCnt int
		chRemark string
	)
	err := db.DB().QueryRow(
		`SELECT id, error_count, remark
         FROM security_verify_log
         WHERE id = ?
           AND user_id = ?
           AND request_url = ?
           AND action_type = ?
           AND pin_status IN (0, 2)
           AND verify_expire_time > NOW()
         LIMIT 1`,
		challengeID, userID, requestURL, routeActionType).Scan(&chID, &chErrCnt, &chRemark)
	if err != nil || !strings.Contains(chRemark, "method:"+normalizedMethod) {
		resp.JSON(w, 200, map[string]any{
			"code":    mw.CodeNeedVerify,
			"status":  200,
			"message": "风险验证已过期，请重新操作",
			"data":    map[string]any{"action_type": routeActionType, "expired": true},
		})
		return
	}

	m := bodyHashRe.FindStringSubmatch(chRemark)
	if m == nil {
		resp.JSON(w, 200, map[string]any{
			"code":    mw.CodeNeedVerify,
			"status":  200,
			"message": "风险验证已更新，请重新操作",
			"data":    map[string]any{"action_type": routeActionType, "expired": true},
		})
		return
	}
	bodyHash := m[1]

	pinCode := auth.UserPinCode(userID)
	if pinCode == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "请先设置 PIN 码"})
		return
	}

	if !mw.CheckPwd(pinCode, pin) {
		errorCount := chErrCnt + 1

		if errorCount >= maxErrorCount {
			_, _ = db.DB().Exec(
				`UPDATE security_verify_log
                 SET pin_status = 2, error_count = ?, remark = ?
                 WHERE id = ? AND user_id = ?`,
				errorCount, strings.Split(chRemark, ";验证失败第")[0]+";触发系统锁定", chID, userID)

			// 防止短时间内重复插入软锁记录
			var lockID string
			hasLock := db.DB().QueryRow(
				`SELECT id FROM security_verify_log
                 WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0
                 LIMIT 1`, userID).Scan(&lockID) == nil
			if !hasLock {
				_, _ = db.DB().Exec(
					`INSERT INTO security_verify_log
                     (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
                     VALUES (?, ?, ?, 0, 0, ?, NOW())`,
					userID, "/lock-system", "lock", "风险操作 PIN 错误次数过多，临时锁定")
				// 与 lock-system 一致：清掉内存放行会话，避免软锁被 30 秒放行窗口绕过
				mw.ClearVerifiedSession(userID)
			}

			resp.JSON(w, 200, map[string]any{
				"code":    mw.CodeError,
				"status":  200,
				"message": "PIN 错误次数过多，操作受限，请验证系统 PIN",
				"data":    map[string]any{"action_type": routeActionType},
			})
			return
		}

		_, _ = db.DB().Exec(
			`UPDATE security_verify_log
             SET pin_status = 2, error_count = ?, remark = ?
             WHERE id = ? AND user_id = ?`,
			errorCount, strings.Split(chRemark, ";验证失败第")[0]+";验证失败第"+strconv.Itoa(errorCount)+"次", chID, userID)

		resp.JSON(w, 200, map[string]any{
			"code":    mw.CodeError,
			"status":  200,
			"message": "PIN 错误",
			"data": map[string]any{
				"action_type":       routeActionType,
				"challengeId":       chID,
				"requestUrl":        requestURL,
				"method":            normalizedMethod,
				"remainingAttempts": maxErrorCount - errorCount,
			},
		})
		return
	}

	// 验证成功：签发一次性 token，remark 写入与 mw.PinLockGuard 核销端一致的格式
	token := sec.RandBase64URL(32)
	tokenHash := sec.SHA256Hex([]byte(token))

	_, _ = db.DB().Exec(
		`UPDATE security_verify_log
         SET pin_status = 1,
             error_count = 0,
             verify_expire_time = DATE_ADD(NOW(), INTERVAL ? MINUTE),
             remark = ?
         WHERE id = ? AND user_id = ?`,
		routeExpireMin, tokenRemark(tokenHash, normalizedMethod, bodyHash), chID, userID)

	// 风险路由验证成功时，同步解除系统软锁定（避免后续普通请求被分支1.5 死循环拦截）
	_, _ = db.DB().Exec(
		`UPDATE security_verify_log
         SET pin_status = 1, remark = '系统已解锁'
         WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0`, userID)

	resp.JSON(w, 200, map[string]any{
		"code":    mw.CodeSuccess,
		"status":  200,
		"message": "验证成功",
		"data": map[string]any{
			"action_type": routeActionType,
			"token":       token,
			"headerName":  routeHeaderName,
			"expiresIn":   routeExpireMin * 60,
		},
	})
}

// tokenRemark 对应 pinLockGuard.tokenRemark：`route-token:${method}:${bodyHash}:${hash}`。
//
// 🔒 SYNC-A42（2026-10-13）：改回**明文**拼串（原为 SHA256Hex）。
//
//	Node pinLockGuard.js:32-34 就是明文：
//	    return `${TOKEN_PREFIX}${method}:${bodyHash}:${hash}`;
//	旧实现把整个串再哈希一层，Go 端自洽但与 Node 的 security_verify_log.remark
//	**不兼容** ⇒ 双端混跑（或灰度切换）时，一端签发的 token 在另一端核销必然失败，
//	风险路由 100% 退回 8303「验证已失效」；且 remark 不可读，丢失 method/bodyHash 明文，
//	排障困难。
//	注：这里的 hash 参数本身已是 token 的 SHA256（见调用处），不含 token 明文。
func tokenRemark(hash, method, bodyHash string) string {
	return routeTokenPfx + method + ":" + bodyHash + ":" + hash
}

// ================= 2. 设置 PIN =================

// SetPin 对应 securityController.setPin。
func SetPin(w http.ResponseWriter, r *http.Request) {
	// 🔄 2026-10-13（api.md P2-12）：双路径 `const { pin: rawPin } = req.body.data || req.body`。
	d := resp.Parse(r).DataOrRaw()
	pin := auth.ResolvePin(d["pin"])

	if pin == "" || len(pin) != 6 || !allDigits(pin) {
		resp.Say(w, "PIN码必须是6位纯数字", 400)
		return
	}

	status, message := auth.UserPinCreate(resp.UID(r), pin)
	if status != 200 {
		resp.JSON(w, status, map[string]any{"status": status, "message": message})
		return
	}
	resp.Say(w, "设置成功", 200)
}

// ================= 3. 修改 / 关闭 PIN =================

// ChangePin 对应 securityController.changePin（newPin=000000 为关闭 PIN）。
func ChangePin(w http.ResponseWriter, r *http.Request) {
	userID := resp.UID(r)

	// 🔄 2026-10-13（api.md P2-12）：双路径 `const { oldPin, newPin } = req.body.data || req.body`。
	d := resp.Parse(r).DataOrRaw()
	oldPin := auth.ResolvePin(d["oldPin"])
	newPin := auth.ResolvePin(d["newPin"])

	if oldPin == "" || len(oldPin) != 6 || !allDigits(oldPin) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "原 PIN 码必须是6位纯数字"})
		return
	}
	if newPin == "" || len(newPin) != 6 || !allDigits(newPin) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "新 PIN 码必须是6位纯数字"})
		return
	}

	const closePinFlag = "000000" // 关闭 PIN 的固定标记

	pinCode := auth.UserPinCode(userID)
	if pinCode == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "请先设置 PIN 码"})
		return
	}

	if !mw.CheckPwd(pinCode, oldPin) {
		// 错误计数：有记录则对最新一条累加，无记录则插入（与 verifyPin 的 3 次锁定语义一致）
		var (
			pinLogID     int64
			pinLogErrCnt int
		)
		hasLog := db.DB().QueryRow(
			`SELECT id, error_count FROM security_verify_log
             WHERE user_id = ? AND action_type <> 'route_verify'
             ORDER BY id DESC LIMIT 1`, userID).Scan(&pinLogID, &pinLogErrCnt) == nil
		if hasLog {
			_, _ = db.DB().Exec(
				`UPDATE security_verify_log
                 SET pin_status = 2, error_count = error_count + 1, remark = '验证失败'
                 WHERE id = ?`, pinLogID)
		} else {
			_, _ = db.DB().Exec(
				`INSERT INTO security_verify_log
                 (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
                 VALUES (?, ?, 'verify', 2, 1, '验证失败', NOW())`,
				userID, requestURI(r))
		}
		pinErrCount := 1
		if hasLog {
			pinErrCount = pinLogErrCnt + 1
		}

		if pinErrCount >= maxErrorCount {
			// 连续 3 次 PIN 错误 → 锁定 PIN 验证（90 分钟，与 verifyPin 一致）
			_, _ = db.DB().Exec(
				`UPDATE security_verify_log
                 SET pin_status = 3, remark = '锁定90分钟'
                 WHERE user_id = ? AND pin_status = 2 AND action_type <> 'route_verify'
                 ORDER BY id DESC LIMIT 1`, userID)
			resp.JSON(w, 200, map[string]any{
				"code":    mw.CodeLocked,
				"status":  200,
				"message": "PIN 错误次数过多，已锁定90分钟",
				"data":    map[string]any{"locked": true},
			})
			return
		}

		// 错误次数未达阈值：同步 user_log 做账户级统计（保持原 5 次锁账户兜底）
		if auth.UserLogPinErrorCount(userID) >= 5 {
			auth.LockUser(userID)
			resp.JSON(w, 401, map[string]any{
				"status":      401,
				"message":     "连续输入错误超过5次，账户已被锁定",
				"forceLogout": true,
				"locked":      true,
			})
			return
		}

		// 🔴 登录失败统计
		// 🔒 SYNC-A19（2026-10-12）：改用服务端采集（BuildServerSideLogFields）——
		//   原实现 SpreadClient 把客户端整个 body 展开进日志（client 覆盖 base），
		//   攻击者可伪造 user_id/type/status/login_ip/fingerprint/path。
		//   这正是 Node P1-15「复审补漏」修掉的同一处（securityController.changePin）。
		fields := auth.BuildServerSideLogFields(r, userID)
		fields["type"] = "pin"
		fields["status"] = 0
		fields["error_message"] = "尝试修改PIN码PIN码输入错误"
		auth.UserLogAppend(fields)
		resp.JSON(w, 400, map[string]any{
			"status":            400,
			"message":           "原 PIN 码错误",
			"errorCount":        pinErrCount,
			"remainingAttempts": maxOf(maxErrorCount-pinErrCount, 0),
		})
		return
	}

	// 逻辑分支：关闭 PIN 或修改 PIN
	var status int
	var message string
	if newPin == closePinFlag {
		status, message = auth.UserPinClose(userID)
	} else {
		status, message = auth.UserPinUpdate(userID, oldPin, newPin)
	}
	resp.JSON(w, status, map[string]any{
		"status":  status,
		"message": message,
	})
}

// ================= 4. 重置 PIN =================

// ResetPin 对应 securityController.resetPin。
// 🔒 2026-10-13 修复（api.md P1-3）：恢复邮箱验证码校验。
//
//	原实现整段被注释（keep BUG-001）⇒ 任何已登录用户无需验证码/原 PIN 即可重设 PIN，
//	PIN 二次防护被完整绕过。校验口径与 changePasswordWithCode 一致：
//	查 device_crypto 的 email_verify_pwd 记录（scene=用户当前邮箱），
//	比对验证码 + 有效期 + 未使用，通过后核销。
func ResetPin(w http.ResponseWriter, r *http.Request) {
	// 🔄 2026-10-13（api.md P2-12）：双路径 `const { verificationCode, newPin } = req.body.data || req.body`。
	d := resp.Parse(r).DataOrRaw()
	verificationCode := toString(d["verificationCode"])
	newPin := auth.ResolvePin(d["newPin"]) // 支持 RSA 密文数组解密

	// 新 PIN 格式校验
	if newPin == "" || len(newPin) != 6 || !allDigits(newPin) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "PIN 码必须是6位纯数字"})
		return
	}

	if verificationCode == "" {
		resp.Say(w, "验证码不能为空", 400)
		return
	}

	userID := resp.UID(r)
	var dbEmail sql.NullString
	if err := db.DB().QueryRow(
		"SELECT email FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1", userID).
		Scan(&dbEmail); err != nil || !dbEmail.Valid {
		resp.Say(w, "您的账号未绑定邮箱，无法重置 PIN", 400)
		return
	}
	userEmail := dbEmail.String

	fingerprint := "email_verify_pwd"
	var (
		recCode      string
		recExpiresAt int64
		recVerified  int
	)
	if err := db.DB().QueryRow(
		"SELECT captcha_code, captcha_expires_at, captcha_verified FROM device_crypto WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
		fingerprint, userEmail, userID).Scan(&recCode, &recExpiresAt, &recVerified); err != nil {
		resp.Say(w, "验证码不存在或已过期", 400)
		return
	}
	now := tim.Now().UnixMilli()
	if now > recExpiresAt {
		resp.Say(w, "验证码已过期", 400)
		return
	}
	if recVerified == 1 {
		resp.Say(w, "验证码已被使用", 400)
		return
	}
	if recCode != verificationCode {
		_, _ = db.DB().Exec(
			"UPDATE device_crypto SET fail_count = fail_count + 1, updated_at = ? WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
			now, fingerprint, userEmail, userID)
		resp.Say(w, "验证码错误", 400)
		return
	}

	// 使用 UserPin.reset 重置 PIN
	status, message := auth.UserPinReset(userID, newPin)

	// 核销验证码（仅重置成功后）
	if status == 200 {
		_, _ = db.DB().Exec(
			"UPDATE device_crypto SET captcha_verified = 1, updated_at = ? WHERE fingerprint = ? AND scene = ? AND aes_key = ?",
			now, fingerprint, userEmail, userID)
	}

	resp.JSON(w, status, map[string]any{
		"status":  status,
		"message": message,
	})
}

// ================= 5. 设备风险信号上报（SYNC-012 / P2-14） =================

// 风险信号上报是「尽力而为」的纯信号落库（对齐 Node securityController.riskReport）：
//   - 不拒服务：无论内容是否有效都返回 200「已接收」，失败只告警不阻断
//     （上报失败不该影响 APP 正常使用）；
//   - pin_status 固定写 1 —— 该表 pin_status=0 会被 pinLockGuard 当成
//     「待验证/锁定」记录参与 PIN 拦截，风险信号绝不能影响那个流程。

// riskSignalNameRe 信号名白名单：APP 端 DeviceRiskInspector 的输出全集。
// 新增检测项时两端同步维护（P2-14：APP/.../security/DeviceRiskInspector.kt）。
var riskSignalNameRe = regexp.MustCompile(`^[a-z0-9_:-]{1,40}$`)

const riskSignalMax = 20

// riskRemark remark JSON 结构体（字段序对齐 Node JSON.stringify 的插入序）。
type riskRemark struct {
	Signals     []string `json:"signals"`
	UA          string   `json:"ua"`
	DeviceModel string   `json:"device_model"`
}

// RiskReport 对应 securityController.riskReport。
func RiskReport(w http.ResponseWriter, r *http.Request) {
	// Node: 整个 handler 包在 try/catch 里，任何异常都 res.say("已接收", 200)
	defer func() {
		if rec := recover(); rec != nil {
			println("[risk-signal] 上报处理异常（不阻断）:", fmt.Sprint(rec))
			resp.Say(w, "已接收", 200)
		}
	}()

	// Node: req.body?.data?.signals（两步断言避免 panic，nil map 取键安全）
	data, _ := resp.Parse(r).Raw["data"].(map[string]any)
	arr, ok := data["signals"].([]any)
	if !ok || len(arr) == 0 {
		resp.Say(w, "已接收", 200)
		return
	}

	// Node: filter(typeof s === "string" && SIGNAL_NAME_RE.test(s)).slice(0, MAX_SIGNALS)
	signals := make([]string, 0, len(arr))
	for _, s := range arr {
		if str, isStr := s.(string); isStr && riskSignalNameRe.MatchString(str) {
			signals = append(signals, str)
			if len(signals) >= riskSignalMax {
				break
			}
		}
	}
	if len(signals) == 0 {
		resp.Say(w, "已接收", 200)
		return
	}

	// Node: req.security?.ip || req.ip || "0.0.0.0" —— SecurityCheck 写入的
	// secInfo.ip 就是 mw.ClientIP(r) 的结果，直接同源取值，语义等价。
	ip := mw.ClientIP(r)
	remarkBytes, err := json.Marshal(riskRemark{
		Signals: signals,
		// 与 UserLog 的字段口径一致，便于登录日志关联分析
		UA:          cutRunes(r.Header.Get("x-user-agent-custom"), 160),
		DeviceModel: cutRunes(r.Header.Get("x-device-model"), 60),
	})
	if err != nil {
		println("[risk-signal] remark 序列化失败（不阻断）:", err.Error())
		resp.Say(w, "已接收", 200)
		return
	}

	if _, err := db.DB().Exec(
		`INSERT INTO security_verify_log
		 (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
		 VALUES (?, ?, 'risk_signal', 1, 0, ?, NOW())`,
		resp.UID(r), "/security/risk-report", string(remarkBytes),
	); err != nil {
		println("[risk-signal] 落库失败（不阻断）:", err.Error())
		resp.Say(w, "已接收", 200)
		return
	}
	println("[risk-signal] user=" + resp.UID(r) + " ip=" + ip + " signals=[" + strings.Join(signals, ",") + "]")
	resp.Say(w, "已接收", 200)
}

// cutRunes 对应 JS String(x || "").slice(0, n)（rune 截断近似 UTF-16 code unit 语义）。
func cutRunes(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n])
}

// ================= 辅助 =================

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func toString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	}
	return fmt.Sprintf("%v", v)
}

// requestURI 对应 req.originalUrl（路径 + query）。
func requestURI(r *http.Request) string {
	if r.URL.RawQuery != "" {
		return r.URL.Path + "?" + r.URL.RawQuery
	}
	return r.URL.Path
}

func maxOf(a, b int) int {
	if a > b {
		return a
	}
	return b
}
