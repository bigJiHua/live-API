package moment

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("moment", Register) }

// Register 路由顺序严格同 Node api/index.js。
// 所有路由都需要认证（Node router.use(authGuard)）。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// 【已启用】创建动态
	mw.Route(mux, "POST", "/api/v1/moment", auth, Create)

	// 【已启用】查询所有动态（必须在 /:id 前面）
	mw.Route(mux, "GET", "/api/v1/moment/list", auth, List)

	// 【已启用】查询今日动态（含追加）
	mw.Route(mux, "GET", "/api/v1/moment/today", auth, Today)

	// 【已启用】查询单条动态（必须在 /batch 后面）
	mw.Route(mux, "GET", "/api/v1/moment/{id}", auth, Detail)

	// 【已启用】批量获取动态详情
	mw.Route(mux, "POST", "/api/v1/moment/batch", auth, BatchDetail)

	// 【已启用】更新动态
	mw.Route(mux, "PUT", "/api/v1/moment/{id}", auth, Update)

	// 【已启用】删除动态
	mw.Route(mux, "DELETE", "/api/v1/moment/{id}", authPin, Delete)
	mw.Protect("DELETE", "/api/v1/moment/:id")
}
