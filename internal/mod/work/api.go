package work

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("work", Register) }

// Register 路由顺序严格同 Node src/modules/work/api/index.js。
// 所有路由均挂 authGuard；DELETE 另挂 pinLockGuard 并声明风险模式。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 工作信息 CRUD ==========

	mw.Route(mux, "GET", "/api/v1/work/job/list", auth, List)
	mw.Route(mux, "POST", "/api/v1/work/job", auth, CreateJob)
	mw.Route(mux, "PUT", "/api/v1/work/job/{id}", auth, UpdateJob)
	mw.Route(mux, "DELETE", "/api/v1/work/job/{id}", authPin, DeleteJob)
	mw.Protect("DELETE", "/api/v1/work/job/:id")

	// ========== 工资查询与计算 ==========

	mw.Route(mux, "GET", "/api/v1/work/salary/day", auth, GetDaySalary)
	mw.Route(mux, "POST", "/api/v1/work/salary", auth, SaveDaySalary)
	mw.Route(mux, "GET", "/api/v1/work/salary/month", auth, GetMonthSalary)
	mw.Route(mux, "DELETE", "/api/v1/work/salary", authPin, DeleteDaySalary)
	mw.Protect("DELETE", "/api/v1/work/salary")
}
