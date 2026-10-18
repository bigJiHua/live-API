package auth

// from: src/modules/user/api/index.js
// Node 中 user 为独立模块（router.use(authGuard) 全局鉴权），Go 端并入 auth 包注册，
// 路径与 auth 模块无重叠；中间件链与 handler 均复用 authController。

import (
	"net/http"

	"live/api/internal/mw"
)

// registerUserRoutes 注册 /api/v1/user/* 路由（顺序同 Node user/api/index.js）。
func registerUserRoutes(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}

	// 更新用户信息
	mw.Route(mux, "PUT", "/api/v1/user/profile",
		append(append([]func(http.Handler) http.Handler{}, auth...), guardRule(ValidateProfile)), UpdateProfile)

	// 🔄 2026-10-13（api.md §11）：GET/PUT /user/settings 已删——
	//   user_info 表无 settings 列，功能未落地（前端无调用），Node 侧整体移除。

	// 发送邮箱验证码（authGuard → emailSendCode 校验 → emailCodeRateLimit）
	// 🔒 2026-10-12 修复（api.md P1-1）：路由顺序对齐 Node user/api/index.js:21-26——
	//    createValidator(UserRules.emailSendCode) 在限流中间件**之前**，
	//    stripUnknown 剥离 data 内/顶层伪造字段（含 userId），与控制器归一形成双层防护。
	mw.Route(mux, "POST", "/api/v1/user/email/send-code",
		[]func(http.Handler) http.Handler{mw.AuthGuard, guardRule(ValidateEmailSendCode), mw.EmailCodeRateLimit}, SendEmailCode)

	// 修改邮箱（需要验证码）
	mw.Route(mux, "PUT", "/api/v1/user/email/change",
		append(append([]func(http.Handler) http.Handler{}, auth...), guardRule(ValidateEmailChange)), ChangeEmail)

	// 修改密码（需要邮箱验证码）
	mw.Route(mux, "PUT", "/api/v1/user/password/change",
		append(append([]func(http.Handler) http.Handler{}, auth...), guardRule(ValidatePasswordChangeWithCode)), ChangePasswordWithCode)
}
