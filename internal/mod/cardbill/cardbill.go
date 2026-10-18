// Package cardbill 复刻 src/modules/card/model/bill.js（CardBill 模型 / card_bill 表）。
// SQL 逐字一致（? 占位）；keep/fix 标注同 build_logs/api.logs。
package cardbill

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"

	"live/api/internal/cur"
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// billTable 对应 CardBill.tableName = 'card_bill'。
const billTable = "card_bill"

// REPAY_DATE_SQL 还款日 SQL 片段，原样保留 bill.js:26。
// P8：原直接用账单月导致早一个月；M2：repay_day 29-31 遇短月 clamp 到目标月最后一天。
const REPAY_DATE_SQL = `STR_TO_DATE(CONCAT(DATE_FORMAT(DATE_ADD(CONCAT(cb.bill_month, '-01'), INTERVAL 1 MONTH), '%Y-%m'), '-', LPAD(LEAST(c.repay_day, DAY(LAST_DAY(DATE_ADD(CONCAT(cb.bill_month, '-01'), INTERVAL 1 MONTH)))) , 2, '0')), '%Y-%m-%d')`

// SyncCardBillsHook 由 creditcore.init() 赋值，对应 Node bill.js create/delete 内
// require('../core/CreditCore').syncCardBills，避免 cardbill → creditcore 循环依赖。
// 注意：Node 侧 syncCardBills 失败向上抛（C8），本 hook 签名无 error 返回，调用点不传播错误。
var SyncCardBillsHook func(ex db.Commiter, cardID, userID string)

// ===== 本地日期工具（对应 bill.js 顶部 toYMD / ymdToTime） =====

// toYMD 对应 toYMD(date)：格式化为本地 YYYY-MM-DD（不走 toISOString 的 UTC 偏移）。
func toYMD(t time.Time) string { return t.In(tim.Loc()).Format("2006-01-02") }

// ymdToTime 对应 ymdToTime(ymd)：'YYYY-MM-DD' → 本地零点毫秒时间戳。
func ymdToTime(ymd string) int64 {
	t, err := time.ParseInLocation("2006-01-02", ymd, tim.Loc())
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// ===== 行 → map 工具 =====

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

// normVal DB 值 → JSON 友好值：[]byte→string（对应 mysql2 DECIMAL/CHAR 返回串）；
// time.Time→Node JSON.stringify(Date) 的 UTC ISO 串（带毫秒 + Z）；其余原样。
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

// toStr 对应 String(v) 常用子集：nil→""，string 原样，数字按 JS 数字串格式。
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
	return fmt.Sprintf("%v", v)
}

// toF 对应 parseFloat(v) || 0：不可解析/空 → 0。
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

// toI 对应 parseInt(v, 10) || 0：截断取整，不可解析 → 0。
func toI(v any) int { return int(toF(v)) }

// truthy 对应 JS 真值判断（非空字符串皆真，含 "false"）。
//
// 🔒 SYNC-A40（2026-10-13）：补 NaN —— `Boolean(NaN) === false`，
// 而 Go 的 `NaN != 0` 为 true ⇒ 原实现把 NaN 当真值。
// 传导后果：b2i(NaN) 得 1，createBill 会把 remind_switch 写成 1（开启提醒），
// 而 Node 写 0（关闭）。
func truthy(v any) bool {
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
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return false
		}
		return f != 0 && !math.IsNaN(f)
	}
	return true
}

func b2i(v any) int {
	if truthy(v) {
		return 1
	}
	return 0
}

// ===== 本地日期解析（对应 new Date(transDate) 语义） =====

// ymRe 校验 'YYYY-MM'（对应 Node try/catch 对非法月份的跳过）。
var ymRe = regexp.MustCompile(`^\d{4}-\d{2}$`)

// parseYM 对应 billMonth.split('-').map(Number)。
func parseYM(billMonth string) (int, int) {
	parts := strings.Split(billMonth, "-")
	if len(parts) < 2 {
		return 0, 0
	}
	y, errY := strconv.Atoi(strings.TrimSpace(parts[0]))
	m, errM := strconv.Atoi(strings.TrimSpace(parts[1]))
	if errY != nil || errM != nil {
		return 0, 0
	}
	return y, m
}

// lastDayOfMonth 对应 new Date(y, m, 0).getDate()（当月最后一天）。
func lastDayOfMonth(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, tim.Loc()).Day()
}

// transLayouts new Date(str) 支持的常见日期形态（本地时区解析）。
var transLayouts = []string{
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
	"2006/01/02",
}

// parseTransDate 对应 getBillMonthByDate 的入参解析：
// 空 → 当前时间；10 位纯数字 → 秒级时间戳；13 位 → 毫秒时间戳；其余按日期字符串本地解析。
func parseTransDate(transDate string) time.Time {
	s := strings.TrimSpace(transDate)
	if s == "" {
		return tim.Now()
	}
	if isDigits(s) {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			switch len(s) {
			case 10:
				return time.UnixMilli(n * 1000).In(tim.Loc())
			case 13:
				return time.UnixMilli(n).In(tim.Loc())
			}
		}
	}
	for _, layout := range transLayouts {
		if t, err := time.ParseInLocation(layout, s, tim.Loc()); err == nil {
			return t
		}
	}
	return tim.Now()
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

// ===== 纯函数（对应 CardBill 静态计算方法） =====

// GetBillMonthByDate 对应 CardBill.getBillMonthByDate（默认 billDay 15 由调用方传参表达）。
// 账单周期：账单日(bill_day)次日 ~ 次月账单日前一天；消费日期 <= billDay 属当月账单，
// > billDay 属下月账单（账单日当天仍属当月）。
func GetBillMonthByDate(transDate string, billDay int) string {
	t := parseTransDate(transDate)
	day := t.Day()
	year := t.Year()
	month := int(t.Month())
	if day > billDay {
		nextMonth := month + 1
		nextYear := year
		if month == 12 {
			nextMonth, nextYear = 1, year+1
		}
		return fmt.Sprintf("%04d-%02d", nextYear, nextMonth)
	}
	return fmt.Sprintf("%04d-%02d", year, month)
}

// GetCurrentBillMonth 对应 CardBill.getCurrentBillMonth：始终返回当前月。
func GetCurrentBillMonth() string { return tim.Now().Format("2006-01") }

// CalculateBillPeriod 对应 CardBill.calculateBillPeriod。
// 账单周期：N-1月billDay+1 ～ N月billDay；止日包含账单日当天。
// keep BUG-034：止日不 clamp——bill_day 超出当月天数时滚入下月（与 JS new Date 溢出语义一致），维持原样。
func CalculateBillPeriod(billMonth string, billDay int) (billStartDate, billEndDate string) {
	year, month := parseYM(billMonth)
	// 账单结束日期：账单月的 billDay（不 clamp）
	billEndDate = toYMD(time.Date(year, time.Month(month), billDay, 0, 0, 0, 0, tim.Loc()))
	// 账单开始日期：上月 billDay 的次日
	lastMonth := month - 1
	lastYear := year
	if month == 1 {
		lastMonth, lastYear = 12, year-1
	}
	lastBillDate := time.Date(lastYear, time.Month(lastMonth), billDay, 0, 0, 0, 0, tim.Loc())
	billStartDate = toYMD(lastBillDate.AddDate(0, 0, 1))
	return billStartDate, billEndDate
}

// CalculateRepayDate 对应 CardBill.calculateRepayDate：还款日 = 账单月的下一月 repayDay。
// M2 审计：repayDay 29-31 遇短月 clamp 到目标月最后一天（LEAST + LAST_DAY）。
func CalculateRepayDate(billMonth string, repayDay int) string {
	year, month := parseYM(billMonth)
	nextMonth := month + 1
	nextYear := year
	if month == 12 {
		nextMonth, nextYear = 1, year+1
	}
	// Math.max(1, Math.min(Number(repayDay) || 0, lastDay))
	lastDay := lastDayOfMonth(nextYear, nextMonth)
	safeRepayDay := repayDay
	if safeRepayDay > lastDay {
		safeRepayDay = lastDay
	}
	if safeRepayDay < 1 {
		safeRepayDay = 1
	}
	return toYMD(time.Date(nextYear, time.Month(nextMonth), safeRepayDay, 0, 0, 0, 0, tim.Loc()))
}

// CalculateBillDate 对应 CardBill.calculateBillDate：账单日（出账日）= 账单月的 bill_day。
// 短月 clamp 与 calculateRepayDate 口径一致（bill_day 29-31 遇短月夹到月末）。
func CalculateBillDate(billMonth string, billDay int) string {
	year, month := parseYM(billMonth)
	lastDay := lastDayOfMonth(year, month)
	safeBillDay := billDay
	if safeBillDay > lastDay {
		safeBillDay = lastDay
	}
	if safeBillDay < 1 {
		safeBillDay = 1
	}
	return toYMD(time.Date(year, time.Month(month), safeBillDay, 0, 0, 0, 0, tim.Loc()))
}

// ===== Model 方法 =====

// GetCardInfo 对应 CardBill.getCardInfo（cardId, executor）：SQL 原样，不带 user_id（同 Node）。
func GetCardInfo(ex db.Commiter, cardID string) (map[string]any, error) {
	return qRow(ex, `SELECT id, user_id, card_type, bill_day, repay_day, credit_limit, 
              temp_limit, points_rate, currency 
       FROM card_base WHERE id = ? AND is_deleted = 0`, cardID)
}

// FindAll 对应 CardBill.findAll(userId, filters={cardId,billMonth})。
func FindAll(ex db.Commiter, userID, cardID, billMonth string) ([]map[string]any, error) {
	whereClause := "WHERE cb.user_id = ? AND cb.is_deleted = 0"
	params := []any{userID}
	if cardID != "" {
		whereClause += " AND cb.card_id = ?"
		params = append(params, cardID)
	}
	if billMonth != "" {
		whereClause += " AND cb.bill_month = ?"
		params = append(params, billMonth)
	}
	query := fmt.Sprintf(`
      SELECT cb.*, c.alias as card_alias, c.last4_no as card_last4,
             c.currency, c.repay_day,
             c.bill_day, c.annual_fee, c.fee_free_rule,
             %s as repay_date_calc,
             CASE 
               WHEN cb.need_repay > 0 AND %s < CURDATE()
               THEN 1 ELSE 0 
             END as is_overdue_calc,
             CASE 
               WHEN cb.need_repay > 0 AND %s < CURDATE()
               THEN DATEDIFF(CURDATE(), %s)
               ELSE 0 
             END as overdue_days_calc
      FROM card_bill cb
      LEFT JOIN card_base c ON cb.card_id = c.id
      %s
      ORDER BY cb.bill_month DESC, cb.update_time DESC
    `, REPAY_DATE_SQL, REPAY_DATE_SQL, REPAY_DATE_SQL, REPAY_DATE_SQL, whereClause)
	return qRows(ex, query, params...)
}

// GetRepaymentRemindersV2 对应 CardBill.getRepaymentRemindersV2（V2 新版口径，日历提醒专用）。
// 每个未还清账单产生两条事件：A 账单日出账提醒（归位账单月）、B 还款日逾期预警（归位还款日所在月）。
// 用北京时间计算"今天"（dayjs().tz('Asia/Shanghai') = tim.BeijingToday）。
// 过滤规则由 happenDate（YYYY-MM-DD）表达目标自然月；未传则取当前自然月
// （Node 的 year+month 分支由调用方换算为 happenDate 传入）。
func GetRepaymentRemindersV2(ex db.Commiter, userID string, happenDate string) ([]map[string]any, error) {
	todayYMD := tim.BeijingToday()
	todayTime := ymdToTime(todayYMD)

	var targetMonth string
	if happenDate != "" {
		targetMonth = happenDate
		if len(targetMonth) > 7 {
			targetMonth = targetMonth[:7]
		}
	} else {
		targetMonth = todayYMD[:7]
	}
	monthPrefix := targetMonth + "-"

	rows, err := qRows(ex, `
      SELECT cb.id, cb.card_id, cb.bill_month, cb.need_repay, cb.remind_days,
              c.alias AS card_alias, c.last4_no AS card_last4, c.repay_day, c.bill_day
       FROM card_bill cb
       LEFT JOIN card_base c ON cb.card_id = c.id
       WHERE cb.user_id = ? AND cb.is_deleted = 0
         AND (cb.remind_switch = 1 OR cb.remind_switch IS NULL)
         AND cb.need_repay > 0
       ORDER BY cb.bill_month DESC`, userID)
	if err != nil {
		return nil, err
	}

	result := []map[string]any{}
	for _, r := range rows {
		needRepay := toF(r["need_repay"])
		if needRepay <= 0 {
			continue
		}
		billMonth := toStr(r["bill_month"])
		if billMonth == "" {
			continue
		}
		billDay := toI(r["bill_day"])
		repayDay := toI(r["repay_day"])
		if repayDay == 0 {
			continue
		}
		// 对应 try/catch：非法月份等跳过
		if !ymRe.MatchString(billMonth) {
			continue
		}
		var billDateYMD string
		if billDay != 0 {
			billDateYMD = CalculateBillDate(billMonth, billDay)
		}
		repayDateYMD := CalculateRepayDate(billMonth, repayDay)

		remindDays := toI(r["remind_days"])
		cardName := strings.TrimSpace(toStr(r["card_alias"]))
		if cardName == "" {
			cardName = "****" + toStr(r["card_last4"])
		}
		content := cardName + " 信用卡还款 ¥" + cur.FormatCNY(needRepay)

		// 事件 A：账单日出账提醒（归位账单月）
		if billDateYMD != "" && strings.HasPrefix(billDateYMD, monthPrefix) {
			billTime := ymdToTime(billDateYMD)
			result = append(result, map[string]any{
				"id":          "cardbill_billday_" + toStr(r["id"]),
				"source":      "card_bill",
				"content":     content,
				"happen_date": billDateYMD,
				"remind_time": billTime - int64(remindDays)*86400000,
				"need_remind": 1,
				"priority":    1,
				"status":      pickStatus(billTime < todayTime),
				"event_type":  "信用卡还款",
				"remark":      "账单月份 " + billMonth + "（账单日提醒）",
				"bill_id":     r["id"],
				"card_id":     r["card_id"],
				"remind_days": remindDays,
			})
		}

		// 事件 B：还款日逾期预警（归位还款日所在月，天然即"跨月仍未还清"才出现）
		if strings.HasPrefix(repayDateYMD, monthPrefix) {
			repayTime := ymdToTime(repayDateYMD)
			result = append(result, map[string]any{
				"id":          "cardbill_repayday_" + toStr(r["id"]),
				"source":      "card_bill",
				"content":     content,
				"happen_date": repayDateYMD,
				"remind_time": repayTime - int64(remindDays)*86400000,
				"need_remind": 1,
				"priority":    1,
				"status":      pickStatus(repayTime < todayTime),
				"event_type":  "信用卡还款",
				"remark":      "账单月份 " + billMonth + "（还款日提醒）",
				"bill_id":     r["id"],
				"card_id":     r["card_id"],
				"remind_days": remindDays,
			})
		}
	}
	// 对应 result.sort((a, b) => (a.happen_date || '').localeCompare(...))（稳定排序）
	sort.SliceStable(result, func(i, j int) bool {
		return toStr(result[i]["happen_date"]) < toStr(result[j]["happen_date"])
	})
	return result, nil
}

func pickStatus(overdue bool) string {
	if overdue {
		return "逾期"
	}
	return "待完成"
}

// FindLatestByCardId 对应 CardBill.findLatestByCardId（限定 user_id，防越权）。
func FindLatestByCardId(ex db.Commiter, cardID, userID string) (map[string]any, error) {
	return qRow(ex, `
      SELECT * FROM card_bill
      WHERE card_id = ? AND user_id = ? AND is_deleted = 0
      ORDER BY bill_month DESC
      LIMIT 1
    `, cardID, userID)
}

// FindById 对应 CardBill.findById(id, userId, executor)。
func FindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	return qRow(ex, fmt.Sprintf(`
      SELECT cb.*, c.alias as card_alias, c.last4_no as card_last4, c.currency,
             c.repay_day,
             %s as repay_date_calc,
             CASE 
               WHEN cb.need_repay > 0 AND %s < CURDATE()
               THEN 1 ELSE 0 
             END as is_overdue_calc,
             CASE 
               WHEN cb.need_repay > 0 AND %s < CURDATE()
               THEN DATEDIFF(CURDATE(), %s)
               ELSE 0 
             END as overdue_days_calc
      FROM card_bill cb
      LEFT JOIN card_base c ON cb.card_id = c.id
      WHERE cb.id = ? AND cb.user_id = ? AND cb.is_deleted = 0
    `, REPAY_DATE_SQL, REPAY_DATE_SQL, REPAY_DATE_SQL, REPAY_DATE_SQL), id, userID)
}

// FindByCardAndMonth 对应 CardBill.findByCardAndMonth。
// keep：Node 此方法无 user_id 过滤，维持原样。
func FindByCardAndMonth(ex db.Commiter, cardID, billMonth string) (map[string]any, error) {
	return qRow(ex, `
      SELECT * FROM card_bill
      WHERE card_id = ? AND bill_month = ? AND is_deleted = 0
    `, cardID, billMonth)
}

// GetOrCreateBill 对应 CardBill.getOrCreateBill(cardId, userId, billMonth, executor)。
//
// 🔧 SYNC-A40（2026-10-13）：补回 billMonth 入参（原 Go 契约为 (ex, cardID, userID)，
// 月份硬编码当前月）。Node bill.js:387-399 是 `billMonth || this.getCurrentBillMonth()`，
// 缺该参数就无法为指定历史/未来账单月补建空壳快照（补账、跨月首刷、账单日切月补单）。
// billMonth 传 "" 时仍回退当前月，行为与旧实现一致 ⇒ 现有唯一调用方行为不变。
func GetOrCreateBill(ex db.Commiter, cardID, userID, billMonth string) (map[string]any, error) {
	card, err := GetCardInfo(ex, cardID)
	if err != nil {
		return nil, err
	}
	if card == nil {
		return nil, errors.New("卡片不存在")
	}
	if toStr(card["card_type"]) != "credit" {
		return nil, errors.New("只有信用卡才需要账单")
	}
	month := billMonth
	if month == "" {
		month = GetCurrentBillMonth()
	}
	bill, err := FindByCardAndMonth(ex, cardID, month)
	if err != nil {
		return nil, err
	}
	if bill != nil {
		return bill, nil
	}
	return createBill(ex, cardID, userID, month, nil)
}

// createBill 对应 CardBill.create({userId, cardId, billMonth, pointsRate, remindSwitch, remindDays})。
// H8 审计：额度字段一律由 CreditCore 计算（唯一真相源），仅处理 remind/points 元数据；
// data 为可选字段（pointsRate/remindSwitch/remindDays），nil 表示均未传。
func createBill(ex db.Commiter, cardID, userID, billMonth string, data map[string]any) (map[string]any, error) {
	now := tim.NowMS()
	card, err := GetCardInfo(ex, cardID)
	if err != nil {
		return nil, err
	}
	if card == nil {
		return nil, errors.New("卡片不存在")
	}
	if toStr(card["card_type"]) != "credit" {
		return nil, errors.New("只有信用卡才需要账单")
	}
	month := billMonth
	if month == "" {
		month = GetCurrentBillMonth()
	}

	// 已有账单：仅同步提醒/积分元数据，额度一律不动（交由 CreditCore 重算）
	existing, err := FindByCardAndMonth(ex, cardID, month)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		sets := []string{"update_time = ?"}
		params := []any{now}
		if v, ok := data["remindSwitch"]; ok && v != nil {
			sets = append(sets, "remind_switch = ?")
			params = append(params, b2i(v))
		}
		if v, ok := data["remindDays"]; ok && v != nil {
			sets = append(sets, "remind_days = ?")
			params = append(params, toI(v))
		}
		if v, ok := data["pointsRate"]; ok && v != nil {
			sets = append(sets, "points_rate = ?")
			params = append(params, toF(v))
		}
		if _, err := ex.Exec(
			"UPDATE card_bill SET "+strings.Join(sets, ", ")+" WHERE id = ?",
			append(params, existing["id"])...); err != nil {
			return nil, err
		}
		return FindById(ex, toStr(existing["id"]), userID)
	}

	// 不存在：先由 CreditCore 全量重算（生成所有有流水月份的快照，口径统一、含共享池）
	// C8 审计：重算失败必须向上抛出，不得吞错后建"零消费、零待还"空壳
	// （hook 签名无 error 返回，无法传播重算失败，见 SyncCardBillsHook 注释）。
	if SyncCardBillsHook != nil {
		SyncCardBillsHook(ex, cardID, userID)
	}

	// 若目标月份仍无账单（该月无消费/还款流水），创建空壳快照（额度占位，后续 syncCardBills 覆盖）
	bill, err := FindByCardAndMonth(ex, cardID, month)
	if err != nil {
		return nil, err
	}
	if bill == nil {
		id := idgen.BillID()
		billStartDate, billEndDate := CalculateBillPeriod(month, toI(card["bill_day"]))
		finalCreditLimit := toF(card["credit_limit"])
		finalTempLimit := toF(card["temp_limit"])
		finalPointsRate := 1.0 // parseFloat(card.points_rate) || 1
		if v, ok := data["pointsRate"]; ok && v != nil {
			finalPointsRate = toF(v)
		} else if pr := toF(card["points_rate"]); pr != 0 {
			finalPointsRate = pr
		}
		remindSwitchVal := 1 // remindSwitch 未传默认 1
		if v, ok := data["remindSwitch"]; ok && v != nil {
			remindSwitchVal = b2i(v)
		}
		remindDaysVal := 3 // remindDays 未传默认 3
		if v, ok := data["remindDays"]; ok && v != nil {
			remindDaysVal = toI(v)
		}
		_, err := ex.Exec(
			`INSERT INTO card_bill (
            id, card_id, bill_month, user_id, credit_limit, avail_limit, used_limit,
            temp_limit, bill_start_date, bill_end_date, bill_amount,
            min_repay, repaid, need_repay, points, points_rate,
            remind_switch, remind_days, create_time, update_time, is_deleted
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			id, cardID, month, userID,
			finalCreditLimit, finalCreditLimit+finalTempLimit, 0,
			finalTempLimit, billStartDate, billEndDate, 0,
			0, 0, 0, 0, finalPointsRate,
			remindSwitchVal,
			remindDaysVal,
			now, now)
		if err != nil {
			// 对应 Node error.code === 'ER_DUP_ENTRY'
			var myErr *mysql.MySQLError
			if errors.As(err, &myErr) && myErr.Number == 1062 {
				return FindByCardAndMonth(ex, cardID, month)
			}
			return nil, err
		}
		// 空壳快照也交由 CreditCore 规范化一次（共享池卡会把 avail_limit 覆盖为池口径）
		if SyncCardBillsHook != nil {
			SyncCardBillsHook(ex, cardID, userID)
		}
	}
	return FindByCardAndMonth(ex, cardID, month)
}

// UpdateBill 对应 CardBill.update(id, userId, updates)。
// 只允许更新 remindSwitch/remindDays；返回受影响行数。
// 注意：Node 在无有效字段时返回 findById 整行业，Go 契约为 (affected, error)，无字段可更时返回 0。
func UpdateBill(ex db.Commiter, id, userID string, data map[string]any) (int64, error) {
	now := tim.NowMS()
	allowedFields := map[string]string{
		"remindSwitch": "remind_switch",
		"remindDays":   "remind_days",
	}
	var fields []string
	var params []any
	if v, ok := data["remindSwitch"]; ok {
		fields = append(fields, allowedFields["remindSwitch"]+" = ?")
		params = append(params, b2i(v))
	}
	if v, ok := data["remindDays"]; ok {
		fields = append(fields, allowedFields["remindDays"]+" = ?")
		if v == nil {
			params = append(params, nil) // Node: params.push(undefined) → 写 NULL
		} else {
			params = append(params, toI(v))
		}
	}
	if len(fields) == 0 {
		return 0, nil
	}
	fields = append(fields, "update_time = ?")
	params = append(params, now)
	params = append(params, id, userID)
	res, err := ex.Exec(
		"UPDATE card_bill SET "+strings.Join(fields, ", ")+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		params...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, nil
}

// DeleteBill 对应 CardBill.delete(id, userId)（软删除）。
// H8 审计：删除后必须重算——若该卡该月仍有账本流水，CreditCore 会按账本重建快照。
// Node 的重算用全局连接且失败仅 console.error 吞错，此处维持原样。
func DeleteBill(ex db.Commiter, id, userID string) (int64, error) {
	bill, err := FindById(ex, id, userID)
	if err != nil {
		return 0, err
	}
	if bill == nil {
		return 0, nil
	}
	now := tim.NowMS()
	res, err := ex.Exec(
		"UPDATE card_bill SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
		now, id, userID)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if n > 0 && truthy(bill["card_id"]) {
		if SyncCardBillsHook != nil {
			// 对应 Node：不加事务、失败仅 console.error（维持原样）
			SyncCardBillsHook(db.DB(), toStr(bill["card_id"]), userID)
		}
	}
	return n, nil
}
