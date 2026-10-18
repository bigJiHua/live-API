package todo

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/mod/cardbill"
	"live/api/internal/tim"
)

// ============================================================================
// recurring 日历事件复刻 —— 来源：src/modules/recurring/model/index.js
// （recurring 模块尚未创建，按任务要求将 getCalendarEvents /
//  getUpcomingRemindersCurrentMonth 依赖的查询与装饰逻辑在 todo 包内等价复刻，
//  供 calendarMonth / reminders 两个接口合并 recurring + cardBill 事件使用）
//
// 复刻范围（与 Node 逐行对应）：
//   - findAll                       → recurringFindAll
//   - attachMonthInfo/getMonthRecord/getMonthDate/daysInMonth
//   - decorateRowsForCalendar       → recurringDecorateRowsForCalendar
//   - voidExpiredInstallments/updateMonthRecords
//   - resolvePlanDate/canEnterNow/isEnterExpired/resolveBillMonth
//   - decorateInstallmentStatus     → recurringDecorateInstallmentStatus（keep BUG-039）
//   - toCalendarEvent
//   - getCalendarEvents             → recurringCalendarEvents
//   - getUpcomingRemindersCurrentMonth → recurringUpcomingRemindersCurrentMonth
// ============================================================================

// INSTALLMENT_GRACE_DAYS 对应 recurring/model/index.js:15：Number(env) || 30。
func installmentGraceDays() int {
	return envGraceDays()
}

// recurringToday 对应 RecurringExpense.today()：北京时间 YYYY-MM-DD。
func recurringToday() string { return tim.BeijingToday() }

// recurringNow 对应 RecurringExpense.now()：Date.now().toString()。
func recurringNow() string { return tim.NowMS() }

// parseMonthRecords 对应 RecurringExpense.parseMonthRecords：raw 为空 → {}；
// 解析失败 → {}（Node catch 分支）。UseNumber 保持数字精度。
func parseMonthRecords(raw any) map[string]any {
	s, ok := raw.(string)
	if !ok || s == "" {
		if m, ok := raw.(map[string]any); ok {
			return m
		}
		return map[string]any{}
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

// normalizeMonth 对应 RecurringExpense.normalizeMonth：非 YYYY-MM 抛错。
func normalizeMonth(month string) (string, error) {
	if len(month) == 7 && month[4] == '-' &&
		isDigits(month[:4]) && isDigits(month[5:]) {
		return month, nil
	}
	return "", fmt.Errorf("月份格式应为 YYYY-MM")
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// daysInMonth 对应 RecurringExpense.daysInMonth：new Date(y, m, 0).getDate()。
func daysInMonth(month string) int {
	parts := strings.Split(month, "-")
	if len(parts) < 2 {
		return 0
	}
	y, errY := strconv.Atoi(parts[0])
	m, errM := strconv.Atoi(parts[1])
	if errY != nil || errM != nil {
		return 0
	}
	return time.Date(y, time.Month(m)+1, 0, 0, 0, 0, 0, tim.Loc()).Day()
}

// getMonthDate 对应 RecurringExpense.getMonthDate：day_of_cycle 夹到当月天数。
// day = Math.max(1, Number(row.day_of_cycle || 1))
func getMonthDate(row map[string]any, month string) string {
	day := int(jsNumber(orJS(row["day_of_cycle"], 1)))
	if day < 1 {
		day = 1
	}
	safeDay := day
	if d := daysInMonth(month); safeDay > d {
		safeDay = d
	}
	return fmt.Sprintf("%s-%02d", month, safeDay)
}

// getMonthRecord 对应 RecurringExpense.getMonthRecord。
func getMonthRecord(row map[string]any, month string) map[string]any {
	rec := map[string]any{}
	if m, ok := parseMonthRecords(row["month_records"])[month].(map[string]any); ok {
		rec = m
	}
	out := map[string]any{
		"month":       month,
		"remind_time": nil,
		"done_time":   nil,
		"remark":      "",
	}
	// status: record.status || "pending"
	out["status"] = "pending"
	if s, ok := rec["status"].(string); ok && s != "" {
		out["status"] = s
	}
	// amount: record.amount !== undefined ? record.amount : row.amount
	amount := row["amount"]
	if v, ok := rec["amount"]; ok && v != nil {
		amount = v
	}
	out["amount"] = amount
	if v, ok := rec["remind_time"]; ok && v != nil {
		out["remind_time"] = v
	}
	if v, ok := rec["done_time"]; ok && v != nil {
		out["done_time"] = v
	}
	if v, ok := rec["remark"]; ok && v != nil {
		out["remark"] = v
	}
	// 🔒 SYNC-A29（2026-10-12）：**删除**装饰字段透传
	//   （effectiveStatus/overdue/plan_date/bill_month）。
	//   Node 的 getMonthRecord 只返回 5 个固定键
	//   （recurring/model/index.js:76-87），不带这四个。原 Go 额外透传后，
	//   attachMonthInfo 的 `record.effectiveStatus || record.status`
	//   会被覆盖 —— 「已入账且账单已还清」的分期在待办日历/提醒里显示成
	//   「已完成」，而 Node 显示「已入账」。以 Node 为准。
	return out
}

// attachMonthInfo 对应 RecurringExpense.attachMonthInfo：在原行上叠加月份维度字段。
func attachMonthInfo(row map[string]any, month string) map[string]any {
	record := getMonthRecord(row, month)
	happenDate := getMonthDate(row, month)
	effStatus := "pending"
	if s, ok := record["status"].(string); ok {
		effStatus = s
	}
	if s, ok := record["effectiveStatus"].(string); ok && s != "" {
		effStatus = s
	}

	out := make(map[string]any, len(row)+9)
	for k, v := range row {
		out[k] = v
	}
	out["amount"] = jsNumber(orJS(row["amount"], float64(0)))
	out["month"] = month
	out["happen_date"] = happenDate
	out["month_status"] = effStatus
	out["month_overdue"] = truthyJS(record["overdue"])
	out["month_amount"] = jsNumber(orJS(record["amount"], row["amount"]))
	out["month_record"] = record
	out["month_records"] = parseMonthRecords(row["month_records"])
	out["is_done"] = effStatus == "done"
	out["is_skipped"] = record["status"] == "skipped"
	out["is_due"] = happenDate <= recurringToday()
	return out
}

// toCalendarEvent 对应 RecurringExpense.toCalendarEvent；返回 nil 对应 Node null。
func toCalendarEvent(row map[string]any, month string) map[string]any {
	repeatCount := jsInt(row["repeat_count"])
	if repeatCount != 0 {
		records := parseMonthRecords(row["month_records"])
		sortedMonths := sortedKeys(records)
		idx := indexOf(sortedMonths, month)
		if idx == -1 || idx >= repeatCount {
			return nil
		}
	}

	item := attachMonthInfo(row, month)
	// 已中止(void)的分期期次不再在日历体现
	if item["month_status"] == "void" {
		return nil
	}
	statusMap := map[string]string{
		"done": "已完成", "skipped": "已取消", "pending": "待完成",
		"entered": "已入账", "void": "已中止",
	}

	// 分期：追加第N/M期
	content := toStrJS(item["name"])
	if repeatCount != 0 {
		records := parseMonthRecords(row["month_records"])
		sortedMonths := sortedKeys(records)
		periodIdx := indexOf(sortedMonths, month)
		if periodIdx >= 0 {
			content = fmt.Sprintf("%s 第%d/%d期", toStrJS(item["name"]), periodIdx+1, repeatCount)
		}
	}

	status := statusMap[toStrJS(item["month_status"])]
	if status == "" {
		status = "待完成"
	}
	isRecurring := 0
	if toStrJS(item["cycle"]) == "year" {
		isRecurring = 1
	}
	cycle := toStrJS(item["cycle"])
	if cycle == "" {
		cycle = "month"
	}

	return map[string]any{
		"id":               "recurring_" + toStrJS(item["id"]) + "_" + month,
		"source":           "recurring",
		"recurring_id":     item["id"],
		"content":          content,
		"event_type":       "fixed_expense",
		"happen_date":      item["happen_date"],
		"status":           status,
		"priority":         2,
		"need_remind":      1,
		"is_recurring":     isRecurring,
		"cycle":            cycle,
		"amount":           item["month_amount"],
		"category_id":      item["category_id"],
		"category_name":    orStrJS(item["category_name"], ""),
		"remark":           orStrJS(item["remark"], ""),
		"month_status":     item["month_status"],
		"month_overdue":    item["month_overdue"],
		"is_fixed_expense": true,
	}
}

// recurringFindAll 对应 RecurringExpense.findAll(userId, {month, includeInactive:false})。
// from: recurring/model/index.js:155-201
func recurringFindAll(ex db.Commiter, userID, month string) ([]map[string]any, error) {
	rows, err := qRows(ex, `
       SELECT r.*, c.name AS category_name, cb.alias AS account_name, cb.last4_no AS account_last4, cb.card_type
       FROM bus_recurring r
       LEFT JOIN bus_category c ON r.category_id = c.id AND c.is_deleted = 0
       LEFT JOIN card_base cb ON r.account_id = cb.id AND cb.is_deleted = 0
       WHERE r.user_id = ? AND r.is_deleted = 0 AND r.is_active = 1
       ORDER BY r.is_active DESC, r.day_of_cycle ASC, r.create_time DESC`, userID)
	if err != nil {
		return nil, err
	}

	// 按年周期过滤：只返回匹配月份的项
	filtered := rows
	if month != "" {
		safeMonth, err := normalizeMonth(month)
		if err != nil {
			return nil, err
		}
		monthNum, _ := strconv.Atoi(safeMonth[5:])
		filtered = []map[string]any{}
		for _, row := range rows {
			// 截止日期（end_date）判断（与 Node 一致）
			if ed := toStrJS(row["end_date"]); ed != "" {
				if ed < recurringToday() {
					continue
				}
				if ed[:min(7, len(ed))] < safeMonth {
					continue
				}
			}
			if toStrJS(row["cycle"]) == "year" && truthyJS(row["month_of_cycle"]) {
				if jsNumber(row["month_of_cycle"]) != float64(monthNum) {
					continue
				}
			}
			filtered = append(filtered, row)
		}
	}
	return filtered, nil
}

// recurringDecorateRowsForCalendar 对应 RecurringExpense.decorateRowsForCalendar。
// from: recurring/model/index.js:505-520
func recurringDecorateRowsForCalendar(ex db.Commiter, rows []map[string]any) {
	for _, row := range rows {
		acc := parseAccountInfo(row["account_id"])
		if t, _ := acc["type"].(string); t != "installment" {
			continue
		}
		// 读取即写库：把已过期且未入账的期次标记为 void；装饰失败不影响日历主流程
		voidExpiredInstallments(ex, row)
		decorated := decorateInstallmentStatus(ex, row)
		row["month_records"] = mustJSONString(decorated)
	}
}

// parseAccountInfo 对应 RecurringExpense.parseAccountInfo：JSON.parse(raw || "{}") || {}。
func parseAccountInfo(raw any) map[string]any {
	s := toStrJS(raw)
	if s == "" {
		return map[string]any{}
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

// voidExpiredInstallments 对应 RecurringExpense.voidExpiredInstallments。
// from: recurring/model/index.js:799-826
func voidExpiredInstallments(ex db.Commiter, row map[string]any) bool {
	if jsInt(row["repeat_count"]) == 0 {
		return false
	}
	records := parseMonthRecords(row["month_records"])
	mutated := false
	for _, month := range sortedKeys(records) {
		rec, ok := records[month].(map[string]any)
		if !ok {
			continue
		}
		s := toStrJS(rec["status"])
		if s != "pending" && !(s == "entering" && toStrJS(rec["remark"]) == "") {
			continue
		}
		if isEnterExpired(row, month, records) {
			// {...rec, status:"void", remark:"超过期限，自动作废", done_time:...}：保留其余字段
			next := make(map[string]any, len(rec)+3)
			for k, v := range rec {
				next[k] = v
			}
			next["status"] = "void"
			next["remark"] = "超过期限，自动作废"
			next["done_time"] = tim.BeijingNow().Format("2006-01-02 15:04:05")
			records[month] = next
			mutated = true
		}
	}
	if mutated {
		updateMonthRecords(ex, toStrJS(row["id"]), toStrJS(row["user_id"]), records)
	}
	return mutated
}

// updateMonthRecords 对应 RecurringExpense.updateMonthRecords。
// from: recurring/model/index.js:587-592
func updateMonthRecords(ex db.Commiter, id, userID string, records map[string]any) {
	_, _ = ex.Exec(
		`UPDATE bus_recurring SET month_records = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		mustJSONString(records), recurringNow(), id, userID)
}

// resolvePlanDate 对应 RecurringExpense.resolvePlanDate：返回北京时间入账日 YYYY-MM-DD。
// from: recurring/model/index.js:609-619
func resolvePlanDate(row map[string]any, month string, records map[string]any) string {
	if rec, ok := records[month].(map[string]any); ok {
		if pd := toStrJS(rec["plan_date"]); pd != "" {
			if t, err := time.ParseInLocation("2006-01-02", pd, tim.Loc()); err == nil {
				return t.Format("2006-01-02")
			}
		}
	}
	acc := parseAccountInfo(row["account_id"])
	billingDay := 1
	if v := jsNumber(acc["billing_day"]); !isNaN(v) && v != 0 {
		billingDay = int(v)
	}
	targetMonth, err := time.ParseInLocation("2006-01-02", month+"-01", tim.Loc())
	if err != nil {
		return month + "-01"
	}
	day := billingDay + 1
	if d := daysInMonth(month); day > d {
		day = d
	}
	return targetMonth.AddDate(0, 0, day-1).Format("2006-01-02")
}

// canEnterNow 对应 RecurringExpense.canEnterNow：plan_date <= 今天 <= plan_date+宽限。
// from: recurring/model/index.js:625-629
func canEnterNow(row map[string]any, month string, records map[string]any) bool {
	planDate, err := time.ParseInLocation("2006-01-02", resolvePlanDate(row, month, records), tim.Loc())
	if err != nil {
		return false
	}
	today := tim.BeijingNow()
	return !today.Before(planDate) && !today.After(planDate.AddDate(0, 0, installmentGraceDays()))
}

// isEnterExpired 对应 RecurringExpense.isEnterExpired：今天 > plan_date+宽限 → 作废。
// from: recurring/model/index.js:634-638
func isEnterExpired(row map[string]any, month string, records map[string]any) bool {
	planDate, err := time.ParseInLocation("2006-01-02", resolvePlanDate(row, month, records), tim.Loc())
	if err != nil {
		return false
	}
	return tim.BeijingNow().After(planDate.AddDate(0, 0, installmentGraceDays()))
}

// resolveBillMonth 对应 RecurringExpense.resolveBillMonth：
// 复用 CardBill.getBillMonthByDate（plan_date 的月/日 + billing_day）。
// from: recurring/model/index.js:643-649
func resolveBillMonth(row map[string]any, month string, records map[string]any) string {
	acc := parseAccountInfo(row["account_id"])
	billingDay := 1
	if v := jsNumber(acc["billing_day"]); !isNaN(v) && v != 0 {
		billingDay = int(v)
	}
	return cardbill.GetBillMonthByDate(resolvePlanDate(row, month, records), billingDay)
}

// decorateInstallmentStatus 对应 RecurringExpense.decorateInstallmentStatus：
// entered 期若归属账单已还清(need_repay<=0.01) 则视为 done。
// keep BUG-039：need_repay 为 NULL 时 parseFloat=NaN，NaN<=0.01 为 false →
// 永远显示未还清（entered），维持原样。
// from: recurring/model/index.js:877-928
func decorateInstallmentStatus(ex db.Commiter, row map[string]any) map[string]any {
	records := parseMonthRecords(row["month_records"])
	acc := parseAccountInfo(row["account_id"])
	cardID := toStrJS(acc["card_id"])
	// 补齐每期的计划入账日与归属账单月（存量数据用回退算法补齐），仅展示不写库
	for _, month := range sortedKeys(records) {
		rec, ok := records[month].(map[string]any)
		if !ok {
			rec = map[string]any{}
			records[month] = rec
		}
		if toStrJS(rec["plan_date"]) == "" {
			rec["plan_date"] = resolvePlanDate(row, month, records)
		}
		if toStrJS(rec["bill_month"]) == "" {
			rec["bill_month"] = resolveBillMonth(row, month, records)
		}
	}
	if cardID == "" {
		return records
	}
	enteredMonths := []string{}
	for _, month := range sortedKeys(records) {
		rec, _ := records[month].(map[string]any)
		if toStrJS(rec["status"]) == "entered" {
			enteredMonths = append(enteredMonths, month)
		}
	}
	if len(enteredMonths) == 0 {
		return records
	}
	monthToBillMonth := map[string]string{}
	billMonths := []string{}
	for _, month := range enteredMonths {
		bm := resolveBillMonth(row, month, records)
		monthToBillMonth[month] = bm
		billMonths = append(billMonths, bm)
	}

	ph := strings.Repeat("?,", len(billMonths))
	ph = ph[:len(ph)-1]
	params := []any{cardID, toStrJS(row["user_id"])}
	for _, m := range billMonths {
		params = append(params, m)
	}
	billRows, err := qRows(ex,
		`SELECT bill_month, need_repay, is_overdue FROM card_bill WHERE card_id = ? AND user_id = ? AND bill_month IN (`+ph+`) AND is_deleted = 0`,
		params...)
	if err != nil {
		return records
	}
	billMap := map[string]map[string]any{}
	for _, b := range billRows {
		billMap[toStrJS(b["bill_month"])] = b
	}
	for _, month := range enteredMonths {
		rec := records[month].(map[string]any)
		b, ok := billMap[monthToBillMonth[month]]
		var nr float64
		hasNR := false
		if ok {
			if v, exists := b["need_repay"]; exists && v != nil {
				n := jsParseFloatLoose(toStrJS(v))
				if !isNaN(n) {
					nr, hasNR = n, true
				}
			}
		}
		overdue := ok && truthyJS(b["is_overdue"])
		// keep BUG-039：nr 为 NaN（need_repay=NULL）时 NaN<=0.01 为 false → entered
		rec["effectiveStatus"] = "entered"
		if hasNR && nr <= 0.01 {
			rec["effectiveStatus"] = "done"
		}
		rec["overdue"] = rec["effectiveStatus"] == "entered" && overdue
	}
	return records
}

// recurringCalendarEvents 对应 RecurringExpense.getCalendarEvents(userId, year, monthNo)。
// from: recurring/model/index.js:522-527
func recurringCalendarEvents(ex db.Commiter, userID string, year, monthNo int) ([]map[string]any, error) {
	month := fmt.Sprintf("%04d-%02d", year, monthNo)
	rows, err := recurringFindAll(ex, userID, month)
	if err != nil {
		return nil, err
	}
	recurringDecorateRowsForCalendar(ex, rows)
	out := []map[string]any{}
	for _, row := range rows {
		if ev := toCalendarEvent(row, month); ev != nil {
			out = append(out, ev)
		}
	}
	return out, nil
}

// recurringUpcomingRemindersCurrentMonth 对应
// RecurringExpense.getUpcomingRemindersCurrentMonth(userId, {month})。
// from: recurring/model/index.js:562-577
func recurringUpcomingRemindersCurrentMonth(ex db.Commiter, userID string, month string) ([]map[string]any, error) {
	if month == "" {
		month = tim.BeijingMonth()
	}
	rows, err := recurringFindAll(ex, userID, month)
	if err != nil {
		return nil, err
	}
	recurringDecorateRowsForCalendar(ex, rows)
	result := []map[string]any{}
	for _, row := range rows {
		ev := toCalendarEvent(row, month)
		if ev == nil {
			continue
		}
		hd := toStrJS(ev["happen_date"])
		if hd >= month+"-01" && hd <= month+"-31" {
			if ev["month_status"] != "done" && ev["month_status"] != "skipped" {
				result = append(result, ev)
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		return toStrJS(result[i]["happen_date"]) < toStrJS(result[j]["happen_date"])
	})
	return result, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
