package account

import (
	"net/http"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

// ============================================================================
// 账户余额控制器 —— from: controller/balanceController.js
//   - 虚拟账户：xxxx（现金）、yyyy（余额）
//   - 实体卡片：card_base 表中的储蓄卡（debit）
//   - 余额统一换算成人民币
// ============================================================================

// virtualTypes 虚拟账户类型（无卡号实体账户）。
// 注意：Node VIRTUAL_TYPES = {CASH:'xxxx', WX:'yyyy', ALIPAY:'yyyy'}，ALIPAY 与 WX 同为 yyyy
// （ensureVirtualAccounts 会对 yyyy 处理两次，第二次命中已存在跳过），保持原语义。
var virtualTypes = []struct{ typ, cardID string }{
	{"CASH", "xxxx"},   // 现金
	{"WX", "yyyy"},     // 微信/支付宝（余额）
	{"ALIPAY", "yyyy"}, // 支付宝
}

// virtualNames 虚拟账户显示名称。
var virtualNames = map[string]struct{ name, alias string }{
	"xxxx": {"现金", "现金账户"},
	"yyyy": {"余额", "余额账户（微信/支付宝）"},
}

// BalanceGetList 获取所有账户余额列表。
// 自动初始化未登记的卡片账户和虚拟账户；自动校验卡片和流水是否正常。
// from: controller/balanceController.js:31-57
func BalanceGetList(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)

	// 0. 动态校验：清理无效卡片，重新计算余额
	if err := verifyAndSync(uid); err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	// 1. 初始化虚拟账户（现金 + 余额）
	if err := ensureVirtualAccounts(uid); err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	// 2. 初始化储蓄卡
	if err := initAllCardBalances(uid); err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	// 3. 获取余额快照列表
	balances, err := getSnapshotList(uid)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}

	if len(balances) == 0 {
		resp.JSON(w, 200, map[string]any{
			"status": 200, "message": "暂无余额记录", "data": []map[string]any{},
		})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": balances})
}

// getSnapshotList 获取余额快照列表。
// from: controller/balanceController.js:62-93
func getSnapshotList(userID string) ([]map[string]any, error) {
	query := `
      SELECT ab.*,
             cb.alias as card_alias,
             cb.last4_no as card_last4,
             cb.card_type
      FROM account_balance ab
      LEFT JOIN card_base cb ON ab.card_id = cb.id
      WHERE ab.user_id = ? AND ab.is_deleted = 0
      ORDER BY 
        CASE WHEN ab.card_id IN ('xxxx', 'yyyy') THEN 0 ELSE 1 END,
        COALESCE(cb.is_default, 0) DESC,
        COALESCE(cb.sort, 99) ASC,
        ab.card_id
    `
	rows, err := queryRows(db.DB(), query, userID)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		m := make(map[string]any, len(row)+2)
		for k, v := range row {
			m[k] = v
		}
		// 虚拟账户（xxxx=现金，yyyy=余额）
		if vn, ok := virtualNames[toStr(row["card_id"])]; ok {
			m["alias"] = vn.alias
			if vn.alias == "" {
				m["alias"] = toStr(row["card_id"])
			}
			m["card_type"] = "virtual"
		} else {
			m["alias"] = orStr(toStr(row["card_alias"]), toStr(row["card_id"]))
		}
		out = append(out, m)
	}
	return out, nil
}

// ensureVirtualAccounts 确保虚拟账户已初始化。
// xxxx = 现金，yyyy = 余额（微信/支付宝）。
// from: controller/balanceController.js:99-107
func ensureVirtualAccounts(userID string) error {
	for _, vt := range virtualTypes {
		existing, err := getBalanceSnapshot(vt.cardID, userID)
		if err != nil {
			return err
		}
		if existing == nil {
			balanceInfo, err := CalculateBalance(db.DB(), vt.cardID, userID)
			if err != nil {
				return err
			}
			if err := createSnapshot(vt.cardID, userID, toF(balanceInfo["balance"])); err != nil {
				return err
			}
		}
	}
	return nil
}

// verifyAndSync 动态校验并同步余额。
// 1. 清理已删除的卡片关联的余额记录；2. 重新计算所有余额。
// from: controller/balanceController.js:114-168
func verifyAndSync(userID string) error {
	now := tim.NowMS()

	// 1. 软删除 account_balance 中已失效的卡片记录（卡片已删除或不是储蓄卡）
	balances, err := queryRows(db.DB(), `
      SELECT DISTINCT ab.card_id, ab.id
      FROM account_balance ab
      WHERE ab.user_id = ? AND ab.is_deleted = 0
        AND ab.card_id NOT IN ('xxxx', 'yyyy')
    `, userID)
	if err != nil {
		return err
	}
	for _, item := range balances {
		// 检查卡片是否还存在且是储蓄卡
		cardRows, err := queryRows(db.DB(),
			"SELECT id FROM card_base WHERE id = ? AND user_id = ? AND card_type = ? AND is_deleted = 0",
			toStr(item["card_id"]), userID, "debit")
		if err != nil {
			return err
		}
		if len(cardRows) == 0 {
			if _, err := execAffected(db.DB(),
				"UPDATE account_balance SET is_deleted = 1, update_time = ? WHERE id = ?",
				now, toStr(item["id"])); err != nil {
				return err
			}
		}
	}

	// 2. 重新计算并同步所有有效卡片的余额
	validBalances, err := queryRows(db.DB(), `
      SELECT DISTINCT card_id
      FROM account_balance
      WHERE user_id = ? AND is_deleted = 0 AND card_id NOT IN ('xxxx', 'yyyy')
    `, userID)
	if err != nil {
		return err
	}
	for _, item := range validBalances {
		balanceInfo, err := CalculateBalance(db.DB(), toStr(item["card_id"]), userID)
		if err != nil {
			return err
		}
		if _, err := execAffected(db.DB(),
			"UPDATE account_balance SET balance = ?, update_time = ? WHERE card_id = ? AND user_id = ?",
			toF(balanceInfo["balance"]), now, toStr(item["card_id"]), userID); err != nil {
			return err
		}
	}

	// 3. 同步虚拟账户余额
	for _, vt := range virtualTypes {
		balanceInfo, err := CalculateBalance(db.DB(), vt.cardID, userID)
		if err != nil {
			return err
		}
		if _, err := execAffected(db.DB(),
			"UPDATE account_balance SET balance = ?, update_time = ? WHERE card_id = ? AND user_id = ?",
			toF(balanceInfo["balance"]), now, vt.cardID, userID); err != nil {
			return err
		}
	}
	return nil
}

// initAllCardBalances 初始化所有储蓄卡账户的余额。
// from: controller/balanceController.js:173-187
func initAllCardBalances(userID string) error {
	query := `
      SELECT id FROM card_base 
      WHERE user_id = ? AND card_type = 'debit' AND is_deleted = 0
    `
	cards, err := queryRows(db.DB(), query, userID)
	if err != nil {
		return err
	}
	for _, card := range cards {
		existing, err := getBalanceSnapshot(toStr(card["id"]), userID)
		if err != nil {
			return err
		}
		if existing == nil {
			balanceInfo, err := CalculateBalance(db.DB(), toStr(card["id"]), userID)
			if err != nil {
				return err
			}
			if err := createSnapshot(toStr(card["id"]), userID, toF(balanceInfo["balance"])); err != nil {
				return err
			}
		}
	}
	return nil
}

// createSnapshot 创建余额快照（使用 ON DUPLICATE KEY UPDATE 防止重复）。
// from: controller/balanceController.js:192-203
func createSnapshot(cardID, userID string, balance float64) error {
	id := idgen.BillID()
	now := tim.NowMS()
	query := `
      INSERT INTO account_balance (id, user_id, card_id, balance, update_time, is_deleted)
      VALUES (?, ?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        balance = VALUES(balance),
        update_time = VALUES(update_time)
    `
	_, err := execAffected(db.DB(), query, id, userID, cardID, balance, now)
	return err
}

// BalanceGetByCardId 获取单张卡/账户余额。
// keep BUG-023：对任意不存在 cardId 建余额行（无 card_base 存在性校验），维持原样。
// from: controller/balanceController.js:208-224
func BalanceGetByCardId(w http.ResponseWriter, r *http.Request) {
	cardID := r.PathValue("cardId")
	if cardID == "" {
		resp.Say(w, "卡片ID不能为空", 400)
		return
	}
	uid := resp.UID(r)
	balance, err := getBalanceSnapshot(cardID, uid)
	if err != nil {
		resp.Say(w, "获取失败", 500)
		return
	}
	if balance == nil {
		balanceInfo, err := CalculateBalance(db.DB(), cardID, uid)
		if err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
		if err := createSnapshot(cardID, uid, toF(balanceInfo["balance"])); err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
		balance, err = getBalanceSnapshot(cardID, uid)
		if err != nil {
			resp.Say(w, "获取失败", 500)
			return
		}
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "获取成功", "data": balance})
}

// InitVirtual 初始化所有账户。
// from: controller/balanceController.js:229-239
func InitVirtual(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	if err := ensureVirtualAccounts(uid); err != nil {
		resp.Say(w, "初始化失败", 500)
		return
	}
	if err := initAllCardBalances(uid); err != nil {
		resp.Say(w, "初始化失败", 500)
		return
	}
	balances, err := getSnapshotList(uid)
	if err != nil {
		resp.Say(w, "初始化失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "初始化成功", "data": balances})
}

// Rebuild 重建所有账户余额（从收支表重新计算）。
// from: controller/balanceController.js:244-272
func Rebuild(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)

	// 重建虚拟账户
	if err := ensureVirtualAccounts(uid); err != nil {
		resp.Say(w, "重建失败", 500)
		return
	}
	// 重建储蓄卡
	if err := initAllCardBalances(uid); err != nil {
		resp.Say(w, "重建失败", 500)
		return
	}

	// 从收支表重建余额
	allBalances, err := getAllBalances(uid)
	if err != nil {
		resp.Say(w, "重建失败", 500)
		return
	}
	for _, item := range allBalances {
		existing, err := getBalanceSnapshot(toStr(item["card_id"]), uid)
		if err != nil {
			resp.Say(w, "重建失败", 500)
			return
		}
		if existing != nil {
			if _, err := execAffected(db.DB(),
				"UPDATE account_balance SET balance = ?, update_time = ? WHERE card_id = ? AND user_id = ?",
				toF(item["balance"]), tim.NowMS(), toStr(item["card_id"]), uid); err != nil {
				resp.Say(w, "重建失败", 500)
				return
			}
		} else {
			if err := createSnapshot(toStr(item["card_id"]), uid, toF(item["balance"])); err != nil {
				resp.Say(w, "重建失败", 500)
				return
			}
		}
	}

	result, err := getSnapshotList(uid)
	if err != nil {
		resp.Say(w, "重建失败", 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "重建成功", "data": result})
}
