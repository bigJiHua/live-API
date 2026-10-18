package auth

// SYNC-A38（2026-10-12）：为 SYNC-A2（httpOnly 认证 Cookie 双通道）补单测。
//
// 背景：Go 端此前**全仓无任何 Set-Cookie 写入点** —— 登录/刷新都不下发 Cookie，
// P0-5（XSS 窃取令牌）整改在 Go 端完全落空，且 ExtractAuthToken 的 Cookie
// 回落通道永远命中不到。本测试锁定 Cookie 属性与 TTL 解析。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"live/api/internal/config"
)

// TestSetAuthCookieAttributes 属性必须与 Node authCookie.buildCookieOptions 逐项一致，
// 否则浏览器认不出是同一个 Cookie、清不掉。
func TestSetAuthCookieAttributes(t *testing.T) {
	t.Setenv("NODE_ENV", "development") // dev 走 http://localhost，secure 必须为 false

	w := httptest.NewRecorder()
	SetAuthCookie(w, "test.jwt.token", 604800)

	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("应下发 1 个 Cookie，实际 %d", len(cookies))
	}
	c := cookies[0]

	if c.Name != "finance_token" {
		t.Errorf("Cookie 名 = %q，期望 finance_token", c.Name)
	}
	if c.Value != "test.jwt.token" {
		t.Errorf("Cookie 值 = %q", c.Value)
	}
	if !c.HttpOnly {
		t.Errorf("HttpOnly 必须为 true —— 这是 P0-5 的核心（JS 读不到 ⇒ XSS 窃取无效）")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite = %v，期望 Lax（strict 会让外链跳回不带 Cookie）", c.SameSite)
	}
	if c.Secure {
		t.Errorf("dev 环境 secure 应为 false，否则本地根本带不上 Cookie")
	}
	if c.Path != "/" {
		t.Errorf("Path = %q，期望 /", c.Path)
	}
	if c.MaxAge != 604800 {
		t.Errorf("MaxAge = %d，期望 604800（与 JWT 有效期一致）", c.MaxAge)
	}
}

// TestSetAuthCookieSecureInProduction 生产必须带 secure。
func TestSetAuthCookieSecureInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	w := httptest.NewRecorder()
	SetAuthCookie(w, "t", 3600)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure {
		t.Errorf("生产环境 Cookie 必须带 Secure")
	}
}

// TestClearAuthCookie 属性必须与设置时一致，否则清不掉。
func TestClearAuthCookie(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	w := httptest.NewRecorder()
	ClearAuthCookie(w)

	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("清除时应下发 1 个过期 Cookie，实际 %d", len(cookies))
	}
	c := cookies[0]
	if c.Name != "finance_token" || c.Value != "" || c.MaxAge != 0 {
		t.Errorf("清除 Cookie 属性不符：name=%q value=%q maxAge=%d", c.Name, c.Value, c.MaxAge)
	}
	// 属性一致性：与设置时同 path / httpOnly / samesite
	if c.Path != "/" || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
		t.Errorf("清除时的属性必须与设置时一致，否则浏览器认不出同一个 Cookie")
	}
}

// TestParseTTLSec 对齐 authCookie.resolveTokenTtlSec 的正则与单位。
func TestParseTTLSec(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"7d", 604800},
		{"12h", 43200},
		{"30m", 1800},
		{"3600", 3600},
		{"3600s", 3600},
		{"1.5h", 5400},
		{" 7D ", 604800}, // 大小写不敏感 + trim
		{"", DefaultTokenTTLSec},
		{"garbage", DefaultTokenTTLSec},
		{"-5d", DefaultTokenTTLSec},
	}
	for _, c := range cases {
		if got := ParseTTLSec(c.in); got != c.want {
			t.Errorf("ParseTTLSec(%q) = %d，期望 %d", c.in, got, c.want)
		}
	}
}

// TestResolveTokenTTLSecFromEnv 直接读 JWT_EXPIRES_IN。
func TestResolveTokenTTLSecFromEnv(t *testing.T) {
	t.Setenv("JWT_EXPIRES_IN", "30d")
	if got := ResolveTokenTTLSec(); got != 30*24*3600 {
		t.Errorf("ResolveTokenTTLSec() = %d，期望 %d", got, 30*24*3600)
	}
	t.Setenv("JWT_EXPIRES_IN", "bad-value")
	if got := ResolveTokenTTLSec(); got != DefaultTokenTTLSec {
		t.Errorf("非法值应回落默认 %d，实际 %d", DefaultTokenTTLSec, got)
	}
}

// TestCookieRoundTrip 端到端：Set → 请求带回 → 解析出同一 token。
// 这是「Cookie 通道真的通了」的守门测试。
func TestCookieRoundTrip(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	w := httptest.NewRecorder()
	SetAuthCookie(w, "abc.def.ghi", 3600)

	setCookie := w.Result().Cookies()[0]
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(setCookie)

	got, err := req.Cookie(TokenCookieName)
	if err != nil {
		t.Fatalf("Cookie 应能被回读：%v", err)
	}
	if got.Value != "abc.def.ghi" {
		t.Errorf("回读值 = %q", got.Value)
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), "HttpOnly") {
		t.Errorf("Set-Cookie 头缺 HttpOnly：%s", w.Header().Get("Set-Cookie"))
	}
}

// TestDefaultTokenTTL 对齐 JWT_EXPIRES_IN 默认 7d。
func TestDefaultTokenTTL(t *testing.T) {
	if DefaultTokenTTLSec != 7*24*60*60 {
		t.Errorf("DefaultTokenTTLSec = %d，期望 604800（7d）", DefaultTokenTTLSec)
	}
	_ = config.IsProduction // 确保 config 已链接（本包依赖它）
}
