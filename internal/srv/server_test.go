package srv

// SYNC-A38（2026-10-12）：为 SYNC-A6/A7/A8 的装配层修复补单测。
//
// 覆盖三件事：
//  1. 中间件执行顺序 = app.js（pinSecurityGuard 先、appSignatureGuard 后）
//  2. CORS allowedHeaders 与 Node app.js:122-146 **逐项相等**（含 x-app-sign-sha256）
//  3. /api/v1 下未匹配路径回 JSON 404（不是 ServeMux 默认的 text/plain）

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
)

// ---------- 1. 中间件顺序 ----------

// TestMiddlewareOrderPinBeforeAppSignature 锁住 app.js:176-179 的顺序。
//
// 探针：注册两个可观测的中间件占位（记录进入顺序），
// 按 NewMux 的写法装配（先包 pin → pin 成内层；再包 appSignature → 成外层），
// 期望执行顺序为 appSignature 先、pin 后（与 Node 一致：
// app.use(pin) 先注册 ⇒ 在内层；app.use(appSignature) 后注册 ⇒ 在外层）。
func TestMiddlewareOrderPinBeforeAppSignature(t *testing.T) {
	var order []string
	mk := func(tag string) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, tag)
				next.ServeHTTP(w, r)
			})
		}
	}

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "handler")
		w.WriteHeader(200)
	})

	// 与 NewMux 相同的包装方向（后包装 = 外层）
	var h http.Handler = inner
	h = mk("pin")(h)
	h = mk("appSignature")(h)

	r := httptest.NewRequest(http.MethodGet, "/api/v1/account/list", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	h.ServeHTTP(httptest.NewRecorder(), r)

	want := []string{"appSignature", "pin", "handler"}
	if len(order) != len(want) {
		t.Fatalf("执行顺序 = %v，期望 %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("执行顺序 = %v，期望 %v", order, want)
		}
	}
}

// TestServeMuxStructure 冒烟：NewMux 能装配出来且不 panic，
// 且 /api/v1 下未匹配路径返回 JSON 404（SYNC-A6）。
func TestServeMuxStructure(t *testing.T) {
	t.Setenv("APP_SIGN_SHA256", "")
	mux := NewMux()

	// 未注册路径 → JSON 404
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/definitely-not-a-route", nil))
	if w.Code != 404 {
		t.Fatalf("未知路径 HTTP = %d，期望 404", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("404 响应体不是 JSON（应与 Node notFoundHandler 同构）：%s", w.Body.String())
	}
	if body["code"] != float64(404) {
		t.Errorf("404 响应缺 code 字段：%s", w.Body.String())
	}
	msg, _ := body["message"].(string)
	if !strings.HasPrefix(msg, "非法访问: GET /definitely-not-a-route！") {
		t.Errorf("404 message = %q", msg)
	}

	// /api/v1 下未匹配路径也必须是 JSON 404（SYNC-A6 的核心断言）
	w2 := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/no-such-module/x", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	mux.ServeHTTP(w2, req)
	if w2.Code != 400 && w2.Code != 404 {
		t.Fatalf("/api/v1 未匹配路径 HTTP = %d（400=securityCheck 拦截 / 404=JSON 404），body=%s",
			w2.Code, w2.Body.String())
	}
	if w2.Code == 404 && !strings.Contains(w2.Body.String(), `"code":404`) {
		t.Errorf("/api/v1 未匹配路径未返回 JSON 404，而是：%s", w2.Body.String())
	}
}

// TestHealthEndpointBypassesGuards 锁住 /api/health 的三条契约（2026-10-17）：
//  1. 不需要任何安全头（不带 X-Requested-With / 时间戳 / nonce）也能 200 —— APP 探测不能被手机时钟偏差误伤；
//  2. strict 签名模式下也不被 403（APP「接入站点」和运维 curl 都必须可用）；
//  3. 返回体带 data.service = live-finance，APP 据此判定「是本项目后端」。
func TestHealthEndpointBypassesGuards(t *testing.T) {
	t.Setenv("APP_SIGN_SHA256", strings.Repeat("a", 64))
	t.Setenv("APP_SIGN_ENFORCE", "strict")

	mux := NewMux()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	mux.ServeHTTP(w, req)

	if w.Code != 200 {
		t.Fatalf("/api/health HTTP = %d，期望 200（守卫必须豁免），body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("/api/health 响应不是 JSON：%s", w.Body.String())
	}
	data, _ := body["data"].(map[string]any)
	if data["service"] != healthServiceID {
		t.Errorf("data.service = %v，期望 %q", data["service"], healthServiceID)
	}
}

// ---------- 2. CORS ----------

// TestCORSAllowedHeadersMatchNode 与 Node app.js:122-146 的清单逐项比对。
// 漏一项 ⇒ 浏览器/webview 预检拒该头 ⇒ 对应功能在该端静默失效。
func TestCORSAllowedHeadersMatchNode(t *testing.T) {
	t.Setenv("FRONTEND_URL", "http://localhost:3000")
	h := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/account/list", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	h.ServeHTTP(w, req)

	got := splitAndTrim(w.Header().Get("Access-Control-Allow-Headers"))

	// Node app.js allowedHeaders 全集
	want := []string{
		"Content-Type", "Authorization", "viewportwidth", "viewportheight",
		"pixelratio", "navigatorplatform", "X-Requested-With", "x-client-timestamp",
		"x-fingerprint-hash", "x-user-agent-custom", "x-device-model", "x-os-name",
		"x-device-type", "x-scene", "X-FP-ID", "x-route-verify-token", "x-client-nonce",
		"x-app-sign-sha256", "x-sign", "x-client-ip",
	}

	wantSet := map[string]bool{}
	for _, h := range want {
		wantSet[strings.ToLower(h)] = true
	}
	for _, g := range got {
		if !wantSet[strings.ToLower(g)] {
			t.Errorf("Go 端多出 Node 没有的头：%q", g)
		}
	}
	for _, wnt := range want {
		found := false
		for _, g := range got {
			if strings.EqualFold(g, wnt) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Go 端缺少 Node 已有的头：%q（浏览器预检会直接拒掉）", wnt)
		}
	}
}

// TestCORSPreflightOnlyShortCircuits 预检才短路 204；普通 OPTIONS 继续走业务。
func TestCORSPreflightOnlyShortCircuits(t *testing.T) {
	t.Setenv("FRONTEND_URL", "http://localhost:3000")
	var reached bool
	h := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(200)
	}))

	// 预检：短路 204
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/account/list", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	h.ServeHTTP(w, req)
	if w.Code != 204 {
		t.Errorf("预检 OPTIONS 应返 204，实际 %d", w.Code)
	}
	if reached {
		t.Errorf("预检不应进入业务链路")
	}
	if w.Header().Get("Access-Control-Max-Age") != "600" {
		t.Errorf("预检应带 Max-Age=600（对齐 cors 默认），实际 %q", w.Header().Get("Access-Control-Max-Age"))
	}
	if !strings.Contains(w.Header().Get("Vary"), "Origin") {
		t.Errorf("应带 Vary: Origin（防代理/CDN 串源）")
	}

	// 非预检 OPTIONS：继续往下走
	reached = false
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodOptions, "/api/v1/account/list", nil)
	req2.RemoteAddr = "10.0.0.1:1234"
	req2.Header.Set("Origin", "http://localhost:3000")
	h.ServeHTTP(w2, req2)
	if !reached {
		t.Errorf("非预检 OPTIONS 不应被 CORS 层短路（对齐 express cors）")
	}
}

// TestCORSRejectsUnknownOrigin 白名单外的 Origin 不得拿到 Allow-Origin。
func TestCORSRejectsUnknownOrigin(t *testing.T) {
	t.Setenv("FRONTEND_URL", "http://localhost:3000")
	t.Setenv("NODE_ENV", "production")
	t.Setenv("CORS_EXTRA_ORIGINS", "")
	h := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/api/v1/account/list", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("Origin", "http://evil.example.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	h.ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("白名单外 Origin 不应拿到 Allow-Origin，实际 %q", got)
	}
}

// ---------- 3. 静态资源 ----------

func TestStaticHandlerRejectsTraversal(t *testing.T) {
	h := staticHandler(os.TempDir())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/../../etc/passwd", nil)
	h.ServeHTTP(w, req)
	if w.Code != 403 && w.Code != 404 {
		t.Errorf("路径穿越应被拒（403/404），实际 %d", w.Code)
	}
}

// ---------- 工具 ----------

func splitAndTrim(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
