package asset

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("asset", Register) }

// Register 路由顺序严格同 Node api/index.js。
// 所有路由都需要认证（Node router.use(authGuard)）。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// ========== 资产快照 ==========

	// 获取首页资产数据（最新快照 + 最新登记）
	mw.Route(mux, "GET", "/api/v1/asset/home", auth, GetHomeAsset)

	// 获取资产快照列表
	mw.Route(mux, "GET", "/api/v1/asset/snapshot/list", auth, GetSnapshots)

	// ========== 资产登记 ==========

	// 获取用户登记列表
	mw.Route(mux, "GET", "/api/v1/asset/register/list", auth, GetRegisters)

	// 获取登记记录详情
	mw.Route(mux, "GET", "/api/v1/asset/register/{id}", auth, GetRegisterById)

	// 用户登记资产
	mw.Route(mux, "POST", "/api/v1/asset/register", auth, CreateRegister)

	// 更新登记记录
	mw.Route(mux, "PUT", "/api/v1/asset/register/{id}", auth, UpdateRegister)

	// 删除登记记录
	mw.Route(mux, "DELETE", "/api/v1/asset/register/{id}", authPin, DeleteRegister)
	mw.Protect("DELETE", "/api/v1/asset/register/:id")
}
