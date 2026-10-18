package category

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() {
	srv.Add("category", Register)
}

// Register 分类管理路由（Node api/index.js，挂载于 /category），顺序严格同 Node。
// Node `router.use(authGuard)` → 全模块挂 AuthGuard。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 分类管理 ==========

	// 获取分类列表（支持按类型筛选 ?type=income/expense/asset/fixed/bank）
	mw.Route(mux, "GET", "/api/v1/category", auth, GetList)
	mw.Route(mux, "GET", "/api/v1/category/", auth, GetList)

	// 获取单个分类详情
	mw.Route(mux, "GET", "/api/v1/category/{id}", auth, GetById)

	// 创建分类（自动分配sort）
	mw.Route(mux, "POST", "/api/v1/category", auth, withRule(CleanCreate, Create))
	mw.Route(mux, "POST", "/api/v1/category/", auth, withRule(CleanCreate, Create))

	// 更新分类
	mw.Route(mux, "PUT", "/api/v1/category/{id}", auth, withRule(CleanUpdate, Update))

	// 删除分类
	mw.Route(mux, "DELETE", "/api/v1/category/{id}", authPin, Delete)
	mw.Protect("DELETE", "/api/v1/category/:id")
}
