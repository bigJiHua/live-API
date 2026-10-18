package mw

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"live/api/internal/sec"
)

// SYNC-013（2026-10-12）：取 token 双通道回归护栏。
//
// ## 背景（为什么必须有这个测试）
// Node 侧 P0-5 改造（httpOnly Cookie）后，web 只带 Cookie 不发 Bearer 头；
// Go 侧 AuthGuard / extractBearerUID 只认 Bearer ⇒ web 用户被恒判「未登录」，
// PIN 风控（PinSecurityGuard）对 web 静默失效 —— 与 Node 侧 2026-10-12 修复的
// pinSecurityGuard 同款问题。本测试钉死三条通道行为，防止口径再分叉。
//
// ## 断言设计（全部不依赖 DB）
// - AuthGuard 只测在 user_info 查询**之前** return 的分支
//   （未提供认证令牌 / 无效的认证令牌）；
// - 「Cookie 垃圾值 → 无效的认证令牌」是关键用例：Bearer-only 旧实现下
//   会误报「未提供认证令牌」，本用例抓得住通道没接上的回归。

// 用统一密钥源造 token（与 AuthGuard/extractUID 验签同用 JWTSecret()，无需关心 env）
func signToken(t *testing.T, userID string) string {
	t.Helper()
	token, err := sec.Sign(JWTSecret(), sec.Claims{UserID: userID}, time.Hour)
	if err != nil {
		t.Fatalf("sec.Sign: %v", err)
	}
	return token
}

func reqWith(bearer, cookieVal string) *http.Request {
	r := httptest.NewRequest("GET", "/api/v1/card/list", nil)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	if cookieVal != "" {
		r.AddCookie(&http.Cookie{Name: authCookieName, Value: cookieVal})
	}
	return r
}

// ===== ExtractAuthToken 三通道口径 =====

func TestExtractAuthTokenBearerPriority(t *testing.T) {
	bearer := signToken(t, "u-bearer")
	cookie := signToken(t, "u-cookie")
	if got := ExtractAuthToken(reqWith(bearer, cookie)); got != bearer {
		t.Fatalf("Bearer 应优先：got %q", got)
	}
}

func TestExtractAuthTokenCookieFallback(t *testing.T) {
	cookie := signToken(t, "u-cookie")
	if got := ExtractAuthToken(reqWith("", cookie)); got != cookie {
		t.Fatalf("无 Bearer 应回落 Cookie：got %q", got)
	}
}

func TestExtractAuthTokenEmptyWhenNone(t *testing.T) {
	if got := ExtractAuthToken(reqWith("", "")); got != "" {
		t.Fatalf("两通道都无应返回空：got %q", got)
	}
}

func TestExtractAuthTokenEmptyBearerFallsBackToCookie(t *testing.T) {
	// 对齐 Node extractToken：Bearer 头存在但 token 为空 ⇒ 继续回落 Cookie
	cookie := signToken(t, "u-cookie")
	r := httptest.NewRequest("GET", "/api/v1/x", nil)
	r.Header.Set("Authorization", "Bearer ")
	r.AddCookie(&http.Cookie{Name: authCookieName, Value: cookie})
	if got := ExtractAuthToken(r); got != cookie {
		t.Fatalf("空 Bearer 应回落 Cookie：got %q", got)
	}
}

// ===== extractUID（PinSecurityGuard 的验签路径，不查库可完整测）=====

func TestExtractUIDViaCookie(t *testing.T) {
	// 关键回归护栏：Bearer-only 旧实现下 web Cookie 用户恒返回 ""（风控静默失效）
	if uid := extractUID(reqWith("", signToken(t, "u-web"))); uid != "u-web" {
		t.Fatalf("Cookie 通道应识别 userId：got %q", uid)
	}
}

func TestExtractUIDViaBearer(t *testing.T) {
	if uid := extractUID(reqWith(signToken(t, "u-app"), "")); uid != "u-app" {
		t.Fatalf("Bearer 通道行为不变：got %q", uid)
	}
}

func TestExtractUIDInvalidToken(t *testing.T) {
	if uid := extractUID(reqWith("", "not-a-jwt")); uid != "" {
		t.Fatalf("无效 token 应回空：got %q", uid)
	}
}

// ===== AuthGuard 分支（DB 查询之前的分支）=====

func guardBody(t *testing.T, r *http.Request) string {
	t.Helper()
	rec := httptest.NewRecorder()
	AuthGuard(http.NotFoundHandler()).ServeHTTP(rec, r)
	return rec.Body.String()
}

func TestAuthGuardNoToken(t *testing.T) {
	if body := guardBody(t, reqWith("", "")); !strings.Contains(body, "未提供认证令牌") {
		t.Fatalf("应报未提供认证令牌：%s", body)
	}
}

func TestAuthGuardCookieChannelReachesVerify(t *testing.T) {
	// 关键：Cookie 中的垃圾值必须走到「验签失败」而非「未提供认证令牌」——
	// 证明 Cookie 通道真的被读取（Bearer-only 旧实现下本用例会失败）
	if body := guardBody(t, reqWith("", "not-a-jwt")); !strings.Contains(body, "无效的认证令牌") {
		t.Fatalf("Cookie 通道应进入验签（无效的认证令牌）：%s", body)
	}
}

func TestAuthGuardBearerInvalid(t *testing.T) {
	if body := guardBody(t, reqWith("garbage-token", "")); !strings.Contains(body, "无效的认证令牌") {
		t.Fatalf("Bearer 无效应报无效的认证令牌：%s", body)
	}
}
