package recurring

import (
	"net/http"

	"live/api/internal/resp"
)

// ============================================================================
// 固定周期支出控制器 —— from: controller/index.js
// ============================================================================

// bodyData 对应 `req.body.data || req.body`（data 为对象时优先，含空对象）。
func bodyData(b resp.Body) map[string]any {
	if v, ok := b.Raw["data"]; ok {
		if m, ok := v.(map[string]any); ok {
			return m
		}
	}
	return b.Raw
}

// List 获取固定支出列表。from: controller/index.js:4-18
func List(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	q := r.URL.Query()
	rows, err := findAll(uid, FindOptions{
		Month:              q.Get("month"),
		IncludeInactive:    q.Get("includeInactive") == "1" || q.Get("includeInactive") == "true",
		ExcludeInstallment: q.Get("excludeInstallment") == "1" || q.Get("excludeInstallment") == "true",
	})
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": rows})
}

// Summary 获取固定支出统计。from: controller/index.js:20-31
func Summary(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	month := r.URL.Query().Get("month")
	if month == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "month 参数必填"})
		return
	}
	data, err := getMonthSummary(uid, month)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": data})
}

// Create 创建固定支出。from: controller/index.js:33-59
func Create(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	row, err := create(CreateParams{
		UserID:        uid,
		Name:          d["name"],
		Amount:        d["amount"],
		CategoryID:    d["category_id"],
		AccountID:     d["account_id"],
		Cycle:         d["cycle"],
		DayOfCycle:    d["day_of_cycle"],
		MonthOfCycle:  d["month_of_cycle"],
		RemindDays:    d["remind_days"],
		Remark:        d["remark"],
		IsActive:      d["is_active"],
		EndDate:       d["end_date"],
		RepeatCount:   d["repeat_count"],
		NotifyChannel: d["notify_channel"],
		MonthRecords:  d["month_records"],
	})
	if err != nil {
		resp.SayErrBody(w, 500, "创建失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "创建成功", "data": row})
}

// Installments 获取分期列表（含系统自动入账 + 状态装饰）。
// from: controller/index.js:61-87
func Installments(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	rows, err := findAll(uid, FindOptions{IncludeInactive: true, InstallmentOnly: true, ExcludeInstallment: false})
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	// 系统自动入账：对处于账单周期内且未入账的期次自动触发（替代前端手动按钮）。
	// 失败仅告警，不影响后续列表读取。
	for _, row := range rows {
		if err := autoEnterPending(toStr(row["id"]), uid); err != nil {
			println("[installments] 自动入账跳过 id=" + toStr(row["id"]) + ": " + err.Error())
		}
	}
	// 附加各期有效状态（已还判定：entered 期且账单已还清 -> done），只读不写
	decorated := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		records, err := decorateInstallmentStatus(row)
		if err != nil {
			resp.SayErrBody(w, 500, "查询失败", err)
			return
		}
		next := map[string]any{}
		for k, v := range row {
			next[k] = v
		}
		next["month_records"] = records
		decorated = append(decorated, next)
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": decorated})
}

// Detail 获取固定支出详情。from: controller/index.js:89-98
func Detail(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	row, err := findById(r.PathValue("id"), uid)
	if err != nil {
		resp.SayErrBody(w, 500, "查询失败", err)
		return
	}
	if row == nil {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "固定支出不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "查询成功", "data": row})
}

// Update 更新固定支出。from: controller/index.js:100-123
func Update(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	row, err := update(r.PathValue("id"), uid, map[string]any{
		"name":          d["name"],
		"amount":        d["amount"],
		"categoryId":    d["category_id"],
		"accountId":     d["account_id"],
		"cycle":         d["cycle"],
		"dayOfCycle":    d["day_of_cycle"],
		"monthOfCycle":  d["month_of_cycle"],
		"remindDays":    d["remind_days"],
		"remark":        d["remark"],
		"isActive":      d["is_active"],
		"endDate":       d["end_date"],
		"repeatCount":   d["repeat_count"],
		"notifyChannel": d["notify_channel"],
	})
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": row})
}

// Delete 删除固定支出（软删）。from: controller/index.js:125-134
func Delete(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	ok, err := deleteFn(r.PathValue("id"), uid)
	if err != nil {
		resp.SayErrBody(w, 500, "删除失败", err)
		return
	}
	if !ok {
		resp.JSON(w, 404, map[string]any{"status": 404, "message": "固定支出不存在"})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "删除成功"})
}

// UpdateMonthStatus 更新月度状态。from: controller/index.js:136-150
func UpdateMonthStatus(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	d := bodyData(resp.Parse(r))
	row, err := updateMonthStatus(r.PathValue("id"), uid,
		toStr(d["month"]), toStr(d["status"]), d["amount"], d["remark"])
	if err != nil {
		resp.SayErrBody(w, 500, "更新失败", err)
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "更新成功", "data": row})
}

// EnterInstallment 分期入账：触发月份直接入账（后端校验账单周期 + 防重复）。
// from: controller/index.js:153-165
func EnterInstallment(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	d := bodyData(resp.Parse(r))
	month := toStr(d["month"])
	if month == "" {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": "缺少入账月份"})
		return
	}
	result, err := enterInstallment(id, month, uid)
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "入账失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "入账成功", "data": result})
}

// AbortInstallment 分期中止：仅未入账月份可中止。
// from: controller/index.js:168-179
func AbortInstallment(w http.ResponseWriter, r *http.Request) {
	uid := resp.UID(r)
	id := r.PathValue("id")
	d := bodyData(resp.Parse(r))
	var months []string
	if arr, ok := d["months"].([]any); ok {
		for _, v := range arr {
			months = append(months, toStr(v))
		}
	}
	result, err := abortInstallment(id, months, uid)
	if err != nil {
		resp.JSON(w, 400, map[string]any{"status": 400, "message": orMsg(err.Error(), "中止失败")})
		return
	}
	resp.JSON(w, 200, map[string]any{"status": 200, "message": "中止完成", "data": result})
}

// orMsg 对应 `error.message || "xxx失败"`。
func orMsg(msg, def string) string {
	if msg == "" {
		return def
	}
	return msg
}
