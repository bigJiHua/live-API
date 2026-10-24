package auth

// from: src/modules/auth/model/log.js
// UserLog 模型：19 列审计日志，默认值逐字复刻 Node。

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"live/api/internal/db"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

const logTable = "user_log"

// SpreadClient 对应 JS 展开语法 { ...base, ...clientData }：clientData 覆盖 base 同名键
// （Node 的 UserLog.append({user_id, type, ..., ...clientData}) 中 clientData 在最后）。
func SpreadClient(base, client map[string]any) map[string]any {
	m := make(map[string]any, len(base)+len(client))
	for k, v := range base {
		m[k] = v
	}
	for k, v := range client {
		m[k] = v
	}
	return m
}

// firstStr 对应 JS `a || b || def` 真值链（空串/NULL 落到下一项）。
func firstStr(vals ...any) string {
	for _, v := range vals {
		if s := toString(v); s != "" {
			return s
		}
	}
	return ""
}

// UserLogAppend 对应 UserLog.append：19 列默认值全复刻；写失败仅打印不抛出
// （防止日志写失败导致用户登不上去）。
func UserLogAppend(logData map[string]any) {
	now := tim.Now().UnixMilli()
	uid := toString(logData["user_id"])
	if uid == "" {
		fmt.Fprintln(os.Stderr, "传入日志用户ID 不能为空！")
		return
	}
	token := firstStr(logData["token"])
	var tokenArg any
	if token != "" {
		tokenArg = truncateRunes(token, 50) // 只存 Token 存根
	}
	values := []any{
		uid,
		firstStr(logData["type"], "login"),
		tokenArg,
		firstStr(logData["login_ip"], logData["loginIp"], "0.0.0.0"),
		firstStr(logData["login_location"], logData["loginLocation"], "未知"),
		firstStr(logData["login_isp"], logData["loginIsp"], "未知"),
		firstStr(logData["user_agent"], logData["userAgent"], ""),
		firstStr(logData["os_info"], logData["osInfo"], ""),
		firstStr(logData["browser_info"], logData["browserInfo"], ""),
		firstStr(logData["device_model"], logData["deviceModel"], ""),
		firstStr(logData["fingerprint"], ""),
		firstStr(logData["viewport"], ""),
		firstStr(logData["pixel_ratio"], logData["pixelRatio"], "1"),
		statusOrDefault(logData["status"]), // 1成功 0失败
		firstStr(logData["error_message"], logData["errorMessage"], ""),
		firstStr(logData["login_lang"], logData["language"], "zh-CN"),
		firstStr(logData["path"], "/"),
		now,
		now,
	}
	if _, err := db.DB().Exec(
		"INSERT INTO "+logTable+" (user_id, type, token, login_ip, login_location, login_isp, user_agent, os_info, browser_info, device_model, fingerprint, viewport, pixel_ratio, status, error_message, login_lang, path, login_time, create_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		values...); err != nil {
		fmt.Fprintln(os.Stderr, "Critical: UserLog record failed!", err)
	}
}

// truncateRunes 对应 String.prototype.substring(0, 50)（存根截断）。
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// statusOrDefault 对应 logData.status ?? 1（仅 null/undefined 落默认，0 保留）。
func statusOrDefault(v any) int {
	if v == nil {
		return 1
	}
	if n, ok := toInt64(v); ok {
		return int(n)
	}
	return 1
}

// UserLogPinErrorCount 对应 UserLog.getPinErrorCount(userId, 30)：统计最近 30 分钟 PIN 失败次数。
// 出错返回 0（Node 同样 catch 后返回 0）。
func UserLogPinErrorCount(userID string) int {
	threshold := tim.Now().UnixMilli() - 30*60*1000
	var cnt int
	if err := db.DB().QueryRow(
		"SELECT COUNT(*) as errorCount FROM "+logTable+" WHERE user_id = ? AND type = 'pin' AND status = 0 AND create_time > ?",
		userID, strconv.FormatInt(threshold, 10)).Scan(&cnt); err != nil {
		return 0
	}
	return cnt
}

// BuildServerSideLogFields 审计日志字段的**服务端可信采集**（SYNC-003，2026-10-11；
// 对齐 Node common/utils/logFields.buildServerSideLogFields）。
//
// 背景：旧写法 SpreadClient({...clientData}) 把客户端整个 body 展开进日志 ——
// INSERT 虽参数化（无注入），但 UserLogAppend 按固定键名读取 login_ip/fingerprint/path 等，
// 客户端塞同名键即可伪造审计日志。现字段除地点/运营商外一律来自服务端可信来源：
//
//	login_ip     = mw.ClientIP（TRUST_PROXY_HOPS 收敛后，客户端不可伪造）
//	user_agent / os_info / device_model / fingerprint / viewport / pixel_ratio / login_lang = 请求头
//	path         = r.URL.Path（服务端路由）
//	login_location / login_isp = 解密后 body 顶层（仅展示，可伪造；2026-10-20 负责人拍板例外）
//	browser_info = 固定占位
//
// 地点/运营商的例外原因：部署方可能没有服务端 IP 库，内网访问时服务端看到的
// 192.168.x 任何 IP 库都查不出城市。这两个字段不得参与风控/审计定性/权限判断。
//
// 返回的 map 可直接传 UserLogAppend（调用方再补 type/status/error_message/user_id 等业务键）。
func BuildServerSideLogFields(r *http.Request, userID string) map[string]any {
	h := r.Header
	viewport := ""
	if vw, vh := h.Get("Viewportwidth"), h.Get("Viewportheight"); vw != "" && vh != "" {
		viewport = vw + "x" + vh
	}
	osInfo := h.Get("X-OS-Name")
	if dm := h.Get("X-Device-Model"); dm != "" {
		if osInfo != "" {
			osInfo += " "
		}
		osInfo += dm
	}
	lang := h.Get("Accept-Language")
	if lang == "" {
		lang = "zh-CN"
	}
	if len(lang) > 16 {
		lang = lang[:16]
	}
	pr := h.Get("Pixelratio")
	if pr == "" {
		pr = "1"
	}
	// 解密中间件已把客户端上下文平铺到 body 顶层；明文请求/未上报时为 nil。
	body := resp.Parse(r).Raw
	return map[string]any{
		"user_id":      userID,
		"login_ip":     mw.ClientIP(r),
		"user_agent":   h.Get("User-Agent"),
		"os_info":      osInfo,
		"device_model": h.Get("X-Device-Model"),
		"fingerprint":  h.Get("X-Fingerprint-Hash"),
		"viewport":     viewport,
		"pixel_ratio":  pr,
		"path":         r.URL.Path,
		"login_lang":   lang,
		"login_location": firstStr(
			clientReportedText(body["login_location"]),
			clientReportedText(body["loginLocation"]),
			"未知",
		),
		"login_isp": firstStr(
			clientReportedText(body["login_isp"]),
			clientReportedText(body["loginIsp"]),
			"未知",
		),
		"browser_info": "",
	}
}

// clientReportedText 客户端上报的展示型字段：只接受字符串；空/占位值视为未上报。
func clientReportedText(v any) string {
	s := strings.TrimSpace(toString(v))
	if s == "" || s == "--" || strings.EqualFold(s, "unknown") {
		return ""
	}
	return truncateRunes(s, 255)
}
