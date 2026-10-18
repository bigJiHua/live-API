package mw

// 批 E 单元测试：SYNC-011 签名守卫三模式矩阵
//
// 运行：cd API_Go && go test ./internal/mw/ -run TestSync011 -v

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const goodSig = "ab"

func goodSig64() string {
	s := ""
	for i := 0; i < 32; i++ {
		s += goodSig
	}
	return s
}

func passthrough(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }

func runGuard(path, sig string) *httptest.ResponseRecorder {
	h := AppSignatureGuard(http.HandlerFunc(passthrough))
	req := httptest.NewRequest("POST", path, nil)
	if sig != "" {
		req.Header.Set("X-App-Sign-Sha256", sig)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSync011NoWhitelist(t *testing.T) {
	t.Setenv("APP_SIGN_SHA256", "")
	t.Setenv("APP_SIGN_ENFORCE", "")
	// 未配置 ⇒ 守卫不启用：带假签名也放行（200 透传）
	if rec := runGuard("/api/v1/auth/login", "deadbeef"); rec.Code != 200 {
		t.Fatalf("未配置应放行, got %d", rec.Code)
	}
}

func TestSync011Loose(t *testing.T) {
	t.Setenv("APP_SIGN_SHA256", goodSig64())
	t.Setenv("APP_SIGN_ENFORCE", "loose")

	if rec := runGuard("/api/v1/auth/login", goodSig64()); rec.Code != 200 {
		t.Fatalf("匹配签名应放行, got %d", rec.Code)
	}
	if rec := runGuard("/api/v1/auth/login", "deadbeef"); rec.Code != 403 {
		t.Fatalf("不匹配应 403, got %d", rec.Code)
	}
	if rec := runGuard("/api/v1/auth/login", ""); rec.Code != 200 {
		t.Fatalf("loose 无头应放行（浏览器）, got %d", rec.Code)
	}
	// 大小写归一化
	if rec := runGuard("/api/v1/auth/login", strings.ToUpper(goodSig64())); rec.Code != 200 {
		t.Fatalf("大写应归一化匹配, got %d", rec.Code)
	}
}

func TestSync011Strict(t *testing.T) {
	t.Setenv("APP_SIGN_SHA256", goodSig64())
	t.Setenv("APP_SIGN_ENFORCE", "strict")

	if rec := runGuard("/api/v1/auth/login", ""); rec.Code != 403 {
		t.Fatalf("strict 无头应 403, got %d", rec.Code)
	}
	if rec := runGuard("/api/v1/auth/login", goodSig64()); rec.Code != 200 {
		t.Fatalf("strict 匹配应放行, got %d", rec.Code)
	}
}

func TestSync011PublicExempt(t *testing.T) {
	t.Setenv("APP_SIGN_SHA256", goodSig64())
	t.Setenv("APP_SIGN_ENFORCE", "strict")
	// /api/public 豁免（Node 复审修复同款）：strict 下静态资源也放行
	if rec := runGuard("/api/public/img/logo.png", "deadbeef"); rec.Code != 200 {
		t.Fatalf("/api/public 应豁免, got %d", rec.Code)
	}
}

func TestSync011WhitelistNormalization(t *testing.T) {
	// 白名单含非法项 + 大写 + 多值：只有合法 64hex 进白名单
	t.Setenv("APP_SIGN_SHA256", "BADLIST, "+goodSig64()+", "+strings.Repeat("cd", 32))
	t.Setenv("APP_SIGN_ENFORCE", "loose")
	wl := GetWhitelist()
	if len(wl) != 2 {
		t.Fatalf("白名单应过滤非法项剩 2 个, got %d", len(wl))
	}
	// 第二个合法项也能匹配
	if rec := runGuard("/api/v1/x", strings.Repeat("cd", 32)); rec.Code != 200 {
		t.Fatalf("多值白名单第二项应匹配, got %d", rec.Code)
	}
}
