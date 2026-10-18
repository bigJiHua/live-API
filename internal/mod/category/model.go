// Package category 复刻 src/modules/category：业务分类（bus_category，income/expense/asset/fixed）
// 与银行分类（bus_category type='bank'，model/bank.js）。SQL 逐字一致（? 占位）。
package category

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/idgen"
)

// ===== 行 → map 工具（与 cardbill/creditcore/card 包各自的私有副本，避免共享导出面） =====

// qRow 查询单行并转为 map（列名 → 值）；无记录返回 nil, nil。
func qRow(ex db.Commiter, q string, args ...any) (map[string]any, error) {
	rows, err := ex.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if !rows.Next() {
		return nil, rows.Err()
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	m := make(map[string]any, len(cols))
	for i, c := range cols {
		m[c] = normVal(vals[i])
	}
	return m, rows.Err()
}

// qRows 查询多行并转为 []map。
func qRows(ex db.Commiter, q string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = normVal(vals[i])
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// normVal DB 值 → JSON 友好值：[]byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串；其余原样。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// ===== 通用值转换（对应 JS 松散语义） =====

// toStr 对应 String(v) 常用子集。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

// toF 对应 parseFloat(v) || 0。
func toF(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

// toI 对应 parseInt(v, 10) || 0：截断取整。
func toI(v any) int { return int(toF(v)) }

// jsNum 对应 Number(v)：解析失败/非数字 → NaN（ok=false）。
func jsNum(v any) (float64, bool) {
	switch t := v.(type) {
	case nil:
		return 0, true
	case float64:
		return t, true
	case int64:
		return float64(t), true
	case int:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN(), false
		}
		return f, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, true // Number("") = 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN(), false
		}
		return f, true
	}
	return math.NaN(), false
}

// truthy 对应 JS 真值判断（非空字符串皆真，含 "false"）。
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int64:
		return t != 0
	case int:
		return t != 0
	case []any:
		return true
	case map[string]any:
		return true
	}
	return true
}

// sqlVal SQL 参数规整：json.Number → int64/float64（database/sql 不直接支持 json.Number）。
func sqlVal(v any) any {
	if n, ok := v.(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return i
		}
		if f, err := n.Float64(); err == nil {
			return f
		}
		return n.String()
	}
	return v
}

// errText 构造业务错误（对应 Node `throw new Error(msg)`）。
func errText(msg string) error { return &textError{msg} }

type textError struct{ msg string }

func (e *textError) Error() string { return e.msg }

// ============================================================================
// 分类模型 - 对应数据库 bus_category 表 —— from: model/index.js
// ============================================================================

// categoryTable 对应 Category.tableName = 'bus_category'。
const categoryTable = "bus_category"

// GetMaxSort 对应 Category.getMaxSort：获取某类型分类的最大排序值。
// from: model/index.js:13-21
func GetMaxSort(userID, ctype string) (int, error) {
	row, err := qRow(db.DB(),
		`SELECT MAX(sort) as maxSort 
       FROM bus_category 
       WHERE user_id = ? AND type = ? AND is_deleted = 0`,
		userID, ctype)
	if err != nil {
		return 0, err
	}
	if row == nil || !truthy(row["maxSort"]) {
		return 0, nil // Node `rows[0]?.maxSort || 0`
	}
	return toI(row["maxSort"]), nil
}

// FindAll 对应 Category.findAll(userId, filters={type})。
// from: model/index.js:26-42
func FindAll(userID string, filters map[string]any) ([]map[string]any, error) {
	whereClause := "WHERE user_id = ? AND is_deleted = 0"
	params := []any{userID}
	if v, ok := filters["type"]; ok && truthy(v) {
		whereClause += " AND type = ?"
		params = append(params, toStr(v))
	}
	query := `
      SELECT * FROM bus_category
      ` + whereClause + `
      ORDER BY sort ASC, name ASC
    `
	return qRows(db.DB(), query, params...)
}

// FindById 对应 Category.findById(id, userId)。
// from: model/index.js:47-51
func FindById(id, userID string) (map[string]any, error) {
	return qRow(db.DB(),
		"SELECT * FROM bus_category WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// CategoryCreateParams 对应 Node create({userId, name, type, iconUrl, remark})。
// IconURLSet/RemarkSet 对应 `iconUrl !== undefined`（显式 null 也写入 NULL；undefined 时省略列走 DB 默认值）。
type CategoryCreateParams struct {
	UserID     string
	Name       string
	Type       string
	IconURL    any
	IconURLSet bool
	Remark     any
	RemarkSet  bool
}

// CreateModel 对应 Category.create（自动分配 sort = 同类型 maxSort + 1）。
// from: model/index.js:56-85
// 🔧 2026-10-11 改名：原 Create 与 controller 的同名 handler 冲突（同包不允许）。
func CreateModel(p CategoryCreateParams) (map[string]any, error) {
	id := idgen.BillID()

	// 自动获取该类型分类的最大 sort 值 +1
	maxSort, err := GetMaxSort(p.UserID, p.Type)
	if err != nil {
		return nil, err
	}
	sort := maxSort + 1

	// 构建字段和值，undefined 时让数据库使用默认值
	fields := []string{"id", "user_id", "name", "type", "sort", "is_deleted"}
	values := []any{id, p.UserID, p.Name, p.Type, sort, 0}
	if p.IconURLSet {
		fields = append(fields, "icon_url")
		values = append(values, sqlVal(p.IconURL))
	}
	if p.RemarkSet {
		fields = append(fields, "remark")
		values = append(values, sqlVal(p.Remark))
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(fields)), ", ")
	query := "INSERT INTO bus_category (" + strings.Join(fields, ", ") + ") VALUES (" + placeholders + ")"
	if _, err := db.DB().Exec(query, values...); err != nil {
		return nil, err
	}
	return FindById(id, p.UserID)
}

// UpdateModel 对应 Category.update(id, userId, {name, iconUrl, remark})。
// from: model/index.js:90-120
// 🔧 2026-10-11 改名：原 Update 与 controller 的同名 handler 冲突。
func UpdateModel(id, userID string, name, iconURL, remark any, nameSet, iconURLSet, remarkSet bool) (map[string]any, error) {
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
	if len(fields) == 0 {
		return FindById(id, userID)
	}
	params = append(params, id, userID)
	query := `
      UPDATE bus_category
      SET ` + strings.Join(fields, ", ") + `
      WHERE id = ? AND user_id = ? AND is_deleted = 0
    `
	if _, err := db.DB().Exec(query, params...); err != nil {
		return nil, err
	}
	return FindById(id, userID)
}

// DeleteModel 对应 Category.delete（软删除）。
// keep BUG-056：删除不校验被引用（无引用检查；且未限定 type，可删 bank 行），维持原样。
// from: model/index.js:125-133
// 🔧 2026-10-11 改名：原 Delete 与 controller 的同名 handler 冲突。
func DeleteModel(id, userID string) (bool, error) {
	res, err := db.DB().Exec(
		"UPDATE bus_category SET is_deleted = 1 WHERE id = ? AND user_id = ?",
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

// defaultCategories 对应 Node createDefaults 的 defaults（24 条：收入 11 + 支出 13）。
// from: model/index.js:139-167
var defaultCategories = []struct {
	name, ctype, remark string
	hasRemark           bool
}{
	// 收入分类
	{name: "工资", ctype: "income", remark: "每月固定收入", hasRemark: true},
	{name: "奖金", ctype: "income", remark: "额外奖励", hasRemark: true},
	{name: "投资收益", ctype: "income", remark: "理财分红等", hasRemark: true},
	{name: "兼职", ctype: "income", remark: "副业收入", hasRemark: true},
	{name: "退款", ctype: "income", remark: "退款返还", hasRemark: true},
	{name: "转账", ctype: "income", remark: "账户转入", hasRemark: true},
	{name: "提现", ctype: "income", remark: "提现到账", hasRemark: true},
	{name: "冲正", ctype: "income", remark: "交易冲正退款", hasRemark: true},
	{name: "结汇", ctype: "income", remark: "外币结汇收入", hasRemark: true},
	{name: "初始化余额", ctype: "income", remark: "账户初始化余额", hasRemark: true},
	{name: "其他收入", ctype: "income"},

	// 支出分类
	{name: "餐饮", ctype: "expense", remark: "早中晚餐", hasRemark: true},
	{name: "交通", ctype: "expense", remark: "出行费用", hasRemark: true},
	{name: "购物", ctype: "expense", remark: "日用品/服饰", hasRemark: true},
	{name: "娱乐", ctype: "expense", remark: "游戏/电影/旅游", hasRemark: true},
	{name: "住房", ctype: "expense", remark: "房租/房贷/物业", hasRemark: true},
	{name: "医疗", ctype: "expense", remark: "药品/看病", hasRemark: true},
	{name: "教育", ctype: "expense", remark: "培训/书籍", hasRemark: true},
	{name: "通讯", ctype: "expense", remark: "话费/网费", hasRemark: true},
	{name: "水电煤", ctype: "expense", remark: "生活必需", hasRemark: true},
	{name: "转账", ctype: "expense", remark: "账户转出", hasRemark: true},
	{name: "提现", ctype: "expense", remark: "余额提现", hasRemark: true},
	{name: "购汇", ctype: "expense", remark: "购买外币", hasRemark: true},
	{name: "其他支出", ctype: "expense"},
}

// CreateDefaults 对应 Category.createDefaults(userId)：批量创建默认分类（24 条）。
// from: model/index.js:138-172
func CreateDefaults(userID string) error {
	for _, item := range defaultCategories {
		if _, err := CreateModel(CategoryCreateParams{
			UserID:    userID,
			Name:      item.name,
			Type:      item.ctype,
			Remark:    item.remark,
			RemarkSet: item.hasRemark,
		}); err != nil {
			return err
		}
	}
	return nil
}
