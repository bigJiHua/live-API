package card

import (
	"math"
	"strings"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/account"
	"live/api/internal/mod/cardbill"
	"live/api/internal/mod/creditcore"
	"live/api/internal/tim"
)

// 卡片还款记录模型 - 对应数据库 card_repay 表 —— from: model/repay.js

// repayTable 对应 CardRepay.tableName = 'card_repay'。
const repayTable = "card_repay"

// repaySelect 对应 findAll/findById 的 SELECT 列表（三处 LEFT JOIN 逐字一致）。
const repaySelect = `SELECT cr.*, c.alias as card_alias, c.last4_no as card_last4,
             cb.bill_amount, cb.need_repay as bill_need_repay,
             rc.alias as repay_card_alias, rc.last4_no as repay_card_last4
      FROM card_repay cr
      LEFT JOIN card_base c ON cr.card_id = c.id
      LEFT JOIN card_bill cb ON cr.bill_id = cb.id
      LEFT JOIN card_base rc ON cr.repay_card_id = rc.id`

// RepayFindAll 对应 CardRepay.findAll(userId, filters={cardId,billId,billMonth})。
// from: repay.js:20-52
func RepayFindAll(userID string, filters map[string]any) ([]map[string]any, error) {
	whereClause := "WHERE cr.user_id = ? AND cr.is_deleted = 0"
	params := []any{userID}

	if v, ok := filters["cardId"]; ok && truthy(v) {
		whereClause += " AND cr.card_id = ?"
		params = append(params, toStr(v))
	}
	if v, ok := filters["billId"]; ok && truthy(v) {
		whereClause += " AND cr.bill_id = ?"
		params = append(params, toStr(v))
	}
	if v, ok := filters["billMonth"]; ok && truthy(v) {
		whereClause += " AND cr.bill_month = ?"
		params = append(params, toStr(v))
	}

	query := repaySelect + "\n      " + whereClause + "\n      ORDER BY cr.repay_time DESC"
	return qRows(db.DB(), query, params...)
}

// RepayFindById 对应 CardRepay.findById(id, userId)。
// from: repay.js:57-70
func RepayFindById(id, userID string) (map[string]any, error) {
	return qRow(db.DB(), repaySelect+"\n      WHERE cr.id = ? AND cr.user_id = ? AND cr.is_deleted = 0", id, userID)
}

// RepayParams 还款参数（对应 Node executeRepay(params)）。
type RepayParams struct {
	UserID            string
	CardID            string
	BillID            string
	RepayAmount       float64 // Node parseFloat(repayAmount)
	RepayMethod       string
	RepayMethodCardID string
	RepayTime         string
	Remark            string
	// MergeMode 合并还款模式（P2-7）：金额来自事务外快照，
	// 锁内重读 need_repay 后收敛（已结清跳过、部分已还按真实待还扣）。
	MergeMode bool
}

// RepayResult 对应 Node executeRepay 的返回结构。
type RepayResult struct {
	RepayID           string
	RepayAmount       float64
	ActualRepayToBill float64
	NewUsedLimit      float64
	NewAvailLimit     float64
}

// ExecuteRepay 对应 CardRepay.executeRepay：单卡还款（事务 + 事务外资产快照 + 返回最新账单快照）。
// from: repay.js:84-124
func ExecuteRepay(p RepayParams) (RepayResult, error) {
	var out RepayResult
	tx, err := db.GetPool().Begin()
	if err != nil {
		return out, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	repayID, _, err := execRepayTx(tx, p)
	if err != nil {
		// 对应 Node console.error('[还款事务] 回滚:', e.message) 后原样抛出
		println("[还款事务] 回滚:", err.Error())
		return out, err
	}
	if err := tx.Commit(); err != nil {
		return out, err
	}
	committed = true

	// 系统自动检查并记录资产快照（对应 Node setImmediate(autoSaveSnapshot)）
	asyncAutoSaveSnapshot(p.UserID)

	// 返回最新账单快照（由 CreditCore 计算）
	// 🔒 SYNC-A39：Node 是 `parseFloat(params.repayAmount) || 0`，
	// `||` 同时兜住 0 与 NaN（parseFloat 失败得 NaN，NaN 是 falsy）。
	// Go 的 p.RepayAmount 若是 NaN，encoding/json 会报 "unsupported value: NaN"
	// 导致整个响应序列化失败 ⇒ 显式做同样的兜底。
	amtOut := p.RepayAmount
	if amtOut == 0 || math.IsNaN(amtOut) || math.IsInf(amtOut, 0) {
		amtOut = 0
	}
	out = RepayResult{
		RepayID:           repayID,
		RepayAmount:       amtOut,
		ActualRepayToBill: amtOut,
	}
	if p.BillID != "" {
		synced, err := cardbill.FindById(db.DB(), p.BillID, p.UserID)
		if err != nil {
			return out, err
		}
		if synced != nil {
			out.NewUsedLimit = toF(synced["used_limit"])
			out.NewAvailLimit = toF(synced["avail_limit"])
		}
	}
	return out, nil
}

// execRepayTx 对应 CardRepay.#execRepayTx：事务内单卡还款核心（供 executeRepay / executeMergeRepay 复用）。
// 同一事务连接内完成：锁卡 → 扣来源款 → 写 card_repay → 账单重算。
// 返回 (repayID, 实际入账金额, error)；mergeMode 下账单已结清时 repayID 为空串（调用方跳过）。
// from: repay.js:133-311
func execRepayTx(ex db.Commiter, p RepayParams) (string, float64, error) {
	now := tim.NowMS()
	repayAmountNum := p.RepayAmount

	if repayAmountNum <= 0 {
		return "", 0, errText("还款金额必须大于0")
	}

	// 获取卡片信息（H6：限定 user_id，防止跨用户还款）
	card, err := qRow(ex,
		"SELECT * FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
		p.CardID, p.UserID)
	if err != nil {
		return "", 0, err
	}
	if card == nil {
		return "", 0, errText("卡片不存在")
	}
	if toStr(card["card_type"]) != "credit" {
		return "", 0, errText("该卡片不是信用卡，不能执行信用卡还款")
	}
	// P2-7 审计：移除"本卡还款"(repayMethod='card')——该方式不产生来源资金扣款、account_id 为 NULL，
	// 会凭空减免信用卡负债且与撤销路径冲突。还款必须从真实来源（余额/银行卡/现金）扣款。
	if p.RepayMethod == "card" {
		return "", 0, errText("不支持\"本卡还款\"方式，请选择余额、银行卡或现金还款")
	}

	// 获取当前账单（如果有）（H6：限定 user_id + 校验账单归属该卡片）
	// 🔒 2026-10-13（api.md P2-7）：改 FOR UPDATE 行锁——并发两笔还款打同一账单时串行，
	//    后到者必须读到前者的已还结果，不能按过期快照重复扣款。
	var bill map[string]any
	if p.BillID != "" {
		bill, err = qRow(ex,
			"SELECT * FROM card_bill WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			p.BillID, p.UserID)
		if err != nil {
			return "", 0, err
		}
		if bill == nil {
			return "", 0, errText("账单不存在")
		}
		if toStr(bill["card_id"]) != p.CardID {
			return "", 0, errText("账单与卡片不匹配，无法还款")
		}

		// 🔒 2026-10-13（api.md P2-7）：合并还款金额来自事务外快照，并发下可能过期
		//    （另一笔合并还款/单笔还款已动过该账单）。锁内重读 need_repay 后收敛：
		//    已结清(=0) → 返回空 repayID 由调用方跳过；仍欠但少于快照 → 按真实待还扣。
		//    单笔还款（mergeMode=false）不收敛——用户主动多还形成溢缴是合法设计（H7）。
		if p.MergeMode {
			currentNeed := toF(bill["need_repay"])
			if currentNeed <= 0 {
				return "", 0, nil
			}
			if currentNeed < repayAmountNum {
				repayAmountNum = currentNeed
			}
		}
	}

	// ===== 验证还款来源（P0-2 审计：余额校验在事务内用 conn 重查）=====
	var sourceCardID string // 资金来源的card_id

	switch p.RepayMethod {
	case "balance":
		sourceCardID = "yyyy"
	case "bank_card":
		if p.RepayMethodCardID == "" {
			return "", 0, errText("请指定还款使用的银行卡")
		}
		// 校验还款卡类型，禁止信用卡还信用卡（H6：限定 user_id）
		sourceCardRows, err := qRows(ex,
			"SELECT card_type FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
			p.RepayMethodCardID, p.UserID)
		if err != nil {
			return "", 0, err
		}
		if len(sourceCardRows) == 0 {
			return "", 0, errText("还款银行卡不存在")
		}
		if toStr(sourceCardRows[0]["card_type"]) == "credit" {
			return "", 0, errText("禁止使用信用卡还款，请选择储蓄卡或其他方式")
		}
		sourceCardID = p.RepayMethodCardID
	case "cash":
		sourceCardID = "xxxx"
	}

	// ===== 处理资金转移 =====
	var repayAccountID string // 保存还款流水ID，用于关联 card_repay

	// H9：锁信用卡行，串行化并发消费/还款（还款同样改变可用额度）
	if _, err := qRows(ex,
		"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
		p.CardID, p.UserID); err != nil {
		return "", 0, err
	}

	// P0-2 审计：事务内锁来源卡行 + 用 conn 重查余额并校验。
	if sourceCardID != "" {
		if _, err := qRows(ex,
			"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			sourceCardID, p.UserID); err != nil {
			return "", 0, err
		}
		balanceInfo, err := account.CalculateBalance(ex, sourceCardID, p.UserID)
		if err != nil {
			return "", 0, err
		}
		sourceBalance := toF(balanceInfo["balance"])
		if sourceBalance < repayAmountNum {
			return "", 0, errText("余额不足，当前余额 " + jsNumString(sourceBalance) + "，需要 " + jsNumString(repayAmountNum))
		}

		// 1. 从还款来源扣款（生成支出流水，归属来源卡=借记卡），使用事务连接
		// C3：还款金额是人民币口径，来源流水必须记 CNY。
		//    若沿用目标信用卡 card.currency（如 USD），来源卡按 toCNY 折算会被错误缩小/放大（每100外币=人民币）。
		remark := p.Remark
		if remark == "" {
			remark = "信用卡还款至" + orText(card["alias"], toStr(card["last4_no"])) // Node `信用卡还款至${card.alias || card.last4_no}`
		}
		payMethod := "现金"
		switch p.RepayMethod {
		case "balance":
			payMethod = "余额"
		case "bank_card":
			payMethod = "银行卡"
		}
		repayAccount, err := account.DebitAccountCreate(ex, account.DebitCreateParams{
			UserID:       p.UserID,
			Direction:    "0", // 支出
			CategoryID:   "CATEGORY_REPAY",
			PayType:      "还款",
			PayMethod:    payMethod,
			AccountType:  "debit",
			Amount:       jsNumString(repayAmountNum),
			Currency:     "CNY",
			ExchangeRate: "1",
			TransDate:    orText(p.RepayTime, now[:10]), // Node repayTime || now.substring(0, 10)
			Remark:       remark,
			CardID:       sourceCardID,
		})
		if err != nil {
			return "", 0, err
		}

		// 保存还款流水ID用于关联
		if repayAccount != nil && repayAccount["id"] != nil {
			repayAccountID = toStr(repayAccount["id"])
		}
	}

	// 2. 同步信用卡余额快照（事务内，使用同一连接）
	if _, err := account.SyncBalanceSnapshot(ex, p.CardID, p.UserID); err != nil {
		return "", 0, err
	}

	// 3. 创建还款记录
	repayID := idgen.BillID()
	var month any // Node `bill ? bill.bill_month : null`
	if bill != nil {
		// 🔒 SYNC-A39：Node 写 `month || null`，空串也会落 NULL；
		// Go 直接透传会把 '' 写进 DATE 列，与 Node 不同口径。
		if s := toStr(bill["bill_month"]); s != "" {
			month = s
		}
	}

	// 获取还款来源卡ID（用于 repay_card_id 字段溯源）
	var repaySourceCardID any
	switch p.RepayMethod {
	case "balance":
		repaySourceCardID = "yyyy" // 余额（微信+支付宝）
	case "bank_card":
		repaySourceCardID = p.RepayMethodCardID // 指定银行卡
	case "cash":
		repaySourceCardID = "xxxx" // 现金
	}

	query := `
      INSERT INTO card_repay (
        id, card_id, user_id, bill_id, bill_month, repay_amount,
        repay_method, repay_card_id, repay_time, remark, account_id, is_deleted, create_time, update_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `
	var billIDArg, remarkArg any
	if p.BillID != "" {
		billIDArg = p.BillID
	}
	if p.Remark != "" {
		remarkArg = p.Remark
	}
	var repayAccountIDArg any
	if repayAccountID != "" {
		repayAccountIDArg = repayAccountID
	}
	if _, err := ex.Exec(query, []any{
		repayID,
		p.CardID,
		p.UserID,
		billIDArg,
		month,
		repayAmountNum,
		p.RepayMethod,
		repaySourceCardID,
		orText(p.RepayTime, now[:10]),
		remarkArg,
		repayAccountIDArg,
		now,
		now,
	}...); err != nil {
		return "", 0, err
	}

	// 4. 同步更新信用卡账单（事务内，使用同一连接；共享池卡自动全池扩散）
	if err := creditcore.SyncCardBills(ex, p.CardID, p.UserID); err != nil {
		return "", 0, err
	}

	// 返回 repayID 与实际入账金额（mergeMode 收敛后可能小于快照金额）
	return repayID, repayAmountNum, nil
}

// MergeRepayResult 对应 Node executeMergeRepay 的返回结构。
type MergeRepayResult struct {
	TotalAmount float64
	Count       int
	RepayIDs    []string
	CardIDs     []string
}

// ExecuteMergeRepay 对应 CardRepay.executeMergeRepay：
// 信报合一合并还款——单事务内一次性结清共享池内全部卡的欠款。
// 🔒 2026-10-13（api.md P2-7）：debts 是事务外快照，并发双打时第二笔会按过期金额
//
//	重复扣款成溢缴（实测：两笔并发 merge 各扣 2000，实欠 2000 → 溢缴 2000）。
//	现传 mergeMode：#execRepayTx 锁内重读 need_repay 收敛——已结清跳过、
//	部分已还按真实待还扣，杜绝重复扣款；总额/笔数按实际执行结果返回。
//
// from: repay.js:326-411
func ExecuteMergeRepay(userID, poolID, repayMethod, repayMethodCardID, repayTime, remark string) (MergeRepayResult, error) {
	var out MergeRepayResult
	if poolID == "" {
		return out, errText("共享池ID不能为空")
	}
	if repayMethod != "balance" && repayMethod != "bank_card" && repayMethod != "cash" {
		return out, errText("还款方式不合法")
	}
	if repayMethod == "bank_card" && repayMethodCardID == "" {
		return out, errText("请指定还款银行卡")
	}

	// 1. 校验共享池存在、属于该用户、且开启信报合一
	pool, err := poolFindById(poolID, userID)
	if err != nil {
		return out, err
	}
	if pool == nil {
		return out, errText("共享池不存在")
	}
	if !truthy(pool["credit_report_merged"]) {
		return out, errText("该共享池未开启信报合一，无法合并还款")
	}

	// 2. 池内全部信用卡
	cards, err := qRows(db.DB(),
		"SELECT id FROM card_base WHERE share_pool_id = ? AND user_id = ? AND is_deleted = 0",
		poolID, userID)
	if err != nil {
		return out, err
	}
	if len(cards) == 0 {
		return out, errText("共享池内暂无信用卡")
	}

	// 3. 汇总池内全部未结清账单（每卡可能多个账单月）—— 事务外快照，
	//    过期风险由 mergeMode 锁内收敛兜底（P2-7）
	type debt struct {
		cardID string
		billID string
		amount float64
	}
	var debts []debt
	for _, c := range cards {
		bills, err := qRows(db.DB(),
			`SELECT id, need_repay FROM card_bill
         WHERE card_id = ? AND user_id = ? AND is_deleted = 0 AND need_repay > 0
         ORDER BY bill_month ASC`,
			toStr(c["id"]), userID)
		if err != nil {
			return out, err
		}
		for _, b := range bills {
			amt := toF(b["need_repay"])
			if amt > 0 {
				debts = append(debts, debt{cardID: toStr(c["id"]), billID: toStr(b["id"]), amount: amt})
			}
		}
	}
	if len(debts) == 0 {
		return out, errText("共享池内无待还欠款")
	}

	// 4. 单事务逐笔结清（原子：任一失败整体回滚）
	tx, err := db.GetPool().Begin()
	if err != nil {
		return out, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	poolRemark := remark
	if poolRemark == "" {
		poolRemark = "信报合一合并还款(" + orText(pool["bank_name"], "") + ")" // Node `信报合一合并还款(${pool.bank_name || ''})`
	}
	repayIDs := make([]string, 0, len(debts))
	actualAmount := 0.0
	for _, d := range debts {
		rid, actual, err := execRepayTx(tx, RepayParams{
			UserID:            userID,
			CardID:            d.cardID,
			BillID:            d.billID,
			RepayAmount:       d.amount,
			RepayMethod:       repayMethod,
			RepayMethodCardID: repayMethodCardID,
			RepayTime:         repayTime,
			Remark:            poolRemark,
			MergeMode:         true, // P2-7：锁内重读 need_repay 收敛
		})
		if err != nil {
			println("[信报合一合并还款] 回滚:", err.Error())
			return out, err
		}
		if rid != "" {
			repayIDs = append(repayIDs, rid)
			actualAmount += actual
		}
	}
	if err := tx.Commit(); err != nil {
		return out, err
	}
	committed = true

	// 系统自动检查并记录资产快照（对应 Node setImmediate(autoSaveSnapshot)）
	asyncAutoSaveSnapshot(userID)

	cardIDs := make([]string, 0, len(cards))
	for _, c := range cards {
		cardIDs = append(cardIDs, toStr(c["id"]))
	}
	// 🔄 2026-10-13（api.md P2-7）：返回实际结清金额/笔数（并发下可能少于快照）
	return MergeRepayResult{
		TotalAmount: actualAmount,
		Count:       len(repayIDs),
		RepayIDs:    repayIDs,
		CardIDs:     cardIDs,
	}, nil
}

// reverseSourceFlow 对应 CardRepay.#reverseSourceFlow：
// 事务内冲正一笔来源流水（创建等额反向收入 + 软删原流水，恢复资金）。
// from: repay.js:392-411
func reverseSourceFlow(ex db.Commiter, src map[string]any, userID, now, reason string) (string, error) {
	reverseID := idgen.BillID()
	_, err := ex.Exec(
		`INSERT INTO account
       (id, user_id, direction, category_id, pay_type, pay_method, account_type, amount, currency, exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, reversed_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		[]any{
			reverseID, userID, 1, src["category_id"], src["pay_type"], src["pay_method"],
			orText(src["account_type"], "debit"), src["amount"], src["currency"], src["exchange_rate"],
			now[:10],
			reason + "：" + orText(src["remark"], "还款流水"), // Node `${reason}：${src.remark || '还款流水'}`
			src["card_id"], now, now, src["id"],
		}...)
	if err != nil {
		return "", err
	}
	if _, err := ex.Exec(
		"UPDATE account SET is_deleted = 1, update_time = ? WHERE id = ?",
		now, src["id"]); err != nil {
		return "", err
	}
	return reverseID, nil
}

// RepayUpdate 对应 CardRepay.update：
// H5 审计：金额/还款方式变化时，必须同时调整来源资金（冲正原来源流水 + 按新值重建），
// 否则会出现「信用卡欠款恢复，但来源卡资金仍被扣除」的错账。
// from: repay.js:418-577
func RepayUpdate(id, userID string, updates map[string]any) (map[string]any, error) {
	// Node `const { repayAmount, repayMethod, repayTime, remark } = req.body.data`
	// （repayController destructure，data 缺失即抛）——此处由 controller 保证非 nil。

	// 先获取原记录
	oldRecord, err := RepayFindById(id, userID)
	if err != nil {
		return nil, err
	}
	if oldRecord == nil {
		return nil, nil // Node `if (!oldRecord) return null`
	}

	now := tim.NowMS()
	validMethods := []string{"balance", "bank_card", "cash"}
	repayAmount, hasAmount := repayAmountOf(updates) // Node repayAmountNum：null=未提供/空串，NaN=不可解析
	// C2：编辑还款禁止 0/负数——负金额支出会反向增加来源卡余额（计算器把负支出计入收入）
	if hasAmount && !math.IsNaN(repayAmount) && repayAmount <= 0 {
		return nil, errText("还款金额必须大于 0")
	}
	methodChanged := updates["repayMethod"] != nil &&
		containsStr(validMethods, toStr(updates["repayMethod"])) &&
		toStr(updates["repayMethod"]) != toStr(oldRecord["repay_method"])
	amountChanged := hasAmount && !math.IsNaN(repayAmount) &&
		repayAmount != toF(oldRecord["repay_amount"])
	needRebuildFund := amountChanged || methodChanged

	if !needRebuildFund {
		// 仅备注/时间等字段，直接更新（repayMethod 非法时忽略，防止污染枚举）
		fields := []string{"update_time = ?"}
		params := []any{now}
		if hasAmount && !math.IsNaN(repayAmount) {
			fields = append(fields, "repay_amount = ?")
			params = append(params, repayAmount)
		}
		if truthy(updates["repayTime"]) {
			fields = append(fields, "repay_time = ?")
			params = append(params, jsDate10(updates["repayTime"]))
		}
		if updates["remark"] != nil {
			fields = append(fields, "remark = ?")
			params = append(params, sqlVal(updates["remark"]))
		}
		params = append(params, id, userID)
		query := "UPDATE card_repay SET " + strings.Join(fields, ", ") + " WHERE id = ? AND user_id = ? AND is_deleted = 0"
		if _, err := db.DB().Exec(query, params...); err != nil {
			return nil, err
		}
		// Node：CreditCore.syncCardBills(oldRecord.card_id, userId)（全局连接，失败上抛）
		if err := creditcore.SyncCardBills(db.DB(), toStr(oldRecord["card_id"]), userID); err != nil {
			return nil, err
		}
		return RepayFindById(id, userID)
	}

	effMethod := toStr(oldRecord["repay_method"])
	if methodChanged {
		effMethod = toStr(updates["repayMethod"])
	}
	effAmount := toF(oldRecord["repay_amount"])
	if amountChanged {
		effAmount = repayAmount
	}

	tx, err := db.GetPool().Begin()
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// 锁信用卡行，防并发编辑
	lockedCard, err := qRows(tx,
		"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
		toStr(oldRecord["card_id"]), userID)
	if err != nil {
		return nil, err
	}
	if len(lockedCard) == 0 {
		return nil, errText("卡片不存在")
	}

	// 1. 冲正原来源流水（若存在），恢复资金
	var oldSourceCardID string
	// 🔒 SYNC-A39：Node repay.js:482 是 `if (oldRecord.account_id)` —— JS **falsy** 判定，
	// 故 NULL / '' / 0 三者都跳过。Go 的 `!= nil` 只挡 NULL，account_id 为空串时会多跑一次
	// `SELECT * FROM account WHERE id = ''`（无结果，后续行为一致，仅一次无效查询）。
	// 改用 falsy 等价判定，与 Node 完全一致。
	if truthy(oldRecord["account_id"]) {
		// 🔒 SYNC-A45（2026-10-13）：补 FOR UPDATE。
		// 同模块的 reverseDebitById（debit.go:547）与 reverseTransferById（debit.go:688）
		// 早已加行锁（fix BUG-018），而本路径漏了 —— 属遗漏而非设计。
		// 并发时序：T1/T2 都通过事务外的 RepayFindById 看到 account_id 有效 →
		// 各自 INSERT 一条反向流水 → 都软删原流水与 card_repay ⇒ **资金双倍返还**。
		// 加锁后后一方会看到 is_deleted=1 而跳过。
		srcRows, err := qRows(tx,
			"SELECT * FROM account WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			toStr(oldRecord["account_id"]), userID)
		if err != nil {
			return nil, err
		}
		if len(srcRows) > 0 {
			oldSourceCardID = toStr(srcRows[0]["card_id"])
			if _, err := reverseSourceFlow(tx, srcRows[0], userID, now, "还款修改冲正"); err != nil {
				return nil, err
			}
		}
	}

	// 2. 按新方式重建来源流水（P2-7：本卡还款方式已移除，还款必有来源流水）
	if effMethod == "card" {
		return nil, errText("不支持\"本卡还款\"方式，请选择余额、银行卡或现金还款")
	}
	var newAccountID string
	newRepayCardID := toStr(oldRecord["repay_card_id"]) // Node `let newRepayCardId = oldRecord.repay_card_id`
	{
		var srcCardID string
		switch effMethod {
		case "balance":
			srcCardID = "yyyy"
		case "cash":
			srcCardID = "xxxx"
		case "bank_card":
			srcCardID = toStr(updates["repayMethodCardId"])
			if srcCardID == "" {
				srcCardID = toStr(oldRecord["repay_card_id"])
			}
			scRows, err := qRows(tx,
				"SELECT card_type FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
				srcCardID, userID)
			if err != nil {
				return nil, err
			}
			if len(scRows) == 0 {
				return nil, errText("还款银行卡不存在")
			}
			if toStr(scRows[0]["card_type"]) == "credit" {
				return nil, errText("禁止使用信用卡还款")
			}
		}
		if srcCardID == toStr(oldRecord["card_id"]) {
			return nil, errText("不能使用信用卡本身作为还款来源")
		}
		// 余额校验（用事务连接，读到含本事务冲正后的最新状态）
		balanceInfo, err := account.CalculateBalance(tx, srcCardID, userID)
		if err != nil {
			return nil, err
		}
		if toF(balanceInfo["balance"]) < effAmount {
			return nil, errText("余额不足，当前 " + jsNumString(toF(balanceInfo["balance"])) + "，需要 " + jsNumString(effAmount))
		}
		transDate := jsDate10(updates["repayTime"])
		if !truthy(updates["repayTime"]) {
			transDate = jsDate10(oldRecord["repay_time"])
			if transDate == "" {
				transDate = now[:10]
			}
		}
		remark := orText(oldRecord["remark"], "信用卡还款") // Node `oldRecord.remark || '信用卡还款'`
		payMethod := "现金"
		switch effMethod {
		case "balance":
			payMethod = "余额"
		case "bank_card":
			payMethod = "银行卡"
		}
		newAccount, err := account.DebitAccountCreate(tx, account.DebitCreateParams{
			UserID:       userID,
			Direction:    "0",
			CategoryID:   "CATEGORY_REPAY",
			PayType:      "还款",
			PayMethod:    payMethod,
			AccountType:  "debit",
			Amount:       jsNumString(effAmount),
			Currency:     "CNY",
			ExchangeRate: "1",
			TransDate:    transDate,
			Remark:       remark,
			CardID:       srcCardID,
		})
		if err != nil {
			return nil, err
		}
		// 🔒 SYNC-A39：Node repay.js:534 是 `newAccountId = newAccount.id`，
		// create 返回空时抛 TypeError ⇒ 外层 rollback，整笔改账不落库。
		// 旧实现 toStr(nil map["id"]) 得 "" ⇒ account_id 落 NULL 并**提交**，
		// 留下一条无法冲正的还款记录（后续 update/delete 都因 account_id 空而跳过冲正）。
		if newAccount == nil || newAccount["id"] == nil {
			return nil, errText("重建还款流水失败：未取得新流水 ID")
		}
		newAccountID = toStr(newAccount["id"])
		newRepayCardID = srcCardID
	}

	// 3. 更新 card_repay
	fields := []string{"update_time = ?"}
	params := []any{now}
	if amountChanged {
		fields = append(fields, "repay_amount = ?")
		params = append(params, repayAmount)
	}
	if methodChanged {
		fields = append(fields, "repay_method = ?")
		params = append(params, sqlVal(updates["repayMethod"]))
	}
	fields = append(fields, "account_id = ?")
	params = append(params, strOrNil(newAccountID))
	fields = append(fields, "repay_card_id = ?")
	params = append(params, strOrNil(newRepayCardID))
	if truthy(updates["repayTime"]) {
		fields = append(fields, "repay_time = ?")
		params = append(params, jsDate10(updates["repayTime"]))
	}
	if updates["remark"] != nil {
		fields = append(fields, "remark = ?")
		params = append(params, sqlVal(updates["remark"]))
	}
	params = append(params, id, userID)
	query := "UPDATE card_repay SET " + strings.Join(fields, ", ") + " WHERE id = ? AND user_id = ? AND is_deleted = 0"
	if _, err := tx.Exec(query, params...); err != nil {
		return nil, err
	}

	// 4. 重算信用卡账单 + 刷新来源卡余额快照（事务内）
	if err := creditcore.SyncCardBills(tx, toStr(oldRecord["card_id"]), userID); err != nil {
		return nil, err
	}
	if oldSourceCardID != "" {
		if _, err := account.SyncBalanceSnapshot(tx, oldSourceCardID, userID); err != nil {
			return nil, err
		}
	}
	if newRepayCardID != "" && newRepayCardID != oldSourceCardID && newRepayCardID != toStr(oldRecord["card_id"]) {
		if _, err := account.SyncBalanceSnapshot(tx, newRepayCardID, userID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	return RepayFindById(id, userID)
}

// RepayDelete 对应 CardRepay.delete（软删除）。
// H5 审计：删除还款必须同时冲正原来源流水（恢复资金），
// 否则「信用卡恢复欠款，但资金仍被扣除」。
// from: repay.js:584-633
func RepayDelete(id, userID string) (bool, error) {
	record, err := RepayFindById(id, userID)
	if err != nil {
		return false, err
	}
	if record == nil {
		return false, nil // Node `if (!record) return false`
	}

	now := tim.NowMS()
	tx, err := db.GetPool().Begin()
	if err != nil {
		return false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// 锁信用卡行
	if _, err := qRows(tx,
		"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
		toStr(record["card_id"]), userID); err != nil {
		return false, err
	}

	// 1. 冲正原来源流水（恢复资金），并刷新来源卡余额快照
	var sourceCardID string
	// 🔒 SYNC-A39：同上，Node repay.js:601 为 falsy 判定。
	if truthy(record["account_id"]) {
		// 🔒 SYNC-A45（2026-10-13）：补 FOR UPDATE。
		// 同模块的 reverseDebitById（debit.go:547）与 reverseTransferById（debit.go:688）
		// 早已加行锁（fix BUG-018），而本路径漏了 —— 属遗漏而非设计。
		// 并发时序：T1/T2 都通过事务外的 RepayFindById 看到 account_id 有效 →
		// 各自 INSERT 一条反向流水 → 都软删原流水与 card_repay ⇒ **资金双倍返还**。
		// 加锁后后一方会看到 is_deleted=1 而跳过。
		srcRows, err := qRows(tx,
			"SELECT * FROM account WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			toStr(record["account_id"]), userID)
		if err != nil {
			return false, err
		}
		if len(srcRows) > 0 {
			sourceCardID = toStr(srcRows[0]["card_id"])
			if _, err := reverseSourceFlow(tx, srcRows[0], userID, now, "删除还款退回"); err != nil {
				return false, err
			}
		}
	}

	// 2. 软删 card_repay
	if _, err := tx.Exec(
		"UPDATE card_repay SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
		now, id, userID); err != nil {
		return false, err
	}

	// 3. 重算信用卡账单 + 来源卡余额快照（事务内）
	if err := creditcore.SyncCardBills(tx, toStr(record["card_id"]), userID); err != nil {
		return false, err
	}
	if sourceCardID != "" {
		if _, err := account.SyncBalanceSnapshot(tx, sourceCardID, userID); err != nil {
			return false, err
		}
	}

	if err := tx.Commit(); err != nil {
		return false, err
	}
	committed = true
	return true, nil
}

// ===== 本文件助手 =====

// repayAmountOf 对应 Node 的 repayAmountNum 三态：
// 未提供/undefined/null/” → (0,false)；可解析 → (值,true)；不可解析 → (NaN,true)。
func repayAmountOf(updates map[string]any) (float64, bool) {
	v, ok := updates["repayAmount"]
	if !ok || v == nil {
		return 0, false
	}
	if s, isStr := v.(string); isStr && s == "" {
		return 0, false // Node `updates.repayAmount !== ''`
	}
	f, ok := jsNum(v)
	if !ok {
		return math.NaN(), true
	}
	return f, true
}

// jsDate10 对应 `String(updates.repayTime).substring(0, 10)`。
func jsDate10(v any) string {
	s := toStr(v)
	if len(s) > 10 {
		return s[:10]
	}
	return s
}

// orText 对应 Node `a || b`（空串 → b）。
func orText(a any, b string) string {
	s := toStr(a)
	if s == "" {
		return b
	}
	return s
}

// containsStr 对应 Array.prototype.includes。
func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// asyncAutoSaveSnapshot 对应 Node setImmediate(autoSaveSnapshot)：
// account.AutoSaveSnapshotHook 由 asset 模块注册（DebitAccountCreate 内部亦会同款触发，此处不重复）。
func asyncAutoSaveSnapshot(userID string) {
	go func() {
		defer func() { _ = recover() }()
		if account.AutoSaveSnapshotHook != nil {
			account.AutoSaveSnapshotHook(userID)
		}
	}()
}
