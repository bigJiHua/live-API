package account

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/creditcore"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

// ============================================================================
// 信用卡账务控制器 —— from: controller/credit.js
// ============================================================================

// CreditCreate 创建信用卡消费记录。
// from: controller/credit.js:11-30
func CreditCreate(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := dataBody(resp.Parse(r))
	// 信用卡不能收入（CreditCreateParams 按导出契约不含 Direction，参照 Node 在入口拦截）
	if d.Str("data.direction") == "1" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "信用卡不能登记收入，还款请使用储蓄卡"})
		return
	}
	transaction, err := CreditAccountCreate(db.DB(), CreditCreateParams{
		UserID:       uid,
		CategoryID:   d.Str("data.categoryId"),
		PayType:      d.Str("data.payType"),
		PayMethod:    d.Str("data.payMethod"),
		Amount:       d.Str("data.amount"),
		Currency:     d.Str("data.currency"),
		ExchangeRate: d.Str("data.exchangeRate"),
		TransDate:    d.Str("data.transDate"),
		Remark:       d.Str("data.remark"),
		CardID:       d.Str("data.cardId"),
	})
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "创建失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": transaction})
}

// CreditUpdate 更新信用卡消费记录。
// from: controller/credit.js:35-54
func CreditUpdate(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	b := resp.Parse(r)
	transaction, err := creditUpdate(id, uid, updateData(b))
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "更新失败")})
		return
	}
	if transaction == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": transaction})
}

// ReverseCreditExpense 信用卡消费冲正。
// from: controller/credit.js:59-85
func ReverseCreditExpense(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	b := resp.Parse(r)
	result, err := reverseCreditExpenseById(id, uid, toStr(b.Raw["remark"]))
	if err != nil {
		clientMsg := orMsg(err.Error(), "冲正失败")
		// 简化前端提示，详细信息仅在控制台输出
		if strings.Contains(clientMsg, "已还清") || strings.Contains(clientMsg, "已有还款记录") {
			clientMsg = "该笔消费所在的账单周期已还清，冲正将产生溢缴，请先撤销还款再冲正！"
		}
		resp.JSON(w, 400, map[string]any{"status": 400, "message": clientMsg})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "信用卡消费冲正成功",
		"data": map[string]any{"reversed": result, "originalId": id},
	})
}

// ReverseCreditRepay 信用卡还款撤销。
// from: controller/credit.js:90-111
func ReverseCreditRepay(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	b := resp.Parse(r)
	result, err := reverseCreditRepayById(id, uid, toStr(b.Raw["remark"]))
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "撤销失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "信用卡还款撤销成功",
		"data": map[string]any{"reversed": result, "originalId": id},
	})
}

// ============================================================================
// 信用卡账务模型 —— from: model/credit.js
// ============================================================================

// CreditCreateParams 信用卡消费创建参数。
type CreditCreateParams struct {
	UserID       string
	CategoryID   string
	PayType      string
	PayMethod    string
	Amount       string
	Currency     string
	ExchangeRate string
	TransDate    string
	Remark       string
	CardID       string
}

// syncForeignRegister 外币消费登记随流水创建/更新/币种切换而同步（痛点4）。
// C5 审计：登记失败不允许被吞掉——失败直接抛出，外层事务回滚。
// from: model/credit.js:24-40
func syncForeignRegister(ex db.Commiter, id, userID, cardID, currency, amount, exchangeRate string) error {
	if currency != "" && currency != "CNY" {
		// registeredRate 对应 Node `exchangeRate || 0`；foreignAmount 对应 `Number(amount || 0)`
		_, err := creditcore.EnsurePendingRegister(ex, userID, cardID, id, currency, toF(amount), toF(exchangeRate))
		return err
	}
	// 改为人民币或未知：移除外币登记（使用同一事务连接，跟随外层事务回滚，H4 审计）
	return creditcore.DeleteForeignByAccountId(ex, id, userID)
}

// CreditAccountCreate 创建信用卡消费记录。
// 独立实现，仅处理信用卡消费（direction=0），含事务；账单一律交由 CreditCore.syncCardBills 全量重算。
// from: model/credit.js:46-166
func CreditAccountCreate(ex db.Commiter, p CreditCreateParams) (map[string]any, error) {
	id := idgen.BillID()
	now := tim.NowMS()

	// 从 card_base 获取真实的 card_type
	finalAccountType := ""
	cardRows, err := queryRows(ex,
		"SELECT card_type FROM card_base WHERE id = ? AND is_deleted = 0",
		p.CardID)
	if err != nil {
		return nil, err
	}
	if len(cardRows) > 0 && cardRows[0]["card_type"] != nil {
		finalAccountType = toStr(cardRows[0]["card_type"])
	}

	// 信用卡消费恒为支出方向（Node：direction===1 已在入口拦截；CreditCreateParams 导出契约不含 Direction）
	dir := 0.0

	// 信用卡模块拦截：仅处理信用卡
	if finalAccountType != "credit" {
		return nil, errors.New("信用卡接口仅支持信用卡流水，借记卡请使用 /account/debit")
	}
	// P0-1 审计：CATEGORY_REPAY 为还款专用分类，信用卡消费传入会导致该笔不计入账单、额度逃逸。
	//         金额必须 > 0，负数消费不进账单但会留脏数据。
	if p.CategoryID == "CATEGORY_REPAY" {
		return nil, errors.New("信用卡消费不允许使用还款分类（CATEGORY_REPAY）")
	}
	amt, finite := jsNumStrict(p.Amount)
	if !finite || amt <= 0 {
		return nil, errors.New("信用卡消费金额必须大于 0")
	}

	query := `
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, account_type, amount, currency, exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, transfer_group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `

	// 信用卡消费：事务内创建流水 + 同步账单额度
	tx, err := db.GetPool().BeginTx(context.Background(), nil)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// H9 审计：事务内行级锁（锁卡片；若属于共享池则锁池行），串行化并发消费。
	// 锁后再校验额度（读到的都是已提交的最新账本），避免两笔并发同时通过校验。
	lockedCard, err := queryRows(tx,
		"SELECT id, share_pool_id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
		p.CardID, p.UserID)
	if err != nil {
		return nil, err
	}
	if len(lockedCard) == 0 {
		return nil, errors.New("卡片不存在")
	}
	if sharePoolID := toStr(lockedCard[0]["share_pool_id"]); sharePoolID != "" {
		if _, err := queryRows(tx,
			"SELECT id FROM card_credit_pool WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			sharePoolID, p.UserID); err != nil {
			return nil, err
		}
	}

	// ===== 清算中心验证（额度校验）—— 必须在锁内、事务内执行 =====
	valid, msg, _ := AccountSettlementValidate(tx, map[string]any{
		"card_id":       p.CardID,
		"user_id":       p.UserID,
		"direction":     dir,
		"amount":        p.Amount,
		"exchange_rate": orNumValue(p.ExchangeRate, 1),
		"currency":      orStr(p.Currency, "CNY"),
		"account_type":  finalAccountType,
	})
	if !valid {
		return nil, errors.New(msg)
	}

	_, err = tx.Exec(query, []any{
		id,
		p.UserID,
		dir,
		p.CategoryID,
		p.PayType,
		p.PayMethod,
		finalAccountType,
		p.Amount,
		orStr(p.Currency, "CNY"),
		orNumValue(p.ExchangeRate, 1),
		orStr(p.TransDate, now[:10]),
		orStr(p.Remark, ""),
		p.CardID,
		now,
		now,
		nil,
	}...)
	if err != nil {
		return nil, err
	}
	// 外币消费：先登记 pending（事务内、重算前），使 syncCardBills 重算时登记已存在
	// （pending 状态被 CreditCore 跳过计入，对账完成后再重算计入实际汇率，P2 审计修复）
	if err := syncForeignRegister(tx, id, p.UserID, p.CardID, p.Currency, p.Amount, p.ExchangeRate); err != nil {
		return nil, err
	}
	// [CreditCore] 统一重算（账本全量重算，幂等）
	if err := creditcore.SyncCardBills(tx, p.CardID, p.UserID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true

	// 信用卡余额快照同步（syncBalanceSnapshot 对信用卡会跳过，保留调用保持一致性）
	if _, err := SyncBalanceSnapshot(db.DB(), p.CardID, p.UserID); err != nil {
		return nil, err
	}

	// 系统自动检查并记录资产快照
	autoSaveSnapshot(p.UserID)

	return FindById(db.DB(), id, p.UserID)
}

// creditUpdate 更新信用卡消费记录。
// 独立实现，处理金额/日期变更时的账单回滚 + 重同步；
// 修复：增加 reversed_id 校验，防止已冲正流水被 update 导致双重回滚。
// from: model/credit.js:173-355
func creditUpdate(id, userID string, d map[string]any) (map[string]any, error) {
	now := tim.NowMS()
	fields := []string{}
	params := []any{}

	if v, ok := d["direction"]; ok {
		fields = append(fields, "direction = ?")
		params = append(params, v)
	}
	if v, ok := d["categoryId"]; ok {
		fields = append(fields, "category_id = ?")
		params = append(params, v)
	}
	if v, ok := d["payType"]; ok {
		fields = append(fields, "pay_type = ?")
		params = append(params, v)
	}
	if v, ok := d["payMethod"]; ok {
		fields = append(fields, "pay_method = ?")
		params = append(params, v)
	}
	if v, ok := d["amount"]; ok {
		fields = append(fields, "amount = ?")
		params = append(params, v)
	}
	if v, ok := d["currency"]; ok {
		fields = append(fields, "currency = ?")
		params = append(params, v)
	}
	if v, ok := d["exchangeRate"]; ok {
		fields = append(fields, "exchange_rate = ?")
		params = append(params, v)
	}
	if v, ok := d["transDate"]; ok {
		fields = append(fields, "trans_date = ?")
		params = append(params, dateValue10(v))
	}
	if v, ok := d["remark"]; ok {
		fields = append(fields, "remark = ?")
		params = append(params, v)
	}
	if v, ok := d["cardId"]; ok {
		fields = append(fields, "card_id = ?")
		params = append(params, v)
	}

	if len(fields) == 0 {
		return FindById(db.DB(), id, userID)
	}

	fields = append(fields, "update_time = ?")
	params = append(params, now)
	params = append(params, id, userID)

	query := `
      UPDATE account 
      SET ` + strings.Join(fields, ", ") + `
      WHERE id = ? AND user_id = ? AND is_deleted = 0
    `

	// 校验：本接口仅处理信用卡消费流水
	oldRecord, err := FindById(db.DB(), id, userID)
	if err != nil {
		return nil, err
	}
	if oldRecord == nil {
		return nil, errors.New("原流水不存在")
	}
	if toStr(oldRecord["account_type"]) != "credit" {
		return nil, errors.New("该流水为借记卡流水，请使用借记卡接口（/account/debit）更新")
	}
	// 修复隐患：已冲正的流水不允许 update，防止重复冲正
	if oldRecord["reversed_id"] != nil {
		return nil, errors.New("该流水已被冲正，无法修改")
	}

	// P0-1 审计：信用卡消费 update 同样禁止改为还款分类；金额必须 > 0
	if v, ok := d["categoryId"]; ok && toStr(v) == "CATEGORY_REPAY" {
		return nil, errors.New("信用卡消费不允许使用还款分类（CATEGORY_REPAY）")
	}
	if v, ok := d["amount"]; ok {
		amt, finite := jsNumStrict(toStr(v))
		if !finite || amt <= 0 {
			return nil, errors.New("信用卡消费金额必须大于 0")
		}
	}

	// H2 审计：重算条件必须覆盖所有影响账单的字段（金额/日期/卡片/币种/汇率/方向/分类），
	// 此前仅金额/日期变更触发重算，改币种/汇率/方向/分类/换卡会绕过账单同步。
	targetCardID := toStr(oldRecord["card_id"])
	if v, ok := d["cardId"]; ok {
		targetCardID = toStr(v)
	}
	_, isAmountChanged := d["amount"]
	_, isDateChanged := d["transDate"]
	_, cardPresent := d["cardId"]
	isCardChanged := cardPresent && toStr(d["cardId"]) != toStr(oldRecord["card_id"])
	_, currencyPresent := d["currency"]
	_, ratePresent := d["exchangeRate"]
	isCurrencyRateChanged := currencyPresent || ratePresent
	_, directionPresent := d["direction"]
	isDirectionChanged := directionPresent && toF(d["direction"]) != toF(oldRecord["direction"])
	_, categoryPresent := d["categoryId"]
	isCategoryChanged := categoryPresent && toStr(d["categoryId"]) != toStr(oldRecord["category_id"])
	needsBillSync := isAmountChanged || isDateChanged || isCardChanged || isCurrencyRateChanged || isDirectionChanged || isCategoryChanged

	if needsBillSync {
		// 信用卡流水变更 → 事务内：锁卡 + 校验额度 + 更新流水 + 外币登记 + 重算目标卡/旧卡
		tx, err := db.GetPool().BeginTx(context.Background(), nil)
		if err != nil {
			return nil, err
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Rollback()
			}
		}()

		// H9：锁目标卡（可能为新卡）+ 若为共享池则锁池行，串行化并发
		lockedCard, err := queryRows(tx,
			"SELECT id, share_pool_id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			targetCardID, userID)
		if err != nil {
			return nil, err
		}
		if len(lockedCard) == 0 {
			return nil, errors.New("卡片不存在")
		}
		if sharePoolID := toStr(lockedCard[0]["share_pool_id"]); sharePoolID != "" {
			if _, err := queryRows(tx,
				"SELECT id FROM card_credit_pool WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
				sharePoolID, userID); err != nil {
				return nil, err
			}
		}

		// C4：无论变更哪类影响账单的字段（金额/币种/汇率/换卡/方向/分类），一律在锁内重新校验额度。
		//    - 同卡修改：按「差额」校验（excludeAmountCNY = 原流水折算 CNY），避免把原消费重复计入而错误拒绝
		//    - 换卡：原流水在旧卡聚合中，目标卡不含它 → excludeAmountCNY = 0
		//    - 改币种/汇率：新 CNY 折算可能超限，必须校验
		newDirection := toF(oldRecord["direction"])
		if directionPresent {
			newDirection = toF(d["direction"])
		}
		if newDirection == 1 {
			return nil, errors.New("信用卡不能登记收入，还款请使用储蓄卡")
		}
		originalCNY := cur.ToCNY(toF(oldRecord["amount"]), orStr(toStr(oldRecord["currency"]), "CNY"), rateOr1(oldRecord["exchange_rate"]))
		excludeAmountCNY := 0.0
		if !isCardChanged {
			excludeAmountCNY = originalCNY
		}
		newAmount := toStr(oldRecord["amount"])
		if isAmountChanged {
			newAmount = toStr(d["amount"])
		}
		newRate := toStr(oldRecord["exchange_rate"])
		if ratePresent {
			newRate = toStr(d["exchangeRate"])
		}
		newCurrency := toStr(oldRecord["currency"])
		if currencyPresent {
			newCurrency = toStr(d["currency"])
		}
		valid, msg, _ := AccountSettlementValidate(tx, map[string]any{
			"card_id":          targetCardID,
			"user_id":          userID,
			"direction":        newDirection,
			"amount":           newAmount,
			"exchange_rate":    orNumValue(newRate, 1),
			"currency":         orStr(newCurrency, "CNY"),
			"account_type":     "credit",
			"excludeAmountCNY": excludeAmountCNY,
		})
		if !valid {
			return nil, errors.New(msg)
		}

		// 更新流水
		if _, err := tx.Exec(query, params...); err != nil {
			return nil, err
		}

		// 外币登记随消费金额/币种/卡片变更而同步（事务内、重算前；使用目标卡 ID）
		if err := syncForeignRegister(tx, id, userID, targetCardID, newCurrency, newAmount, newRate); err != nil {
			return nil, err
		}

		// 重算目标卡全部账单；换卡时旧卡也一并重算
		if err := creditcore.SyncCardBills(tx, targetCardID, userID); err != nil {
			return nil, err
		}
		if isCardChanged {
			if err := creditcore.SyncCardBills(tx, toStr(oldRecord["card_id"]), userID); err != nil {
				return nil, err
			}
		}

		if err := tx.Commit(); err != nil {
			return nil, err
		}
		committed = true

		// 事务外：同步余额快照（目标卡 + 换卡时的旧卡）
		if _, err := SyncBalanceSnapshot(db.DB(), targetCardID, userID); err != nil {
			return nil, err
		}
		if isCardChanged && toStr(oldRecord["card_id"]) != "" {
			if _, err := SyncBalanceSnapshot(db.DB(), toStr(oldRecord["card_id"]), userID); err != nil {
				return nil, err
			}
		}

		return FindById(db.DB(), id, userID)
	}

	// 仅备注/支付方式等不影响账单的字段变更
	if _, err := execAffected(db.DB(), query, params...); err != nil {
		return nil, err
	}

	var updated map[string]any
	if cardPresent && toStr(d["cardId"]) != "" || isAmountChanged || directionPresent {
		updated, err = FindById(db.DB(), id, userID)
		if err != nil {
			return nil, err
		}
		if updated != nil && updated["card_id"] != nil {
			if _, err := SyncBalanceSnapshot(db.DB(), toStr(updated["card_id"]), userID); err != nil {
				return nil, err
			}
		}
	}

	if updated != nil {
		return updated, nil
	}
	return FindById(db.DB(), id, userID)
}

// reverseCreditExpenseById 信用卡消费冲正。
// 原支出 -> 冲正收入 + 恢复账单额度。
// from: model/credit.js:361-513
func reverseCreditExpenseById(id, userID, reverseRemark string) (map[string]any, error) {
	now := tim.NowMS()

	// ===== 1. 查询原流水 =====
	original, err := queryRow(db.DB(), `
      SELECT 
          a.*,
          cb.card_type,
          cb.alias as card_alias,
          cb.last4_no,
          cb.bill_day
       FROM account a
       LEFT JOIN card_base cb ON a.card_id = cb.id
       WHERE a.id = ? AND a.user_id = ? AND a.is_deleted = 0`,
		id, userID)
	if err != nil {
		return nil, err
	}

	// ===== 2. 基础校验 =====
	if original == nil {
		return nil, errors.New("原流水不存在或已被删除")
	}
	if original["reversed_id"] != nil {
		return nil, errors.New("该流水已被冲正，无法重复冲正")
	}

	// 仅限信用卡
	if toStr(original["card_type"]) != "credit" {
		return nil, errors.New("该接口仅支持信用卡消费冲正")
	}
	if toF(original["direction"]) != 0 {
		return nil, errors.New("该接口仅支持信用卡支出流水冲正")
	}

	// 旧版转账记录拦截
	if toStr(original["pay_type"]) == "转账" && toStr(original["transfer_group_id"]) == "" {
		return nil, errors.New("该转账流水为早期旧数据，缺少转账关联信息，无法自动冲正。如需撤销请手动创建相反方向的收支记录")
	}

	// ===== 3. 账单周期校验 =====

	// 校验账单日配置
	billDayF := toF(original["bill_day"])
	if billDayF != float64(int(billDayF)) || billDayF < 1 || billDayF > 31 {
		return nil, fmt.Errorf("卡片 [%s] 账单日配置异常", orStr(toStr(original["card_alias"]), toStr(original["card_id"])))
	}
	billDay := int(billDayF)

	// 计算原消费所属账单周期
	billMonth := getBillMonthByDate(toStr(original["trans_date"]), billDay)

	// 检查对应账单是否存在（card_bill 查询直接用 SQL，与 Node CardBill.findByCardAndMonth 一致）
	bill, err := queryRow(db.DB(),
		"SELECT * FROM card_bill WHERE card_id = ? AND bill_month = ? AND is_deleted = 0",
		toStr(original["card_id"]), billMonth)
	if err != nil {
		return nil, err
	}
	if bill == nil {
		return nil, fmt.Errorf("该消费属于 %s 账单周期，但该周期账单不存在，无法冲正", billMonth)
	}

	// 检查该账单周期内是否已有还款
	repayRows, err := queryRows(db.DB(), `
      SELECT id, repay_amount, repay_time
      FROM card_repay
      WHERE card_id = ?
        AND user_id = ?
        AND (bill_month = ? OR bill_id = ?)
        AND is_deleted = 0
      LIMIT 1`,
		toStr(original["card_id"]), userID, billMonth, toStr(bill["id"]))
	if err != nil {
		return nil, err
	}

	if len(repayRows) > 0 {
		// 仅当该账单已"完全还清"（待还金额≈0）时才禁止冲正。
		// 若仍有未还欠款(need_repay>0)，说明账单尚未结清，允许冲正本期内的消费
		// （例如还款后新增的消费、或还款后发生的退款），避免"还过款就一律锁死"的问题。
		needRepay := toF(bill["need_repay"])
		if needRepay < 0.01 {
			return nil, fmt.Errorf("该消费属于 %s 账单周期，该周期已还清（还款 %s元），继续冲正将产生溢缴差额，请先撤销还款后再冲正此笔交易",
				billMonth, toStr(repayRows[0]["repay_amount"]))
		}
	}

	// ===== 4. 事务执行核心操作 =====
	reverseID := idgen.BillID()
	tx, err := db.GetPool().BeginTx(context.Background(), nil)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// 4a. 行级锁：重新获取原流水并校验，防止并发重复冲正
	lockedRows, err := queryRows(tx, `
      SELECT id, reversed_id FROM account
      WHERE id = ? AND user_id = ? AND is_deleted = 0
      FOR UPDATE`,
		id, userID)
	if err != nil {
		return nil, fmt.Errorf("信用卡消费冲正失败：%s", err.Error())
	}
	if len(lockedRows) == 0 {
		return nil, errors.New("信用卡消费冲正失败：原流水已被删除或冲正")
	}
	if lockedRows[0]["reversed_id"] != nil {
		return nil, errors.New("信用卡消费冲正失败：该流水已被冲正，无法重复冲正")
	}

	// 4b. 创建冲正流水
	_, err = tx.Exec(`
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, amount, currency, 
       exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, reversed_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, []any{
		reverseID, userID, 1, original["category_id"],
		original["pay_type"], original["pay_method"], original["amount"], original["currency"],
		original["exchange_rate"], now[:10],
		orStr(reverseRemark, "冲正："+orStr(toStr(original["remark"]), "交易撤销")),
		original["card_id"], now, now, original["id"],
	}...)
	if err != nil {
		return nil, fmt.Errorf("信用卡消费冲正失败：%s", err.Error())
	}

	// 4c. 标记原流水为已删除
	if _, err := tx.Exec(
		"UPDATE account SET is_deleted = 1, update_time = ? WHERE id = ?",
		now, id); err != nil {
		return nil, fmt.Errorf("信用卡消费冲正失败：%s", err.Error())
	}

	// 4c2. 冲正连带删除外币登记（同一事务，C5 审计：避免 pending 占额残留/额度快照滞后）
	//      必须早于 syncCardBills，使 pending 占额在重算时已释放
	if err := creditcore.DeleteForeignByAccountId(tx, id, userID); err != nil {
		return nil, fmt.Errorf("信用卡消费冲正失败：%s", err.Error())
	}

	// 4c. [CreditCore] 重算账单（消费已冲正并标记删除，账本重算即反映额度恢复）
	if err := creditcore.SyncCardBills(tx, toStr(original["card_id"]), userID); err != nil {
		return nil, fmt.Errorf("信用卡消费冲正失败：%s", err.Error())
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("信用卡消费冲正失败：%s", err.Error())
	}
	committed = true

	// ===== 5. 事务外操作（快照同步，失败不回滚核心数据）=====
	if _, err := SyncBalanceSnapshot(db.DB(), toStr(original["card_id"]), userID); err != nil {
		return nil, err
	}

	autoSaveSnapshot(userID)

	return FindById(db.DB(), reverseID, userID)
}

// reverseCreditRepayById 信用卡还款撤销冲正。
// 原还款流水 -> 冲正收入（恢复余额）+ 软删除 card_repay + 重建账单。
// from: model/credit.js:519-646
func reverseCreditRepayById(id, userID, reverseRemark string) (map[string]any, error) {
	now := tim.NowMS()

	original, err := queryRow(db.DB(), `
      SELECT a.*, cb.card_type, cb.alias as card_alias, cb.last4_no
      FROM account a
      LEFT JOIN card_base cb ON a.card_id = cb.id
      WHERE a.id = ? AND a.user_id = ? AND a.is_deleted = 0`,
		id, userID)
	if err != nil {
		return nil, err
	}

	if original == nil {
		return nil, errors.New("原流水不存在或已被删除")
	}
	if original["reversed_id"] != nil {
		return nil, errors.New("该流水已被冲正，无法重复冲正")
	}
	if toStr(original["category_id"]) != "CATEGORY_REPAY" {
		return nil, errors.New("该接口仅支持信用卡还款流水")
	}

	// ===== 1. 事务内：行锁校验 + 创建冲正流水 + 软删原流水 + 软删 card_repay =====
	reverseID := idgen.BillID()
	tx, err := db.GetPool().BeginTx(context.Background(), nil)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// 1a. 行级锁：重新校验原流水，防并发重复冲正
	lockedRows, err := queryRows(tx, `
      SELECT id, reversed_id, category_id FROM account
      WHERE id = ? AND user_id = ? AND is_deleted = 0
      FOR UPDATE`,
		id, userID)
	if err != nil {
		return nil, err
	}
	if len(lockedRows) == 0 {
		return nil, errors.New("原流水已被删除或冲正")
	}
	if lockedRows[0]["reversed_id"] != nil {
		return nil, errors.New("该流水已被冲正，无法重复冲正")
	}
	if toStr(lockedRows[0]["category_id"]) != "CATEGORY_REPAY" {
		return nil, errors.New("该接口仅支持信用卡还款流水")
	}

	// 1b. 创建冲正流水（收入方向，恢复余额）
	_, err = tx.Exec(`
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, amount, currency, 
       exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, reversed_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, []any{
		reverseID, userID, 1, original["category_id"],
		original["pay_type"], original["pay_method"], original["amount"], original["currency"],
		original["exchange_rate"], now[:10],
		orStr(reverseRemark, "还款撤销："+orStr(toStr(original["remark"]), "交易撤销")),
		original["card_id"], now, now, original["id"],
	}...)
	if err != nil {
		return nil, err
	}

	// 1c. 标记原流水为已删除
	if _, err := tx.Exec(
		"UPDATE account SET is_deleted = 1, update_time = ? WHERE id = ?",
		now, id); err != nil {
		return nil, err
	}

	// 1d. 查询并软删除 card_repay 记录
	// P2-8 审计：本卡还款方式已移除，但历史数据可能存在 account_id IS NULL 的旧记录。
	//     优先按 account_id 精确匹配；匹配不到时回退按流水 card_id + 金额 + 时间兜底匹配，
	//     保证撤销路径与 CardRepay.delete 语义一致（都能撤销本卡还款旧数据）。
	repayRows, rerr := queryRows(tx,
		"SELECT * FROM card_repay WHERE account_id = ? AND is_deleted = 0 LIMIT 1",
		id)
	if rerr != nil {
		repayRows = nil // Node try/catch → repayRows = []
	}
	if len(repayRows) == 0 {
		// keep BUG-022：兜底匹配按"今天"（repay_time = now），历史记录 repay_time 是还款当天，
		// 旧数据（account_id IS NULL）还款撤销必报"未找到关联的还款记录"，维持原样
		repayRows, err = queryRows(tx, `
          SELECT * FROM card_repay
          WHERE card_id = ? AND user_id = ? AND account_id IS NULL AND is_deleted = 0
            AND repay_time = ? AND repay_amount = ?
          ORDER BY create_time DESC LIMIT 1`,
			toStr(original["card_id"]), userID, now[:10], original["amount"])
		if err != nil {
			return nil, err
		}
	}

	if len(repayRows) == 0 {
		return nil, errors.New("未找到关联的还款记录")
	}

	repayRecord := repayRows[0]
	creditCardID := toStr(repayRecord["card_id"])

	if _, err := tx.Exec(
		"UPDATE card_repay SET is_deleted = 1, update_time = ? WHERE id = ?",
		now, toStr(repayRecord["id"])); err != nil {
		return nil, err
	}

	// [CreditCore] 重建账单（事务内，避免"撤销已提交但重算失败"的半完成态，P3 审计）
	if err := creditcore.SyncCardBills(tx, creditCardID, userID); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true

	// ===== 2. 事务外：同步来源卡余额快照 =====

	// 同步来源卡余额快照：还款流水挂在来源卡(original.card_id)上，
	// 冲正后来源卡余额已恢复，必须更新 account_balance 快照，否则前端读快照会显示旧余额。
	// 注意：信用卡本身的 syncBalanceSnapshot 会被跳过（信用卡用 card_bill 而非 account_balance），
	// 真正需要更新的是来源卡（借记卡/余额/现金）的快照。
	if _, err := SyncBalanceSnapshot(db.DB(), toStr(original["card_id"]), userID); err != nil {
		return nil, err
	}

	// 系统自动检查并记录资产快照
	autoSaveSnapshot(userID)

	// M3 审计：原流水已软删，findById(id) 返回 null；应返回新冲正流水
	return FindById(db.DB(), reverseID, userID)
}

// ============================================================================
// 账单周期计算 —— from: card/model/bill.js getBillMonthByDate（纯函数，直接 SQL 查账单）
// ============================================================================

var billDateLayouts = []string{
	"2006-01-02",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04:05",
	"2006-01-02T15:04:05Z07:00",
	"2006/01/02",
}

// getBillMonthByDate 获取账单月 YYYY-MM。
// 账单周期：账单日(bill_day)次日 ~ 次月账单日前一天。
// 消费日期 <= 账单日 属于当月账单，消费日期 > 账单日 属于下月账单（账单日当天仍属当月）。
// from: card/model/bill.js:60-95
func getBillMonthByDate(transDate string, billDay int) string {
	s := strings.TrimSpace(transDate)
	var t time.Time
	if s == "" {
		t = tim.Now()
	} else if isAllDigits(s) {
		ts := toF(s)
		switch len(s) {
		case 10: // 秒级时间戳，转为毫秒
			t = time.Unix(int64(ts), 0).In(tim.Loc())
		case 13: // 毫秒时间戳
			t = time.UnixMilli(int64(ts)).In(tim.Loc())
		default:
			t = parseDateLoose(s)
		}
	} else {
		t = parseDateLoose(s)
	}

	// day > billDay 属于下月账单（账单日当天仍属当月）
	if t.Day() > billDay {
		year, month := t.Year(), int(t.Month())
		if month == 12 {
			return strconv.Itoa(year+1) + "-01"
		}
		return strconv.Itoa(year) + "-" + pad2(month+1)
	}
	return strconv.Itoa(t.Year()) + "-" + pad2(int(t.Month()))
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// parseDateLoose 宽松解析日期（对应 Node new Date(str) 的常见格式）。
func parseDateLoose(s string) time.Time {
	for _, layout := range billDateLayouts {
		if t, err := time.ParseInLocation(layout, s, tim.Loc()); err == nil {
			return t
		}
	}
	return tim.Now()
}
