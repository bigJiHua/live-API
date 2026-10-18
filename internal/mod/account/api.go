package account

import (
	"net/http"

	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/srv"
)

func init() {
	srv.Add("account", Register)
	srv.Add("accountBalance", RegisterBalance)
}

// Register 账务流水路由，顺序严格同 Node api/index.js（静态段优先于参数段）。
// 所有路由均挂 authGuard（Node router.use(authGuard)）。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}

	// ========== 收支记录（通用查询） ==========

	// 获取收支列表
	// SYNC-A14（2026-10-12）：Node router.get("/") 挂载于 /api/v1/account，
	//   Express 下 "/" 同时匹配 `/account` 与 `/account/`；Go ServeMux 两者不同，
	//   只注册带尾斜杠那条会让 `GET /api/v1/account`（前端实际请求形态）404。
	mw.Route(mux, "GET", "/api/v1/account", auth, GetList)
	mw.Route(mux, "GET", "/api/v1/account/", auth, GetList)

	// 根据卡片获取流水
	mw.Route(mux, "GET", "/api/v1/account/list", auth, GetByCard)

	// 获取转账明细列表（需在 /:id 之前注册，避免被 :id 捕获）
	mw.Route(mux, "GET", "/api/v1/account/transfer/list", auth, GetTransferList)

	// 获取本月收支统计（需在 /:id 之前注册）
	mw.Route(mux, "GET", "/api/v1/account/stats/month", auth, GetMonthStats)

	// 所有银行卡近 N 个月支出/收入笔数（按卡聚合，需在 /:id 之前注册）
	mw.Route(mux, "GET", "/api/v1/account/stats/cards-flow", auth, GetCardsFlowStats)

	// 获取单条收支详情
	mw.Route(mux, "GET", "/api/v1/account/{id}", auth, GetById)

	// 修改收支备注（仅备注）
	mw.Route(mux, "PATCH", "/api/v1/account/{id}/remark", auth, UpdateRemark)

	// ========== 借记卡写入（/account/debit/**） ==========

	// 创建借记卡收支记录（普通收支/转账/提现/还款支出流水）
	mw.Route(mux, "POST", "/api/v1/account/debit", auth, withRule(ValidateCreate, DebitCreate))

	// 更新借记卡收支记录
	mw.Route(mux, "PUT", "/api/v1/account/debit/{id}", auth, withRule(ValidateUpdate, DebitUpdate))

	// 借记卡冲正
	mw.Route(mux, "POST", "/api/v1/account/debit/{id}/reverse", auth, ReverseDebit)

	// 转账冲正（自转/提现撤销）
	mw.Route(mux, "POST", "/api/v1/account/debit/{id}/reverse/transfer", auth, ReverseTransfer)

	// ========== 信用卡写入（/account/credit/**） ==========

	// 创建信用卡消费记录
	mw.Route(mux, "POST", "/api/v1/account/credit", auth, withRule(ValidateCreate, CreditCreate))

	// 更新信用卡消费记录
	mw.Route(mux, "PUT", "/api/v1/account/credit/{id}", auth, withRule(ValidateUpdate, CreditUpdate))

	// 信用卡消费冲正
	mw.Route(mux, "POST", "/api/v1/account/credit/{id}/reverse/expense", auth, ReverseCreditExpense)

	// 信用卡还款冲正
	mw.Route(mux, "POST", "/api/v1/account/credit/{id}/reverse/repay", auth, ReverseCreditRepay)
}

// RegisterBalance 账户余额路由，顺序严格同 Node api/balance.js（挂载于 /accountBalance）。
func RegisterBalance(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}

	// ========== 账户余额管理 ==========

	// 获取所有账户余额列表
	// SYNC-A14：同 account —— Node 的 "/" 挂载点无/有尾斜杠都匹配。
	mw.Route(mux, "GET", "/api/v1/accountBalance", auth, BalanceGetList)
	mw.Route(mux, "GET", "/api/v1/accountBalance/", auth, BalanceGetList)

	// 获取单张卡/账户余额
	mw.Route(mux, "GET", "/api/v1/accountBalance/{cardId}", auth, BalanceGetByCardId)

	// 初始化虚拟账户（现金、微信、支付宝）
	mw.Route(mux, "POST", "/api/v1/accountBalance/init-virtual", auth, InitVirtual)

	// 重建所有账户余额（从收支表重新计算）
	mw.Route(mux, "POST", "/api/v1/accountBalance/rebuild", auth, Rebuild)
}

// withRule 复刻 createValidator(schemas)：校验失败 res.say(首条错误, 400)，通过后放行。
// 对应 Node createValidator(AccountRules.create) 中间件语义。
func withRule(validate func(resp.Body) string, fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg := validate(resp.Parse(r)); msg != "" {
			resp.Say(w, msg, 400)
			return
		}
		fn(w, r)
	}
}
