package budget

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/srv"
)

func init() { srv.Add("budget", Register) }

// Register 路由顺序严格同 Node api/index.js。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 预算 CRUD ==========

	// 获取所有预算
	mw.Route(mux, "GET", "/api/v1/budget/list", auth, List)

	// 获取预算统计
	mw.Route(mux, "GET", "/api/v1/budget/stats", auth, Stats)

	// 获取单个预算
	mw.Route(mux, "GET", "/api/v1/budget/{id}", auth, withIDRule(ValidateIDParam, GetOne))

	// 创建预算
	// SYNC-A14（2026-10-12）：Node router.post("/") 无/有尾斜杠都匹配，Go 需两条。
	mw.Route(mux, "POST", "/api/v1/budget", auth, withRule(ValidateCreate, Create))
	mw.Route(mux, "POST", "/api/v1/budget/", auth, withRule(ValidateCreate, Create))

	// 更新预算
	mw.Route(mux, "PUT", "/api/v1/budget/{id}", auth, withIDRule(ValidateIDParam, withRule(ValidateUpdate, Update)))

	// 删除预算（硬删除）
	mw.Route(mux, "DELETE", "/api/v1/budget/{id}", authPin, withIDRule(ValidateIDParam, Delete))
	mw.Protect("DELETE", "/api/v1/budget/:id")
}

// withRule 复刻 createValidator(schemas)：校验失败 res.say(首条错误, 400)，通过后放行。
func withRule(validate func(resp.Body) string, fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg := validate(resp.Parse(r)); msg != "" {
			resp.Say(w, msg, 400)
			return
		}
		fn(w, r)
	}
}

// withIDRule 复刻 createValidator(BudgetRules.idParam)：params.id 必填。
func withIDRule(validate func(*http.Request) string, fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg := validate(r); msg != "" {
			resp.Say(w, msg, 400)
			return
		}
		fn(w, r)
	}
}
