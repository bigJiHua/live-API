package todo

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
	"live/api/internal/mod/cardbill"
	"live/api/internal/resp"
	"live/api/internal/tim"
)

// ============================================================================
// 待办事项控制器 —— from: controller/index.js（逐函数复刻）
// keep BUG-028：findByMonth/-31 上界与 findOpenReminders 下月1号(含)维持原样。
// ============================================================================

// dateRe 对应 /^\d{4}-\d{2}-\d{2}$/。
var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// Create 创建待办。from: controller/index.js:17-48
func Create(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	// 🔄 2026-10-13（api.md P2-12）：双路径 `req.body.data || req.body`（本路由无 Joi 校验）。
	d := resp.Parse(r).DataOrRaw()

	content := d["content"]
	if !truthyJS(content) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "事件内容不能为空"})
		return
	}
	if s, ok := content.(string); ok {
		if strings.TrimSpace(s) == "" {
			resp.JSON(w, 400, map[string]any{"status": 400, "message": "事件内容不能为空"})
			return
		}
	} else {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErrBody。
		// Node 的 content.trim() TypeError 发生在 try 内 → 被 catch 捕获 →
		// 走 buildErrorBody('创建失败', error) ⇒ **对外 message 是「创建失败」**，
		// TypeError 文本只出现在 dev 环境的 error 键里。
		// 旧实现把 TypeError 文本塞进 message ⇒ 生产环境也回显内部错误细节。
		resp.SayErrBody(w, 500, "创建失败", errors.New("content.trim is not a function"))
		return
	}

	happenDate := toStrJS(d["happen_date"])
	if happenDate != "" && !dateRe.MatchString(happenDate) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "日期格式不正确，应为 YYYY-MM-DD"})
		return
	}

	result, err := TodoCreate(db.DB(), createParams{
		UserID:      uid,
		Content:     content,
		EventType:   d["event_type"],
		HappenDate:  d["happen_date"],
		Priority:    d["priority"],
		NeedRemind:  d["need_remind"],
		RemindDays:  d["remind_days"],
		RemindTime:  d["remind_time"],
		IsRecurring: d["is_recurring"],
		Remark:      d["remark"],
	})
	if err != nil {
		resp.SayErrBody(w, 500, "创建失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": result})
}

// List 获取待办列表（happen_date 存在时追加 CardBill.getRepaymentRemindersV2）。
// from: controller/index.js:53-80
func List(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()

	f := findAllFilters{}
	if v := q.Get("status"); v != "" {
		f.Status = v
	}
	if v := q.Get("event_type"); v != "" {
		f.EventType = v
	}
	if v := q.Get("start_date"); v != "" {
		f.StartDate = v
	}
	if v := q.Get("end_date"); v != "" {
		f.EndDate = v
	}
	if v := q.Get("keyword"); v != "" {
		f.Keyword = v
	}
	happenDate := q.Get("happen_date")
	if happenDate != "" {
		f.StartDate = happenDate
		f.EndDate = happenDate
	}

	rows, err := FindAll(db.DB(), uid, f)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}

	// 注入该日的信用卡还款提醒（source=card_bill，V2：账单日+还款日双事件口径）
	result := rows
	if happenDate != "" {
		cardRows, err := cardbill.GetRepaymentRemindersV2(db.DB(), uid, happenDate)
		if err != nil {
			resp.SayErrBody(w, 500, "查询失败", err)
			return
		}
		result = append(append([]map[string]any{}, rows...), cardRows...)
	}

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": result})
}

// CalendarMonth 按月获取日历数据（todo + recurring + cardBill 三方合并）。
// from: controller/index.js:85-141
func CalendarMonth(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()

	yearRaw := q.Get("year")
	monthRaw := q.Get("month")
	if yearRaw == "" || monthRaw == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "year 和 month 参数必填"})
		return
	}
	yf := jsParseFloatLoose(yearRaw)
	mf := jsParseFloatLoose(monthRaw)
	y, m := int(yf), int(mf)

	data, err := FindByMonth(db.DB(), uid, y, m)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	recurringEvents, err := recurringCalendarEvents(db.DB(), uid, y, m)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	cardEvents, err := cardbill.GetRepaymentRemindersV2(db.DB(), uid, yearMonthStr(yf, mf))
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}

	calendar := map[string]any{"year": y, "month": m, "days": []map[string]any{}}
	days := []map[string]any{}

	// 转换为日历网格格式（补齐该月所有日期）
	// new Date(year, month-1, 1) / new Date(year, month, 0)：NaN 时两个循环均不执行（days=[]）
	if !isNaN(yf) && !isNaN(mf) {
		firstDay := time.Date(y, time.Month(m), 1, 0, 0, 0, 0, tim.Loc())
		lastDay := time.Date(y, time.Month(m)+1, 0, 0, 0, 0, 0, tim.Loc())
		daysInMonth := lastDay.Day()
		startWeekday := int(firstDay.Weekday())

		// 补齐月初空白
		for i := 0; i < startWeekday; i++ {
			days = append(days, map[string]any{"day": nil, "list": []map[string]any{}})
		}

		// 填充日期
		for day := 1; day <= daysInMonth; day++ {
			dateStr := yearRaw + "-" + padStart2(monthRaw) + "-" + padStart2(strconv.Itoa(day))
			list := []map[string]any{}
			// data.find(item => item.date === dateStr)
			//
			// 🔒 SYNC-A28（2026-10-12）：Node 的 find 只取**第一个**匹配组
			//   （todo/controller/index.js:123），原 Go 循环累加所有匹配组 ——
			//   同日期存在多组时列表翻倍、count 虚高。改为匹配即跳出。
			for _, item := range data {
				if toStrJS(item["date"]) == dateStr {
					if l, ok := item["list"].([]map[string]any); ok {
						list = append(list, l...)
					}
					break
				}
			}
			for _, item := range recurringEvents {
				if toStrJS(item["happen_date"]) == dateStr {
					list = append(list, item)
				}
			}
			for _, item := range cardEvents {
				if toStrJS(item["happen_date"]) == dateStr {
					list = append(list, item)
				}
			}
			hasCompleted, hasOverdue := false, false
			for _, item := range list {
				switch toStrJS(item["status"]) {
				case "已完成":
					hasCompleted = true
				case "逾期":
					hasOverdue = true
				}
			}
			days = append(days, map[string]any{
				"day":          day,
				"date":         dateStr,
				"list":         list,
				"count":        len(list),
				"hasCompleted": hasCompleted,
				"hasOverdue":   hasOverdue,
			})
		}
	}
	calendar["days"] = days

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": calendar})
}

// Reminders 获取即将提醒的待办（todo + recurring 当月 + cardBill 当月合并）。
// from: controller/index.js:227-268
func Reminders(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()

	// ⚠️ 统一用「北京时间」取当前年月（与 Node 注释一致）
	bjNow := tim.BeijingNow()
	yf := float64(bjNow.Year())
	mf := float64(int(bjNow.Month()))
	if v := q.Get("year"); v != "" {
		yf = jsParseFloatLoose(v) // parseInt
	}
	if v := q.Get("month"); v != "" {
		mf = jsParseFloatLoose(v)
	}
	var daysAround *float64
	if v, ok := q["days"]; ok { // Node: days != null（键存在即用，空串 → NaN）
		n := jsParseFloatLoose(v[0])
		daysAround = &n
	}

	// 横幅按月加载「未完成」待办；首页提醒传 days（今日±N天窗口）
	var todos []map[string]any
	if daysAround != nil {
		inWindow, err := FindOpenReminders(db.DB(), uid, openReminderOpts{DaysAround: daysAround})
		if err != nil {
			resp.SayErrBody(w, 500, "查询失败", err)
			return
		}
		// content==='1' 为飞机模式占位行，不计入有效数据
		validInWindow := []map[string]any{}
		for _, row := range inWindow {
			if truthyJS(row["content"]) && toStrJS(row["content"]) != "1" {
				validInWindow = append(validInWindow, row)
			}
		}
		if len(validInWindow) > 0 {
			todos = inWindow
		} else {
			rows, err := FindOpenReminders(db.DB(), uid, openReminderOpts{
				PastOnly: true, Year: yf, Month: mf,
			})
			if err != nil {
				resp.SayErrBody(w, 500, "查询失败", err)
				return
			}
			todos = rows
		}
	} else {
		rows, err := FindOpenReminders(db.DB(), uid, openReminderOpts{Year: yf, Month: mf})
		if err != nil {
			resp.SayErrBody(w, 500, "查询失败", err)
			return
		}
		todos = rows
	}

	// recurring：当月固定支出（y && m 为假值时退化为当前自然月）
	monthArg := ""
	if truthyJS(yf) && truthyJS(mf) {
		monthArg = yearMonthStr(yf, mf)
	}
	recurring, err := recurringUpcomingRemindersCurrentMonth(db.DB(), uid, monthArg)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	// 🔒 SYNC-A40（2026-10-13）：monthArg 的真值回退必须**同时**用于 recurring 与 cardBills。
	//
	// Node bill.js:244-252 的三段语义：
	//     if (happenDate)   targetMonth = String(happenDate).substring(0, 7);
	//     else if (year && month) targetMonth = `${year}-${padStart(month)}`;
	//     else              targetMonth = todayYMD.substring(0, 7);   // ← 回退当前自然月
	//
	// 关键推导（本条曾两次误判，务必看清）：
	//   ?year=0 时，本文件 228 行 `q.Get("year")` 返回 **"0"**，而 `"0" != ""` **成立**
	//   ⇒ 进入分支 ⇒ `yf = jsParseFloatLoose("0")` = **float64(0)**
	//   ⇒ `truthyJS(float64(0))` = **false** ⇒ 回退分支生效。
	//   Node 侧同样：`year ? parseInt(year,10) : ...`，`"0"` 是非空字符串（truthy）
	//   ⇒ y = parseInt("0",10) = **数字 0** ⇒ 下游 `year && month` 为 falsy ⇒ 回退。
	//   **两端都会回退。**
	//
	// 但原实现给 cardBills 无条件传 `yearMonthStr(yf, mf)` = "0-00"
	// ⇒ monthPrefix "0-00-" 永不匹配 ⇒ **本月全部信用卡还款提醒消失**，与 Node 不一致。
	// recurring 那条早已用 monthArg 做了回退，唯独 cardBills 漏了。
	cardBills, err := cardbill.GetRepaymentRemindersV2(db.DB(), uid, monthArg)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}

	rows := append(append(append([]map[string]any{}, todos...), recurring...), cardBills...)
	// (a.happen_date || '').localeCompare(...)（稳定排序）
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && toStrJS(rows[j]["happen_date"]) < toStrJS(rows[j-1]["happen_date"]); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": rows})
}

// Detail 获取详情。from: controller/index.js:146-161
func Detail(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")

	result, err := TodoFindById(db.DB(), id, uid)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	if result == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": result})
}

// Update 更新待办。from: controller/index.js:166-201
func Update(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	// 🔄 2026-10-13（api.md P2-12）：双路径 `req.body.data || req.body`（同 Create）。
	d := resp.Parse(r).DataOrRaw()

	existing, err := TodoFindById(db.DB(), id, uid)
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	if existing == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}

	content := d["content"]
	if content != nil {
		s, isStr := content.(string)
		if !isStr {
			// 🔒 SYNC-A42：同Create —— Node 走 buildErrorBody('更新失败', error)，对外是「更新失败」。
			resp.SayErrBody(w, 500, "更新失败", errors.New("content.trim is not a function"))
			return
		}
		if strings.TrimSpace(s) == "" {
			resp.JSON(w, 400, map[string]any{"status": 400, "message": "事件内容不能为空"})
			return
		}
	}

	updates := map[string]any{}
	if v, ok := d["content"]; ok {
		updates["content"] = strings.TrimSpace(toStrJS(v))
	}
	if v, ok := d["event_type"]; ok {
		updates["event_type"] = v
	}
	if v, ok := d["happen_date"]; ok {
		updates["happen_date"] = v
	}
	if v, ok := d["status"]; ok {
		updates["status"] = v
	}
	if v, ok := d["priority"]; ok {
		updates["priority"] = v
	}
	if v, ok := d["need_remind"]; ok {
		updates["need_remind"] = b2i(v)
	}
	if v, ok := d["remind_days"]; ok {
		updates["remind_days"] = v
	}
	if v, ok := d["remind_time"]; ok {
		updates["remind_time"] = v
	}
	if v, ok := d["is_recurring"]; ok {
		updates["is_recurring"] = b2i(v)
	}
	if v, ok := d["remark"]; ok {
		updates["remark"] = v
	}

	result, err := TodoUpdate(db.DB(), id, uid, updates)
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": result})
}

// Delete 删除待办。from: controller/index.js:206-221
func Delete(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")

	result, err := TodoDelete(db.DB(), id, uid)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// ===== 小工具 =====

// jsParseFloatQuery 对应 parseInt(str, 10)：宽松前缀解析，失败 NaN。
func jsParseFloatQuery(s string) float64 { return jsParseFloatLoose(s) }

// padStart2 对应 String(x).padStart(2, '0')（仅补齐不截断）。
func padStart2(s string) string {
	for len(s) < 2 {
		s = "0" + s
	}
	return s
}

// yearMonthStr 对应 Node `${year}-${String(month).padStart(2, '0')}`（year/month 为数字）。
func yearMonthStr(year, month float64) string {
	return fmt.Sprintf("%s-%s", jsNumToStr(year), padStart2(jsNumToStr(month)))
}

// jsNumToStr 对应 JS Number → String（NaN → "NaN"）。
func jsNumToStr(f float64) string {
	if isNaN(f) {
		return "NaN"
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
