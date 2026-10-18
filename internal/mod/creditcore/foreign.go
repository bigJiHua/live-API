// Package creditcore 的 foreign.go 复刻 src/modules/card/model/foreignRegister.js
// （外币消费登记/对账模型 / card_foreign_register 表）。SQL 逐字一致（? 占位）。
// 汇率口径：每 100 外币等值人民币（toCNY = amount*rate/100）。
package creditcore

import (
	"errors"
	"math"
	"strings"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// foreignTable 对应 foreignRegister.js TABLE = "card_foreign_register"。
const foreignTable = "card_foreign_register"

// nowStr 对应 ForeignRegister.nowStr()：本地 YYYY-MM-DD HH:mm:ss。
func nowStr() string { return tim.FmtDateTime(tim.Now()) }

// EnsurePendingRegister 对应 ForeignRegister.ensurePending：
// 消费流水创建时自动登记一条 pending（幂等：account_id 唯一，已存在则同步金额/汇率/卡片）。
// amount 对应 foreignAmount（Node Number(foreignAmount || 0)），rate 对应 registeredRate。
func EnsurePendingRegister(ex db.Commiter, userID, cardID, accountID, currency string, amount, rate float64) (string, error) {
	// C7：查询不限定 is_deleted——uk_account_id 唯一键对软删行也生效，命中任意行（含软删）一律 UPDATE 恢复。
	exist, err := qRow(ex,
		"SELECT id FROM "+foreignTable+" WHERE account_id = ? AND user_id = ? LIMIT 1",
		accountID, userID)
	if err != nil {
		return "", err
	}
	now := nowStr()
	regRate := rate // Number(registeredRate || 0)
	regRmb := cur.ToCNY(amount, currency, regRate)
	if exist != nil {
		// H4：流水金额/币种/汇率/卡片变更时，同步更新已存在的登记
		if _, err := ex.Exec(
			"UPDATE "+foreignTable+" SET\n           is_deleted = 0, status = 'pending',\n           card_id = ?, currency = ?, foreign_amount = ?, registered_rate = ?, registered_rmb = ?, update_time = ?\n         WHERE id = ?",
			cardID, currency, amount, regRate, regRmb, now, exist["id"]); err != nil {
			return "", err
		}
		return toStr(exist["id"]), nil
	}
	id := idgen.ShortID()
	if _, err := ex.Exec(
		"INSERT INTO "+foreignTable+"\n       (id, user_id, card_id, account_id, currency, foreign_amount, registered_rate, registered_rmb, status, create_time, update_time, is_deleted)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)",
		id, userID, cardID, accountID, currency,
		amount, regRate, regRmb, now, now); err != nil {
		return "", err
	}
	return id, nil
}

// Reconcile 对应 ForeignRegister.reconcile：录入银行 App 实际结算汇率 / 人民币（或修改）。
// P1-5 审计：实际汇率必须 > 0；传入的人民币金额也必须 > 0。
// 注意：actualRmb 传 0 表示未提供（Node 为 undefined/null/”，无法在 float64 签名中区分），
// 此时按 foreign_amount * rate / 100 反算；显式 0 在 Node 侧会报错，Go 端按未提供处理。
func Reconcile(ex db.Commiter, id, userID string, actualRate, actualRmb float64, settleDate, remark string) (map[string]any, error) {
	rate := actualRate
	if math.IsNaN(rate) || math.IsInf(rate, 0) || rate <= 0 {
		return nil, errors.New("实际汇率必须大于 0")
	}
	if actualRmb != 0 && (math.IsNaN(actualRmb) || math.IsInf(actualRmb, 0) || actualRmb <= 0) {
		return nil, errors.New("实际人民币金额必须大于 0")
	}
	row, err := qRow(ex,
		"SELECT foreign_amount, currency FROM "+foreignTable+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errors.New("外币登记记录不存在")
	}
	// actualRmb 优先用传入；未传则按 foreign_amount * rate / 100 反算
	var rmb float64
	if actualRmb != 0 {
		rmb = actualRmb
	} else {
		rmb = cur.ToCNY(toF(row["foreign_amount"]), toStr(row["currency"]), rate)
	}
	// 结算日期：以「点击确认对账受理那一刻」为结算日；显式传了日期则优先用传入值（兼容历史调用）。
	settleDateValue := strings.TrimSpace(settleDate)
	if settleDateValue == "" {
		settleDateValue = nowStr()[:10]
	}
	var remarkArg any // remark || null
	if remark != "" {
		remarkArg = remark
	}
	if _, err := ex.Exec(
		"UPDATE "+foreignTable+"\n       SET actual_rate = ?, actual_rmb = ?, settle_date = ?, status = 'reconciled',\n           remark = COALESCE(?, remark), update_time = ?\n       WHERE id = ? AND user_id = ? AND is_deleted = 0",
		rate, rmb, settleDateValue, remarkArg, nowStr(), id, userID); err != nil {
		return nil, err
	}
	return FindById(ex, id, userID)
}

// FindById 对应 ForeignRegister.findById。
func FindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	return qRow(ex,
		"SELECT * FROM "+foreignTable+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// FindByAccountId 对应 ForeignRegister.findByAccountId。
func FindByAccountId(ex db.Commiter, accountID, userID string) (map[string]any, error) {
	return qRow(ex,
		"SELECT * FROM "+foreignTable+" WHERE account_id = ? AND user_id = ? AND is_deleted = 0 LIMIT 1",
		accountID, userID)
}

// FindPendingByCard 对应 ForeignRegister.findPendingByCard。
func FindPendingByCard(ex db.Commiter, cardID, userID string) ([]map[string]any, error) {
	return qRows(ex,
		"SELECT * FROM "+foreignTable+" WHERE card_id = ? AND user_id = ? AND status = 'pending' AND is_deleted = 0 ORDER BY create_time DESC",
		cardID, userID)
}

// FindPendingByUser 对应 ForeignRegister.findPendingByUser（用户维度全部待对账）。
func FindPendingByUser(ex db.Commiter, userID string) ([]map[string]any, error) {
	return qRows(ex,
		"SELECT * FROM "+foreignTable+" WHERE user_id = ? AND status = 'pending' AND is_deleted = 0 ORDER BY create_time DESC",
		userID)
}

// FindAllByUser 对应 ForeignRegister.findAllByUser（含已对账）。
func FindAllByUser(ex db.Commiter, userID string) ([]map[string]any, error) {
	return qRows(ex,
		"SELECT * FROM "+foreignTable+" WHERE user_id = ? AND is_deleted = 0 ORDER BY create_time DESC",
		userID)
}

// FindForeignExpenseHistory 对应 ForeignRegister.findForeignExpenseHistory：
// 从 account 账本扫描该用户全部信用卡外币消费，支持按卡与交易时间范围过滤。
// 空字符串过滤参数对应 Node 的 undefined（不追加条件）。
func FindForeignExpenseHistory(ex db.Commiter, userID, cardID, startDate, endDate string) ([]map[string]any, error) {
	where := []string{
		"a.user_id = ?",
		"a.is_deleted = 0",
		"a.direction = 0",
		"a.reversed_id IS NULL",
		"a.currency IS NOT NULL AND a.currency != 'CNY'",
		"c.card_type = 'credit'",
		"(a.category_id IS NULL OR a.category_id != ?)",
	}
	params := []any{userID, "CATEGORY_REPAY"}
	if cardID != "" {
		where = append(where, "a.card_id = ?")
		params = append(params, cardID)
	}
	if startDate != "" {
		where = append(where, "a.trans_date >= ?")
		params = append(params, startDate)
	}
	if endDate != "" {
		where = append(where, "a.trans_date <= ?")
		params = append(params, endDate)
	}
	return qRows(ex, `
      SELECT a.id AS account_id, a.card_id, a.currency, a.amount, a.exchange_rate, a.trans_date,
              fr.id AS reg_id, fr.status AS reg_status, fr.registered_rate, fr.registered_rmb,
              fr.actual_rmb, fr.settle_date
       FROM account a
       JOIN card_base c ON a.card_id = c.id AND c.user_id = a.user_id AND c.is_deleted = 0
       LEFT JOIN card_foreign_register fr ON fr.account_id = a.id AND fr.user_id = a.user_id AND fr.is_deleted = 0
       WHERE `+strings.Join(where, " AND ")+`
       ORDER BY a.trans_date DESC, a.create_time DESC`, params...)
}

// DeleteForeignByAccountId 对应 ForeignRegister.deleteByAccountId：
// 冲正/删除流水时连带删除登记（支持事务连接，跟随外层事务回滚）。
func DeleteForeignByAccountId(ex db.Commiter, accountID, userID string) error {
	_, err := ex.Exec(
		"UPDATE "+foreignTable+" SET is_deleted = 1, update_time = ? WHERE account_id = ? AND user_id = ?",
		nowStr(), accountID, userID)
	return err
}

// Delete 对应 ForeignRegister.delete（软删除）。
func Delete(ex db.Commiter, id, userID string) error {
	_, err := ex.Exec(
		"UPDATE "+foreignTable+" SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
		nowStr(), id, userID)
	return err
}
