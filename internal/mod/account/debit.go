package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

// ============================================================================
// 借记卡账务控制器 —— from: controller/debit.js
// ============================================================================

// DebitCreate 创建借记卡收支记录（普通收支/转账/提现/还款支出流水）。
// from: controller/debit.js:11-30
func DebitCreate(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := dataBody(resp.Parse(r))
	transaction, err := DebitAccountCreate(db.DB(), DebitCreateParams{
		UserID:          uid,
		Direction:       d.Str("data.direction"),
		CategoryID:      d.Str("data.categoryId"),
		PayType:         d.Str("data.payType"),
		PayMethod:       d.Str("data.payMethod"),
		Amount:          d.Str("data.amount"),
		Currency:        d.Str("data.currency"),
		ExchangeRate:    d.Str("data.exchangeRate"),
		TransDate:       d.Str("data.transDate"),
		Remark:          d.Str("data.remark"),
		CardID:          d.Str("data.cardId"),
		TransferGroupID: d.Str("data.transferGroupId"),
	})
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "创建失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": transaction})
}

// DebitUpdate 更新借记卡收支记录。
// from: controller/debit.js:35-54
func DebitUpdate(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	b := resp.Parse(r)
	transaction, err := debitUpdate(id, uid, updateData(b))
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

// ReverseDebit 借记卡冲正。
// from: controller/debit.js:64-91
func ReverseDebit(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	// 🔄 2026-10-13（api.md F-C）：双路径 `const { remark } = req.body.data || req.body`（同 updateRemark）。
	result, err := reverseDebitById(id, uid, toStr(resp.Parse(r).DataOrRaw()["remark"]))
	if err != nil {
		clientMsg := orMsg(err.Error(), "冲正失败")
		// 简化前端提示，详细信息仅在控制台输出
		if strings.Contains(clientMsg, "余额不足") {
			clientMsg = "交易余额不足，无法冲正"
		}
		resp.JSON(w, 400, map[string]any{"status": 400, "message": clientMsg})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "借记卡冲正成功",
		"data": map[string]any{"reversed": result, "originalId": id},
	})
}

// ReverseTransfer 转账冲正（自转/提现撤销）。
// from: controller/debit.js:96-111
func ReverseTransfer(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	// 🔄 2026-10-13（api.md F-C）：双路径 `const { remark } = req.body.data || req.body`。
	result, err := reverseTransferById(id, uid, toStr(resp.Parse(r).DataOrRaw()["remark"]))
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "冲正失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{
		"status": 200, "message": "转账冲正成功",
		"data": map[string]any{"reversed": result, "originalId": id},
	})
}

// ============================================================================
// 借记卡账务模型 —— from: model/debit.js
// ============================================================================

// DebitCreateParams 借记卡收支创建参数。
// 注意：AccountType 对应 Node 调用方（card/repay）传入的 accountType 字段，
// Node 端同样忽略该值（account_type 一律以 card_base 查询结果为准）。
type DebitCreateParams struct {
	UserID          string
	Direction       string // "0"=支出 / "1"=收入
	CategoryID      string
	PayType         string
	PayMethod       string
	AccountType     string
	Amount          string
	Currency        string
	ExchangeRate    string
	TransDate       string
	Remark          string
	CardID          string
	TransferGroupID string
}

// DebitAccountCreate 创建借记卡收支记录。
// 独立实现，不与信用卡共用。处理：普通收支、转账、提现、还款支出流水。
// from: model/debit.js:24-157
func DebitAccountCreate(ex db.Commiter, p DebitCreateParams) (map[string]any, error) {
	// R5：account.card_id 为 NOT NULL，所有收支必须关联卡片（现金=xxxx / 余额=yyyy / 实体卡）
	if p.CardID == "" {
		return nil, errors.New("缺少卡片ID：收支必须关联一张卡片（现金/余额为虚拟卡）")
	}
	// P1-4 审计：金额必须 > 0，否则负支出/负收入会反向篡改账户余额
	amt, finite := jsNumStrict(p.Amount)
	if !finite || amt <= 0 {
		return nil, errors.New("收支金额必须大于 0")
	}
	id := idgen.BillID()
	now := tim.NowMS()
	var err error

	// 从 card_base 获取真实的 card_type
	// 🔒 2026-10-13（api.md P2-5）：实体卡必须存在且归属本人。
	//    原实现 `WHERE id = ? AND is_deleted = 0` 不带 user_id ⇒ 可向他人卡片记收支；
	//    且查不到时静默跳过（配合 validate 的收入放行分支，假卡ID也能建收入）。
	finalAccountType := ""
	if p.CardID != "xxxx" && p.CardID != "yyyy" {
		var cardRows []map[string]any
		cardRows, err = queryRows(ex,
			"SELECT card_type FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
			p.CardID, p.UserID)
		if err != nil {
			return nil, err
		}
		if len(cardRows) == 0 {
			return nil, errors.New("卡片不存在或无权访问")
		}
		finalAccountType = toStr(cardRows[0]["card_type"])
	}

	dir := toF(p.Direction)
	// 借记卡模块拦截：若传入信用卡消费，拒绝（应走 credit 模块）
	if finalAccountType == "credit" && dir == 0 {
		return nil, errors.New("信用卡消费请使用信用卡接口（/account/credit）")
	}
	// 信用卡不能收入（统一拦截，防止误传）
	if finalAccountType == "credit" && dir == 1 {
		return nil, errors.New("信用卡不能登记收入，还款请使用储蓄卡")
	}

	// ===== 清算中心验证 =====
	valid, msg, _ := AccountSettlementValidate(ex, map[string]any{
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

	query := `
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, account_type, amount, currency, exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, transfer_group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `
	_, err = ex.Exec(query, []any{
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
		nilIfEmpty(p.TransferGroupID),
	}...)
	if err != nil {
		return nil, err
	}

	// ===== 清算中心同步余额（从收支表实时计算）=====
	if _, err := SyncBalanceSnapshot(ex, p.CardID, p.UserID); err != nil {
		return nil, err
	}

	// ===== 转账关联：收入方向时写入 account_transfer =====
	// 🔄 2026-10-13（api.md P2-4）：查询/写入统一走 executor（事务连接）。
	//    原实现用全局 db：事务内读不到未提交的支出方记录；
	//    且事务回滚后 account_transfer 残留脏数据。
	if p.TransferGroupID != "" && dir == 1 && p.PayType == "转账" {
		expenseRows, qerr := queryRows(ex, `
          SELECT id, card_id FROM account
          WHERE transfer_group_id = ? AND user_id = ? AND direction = 0 AND is_deleted = 0
          LIMIT 1`,
			p.TransferGroupID, p.UserID)
		if qerr == nil && len(expenseRows) > 0 {
			// 写入失败仅告警（Node try/catch console.warn，不阻断）
			_, _ = execAffected(ex, `
            INSERT INTO account_transfer (id, user_id, from_card_id, to_card_id, amount, trans_date, remark, create_time, is_deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON DUPLICATE KEY UPDATE is_deleted = 0, from_card_id = VALUES(from_card_id), to_card_id = VALUES(to_card_id)
          `, toStr(expenseRows[0]["id"]), p.UserID, toStr(expenseRows[0]["card_id"]), p.CardID,
				p.Amount, orStr(p.TransDate, now[:10]), orStr(p.Remark, "转账"), now)
		}
	}

	// 系统自动检查并记录资产快照
	autoSaveSnapshot(p.UserID)

	// ⚠️ 事务内（executor 为事务连接）时，Account.findById 走全局连接读不到未提交记录，
	//    会返回 null，导致调用方(如还款)无法取得流水 ID。此处直接返回内存对象保证可用。
	//    非事务（默认连接）保持查库，返回完整记录供接口响应。
	if _, isTx := ex.(*sql.Tx); isTx {
		return map[string]any{
			"id":            id,
			"user_id":       p.UserID,
			"card_id":       nilIfEmpty(p.CardID),
			"direction":     dir,
			"amount":        p.Amount,
			"currency":      orStr(p.Currency, "CNY"),
			"exchange_rate": orNumValue(p.ExchangeRate, 1),
			"trans_date":    orStr(p.TransDate, now[:10]),
			"account_type":  finalAccountType,
			"create_time":   now,
			"update_time":   now,
		}, nil
	}
	return FindById(ex, id, p.UserID)
}

// debitUpdate 更新借记卡收支记录。
// 独立实现，仅处理借记卡/虚拟账户流水更新（普通字段更新 + 余额快照同步），
// 不涉及信用卡账单回滚逻辑。
// from: model/debit.js:164-311
func debitUpdate(id, userID string, d map[string]any) (map[string]any, error) {
	now := tim.NowMS()
	// P1-4 审计：金额必须 > 0
	if v, ok := d["amount"]; ok {
		amt, finite := jsNumStrict(toStr(v))
		if !finite || amt <= 0 {
			return nil, errors.New("收支金额必须大于 0")
		}
	}
	// 构造更新的字段（先不注入 update_time/id/userId，由后续分支统一处理）
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

	// 校验：本接口仅处理借记卡流水，信用卡流水应走 credit 模块
	oldRecord, err := FindById(db.DB(), id, userID)
	if err != nil {
		return nil, err
	}
	if oldRecord == nil {
		return nil, errors.New("原流水不存在")
	}
	if toStr(oldRecord["account_type"]) == "credit" {
		return nil, errors.New("该流水为信用卡流水，请使用信用卡接口（/account/credit）更新")
	}
	if oldRecord["reversed_id"] != nil {
		return nil, errors.New("该流水已被冲正，无法修改")
	}

	// P1-6 审计：修改金额/方向/卡片时必须重新校验余额，
	// 否则可先小额通过校验、再改大额/反向，绕过清算中心。
	_, amountChanged := d["amount"]
	_, directionChanged := d["direction"]
	_, cardPresent := d["cardId"]
	cardChanged := cardPresent && toStr(d["cardId"]) != toStr(oldRecord["card_id"])
	balanceFieldsChanged := amountChanged || directionChanged || cardChanged

	if !balanceFieldsChanged {
		// 不涉及余额的字段（备注/日期/分类等）直接更新
		query := `
        UPDATE account 
        SET ` + strings.Join(fields, ", ") + `, update_time = ?
        WHERE id = ? AND user_id = ? AND is_deleted = 0
      `
		if _, err := execAffected(db.DB(), query, append(params, now, id, userID)...); err != nil {
			return nil, err
		}
		return FindById(db.DB(), id, userID)
	}

	targetCardID := toStr(oldRecord["card_id"])
	if cardPresent {
		targetCardID = toStr(d["cardId"])
	}
	newDirection := toF(oldRecord["direction"])
	if directionChanged {
		newDirection = toF(d["direction"])
	}
	newAmount := oldRecord["amount"]
	if amountChanged {
		newAmount = d["amount"]
	}
	newCurrency := toStr(oldRecord["currency"])
	if v, ok := d["currency"]; ok {
		newCurrency = toStr(v)
	}
	newRate := oldRecord["exchange_rate"]
	if v, ok := d["exchangeRate"]; ok {
		newRate = v
	}

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

	// 锁目标卡（新卡）+ 旧卡（换卡场景），串行化并发
	locked, err := queryRows(tx,
		"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
		targetCardID, userID)
	if err != nil {
		return nil, err
	}
	// fix BUG-058：锁卡 SQL 不校验命中（FOR UPDATE 空结果不报错 → 静默换卡失败），校验命中行数
	//
	// 🔧 SYNC-A40（2026-10-13）修正：**必须豁免虚拟账户**。
	//
	// BUG-058 加这道校验时漏了 xxxx（现金）/ yyyy（余额）：
	//   - Node balanceController.js:99-107 `ensureVirtualAccounts` 只写 account_balance 快照，
	//     **从不往 card_base 插行** ⇒ 这两个 id 在 card_base 里永远查不到；
	//   - Node settlement.js:107-109 `validate` 对它们有**短路前置分支**（直接算余额返回），
	//     即 Node 自己就承认它们不是真实卡；
	//   - Node debit.js:259-262 的 FOR UPDATE **不检查结果**，锁空集也照常往下走。
	//
	// 结果：修复前 Go 端「改现金/余额流水的金额或方向」一律 400「卡片不存在」——
	// 而 Node 能正常改。这是**功能回归**，不是加固。
	// （本函数下方 AccountSettlementValidate 里 settlement.go:122 已有对应的短路分支，
	//    此前两道校验自相矛盾。）
	if len(locked) == 0 && targetCardID != "xxxx" && targetCardID != "yyyy" {
		return nil, errors.New("卡片不存在")
	}
	oldCardID := toStr(oldRecord["card_id"])
	if oldCardID != "" && oldCardID != targetCardID {
		if _, err := queryRows(tx,
			"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0 FOR UPDATE",
			oldCardID, userID); err != nil {
			return nil, err
		}
	}

	// P1-6 审计：按新值手动校验余额（不能直接软删原流水再 validate——
	// 单流水卡会被 totalCount===0 误拒；且须按"原流水贡献 − 新流水贡献"计算改后余额）
	origCNY := cur.ToCNY(toF(oldRecord["amount"]), orStr(toStr(oldRecord["currency"]), "CNY"), rateOr1(oldRecord["exchange_rate"]))
	newCNY := cur.ToCNY(toF(newAmount), orStr(newCurrency, "CNY"), rateOr1(newRate))
	// 原流水对来源余额的贡献（收入 +，支出 −）
	origContrib := origCNY
	if toF(oldRecord["direction"]) != 1 {
		origContrib = -origCNY
	}
	newContrib := newCNY
	if newDirection != 1 {
		newContrib = -newCNY
	}
	isCardChanged := targetCardID != oldCardID
	// 目标卡当前余额（事务连接内读取，换卡时不含原流水；同卡时含原流水）
	targetBalanceInfo, err := CalculateBalance(tx, targetCardID, userID)
	if err != nil {
		return nil, err
	}
	targetBalance := toF(targetBalanceInfo["balance"])
	// 改后余额 = 目标卡余额（同卡：− 原流水贡献）+ 新流水贡献
	afterBalance := targetBalance + newContrib
	if !isCardChanged {
		afterBalance += -origContrib
	}

	// 收入方向总是允许（转入/退款）；支出方向要求改后余额 >= 0
	if newDirection == 0 && afterBalance < -1e-9 {
		return nil, fmt.Errorf("余额不足！修改后余额将为 %s", jsToFixed2(afterBalance))
	}

	// 校验通过：按新值写入（注意：Node 事务内 UPDATE 无 is_deleted 条件，保持逐字一致）
	realQuery := `
      UPDATE account
      SET ` + strings.Join(fields, ", ") + `, update_time = ?
      WHERE id = ? AND user_id = ?
    `
	if _, err := tx.Exec(realQuery, append(params, now, id, userID)...); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true

	// 同步余额快照（新卡 + 换卡时的旧卡）
	if _, err := SyncBalanceSnapshot(db.DB(), targetCardID, userID); err != nil {
		return nil, err
	}
	if oldCardID != "" && oldCardID != targetCardID {
		if _, err := SyncBalanceSnapshot(db.DB(), oldCardID, userID); err != nil {
			return nil, err
		}
	}

	return FindById(db.DB(), id, userID)
}

// reverseDebitById 借记卡冲正。
// 原支出 -> 冲正收入，原收入 -> 冲正支出。
// 含余额校验（冲正收入时相当于扣款，需校验余额）+ 事务保护。
// from: model/debit.js:318-413
func reverseDebitById(id, userID, reverseRemark string) (map[string]any, error) {
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
	// 旧版转账记录（无 transfer_group_id）拦截
	if toStr(original["pay_type"]) == "转账" && toStr(original["transfer_group_id"]) == "" {
		return nil, errors.New("该转账流水为早期旧数据，缺少转账关联信息，无法自动冲正。如需撤销请手动创建相反方向的收支记录")
	}
	// fix BUG-017：借记冲正不校验 card_type（信用卡消费流水走借记冲正会生成 direction=1 流水
	// 但不触发 syncCardBills，账单/额度失真）——拦截非 debit 实体卡；
	// 虚拟账户（xxxx/yyyy）LEFT JOIN 后 card_type 为空，不过拦。
	if cardType := toStr(original["card_type"]); cardType != "" && cardType != "debit" {
		return nil, errors.New("该流水为信用卡流水，请使用信用卡接口（/account/credit）冲正")
	}

	reverseDirection := 0.0
	if toF(original["direction"]) == 0 {
		reverseDirection = 1.0
	}

	// 余额校验：冲正收入(direction=1)会创建支出冲正流水，相当于从账户扣回这笔钱，
	// 若后续已被消费导致余额不足，应拒绝冲正；冲正支出(direction=0)相当于退款，总是允许。
	valid, msg, _ := AccountSettlementValidate(db.DB(), map[string]any{
		"card_id":       original["card_id"],
		"user_id":       userID,
		"direction":     reverseDirection,
		"amount":        original["amount"],
		"exchange_rate": original["exchange_rate"],
		"currency":      original["currency"],
	})
	if !valid {
		return nil, fmt.Errorf("冲正失败：%s", msg)
	}

	// 事务执行核心操作：创建冲正流水 + 软删原流水，保证原子性
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

	// 行级锁：重新获取原流水并校验，防止并发重复冲正
	lockedRows, err := queryRows(tx, `
      SELECT id, reversed_id FROM account
      WHERE id = ? AND user_id = ? AND is_deleted = 0
      FOR UPDATE`,
		id, userID)
	if err != nil {
		return nil, fmt.Errorf("借记卡冲正失败：%s", err.Error())
	}
	if len(lockedRows) == 0 {
		return nil, errors.New("借记卡冲正失败：原流水已被删除或冲正")
	}
	if lockedRows[0]["reversed_id"] != nil {
		return nil, errors.New("借记卡冲正失败：该流水已被冲正，无法重复冲正")
	}

	// 创建冲正流水
	_, err = tx.Exec(`
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, amount, currency, 
       exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, reversed_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, []any{
		reverseID, userID, reverseDirection, original["category_id"],
		original["pay_type"], original["pay_method"], original["amount"], original["currency"],
		original["exchange_rate"], now[:10],
		orStr(reverseRemark, "冲正："+orStr(toStr(original["remark"]), "交易撤销")),
		original["card_id"], now, now, original["id"],
	}...)
	if err != nil {
		return nil, fmt.Errorf("借记卡冲正失败：%s", err.Error())
	}

	// 标记原流水为已删除
	if _, err := tx.Exec(
		"UPDATE account SET is_deleted = 1, update_time = ? WHERE id = ?",
		now, id); err != nil {
		return nil, fmt.Errorf("借记卡冲正失败：%s", err.Error())
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("借记卡冲正失败：%s", err.Error())
	}
	committed = true

	// 事务外操作（快照同步，失败不回滚核心数据）
	if _, err := SyncBalanceSnapshot(db.DB(), toStr(original["card_id"]), userID); err != nil {
		return nil, err
	}

	autoSaveSnapshot(userID)

	// fix BUG-016：借记冲正完成后返回冲正流水（Node 返回 findById(原id)=null，
	// 原流水已软删仍查原 id；credit 两接口已改为返回冲正流水）
	return FindById(db.DB(), reverseID, userID)
}

// reverseTransferById 转账冲正（自转 / 提现）。
// 校验：1. 该流水必须是转账类型 (pay_type === '转账')；2. 收款账户余额必须充足以支持冲正退款。
// 处理：将款项退回原转出账户 + 同步扣减收款账户 + 两条原流水均标记为已删除。
// from: model/debit.js:426-566
func reverseTransferById(id, userID, reverseRemark string) (map[string]any, error) {
	// 1. 查询当前流水
	current, err := queryRow(db.DB(), `
      SELECT a.*, cb.card_type, cb.alias as card_alias, cb.last4_no
      FROM account a
      LEFT JOIN card_base cb ON a.card_id = cb.id
      WHERE a.id = ? AND a.user_id = ? AND a.is_deleted = 0`,
		id, userID)
	if err != nil {
		return nil, err
	}
	if current == nil {
		return nil, errors.New("原流水不存在或已被删除")
	}
	if current["reversed_id"] != nil {
		return nil, errors.New("该流水已被冲正，无法重复冲正")
	}

	// 校验转账类型
	if toStr(current["pay_type"]) != "转账" {
		return nil, errors.New("该接口仅支持转账类型的流水")
	}
	if toStr(current["transfer_group_id"]) == "" {
		return nil, errors.New("该流水不属于转账组，无法执行转账冲正")
	}

	// 2. 查询同组所有未删除的记录
	groupRecords, err := findByTransferGroup(toStr(current["transfer_group_id"]), userID)
	if err != nil {
		return nil, err
	}

	// 找到支出方（direction=0）和收入方（direction=1）
	var expenseRecord, incomeRecord map[string]any
	for _, r := range groupRecords {
		if toF(r["direction"]) == 0 && expenseRecord == nil {
			expenseRecord = r
		} else if toF(r["direction"]) == 1 && incomeRecord == nil {
			incomeRecord = r
		}
	}

	if expenseRecord == nil || incomeRecord == nil {
		return nil, errors.New("未找到完整的转账关联记录（缺少支出或收入方），无法冲正")
	}

	// 如果用户点的是某一条已经被冲正的，已在前面的 reversed_id 检查中拦截
	// （Node 此处另有一条 `WHERE id IN (?, ?) AND is_deleted = 1` 查询，结果未使用，不再复刻）

	// 3. 校验收款账户（收入方）余额是否充足以支持退款
	// 退款方向：从收入方卡扣钱退回给支出方卡
	receiverCardID := toStr(incomeRecord["card_id"]) // 收款卡
	senderCardID := toStr(expenseRecord["card_id"])  // 原转出卡

	valid, msg, _ := AccountSettlementValidate(db.DB(), map[string]any{
		"card_id":       receiverCardID,
		"user_id":       userID,
		"direction":     0, // 从收款方扣款（支出）
		"amount":        current["amount"],
		"exchange_rate": orNumValue(toStr(current["exchange_rate"]), 1),
		"currency":      orStr(toStr(current["currency"]), "CNY"),
	})
	if !valid {
		return nil, fmt.Errorf("收款账户余额不足，无法执行冲正退款：%s", msg)
	}

	// 4. 在事务中执行冲正
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

	nowTs := tim.NowMS()

	// fix BUG-018：转账冲正事务内无 FOR UPDATE（并发重复冲正）——事务内补行锁并复核状态
	lockedRows, err := queryRows(tx, `
      SELECT id, reversed_id FROM account
      WHERE id IN (?, ?) AND user_id = ? AND is_deleted = 0
      FOR UPDATE`,
		toStr(expenseRecord["id"]), toStr(incomeRecord["id"]), userID)
	if err != nil {
		return nil, fmt.Errorf("转账冲正失败：%s", err.Error())
	}
	if len(lockedRows) != 2 {
		return nil, errors.New("转账冲正失败：原流水已被删除或冲正")
	}
	for _, lr := range lockedRows {
		if lr["reversed_id"] != nil {
			return nil, errors.New("转账冲正失败：该流水已被冲正，无法重复冲正")
		}
	}

	// 4a. 反转支出方记录（原支出 → 冲正收入，退款给原转出卡）
	reverseExpenseID := idgen.BillID()
	_, err = tx.Exec(`
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, amount, currency, 
       exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, reversed_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, []any{
		reverseExpenseID, userID, 1, // direction=1 收入（退款）
		expenseRecord["category_id"], expenseRecord["pay_type"], expenseRecord["pay_method"],
		expenseRecord["amount"], expenseRecord["currency"], expenseRecord["exchange_rate"],
		nowTs[:10],
		orStr(reverseRemark, "转账冲正："+orStr(toStr(expenseRecord["remark"]), "转出退款")),
		senderCardID, nowTs, nowTs, expenseRecord["id"],
	}...)
	if err != nil {
		return nil, fmt.Errorf("转账冲正失败：%s", err.Error())
	}

	// 4b. 反转收入方记录（原收入 → 冲正支出，扣回收款）
	reverseIncomeID := idgen.BillID()
	_, err = tx.Exec(`
      INSERT INTO account 
      (id, user_id, direction, category_id, pay_type, pay_method, amount, currency, 
       exchange_rate, trans_date, remark, card_id, create_time, update_time, is_deleted, reversed_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, []any{
		reverseIncomeID, userID, 0, // direction=0 支出（扣回）
		incomeRecord["category_id"], incomeRecord["pay_type"], incomeRecord["pay_method"],
		incomeRecord["amount"], incomeRecord["currency"], incomeRecord["exchange_rate"],
		nowTs[:10],
		orStr(reverseRemark, "转账冲正："+orStr(toStr(incomeRecord["remark"]), "转入扣回")),
		receiverCardID, nowTs, nowTs, incomeRecord["id"],
	}...)
	if err != nil {
		return nil, fmt.Errorf("转账冲正失败：%s", err.Error())
	}

	// 4c. 标记两条原流水为已删除
	if _, err := tx.Exec(
		"UPDATE account SET is_deleted = 1, update_time = ? WHERE id IN (?, ?)",
		nowTs, toStr(expenseRecord["id"]), toStr(incomeRecord["id"])); err != nil {
		return nil, fmt.Errorf("转账冲正失败：%s", err.Error())
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("转账冲正失败：%s", err.Error())
	}
	committed = true

	// 5. 同步双方余额
	if _, err := SyncBalanceSnapshot(db.DB(), senderCardID, userID); err != nil {
		return nil, err
	}
	if receiverCardID != senderCardID {
		if _, err := SyncBalanceSnapshot(db.DB(), receiverCardID, userID); err != nil {
			return nil, err
		}
	}

	autoSaveSnapshot(userID)

	// 5. 同步软删除 account_transfer 记录（失败仅告警，可能不存在）
	if _, err := execAffected(db.DB(),
		"UPDATE account_transfer SET is_deleted = 1 WHERE id = ? AND user_id = ?",
		toStr(current["transfer_group_id"]), userID); err != nil {
		_ = err // Node: console.warn 后继续
	}

	// fix BUG-016：转账冲正完成后返回冲正流水（Node 返回 findById(原id)=null）
	if id == toStr(expenseRecord["id"]) {
		return FindById(db.DB(), reverseExpenseID, userID)
	}
	return FindById(db.DB(), reverseIncomeID, userID)
}

// ===== 本文件助手 =====

// jsNumStrict 复刻 Number(x)：空串→0；非法→NaN(ok=false)。
//
// 🔒 SYNC-A39（2026-10-12）：补 NaN / Inf 判定。
//
// Go 的 strconv.ParseFloat 对 "NaN" / "Inf" / "+Inf" / "Infinity" **返回 (NaN, nil)**
// —— err 为 nil！而 JS 的 `Number("NaN")` 虽然也得 NaN，但调用方一律用
// `Number.isFinite(amt)` 把 NaN 拦掉。
//
// Node debit.js:30-33：
//
//	const amt = Number(amount);
//	if (!Number.isFinite(amt) || amt <= 0) throw ...
//
// 旧实现只判 err，导致 "NaN" 字符串：err==nil → ok=true → NaN；
// 而 `NaN <= 0` 为 false ⇒ **绕过金额校验**，把 NaN 写进 account.amount
// 与 card_repay.repay_amount（Node 侧会抛错整体回滚）。
func jsNumStrict(s string) (float64, bool) {
	if s == "" {
		return 0, true
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	// NaN/±Inf 均非有限数 —— 对齐 Number.isFinite
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// orNumValue 复刻 `x || 1`（空串→1，否则原值）。
func orNumValue(s string, def any) any {
	if s == "" {
		return def
	}
	return s
}

// rateOr1 复刻 `exchange_rate || 1`（0/空→1）。
func rateOr1(v any) float64 {
	f := toF(v)
	if f == 0 {
		return 1
	}
	return f
}

// nilIfEmpty 空串 → nil（对应 Node `x || null`）。
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// dateValue10 复刻 `String(x).includes('-') ? String(x).substring(0, 10) : String(x)`
// （注意：JS String(null) = "null"，与 Node 行为保持一致）。
func dateValue10(v any) any {
	s := "null"
	if v != nil {
		s = toStr(v)
	}
	if strings.Contains(s, "-") && len(s) > 10 {
		return s[:10]
	}
	return s
}

// updateData 对应 Node `req.body.data || req.body`（update 控制器取值）。
func updateData(b resp.Body) map[string]any {
	if v, ok := b.Raw["data"]; ok {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return b.Raw
}

// dataBody 把 body.data 包装为独立 resp.Body（Node create 控制器只读 req.body.data；
// Joi stripUnknown 后顶层字段已被剔除，不会回退到顶层取值）。
func dataBody(b resp.Body) resp.Body {
	if v, ok := b.Raw["data"]; ok {
		if m, ok := v.(map[string]any); ok {
			return resp.Body{Data: m, Raw: m}
		}
	}
	return resp.Body{Data: map[string]any{}, Raw: map[string]any{}}
}

// orMsg 对应 Node `error.message || "xxx失败"`。
func orMsg(msg, def string) string {
	if msg == "" {
		return def
	}
	return msg
}
