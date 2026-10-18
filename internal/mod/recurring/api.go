package recurring

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("recurring", Register) }

// Register 路由顺序严格同 Node src/modules/recurring/api/index.js。
// 所有路由均挂 authGuard；DELETE 另挂 pinLockGuard 并声明风险模式。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	mw.Route(mux, "GET", "/api/v1/recurring/list", auth, List)
	mw.Route(mux, "GET", "/api/v1/recurring/installments", auth, Installments)
	mw.Route(mux, "GET", "/api/v1/recurring/summary", auth, Summary)
	mw.Route(mux, "GET", "/api/v1/recurring/{id}", auth, Detail)
	// Node: router.post("/") 挂载于 /api/v1/recurring（无/有尾斜杠均匹配，Go 需两条模式）
	mw.Route(mux, "POST", "/api/v1/recurring", auth, Create)
	mw.Route(mux, "POST", "/api/v1/recurring/", auth, Create)
	mw.Route(mux, "PUT", "/api/v1/recurring/{id}", auth, Update)
	mw.Route(mux, "PUT", "/api/v1/recurring/{id}/month-status", auth, UpdateMonthStatus)
	// 分期入账：触发月份直接入账（后端校验账单周期 + 防重复）
	mw.Route(mux, "POST", "/api/v1/recurring/{id}/enter", auth, EnterInstallment)
	// 分期中止：仅未入账月份可中止，已入账月份需用户去账单手动冲正
	mw.Route(mux, "POST", "/api/v1/recurring/{id}/abort", auth, AbortInstallment)
	mw.Route(mux, "DELETE", "/api/v1/recurring/{id}", authPin, Delete)
	mw.Protect("DELETE", "/api/v1/recurring/:id")
}
