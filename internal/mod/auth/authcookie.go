package auth

// from: src/common/utils/authCookie.js（安全整改 P0-5）
// 认证 Cookie 双通道：httpOnly Cookie（web 端，JS 读不到 ⇒ XSS 窃取无效）
// + Authorization: Bearer（APP / webview-APP 原生端不发 Cookie）。
// 属性必须与 Node 逐字一致，否则浏览器认不出是同一个 Cookie、清不掉。

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"live/api/internal/config"
)

// TokenCookieName Cookie 名（与前端约定，改了等于让所有人重新登录）。
const TokenCookieName = "finance_token"

// DefaultTokenTTLSec JWT 默认有效期（秒），与 .env 的 JWT_EXPIRES_IN=7d 对齐。
const DefaultTokenTTLSec = 7 * 24 * 60 * 60

// SetAuthCookie 下发认证 Cookie（对应 authCookie.setAuthCookie）。
func SetAuthCookie(w http.ResponseWriter, token string, maxAgeSec int) {
	http.SetCookie(w, &http.Cookie{
		Name:     TokenCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   maxAgeSec,
		HttpOnly: true,
		Secure:   config.IsProduction(),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearAuthCookie 清除认证 Cookie（maxAge=0 ⇒ 立即过期）。
// ⚠ 属性必须与设置时一致，否则清不掉。
func ClearAuthCookie(w http.ResponseWriter) {
	SetAuthCookie(w, "", 0)
}

// ttlPattern 对应 authCookie.js:80 的 /^(\d+(?:\.\d+)?)\s*([smhd])?$/i。
var ttlPattern = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*([smhd])?$`)

// ResolveTokenTTLSec 把 JWT_EXPIRES_IN（"7d"/"12h"/"30m"/"3600"）解析成秒。
// 无法解析时返回 DefaultTokenTTLSec（Node 返回 undefined 交由 cookie 库用默认，
// 等价效果一致）。
func ResolveTokenTTLSec() int {
	return ParseTTLSec(config.Get("JWT_EXPIRES_IN", "7d"))
}

// ParseTTLSec 解析 TTL 字符串为秒数，失败返回 DefaultTokenTTLSec。
func ParseTTLSec(raw string) int {
	s := strings.TrimSpace(raw)
	if s == "" {
		s = "7d"
	}
	m := ttlPattern.FindStringSubmatch(s)
	if m == nil {
		return DefaultTokenTTLSec
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return DefaultTokenTTLSec
	}
	unit := "s"
	if m[2] != "" {
		unit = strings.ToLower(m[2])
	}
	mult := map[string]float64{"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
	return int(n * mult)
}
