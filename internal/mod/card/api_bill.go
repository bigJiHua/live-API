package card

import (
	"net/http"

	"live/api/internal/mw"
)

// RegisterBill 卡片账单路由（Node api/bill.js，挂载于 /card/bill），顺序严格同 Node。
// Node `router.use(authGuard)` → 全模块挂 AuthGuard。
// Node 注册顺序：GET "/" → 具体路由（card/:cardId/latest、card/:cardId/rebuild、
// rebuild-all、foreign/*）→ GET/PUT/DELETE "/:id"（具体路由在前避免被 /:id 劫持）。
func RegisterBill(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	// 获取账单列表（Node router.get("/") 挂载于 /card/bill，兼容带/不带尾斜杠）
	mw.Route(mux, "GET", "/api/v1/card/bill", auth, BillList)
	mw.Route(mux, "GET", "/api/v1/card/bill/", auth, BillList)

	// 👍 具体路由放在通用路由之前，避免被 /:id 劫持（ServeMux 静态段天然优先，仍按 Node 顺序书写）
	// 获取卡片最新账单
	mw.Route(mux, "GET", "/api/v1/card/bill/card/{cardId}/latest", auth, BillLatest)

	// 重建账单（从流水重新计算）
	mw.Route(mux, "POST", "/api/v1/card/bill/card/{cardId}/rebuild", auth, BillRebuild)

	// 🔒 2026-10-13（api.md §11）：POST /rebuild-all 已删（三端无调用方），与 Node 同步。

	// ========== 外币消费登记/对账（痛点4） ==========
	// 待对账外币列表（专用登记页）
	mw.Route(mux, "GET", "/api/v1/card/bill/foreign/pending", auth, BillForeignPending)
	// 全部外币登记列表
	mw.Route(mux, "GET", "/api/v1/card/bill/foreign/list", auth, BillForeignList)
	// 历史外币消费流水（扫描 account 账本，含未登记，按卡/时间范围筛选）
	mw.Route(mux, "GET", "/api/v1/card/bill/foreign/history", auth, BillForeignHistory)
	// 补登记未登记的历史外币消费流水
	mw.Route(mux, "POST", "/api/v1/card/bill/foreign/register", auth, BillForeignRegister)
	// 外币对账：录入实际汇率/人民币
	mw.Route(mux, "PUT", "/api/v1/card/bill/foreign/{id}/reconcile", auth, BillForeignReconcile)
	// 删除外币登记
	mw.Route(mux, "DELETE", "/api/v1/card/bill/foreign/{id}", authPin, BillForeignRemove)

	// 获取单个账单详情
	mw.Route(mux, "GET", "/api/v1/card/bill/{id}", auth, BillDetail)

	// 更新账单
	mw.Route(mux, "PUT", "/api/v1/card/bill/{id}", auth, withRule(cleanUpdateBill, BillEdit))

	// 删除账单
	mw.Route(mux, "DELETE", "/api/v1/card/bill/{id}", authPin, BillRemove)

	// 风险路由声明（供 pinSecurityGuard 识别，对应 Node pinLockGuard 自动注册）
	mw.Protect("DELETE", "/api/v1/card/bill/:id")
	mw.Protect("DELETE", "/api/v1/card/bill/foreign/:id")
}
