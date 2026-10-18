package auth

// from: src/modules/auth/model/user.js
// User 模型：SQL 逐字复刻 Node（? 占位），keep/fix 标注同 api.logs。

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

const userTable = "user_info"

// ================= 行 → map 工具 =================

// scanRow 查询单行并转为 map（列名 → 值）；无记录返回 nil, nil。
func scanRow(q string, args ...any) (map[string]any, error) {
	rows, err := db.DB().Query(q, args...)
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

// scanRows 查询多行并转为 []map。
func scanRows(q string, args ...any) ([]map[string]any, error) {
	rows, err := db.DB().Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
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
		out = append(out, m)
	}
	return out, rows.Err()
}

// normVal DB 值 → JSON 友好值：[]byte→string；time.Time→Node JSON.stringify(Date)
// 的 UTC ISO 格式（带毫秒 + Z）；其余原样（int64→JSON number，nil→null）。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// ================= 通用值转换（对应 JS 松散语义） =================

// toString 对应 JS String(v) 的常用子集：nil→""，string/Number 原样，其余 fmt。
func toString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return fmt.Sprintf("%v", v)
}

func toInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case float64:
		return int64(t), true
	case json.Number:
		n, err := t.Int64()
		return n, err == nil
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		return n, err == nil
	}
	return 0, false
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

// ================= User 模型 =================

// FindUserByUsername 对应 User.findByUsername（无记录返回 nil, nil）。
func FindUserByUsername(username string) (map[string]any, error) {
	return scanRow("SELECT * FROM "+userTable+" WHERE username = ?", username)
}

// FindUserByEmail 对应 User.findByEmail（无记录返回 nil, nil）。
func FindUserByEmail(email string) (map[string]any, error) {
	return scanRow("SELECT * FROM "+userTable+" WHERE email = ?", email)
}

// FindUserByID 对应 User.findById。
// 🔄 2026-10-13 修复（api.md P2-3）：用户不存在时返回 nil。
//
//	原实现 `return { ...rows[0], login_pwd: "", pin_code: "" } || null`——
//	对象字面量恒为 truthy，`|| null` 永不生效 ⇒ 用户不存在也返回空对象，
//	调用方（getCurrentUser 等）的 `if (!user)` 判空失效。
func FindUserByID(id string) map[string]any {
	row, err := scanRow("SELECT * FROM "+userTable+" WHERE id = ?", id)
	if err != nil || row == nil {
		return nil
	}
	row["login_pwd"] = ""
	row["pin_code"] = ""
	return row
}

// CreateUser 对应 User.create：返回 insertId（Node 返回 mysql2 result，adminRegister 只读其 id）。
func CreateUser(username, email, loginPwd, identity string) (int64, error) {
	newUserID := idgen.UserID()
	var emailArg any
	if email != "" {
		emailArg = email // Node: email || null
	}
	if identity == "" {
		identity = "user"
	}
	res, err := db.DB().Exec(
		"INSERT INTO "+userTable+" (id, username, email, login_pwd, identity, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
		newUserID, username, emailArg, loginPwd, identity,
		tim.Now().UnixMilli(), tim.Now().Format("2006-01-02 15:04:05"))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateUser 对应 User.update(id, updates, req)。
// 返回（更新后的用户, status, message）；status=200 时 user 有效（Node {status:200, user}）。
// r 为 nil 时不写 change_username 日志（对应 Node 不传 req）。
func UpdateUser(id string, updates map[string]any, r *http.Request) (map[string]any, int, string) {
	var logData map[string]any
	if u, ok := updates["username"].(string); ok && u != "" {
		currentUser := FindUserByID(id)
		if u != toString(currentUser["username"]) {
			// A. 校验唯一性
			var existID string
			if err := db.DB().QueryRow(
				"SELECT id FROM "+userTable+" WHERE username = ? AND id != ? LIMIT 1", u, id).Scan(&existID); err == nil {
				return nil, 206, "该用户名已被占用"
			}
			// B. 校验修改周期：user_log 上次 change_username 起 1 年限制
			const oneYearMS = int64(365 * 24 * 60 * 60 * 1000)
			now := tim.Now().UnixMilli()
			var lastChange int64
			if err := db.DB().QueryRow(
				"SELECT create_time FROM user_log WHERE user_id = ? AND type = 'change_username' ORDER BY id DESC LIMIT 1", id).
				Scan(&lastChange); err == nil {
				if now-lastChange < oneYearMS {
					diffDays := int64(math.Ceil(float64(oneYearMS-(now-lastChange)) / float64(24*60*60*1000)))
					return nil, 206, "用户名距离上次修改已过 " + strconv.FormatInt(diffDays, 10) + " 天，还需等待"
				}
			}
			oldName := toString(currentUser["username"])
			// 🔒 SYNC-A20（2026-10-12）：改用服务端可信采集（Node model/user.js:179-194
			//   的 P1-15 补漏）。原实现把 req.body 的平铺字段（login_ip/fingerprint/path…）
			//   当日志字段 —— 客户端可塞同名键伪造审计日志；且 token 存的是完整
			//   Authorization 头（仅靠 append 内部截断 50）。此处只保留业务语义字段。
			logData = BuildServerSideLogFields(r, id)
			logData["type"] = "change_username"
			logData["status"] = 1
			logData["error_message"] = "修改用户名: [" + oldName + "] -> [" + u + "]"
		} else {
			return nil, 206, "新旧名不能一致！"
		}
	}

	// --- 2. 构建 SQL 字段（fieldMap 顺序 = Node updateData 构造顺序）---
	fieldMap := map[string]bool{"username": true, "avatar": true, "email": true}
	var fields []string
	var values []any
	for _, key := range []string{"username", "avatar", "email"} {
		if fieldMap[key] {
			if v, ok := updates[key]; ok {
				fields = append(fields, key+" = ?")
				values = append(values, v)
			}
		}
	}
	if len(fields) == 0 {
		// keep BUG-045：settings 等不在 fieldMap 中的字段被静默丢弃（原样返回用户）
		return FindUserByID(id), 200, ""
	}

	// --- 3. 执行更新 ---
	fields = append(fields, "update_time = NOW()")
	query := "UPDATE " + userTable + " SET " + strings.Join(fields, ", ") + " WHERE id = ?"
	values = append(values, id)
	if _, err := db.DB().Exec(query, values...); err != nil {
		return nil, 500, "系统繁忙，请稍后再试"
	}

	// --- 4. 自动化记录 UserLog ---
	if logData != nil && r != nil {
		UserLogAppend(logData)
	}
	return FindUserByID(id), 200, ""
}

// authHeader 对应 req.headers.authorization。
func authHeader(r *http.Request) any {
	if r == nil {
		return nil
	}
	if v := r.Header.Get("Authorization"); v != "" {
		return v
	}
	return nil
}

// bodyStr 取 req.body 平铺字段（解密中间件已平铺；Go 端 = Body.Raw）。
func bodyStr(r *http.Request, key string) any {
	if r == nil {
		return nil
	}
	return resp.Parse(r).Raw[key]
}

// bodyOrIP 对应 req.body.login_ip === "unknown" ? req.ip : req.body.login_ip。
func bodyOrIP(r *http.Request, key string) any {
	v := bodyStr(r, key)
	if toString(v) == "unknown" {
		return mw.ClientIP(r)
	}
	return v
}

// pathOrDefault 对应 req.body.path || "/profile/edit"。
func pathOrDefault(r *http.Request, def string) any {
	v := bodyStr(r, "path")
	if s := toString(v); s != "" {
		return v
	}
	return def
}

// SetLockStatus 对应 User.setLockStatus。
func SetLockStatus(id string, locked bool) (int, string) {
	status := 1
	if locked {
		status = 0
	}
	if _, err := db.DB().Exec(
		"UPDATE "+userTable+" SET status = ?, update_time = ? WHERE id = ?", status, tim.Now().UnixMilli(), id); err != nil {
		return 500, "操作失败"
	}
	if locked {
		return 200, "账户已锁定"
	}
	return 200, "账户已解锁"
}

// LockUser 对应 User.lockUser（PIN 错误超限调用）。
func LockUser(id string) (int, string) {
	if _, err := db.DB().Exec(
		"UPDATE "+userTable+" SET status = 0, update_time = ? WHERE id = ?", tim.Now().UnixMilli(), id); err != nil {
		return 500, "操作失败"
	}
	return 200, "账户已被锁定"
}

// VerifyUserPassword 对应 User.verifyPassword（bcrypt 出错/空值一律 false）。
func VerifyUserPassword(plainPassword, hashedPassword string) bool {
	if plainPassword == "" || hashedPassword == "" {
		return false
	}
	return mw.CheckPwd(hashedPassword, plainPassword)
}

// CountUsers 对应 User.count。
// keep BUG-044：COUNT(*) 不过滤 is_deleted（软删用户占位）。
func CountUsers() (int, error) {
	var count int
	if err := db.DB().QueryRow("SELECT COUNT(*) as count FROM " + userTable).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// saltRounds 对应 parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10。
func saltRounds() int {
	if v := config.Get("BCRYPT_SALT_ROUNDS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 10
}
