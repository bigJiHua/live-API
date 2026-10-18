package auth

// from: src/modules/auth/model/pin.js
// UserPin 模型：PIN 读写走 user_info 表，SQL 逐字复刻 Node。

import (
	"database/sql"

	"live/api/internal/db"
	"live/api/internal/mw"
)

// UserPinCode 对应 UserPin.findById 后读取 pin_code。
// Node findById 无记录返回 null、NULL 列为 null，控制器统一走 !user?.pin_code 分支，
// 故无记录/NULL 均以 "" 表示（调用方无法也不需要区分）。
func UserPinCode(userID string) string {
	var (
		id  string
		pin sql.NullString
	)
	if err := db.DB().QueryRow(
		"SELECT id, pin_code FROM "+userTable+" WHERE id = ? LIMIT 1", userID).Scan(&id, &pin); err != nil {
		return ""
	}
	return pin.String
}

// UserPinHas 对应 UserPin.hasPin。
func UserPinHas(userID string) bool { return UserPinCode(userID) != "" }

// UserPinCreate 对应 UserPin.create：已存在 PIN → 400。
func UserPinCreate(userID, plainPin string) (int, string) {
	if UserPinCode(userID) != "" {
		return 400, "PIN码已存在，请使用修改接口"
	}
	hashedPin, err := mw.BcryptHash(plainPin, saltRounds())
	if err != nil {
		return 500, "设置失败"
	}
	if _, err := db.DB().Exec(
		"UPDATE "+userTable+" SET pin_code = ?, update_time = NOW() WHERE id = ?", hashedPin, userID); err != nil {
		return 500, "设置失败"
	}
	return 200, "设置成功"
}

// UserPinUpdate 对应 UserPin.update：未设置 → 400；旧 PIN 错误 → 401。
func UserPinUpdate(userID, oldPin, newPin string) (int, string) {
	code := UserPinCode(userID)
	if code == "" {
		return 400, "请先设置 PIN 码"
	}
	// 对应 bcrypt.compare；Node 侧无 try/catch（哈希损坏会抛错上抛），Go 端 mw.CheckPwd 出错返回 false。
	if !mw.CheckPwd(code, oldPin) {
		return 401, "原 PIN 码错误"
	}
	hashedPin, err := mw.BcryptHash(newPin, saltRounds())
	if err != nil {
		return 500, "修改失败"
	}
	if _, err := db.DB().Exec(
		"UPDATE "+userTable+" SET pin_code = ?, update_time = NOW() WHERE id = ?", hashedPin, userID); err != nil {
		return 500, "修改失败"
	}
	return 200, "修改成功"
}

// UserPinReset 对应 UserPin.reset。
// keep BUG-001：Node controller 的 verificationCode 校验被注释掉，此处同样不做验证码校验。
func UserPinReset(userID, newPin string) (int, string) {
	hashedPin, err := mw.BcryptHash(newPin, saltRounds())
	if err != nil {
		return 500, "重置失败"
	}
	if _, err := db.DB().Exec(
		"UPDATE "+userTable+" SET pin_code = ?, update_time = NOW() WHERE id = ?", hashedPin, userID); err != nil {
		return 500, "重置失败"
	}
	return 200, "重置成功"
}

// UserPinClose 对应 UserPin.close。
func UserPinClose(userID string) (int, string) {
	if _, err := db.DB().Exec(
		"UPDATE "+userTable+" SET pin_code = NULL, update_time = NOW() WHERE id = ?", userID); err != nil {
		return 500, "关闭失败"
	}
	return 200, "PIN 码已关闭"
}
