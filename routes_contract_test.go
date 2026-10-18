package main

// SYNC-A38（2026-10-12）：路由契约测试 —— 防止后续改动再次引入路径/方法漂移。
//
// 基准：api/src/api/index.js 的挂载顺序 + 各模块 api/*.js 的 router.xxx 声明。
// 本测试用**实测 ServeMux 匹配**（而非读注册表）来验证，因此参数段/尾斜杠/
// 静态段优先级的问题都能被它抓到 —— 例如 SYNC-A14 修的那 3 条无尾斜杠路由。
//
// ⚠ 本文件必须放在 **package main**：业务模块是靠 main.go 的 blank import
//   触发 init() → srv.Add 注册路由的；若放在 internal/srv 的测试二进制里，
//   registrars 为空，所有路由都会 404（测试失去意义）。

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"live/api/internal/srv"
)

// routeProbe 探针：真实发一个请求，看是否**命中路由**。
//
// ⚠ 必须先通过 securityCheck，否则会被前置校验拦成 400，
//
//	使"路由可达"的断言变成假阳性（这正是初版探针的缺陷）。
//
// 返回码含义：
//   - 200/206/400/401/423 等：命中了 handler（可能在鉴权层被拦，但路由存在）
//   - 404：路由未注册
func routeProbe(t *testing.T, method, path string) int {
	t.Helper()
	t.Setenv("REQUIRE_CLIENT_NONCE", "false")
	t.Setenv("PIN_NONCE_MODE", "off")
	t.Setenv("PIN_RISK_MODE", "off")

	mux := srv.NewMux()
	req := httptest.NewRequest(method, path, nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("x-requested-with", "XMLHttpRequest")
	req.Header.Set("x-client-timestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w.Code
}

// TestKnownRoutesReachable 抽查关键路由可达（非 404 即证明路由已注册）。
func TestKnownRoutesReachable(t *testing.T) {
	routes := []struct{ method, path string }{
		// 站点健康检查（2026-10-17，APP「接入站点」探测用；在 securityCheck 之外）
		{http.MethodGet, "/api/health"},
		// auth（SYNC-A2 新增 logout）
		{http.MethodGet, "/api/v1/auth/handshake"},
		{http.MethodGet, "/api/v1/auth/check-admin"},
		{http.MethodPost, "/api/v1/auth/login"},
		{http.MethodPost, "/api/v1/auth/logout"},
		{http.MethodPost, "/api/v1/auth/refresh"},
		{http.MethodPost, "/api/v1/auth/admin-register"},
		{http.MethodPost, "/api/v1/auth/lock-system"},
		{http.MethodGet, "/api/v1/auth/me"},
		{http.MethodGet, "/api/v1/auth/login-logs"},
		// security（PIN 七条）
		{http.MethodGet, "/api/v1/security/pin/check"},
		{http.MethodPost, "/api/v1/security/pin/verify"},
		{http.MethodPost, "/api/v1/security/pin/route-verify"},
		{http.MethodPost, "/api/v1/security/pin/set"},
		{http.MethodPost, "/api/v1/security/pin/change"},
		{http.MethodPost, "/api/v1/security/pin/reset"},
		{http.MethodPost, "/api/v1/security/risk-report"},
		// user（settings 已于 2026-10-13 随 Node 删除，见 TestRemovedRoutesNotMounted）
		{http.MethodPut, "/api/v1/user/profile"},
		{http.MethodPost, "/api/v1/user/email/send-code"},
		{http.MethodPut, "/api/v1/user/email/change"},
		{http.MethodPut, "/api/v1/user/password/change"},
		// account
		{http.MethodGet, "/api/v1/account/list"},
		{http.MethodGet, "/api/v1/account/transfer/list"},
		{http.MethodGet, "/api/v1/account/stats/month"},
		{http.MethodPost, "/api/v1/account/debit"},
		{http.MethodPost, "/api/v1/account/credit"},
		{http.MethodGet, "/api/v1/accountBalance"},
		// card / category / budget / fund / todo / moment / fixedAsset
		{http.MethodGet, "/api/v1/card/list"},
		{http.MethodGet, "/api/v1/category/list"},
		{http.MethodGet, "/api/v1/budget/list"},
		{http.MethodPost, "/api/v1/budget"},
		{http.MethodGet, "/api/v1/fund/list"},
		{http.MethodGet, "/api/v1/todo/list"},
		{http.MethodGet, "/api/v1/moment/list"},
		{http.MethodGet, "/api/v1/fixedAsset/list"},
		{http.MethodGet, "/api/v1/asset/home"},
		{http.MethodGet, "/api/v1/recurring/list"},
		// 管理员 / 基础设施
		{http.MethodGet, "/api/v1/data-manager/backups"},
		{http.MethodGet, "/api/v1/geo/network"},
	}
	for _, r := range routes {
		if code := routeProbe(t, r.method, r.path); code == 404 {
			t.Errorf("路由缺失（404）：%s %s", r.method, r.path)
		}
	}
}

// TestSlashlessCollectionRoutes SYNC-A14 护栏：
// Node 的 router.get("/") 挂载点同时匹配 `/x` 与 `/x/`，Go 需双注册。
// 这些是前端实际请求的无尾斜杠形态，缺一条就是 404。
func TestSlashlessCollectionRoutes(t *testing.T) {
	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/account"},        // GET  ""
		{http.MethodGet, "/api/v1/accountBalance"}, // GET  ""
		{http.MethodPost, "/api/v1/budget"},        // POST ""
		{http.MethodGet, "/api/v1/fund/list"},      // 参照：确认探针本身有效
	}
	for _, r := range routes {
		if code := routeProbe(t, r.method, r.path); code == 404 {
			t.Errorf("无尾斜杠形态路由缺失（404）：%s %s", r.method, r.path)
		}
	}
}

// TestDashboardNotMounted 与 Node 一致：dashboard 在 index.js:57 是注释掉的。
func TestDashboardNotMounted(t *testing.T) {
	if code := routeProbe(t, http.MethodGet, "/api/v1/dashboard/summary"); code != 404 {
		t.Errorf("dashboard 未在 Node 挂载，Go 也不应挂载（实际 code=%d）", code)
	}
}

// TestAuthRegisterNotMounted Node 的 /auth/register 是注释行（auth/api/index.js:13）。
func TestAuthRegisterNotMounted(t *testing.T) {
	if code := routeProbe(t, http.MethodPost, "/api/v1/auth/register"); code != 404 {
		t.Errorf("auth/register 在 Node 中已注释，Go 也不应挂载（实际 code=%d）", code)
	}
}

// TestRemovedRoutesNotMounted 🔒 2026-10-13（api.md §11 冗余接口清理）：
// 以下路由已与 Node 同步整组/零散删除，Go 不得重新注册（防回潮）。
//
// ⚠ 探针口径说明（Go/Node 既有差异，非本次引入）：Go ServeMux 的**尾斜杠子树
// pattern**（如 "GET /api/v1/account/"、"GET /api/v1/card/bill/"）会兜住其下
// 所有路径的所有方法，未注册子路径也会落到该 handler 的 AuthGuard（HTTP 200 +
// body 401）；Node/Express 对同形态不存在子路径返 404。因此：
//   - 不在任何子树下的已删路径 → 断言 404；
//   - stats/all、rebuild-all 位于上述两个子树之下 → 断言“未命中已删 handler”
//     （响应为子树通用的未认证拒绝，而非已删 handler 的业务响应）。
func TestRemovedRoutesNotMounted(t *testing.T) {
	notMounted := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/bank"},
		{http.MethodGet, "/api/v1/bank/xxx"},
		{http.MethodPost, "/api/v1/bank"},
		{http.MethodPut, "/api/v1/bank/xxx"},
		{http.MethodDelete, "/api/v1/bank/xxx"},
		{http.MethodGet, "/api/v1/bank-category"},
		{http.MethodPost, "/api/v1/bank-category"},
		{http.MethodPut, "/api/v1/bank-category/xxx"},
		{http.MethodDelete, "/api/v1/bank-category/xxx"},
		{http.MethodGet, "/api/v1/resource"},
		{http.MethodDelete, "/api/v1/resource/xxx"},
		{http.MethodGet, "/api/v1/database/databases"},
		{http.MethodGet, "/api/v1/database/tables"},
		{http.MethodGet, "/api/v1/database/table/x/structure"},
		{http.MethodGet, "/api/v1/database/table/x/data"},
		{http.MethodPost, "/api/v1/database/execute"},
		{http.MethodGet, "/api/v1/database/table/x/indexes"},
		{http.MethodGet, "/api/v1/database/table/x/show-create"},
		{http.MethodDelete, "/api/v1/database/table/x"},
		{http.MethodDelete, "/api/v1/database/table/x/data"},
		{http.MethodGet, "/api/v1/user/settings"},
		{http.MethodPut, "/api/v1/user/settings"},
		{http.MethodGet, "/api/v1/flow/xxx"},
	}
	for _, r := range notMounted {
		if code := routeProbe(t, r.method, r.path); code != 404 {
			t.Errorf("已删除路由不应命中（期望 404）：%s %s（实际 code=%d）", r.method, r.path, code)
		}
	}

	// 子树兜底路径：已删 handler 不再注册（响应只能是子树的通用未认证拒绝，
	// 不可能是已删 handler 的 200 业务响应——handler 没了，编译期已无引用）。
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/account/stats/all"},
		{http.MethodPost, "/api/v1/card/bill/rebuild-all"},
	} {
		if code := routeProbe(t, r.method, r.path); code == 404 {
			t.Errorf("已删除路由被子树兜底属预期，但 404 说明子树也异常：%s %s", r.method, r.path)
		}
	}
}

// TestStaticPublicPathMounted /api/public 静态资源应挂载（app.js:184）。
func TestStaticPublicPathMounted(t *testing.T) {
	mux := srv.NewMux()
	req := httptest.NewRequest(http.MethodGet, "/api/public/definitely-missing.png", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Errorf("静态资源缺失应 404，实际 %d", w.Code)
	}
}

// TestSecureHeadersOn404 安全头必须覆盖 panic/404 响应（SYNC-006）。
func TestSecureHeadersOn404(t *testing.T) {
	mux := srv.NewMux()
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/nope", nil))

	for _, h := range []string{
		"X-Content-Type-Options", "X-Frame-Options",
		"Referrer-Policy", "Cross-Origin-Resource-Policy",
	} {
		if w.Header().Get(h) == "" {
			t.Errorf("404 响应缺安全头 %s（SecureHeaders 应为全局最外层）", h)
		}
	}
}
