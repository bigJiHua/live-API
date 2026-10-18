package security

// from: src/modules/security/api/index.js
// 6 条路由，顺序同 Node；校验复用 auth/rules（Node：security/api 引用 ../../auth/rules）。

import (
	"net/http"

	"live/api/internal/mod/auth"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/srv"
)

func init() { srv.Add("security", Register) }

// Register 注册 security 模块路由（顺序同 Node api/index.js）。
func Register(mux *http.ServeMux) {
	authGuard := []func(http.Handler) http.Handler{mw.AuthGuard}
	guard := func(check func(resp.Body) string) []func(http.Handler) http.Handler {
		return []func(http.Handler) http.Handler{mw.AuthGuard, auth.GuardRule(check)}
	}

	// 获取 PIN状态
	mw.Route(mux, "GET", "/api/v1/security/pin/check", authGuard, PinStatus)
	// 验证 PIN
	mw.Route(mux, "POST", "/api/v1/security/pin/verify", guard(auth.ValidateVerifyPin), VerifyPin)
	// 验证风险路由 PIN，成功后返回一次性 token
	mw.Route(mux, "POST", "/api/v1/security/pin/route-verify", guard(auth.ValidateVerifyRoutePin), VerifyRoutePin)
	// 设置 PIN
	mw.Route(mux, "POST", "/api/v1/security/pin/set", guard(auth.ValidateSetPin), SetPin)
	// 修改 PIN
	mw.Route(mux, "POST", "/api/v1/security/pin/change", guard(auth.ValidateChangePin), ChangePin)
	// 设备风险信号上报（SYNC-012 / P2-14：纯信号落库，不拒服务）
	mw.Route(mux, "POST", "/api/v1/security/risk-report", authGuard, RiskReport)
	// 重置 PIN（keep BUG-001：verificationCode 校验在 Node 中被注释，路由仍在线）
	mw.Route(mux, "POST", "/api/v1/security/pin/reset", guard(auth.ValidateResetPin), ResetPin)
}
