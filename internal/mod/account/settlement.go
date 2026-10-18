package account

import (
	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/creditcore"
	"live/api/internal/tim"
)

// ============================================================================
// 账户清算中心 —— from: service/settlement.js
// ============================================================================

// CalculateBalance 计算余额（从 account 表汇总，换算成人民币价值）。
// CNY（人民币）：金额 * 1（1:1 不变）；外币：amount * exchange_rate / 100。
// 跳过 reversed_id 不为空的流水（已被冲正，不应计入余额）。
// from: service/settlement.js:17-49
func CalculateBalance(ex db.Commiter, cardID, userID string) (map[string]any, error) {
	query := `
      SELECT 
        currency,
        direction,
        amount,
        exchange_rate
      FROM account
      WHERE card_id = ? AND user_id = ? AND is_deleted = 0 AND reversed_id IS NULL
    `
	rows, err := queryRows(ex, query, cardID, userID)
	if err != nil {
		return nil, err
	}

	income, expense := 0.0, 0.0
	for _, row := range rows {
		amount := toF(row["amount"])
		cnyAmount := cur.ToCNY(amount, toStr(row["currency"]), toF(row["exchange_rate"]))
		if toF(row["direction"]) == 1 {
			income += cnyAmount
		} else {
			expense += cnyAmount
		}
	}

	return map[string]any{
		"income":     cur.Round2(income),
		"expense":    cur.Round2(expense),
		"balance":    cur.Round2(income - expense),
		"totalCount": float64(len(rows)),
	}, nil
}

// getBalanceSnapshot 获取余额快照。
// from: service/settlement.js:54-61
func getBalanceSnapshot(cardID, userID string) (map[string]any, error) {
	query := `
      SELECT * FROM account_balance 
      WHERE card_id = ? AND user_id = ? AND is_deleted = 0
    `
	return queryRow(db.DB(), query, cardID, userID)
}

// getAllBalances 获取用户所有账户余额。
// keep BUG-019：与 calculateBalance 口径分裂（前者 SQL ROUND(x,2) 且不过滤 reversed_id、
// 不排除虚拟卡；后者逐笔 toCNY 截断 4 位），维持原样（rebuild 后余额与实时口径不一致）。
// from: service/settlement.js:66-91
func getAllBalances(userID string) ([]map[string]any, error) {
	query := `
      SELECT card_id,
             SUM(CASE WHEN direction = 1 THEN 
               CASE WHEN currency = 'CNY' THEN amount 
               ELSE ROUND(amount * exchange_rate / 100, 2) END 
             ELSE 0 END) as income,
             SUM(CASE WHEN direction = 0 THEN 
               CASE WHEN currency = 'CNY' THEN amount 
               ELSE ROUND(amount * exchange_rate / 100, 2) END 
             ELSE 0 END) as expense,
             COUNT(*) as total_count
      FROM account
      WHERE user_id = ? AND is_deleted = 0 AND card_id IS NOT NULL
      GROUP BY card_id
    `
	rows, err := queryRows(db.DB(), query, userID)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, map[string]any{
			"card_id":     toStr(row["card_id"]),
			"income":      toF(row["income"]),
			"expense":     toF(row["expense"]),
			"balance":     toF(row["income"]) - toF(row["expense"]),
			"total_count": toF(row["total_count"]),
		})
	}
	return out, nil
}

// AccountSettlementValidate 验证交易。
//   - 信用卡（credit）：验证额度不能超限（CreditCore.aggregate 权威口径）
//   - 虚拟账户（xxxx=现金，yyyy=余额）：需要验证余额
//   - 储蓄卡（debit）：需要验证余额
//
// rec 支持的键（对应 Node record）：card_id / user_id / direction / amount /
// exchange_rate / currency / excludeAmountCNY（可选）。
// 返回 (valid, message, result)，result 含 valid/message/currentBalance。
// from: service/settlement.js:99-226
func AccountSettlementValidate(ex db.Commiter, rec map[string]any) (bool, string, map[string]any) {
	cardID := toStr(rec["card_id"])
	userID := toStr(rec["user_id"])
	direction := toF(rec["direction"])
	amountNum := toF(rec["amount"])
	currency := toStr(rec["currency"])
	exchangeRate := rec["exchange_rate"]
	excludeAmountCNY := toF(rec["excludeAmountCNY"])

	// 转换后的金额（人民币）
	amountInCNY := cur.ToCNY(amountNum, currency, toF(exchangeRate))

	// 虚拟账户（xxxx=现金，yyyy=余额）
	if cardID == "xxxx" || cardID == "yyyy" {
		balanceInfo, err := CalculateBalance(ex, cardID, userID)
		if err != nil {
			return false, err.Error(), nil
		}
		currentBalance := toF(balanceInfo["balance"])

		// 收入总是允许
		if direction == 1 {
			return true, "收入允许", map[string]any{"valid": true, "message": "收入允许", "currentBalance": currentBalance}
		}
		// 无收支记录不能支出
		if toF(balanceInfo["totalCount"]) == 0 {
			return false, "该账户尚无收支记录，请先登记一笔收入", map[string]any{"valid": false, "message": "该账户尚无收支记录，请先登记一笔收入", "currentBalance": currentBalance}
		}
		// 余额不足不能支出
		if currentBalance < amountInCNY {
			msg := "余额不足，当前 " + jsNumString(currentBalance) + "，需要 " + jsNumString(amountInCNY)
			return false, msg, map[string]any{"valid": false, "message": msg, "currentBalance": currentBalance}
		}
		return true, "验证通过", map[string]any{"valid": true, "message": "验证通过", "currentBalance": currentBalance}
	}

	// 查询实体卡片类型（P2-10：使用事务连接，保证锁内读到己写入/最新状态）
	// 🔒 2026-10-13（api.md P2-5）：补 user_id 归属校验，
	//    原实现不带 user_id ⇒ 信用卡分支聚合未命中时兜底读他人卡的静态额度。
	cardRows, err := queryRows(ex,
		"SELECT card_type, credit_limit, temp_limit FROM card_base WHERE id = ? AND user_id = ? AND is_deleted = 0",
		cardID, userID)
	if err != nil {
		return false, err.Error(), nil
	}
	// 🔒 2026-10-13（api.md P2-5）：实体卡不存在/不属本人 ⇒ 直接拒绝（含收入方向）。
	//    原实现查不到时静默走储蓄卡分支，收入方向又总是放行 ⇒ 假卡ID可建收入。
	if len(cardRows) == 0 {
		return false, "卡片不存在或无权访问", map[string]any{"valid": false, "message": "卡片不存在或无权访问"}
	}
	var cardType string
	creditLimit, tempLimit := 0.0, 0.0
	if len(cardRows) > 0 {
		cardType = toStr(cardRows[0]["card_type"])
		creditLimit = toF(cardRows[0]["credit_limit"])
		tempLimit = toF(cardRows[0]["temp_limit"])
	}

	// 信用卡：验证额度不能超限（使用权威口径 CreditCore.aggregate，支持共享池/外币登记）
	if cardType == "credit" {
		// P2-10：传入 executor（事务连接），锁内校验读到一致账本
		agg, err := creditcore.Aggregate(ex, userID)
		if err != nil {
			return false, err.Error(), nil
		}
		list := toAnySlice(agg["cards"])
		// 从聚合结果中找到本卡归属的分组（独立卡 / 共享池）
		var group map[string]any
		for _, g := range list {
			gm := toMap(g)
			if !toBool(gm["shared"]) && toStr(gm["cardId"]) == cardID {
				group = gm
				break
			}
		}
		if group == nil {
			for _, g := range list {
				gm := toMap(g)
				if toBool(gm["shared"]) && cardsContain(gm["cards"], cardID) {
					group = gm
					break
				}
			}
		}

		// 兜底：若聚合未命中（极端异常），回退到 card_base 静态额度，避免误拦截
		var totalLimit, availLimit float64
		if group != nil {
			totalLimit = toF(group["creditLimit"]) + toF(group["tempLimit"])
			availLimit = toF(group["avail"])
		} else {
			totalLimit = creditLimit + tempLimit
			availLimit = totalLimit
		}

		// 收入（还款）总是允许
		if direction == 1 {
			return true, "信用卡还款允许", map[string]any{"valid": true, "message": "信用卡还款允许", "currentBalance": availLimit}
		}

		// C4：usedLimitAfter = 当前负债(含原流水) − 原流水折算(同卡修改时) + 新金额折算
		usedLimitAfter := totalLimit - availLimit + amountInCNY - excludeAmountCNY

		// 检查是否超额度
		if usedLimitAfter > totalLimit+1e-9 {
			msg := "登记失败！超过信用卡额度！可用 ¥" + jsToFixed2(availLimit) + "，本次 ¥" + jsToFixed2(amountInCNY)
			return false, msg, map[string]any{"valid": false, "message": msg, "currentBalance": availLimit}
		}
		return true, "验证通过", map[string]any{"valid": true, "message": "验证通过", "currentBalance": availLimit}
	}

	// 储蓄卡
	balanceInfo, err := CalculateBalance(ex, cardID, userID)
	if err != nil {
		return false, err.Error(), nil
	}
	currentBalance := toF(balanceInfo["balance"])

	// 收入总是允许
	if direction == 1 {
		return true, "收入允许", map[string]any{"valid": true, "message": "收入允许", "currentBalance": currentBalance}
	}

	// 储蓄卡：必须有收支记录才能支出
	if toF(balanceInfo["totalCount"]) == 0 {
		return false, "余额不足！", map[string]any{"valid": false, "message": "余额不足！", "currentBalance": currentBalance}
	}

	// 储蓄卡：余额不足不能支出
	if currentBalance < amountInCNY {
		msg := "余额不足，当前 " + jsNumString(currentBalance) + "，需要 " + jsNumString(amountInCNY)
		return false, msg, map[string]any{"valid": false, "message": msg, "currentBalance": currentBalance}
	}

	return true, "验证通过", map[string]any{"valid": true, "message": "验证通过", "currentBalance": currentBalance}
}

// SyncBalanceSnapshot 同步余额快照。
// 跳过信用卡类型（信用卡使用 card_bill 而非 account_balance 记录余额），返回 nil。
// from: service/settlement.js:232-259
func SyncBalanceSnapshot(ex db.Commiter, cardID, userID string) (map[string]any, error) {
	// 检查是否为信用卡，信用卡不写入 account_balance
	cardRows, err := queryRows(ex,
		"SELECT card_type FROM card_base WHERE id = ? AND is_deleted = 0",
		cardID)
	if err != nil {
		return nil, err
	}
	if len(cardRows) > 0 && toStr(cardRows[0]["card_type"]) == "credit" {
		return nil, nil
	}

	balanceInfo, err := CalculateBalance(ex, cardID, userID)
	if err != nil {
		return nil, err
	}
	now := tim.NowMS()
	id := idgen.BillID()

	// 使用 INSERT ... ON DUPLICATE KEY UPDATE 防止重复
	_, err = ex.Exec(
		`INSERT INTO account_balance (id, user_id, card_id, balance, update_time, is_deleted) 
       VALUES (?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         balance = VALUES(balance),
         update_time = VALUES(update_time),
         is_deleted = 0`,
		id, userID, cardID, toF(balanceInfo["balance"]), now)
	if err != nil {
		return nil, err
	}

	// Node 此处走全局连接读快照（getBalanceSnapshot 无 executor 参数），保持一致
	return getBalanceSnapshot(cardID, userID)
}

// InitCardBalance 初始化卡片余额（card 模块将调用：Node card/controller/index.js:64）。
// from: service/settlement.js:264-270
func InitCardBalance(cardID, userID string) (map[string]any, error) {
	existing, err := getBalanceSnapshot(cardID, userID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		if _, err := SyncBalanceSnapshot(db.DB(), cardID, userID); err != nil {
			return nil, err
		}
	}
	return getBalanceSnapshot(cardID, userID)
}

// rebuildAllBalances 重建所有余额。
// from: service/settlement.js:275-281
func rebuildAllBalances(userID string) ([]map[string]any, error) {
	balances, err := getAllBalances(userID)
	if err != nil {
		return nil, err
	}
	for _, item := range balances {
		if _, err := SyncBalanceSnapshot(db.DB(), toStr(item["card_id"]), userID); err != nil {
			return nil, err
		}
	}
	return balances, nil
}

// ===== 聚合结构解析助手（CreditCore.aggregate 结果）=====

// toAnySlice 把 []any / []map[string]any 统一为 []any。
func toAnySlice(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case []map[string]any:
		out := make([]any, 0, len(t))
		for _, m := range t {
			out = append(out, m)
		}
		return out
	}
	return nil
}

func toMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// cardsContain 判断共享池分组 cards 数组是否包含目标 cardId。
func cardsContain(v any, cardID string) bool {
	for _, c := range toAnySlice(v) {
		if toStr(toMap(c)["cardId"]) == cardID {
			return true
		}
	}
	return false
}

// toBool 宽松布尔（JS 真值语义：对象/非零数为 true）。
func toBool(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != "" && t != "false" && t != "0"
	case float64:
		return t != 0
	case int64:
		return t != 0
	}
	return true
}
