package card

import (
	"net/http"

	"live/api/internal/mw"
)

// RegisterRepay 卡片还款路由（Node api/repay.js，挂载于 /card/repay），顺序严格同 Node。
// Node `router.use(authGuard)` → 全模块挂 AuthGuard。
// Node 注册顺序：GET "/" → POST "/merge"（须放在 /:id 之前）→ GET "/:id" → POST "/" → PUT/DELETE "/:id"。
func RegisterRepay(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// 获取还款记录列表（Node router.get("/") 挂载于 /card/repay，兼容带/不带尾斜杠）
	mw.Route(mux, "GET", "/api/v1/card/repay", auth, RepayList)
	mw.Route(mux, "GET", "/api/v1/card/repay/", auth, RepayList)

	// 信报合一合并还款（一次性结清共享池内全部卡欠款；须放在 /:id 之前）
	mw.Route(mux, "POST", "/api/v1/card/repay/merge", auth, RepayMerge)

	// 获取单个还款记录详情
	mw.Route(mux, "GET", "/api/v1/card/repay/{id}", auth, RepayDetail)

	// 创建还款记录
	mw.Route(mux, "POST", "/api/v1/card/repay", auth, withRule(cleanCreateRepay, RepayCreate))
	mw.Route(mux, "POST", "/api/v1/card/repay/", auth, withRule(cleanCreateRepay, RepayCreate))

	// 更新还款记录
	mw.Route(mux, "PUT", "/api/v1/card/repay/{id}", auth, withRule(cleanUpdateRepay, RepayEdit))

	// 删除还款记录
	mw.Route(mux, "DELETE", "/api/v1/card/repay/{id}", authPin, RepayRemove)

	// 风险路由声明（供 pinSecurityGuard 识别，对应 Node pinLockGuard 自动注册）
	mw.Protect("DELETE", "/api/v1/card/repay/:id")
}
