package mw

import "net/http"

// Route 注册带中间件链的路由。pattern 用 Go1.22 语法："/api/v1/card/{id}"。
// 中间件顺序=[先执行...]，如 {AuthGuard, PinLockGuard}。
func Route(mux *http.ServeMux, method, pattern string, chain []func(http.Handler) http.Handler, fn http.HandlerFunc) {
	var h http.Handler = fn
	for i := len(chain) - 1; i >= 0; i-- {
		h = chain[i](h)
	}
	mux.Handle(method+" "+pattern, h)
}

// Protect 声明风险路由模式（供 pinSecurityGuard 识别，:param 单段参数写法）。
func Protect(method, pattern string) {
	RegisterProtectedRoute(method, pattern)
}
