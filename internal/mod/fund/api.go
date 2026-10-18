package fund

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("fund", Register) }

// Register 路由顺序严格同 Node src/modules/fund/api/index.js。
// 所有路由均挂 authGuard（router.use(authGuard)）；
// DELETE 另挂 pinLockGuard 并声明风险模式。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	mw.Route(mux, "GET", "/api/v1/fund/list", auth, GetList)
	mw.Route(mux, "GET", "/api/v1/fund/history/all", auth, GetAllHistory)
	mw.Route(mux, "GET", "/api/v1/fund/{id}", auth, GetById)
	// Node: router.post("/") 挂载于 /api/v1/fund（无/有尾斜杠均匹配，Go 需两条模式）
	mw.Route(mux, "POST", "/api/v1/fund", auth, Create)
	mw.Route(mux, "POST", "/api/v1/fund/", auth, Create)
	mw.Route(mux, "PUT", "/api/v1/fund/{id}", auth, Update)
	mw.Route(mux, "DELETE", "/api/v1/fund/{id}", authPin, Delete)
	mw.Protect("DELETE", "/api/v1/fund/:id")
	mw.Route(mux, "GET", "/api/v1/fund/{id}/history/monthly", auth, GetMonthlyHistory)
	mw.Route(mux, "GET", "/api/v1/fund/{id}/history", auth, GetHistory)
	mw.Route(mux, "POST", "/api/v1/fund/{id}/history", auth, AddHistory)
	mw.Route(mux, "PUT", "/api/v1/fund/history/{id}", auth, UpdateHistory)
	mw.Route(mux, "DELETE", "/api/v1/fund/history/{id}", authPin, DeleteHistory)
	mw.Protect("DELETE", "/api/v1/fund/history/:id")
}
