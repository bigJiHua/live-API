package card

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() {
	srv.Add("card", Register)
	srv.Add("card-bill", RegisterBill)
	srv.Add("card-repay", RegisterRepay)
}

// Register 卡片管理路由，顺序严格同 Node modules/card/api/index.js。
// Node `router.use(authGuard)` → 全模块挂 AuthGuard（Go 逐路由声明）。
// ServeMux 静态段优先于参数段，无需关心注册先后；同模块内仍按 Node 顺序书写。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 卡片管理 ==========

	// 获取卡片列表（Node router.get("/") 挂载于 /card，兼容带/不带尾斜杠）
	mw.Route(mux, "GET", "/api/v1/card", auth, GetList)
	mw.Route(mux, "GET", "/api/v1/card/", auth, GetList)

	// ========== 共享额度池（痛点2） ==========
	mw.Route(mux, "GET", "/api/v1/card/pool", auth, ListPools)
	mw.Route(mux, "POST", "/api/v1/card/pool", auth, CreatePool)
	mw.Route(mux, "PUT", "/api/v1/card/pool/{id}", auth, UpdatePool)
	mw.Route(mux, "DELETE", "/api/v1/card/pool/{id}", authPin, DeletePool)
	mw.Route(mux, "POST", "/api/v1/card/pool/assign", auth, AssignCardPool)

	// 获取单个卡片详情
	mw.Route(mux, "GET", "/api/v1/card/{id}", auth, GetById)

	// 创建卡片
	mw.Route(mux, "POST", "/api/v1/card", auth, withRule(cleanCreateCard, Create))
	mw.Route(mux, "POST", "/api/v1/card/", auth, withRule(cleanCreateCard, Create))

	// 批量更新排序（必须在 /:id 之前，避免被 :id 捕获；ServeMux 静态段天然优先）
	mw.Route(mux, "PUT", "/api/v1/card/sort", auth, UpdateSortBatch)

	// 更新卡片
	mw.Route(mux, "PUT", "/api/v1/card/{id}", auth, withRule(cleanUpdateCard, Update))

	// 删除卡片
	mw.Route(mux, "DELETE", "/api/v1/card/{id}", authPin, Delete)

	// 风险路由声明（供 pinSecurityGuard 识别，对应 Node pinLockGuard 自动注册）
	mw.Protect("DELETE", "/api/v1/card/:id")
	mw.Protect("DELETE", "/api/v1/card/pool/:id")
}
