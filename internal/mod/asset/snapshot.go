package asset

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/account"
	"live/api/internal/mod/creditcore"
	"live/api/internal/tim"
)

// ============================================================================
// 资产快照模型 —— from: model/snapshot.js（SQL 逐字一致）
// keep BUG-024：现金聚合 LEFT JOIN 后 `c.card_type != 'credit'` 把卡片已删的行也滤掉，
// 卡片删除后其余额漏算，维持原样。
// ============================================================================

// snapshotTable 对应 AssetSnapshot.tableName = 'asset_snapshot'。
const snapshotTable = "asset_snapshot"

func init() {
	// 对应 Node account/credit.js、account/debit.js、card/repay.js 内
	// require('../../asset/model/snapshot').autoSaveSnapshot(userId)（反向依赖，避免循环）。
	account.AutoSaveSnapshotHook = func(userID string) {
		_ = autoSaveSnapshot(userID)
	}
}

// formatLocalDate 对应 AssetSnapshot.formatLocalDate：本地 YYYY-MM-DD。
func formatLocalDate(t time.Time) string {
	t = t.In(tim.Loc())
	return fmt.Sprintf("%04d-%02d-%02d", t.Year(), int(t.Month()), t.Day())
}

// formatLocalDateTime 对应 AssetSnapshot.formatLocalDateTime：本地 YYYY-MM-DD HH:mm:ss。
func formatLocalDateTime(t time.Time) string {
	t = t.In(tim.Loc())
	return fmt.Sprintf("%04d-%02d-%02d %02d:%02d:%02d",
		t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second())
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
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

// ===== 计算 =====

// CalculateCurrentAssets 对应 AssetSnapshot.calculateCurrentAssets。
// from: asset/model/snapshot.js:29-55
func CalculateCurrentAssets(userID string) (totalAsset, creditDebt, finalBalance float64, err error) {
	// 计算现金类资产总和（account_balance，排除信用卡）
	// keep BUG-024：LEFT JOIN 后过滤右表字段，卡片已删的行（c.* 全 NULL）同样被滤掉
	row, err := qRow(db.DB(), `
      SELECT COALESCE(SUM(balance), 0) as total 
      FROM account_balance ab
      LEFT JOIN card_base c ON ab.card_id = c.id
      WHERE ab.user_id = ? AND ab.is_deleted = 0 AND c.card_type != 'credit'`, userID)
	if err != nil {
		return 0, 0, 0, err
	}
	totalBalance := toF(row["total"])

	// 信用卡待还/溢缴款：统一 CreditCore.aggregate 口径（H10 审计）
	agg, err := creditcore.Aggregate(db.DB(), userID)
	if err != nil {
		return 0, 0, 0, err
	}
	creditDebt = toF(agg["totalDebt"])
	creditOverflow := toF(agg["totalOverflow"])

	// 总资产 = 现金 + 信用卡溢缴款
	totalAsset = totalBalance + math.Max(0, creditOverflow)
	// 最终余额 = 总资产 - 信用卡欠款
	finalBalance = totalAsset - creditDebt
	return totalAsset, creditDebt, finalBalance, nil
}

// autoSaveSnapshot 对应 AssetSnapshot.autoSaveSnapshot：每日最多1条，仅数值变化时记录。
// Node 内部 try/catch 吞错返回 null，此处维持原样（错误不向上传播）。
// from: asset/model/snapshot.js:61-107
func autoSaveSnapshot(userID string) error {
	today := formatLocalDate(tim.Now())

	// 1. 检查今日是否已有记录
	todayRecords, err := qRows(db.DB(), `
      SELECT * FROM `+snapshotTable+` 
      WHERE user_id = ? AND record_date = ? AND is_deleted = 0
      ORDER BY create_time DESC LIMIT 1`, userID, today)
	if err != nil {
		return err
	}
	if len(todayRecords) > 0 {
		return nil
	}

	// 2. 计算当前资产
	totalAsset, creditDebt, finalBalance, err := CalculateCurrentAssets(userID)
	if err != nil {
		return err
	}

	// 3. 对比昨日数值（允许误差0.01）
	yesterdayRecords, err := qRows(db.DB(), `
      SELECT * FROM `+snapshotTable+` 
      WHERE user_id = ? AND record_date < ? AND is_deleted = 0
      ORDER BY record_date DESC LIMIT 1`, userID, today)
	if err != nil {
		return err
	}
	if len(yesterdayRecords) > 0 {
		last := yesterdayRecords[0]
		diff1 := math.Abs(toF(last["total_asset"]) - totalAsset)
		diff2 := math.Abs(toF(last["credit_debt"]) - creditDebt)
		diff3 := math.Abs(toF(last["total_balance"]) - finalBalance)
		if diff1 < 0.01 && diff2 < 0.01 && diff3 < 0.01 {
			// 资产数值未变化，跳过
			return nil
		}
	}

	// 4. 写入快照
	_, err = SaveSnapshot(userID, totalAsset, creditDebt, finalBalance)
	return err
}

// SaveSnapshot 保存快照（仅当与上次记录不同时）。
// from: asset/model/snapshot.js:112-158
func SaveSnapshot(userID string, totalAsset, creditDebt, totalBalance float64) (map[string]any, error) {
	now := tim.NowMS()
	today := formatLocalDate(tim.Now())

	// 查询今天最后一条记录
	existing, err := qRows(db.DB(), `
      SELECT * FROM `+snapshotTable+` 
      WHERE user_id = ? AND record_date = ? AND is_deleted = 0
      ORDER BY create_time DESC LIMIT 1`, userID, today)
	if err != nil {
		return nil, err
	}

	// 如果今天的值与上次相同，不重复记录
	if len(existing) > 0 {
		last := existing[0]
		if math.Abs(toF(last["total_asset"])-totalAsset) < 0.01 &&
			math.Abs(toF(last["credit_debt"])-creditDebt) < 0.01 &&
			math.Abs(toF(last["total_balance"])-totalBalance) < 0.01 {
			// 今日数值未变，跳过记录
			return last, nil
		}
	}

	// 写入新快照
	id := idgen.BillID()
	recordTime := formatLocalDateTime(tim.Now())

	_, err = db.DB().Exec(`
      INSERT INTO `+snapshotTable+` 
      (id, user_id, total_asset, credit_debt, total_balance, record_date, record_time, create_time, update_time, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, userID, totalAsset, creditDebt, totalBalance, today, recordTime, now, now)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"id":            id,
		"total_asset":   totalAsset,
		"credit_debt":   creditDebt,
		"total_balance": totalBalance,
		"record_date":   today,
		"record_time":   recordTime,
		"create_time":   now,
		"update_time":   now,
	}, nil
}

// GetLatest 获取最新快照（附加实时计算数据）；没有快照时自动立即创建一条。
// from: asset/model/snapshot.js:164-211
func GetLatest(userID string) (map[string]any, error) {
	// 获取最新快照记录
	rows, err := qRows(db.DB(), `
      SELECT * FROM `+snapshotTable+` 
      WHERE user_id = ? AND is_deleted = 0
      ORDER BY create_time DESC LIMIT 1`, userID)
	if err != nil {
		return nil, err
	}

	var snapshot map[string]any
	if len(rows) > 0 {
		snapshot = rows[0]
	} else {
		// 无快照记录，立即创建
		snapshot, err = createSnapshotNow(userID)
		if err != nil {
			return nil, err
		}
	}

	// 实时计算当前资产数据（确保与信用卡账单页数据一致）
	totalAsset, creditDebt, finalBalance, err := CalculateCurrentAssets(userID)
	if err != nil {
		return nil, err
	}

	// 计算实时统计数据
	realtime, err := calculateRealtimeStats(userID)
	if err != nil {
		return nil, err
	}

	// 获取近期大额流水
	largeTransactions, err := getRecentLargeTransactions(userID, 10)
	if err != nil {
		return nil, err
	}

	// 获取待还账单明细
	pendingBills, err := getPendingBills(userID)
	if err != nil {
		return nil, err
	}

	// 返回实时数据（不依赖快照的历史值）
	return map[string]any{
		"total_asset":       totalAsset,
		"credit_debt":       creditDebt,
		"total_balance":     finalBalance,
		"record_date":       snapshot["record_date"],
		"record_time":       snapshot["record_time"],
		"debitCardCount":    realtime["debitCardCount"],
		"creditCardCount":   realtime["creditCardCount"],
		"creditDebt":        realtime["creditDebt"],
		"monthIncome":       realtime["monthIncome"],
		"monthExpense":      realtime["monthExpense"],
		"monthBalance":      realtime["monthBalance"],
		"todayIncome":       realtime["todayIncome"],
		"todayExpense":      realtime["todayExpense"],
		"largeTransactions": largeTransactions,
		"pendingBills":      pendingBills,
	}, nil
}

// createSnapshotNow 对应 AssetSnapshot.createSnapshotNow。
// from: asset/model/snapshot.js:216-219
func createSnapshotNow(userID string) (map[string]any, error) {
	totalAsset, creditDebt, finalBalance, err := CalculateCurrentAssets(userID)
	if err != nil {
		return nil, err
	}
	return SaveSnapshot(userID, totalAsset, creditDebt, finalBalance)
}

// calculateRealtimeStats 对应 AssetSnapshot.calculateRealtimeStats。
// from: asset/model/snapshot.js:224-310
func calculateRealtimeStats(userID string) (map[string]any, error) {
	now := tim.Now()
	year := now.Year()
	month := int(now.Month())
	today := formatLocalDate(now)
	startDate := fmt.Sprintf("%04d-%02d-01", year, month)
	nextMonth := month + 1
	nextYear := year
	if month == 12 {
		nextMonth, nextYear = 1, year+1
	}
	monthEndDate := fmt.Sprintf("%04d-%02d-01", nextYear, nextMonth)

	// 1. 借记卡数量（排除虚拟账户 xxxx, yyyy）
	debitRow, err := qRow(db.DB(), `
      SELECT COUNT(*) as count FROM card_base 
      WHERE user_id = ? AND is_deleted = 0 
      AND card_type != 'credit' AND id NOT IN ('xxxx', 'yyyy')`, userID)
	if err != nil {
		return nil, err
	}
	debitCardCount := toF(debitRow["count"])

	// 2. 信用卡数量（排除虚拟账户）
	creditRow, err := qRow(db.DB(), `
      SELECT COUNT(*) as count FROM card_base 
      WHERE user_id = ? AND is_deleted = 0 
      AND card_type = 'credit' AND id NOT IN ('xxxx', 'yyyy')`, userID)
	if err != nil {
		return nil, err
	}
	creditCardCount := toF(creditRow["count"])

	// 3. 信用卡代还金额（统一 CreditCore 口径，覆盖全部账单月，H10 审计）
	agg, err := creditcore.Aggregate(db.DB(), userID)
	if err != nil {
		return nil, err
	}
	creditDebt := toF(agg["totalDebt"])

	// 4. 本月统计（收入 - 支出，排除信用卡还款）
	monthIncome, monthExpense, err := sumByDirection(userID,
		`SELECT direction, SUM(amount) as total
      FROM account
      WHERE user_id = ? AND is_deleted = 0 
        AND trans_date >= ? AND trans_date < ?
        AND NOT (direction = 0 AND category_id = 'CATEGORY_REPAY')
      GROUP BY direction`, userID, startDate, monthEndDate)
	if err != nil {
		return nil, err
	}
	monthBalance := monthIncome - monthExpense

	// 5. 今日收支
	todayIncome, todayExpense, err := sumByDirection(userID,
		`SELECT direction, SUM(amount) as total
      FROM account
      WHERE user_id = ? AND is_deleted = 0 
        AND trans_date = ?
        AND NOT (direction = 0 AND category_id = 'CATEGORY_REPAY')
      GROUP BY direction`, userID, today)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"debitCardCount":  debitCardCount,
		"creditCardCount": creditCardCount,
		"creditDebt":      creditDebt,
		"monthIncome":     monthIncome,
		"monthExpense":    monthExpense,
		"monthBalance":    monthBalance,
		"todayIncome":     todayIncome,
		"todayExpense":    todayExpense,
	}, nil
}

// sumByDirection 对应 monthRows/todayRows 的 forEach 汇总：
// direction === 1 → income；direction === 0 → expense。
func sumByDirection(_ string, query string, args ...any) (income, expense float64, err error) {
	rows, err := qRows(db.DB(), query, args...)
	if err != nil {
		return 0, 0, err
	}
	for _, row := range rows {
		switch toF(row["direction"]) {
		case 1:
			income = toF(row["total"])
		case 0:
			expense = toF(row["total"])
		}
	}
	return income, expense, nil
}

// getRecentLargeTransactions 获取一周内金额最大的流水（收支 + 信用卡还款，取前10名）。
// from: asset/model/snapshot.js:315-340
func getRecentLargeTransactions(userID string, limit int) ([]map[string]any, error) {
	// 计算一周前日期
	weekAgoStr := formatLocalDate(tim.Now().Add(-7 * 24 * time.Hour))

	// 排除信用卡还款（category_id = 'CATEGORY_REPAY'）
	accountRows, err := qRows(db.DB(), `
      SELECT id, card_id, direction, amount, category_id, pay_type, trans_date, remark, create_time
      FROM account
      WHERE user_id = ? AND is_deleted = 0 AND trans_date >= ?
        AND NOT (direction = 0 AND category_id = 'CATEGORY_REPAY')
      ORDER BY amount DESC LIMIT ?`, userID, weekAgoStr, limit)
	if err != nil {
		return nil, err
	}

	allRows := make([]map[string]any, 0, len(accountRows))
	for _, r := range accountRows {
		out := make(map[string]any, len(r)+1)
		for k, v := range r {
			out[k] = v
		}
		out["type"] = "account"
		allRows = append(allRows, out)
	}

	// allRows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
	sortByAmountDesc(allRows)
	if len(allRows) > limit {
		allRows = allRows[:limit]
	}
	return allRows, nil
}

func sortByAmountDesc(rows []map[string]any) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && toF(rows[j]["amount"]) > toF(rows[j-1]["amount"]); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}

// getPendingBills 获取本月待还账单明细（need_repay > 0 的当前账单月）。
// from: asset/model/snapshot.js:345-376
func getPendingBills(userID string) ([]map[string]any, error) {
	now := tim.Now()
	currentMonth := fmt.Sprintf("%04d-%02d", now.Year(), int(now.Month()))
	rows, err := qRows(db.DB(), `
      SELECT cb.id, cb.card_id, cb.bill_month, cb.bill_amount, cb.min_repay,
              cb.repaid, cb.need_repay, cb.repay_status, cb.is_overdue,
              cb.overdue_days, cb.bill_end_date, cb.update_time,
              c.alias as card_alias, c.last4_no as card_last4
       FROM card_bill cb
       LEFT JOIN card_base c ON cb.card_id = c.id
       WHERE cb.user_id = ? AND cb.is_deleted = 0
         AND c.card_type = 'credit' AND cb.need_repay > 0
         AND cb.bill_month = ?
       ORDER BY cb.bill_end_date ASC`, userID, currentMonth)
	if err != nil {
		return nil, err
	}

	out := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]any{
			"id":            r["id"],
			"card_id":       r["card_id"],
			"card_alias":    r["card_alias"],
			"card_last4":    r["card_last4"],
			"bill_month":    r["bill_month"],
			"bill_amount":   toF(r["bill_amount"]),
			"min_repay":     toF(r["min_repay"]),
			"repaid":        toF(r["repaid"]),
			"need_repay":    toF(r["need_repay"]),
			"repay_status":  r["repay_status"],
			"is_overdue":    truthyJS(r["is_overdue"]),
			"overdue_days":  orJS(r["overdue_days"], 0),
			"bill_end_date": r["bill_end_date"],
		})
	}
	return out, nil
}

// GetRecent 获取最近N条快照。from: asset/model/snapshot.js:381-389
func GetRecent(userID string, limit int) ([]map[string]any, error) {
	return qRows(db.DB(), `
      SELECT * FROM `+snapshotTable+` 
      WHERE user_id = ? AND is_deleted = 0
      ORDER BY record_date DESC LIMIT ?`, userID, limit)
}

// GetByDateRange 获取指定日期范围的快照。from: asset/model/snapshot.js:394-403
func GetByDateRange(userID, startDate, endDate string) ([]map[string]any, error) {
	return qRows(db.DB(), `
      SELECT * FROM `+snapshotTable+` 
      WHERE user_id = ? AND is_deleted = 0 
        AND record_date >= ? AND record_date <= ?
      ORDER BY record_date ASC`, userID, startDate, endDate)
}

// ===== 行 → map 工具（私有副本） =====

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

// truthyJS 对应 JS 真值判断（!!r.is_overdue：非空字符串含 "0" 皆真）。
func truthyJS(v any) bool {
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
	}
	return true
}

// orJS 对应 r.overdue_days || 0。
func orJS(v any, def any) any {
	if truthyJS(v) {
		return v
	}
	return def
}
