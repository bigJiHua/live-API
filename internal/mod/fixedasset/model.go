// Package fixedasset 复刻 src/modules/fixed_asset（固定资产：api + controller + model）。
// SQL 逐字一致（? 占位）；keep 标注同 build_logs/api.logs：
//   - keep BUG-026：update 修改 use_years/residual_rate 不重算折旧
//     （Node `fields.includes('use_years')` 判断失败——fields 存的是整句），维持原样；
//   - keep BUG-027：折旧日期 getCurrentDate 用 UTC（toISOString），北京时间 0-8 点得到前一天，维持原样。
//
// 折旧算法逐字复刻：
//   - use_months = round(use_years*12)
//   - residual_val = round(buy_price*residual_rate/100*100)/100
//   - month_deprec = (buy_price-residual_val)/use_months（保留2位）
//   - now_val 不低于残值（折旧封顶 deprec_finished=1）
package fixedasset

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// tableName 对应 FixedAsset.tableName = 'fixed_asset'。
const tableName = "fixed_asset"

// diffMonths 对应 FixedAsset.diffMonths：两个日期字符串的月份差。
// new Date('YYYY-MM-DD') 按 UTC 解析，getFullYear/getMonth 取本地时区分量
// （Asia/Shanghai +8：UTC 零点 → 当地当日 08:00，年月不变）。
// 非法日期返回 NaN（JS Invalid Date 语义），后续比较同样落入 false 分支。
// from: fixed_asset/model/fixed_asset.js:24-28
func diffMonths(date1, date2 string) float64 {
	t1, err1 := time.Parse("2006-01-02", strings.TrimSpace(date1))
	t2, err2 := time.Parse("2006-01-02", strings.TrimSpace(date2))
	if err1 != nil || err2 != nil {
		return math.NaN()
	}
	l1, l2 := t1.In(tim.Loc()), t2.In(tim.Loc())
	return float64((l2.Year()-l1.Year())*12 + (int(l2.Month()) - int(l1.Month())))
}

// getCurrentDate 对应 FixedAsset.getCurrentDate：UTC 日期。
// keep BUG-027：toISOString 取 UTC 日期，维持原样。
// from: fixed_asset/model/fixed_asset.js:33-35
func getCurrentDate() string {
	return time.Now().UTC().Format("2006-01-02")
}

// FindById 根据ID查询。from: fixed_asset/model/fixed_asset.js:92-98
func FindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	return qRow(ex,
		`SELECT * FROM `+tableName+` WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		id, userID)
}

// FindAll 获取用户所有固定资产。from: fixed_asset/model/fixed_asset.js:103-109
func FindAll(ex db.Commiter, userID string) ([]map[string]any, error) {
	return qRows(ex,
		`SELECT * FROM `+tableName+` WHERE user_id = ? AND is_deleted = 0 ORDER BY create_time DESC`,
		userID)
}

// FindDeleted 获取已删除的资产（回收站）。from: fixed_asset/model/fixed_asset.js:114-120
func FindDeleted(ex db.Commiter, userID string) ([]map[string]any, error) {
	return qRows(ex,
		`SELECT * FROM `+tableName+` WHERE user_id = ? AND is_deleted = 1 ORDER BY create_time DESC`,
		userID)
}

// FindForDeprec 获取需要折旧巡检的资产。from: fixed_asset/model/fixed_asset.js:126-133
func FindForDeprec(ex db.Commiter, userID string) ([]map[string]any, error) {
	return qRows(ex, `
      SELECT * FROM `+tableName+` 
      WHERE user_id = ? AND is_deleted = 0 AND status = 'using' AND deprec_finished = 0`,
		userID)
}

// createAsset 创建固定资产（初始化计算）。
// from: fixed_asset/model/fixed_asset.js:40-87
func createAsset(ex db.Commiter, userID string, info, tag, imgUrl, buyPrice, secondhandPrice, useYears, residualRate, buyDate, status any) (map[string]any, error) {
	if isEmptyVal(info) {
		return nil, errStr("资产名称不能为空")
	}
	if isEmptyVal(tag) {
		return nil, errStr("品类不能为空")
	}
	if isEmptyVal(imgUrl) {
		return nil, errStr("图片不能为空")
	}
	if !truthyJS(buyPrice) || parseFloatJS(buyPrice) <= 0 {
		return nil, errStr("购买价必须大于0")
	}
	if !truthyJS(useYears) || parseFloatJS(useYears) <= 0 {
		return nil, errStr("预计使用年限必须大于0")
	}
	rr := parseFloatJS(residualRate)
	if !truthyJS(residualRate) || (!isNaN(rr) && rr < 0) || (!isNaN(rr) && rr > 100) {
		return nil, errStr("残值率必须在0~100之间")
	}
	if isEmptyVal(buyDate) {
		return nil, errStr("购买日期不能为空")
	}

	buyPriceNum := parseFloatJS(buyPrice)
	useYearsNum := parseFloatJS(useYears)
	residualRateNum := rr

	// 计算字段
	useMonths := math.Round(useYearsNum * 12)                            // 预计使用月数 Math.round(use_years*12)
	residualVal := cur.Round2(buyPriceNum * residualRateNum / 100 * 100) // 残值 Math.round(x*100)/100
	totalDepreciable := buyPriceNum - residualVal                        // 总可折旧额度
	var monthDeprec float64
	if totalDepreciable > 0 && useMonths > 0 {
		monthDeprec = cur.Round2(totalDepreciable / useMonths * 100) // 月折旧额
	}
	createTime := getCurrentDate()

	id := idgen.BillID()

	_, err := ex.Exec(`
      INSERT INTO `+tableName+` 
      (id, user_id, info, tag, img_url, buy_price, now_val, secondhand_price,
       use_years, use_months, residual_rate, residual_val,
       deprec_method, month_deprec, total_deprec,
       buy_date, last_deprec_date, scrap_date,
       create_time, deprec_finished, status, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, userID, info, tag, imgUrl, buyPrice, buyPrice, orNil(secondhandPrice),
		useYears, int64(useMonths), residualRate, residualVal,
		"straight", monthDeprec, 0,
		buyDate, buyDate, nil,
		createTime, 0, orDefaultStatus(status))
	if err != nil {
		return nil, err
	}

	return FindById(ex, id, userID)
}

// updateAsset 更新固定资产（部分字段可修改）。
// 🔄 2026-10-13 修复（api.md P1-5）：needsRecalc 前缀匹配。
//
//	Node 原实现 `deprecFields.some(f => fields.includes(f))` 匹配的是
//	'use_years = ?' 整句 ⇒ 恒 false，改年限/残值率后 use_months/residual_val/
//	month_deprec 从不重算（折旧数据全停留在旧值）。Node 已改 startsWith，Go 同步。
//
// from: fixed_asset/model/fixed_asset.js:138-200
func updateAsset(ex db.Commiter, id, userID string, updates map[string]any) (map[string]any, error) {
	fields := []string{}
	params := []any{}

	// 可修改字段（除系统字段和计算字段外）
	allowedFields := []string{"info", "tag", "img_url", "now_val", "secondhand_price",
		"use_years", "residual_rate", "scrap_date", "status"}

	for _, key := range allowedFields {
		// 🔒 SYNC-A42（2026-10-13）：只判**键存在性**，不排除显式 null。
		// Node fixed_asset.js:146-151 是 `updates[key] !== undefined` ⇒ 显式 null 会写 SQL NULL；
		// 旧实现多加了 `&& v != nil` ⇒ 传 {now_val:null} / {scrap_date:null} 清空字段时被静默跳过，
		// 字段永远清不掉。这与 budget 侧 SYNC-A25 修好的是同一类遗漏。
		if v, ok := updates[key]; ok {
			fields = append(fields, key+" = ?")
			params = append(params, v)
		}
	}

	if len(fields) == 0 {
		return FindById(ex, id, userID)
	}

	existing, err := FindById(ex, id, userID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, errStr("资产记录不存在")
	}

	// 如果修改了影响折旧的字段，重新计算相关值（前缀匹配：fields 存的是 "use_years = ?" 整句）
	deprecFields := []string{"use_years", "residual_rate"}
	needsRecalc := false
	for _, f := range deprecFields {
		for _, x := range fields {
			if strings.HasPrefix(x, f+" ") {
				needsRecalc = true
				break
			}
		}
	}

	if needsRecalc {
		buyPrice := parseFloatJS(existing["buy_price"])
		useYears := parseFloatJS(existing["use_years"])
		if v, ok := updates["use_years"]; ok {
			useYears = parseFloatJS(v)
		}
		residualRate := parseFloatJS(existing["residual_rate"])
		if v, ok := updates["residual_rate"]; ok {
			residualRate = parseFloatJS(v)
		}
		useMonths := math.Round(useYears * 12)
		residualVal := math.Round(buyPrice*residualRate/100*100) / 100
		totalDepreciable := buyPrice - residualVal
		monthDeprec := 0.0
		if totalDepreciable > 0 && useMonths > 0 {
			monthDeprec = math.Round(totalDepreciable/useMonths*100) / 100
		}

		// 同上的 startsWith 模式（allowedFields 不含这三个计算列，恒 push 一次；
		//  用 startsWith 是为了将来若放开计算列入参也不产生重复列）
		if !hasFieldPrefix(fields, "use_months ") {
			fields = append(fields, "use_months = ?")
			params = append(params, int64(useMonths))
		}
		if !hasFieldPrefix(fields, "residual_val ") {
			fields = append(fields, "residual_val = ?")
			params = append(params, residualVal)
		}
		if !hasFieldPrefix(fields, "month_deprec ") {
			fields = append(fields, "month_deprec = ?")
			params = append(params, monthDeprec)
		}
	}

	params = append(params, id, userID)
	_, err = ex.Exec(
		`UPDATE `+tableName+` SET `+strings.Join(fields, ", ")+` WHERE id = ? AND user_id = ?`,
		params...)
	if err != nil {
		return nil, err
	}
	return FindById(ex, id, userID)
}

// hasFieldPrefix 判断 fields 是否已有某列的前缀条目（对应 Node fields.some(x => x.startsWith(f + ' '))）。
func hasFieldPrefix(fields []string, prefix string) bool {
	for _, x := range fields {
		if strings.HasPrefix(x, prefix) {
			return true
		}
	}
	return false
}

// deleteAsset 软删除资产。from: fixed_asset/model/fixed_asset.js:199-205
func deleteAsset(ex db.Commiter, id, userID string) (bool, error) {
	return execAffected(ex,
		`UPDATE `+tableName+` SET is_deleted = 1 WHERE id = ? AND user_id = ?`,
		id, userID)
}

// restoreAsset 恢复删除的资产。from: fixed_asset/model/fixed_asset.js:210-216
func restoreAsset(ex db.Commiter, id, userID string) (bool, error) {
	return execAffected(ex,
		`UPDATE `+tableName+` SET is_deleted = 0 WHERE id = ? AND user_id = ?`,
		id, userID)
}

// PermanentDeleteAsset 永久删除资产。from: fixed_asset/model/fixed_asset.js:221-227
func PermanentDeleteAsset(ex db.Commiter, id, userID string) (bool, error) {
	return execAffected(ex,
		`DELETE FROM `+tableName+` WHERE id = ? AND user_id = ?`,
		id, userID)
}

// depreciateAll 折旧巡检：返回更新后的资产列表。
// from: fixed_asset/model/fixed_asset.js:233-282
func depreciateAll(ex db.Commiter, userID string) ([]map[string]any, error) {
	assets, err := FindForDeprec(ex, userID)
	if err != nil {
		return nil, err
	}
	if len(assets) == 0 {
		return []map[string]any{}, nil
	}

	today := getCurrentDate()
	updatedAssets := []map[string]any{}

	for _, asset := range assets {
		lastDeprecDate := orStr(asset["last_deprec_date"], toStr(asset["buy_date"]))
		dm := diffMonths(lastDeprecDate, today)

		// 如果当月已计算过，跳过（NaN <= 0 为 false，与 JS 一致继续执行）
		if dm <= 0 {
			continue
		}

		updated, err := applyDepreciation(ex, asset, userID, today, dm)
		if err != nil {
			return nil, err
		}
		if updated != nil {
			updatedAssets = append(updatedAssets, updated)
		}
	}
	return updatedAssets, nil
}

// applyDepreciation 对应 depreciate 循环体 / depreciateAsset 的公共计算：
// addDeprec = monthDeprec * diffMonths；newTotalDeprec >= totalDepreciable 时封顶
// （nowVal = residualVal, deprecFinished = 1）。
func applyDepreciation(ex db.Commiter, asset map[string]any, userID, today string, diffMonths float64) (map[string]any, error) {
	buyPrice := parseFloatJS(asset["buy_price"])
	residualVal := parseFloatJS(asset["residual_val"])
	totalDepreciable := buyPrice - residualVal
	currentTotalDeprec := orZero(parseFloatJS(asset["total_deprec"]))
	monthDeprec := orZero(parseFloatJS(asset["month_deprec"]))

	// 计算应补提折旧
	addDeprec := monthDeprec * diffMonths
	newTotalDeprec := currentTotalDeprec + addDeprec

	// 边界校验：折旧封顶
	deprecFinished := 0
	nowVal := buyPrice - newTotalDeprec

	if newTotalDeprec >= totalDepreciable {
		// 折旧完毕
		newTotalDeprec = totalDepreciable
		nowVal = residualVal
		deprecFinished = 1
	}

	_, err := ex.Exec(`
      UPDATE `+tableName+` 
      SET total_deprec = ?, now_val = ?, last_deprec_date = ?, deprec_finished = ?
      WHERE id = ? AND user_id = ?`,
		cur.Round2(newTotalDeprec), nowVal, today, deprecFinished, toStr(asset["id"]), userID)
	if err != nil {
		return nil, err
	}
	return FindById(ex, toStr(asset["id"]), userID)
}

// changeStatus 状态变更。from: fixed_asset/model/fixed_asset.js:287-320
func changeStatus(ex db.Commiter, id, userID, newStatus string) (map[string]any, error) {
	asset, err := FindById(ex, id, userID)
	if err != nil {
		return nil, err
	}
	if asset == nil {
		return nil, errStr("资产记录不存在")
	}

	validStatuses := []string{"using", "scrapped", "sold", "lost"}
	if indexOfStr(validStatuses, newStatus) == -1 {
		return nil, errStr("状态只能是 using/scrapped/sold/lost")
	}

	var scrapDate any
	// 报废时记录报废日期
	if newStatus == "scrapped" && toStr(asset["status"]) != "scrapped" {
		scrapDate = getCurrentDate()
	}

	// 从using改为其他状态，停止折旧（先执行一次折旧巡检）
	if newStatus != "using" && toStr(asset["status"]) == "using" {
		lastDeprecDate := orStr(asset["last_deprec_date"], toStr(asset["buy_date"]))
		dm := diffMonths(lastDeprecDate, getCurrentDate())
		if dm > 0 {
			if _, err := applyDepreciation(ex, asset, userID, getCurrentDate(), dm); err != nil {
				return nil, err
			}
		}
	}

	_, err = ex.Exec(
		`UPDATE `+tableName+` SET status = ?, scrap_date = COALESCE(?, scrap_date) WHERE id = ? AND user_id = ?`,
		newStatus, orNil(scrapDate), id, userID)
	if err != nil {
		return nil, err
	}
	return FindById(ex, id, userID)
}

// GetAssetDetail 获取资产详情（含计算字段）。
// from: fixed_asset/model/fixed_asset.js:363-377
func GetAssetDetail(ex db.Commiter, id, userID string) (map[string]any, error) {
	asset, err := FindById(ex, id, userID)
	if err != nil {
		return nil, err
	}
	if asset == nil {
		return nil, nil
	}

	buyDate := toStr(asset["buy_date"])
	today := getCurrentDate()
	monthsUsed := diffMonths(buyDate, today)

	out := make(map[string]any, len(asset)+3)
	for k, v := range asset {
		out[k] = v
	}
	out["months_used"] = monthsUsed
	out["years_used"] = cur.Round2(monthsUsed / 12 * 100)
	out["depreciable_amount"] = cur.Round2((parseFloatJS(asset["buy_price"]) - parseFloatJS(asset["residual_val"])) * 100)
	return out, nil
}

// ===== 小工具 =====

type errStr string

func (e errStr) Error() string { return string(e) }

func isEmptyVal(v any) bool { return !truthyJS(v) }

// orNil 对应 v || null。
func orNil(v any) any {
	if truthyJS(v) {
		return v
	}
	return nil
}

// orZero 对应 parseFloat(x) || 0。
func orZero(f float64) float64 {
	if isNaN(f) {
		return 0
	}
	return f
}

// orStr 对应 a || b（字符串）。
func orStr(a any, b string) string {
	if s := toStr(a); s != "" {
		return s
	}
	return b
}

// orDefaultStatus 对应 status || 'using'。
func orDefaultStatus(v any) any {
	if truthyJS(v) {
		return v
	}
	return "using"
}

func indexOfStr(ss []string, s string) int {
	for i, v := range ss {
		if v == s {
			return i
		}
	}
	return -1
}

func isNaN(f float64) bool { return math.IsNaN(f) }

// parseFloatJS 对应 JS parseFloat(v)：宽松前缀解析，失败 NaN；null/undefined → NaN。
func parseFloatJS(v any) float64 {
	switch t := v.(type) {
	case nil:
		return math.NaN()
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	case string:
		return parseFloatLoose(t)
	}
	return math.NaN()
}

func parseFloatLoose(s string) float64 {
	neg := false
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	if i < len(s) && (s[i] == '-' || s[i] == '+') {
		neg = s[i] == '-'
		i++
	}
	end, seenDigit, seenDot := i, false, false
	for ; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			seenDigit = true
			end = i + 1
		case c == '.' && !seenDot && seenDigit:
			seenDot = true
			end = i + 1
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
	if neg {
		f = -f
	}
	return f
}

// truthyJS 对应 JS 真值判断（非空字符串皆真，含 "false"/"0"）。
func truthyJS(v any) bool {
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
	case int:
		return t != 0
	}
	return true
}

// toStr 对应 String(v) 常用子集。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if isNaN(t) {
			return "NaN"
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	}
	return ""
}

// qRow / qRows / execAffected（私有副本）
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
