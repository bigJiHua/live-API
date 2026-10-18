// 批 C 单元测试：SYNC-004（5xx 脱敏）+ SYNC-006（安全头）
//
// 运行：cd API_Go && go test ./internal/... -run TestSync -v
package mw

import (
	"encoding/json"
	"live/api/internal/resp"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ── SYNC-004：5xx 响应 error 键脱敏（生产删 / dev 留） ──

func TestSync004ErrorSanitizedInProduction(t *testing.T) {
	orig := resp.IsDev
	defer func() { resp.IsDev = orig }()

	resp.IsDev = func() bool { return false } // 模拟生产
	w := httptest.NewRecorder()
	resp.JSON(w, 500, map[string]any{"message": "查询失败", "error": "sql: table users does not exist", "status": 500})

	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if _, has := body["error"]; has {
		t.Fatalf("生产环境 error 键未删除: %s", w.Body.String())
	}
	if body["message"] != "查询失败" {
		t.Fatalf("message 被破坏: %v", body["message"])
	}
}

func TestSync004ErrorKeptInDev(t *testing.T) {
	orig := resp.IsDev
	defer func() { resp.IsDev = orig }()

	resp.IsDev = func() bool { return true } // 模拟开发
	w := httptest.NewRecorder()
	resp.JSON(w, 500, map[string]any{"message": "查询失败", "error": "sql: detail"})

	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["error"] != "sql: detail" {
		t.Fatalf("dev 环境 error 应保留: %s", w.Body.String())
	}
}

func TestSync004NoSanitizeBelow500(t *testing.T) {
	orig := resp.IsDev
	defer func() { resp.IsDev = orig }()

	resp.IsDev = func() bool { return false }
	w := httptest.NewRecorder()
	// 4xx 不在脱敏范围（与 Node buildErrorBody 只用于 500 的口径一致）
	resp.JSON(w, 400, map[string]any{"message": "参数错误", "error": "bad input"})
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["error"] != "bad input" {
		t.Fatalf("4xx 不应被脱敏: %s", w.Body.String())
	}
}

// ── SYNC-006：安全头中间件 ──

func TestSync006SecureHeadersPresent(t *testing.T) {
	h := SecureHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("GET", "/api/v1/auth/handshake?fp=x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	want := map[string]string{
		"Content-Security-Policy":           "", // 只查存在性
		"Cross-Origin-Resource-Policy":      "cross-origin",
		"Referrer-Policy":                   "no-referrer",
		"Strict-Transport-Security":         "max-age=15552000; includeSubDomains",
		"X-Content-Type-Options":            "nosniff",
		"X-Frame-Options":                   "SAMEORIGIN",
		"X-Permitted-Cross-Domain-Policies": "none",
		"X-XSS-Protection":                  "0",
	}
	for k, v := range want {
		got := rec.Header().Get(k)
		if got == "" {
			t.Fatalf("缺少安全头 %s", k)
		}
		if v != "" && got != v {
			t.Fatalf("%s 值不符: got %q want %q", k, got, v)
		}
	}
}

func TestSync006SecureHeadersOnPanicResponse(t *testing.T) {
	// panic 响应也应带头（SecureHeaders 挂最外层的意义）
	h := SecureHeaders(Recover(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	})))
	req := httptest.NewRequest("GET", "/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 500 {
		t.Fatalf("panic 应转 500，got %d", rec.Code)
	}
	if rec.Header().Get("X-Frame-Options") == "" {
		t.Fatal("panic 响应缺少安全头")
	}
}
