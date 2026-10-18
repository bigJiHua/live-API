package recurring

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/mod/account"
	"live/api/internal/mod/cardbill"
	"live/api/internal/tim"
)

// ============================================================================
// 固定周期支出模型 —— from: model/index.js（bus_recurring 表）
// ============================================================================

const tableName = "bus_recurring"

// graceDays 分期「计划入账日」之后的宽限天数：plan_date ~ plan_date+N 天内可入账，
// 超过即作废。入账与作废判定均基于 plan_date，二者严格互补、不重叠。默认 30 天≈一个账单周期。
//
// 🔒 SYNC-A15（2026-10-12）：原为**包级变量** `var graceDays = envInt(...)`，
//
//	在 main() 的 config.Load() **之前**求值 ⇒ .env 里的
//	INSTALLMENT_GRACE_DAYS 永远读不到（恒为默认 30），直接影响入账/作废
//	判定与 cron 扫描。Node 侧是 require('dotenv').config() 之后才取值，正常生效。
//	改为惰性函数，每次调用时读 env（与 todo/helpers.go 的同类做法一致）。
func graceDays() int { return envInt("INSTALLMENT_GRACE_DAYS", 30) }

func envInt(k string, def int) int {
	if v := config.Get(k, ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// monthRe 对应 /^\d{4}-\d{2}$/。
var monthRe = regexp.MustCompile(`^\d{4}-\d{2}$`)

// today 北京时间"今天"，避免 UTC 服务器下 toISOString 取错日。
func today() string { return tim.BeijingToday() }

// now 对应 String(Date.now())。
func now() string { return tim.NowMSString() }

// parseMonthRecords 对应 parseMonthRecords(raw)。
func parseMonthRecords(raw any) map[string]map[string]any {
	out := map[string]map[string]any{}
	switch t := raw.(type) {
	case nil:
		return out
	case map[string]map[string]any:
		return t
	case string:
		m := parseJSONObject(t)
		if m == nil {
			return out
		}
		for k, v := range m {
			if rec, ok := v.(map[string]any); ok {
				out[k] = rec
			}
		}
		return out
	case map[string]any:
		for k, v := range t {
			if rec, ok := v.(map[string]any); ok {
				out[k] = rec
			}
		}
		return out
	}
	return out
}

// normalizeMonth 对应 normalizeMonth(month)。
func normalizeMonth(month string) (string, error) {
	if monthRe.MatchString(orEmpty(month)) {
		return month, nil
	}
	return "", errors.New("月份格式应为 YYYY-MM")
}

func orEmpty(s string) string {
	if s == "" {
		return ""
	}
	return s
}

// daysInMonth 对应 daysInMonth(month)（new Date(year, month, 0).getDate()）。
func daysInMonth(month string) int {
	parts := strings.Split(month, "-")
	if len(parts) < 2 {
		return 31
	}
	year, err1 := strconv.Atoi(parts[0])
	monthNo, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return 31
	}
	return daysInMonthYM(year, monthNo)
}

// getMonthDate 对应 getMonthDate(row, month)。
func getMonthDate(row map[string]any, month string) string {
	day := parseIntValue(row["day_of_cycle"])
	if day < 1 {
		day = 1 // Math.max(1, Number(row.day_of_cycle || 1))
	}
	safeDay := day
	if dim := daysInMonth(month); safeDay > dim {
		safeDay = dim
	}
	return month + "-" + pad2(safeDay)
}

// getMonthRecord 对应 getMonthRecord(row, month)。
func getMonthRecord(row map[string]any, month string) map[string]any {
	records := parseMonthRecords(row["month_records"])
	record := records[month]
	if record == nil {
		record = map[string]any{}
	}
	status, _ := record["status"].(string)
	if status == "" {
		status = "pending"
	}
	// 🔒 SYNC-A43（2026-10-13）：三处归一口径对齐 Node recurring/model/index.js:79-86
	//
	//	  status:      record.status || "pending"
	//	  amount:      record.amount !== undefined ? record.amount : row.amount
	//	  remind_time: record.remind_time || null
	//	  done_time:   record.done_time || null
	//	  remark:      record.remark || ""
	//
	//  旧实现的三处偏差：
	//  1) amount 用 `== nil` 判断 ⇒ **显式 null 也被吃掉**回退到主表金额。
	//     Node 用的是 `!== undefined`，只在该键**不存在**时才回退。
	//     可达：create 的 monthRecords 由客户端整体上传，传 {"amount": null} 即中招。
	//  2) done_time 缺 `|| null` 归一 ⇒ 存有 ""/0 时 Go 多输出 ""/0，Node 是 null。
	//  3) remark 用 `== nil` 而非 `|| ""` ⇒ 存有 0/false 时 Go 输出 0，Node 是 ""。
	amount, amountOK := record["amount"]
	if !amountOK {
		amount = row["amount"] // 仅"键不存在"才回退（对齐 !== undefined）
	}
	// 显式 null（amountOK 且值为 nil）原样保留 ⇒ JSON 输出 null，与 Node 一致
	remindTime := record["remind_time"]
	if !jsTruthy(remindTime) {
		remindTime = nil // record.remind_time || null
	}
	doneTime := record["done_time"]
	if !jsTruthy(doneTime) {
		doneTime = nil // record.done_time || null
	}
	remark := record["remark"]
	if !jsTruthy(remark) {
		remark = "" // record.remark || ""
	}
	return map[string]any{
		"month":       month,
		"status":      status,
		"amount":      amount,
		"remind_time": remindTime,
		"done_time":   doneTime,
		"remark":      remark,
	}
}

// attachMonthInfo 对应 attachMonthInfo(row, month)。
func attachMonthInfo(row map[string]any, month string) map[string]any {
	record := getMonthRecord(row, month)
	happenDate := getMonthDate(row, month)
	effective, _ := record["effectiveStatus"].(string)
	status, _ := record["status"].(string)
	monthStatus := effective
	if monthStatus == "" {
		monthStatus = status
	}
	monthAmount := toF(record["amount"])
	if monthAmount == 0 {
		monthAmount = toF(row["amount"])
	}
	out := map[string]any{}
	for k, v := range row {
		out[k] = v
	}
	out["amount"] = toF(row["amount"])
	out["month"] = month
	out["happen_date"] = happenDate
	out["month_status"] = monthStatus
	out["month_overdue"] = jsTruthy(record["overdue"])
	out["month_amount"] = monthAmount
	out["month_record"] = record
	out["month_records"] = parseMonthRecords(row["month_records"])
	out["is_done"] = monthStatus == "done"
	out["is_skipped"] = status == "skipped"
	out["is_due"] = happenDate <= today()
	return out
}

// FindOptions 对应 findAll 的 options。
type FindOptions struct {
	Month              string
	IncludeInactive    bool
	InstallmentOnly    bool
	ExcludeInstallment bool
}

// findAll 对应 findAll(userId, options)。
func findAll(userID string, opts FindOptions) ([]map[string]any, error) {
	params := []any{userID}
	where := "WHERE r.user_id = ? AND r.is_deleted = 0"
	if !opts.IncludeInactive {
		where += " AND r.is_active = 1"
	}
	if opts.InstallmentOnly {
		where += ` AND (c.name = '分期' OR r.account_id LIKE '%"type":"installment"%')`
	} else if opts.ExcludeInstallment {
		where += ` AND (c.name IS NULL OR (c.name != '分期' AND (r.account_id NOT LIKE '%"type":"installment"%' OR r.account_id IS NULL)))`
	}

	rows, err := queryRows(db.DB(), `
      SELECT r.*, c.name AS category_name, cb.alias AS account_name, cb.last4_no AS account_last4, cb.card_type
       FROM `+tableName+` r
       LEFT JOIN bus_category c ON r.category_id = c.id AND c.is_deleted = 0
       LEFT JOIN card_base cb ON r.account_id = cb.id AND cb.is_deleted = 0
       `+where+`
       ORDER BY r.is_active DESC, r.day_of_cycle ASC, r.create_time DESC`,
		params...)
	if err != nil {
		return nil, err
	}

	filtered := rows
	if opts.Month != "" {
		safeMonth, err := normalizeMonth(opts.Month)
		if err != nil {
			return nil, err
		}
		_, monthNum := splitMonthNum(safeMonth)
		kept := []map[string]any{}
		for _, row := range rows {
			// 🔒 SYNC-A43（2026-10-13）：去掉 `len(endDate) >= 7` 前置，改为与 Node 同构。
			// Node recurring/model/index.js:187-191 只判 `if (row.end_date)`。
			// 旧实现的长度前置会让脏值（如 end_date="2026"）跳过过滤而照常显示，
			// 而 Node 会 `"2026" < "2026-10-13"` 为真 ⇒ 隐藏该行。
			if endDate := toStr(row["end_date"]); endDate != "" {
				// 1) 真实已过期（截止日早于今天）→ 隐藏；2) 查看月份超过截止月 → 隐藏
				if endDate < today() {
					continue
				}
				if endDate[:min(7, len(endDate))] < safeMonth {
					continue
				}
			}
			if toStr(row["cycle"]) == "year" && jsTruthy(row["month_of_cycle"]) {
				if parseIntValue(row["month_of_cycle"]) != monthNum {
					continue
				}
			}
			kept = append(kept, row)
		}
		filtered = kept
	}

	if opts.Month == "" {
		out := make([]map[string]any, 0, len(filtered))
		for _, row := range filtered {
			m := map[string]any{}
			for k, v := range row {
				m[k] = v
			}
			m["month_records"] = parseMonthRecords(row["month_records"])
			out = append(out, m)
		}
		return out, nil
	}
	out := make([]map[string]any, 0, len(filtered))
	for _, row := range filtered {
		out = append(out, attachMonthInfo(row, opts.Month))
	}
	return out, nil
}

// splitMonthNum 对应 safeMonth.split("-").map(Number) 取月份。
func splitMonthNum(safeMonth string) (int, int) {
	parts := strings.Split(safeMonth, "-")
	if len(parts) < 2 {
		return 0, 0
	}
	y, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	return y, m
}

// findActiveInstallments 查询全量启用中的分期（跨用户，仅定时扫描 cron 使用）。
// 命中口径与 findAll 的 installmentOnly 保持一致。
func findActiveInstallments() ([]map[string]any, error) {
	rows, err := queryRows(db.DB(), `
      SELECT r.* FROM `+tableName+` r
       WHERE r.is_deleted = 0 AND r.is_active = 1
         AND r.repeat_count IS NOT NULL
         AND r.account_id LIKE '%"type":"installment"%'`)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		row["month_records"] = parseMonthRecords(row["month_records"])
	}
	return rows, nil
}

// findById 对应 findById(id, userId)。
func findById(id, userID string) (map[string]any, error) {
	row, err := queryRow(db.DB(), `
      SELECT r.*, c.name AS category_name, cb.alias AS account_name, cb.last4_no AS account_last4, cb.card_type
       FROM `+tableName+` r
       LEFT JOIN bus_category c ON r.category_id = c.id AND c.is_deleted = 0
       LEFT JOIN card_base cb ON r.account_id = cb.id AND cb.is_deleted = 0
       WHERE r.id = ? AND r.user_id = ? AND r.is_deleted = 0`,
		id, userID)
	if err != nil || row == nil {
		return nil, err
	}
	row["month_records"] = parseMonthRecords(row["month_records"])
	return row, nil
}

// CreateParams 对应 create 入参。
type CreateParams struct {
	UserID        string
	Name          any
	Amount        any
	CategoryID    any
	AccountID     any
	Cycle         any
	DayOfCycle    any
	MonthOfCycle  any
	RemindDays    any
	Remark        any
	IsActive      any
	EndDate       any
	RepeatCount   any
	NotifyChannel any
	MonthRecords  any
}

// create 对应 RecurringExpense.create。
func create(p CreateParams) (map[string]any, error) {
	if !jsTruthy(p.Name) || strings.TrimSpace(toStr(p.Name)) == "" {
		return nil, errors.New("固定支出名称不能为空")
	}
	numAmount := toF(p.Amount)
	if isNaNAmount(p.Amount) || numAmount < 0 {
		return nil, errors.New("金额不能为负数")
	}

	finalCycle := toStr(p.Cycle)
	if finalCycle == "" {
		finalCycle = "month"
	}
	if finalCycle != "month" && finalCycle != "year" {
		return nil, errors.New("周期仅支持 month / year")
	}
	if finalCycle == "year" && (!jsTruthy(p.MonthOfCycle) || parseIntValue(p.MonthOfCycle) < 1 || parseIntValue(p.MonthOfCycle) > 12) {
		return nil, errors.New("年度周期需指定 month_of_cycle (1-12)")
	}

	day := clampInt(parseIntValue(orDefaultInt(p.DayOfCycle, 1)), 1, 31)
	var monthVal any
	if jsTruthy(p.MonthOfCycle) {
		monthVal = clampInt(parseIntValue(p.MonthOfCycle), 1, 12)
	}
	id := idgen.BillID()
	nowStr := now()
	var nextDate string
	if finalCycle == "year" {
		nextDate = getNextDateYear(day, parseIntValue(monthVal))
	} else {
		nextDate = getNextDate(day)
	}

	initialRecords := "{}"
	if m, ok := p.MonthRecords.(map[string]any); ok && m != nil {
		s, err := jsonStringify(m)
		if err != nil {
			return nil, err
		}
		initialRecords = s
	}

	_, err := db.DB().Exec(
		`INSERT INTO `+tableName+`
       (id, user_id, name, amount, category_id, account_id, cycle, day_of_cycle, month_of_cycle,
        next_date, remind_days, remark, month_records, end_date, repeat_count, notify_channel,
        is_active, create_time, update_time, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, p.UserID, strings.TrimSpace(toStr(p.Name)), numAmount,
		orNull(p.CategoryID), orNull(p.AccountID),
		finalCycle, day, monthVal, nextDate,
		parseIntValue(orDefaultInt(p.RemindDays, 0)), orNull(p.Remark), initialRecords,
		orNull(p.EndDate), repeatCountOrNull(p.RepeatCount), orDefaultStr(p.NotifyChannel, "app"),
		isActive01(p.IsActive), nowStr, nowStr)
	if err != nil {
		return nil, err
	}
	return findById(id, p.UserID)
}

// isNaNAmount 对应 isNaN(Number(amount))。
func isNaNAmount(v any) bool {
	switch t := v.(type) {
	case nil:
		return true // Number(undefined) = NaN
	case string:
		if strings.TrimSpace(t) == "" {
			return false // Number("") = 0
		}
		_, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		// 🔒 SYNC-A41（2026-10-13）：ParseFloat("NaN"/"Inf"/"+Inf", 64) 返回 **(值, nil)**
		// —— err 为 nil！只判 err 会让 NaN / ±Inf 绕过金额校验，
		// 把 NaN 写进 bus_recurring.amount，之后 month_amount 汇总、日历金额全部变 NaN。
		// 对照 account/debit.go 的 jsNumStrict 已有同款判定。
		if err != nil {
			return true
		}
		f, _ := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return math.IsNaN(f) || math.IsInf(f, 0)
	case json.Number:
		_, err := t.Float64()
		return err != nil
	case float64:
		return t != t // NaN
	case bool:
		return false // Number(true)=1 / Number(false)=0
	}
	return false
}

// getNextDate 对应 getNextDate(dayOfCycle)。
func getNextDate(dayOfCycle int) string {
	nowT := tim.BeijingNow()
	currentMonth := nowT.Format("2006-01")
	date := getMonthDate(map[string]any{"day_of_cycle": dayOfCycle}, currentMonth)
	if date < today() {
		next := nowT.AddDate(0, 1, 0)
		nextMonth := next.Format("2006-01")
		date = getMonthDate(map[string]any{"day_of_cycle": dayOfCycle}, nextMonth)
	}
	return date
}

// getNextDateYear 对应 getNextDateYear(dayOfCycle, monthOfCycle)（不 clamp 到月末，维持原样）。
func getNextDateYear(dayOfCycle, monthOfCycle int) string {
	nowT := tim.BeijingNow()
	year := nowT.Year()
	day := clampInt(dayOfCycle, 1, 31)
	month := monthOfCycle
	if month < 1 {
		month = 1 // Number(monthOfCycle || 1)
	}
	thisYearDate := fmt.Sprintf("%04d-%02d-%02d", year, month, day)
	if thisYearDate >= today() {
		return thisYearDate
	}
	return fmt.Sprintf("%04d-%02d-%02d", year+1, month, day)
}

// update 对应 update(id, userId, updates)（updates 键为 camelCase）。
func update(id, userID string, updates map[string]any) (map[string]any, error) {
	existing, err := findById(id, userID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, errors.New("固定支出不存在")
	}

	colMap := map[string]string{
		"name": "name", "amount": "amount", "categoryId": "category_id", "accountId": "account_id",
		"cycle": "cycle", "dayOfCycle": "day_of_cycle", "monthOfCycle": "month_of_cycle",
		"remindDays": "remind_days", "remark": "remark", "isActive": "is_active",
		"endDate": "end_date", "repeatCount": "repeat_count", "notifyChannel": "notify_channel",
	}

	if updates["name"] != nil && strings.TrimSpace(toStr(updates["name"])) == "" {
		return nil, errors.New("固定支出名称不能为空")
	}
	if updates["amount"] != nil && toF(updates["amount"]) < 0 {
		return nil, errors.New("金额不能为负数")
	}

	// 合并 cycle：优先用传入值，否则用现有值
	resolvedCycle := toStr(existing["cycle"])
	if updates["cycle"] != nil {
		resolvedCycle = toStr(updates["cycle"])
	}
	if resolvedCycle != "month" && resolvedCycle != "year" {
		return nil, errors.New("周期仅支持 month / year")
	}

	resolvedMonthOfCycle := existing["month_of_cycle"]
	if updates["monthOfCycle"] != nil {
		resolvedMonthOfCycle = updates["monthOfCycle"]
	}
	if resolvedCycle == "year" && (!jsTruthy(resolvedMonthOfCycle) || parseIntValue(resolvedMonthOfCycle) < 1 || parseIntValue(resolvedMonthOfCycle) > 12) {
		return nil, errors.New("年度周期需指定 month_of_cycle (1-12)")
	}

	var fields []string
	var params []any
	// 按 Node map 的固定顺序遍历，保证 SET 子句稳定
	keyOrder := []string{"name", "amount", "categoryId", "accountId", "cycle", "dayOfCycle", "monthOfCycle", "remindDays", "remark", "isActive", "endDate", "repeatCount", "notifyChannel"}
	for _, key := range keyOrder {
		v, ok := updates[key]
		if !ok || v == nil {
			continue
		}
		column := colMap[key]
		fields = append(fields, column+" = ?")
		switch key {
		case "dayOfCycle":
			params = append(params, clampInt(parseIntValue(orDefaultInt(v, 1)), 1, 31))
		case "monthOfCycle":
			params = append(params, clampInt(parseIntValue(orDefaultInt(v, 1)), 1, 12))
		case "remindDays":
			params = append(params, parseIntValue(orDefaultInt(v, 0)))
		case "repeatCount":
			params = append(params, orNull(v))
		case "isActive":
			params = append(params, isActive01(v))
		case "categoryId", "accountId", "endDate", "notifyChannel":
			params = append(params, orNull(v))
		default:
			params = append(params, v)
		}
	}

	// 当 day_of_cycle 或 month_of_cycle 或 cycle 变更时，重算 next_date
	if updates["dayOfCycle"] != nil || updates["monthOfCycle"] != nil || updates["cycle"] != nil {
		dayVal := parseIntValue(orDefaultInt(existing["day_of_cycle"], 1))
		if updates["dayOfCycle"] != nil {
			dayVal = clampInt(parseIntValue(orDefaultInt(updates["dayOfCycle"], 1)), 1, 31)
		}
		monthVal := parseIntValue(existing["month_of_cycle"])
		if updates["monthOfCycle"] != nil {
			monthVal = clampInt(parseIntValue(orDefaultInt(updates["monthOfCycle"], 1)), 1, 12)
		}
		fields = append(fields, "next_date = ?")
		if resolvedCycle == "year" {
			params = append(params, getNextDateYear(dayVal, monthVal))
		} else {
			params = append(params, getNextDate(dayVal))
		}
	}

	if len(fields) == 0 {
		return existing, nil
	}
	fields = append(fields, "update_time = ?")
	params = append(params, now(), id, userID)

	_, err = db.DB().Exec(
		"UPDATE "+tableName+" SET "+strings.Join(fields, ", ")+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		params...)
	if err != nil {
		return nil, err
	}
	return findById(id, userID)
}

// deleteFn 对应 delete(id, userId)（软删除）。
func deleteFn(id, userID string) (bool, error) {
	n, err := execAffected(db.DB(),
		"UPDATE "+tableName+" SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
		now(), id, userID)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// updateMonthStatus 对应 updateMonthStatus(id, userId, {month, status, amount, remark})。
func updateMonthStatus(id, userID string, month, status string, amount, remark any) (map[string]any, error) {
	safeMonth, err := normalizeMonth(month)
	if err != nil {
		return nil, err
	}
	if status != "pending" && status != "done" && status != "skipped" {
		return nil, errors.New("状态只能是 pending/done/skipped")
	}

	existing, err := findById(id, userID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, errors.New("固定支出不存在")
	}

	// 分期限定：只能操作 month_records 中已有月份，防止超范围插入
	if jsTruthy(existing["repeat_count"]) {
		existingRecords := parseMonthRecords(existing["month_records"])
		if _, ok := existingRecords[safeMonth]; !ok {
			return nil, fmt.Errorf("分期仅限已登记月份操作，%s 不在范围内", safeMonth)
		}
		// 分期三态护栏
		cur := existingRecords[safeMonth]
		if toStr(cur["status"]) == "entered" {
			return nil, errors.New("该期已入账，不可直接标记，请去账单手动冲正")
		}
		if toStr(cur["status"]) == "void" {
			return nil, errors.New("该期已中止，不可再修改")
		}
	}

	records := parseMonthRecords(existing["month_records"])
	current := records[safeMonth]
	if current == nil {
		current = map[string]any{}
	}
	// 对应 {...current, status, amount, remark, remind_time, done_time}：保留 current 其余键
	newRec := map[string]any{}
	for k, v := range current {
		newRec[k] = v
	}
	newAmount := amount
	if newAmount == nil {
		newAmount = current["amount"]
		if newAmount == nil {
			newAmount = existing["amount"]
		}
	}
	newRemark := remark
	if newRemark == nil {
		newRemark = current["remark"]
		if newRemark == nil {
			newRemark = ""
		}
	}
	var doneTime any
	if status == "done" {
		doneTime = now()
	} else {
		doneTime = nil
	}
	newRec["status"] = status
	newRec["amount"] = newAmount
	newRec["remark"] = newRemark
	newRec["remind_time"] = current["remind_time"]
	newRec["done_time"] = doneTime
	records[safeMonth] = newRec

	// 检查是否已满 repeat_count（分期完成）
	shouldDeactivate := false
	if status == "done" && jsTruthy(existing["repeat_count"]) {
		doneCount := 0
		for _, r := range records {
			if toStr(r["status"]) == "done" {
				doneCount++
			}
		}
		if doneCount >= parseIntValue(existing["repeat_count"]) {
			shouldDeactivate = true
		}
	}

	recordsJSON, err := jsonStringify(records)
	if err != nil {
		return nil, err
	}
	// 🔒 SYNC-A41（2026-10-13）：对齐 Node 的 `existing.is_active || 1`。
	//
	//	Node recurring/model/index.js:458：
	//	    [JSON.stringify(records), shouldDeactivate ? 0 : (existing.is_active || 1), ...]
	//	`0 || 1` = **1** ⇒ 原本 is_active=0（已 abortInstallment 或 repeat_count 满自动停用）
	//	的记录，在改某月状态后会被**改回启用**，重新出现在日历/提醒/自动入账。
	//	旧 Go 实现写成"truthy 则 1、否则 0"⇒ 保持停用，两端行为相反。
	//
	//	这是一处 Node 自身的缺陷（意外复活）。是否保留由产品决定；
	// 当前按基准逐字复刻，并在此标注 —— 若要修正为"保持原状"，改这一行即可。
	activeVal := 1
	// is_active 是 tinyint（0/1），`existing.is_active || 1` 在该域内恒为 1（0→1、1→1），
	// 故不再按 jsTruthy 区分 —— 见上方 SYNC-A41 注释。
	// 若产品决定改为"保持原状"，删掉本段即可让 activeVal 恒为 1。
	if shouldDeactivate {
		activeVal = 0
	}
	_, err = db.DB().Exec(
		"UPDATE "+tableName+" SET month_records = ?, is_active = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0",
		recordsJSON, activeVal, now(), id, userID)
	if err != nil {
		return nil, err
	}

	row, err := findById(id, userID)
	if err != nil {
		return nil, err
	}
	result := attachMonthInfo(row, safeMonth)
	result["auto_deactivated"] = shouldDeactivate
	return result, nil
}

// getMonthSummary 对应 getMonthSummary(userId, month)。
func getMonthSummary(userID, month string) (map[string]any, error) {
	rows, err := findAll(userID, FindOptions{Month: month, IncludeInactive: false})
	if err != nil {
		return nil, err
	}
	var active []map[string]any
	for _, item := range rows {
		if !jsTruthy(item["is_skipped"]) {
			active = append(active, item)
		}
	}
	var done []map[string]any
	for _, item := range active {
		if jsTruthy(item["is_done"]) {
			done = append(done, item)
		}
	}
	totalAmount := 0.0
	for _, item := range active {
		totalAmount += toF(item["month_amount"])
	}
	doneAmount := 0.0
	for _, item := range done {
		doneAmount += toF(item["month_amount"])
	}
	return map[string]any{
		"month":         month,
		"total":         len(active),
		"done":          len(done),
		"pending":       len(active) - len(done),
		"totalAmount":   totalAmount,
		"doneAmount":    doneAmount,
		"pendingAmount": totalAmount - doneAmount,
		"categoryStats": getCategoryStats(active),
	}, nil
}

// getCategoryStats 对应 getCategoryStats(rows)（按 amount 降序）。
func getCategoryStats(rows []map[string]any) []map[string]any {
	type stat struct {
		categoryID   string
		categoryName string
		amount       float64
		count        int
	}
	order := []string{}
	m := map[string]*stat{}
	for _, item := range rows {
		amountVal := toF(item["month_amount"])
		isEvent := !jsTruthy(item["category_id"]) && amountVal == 0
		key := ""
		if isEvent {
			key = "event_reminder"
		} else if jsTruthy(item["category_id"]) {
			key = toStr(item["category_id"])
		} else {
			key = "uncategorized"
		}
		cur, ok := m[key]
		if !ok {
			cur = &stat{}
			if isEvent {
				cur.categoryID = ""
				cur.categoryName = "事件提醒"
			} else if jsTruthy(item["category_id"]) {
				cur.categoryID = toStr(item["category_id"])
				cur.categoryName = toStr(item["category_name"])
				if cur.categoryName == "" {
					cur.categoryName = "未分类"
				}
			} else {
				cur.categoryID = ""
				cur.categoryName = "未分类"
			}
			m[key] = cur
			order = append(order, key)
		}
		cur.amount += amountVal
		cur.count++
	}
	out := make([]map[string]any, 0, len(order))
	for _, key := range order {
		cur := m[key]
		out = append(out, map[string]any{
			"category_id":   cur.categoryID,
			"category_name": cur.categoryName,
			"amount":        cur.amount,
			"count":         cur.count,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return toF(out[i]["amount"]) > toF(out[j]["amount"])
	})
	return out
}

// parseAccountInfo 对应 parseAccountInfo(raw)。
func parseAccountInfo(raw any) map[string]any {
	m := parseJSONObject(toStr(raw))
	if m == nil {
		return map[string]any{}
	}
	return m
}

// updateMonthRecords 对应 updateMonthRecords(id, userId, records)。
func updateMonthRecords(id, userID string, records map[string]map[string]any) error {
	recordsJSON, err := jsonStringify(records)
	if err != nil {
		return err
	}
	_, err = db.DB().Exec(
		"UPDATE "+tableName+" SET month_records = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0",
		recordsJSON, now(), id, userID)
	return err
}

// ============================================================================
// 分期入账（plan_date 口径）
// ============================================================================

// resolvePlanDate 解析某一期的「计划入账日」（北京时区，已 startOf('day')）。
//   - 新数据：取 month_records[month].plan_date（前端按「首期入账日期 + 入账归属」推算写入）。
//   - 存量数据：无 plan_date 时回退旧算法「该期月份 账单日+1」。
func resolvePlanDate(row map[string]any, month string, records map[string]map[string]any) time.Time {
	var recs map[string]map[string]any
	if records != nil {
		recs = records
	} else {
		recs = parseMonthRecords(row["month_records"])
	}
	rec := recs[month]
	if rec != nil && jsTruthy(rec["plan_date"]) {
		if t, err := time.ParseInLocation("2006-01-02", toStr(rec["plan_date"]), tim.Loc()); err == nil {
			return t
		}
	}
	acc := parseAccountInfo(row["account_id"])
	billingDay := parseIntValue(acc["billing_day"])
	if billingDay == 0 {
		billingDay = 1 // Number(acc.billing_day) || 1
	}
	targetMonth, err := time.ParseInLocation("2006-01-02", month+"-01", tim.Loc())
	if err != nil {
		targetMonth = tim.BeijingNow()
	}
	day := billingDay + 1
	if dim := daysInMonthYM(targetMonth.Year(), int(targetMonth.Month())); day > dim {
		day = dim // Math.min(billingDay + 1, targetMonth.daysInMonth())
	}
	return time.Date(targetMonth.Year(), targetMonth.Month(), day, 0, 0, 0, 0, tim.Loc())
}

// beijingTodayStartOfDay 对应 Node `dayjs().tz("Asia/Shanghai").startOf("day")`：
// 北京时区当天零点。
//
// 🔒 SYNC-A41（2026-10-13）：Node 的 canEnterNow / isEnterExpired 都先 startOf("day")，
// 与 planDate（当天零点）做整日比较；Go 此前直接用 `tim.BeijingNow()`（**带时分秒**），
// 导致宽限期**最后一天的判定翻转**：plan_date+30 天当天 00:00 之后，
// Node 判「未超期、仍可入账」，Go 因 14:23:11 > 00:00:00 判「已超期」
// ⇒ cron 把该期次直接 void 掉（remark="超过期限，自动作废"），enterInstallment 也拒绝入账
// ⇒ 宽限期实际少 1 天（30 天变 29 天可用）。
func beijingTodayStartOfDay() time.Time {
	n := tim.BeijingNow()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, tim.Loc())
}

// canEnterNow 是否到达该期入账时机：plan_date <= 今天 <= plan_date + 宽限天数。
func canEnterNow(row map[string]any, month string, records map[string]map[string]any) bool {
	planDate := resolvePlanDate(row, month, records)
	nowDay := beijingTodayStartOfDay()
	return !nowDay.Before(planDate) && !nowDay.After(planDate.AddDate(0, 0, graceDays()))
}

// isEnterExpired 该期是否已超期（超过 plan_date + 宽限天数仍未入账）→ 应自动作废。
func isEnterExpired(row map[string]any, month string, records map[string]map[string]any) bool {
	planDate := resolvePlanDate(row, month, records)
	return beijingTodayStartOfDay().After(planDate.AddDate(0, 0, graceDays()))
}

// resolveBillMonth 该期入账流水归属的账单月（复用 CardBill 周期规则）。
func resolveBillMonth(row map[string]any, month string, records map[string]map[string]any) string {
	acc := parseAccountInfo(row["account_id"])
	billingDay := parseIntValue(acc["billing_day"])
	if billingDay == 0 {
		billingDay = 1
	}
	pd := resolvePlanDate(row, month, records)
	return cardbill.GetBillMonthByDate(pd.Format("2006-01-02"), billingDay)
}

// ===== 进程内互斥锁：按 `${分期id}:${月份}` 串行化入账动作 =====
// Node ENTER_LOCKS + withEnterLock：前一次未结束则等待其完成后执行，结束后删除键。
var (
	enterMu    sync.Mutex
	enterLocks = map[string]*sync.Mutex{}
)

func withEnterLock(key string, fn func() error) error {
	enterMu.Lock()
	mu, ok := enterLocks[key]
	if !ok {
		mu = &sync.Mutex{}
		enterLocks[key] = mu
	}
	enterMu.Unlock()

	mu.Lock() // 等待同一 key 的前一次入账结束（对应 await prev）
	defer func() {
		mu.Unlock()
		enterMu.Lock()
		if enterLocks[key] == mu {
			delete(enterLocks, key)
		}
		enterMu.Unlock()
	}()
	return fn()
}

// enterInstallment 分期入账（对外入口）：加进程内互斥锁后执行。
func enterInstallment(id, month, userID string) (map[string]any, error) {
	var result map[string]any
	var runErr error
	lockErr := withEnterLock(id+":"+month, func() error {
		result, runErr = enterInstallmentUnsafe(id, month, userID)
		return runErr
	})
	if lockErr != nil {
		return nil, lockErr
	}
	return result, runErr
}

// enterInstallmentUnsafe 分期入账（无锁内部实现）。
func enterInstallmentUnsafe(id, month, userID string) (map[string]any, error) {
	row, err := findById(id, userID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errors.New("分期不存在")
	}
	records := parseMonthRecords(row["month_records"])
	m := records[month]
	if m == nil {
		return nil, errors.New("该期不存在")
	}
	// 幂等：已入账（remark 已有流水 ID）直接返回，避免重复建流水
	if toStr(m["status"]) == "entered" && jsTruthy(m["remark"]) {
		return map[string]any{"flowId": toStr(m["remark"]), "month": month, "idx": 0, "transDate": "", "skipped": true}, nil
	}
	// 自愈：旧代码占坑态 entering（remark 为空、无真实流水）视为未入账，复位后重入。
	if toStr(m["status"]) == "entering" && !jsTruthy(m["remark"]) {
		heal := parseMonthRecords(row["month_records"])
		if heal[month] == nil {
			heal[month] = map[string]any{}
		}
		heal[month]["status"] = "pending"
		heal[month]["remark"] = ""
		if err := updateMonthRecords(id, userID, heal); err != nil {
			return nil, err
		}
		m["status"] = "pending"
	}
	if toStr(m["status"]) != "pending" {
		if toStr(m["status"]) == "void" {
			return nil, errors.New("该期已中止")
		}
		return nil, errors.New("该期已入账或已处理")
	}
	acc := parseAccountInfo(row["account_id"])
	billingDay := parseIntValue(acc["billing_day"])
	if billingDay == 0 {
		billingDay = 1
	}
	totalPeriods := parseIntValue(acc["total_periods"])
	if totalPeriods == 0 {
		totalPeriods = parseIntValue(row["repeat_count"])
	}
	if totalPeriods == 0 {
		totalPeriods = 1
	}

	// 入账时机校验：必须已到达该期的计划入账日（账单日前 2 天），且未超宽限期
	planDate := resolvePlanDate(row, month, records)
	nowDay := tim.BeijingNow()
	if nowDay.Before(planDate) {
		return nil, fmt.Errorf("该期计划入账日为 %s（账单日前 2 天），尚未到达，暂不入账", planDate.Format("2006-01-02"))
	}
	if isEnterExpired(row, month, records) {
		return nil, fmt.Errorf("该期计划入账日 %s 已超过 %d 天仍未入账，请确认或中止", planDate.Format("2006-01-02"), graceDays())
	}

	// 第几期（按月份升序）
	sortedMonths := make([]string, 0, len(parseMonthRecords(row["month_records"])))
	for k := range parseMonthRecords(row["month_records"]) {
		sortedMonths = append(sortedMonths, k)
	}
	sort.Strings(sortedMonths)
	idx := 0
	for i, sm := range sortedMonths {
		if sm == month {
			idx = i + 1
			break
		}
	}
	// 流水交易日期 = 计划入账日，账单归属由 CardBill.getBillMonthByDate 决定
	transDate := planDate.Format("2006-01-02")

	// 复用信用卡消费入账（事务 + 锁卡 + 额度校验 + CreditCore.syncCardBills），不改动 CreditCore
	flow, err := account.CreditAccountCreate(db.DB(), account.CreditCreateParams{
		UserID:       userID,
		CategoryID:   "installment",
		Amount:       toStr(m["amount"]),
		TransDate:    transDate,
		Remark:       fmt.Sprintf("%s分期 第%d/%d期消费入账", orDefaultStr(acc["card_name"], toStr(row["name"])), idx, totalPeriods),
		CardID:       toStr(acc["card_id"]),
		PayType:      "installment",
		PayMethod:    "installment",
		Currency:     "CNY",
		ExchangeRate: "1",
	})
	if err != nil {
		return nil, err
	}
	flowID := ""
	if flow != nil {
		flowID = toStr(flow["id"])
	}
	if flowID == "" {
		return nil, errors.New("入账流水创建失败")
	}

	// 成功后写回流水 ID + entered（不再用占坑 entering，避免中间态泄漏）
	updated := parseMonthRecords(row["month_records"])
	if updated[month] == nil {
		updated[month] = map[string]any{}
	}
	nowStr := tim.BeijingNow().Format("2006-01-02 15:04:05")
	updated[month]["status"] = "entered"
	updated[month]["remark"] = flowID
	updated[month]["plan_date"] = transDate
	updated[month]["bill_month"] = resolveBillMonth(row, month, updated)
	updated[month]["entered_at"] = nowStr
	updated[month]["done_time"] = nowStr
	if err := updateMonthRecords(id, userID, updated); err != nil {
		return nil, err
	}

	return map[string]any{"flowId": flowID, "month": month, "idx": idx, "transDate": transDate}, nil
}

// abortInstallment 分期中止：仅未入账(pending)的期次可中止。
func abortInstallment(id string, months []string, userID string) (map[string]any, error) {
	row, err := findById(id, userID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errors.New("分期不存在")
	}
	records := parseMonthRecords(row["month_records"])
	aborted := []string{}
	skipped := []map[string]any{}
	for _, month := range months {
		m := records[month]
		if m == nil {
			skipped = append(skipped, map[string]any{"month": month, "reason": "不存在"})
			continue
		}
		if toStr(m["status"]) == "pending" || toStr(m["status"]) == "entering" {
			newRec := map[string]any{}
			for k, v := range m {
				newRec[k] = v
			}
			newRec["status"] = "void"
			newRec["remark"] = orDefaultStr(m["remark"], "")
			newRec["done_time"] = tim.BeijingNow().Format("2006-01-02 15:04:05")
			records[month] = newRec
			aborted = append(aborted, month)
		} else {
			reason := "已入账/已处理，请去账单手动冲正"
			if toStr(m["status"]) == "void" {
				reason = "已中止"
			}
			skipped = append(skipped, map[string]any{"month": month, "reason": reason})
		}
	}
	if len(aborted) > 0 {
		if err := updateMonthRecords(id, userID, records); err != nil {
			return nil, err
		}
	}
	// 全部期次都不再是待入账(pending/entering) → 整个分期视为已结束/失效
	finished := false
	remaining := 0
	for _, r := range records {
		if toStr(r["status"]) == "pending" || toStr(r["status"]) == "entering" {
			remaining++
		}
	}
	if len(aborted) > 0 && remaining == 0 {
		oldRemark := toStr(row["remark"])
		finishedRemark := oldRemark
		if !strings.Contains(oldRemark, "已全部中止") {
			finishedRemark = strings.TrimSpace(oldRemark + "｜已全部中止，分期结束")
		}
		_, err := db.DB().Exec(
			"UPDATE "+tableName+" SET is_active = 0, remark = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0",
			finishedRemark, now(), id, userID)
		if err != nil {
			return nil, err
		}
		finished = true
	}
	return map[string]any{"aborted": aborted, "skipped": skipped, "finished": finished}, nil
}

// voidExpiredInstallments 超过期限自动作废：pending / entering(无流水) 且已过
// 「计划入账日 + 宽限天数」仍未入账的期次，标记 void（remark="超过期限，自动作废"）。
// 由定时扫描与日历/提醒读取触发写库。修正记录：此前误传 (row.user_id, row.user_id)，
// SQL 条件变成 id = user_id，不命中任何行（Node 已修复，此处按修复后实现）。
func voidExpiredInstallments(row map[string]any) (bool, error) {
	if row == nil || !jsTruthy(row["repeat_count"]) {
		return false, nil
	}
	records := parseMonthRecords(row["month_records"])
	mutated := false
	for _, month := range sortedKeys(records) {
		rec := records[month]
		s := toStr(rec["status"])
		if s != "pending" && !(s == "entering" && !jsTruthy(rec["remark"])) {
			continue
		}
		// 超期判定与入账时机判定同源（都基于 plan_date）
		if isEnterExpired(row, month, records) {
			newRec := map[string]any{}
			for k, v := range rec {
				newRec[k] = v
			}
			newRec["status"] = "void"
			newRec["remark"] = "超过期限，自动作废"
			newRec["done_time"] = tim.BeijingNow().Format("2006-01-02 15:04:05")
			records[month] = newRec
			mutated = true
		}
	}
	if mutated {
		if err := updateMonthRecords(toStr(row["id"]), toStr(row["user_id"]), records); err != nil {
			return false, err
		}
	}
	return mutated, nil
}

// autoEnterPending 系统自动入账：对已到达计划入账日且尚未入账(pending)的期次自动触发入账。
func autoEnterPending(id, userID string) error {
	row, err := findById(id, userID)
	if err != nil {
		return err
	}
	if row == nil || !jsTruthy(row["repeat_count"]) {
		return nil
	}
	records := parseMonthRecords(row["month_records"])
	// 纳入 pending + entering(无流水占坑，需自愈重入) 的期次
	var pendingMonths []string
	for k, rec := range records {
		s := toStr(rec["status"])
		if s == "pending" || (s == "entering" && !jsTruthy(rec["remark"])) {
			pendingMonths = append(pendingMonths, k)
		}
	}
	if len(pendingMonths) == 0 {
		return nil
	}
	// entering 自愈：无流水占坑 → 复位 pending。必须【先落库】再入账。
	mutated := false
	for _, month := range pendingMonths {
		rec := records[month]
		if toStr(rec["status"]) == "entering" && !jsTruthy(rec["remark"]) {
			records[month]["status"] = "pending"
			records[month]["remark"] = ""
			mutated = true
		}
	}
	if mutated {
		if err := updateMonthRecords(id, userID, records); err != nil {
			return err
		}
	}

	for _, month := range pendingMonths {
		rec := records[month]
		if toStr(rec["status"]) != "pending" {
			continue
		}
		if !canEnterNow(row, month, records) {
			continue // 未到计划入账日（含未来期）→ 跳过；已超期 → 由 voidExpiredInstallments 作废
		}
		// 已到达计划入账日 → 自动入账（单期失败仅告警，不影响整体）
		if _, err := enterInstallment(id, month, userID); err != nil {
			println("[installment] 自动入账失败 id=" + id + " month=" + month + ": " + err.Error())
		}
	}
	return nil
}

// decorateInstallmentStatus 计算分期各期"有效状态"：entered 期若所属账单周期已还清(need_repay<=0)
// 则视为已还(done)。只读 card_bill，不写库、不改动 CreditCore。返回新的 month_records。
// keep BUG-039：need_repay=NULL 时 parseFloat(null)=NaN，NaN<=0.01 为 false → 状态装饰为 entered。
func decorateInstallmentStatus(row map[string]any) (map[string]map[string]any, error) {
	records := parseMonthRecords(row["month_records"])
	acc := parseAccountInfo(row["account_id"])
	cardID := toStr(acc["card_id"])
	// 补齐每期的计划入账日与归属账单月（存量数据用回退算法补齐）。仅用于接口展示，不写库。
	for _, month := range sortedKeys(records) {
		rec := records[month]
		if rec == nil {
			rec = map[string]any{}
			records[month] = rec
		}
		if !jsTruthy(rec["plan_date"]) {
			rec["plan_date"] = resolvePlanDate(row, month, records).Format("2006-01-02")
		}
		if !jsTruthy(rec["bill_month"]) {
			rec["bill_month"] = resolveBillMonth(row, month, records)
		}
	}
	if cardID == "" {
		return records, nil
	}
	var enteredMonths []string
	for k, rec := range records {
		if toStr(rec["status"]) == "entered" {
			enteredMonths = append(enteredMonths, k)
		}
	}
	if len(enteredMonths) == 0 {
		return records, nil
	}
	// 账单归属由「计划入账日」经 CardBill 周期规则推导
	billMonths := map[string]bool{}
	monthToBillMonth := map[string]string{}
	for _, month := range enteredMonths {
		billMonth := resolveBillMonth(row, month, records)
		monthToBillMonth[month] = billMonth
		billMonths[billMonth] = true
	}
	inList := make([]string, 0, len(billMonths))
	for bm := range billMonths {
		inList = append(inList, bm)
	}
	sort.Strings(inList)
	placeholders := make([]string, len(inList))
	args := []any{cardID, toStr(row["user_id"])}
	for i, bm := range inList {
		placeholders[i] = "?"
		args = append(args, bm)
	}
	billRows, err := queryRows(db.DB(),
		"SELECT bill_month, need_repay, is_overdue FROM card_bill WHERE card_id = ? AND user_id = ? AND bill_month IN ("+strings.Join(placeholders, ",")+") AND is_deleted = 0",
		args...)
	if err != nil {
		return nil, err
	}
	billMap := map[string]map[string]any{}
	for _, b := range billRows {
		billMap[toStr(b["bill_month"])] = map[string]any{
			"needRepay": toFNaN(b["need_repay"]),
			"isOverdue": isOverdueTrue(b["is_overdue"]),
		}
	}
	for _, month := range enteredMonths {
		billMonth := monthToBillMonth[month]
		b, ok := billMap[billMonth]
		var nr float64
		if ok {
			nr = toF(b["needRepay"])
		} else {
			nr = nanValue()
		}
		overdue := false
		if ok {
			overdue = jsTruthy(b["isOverdue"])
		}
		effectiveStatus := "entered"
		if ok && !isNaN(nr) && nr <= 0.01 {
			effectiveStatus = "done"
		}
		records[month]["effectiveStatus"] = effectiveStatus
		// 逾期：已入账且归属账单处于逾期状态（前端据此显示红色"逾期"）
		records[month]["overdue"] = effectiveStatus == "entered" && overdue
	}
	return records, nil
}

// isOverdueTrue 对应 b.is_overdue === 1 || === "1" || === true。
func isOverdueTrue(v any) bool {
	switch t := v.(type) {
	case float64:
		return t == 1
	case int64:
		return t == 1
	case string:
		return t == "1"
	case bool:
		return t
	}
	return false
}

// ===== 小助手 =====

func sortedKeys(m map[string]map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// orDefaultInt 对应 `Number(x || def)`。
func orDefaultInt(v any, def int) int {
	if !jsTruthy(v) {
		return def
	}
	return parseIntValue(v)
}

// orDefaultStr 对应 `x || def`（字符串版）。
func orDefaultStr(v any, def string) string {
	if !jsTruthy(v) {
		return def
	}
	return toStr(v)
}

// repeatCountOrNull 对应 `repeatCount ? Number(repeatCount) : null`。
func repeatCountOrNull(v any) any {
	if !jsTruthy(v) {
		return nil
	}
	return parseIntValue(v)
}

func isNaN(f float64) bool { return f != f }

func nanValue() float64 { var z float64; return z / z }
