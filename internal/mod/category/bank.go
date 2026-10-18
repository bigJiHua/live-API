package category

import (
	"errors"
	"strings"

	"live/api/internal/db"
	"live/api/internal/idgen"

	"github.com/go-sql-driver/mysql"
)

// ============================================================================
// 银行分类模型 - 对应数据库 bus_category 表 (type='bank') —— from: model/bank.js
// 用于管理用户的银行卡片分类（储蓄卡/信用卡的归属银行）
// ============================================================================

// virtualBanks 对应 BusBank.VIRTUAL_BANKS（系统内置，不可删除）。
// [CASH]xxxx=现金、[BALANCE]yyyy=余额；顺序即 Node Object.entries 顺序。
var virtualBanks = []struct{ key, id string }{
	{"CASH", "xxxx"},
	{"BALANCE", "yyyy"},
}

// virtualBankInfo 对应 BusBank.VIRTUAL_NAMES。
var virtualBankInfo = map[string]struct{ name, iconURL, remark string }{
	"xxxx": {name: "现金", iconURL: "", remark: "系统虚拟账户"},
	"yyyy": {name: "余额", iconURL: "", remark: "系统虚拟账户（微信+支付宝）"},
}

// defaultBanks 对应 BusBank.DEFAULT_BANKS（首次使用时自动初始化）。
var defaultBanks = []struct{ name, remark string }{
	{"中国银行", "BOC"},
	{"中国农业银行", "ABC"},
	{"中国工商银行", "ICBC"},
	{"中国建设银行", "CCB"},
	{"中国邮政储蓄银行", "PSBC"},
	{"交通银行", "BOCOM"},
}

// FindAllBanks 对应 BusBank.findAll(userId)：
// 自动初始化虚拟银行和默认银行分类（如果不存在）。
// keep BUG-057：initDefaultBanks 在查询前执行——用户删光真实银行后每次 GET 复活 6 家默认银行，维持原样。
// from: bank.js:37-49
func FindAllBanks(userID string) ([]map[string]any, error) {
	// 确保虚拟银行分类和默认银行已初始化
	if _, err := InitVirtualBanks(userID); err != nil {
		return nil, err
	}
	if err := InitDefaultBanks(userID); err != nil {
		return nil, err
	}

	query := `
      SELECT * FROM bus_category
      WHERE user_id = ? AND type = 'bank' AND is_deleted = 0
      ORDER BY sort ASC, name ASC
    `
	return qRows(db.DB(), query, userID)
}

// FindBankById 对应 BusBank.findById(id, userId)。
// from: bank.js:54-58
func FindBankById(id, userID string) (map[string]any, error) {
	return qRow(db.DB(),
		"SELECT * FROM bus_category WHERE id = ? AND user_id = ? AND type = 'bank' AND is_deleted = 0",
		id, userID)
}

// BankCreateParams 对应 Node create({userId, name, iconUrl, remark, sort})。
// SortSet 对应 `sort !== undefined`（未传时取同银行 maxSort + 1）。
type BankCreateParams struct {
	UserID  string
	Name    string
	IconURL any
	Remark  any
	Sort    any
	SortSet bool
}

// CreateBank 对应 BusBank.create（获取最大排序值；显式 sort 优先）。
// from: bank.js:63-81
func CreateBank(p BankCreateParams) (map[string]any, error) {
	id := idgen.BillID()

	// 获取最大排序值
	row, err := qRow(db.DB(),
		`SELECT COALESCE(MAX(sort), 0) as maxSort FROM bus_category WHERE user_id = ? AND type = 'bank' AND is_deleted = 0`,
		p.UserID)
	if err != nil {
		return nil, err
	}
	maxSort := toI(row["maxSort"]) // Node parseInt(sortRows[0]?.maxSort || 0)
	var finalSort any = maxSort + 1
	if p.SortSet {
		finalSort = sqlVal(p.Sort)
	}

	query := `
      INSERT INTO bus_category (id, user_id, name, type, icon_url, remark, sort, is_deleted)
      VALUES (?, ?, ?, 'bank', ?, ?, ?, 0)
    `
	if _, err := db.DB().Exec(query, []any{
		id, p.UserID, p.Name,
		toStr(p.IconURL), // Node iconUrl || ''
		toStr(p.Remark),  // Node remark || ''
		finalSort,
	}...); err != nil {
		return nil, err
	}
	return FindBankById(id, p.UserID)
}

// UpdateBank 对应 BusBank.update(id, userId, {name, iconUrl, remark, sort})。
// from: bank.js:86-120
func UpdateBank(id, userID string, name, iconURL, remark, sort any, nameSet, iconURLSet, remarkSet, sortSet bool) (map[string]any, error) {
	var fields []string
	var params []any
	if nameSet {
		fields = append(fields, "name = ?")
		params = append(params, sqlVal(name))
	}
	if iconURLSet {
		fields = append(fields, "icon_url = ?")
		params = append(params, sqlVal(iconURL))
	}
	if remarkSet {
		fields = append(fields, "remark = ?")
		params = append(params, sqlVal(remark))
	}
	if sortSet {
		fields = append(fields, "sort = ?")
		params = append(params, sqlVal(sort))
	}
	if len(fields) == 0 {
		return FindBankById(id, userID)
	}
	params = append(params, id, userID)
	query := `
      UPDATE bus_category
      SET ` + strings.Join(fields, ", ") + `
      WHERE id = ? AND user_id = ? AND type = 'bank' AND is_deleted = 0
    `
	if _, err := db.DB().Exec(query, params...); err != nil {
		return nil, err
	}
	return FindBankById(id, userID)
}

// DeleteBank 对应 BusBank.delete(id, userId)（软删除）。
// keep BUG-056：删除不校验被引用（无引用检查，软删后流水/卡片展示断链），维持原样。
// from: bank.js:125-138
func DeleteBank(id, userID string) (bool, error) {
	// 禁止删除虚拟银行分类
	for _, vb := range virtualBanks {
		if vb.id == id {
			return false, errText("系统虚拟银行分类无法删除")
		}
	}

	res, err := db.DB().Exec(
		"UPDATE bus_category SET is_deleted = 1 WHERE id = ? AND user_id = ? AND type = 'bank'",
		id, userID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// InitVirtualBanks 对应 BusBank.initVirtualBanks(userId)：
// 初始化虚拟银行分类（系统内置）xxxx=现金、yyyy=余额，插入 bus_category type='bank'。
// fix BUG-032：存在性 SELECT 补 is_deleted = 0（Node 原为 `WHERE id = ? AND user_id = ? AND type = ?`
// 无 is_deleted，虚拟银行被软删后永不恢复）；软删占位导致 INSERT 撞主键(1062) 时恢复该行。
// from: bank.js:145-184
func InitVirtualBanks(userID string) ([]map[string]any, error) {
	results := []map[string]any{}

	for _, vb := range virtualBanks {
		bankID := vb.id
		// 检查是否已存在（fix BUG-032：补 is_deleted = 0）
		existing, err := qRow(db.DB(),
			"SELECT id FROM bus_category WHERE id = ? AND user_id = ? AND type = ? AND is_deleted = 0",
			bankID, userID, "bank")
		if err != nil {
			return nil, err
		}

		if existing == nil {
			// 创建虚拟银行分类
			info := virtualBankInfo[bankID]
			query := `
          INSERT INTO bus_category (id, user_id, name, type, icon_url, remark, sort, is_deleted)
          VALUES (?, ?, ?, 'bank', ?, ?, ?, 0)
        `
			// sort=0 表示系统内置
			if _, err := db.DB().Exec(query, []any{
				bankID, userID, info.name, info.iconURL, info.remark, 0,
			}...); err != nil {
				// fix BUG-032 续：1062 = 软删虚拟银行占位 → 恢复（is_deleted = 0）
				if isDupEntryErr(err) {
					if _, uerr := db.DB().Exec(
						"UPDATE bus_category SET is_deleted = 0 WHERE id = ? AND user_id = ? AND type = 'bank'",
						bankID, userID); uerr != nil {
						return nil, uerr
					}
				} else {
					return nil, err
				}
			}
		}

		// 获取并返回虚拟银行信息（Node 原 SQL 不带 is_deleted，维持原样）
		row, err := qRow(db.DB(),
			"SELECT * FROM bus_category WHERE id = ? AND user_id = ? AND type = ?",
			bankID, userID, "bank")
		if err != nil {
			return nil, err
		}
		if row != nil {
			results = append(results, row)
		}
	}
	return results, nil
}

// InitDefaultBanks 对应 BusBank.initDefaultBanks(userId)：首次获取银行列表时自动插入 6 家默认银行。
// keep BUG-057：用户删光真实银行后每次调用都会重新初始化（"删除"被静默复活），维持原样。
// from: bank.js:190-222
func InitDefaultBanks(userID string) error {
	// 检查用户是否已有非虚拟的银行分类
	row, err := qRow(db.DB(),
		`SELECT COUNT(*) as count FROM bus_category
       WHERE user_id = ? AND type = 'bank' AND is_deleted = 0
       AND id NOT IN ('xxxx', 'yyyy')`,
		userID)
	if err != nil {
		return err
	}

	// 已有银行分类则不重复初始化
	if toI(row["count"]) > 0 {
		return nil
	}

	for _, bank := range defaultBanks {
		// 检查是否已存在同名银行
		dup, err := qRow(db.DB(),
			`SELECT id FROM bus_category
         WHERE user_id = ? AND type = 'bank' AND name = ? AND is_deleted = 0`,
			userID, bank.name)
		if err != nil {
			return err
		}
		if dup != nil {
			continue
		}

		if _, err := CreateBank(BankCreateParams{
			UserID: userID,
			Name:   bank.name,
			Remark: bank.remark,
		}); err != nil {
			return err
		}
	}
	return nil
}

// ===== 本文件助手 =====

// isDupEntryErr 判断 ER_DUP_ENTRY(1062)（对应 Node error.code === 'ER_DUP_ENTRY'）。
func isDupEntryErr(err error) bool {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		return myErr.Number == 1062
	}
	return false
}
