package auth

// from: src/modules/auth/api/index.js
// 路由顺序严格同 Node（/register 路由在 Node 中已注释，不实现）。

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/srv"
)

func init() { srv.Add("auth", Register) }

// Register 注册 auth 模块路由（顺序同 Node api/index.js），并挂载 user 模块路由（见 userApi.go）。
func Register(mux *http.ServeMux) {
	// 获取AES临时加密密钥（无鉴权）
	mux.HandleFunc("GET /api/v1/auth/handshake", GetHandshake)

	// 用户登录（链路：validate → accountLockCheck → login）
	mw.Route(mux, "POST", "/api/v1/auth/login",
		[]func(http.Handler) http.Handler{guardRule(ValidateLogin), mw.AccountLockCheck}, Login)

	// 检查是否已有管理员（首次注册使用）
	mux.HandleFunc("GET /api/v1/auth/check-admin", CheckAdmin)

	// 管理员首次注册（只能注册一次）
	mux.HandleFunc("POST /api/v1/auth/admin-register", AdminRegister)

	// 刷新 Token
	mux.HandleFunc("POST /api/v1/auth/refresh", RefreshToken)

	// 登出（P1-17）。**刻意不挂 authGuard**：令牌已失效时也要能登出（幂等）
	mux.HandleFunc("POST /api/v1/auth/logout", Logout)

	// 以下为权限接口（authGuard）
	mw.Route(mux, "GET", "/api/v1/auth/me", []func(http.Handler) http.Handler{mw.AuthGuard}, GetCurrentUser)
	mw.Route(mux, "POST", "/api/v1/auth/lock-system", []func(http.Handler) http.Handler{mw.AuthGuard}, LockSystem)
	mw.Route(mux, "GET", "/api/v1/auth/login-logs", []func(http.Handler) http.Handler{mw.AuthGuard}, GetLoginLogs)

	// src/modules/user 路由并入本包（Node 中为独立 router，此处同 mux 注册，路径无重叠）
	registerUserRoutes(mux)
}
