package budget

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
)

// ============================================================================
// 预算模型 —— from: model/budget.js（SQL 逐字一致）
// 注意：getCurrentDate 用 toISOString 取 UTC 日期（与 fixed_asset 同源，维持原样）。
// ============================================================================

// tableName 对应 Budget.tableName = 'budget'。
const tableName = "budget"

// getCurrentDate 对应 Budget.getCurrentDate：UTC 日期 YYYY-MM-DD。
func getCurrentDate() string {
	return time.Now().UTC().Format("2006-01-02")
}

// toF 对应 parseFloat(v) || 0（宽松解析，失败 0）。
func toF(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case int64:
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

// jsTruthy 对应 JS 真值判断（非空字符串皆真，含 "0"）。
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && !math.IsNaN(t)
	case int64:
		return t != 0
	}
	return true
}

// parseFloatLax 对应 parseFloat(v)（失败 NaN，用于 <= 0 判断分支）。
func parseFloatLax(v any) float64 {
	switch t := v.(type) {
	case nil:
		return math.NaN()
	case float64:
		return t
	case int64:
		return float64(t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case string:
		return parseFloatPrefix(t)
	}
	return math.NaN()
}

func parseFloatPrefix(s string) float64 {
	s = strings.TrimSpace(s)
	end, seenDigit, seenDot := 0, false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case c == '.' && !seenDot && seenDigit:
			seenDot = true
			end = i + 1
		case (c == '-' || c == '+') && i == 0:
		default:
			goto done
		}
	}
done:
	if !seenDigit {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// budgetCreate 创建预算。from: budget/model/budget.js:27-63
// budgetDetailsPresent 用于区分「字段缺省」（写 '{}'）与「显式 null」（写 'null'），见 detailsToString。
func budgetCreate(ex db.Commiter, userID string, title, route, budgetType, budgetAmount, budgetDetails any, budgetDetailsPresent bool, cycle, planDate any) (map[string]any, error) {
	if !jsTruthy(title) {
		return nil, fmt.Errorf("预算标题不能为空")
	}
	if !jsTruthy(budgetType) {
		return nil, fmt.Errorf("预算类型不能为空")
	}
	if !jsTruthy(budgetAmount) || parseFloatLax(budgetAmount) <= 0 {
		return nil, fmt.Errorf("预算金额必须大于0")
	}
	if !jsTruthy(cycle) {
		return nil, fmt.Errorf("周期不能为空")
	}
	if !jsTruthy(planDate) {
		return nil, fmt.Errorf("预计日期不能为空")
	}

	validCycles := []string{"月", "季", "年"}
	if indexOfStr(validCycles, toStr(cycle)) == -1 {
		return nil, fmt.Errorf("周期只能是 月/季/年")
	}

	validTypes := []string{"吃", "买", "行"}
	if indexOfStr(validTypes, toStr(budgetType)) == -1 {
		return nil, fmt.Errorf("预算类型只能是 吃/买/行")
	}

	id := idgen.BillID()
	createTime := getCurrentDate()
	detailsStr := detailsToString(budgetDetails, budgetDetailsPresent)

	_, err := ex.Exec(`
      INSERT INTO `+tableName+` 
      (id, user_id, title, route, budget_type, budget_amount, used_amount, budget_details, 
       cycle, plan_date, is_over_budget, is_excute, create_time, update_time, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, userID, title, orNil(route), budgetType, budgetAmount, 0, detailsStr,
		cycle, planDate, 0, 0, createTime, createTime)
	if err != nil {
		return nil, err
	}

	return FindById(ex, id, userID)
}

// detailsToString 对应 budget_details 的 typeof 判断
// （budget/model/budget.js:46-48）：
//
//	typeof v === 'object' ? JSON.stringify(v) : '{}'
//
// 即 **undefined（缺省）→ '{}'**、**null → 'null'（JSON 字符串）**、对象 → JSON 串。
//
// 🔒 SYNC-A24（2026-10-12）：原实现对 nil 返回 SQL NULL，若该列 NOT NULL 则
//
//	INSERT 直接报错 500（Node 写的是字符串 '{}'，不会失败）。present 用来区分
//	「字段缺省」（写 '{}'）与「显式传 null」（写 'null'）。
func detailsToString(v any, present bool) any {
	if !present {
		return "{}"
	}
	if v == nil {
		// 显式 null：JS typeof null === 'object' ⇒ JSON.stringify(null) === "null"
		return "null"
	}
	switch v.(type) {
	case map[string]any, []any:
		b, err := json.Marshal(v)
		if err != nil {
			return "{}"
		}
		return string(b)
	}
	return "{}"
}

// FindById 根据ID查询。from: budget/model/budget.js:68-77
func FindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	row, err := qRow(ex,
		`SELECT * FROM `+tableName+` WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		id, userID)
	if err != nil {
		return nil, err
	}
	if row != nil {
		row["budget_details"] = parseDetails(row["budget_details"])
	}
	return row, nil
}

// FindAll 获取用户所有预算。from: budget/model/budget.js:82-91
func FindAll(ex db.Commiter, userID string) ([]map[string]any, error) {
	rows, err := qRows(ex,
		`SELECT * FROM `+tableName+` WHERE user_id = ? AND is_deleted = 0 ORDER BY create_time DESC`,
		userID)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		row["budget_details"] = parseDetails(row["budget_details"])
	}
	return rows, nil
}

// parseDetails 对应 Budget.parseDetails：空 → {}；对象 → 本身；JSON.parse 失败 → {}。
func parseDetails(details any) any {
	if details == nil {
		return map[string]any{}
	}
	if _, ok := details.(map[string]any); ok {
		return details
	}
	s, ok := details.(string)
	if !ok {
		return map[string]any{}
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil || v == nil {
		return map[string]any{}
	}
	return v
}

// budgetUpdate 更新预算。from: budget/model/budget.js:109-141
func budgetUpdate(ex db.Commiter, id, userID string, updates map[string]any) (map[string]any, error) {
	existing, err := FindById(ex, id, userID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, fmt.Errorf("预算记录不存在")
	}

	// 允许更新的字段白名单
	allowedFields := []string{"title", "route", "budget_type", "budget_amount", "used_amount", "budget_details", "cycle", "plan_date", "is_over_budget", "is_excute"}
	fields := []string{}
	params := []any{}

	for _, key := range allowedFields {
		v, ok := updates[key]
		// SYNC-A25（2026-10-12）：Node 只排除 undefined（`updates[key] !== undefined`，
		//   budget.js:118-127），**显式 null 会被写入**。原 Go 额外排除了 nil
		//   （`v == nil` ⇒ 跳过）⇒ 前端传 null 清空字段时 Go 静默不更新。
		//   以 Node 为准，只在键缺省时跳过。
		if !ok {
			continue
		}
		fields = append(fields, key+" = ?")
		if key == "budget_details" {
			b, err := json.Marshal(v)
			if err != nil {
				params = append(params, "{}")
			} else {
				params = append(params, string(b))
			}
		} else {
			params = append(params, v)
		}
	}

	if len(fields) == 0 {
		return existing, nil
	}

	fields = append(fields, "update_time = ?")
	params = append(params, getCurrentDate())
	params = append(params, id, userID)

	_, err = ex.Exec(
		`UPDATE `+tableName+` SET `+strings.Join(fields, ", ")+` WHERE id = ? AND user_id = ?`,
		params...)
	if err != nil {
		return nil, err
	}
	return FindById(ex, id, userID)
}

// PermanentDelete 永久删除预算（硬删除）。from: budget/model/budget.js:146-152
func PermanentDelete(ex db.Commiter, id, userID string) (bool, error) {
	return execAffected(ex,
		`DELETE FROM `+tableName+` WHERE id = ? AND user_id = ?`,
		id, userID)
}

// GetStats 获取预算统计。from: budget/model/budget.js:157-174
func GetStats(ex db.Commiter, userID string) ([]map[string]any, error) {
	rows, err := qRows(ex, `
      SELECT budget_type, SUM(budget_amount) as total_budget, SUM(used_amount) as total_used
      FROM `+tableName+` WHERE user_id = ? AND is_deleted = 0
      GROUP BY budget_type`, userID)
	if err != nil {
		return nil, err
	}

	out := []map[string]any{}
	for _, row := range rows {
		totalBudget := toF(row["total_budget"])
		totalUsed := toF(row["total_used"])
		var usageRate any
		if totalBudget > 0 {
			// Math.round(used/budget*10000)/100
			// 🔒 SYNC-A43（2026-10-13）：用 cur.Round2（= floor(x+0.5)）而非 math.Round。
			// Node 是 Math.round(used/budget*10000)/100；JS Math.round 是半值向 +∞，
			// Go 的 math.Round 是半值远离 0 ⇒ 负数差 0.01。
			// 当前 totalBudget>0 且 totalUsed 通常非负故分歧不可见，
			// 但 used_amount 若为负（退款类预算）就会命中。改用 cur.Round2 消除隐患。
			usageRate = cur.Round2(totalUsed/totalBudget*10000) / 100
		} else {
			usageRate = 0
		}
		out = append(out, map[string]any{
			"budget_type":  row["budget_type"],
			"total_budget": totalBudget,
			"total_used":   totalUsed,
			"remaining":    cur.Round2(totalBudget - totalUsed),
			"usage_rate":   usageRate,
		})
	}
	return out, nil
}

// ===== 小工具 =====

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
	}
	return ""
}

func orNil(v any) any {
	if jsTruthy(v) {
		return v
	}
	return nil
}

func indexOfStr(ss []string, s string) int {
	for i, v := range ss {
		if v == s {
			return i
		}
	}
	return -1
}

// hasKey 判断 map 是否**显式包含**某键（用于区分缺省 undefined 与显式 null）。
func hasKey(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}

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

func normVal(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
}

func execAffected(ex db.Commiter, q string, args ...any) (bool, error) {
	res, err := ex.Exec(q, args...)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
