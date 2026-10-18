package todo

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// ============================================================================
// 待办事项模型 —— from: model/index.js（SQL 逐字一致）
// keep BUG-028：findOpenReminders 月分支上界为「下月1号」(<=)，多显示一天待办，维持原样。
// 未移植：findByYear / batchUpdateStatus / getOverdueItems / getUpcomingReminders
// （Node 侧无任何路由或模块调用，属死代码）。
// ============================================================================

// createParams 对应 Node create 的解构入参。
type createParams struct {
	UserID      string
	Content     any
	EventType   any
	HappenDate  any
	Priority    any
	NeedRemind  any
	RemindDays  any
	RemindTime  any
	IsRecurring any
	Remark      any
}

// TodoCreate 对应 Todo.create。from: todo/model/index.js:19-69
func TodoCreate(ex db.Commiter, p createParams) (map[string]any, error) {
	now := tim.NowMS()

	// 业务规则：remark 不能超过 50 个字符（JS length = UTF-16 code unit 数）
	if s, ok := p.Remark.(string); ok && len(utf16.Encode([]rune(s))) > 50 {
		return nil, fmt.Errorf("备注不能超过50个字符")
	}

	happenDate := toStrJS(p.HappenDate)

	// 业务规则：一天最多添加 10 个事件
	if happenDate != "" {
		cnt, err := qRow(ex,
			`SELECT COUNT(*) as total FROM todo WHERE user_id = ? AND happen_date = ? AND is_deleted = 0`,
			p.UserID, happenDate)
		if err != nil {
			return nil, err
		}
		if jsNumber(cnt["total"]) >= 10 {
			return nil, fmt.Errorf("该日期已添加10个事件，达到每日上限")
		}
	}

	// 计算提醒时间：happen_date - remind_days 天
	// 注意：new Date('YYYY-MM-DD') 按 UTC 解析（与 JS 一致），非本地时区。
	var finalRemindTime any
	if truthyJS(p.RemindTime) {
		finalRemindTime = p.RemindTime
	}
	if truthyJS(p.NeedRemind) && happenDate != "" && truthyJS(p.RemindDays) && !truthyJS(p.RemindTime) {
		t, err := time.ParseInLocation("2006-01-02", happenDate, time.UTC)
		if err != nil {
			finalRemindTime = "NaN" // Invalid Date.getTime() = NaN → String(NaN)
		} else {
			remindTimestamp := t.UnixMilli() - int64(jsNumber(p.RemindDays))*24*60*60*1000
			finalRemindTime = strconv.FormatInt(remindTimestamp, 10)
		}
	}

	id := idgen.BillID()
	_, err := ex.Exec(`
      INSERT INTO todo 
      (id, user_id, content, event_type, happen_date, status, priority, need_remind, remind_time, is_recurring, remark, create_time, update_time, is_deleted)
      VALUES (?, ?, ?, ?, ?, '待完成', ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, p.UserID, p.Content,
		orNil(p.EventType), orNil(p.HappenDate),
		orNum(orJS(p.Priority, 2)),
		b2i(p.NeedRemind),
		finalRemindTime,
		b2i(p.IsRecurring),
		orNil(p.Remark),
		now, now)
	if err != nil {
		return nil, err
	}

	return TodoFindById(ex, id, p.UserID)
}

// FindOpenReminders 获取用户「未完成」待办（status='待完成'）。
// from: todo/model/index.js:76-110
//   - Year+Month（均真值）：该月首日 ~ 下月首日(含)   keep BUG-028
//   - DaysAround：今日 ± N 天窗口（北京时间；NaN → "Invalid Date"）
//   - PastOnly：当月1号 ~ 今日(含)
func FindOpenReminders(ex db.Commiter, userID string, opts openReminderOpts) ([]map[string]any, error) {
	sqlStr := `SELECT * FROM todo WHERE user_id = ? AND is_deleted = 0 AND status = '待完成'`
	params := []any{userID}

	if truthyJS(opts.Year) && truthyJS(opts.Month) {
		year, month := int(opts.Year), int(opts.Month)
		m := strconv.Itoa(month)
		if len(m) < 2 {
			m = "0" + m
		}
		prefix := fmt.Sprintf("%04d-%s-", year, m)
		sqlStr += ` AND happen_date >= ? AND happen_date <= ?`
		// 该月首日 ~ 下月首日(不含)—— keep BUG-028：Node 实际为 <= 下月首日
		next := time.Date(year, time.Month(month)+1, 1, 0, 0, 0, 0, tim.Loc())
		endY := next.Year()
		endM := strconv.Itoa(int(next.Month()))
		if len(endM) < 2 {
			endM = "0" + endM
		}
		params = append(params, prefix+"01", fmt.Sprintf("%04d-%s-01", endY, endM))
	} else if opts.DaysAround != nil {
		// 今日 ± N 天窗口（含今天），统一用北京时间计算
		bj := tim.BeijingNow()
		from, to := "Invalid Date", "Invalid Date"
		if !isNaN(*opts.DaysAround) {
			from = bj.AddDate(0, 0, -int(*opts.DaysAround)).Format("2006-01-02")
			to = bj.AddDate(0, 0, int(*opts.DaysAround)).Format("2006-01-02")
		}
		sqlStr += ` AND happen_date >= ? AND happen_date <= ?`
		params = append(params, from, to)
	} else if opts.PastOnly {
		// 窗口(今日±N天)内无数据时回退：取「当月1号 ~ 今日(含)」的未完成待办
		y, m := opts.Year, opts.Month
		if !truthyJS(y) {
			y = float64(tim.BeijingNow().Year())
		}
		if !truthyJS(m) {
			y2 := tim.BeijingNow()
			m = float64(int(y2.Month()))
		}
		monthStart := fmt.Sprintf("%04d-%02d-01", int(y), int(m))
		sqlStr += ` AND happen_date >= ? AND happen_date <= ?`
		params = append(params, monthStart, tim.BeijingToday())
	}
	sqlStr += ` ORDER BY happen_date ASC, priority ASC, create_time DESC`
	return qRows(ex, sqlStr, params...)
}

// openReminderOpts 对应 findOpenReminders 的 opts（Year/Month 携带 NaN 语义）。
type openReminderOpts struct {
	Year       float64
	Month      float64
	DaysAround *float64
	PastOnly   bool
}

// TodoFindById 根据 ID 查询。from: todo/model/index.js:115-121
func TodoFindById(ex db.Commiter, id, userID string) (map[string]any, error) {
	return qRow(ex,
		`SELECT * FROM todo WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		id, userID)
}

// findAllFilters 对应 findAll 的 filters。
type findAllFilters struct {
	Status    string
	EventType string
	StartDate string
	EndDate   string
	Keyword   string
}

// FindAll 获取用户的待办列表。from: todo/model/index.js:126-165
func FindAll(ex db.Commiter, userID string, f findAllFilters) ([]map[string]any, error) {
	whereClause := "WHERE user_id = ? AND is_deleted = 0"
	params := []any{userID}

	if f.Status != "" {
		whereClause += " AND status = ?"
		params = append(params, f.Status)
	}
	if f.EventType != "" {
		whereClause += " AND event_type = ?"
		params = append(params, f.EventType)
	}
	if f.StartDate != "" {
		whereClause += " AND happen_date >= ?"
		params = append(params, f.StartDate)
	}
	if f.EndDate != "" {
		whereClause += " AND happen_date <= ?"
		params = append(params, f.EndDate)
	}
	if f.Keyword != "" {
		whereClause += " AND content LIKE ?"
		params = append(params, "%"+f.Keyword+"%")
	}

	query := `
      SELECT * FROM todo 
      ` + whereClause + ` ORDER BY happen_date ASC, priority ASC, create_time DESC
    `
	return qRows(ex, query, params...)
}

// FindByMonth 按月查询待办（返回日历格式数据 {date, list, count, hasCompleted, hasOverdue}）。
// from: todo/model/index.js:171-203
// 注意：上界为 `${year}-${mm}-31` 字符串边界（短月天然不会越界，2 月会覆盖到 02-29/30 的说法不成立，
// '2026-02-31' 大于任何 2 月日期，等价于 <= 月末；维持 Node 原样）。
func FindByMonth(ex db.Commiter, userID string, year, month int) ([]map[string]any, error) {
	startDate := fmt.Sprintf("%04d-%02d-01", year, month)
	endDate := fmt.Sprintf("%04d-%02d-31", year, month)

	rows, err := qRows(ex, `
      SELECT * FROM todo 
      WHERE user_id = ? AND is_deleted = 0 
        AND happen_date >= ? AND happen_date <= ?
      ORDER BY happen_date ASC, priority ASC, create_time ASC`,
		userID, startDate, endDate)
	if err != nil {
		return nil, err
	}

	// 按日期分组（NULL happen_date 在 JS 中键为 "null"）
	grouped := map[string][]map[string]any{}
	var order []string
	for _, row := range rows {
		date := dateKey(row["happen_date"])
		if _, ok := grouped[date]; !ok {
			order = append(order, date)
		}
		grouped[date] = append(grouped[date], row)
	}

	// Object.keys(grouped).sort()：字典序即日期序
	keys := append([]string{}, order...)
	sortStrings(keys)

	out := []map[string]any{}
	for _, date := range keys {
		list := grouped[date]
		hasCompleted, hasOverdue := false, false
		for _, item := range list {
			switch toStrJS(item["status"]) {
			case "已完成":
				hasCompleted = true
			case "逾期":
				hasOverdue = true
			}
		}
		out = append(out, map[string]any{
			"date":         date,
			"list":         list,
			"count":        len(list),
			"hasCompleted": hasCompleted,
			"hasOverdue":   hasOverdue,
		})
	}
	return out, nil
}

// TodoUpdate 更新待办事项。from: todo/model/index.js:233-278
func TodoUpdate(ex db.Commiter, id, userID string, updates map[string]any) (map[string]any, error) {
	now := tim.NowMS()
	fields := []string{}
	params := []any{}

	// 如果有 remind_days，需要先获取 happen_date 计算 remind_time
	if _, ok := updates["remind_days"]; ok {
		existing, err := TodoFindById(ex, id, userID)
		if err != nil {
			return nil, err
		}
		if existing == nil {
			return nil, fmt.Errorf("记录不存在")
		}
		happenDate := existing["happen_date"]
		if v, ok := updates["happen_date"]; ok && truthyJS(v) {
			happenDate = v
		}
		var needRemind any = existing["need_remind"]
		if v, ok := updates["need_remind"]; ok && v != nil {
			needRemind = v
		}

		if truthyJS(needRemind) && toStrJS(happenDate) != "" && truthyJS(updates["remind_days"]) {
			t, err := time.ParseInLocation("2006-01-02", toStrJS(happenDate), time.UTC)
			if err != nil {
				updates["remind_time"] = "NaN"
			} else {
				remindTimestamp := t.UnixMilli() - int64(jsNumber(updates["remind_days"]))*24*60*60*1000
				updates["remind_time"] = strconv.FormatInt(remindTimestamp, 10)
			}
		}
	}

	allowedFields := []string{"content", "event_type", "happen_date", "status", "priority", "need_remind", "remind_time", "is_recurring", "remark"}
	for _, key := range allowedFields {
		v, ok := updates[key]
		if !ok {
			continue // Node: updates[key] !== undefined（显式 null 写 SQL NULL）
		}
		if key == "remark" {
			if s, ok := v.(string); ok && len(utf16.Encode([]rune(s))) > 50 {
				return nil, fmt.Errorf("备注不能超过50个字符")
			}
		}
		fields = append(fields, key+" = ?")
		params = append(params, v)
	}

	if len(fields) == 0 {
		return TodoFindById(ex, id, userID)
	}

	fields = append(fields, "update_time = ?")
	params = append(params, now)
	params = append(params, id, userID)

	_, err := ex.Exec(
		`UPDATE todo SET `+strings.Join(fields, ", ")+` WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		params...)
	if err != nil {
		return nil, err
	}
	return TodoFindById(ex, id, userID)
}

// TodoDelete 软删除待办事项。from: todo/model/index.js:283-290
func TodoDelete(ex db.Commiter, id, userID string) (bool, error) {
	n, err := execAffected(ex,
		`UPDATE todo SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?`,
		tim.NowMS(), id, userID)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ===== 小工具 =====

// dateKey 对应 JS 对象键转换：null → "null"，其余 String(v)。
func dateKey(v any) string {
	if v == nil {
		return "null"
	}
	return toStrJS(v)
}

func sortStrings(ss []string) {
	for i := 1; i < len(ss); i++ {
		for j := i; j > 0 && ss[j] < ss[j-1]; j-- {
			ss[j], ss[j-1] = ss[j-1], ss[j]
		}
	}
}

// orNil 对应 v || null。
func orNil(v any) any {
	if truthyJS(v) {
		return v
	}
	return nil
}

// orNum 对应 v || 2（priority 默认）。
func orNum(v any) any {
	if truthyJS(v) {
		return v
	}
	return 2
}

// b2i 对应 v ? 1 : 0。
func b2i(v any) int {
	if truthyJS(v) {
		return 1
	}
	return 0
}
