package fund

import (
	"fmt"
	"math"
	"math/big"
	"strings"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// ============================================================================
// 基金模型 —— from: model/index.js（SQL 逐字复刻，聚合视图表达式原样保留）
// ============================================================================

const tableName = "fund"
const tableHistory = "bus_fund_history"

// numberExpr 对应 Fund.numberExpr(alias, field)。
func numberExpr(alias, field string) string {
	return fmt.Sprintf("COALESCE(CAST(NULLIF(%s.%s, '') AS DECIMAL(16,4)), 0)", alias, field)
}

// legacySnapshotExpr 对应 Fund.legacySnapshotExpr。
func legacySnapshotExpr(historyAlias, fundAlias string) string {
	base := numberExpr(fundAlias, "invest")
	profit := numberExpr(historyAlias, "net_value")
	capital := numberExpr(historyAlias, "market_val")
	return fmt.Sprintf("(%s = %s AND ABS(%s) > ABS(%s) * 0.5)", capital, base, profit, base)
}

// historyProfitExpr 对应 Fund.historyProfitExpr。
//
// 🔒 SYNC-A41（2026-10-13）：补回 legacy 分支的 `- base`。
//
//	Node fund/model/index.js:19-23：
//	    return `CASE WHEN ${legacy} THEN ${profit} - ${base} ELSE ${profit} END`;
//	                        ^^^^^^^^^^^^^^^^ 这一段此前被整个漏掉
//
// 影响：命中 legacySnapshotExpr（market_val == invest 且 |net_value| > invest*0.5）
// 的历史行，其"收益"被算成 net_value **本身**而不是「净值 − 本金」，
// 即把本金计入收益 ⇒ 基金列表 profit_delta、历史净值列表、
// 历史汇总（getHistorySummary / Before / monthly.beforeProfit）全部虚高，收益率同步虚高。
func historyProfitExpr(historyAlias, fundAlias string) string {
	base := numberExpr(fundAlias, "invest")
	profit := numberExpr(historyAlias, "net_value")
	return fmt.Sprintf("CASE WHEN %s THEN %s - %s ELSE %s END",
		legacySnapshotExpr(historyAlias, fundAlias), profit, base, profit)
}

// historyCapitalExpr 对应 Fund.historyCapitalExpr。
func historyCapitalExpr(historyAlias, fundAlias string) string {
	capital := numberExpr(historyAlias, "market_val")
	return fmt.Sprintf("CASE WHEN %s THEN 0 ELSE %s END",
		legacySnapshotExpr(historyAlias, fundAlias), capital)
}

// aggregateSelect 对应 Fund.aggregateSelect（聚合视图 SQL 逐字复刻）。
func aggregateSelect() string {
	principalExpr := "COALESCE(CAST(NULLIF(f.invest, '') AS DECIMAL(16,4)), 0)"
	capitalExpr := "COALESCE(a.capital_sum, 0)"
	profitExpr := "COALESCE(a.profit_sum, 0)"
	currentPrincipalExpr := fmt.Sprintf("(%s + %s)", principalExpr, capitalExpr)
	currentMarketExpr := fmt.Sprintf("(%s + %s)", currentPrincipalExpr, profitExpr)

	return fmt.Sprintf(`
      SELECT
        f.id,
        f.user_id,
        f.fund_name,
        f.share,
        f.fund_account,
        f.trade_account,
        f.sell_org,
        f.fund_company,
        f.buy_date,
        ROUND(%s, 4) AS net_value,
        ROUND(%s, 2) AS invest,
        ROUND(%s, 2) AS market_val,
        CONCAT(ROUND(CASE WHEN %s > 0 THEN (%s / %s) * 100 ELSE 0 END, 2), '%%') AS rate,
        f.create_time,
        f.is_deleted,
        f.net_value AS base_net_value,
        f.market_val AS base_market_val,
        ROUND(%s, 2) AS base_invest,
        ROUND(%s, 2) AS capital_delta,
        ROUND(%s, 4) AS profit_delta
      FROM %s f
      LEFT JOIN (
        SELECT
          h.fund_id,
          COALESCE(SUM(%s), 0) AS profit_sum,
          COALESCE(SUM(%s), 0) AS capital_sum
        FROM %s h
        JOIN %s hf ON h.fund_id = hf.id
        GROUP BY h.fund_id
      ) a ON a.fund_id = f.id
    `, profitExpr, currentPrincipalExpr, currentMarketExpr,
		currentPrincipalExpr, profitExpr, currentPrincipalExpr,
		principalExpr, capitalExpr, profitExpr,
		tableName,
		historyProfitExpr("h", "hf"), historyCapitalExpr("h", "hf"),
		tableHistory, tableName)
}

// findAll 对应 Fund.findAll(userId)。
func findAll(userID string) ([]map[string]any, error) {
	return queryRows(db.DB(),
		aggregateSelect()+" WHERE f.user_id = ? AND f.is_deleted = 0 ORDER BY f.create_time DESC",
		userID)
}

// findById 对应 Fund.findById(id, userId)。
func findById(id, userID string) (map[string]any, error) {
	return queryRow(db.DB(),
		aggregateSelect()+" WHERE f.id = ? AND f.user_id = ? AND f.is_deleted = 0",
		id, userID)
}

// findRawById 对应 Fund.findRawById(id, userId)。
func findRawById(id, userID string) (map[string]any, error) {
	return queryRow(db.DB(),
		"SELECT * FROM "+tableName+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// toNull 对应 Fund.toNull：undefined → null。
func toNull(v any) any {
	if v == nil {
		return nil
	}
	return v
}

// CreateParams 对应 Fund.create 入参。
type CreateParams struct {
	UserID       string
	FundName     any
	Share        any
	FundAccount  any
	TradeAccount any
	SellOrg      any
	FundCompany  any
	BuyDate      any
	NetValue     any
	Invest       any
	MarketVal    any
	Rate         any
}

// createFund 对应 Fund.create。
func createFund(p CreateParams) (map[string]any, error) {
	id := idgen.BillID()
	now := tim.NowMSString()
	_, err := db.DB().Exec(
		`INSERT INTO `+tableName+` (id, user_id, fund_name, share, fund_account, trade_account, sell_org, fund_company, buy_date, net_value, invest, market_val, rate, create_time, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[]any{
			id, p.UserID, toNull(p.FundName), toNull(p.Share), toNull(p.FundAccount), toNull(p.TradeAccount),
			toNull(p.SellOrg), toNull(p.FundCompany), toNull(p.BuyDate), toNull(p.NetValue),
			toNull(p.Invest), toNull(p.MarketVal), toNull(p.Rate), now,
		}...)
	if err != nil {
		return nil, err
	}
	return findById(id, p.UserID)
}

// updateFund 对应 Fund.update(id, userId, updates)。
// updates 的键为数据库列名（fund_name/share/.../rate），仅允许白名单列。
func updateFund(id, userID string, updates map[string]any) (map[string]any, error) {
	allowedFields := []string{"fund_name", "share", "fund_account", "trade_account", "sell_org", "fund_company", "buy_date", "net_value", "invest", "market_val", "rate"}
	allowed := map[string]bool{}
	for _, f := range allowedFields {
		allowed[f] = true
	}
	var fields []string
	var params []any
	for k, v := range updates {
		// 🔒 SYNC-A43（2026-10-13）：只判白名单，**不排除显式 nil**。
		// Node fund/model/index.js:115-120 是
		//     if (allowedFields.includes(key) && updates[key] !== undefined) { params.push(updates[key]) }
		// `!== undefined` 不排除 null ⇒ 显式 null 会落库为 NULL。
		// 旧实现多加了 `v != nil`，与 controller.go 的 SYNC-A25 注释自相矛盾：
		// controller 声称"显式 null 会被写入"，model 又把它筛掉了。
		// 后果：前端传 {"fundCompany": null} 清空字段时，Go 静默不更新，Node 写 NULL。
		if allowed[k] {
			fields = append(fields, k+" = ?")
			params = append(params, v)
		}
	}
	if len(fields) == 0 {
		return findById(id, userID)
	}
	params = append(params, id, userID)
	_, err := db.DB().Exec(
		"UPDATE "+tableName+" SET "+strings.Join(fields, ", ")+" WHERE id = ? AND user_id = ?",
		params...)
	if err != nil {
		return nil, err
	}
	return findById(id, userID)
}

// deleteFund 对应 Fund.delete(id, userId)（软删除）。
func deleteFund(id, userID string) (bool, error) {
	n, err := execAffected(db.DB(),
		"UPDATE "+tableName+" SET is_deleted = 1 WHERE id = ? AND user_id = ?",
		id, userID)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// HistoryOptions 对应 Fund.getHistory 的 options。
type HistoryOptions struct {
	Limit     int
	StartDate string
	EndDate   string
}

// getHistoryRows 对应 Fund.getHistory(fundId, userId, options)。
func getHistoryRows(fundID, userID string, opts HistoryOptions) ([]map[string]any, error) {
	params := []any{fundID, userID}
	where := []string{"h.fund_id = ?", "f.user_id = ?", "f.is_deleted = 0"}

	if opts.StartDate != "" {
		where = append(where, "h.record_date >= ?")
		params = append(params, opts.StartDate)
	}
	if opts.EndDate != "" {
		where = append(where, "h.record_date <= ?")
		params = append(params, opts.EndDate)
	}

	limitSql := ""
	if opts.Limit > 0 {
		limitSql = " LIMIT ?"
		params = append(params, opts.Limit)
	}

	return queryRows(db.DB(), fmt.Sprintf(`
      SELECT
         h.id,
         h.fund_id,
         ROUND(%s, 4) AS net_value,
         ROUND(%s, 2) AS market_val,
         h.record_date,
         h.create_time
       FROM %s h
       JOIN %s f ON h.fund_id = f.id
       WHERE %s
       ORDER BY h.record_date ASC%s`,
		historyProfitExpr("h", "f"), historyCapitalExpr("h", "f"),
		tableHistory, tableName, strings.Join(where, " AND "), limitSql),
		params...)
}

// findHistoryById 对应 Fund.findHistoryById(id, userId)。
func findHistoryById(id, userID string) (map[string]any, error) {
	return queryRow(db.DB(),
		`SELECT h.* FROM `+tableHistory+` h
       JOIN `+tableName+` f ON h.fund_id = f.id
       WHERE h.id = ? AND f.user_id = ? AND f.is_deleted = 0`,
		id, userID)
}

// HistorySummary 收益/本金汇总（{profit_sum, capital_sum}）。
type HistorySummary struct {
	ProfitSum  any
	CapitalSum any
}

// getHistorySummary 对应 Fund.getHistorySummary(fundId, userId)。
func getHistorySummary(fundID, userID string) (HistorySummary, error) {
	row, err := queryRow(db.DB(), fmt.Sprintf(`
      SELECT
         COALESCE(SUM(%s), 0) AS profit_sum,
         COALESCE(SUM(%s), 0) AS capital_sum
       FROM %s h
       JOIN %s f ON h.fund_id = f.id
       WHERE h.fund_id = ? AND f.user_id = ? AND f.is_deleted = 0`,
		historyProfitExpr("h", "f"), historyCapitalExpr("h", "f"),
		tableHistory, tableName),
		fundID, userID)
	if err != nil {
		return HistorySummary{}, err
	}
	if row == nil {
		return HistorySummary{ProfitSum: 0, CapitalSum: 0}, nil
	}
	return HistorySummary{ProfitSum: row["profit_sum"], CapitalSum: row["capital_sum"]}, nil
}

// getHistorySummaryBefore 对应 Fund.getHistorySummaryBefore(fundId, userId, beforeDate)。
func getHistorySummaryBefore(fundID, userID, beforeDate string) (HistorySummary, error) {
	row, err := queryRow(db.DB(), fmt.Sprintf(`
      SELECT
         COALESCE(SUM(%s), 0) AS profit_sum,
         COALESCE(SUM(%s), 0) AS capital_sum
       FROM %s h
       JOIN %s f ON h.fund_id = f.id
       WHERE h.fund_id = ? AND f.user_id = ? AND f.is_deleted = 0 AND h.record_date < ?`,
		historyProfitExpr("h", "f"), historyCapitalExpr("h", "f"),
		tableHistory, tableName),
		fundID, userID, beforeDate)
	if err != nil {
		return HistorySummary{}, err
	}
	if row == nil {
		return HistorySummary{ProfitSum: 0, CapitalSum: 0}, nil
	}
	return HistorySummary{ProfitSum: row["profit_sum"], CapitalSum: row["capital_sum"]}, nil
}

// MonthlyHistory 对应 Fund.getHistoryMonthly 返回值。
type MonthlyHistory struct {
	Records          []map[string]any
	BeforeProfit     float64
	BeforeCapital    float64
	LatestRecordDate any
}

// getHistoryMonthly 对应 Fund.getHistoryMonthly(fundId, userId, year, month)。
func getHistoryMonthly(fundID, userID string, year, month int) (MonthlyHistory, error) {
	startDate := fmt.Sprintf("%04d-%02d-01", year, month)
	endDate := fmt.Sprintf("%04d-%02d-31", year, month)
	beforeSummary, err := getHistorySummaryBefore(fundID, userID, startDate)
	if err != nil {
		return MonthlyHistory{}, err
	}
	records, err := getHistoryRows(fundID, userID, HistoryOptions{StartDate: startDate, EndDate: endDate, Limit: 31})
	if err != nil {
		return MonthlyHistory{}, err
	}
	latestRow, err := queryRow(db.DB(),
		`SELECT MAX(h.record_date) AS record_date FROM `+tableHistory+` h JOIN `+tableName+` f ON h.fund_id = f.id WHERE h.fund_id = ? AND f.user_id = ? AND f.is_deleted = 0`,
		fundID, userID)
	if err != nil {
		return MonthlyHistory{}, err
	}
	out := MonthlyHistory{
		Records:       records,
		BeforeProfit:  toNumber(beforeSummary.ProfitSum),
		BeforeCapital: toNumber(beforeSummary.CapitalSum),
	}
	if latestRow != nil {
		out.LatestRecordDate = latestRow["record_date"]
	}
	return out, nil
}

// getAllHistoryRows 对应 Fund.getAllHistory(userId, limit=180)。
func getAllHistoryRows(userID string, limit int) ([]map[string]any, error) {
	return queryRows(db.DB(), fmt.Sprintf(`
      SELECT
         h.id,
         h.fund_id,
         ROUND(%s, 4) AS net_value,
         ROUND(%s, 2) AS market_val,
         h.record_date,
         h.create_time
       FROM %s h
       JOIN %s f ON h.fund_id = f.id
       WHERE f.user_id = ? AND f.is_deleted = 0
       ORDER BY h.record_date ASC LIMIT ?`,
		historyProfitExpr("h", "f"), historyCapitalExpr("h", "f"),
		tableHistory, tableName),
		userID, limit)
}

// addHistoryRow 对应 Fund.addHistory({fundId, netValue, marketVal, recordDate})，返回新记录 id。
func addHistoryRow(fundID string, netValue, marketVal, recordDate any) (string, error) {
	id := idgen.BillID()
	now := tim.NowMSString()
	_, err := db.DB().Exec(
		`INSERT INTO `+tableHistory+` (id, fund_id, net_value, market_val, record_date, create_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
		[]any{id, fundID, toNull(netValue), toNull(marketVal), toNull(recordDate), now}...)
	if err != nil {
		return "", err
	}
	return id, nil
}

// updateHistoryRow 对应 Fund.updateHistory(id, userId, {netValue, marketVal})。
//
// 🔒 SYNC-A43（2026-10-13）：netValue/marketVal 改为用**存在性**表达，而不是 nil。
//
//	Node fund/model/index.js:261-275 只判 `updates[key] !== undefined` ⇒ 显式 null 会写 NULL；
//	旧的 `v != nil` 把 null 当 undefined 跳过。且 Node controller/index.js:14 的
//	isBlank(null) 为真 ⇒ `{"netValue": null}` 能通过 validateDelta，Node 确实写 NULL。
func updateHistoryRow(id, userID string, netValue, marketVal any, netValueSet, marketValSet bool) (bool, error) {
	var fields []string
	var params []any
	if netValueSet {
		fields = append(fields, "h.net_value = ?")
		params = append(params, netValue)
	}
	if marketValSet {
		fields = append(fields, "h.market_val = ?")
		params = append(params, marketVal)
	}
	if len(fields) == 0 {
		return false, nil
	}
	params = append(params, id, userID)
	n, err := execAffected(db.DB(),
		`UPDATE `+tableHistory+` h
       JOIN `+tableName+` f ON h.fund_id = f.id
       SET `+strings.Join(fields, ", ")+`
       WHERE h.id = ? AND f.user_id = ? AND f.is_deleted = 0`,
		params...)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// deleteHistoryRow 对应 Fund.deleteHistory(id, userId)（硬删除）。
func deleteHistoryRow(id, userID string) (bool, error) {
	n, err := execAffected(db.DB(),
		`DELETE h FROM `+tableHistory+` h
       JOIN `+tableName+` f ON h.fund_id = f.id
       WHERE h.id = ? AND f.user_id = ? AND f.is_deleted = 0`,
		id, userID)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// DupHistory 对应 controller addHistory 的重复日期检查：
// SELECT id FROM bus_fund_history WHERE fund_id = ? AND record_date = ?
func DupHistory(fundID, recordDate string) (bool, error) {
	row, err := queryRow(db.DB(),
		"SELECT id FROM "+tableHistory+" WHERE fund_id = ? AND record_date = ?",
		fundID, recordDate)
	if err != nil {
		return false, err
	}
	return row != nil, nil
}

// jsToFixed 严格复刻 ES2023 Number.prototype.toFixed，返回字符串。
//
// 🔒 SYNC-A43（2026-10-13）：旧实现"先乘 scale 再判半值"与规范不符。规范要求
// 对 **x 的双精度精确值**求 n/10^f 的最近整数，并列时取较大 n（等价于绝对值 half-up）。
// Node 实测反例：
//
//	(1.045).toFixed(2)   => "1.04"   （Go 旧实现给 "1.05"）
//	(2.675).toFixed(2)   => "2.67"   （旧 "2.68"）
//	(8.575).toFixed(2)   => "8.57"   （旧 "8.58"）
//	(-0.001).toFixed(2)  => "-0.00"  （旧 "0.00"，丢了符号）
//	(-0.125).toFixed(2)  => "-0.13"  （旧可能 "-0.12"）
//
// 根因：1.045*100 在 IEEE754 下**恰好舍入成 104.5**，于是 diff==0.5 走进位分支；
// 而规范是拿 x 的精确值（double(1.045) 略小于 1.045）去比，结论相反。
//
// 实现：用 big.Rat 取 x 的精确值，精确乘 10^n 后做整数除 + 余数半值判定。
// 顺带修掉旧实现的 int64 溢出（|x*scale| ≥ 2^63 时 Go 转换未定义）。
func jsToFixed(x float64, n int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	// ⚠ IsInf(x, 0) 同时匹配**正负**无穷（sign 参数为 0 表示"忽略符号"），
	//   所以下面必须用 Signbit 区分，不能先写 IsInf(x,0) 再写 IsInf(x,-1)
	//   —— 后者永远不可达（负无穷会在第一分支就返回 "Infinity"）。
	//   Node 实测：(-Infinity).toFixed(2) === "-Infinity"
	if math.IsInf(x, 0) {
		if math.Signbit(x) {
			return "-Infinity"
		}
		return "Infinity"
	}
	// 规范步骤 1/2：符号单独取出，对 |x| 运算（-0 不算负）
	// ⚠ 必须用 math.Signbit 而非 `x < 0`：负无穷 `-Inf < 0` 为 false
	//   ⇒ 旧写法会让 (-Infinity).toFixed(2) 输出 "Infinity"（丢了负号）。
	//   Node 实测：(-Infinity).toFixed(2) === "-Infinity"
	neg := math.Signbit(x)
	if neg {
		x = -x
	}

	// 规范步骤 5-8：对 |x| 求最接近的 n/10^f 的整数 n，并列取大
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
	// SetFloat64 对 0 返回 0/1（精确值，无浮点误差）
	r := new(big.Rat).SetFloat64(x)
	num := new(big.Int)
	if r != nil {
		r.Mul(r, new(big.Rat).SetInt(pow))
		q := new(big.Int)
		rem := new(big.Int)
		q.QuoRem(r.Num(), r.Denom(), rem)
		num = q
		// rem 与 Den 同号（Go 的 QuoRem 保证 rem 符号跟随分子）⇒ rem >= 0
		// 判定 rem/den >= 1/2 ⇔ 2*rem >= den
		if new(big.Int).Lsh(new(big.Int).Abs(rem), 1).Cmp(r.Denom()) >= 0 {
			num.Add(num, big.NewInt(1))
		}
	}

	s := num.String()
	if n > 0 {
		for len(s) <= n {
			s = "0" + s
		}
		s = s[:len(s)-n] + "." + s[len(s)-n:]
	}
	if neg {
		return "-" + s
	}
	return s
}
