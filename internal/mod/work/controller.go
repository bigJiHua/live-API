package work

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"

	"live/api/internal/resp"
)

// ============================================================================
// 工作与工资控制器 —— from: controller/index.js
// ============================================================================

var workDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// bodyData 对应 `req.body.data || req.body`（🔄 2026-10-13 api.md P2-12：双路径兼容明文/加密）。
func bodyData(b resp.Body) map[string]any {
	return b.DataOrRaw()
}

// List 获取用户工作列表。from: controller/index.js:13-24
func List(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	jobs, err := jobFindAll(uid)
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node work/controller 的 catch 是 `res.say('查询失败', 500)`（logFields.buildErrorBody
		// 在生产剥掉 error 细节）。旧实现把 err.Error() 塞进 "message"，
		// 而 resp.JSON 只剥 "error" 键 ⇒ **绕过了 SYNC-004 的脱敏**，
		// 生产环境 SQL 报错原文（表名/列名/查询片段）直接回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": jobs})
}

// CreateJob 新增工作信息。from: controller/index.js:29-87
func CreateJob(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	jobType := d["job_type"]

	if !jsTruthy(jobType) || (toStr(jobType) != "formal" && toStr(jobType) != "parttime") {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "job_type 必填且为 formal 或 parttime"})
		return
	}

	result, err := jobCreate(JobCreateParams{
		UserID:         uid,
		JobType:        jobType,
		Company:        d["company"],
		JobColor:       d["job_color"],
		Status:         d["status"],
		JoinDate:       d["join_date"],
		LeaveDate:      d["leave_date"],
		PayDay:         d["pay_day"],
		BaseSalary:     d["base_salary"],
		BaseWorkDays:   d["base_work_days"],
		HourlyWage:     d["hourly_wage"],
		SubsidyMeal:    d["subsidy_meal"],
		SubsidyTraffic: d["subsidy_traffic"],
		SubsidyPost:    d["subsidy_post"],
		Social:         d["social"],
		Fund:           d["fund"],
		TaxRate:        d["tax_rate"],
		Remark:         d["remark"],
	})
	if err != nil {
		resp.SayErrBody(w, 500, "创建失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": result})
}

// UpdateJob 编辑工作信息。from: controller/index.js:92-147
func UpdateJob(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	d := bodyData(resp.Parse(r))

	existing, err := jobFindById(id, uid)
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	if existing == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "工作记录不存在"})
		return
	}

	updates := map[string]any{}
	setIfPresent := func(bodyKey, dbKey string) {
		if v, ok := d[bodyKey]; ok && v != nil {
			updates[dbKey] = v
		}
	}
	setIfPresent("company", "company")
	setIfPresent("job_color", "job_color")
	setIfPresent("status", "status")
	setIfPresent("join_date", "join_date")
	setIfPresent("leave_date", "leave_date")
	setIfPresent("pay_day", "pay_day")
	setIfPresent("base_salary", "base_salary")
	setIfPresent("base_work_days", "base_work_days")
	setIfPresent("hourly_wage", "hourly_wage")
	setIfPresent("subsidy_meal", "subsidy_meal")
	setIfPresent("subsidy_traffic", "subsidy_traffic")
	setIfPresent("subsidy_post", "subsidy_post")
	setIfPresent("social", "social")
	setIfPresent("fund", "fund")
	setIfPresent("tax_rate", "tax_rate")
	setIfPresent("remark", "remark")

	result, err := jobUpdate(id, uid, updates)
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": result})
}

// DeleteJob 删除工作（软删）。from: controller/index.js:152-168
func DeleteJob(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	result, err := jobDelete(id, uid)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	if !result {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "工作记录不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// GetDaySalary 获取某一天工资。from: controller/index.js:175-205
func GetDaySalary(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	workDate := q.Get("work_date")
	workHoursRaw := q.Get("work_hours")

	if workDate == "" || !workDateRe.MatchString(workDate) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "work_date 必填且为 YYYY-MM-DD 格式"})
		return
	}

	workHoursMap := map[string]any{}
	if workHoursRaw != "" {
		// 🔒 SYNC-A31（2026-10-12）：Node 是 `JSON.parse(work_hours)`，
		//   解析成功即接受（数组/数字也放行，后续属性访问取到 undefined 而不报错）。
		//   原 Go 直接 Unmarshal 到 map，数组/数字会报错 ⇒ 误返 400。
		//   改为先解析到 any，仅解析失败才 400；非对象按空对象处理。
		var parsed any
		if err := json.Unmarshal([]byte(workHoursRaw), &parsed); err != nil {
			resp.JSON(w, 400, map[string]any{"status": 400, "message": "work_hours 格式错误"})
			return
		}
		if m, ok := parsed.(map[string]any); ok {
			workHoursMap = m
		}
	}

	result, err := getDaySalary(uid, workDate, workHoursMap)
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node work/controller 的 catch 是 `res.say('查询失败', 500)`（logFields.buildErrorBody
		// 在生产剥掉 error 细节）。旧实现把 err.Error() 塞进 "message"，
		// 而 resp.JSON 只剥 "error" 键 ⇒ **绕过了 SYNC-004 的脱敏**，
		// 生产环境 SQL 报错原文（表名/列名/查询片段）直接回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": result})
}

// SaveDaySalary 手动保存当日工资。
// 保存成功后自动补充本月缺失的正式工日薪数据。
// from: controller/index.js:211-247
func SaveDaySalary(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	jobID := d["job_id"]
	workDate := toStr(d["work_date"])

	if !jsTruthy(jobID) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "job_id 必填"})
		return
	}
	if workDate == "" || !workDateRe.MatchString(workDate) {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "work_date 必填且为 YYYY-MM-DD 格式"})
		return
	}

	result, err := saveDaySalary(SaveDaySalaryParams{
		UserID:    uid,
		JobID:     jobID,
		WorkDate:  workDate,
		WorkHours: d["work_hours"],
		Cut:       d["cut"],
		Subsidy:   d["subsidy"],
		Status:    d["status"],
		Remark:    d["remark"],
	})
	if err != nil {
		resp.SayErrBody(w, 500, "保存失败", err)
		return
	}

	// 保存成功后，静默补充本月缺失的正式工日薪数据（当月1日 ~ 插入日期）。
	// fix BUG-038：Node 为 fire-and-forget 未 catch；Go 用显式 goroutine + recover。
	go func() {
		defer func() { _ = recover() }()
		_ = FillMissingFormalSalary(uid, workDate)
	}()

	resp.JSON(w, 200, map[string]any{"status": 200, "message": "保存成功", "data": result})
}

// GetMonthSalary 按月统计工资。from: controller/index.js:252-275
func GetMonthSalary(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	year := q.Get("year")
	month := q.Get("month")

	if year == "" || month == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "year 和 month 必填"})
		return
	}

	result, err := getMonthSalary(uid, jsParseInt(year), jsParseInt(month))
	if err != nil {
		// 🔒 SYNC-A42（2026-10-13）：改用 SayErr 做 5xx 生产脱敏。
		// Node work/controller 的 catch 是 `res.say('查询失败', 500)`（logFields.buildErrorBody
		// 在生产剥掉 error 细节）。旧实现把 err.Error() 塞进 "message"，
		// 而 resp.JSON 只剥 "error" 键 ⇒ **绕过了 SYNC-004 的脱敏**，
		// 生产环境 SQL 报错原文（表名/列名/查询片段）直接回显给客户端。
		resp.SayErr(w, err, 500)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": result})
}

// DeleteDaySalary 删除指定日期的所有工资记录。from: controller/index.js:280-296
func DeleteDaySalary(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	workDate := toStr(d["work_date"])
	if workDate == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "work_date 必填"})
		return
	}

	count, err := SalaryDelete(uid, workDate)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "已删除" + itoa64(count) + "条记录"})
}

// ===== 助手 =====

// orMsg 对应 `error.message || "xxx失败"`。
func orMsg(msg, def string) string {
	if msg == "" {
		return def
	}
	return msg
}

// itoa64 int64 → 字符串。
func itoa64(n int64) string { return strconv.FormatInt(n, 10) }
