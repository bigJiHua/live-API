package work

import (
	"fmt"
	"sort"

	"live/api/internal/db"
	"live/api/internal/idgen"
)

// ============================================================================
// 每日工资明细模型 —— from: model/salary.js（work_salary 表）
// 正式工：月薪制，日薪 = base_salary / base_work_days
// 兼职工：时薪制，日薪 = hourly_wage * work_hours
// 注意：subsidy_meal/subsidy_traffic/subsidy_post 是每月固定补贴，不按日计算。
// ============================================================================

const salaryTable = "work_salary"

// formalColor 对应 job.job_color || '#07c160'。
const formalColor = "#07c160"

// calculateFormalSalary 对应 WorkSalary.calculateFormalSalary(job, workDate, overrides)。
// 注：subsidy_meal/subsidy_traffic/subsidy_post 是每月补贴，不按日计算（subsidy 恒 0）。
func calculateFormalSalary(job map[string]any, workDate string, cut any) map[string]any {
	// if (job.status !== 1) return null
	if toF(job["status"]) != 1 {
		return nil
	}
	if jsTruthy(job["join_date"]) && workDate < toStr(job["join_date"]) {
		return nil
	}
	if jsTruthy(job["leave_date"]) && workDate > toStr(job["leave_date"]) {
		return nil
	}

	baseSalary := toF(job["base_salary"])
	baseWorkDays := toF(job["base_work_days"])
	if baseWorkDays == 0 {
		baseWorkDays = 22 // parseFloat(job.base_work_days) || 22
	}
	daySalary := round2(baseSalary / baseWorkDays)

	// 每日补贴为空（meal/traffic/post 是每月补贴，不按日计算）
	subsidy := 0.0

	social := toF(job["social"])
	dailySocial := round2(social / baseWorkDays)

	fund := toF(job["fund"])
	dailyFund := round2(fund / baseWorkDays)

	taxRate := toF(job["tax_rate"])
	tax := round2((daySalary + subsidy) * taxRate / 100)

	// const cut = overrides.cut !== undefined ? overrides.cut : 0
	cutVal := 0.0
	if cut != nil {
		cutVal = toF(cut)
	}
	income := round2(daySalary + subsidy - dailySocial - dailyFund - tax - cutVal)

	return map[string]any{
		"job_id":        job["id"],
		"job_type":      "formal",
		"company":       job["company"],
		"job_color":     orStrOr(job["job_color"], formalColor),
		"work_date":     workDate,
		"work_date_dt":  workDate,
		"work_hours":    0,
		"day_salary":    daySalary,
		"subsidy":       subsidy,
		"social":        dailySocial,
		"fund":          dailyFund,
		"tax":           tax,
		"cut":           cutVal,
		"income":        income,
		"status":        1,
		"remark":        nil,
		"is_calculated": true,
	}
}

// calculateParttimeSalary 对应 WorkSalary.calculateParttimeSalary(job, workDate, workHours, overrides)。
func calculateParttimeSalary(job map[string]any, workDate string, workHours any, cut any) map[string]any {
	if jsTruthy(job["join_date"]) && workDate < toStr(job["join_date"]) {
		return nil
	}
	if jsTruthy(job["leave_date"]) && workDate > toStr(job["leave_date"]) {
		return nil
	}
	if !jsTruthy(workHours) || toF(workHours) <= 0 {
		return nil
	}

	hourlyWage := toF(job["hourly_wage"])
	daySalary := round2(hourlyWage * toF(workHours))

	// 每日补贴为空（meal/traffic/post 是每月补贴，不按日计算）
	subsidy := 0.0

	cutVal := 0.0
	if cut != nil {
		cutVal = toF(cut)
	}
	income := round2(daySalary + subsidy - cutVal)

	return map[string]any{
		"job_id":        job["id"],
		"job_type":      "parttime",
		"company":       job["company"],
		"job_color":     orStrOr(job["job_color"], formalColor),
		"work_date":     workDate,
		"work_date_dt":  workDate,
		"work_hours":    toF(workHours),
		"day_salary":    daySalary,
		"subsidy":       subsidy,
		"social":        0,
		"fund":          0,
		"tax":           0,
		"cut":           cutVal,
		"income":        income,
		"status":        1,
		"remark":        nil,
		"is_calculated": true,
	}
}

// getDaySalary 对应 WorkSalary.getDaySalary(userId, workDate, workHoursMap={})。
func getDaySalary(userID, workDate string, workHoursMap map[string]any) (map[string]any, error) {
	result := map[string]any{
		"formal":       nil,
		"parttimes":    []map[string]any{},
		"total_income": 0.0,
	}
	totalIncome := 0.0

	// 正式工
	formalJobs, err := jobFindActiveFormal(userID, workDate)
	if err != nil {
		return nil, err
	}
	if len(formalJobs) > 0 {
		formal := formalJobs[0]
		salary := calculateFormalSalary(formal, workDate, nil)
		if salary != nil {
			saved, err := queryRows(db.DB(),
				"SELECT * FROM "+salaryTable+" WHERE job_id = ? AND work_date = ? AND is_deleted = 0",
				formal["id"], workDate)
			if err != nil {
				return nil, err
			}
			if len(saved) > 0 {
				// {...saved[0], is_calculated: false}
				row := map[string]any{}
				for k, v := range saved[0] {
					row[k] = v
				}
				row["is_calculated"] = false
				result["formal"] = row
				totalIncome += toF(saved[0]["income"])
			} else {
				result["formal"] = salary
				totalIncome += toF(salary["income"])
			}
		}
	}

	// 兼职列表
	parttimeJobs, err := jobFindActiveParttimes(userID, workDate)
	if err != nil {
		return nil, err
	}
	for _, job := range parttimeJobs {
		var workHours any
		if v, ok := workHoursMap[toStr(job["id"])]; ok {
			workHours = v
		}

		saved, err := queryRows(db.DB(),
			"SELECT * FROM "+salaryTable+" WHERE job_id = ? AND work_date = ? AND is_deleted = 0",
			job["id"], workDate)
		if err != nil {
			return nil, err
		}

		var salary map[string]any
		if len(saved) > 0 {
			// {...saved[0], hourly_wage: job.hourly_wage || 0, is_calculated: false}
			salary = map[string]any{}
			for k, v := range saved[0] {
				salary[k] = v
			}
			salary["hourly_wage"] = orDef(job["hourly_wage"], 0)
			salary["is_calculated"] = false
			totalIncome += toF(saved[0]["income"])
		} else if jsTruthy(workHours) {
			salary = calculateParttimeSalary(job, workDate, workHours, nil)
			if salary != nil {
				salary["hourly_wage"] = orDef(job["hourly_wage"], 0)
				totalIncome += toF(salary["income"])
			}
		} else {
			salary = map[string]any{
				"job_id":        job["id"],
				"job_type":      "parttime",
				"company":       job["company"],
				"job_color":     orStrOr(job["job_color"], formalColor),
				"hourly_wage":   orDef(job["hourly_wage"], 0),
				"work_date":     workDate,
				"work_date_dt":  workDate,
				"day_salary":    0,
				"subsidy":       0,
				"income":        0,
				"work_hours":    0,
				"need_hours":    true,
				"is_calculated": true,
			}
		}

		if salary != nil {
			result["parttimes"] = append(result["parttimes"].([]map[string]any), salary)
		}
	}

	result["total_income"] = round2(totalIncome)
	return result, nil
}

// SaveDaySalaryParams 对应 saveDaySalary 入参。
type SaveDaySalaryParams struct {
	UserID    string
	JobID     any
	WorkDate  string
	WorkHours any
	Cut       any
	Subsidy   any
	Status    any
	Remark    any
}

// saveDaySalary 对应 WorkSalary.saveDaySalary，返回落库后的行。
func saveDaySalary(p SaveDaySalaryParams) (map[string]any, error) {
	job, err := jobFindById(toStr(p.JobID), p.UserID)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, errOrdinary("工作记录不存在")
	}

	if jsTruthy(p.Remark) && runeLen(toStr(p.Remark)) > 50 {
		return nil, errOrdinary("备注不能超过50个字符")
	}

	var salary map[string]any
	if toStr(job["job_type"]) == "formal" {
		salary = calculateFormalSalary(job, p.WorkDate, p.Cut)
		if salary == nil {
			return nil, errOrdinary("该正式工在指定日期不计薪（未入职或已离职）")
		}
		// 如果传了 subsidy 覆盖
		if p.Subsidy != nil {
			salary["subsidy"] = toF(p.Subsidy)
			baseSalary := toF(job["base_salary"])
			baseWorkDays := toF(job["base_work_days"])
			if baseWorkDays == 0 {
				baseWorkDays = 22
			}
			daySalary := round2(baseSalary / baseWorkDays)
			dailySocial := round2(toF(job["social"]) / baseWorkDays)
			dailyFund := round2(toF(job["fund"]) / baseWorkDays)
			taxRate := toF(job["tax_rate"])
			tax := round2((daySalary + toF(salary["subsidy"])) * taxRate / 100)
			cutVal := 0.0
			if p.Cut != nil {
				cutVal = toF(p.Cut)
			}
			salary["income"] = round2(daySalary + toF(salary["subsidy"]) - dailySocial - dailyFund - tax - cutVal)
		}
	} else {
		if !jsTruthy(p.WorkHours) || toF(p.WorkHours) <= 0 {
			return nil, errOrdinary("兼职工必须填写当日工作小时数")
		}
		salary = calculateParttimeSalary(job, p.WorkDate, p.WorkHours, p.Cut)
		if salary == nil {
			return nil, errOrdinary("该兼职在指定日期不计薪（未开始或已结束）")
		}
		// 如果传了 subsidy 覆盖
		if p.Subsidy != nil {
			salary["subsidy"] = toF(p.Subsidy)
			hourlyWage := toF(job["hourly_wage"])
			salary["day_salary"] = round2(hourlyWage * toF(p.WorkHours))
			cutVal := 0.0
			if p.Cut != nil {
				cutVal = toF(p.Cut)
			}
			salary["income"] = round2(toF(salary["day_salary"]) + toF(salary["subsidy"]) - cutVal)
		}
	}

	if p.Status != nil {
		salary["status"] = p.Status
	}
	if p.Remark != nil {
		salary["remark"] = p.Remark
	}

	// 检查是否已存在
	existing, err := queryRows(db.DB(),
		"SELECT id FROM "+salaryTable+" WHERE job_id = ? AND work_date = ? AND is_deleted = 0",
		p.JobID, p.WorkDate)
	if err != nil {
		return nil, err
	}

	var id string
	if len(existing) > 0 {
		id = toStr(existing[0]["id"])
		_, err := db.DB().Exec(`
        UPDATE `+salaryTable+` SET
          day_salary = ?, subsidy = ?,
          social = ?, fund = ?, tax = ?, cut = ?, income = ?, work_hours = ?, status = ?, remark = ?
        WHERE id = ?`,
			salary["day_salary"], salary["subsidy"],
			salary["social"], salary["fund"], salary["tax"], salary["cut"], salary["income"], salary["work_hours"], salary["status"], salary["remark"], id)
		if err != nil {
			return nil, err
		}
	} else {
		id = idgen.BillID()
		// 🔄 2026-10-13（api.md P2-10）：INSERT 改 INSERT ... ON DUPLICATE KEY UPDATE。
		//    唯一键 uk_salary_job_date(job_id, work_date) 建立后，"先查后插"的并发窗口
		//    （两个请求同时查不到 → 双 INSERT）由 DB 兜底：第二个自动变 UPDATE，
		//    不再 ER_DUP_ENTRY 500，幂等且数据正确。
		_, err := db.DB().Exec(`
        INSERT INTO `+salaryTable+` 
        (id, user_id, job_id, job_type, work_date, work_date_dt, work_hours, day_salary, subsidy, 
         social, fund, tax, cut, income, status, remark, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON DUPLICATE KEY UPDATE
          day_salary = VALUES(day_salary), subsidy = VALUES(subsidy),
          social = VALUES(social), fund = VALUES(fund), tax = VALUES(tax),
          cut = VALUES(cut), income = VALUES(income), work_hours = VALUES(work_hours),
          status = VALUES(status), remark = VALUES(remark)`,
			id, p.UserID, p.JobID, job["job_type"], p.WorkDate, p.WorkDate, salary["work_hours"],
			salary["day_salary"], salary["subsidy"],
			salary["social"], salary["fund"], salary["tax"], salary["cut"], salary["income"], salary["status"], salary["remark"])
		if err != nil {
			return nil, err
		}
	}

	// 🔄 2026-10-13（api.md P2-10）：按业务键查真实行（而非按新生成的 id）——
	//    upsert 触发 ON DUPLICATE 时实际行是已存在的旧 id，按新 id 查会为空。
	rows, err := queryRows(db.DB(),
		"SELECT * FROM "+salaryTable+" WHERE job_id = ? AND work_date = ? AND is_deleted = 0",
		p.JobID, p.WorkDate)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// FillMissingFormalSalary 对应 WorkSalary.fillMissingFormalSalary(userId, workDate)：
// 补充本月缺失的正式工日薪数据（当月1日 ~ 执行插入的日期）。静默执行。
func FillMissingFormalSalary(userID, workDate string) error {
	// 解析年月
	year := workDate[:4]
	month := workDate[5:7]
	startDate := year + "-" + month + "-01"

	// 获取本月所有正式工
	formalJobs, err := jobFindActiveFormal(userID, workDate)
	if err != nil {
		return err
	}
	if len(formalJobs) == 0 {
		return nil
	}
	formalJob := formalJobs[0]

	// 获取本月已有的正式工日薪记录（只查到插入的日期）
	existing, err := queryRows(db.DB(),
		`SELECT work_date FROM `+salaryTable+` 
       WHERE user_id = ? AND job_id = ? AND work_date >= ? AND work_date <= ? AND job_type = 'formal'`,
		userID, formalJob["id"], startDate, workDate)
	if err != nil {
		return err
	}
	existingDates := map[string]bool{}
	for _, r := range existing {
		existingDates[toStr(r["work_date"])] = true
	}

	// 从1号到插入日期，逐日检查并补充
	insertDay := jsParseInt(workDate[8:10])
	for day := 1; day <= insertDay; day++ {
		dateStr := year + "-" + month + "-" + pad2(day)
		if existingDates[dateStr] {
			continue
		}

		// 检查入职/离职范围
		if jsTruthy(formalJob["join_date"]) && dateStr < toStr(formalJob["join_date"]) {
			continue
		}
		if jsTruthy(formalJob["leave_date"]) && dateStr > toStr(formalJob["leave_date"]) {
			continue
		}

		salary := calculateFormalSalary(formalJob, dateStr, nil)
		if salary != nil {
			id := idgen.BillID()
			// 🔄 2026-10-13（api.md P2-10）：同 saveDaySalary，upsert 化。
			//    补录与用户手动保存并发时，"已存在"集合可能过期 ⇒ DB 唯一键兜底。
			_, err := db.DB().Exec(`
       INSERT INTO `+salaryTable+` 
       (id, user_id, job_id, job_type, work_date, work_date_dt, work_hours, day_salary, subsidy, 
        social, fund, tax, cut, income, status, remark, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         day_salary = VALUES(day_salary), subsidy = VALUES(subsidy),
         social = VALUES(social), fund = VALUES(fund), tax = VALUES(tax),
         cut = VALUES(cut), income = VALUES(income), work_hours = VALUES(work_hours),
         status = VALUES(status), remark = VALUES(remark)`,
				id, userID, formalJob["id"], salary["job_type"], dateStr, dateStr, salary["work_hours"],
				salary["day_salary"], salary["subsidy"], salary["social"], salary["fund"], salary["tax"], salary["cut"],
				salary["income"], salary["status"], salary["remark"])
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// getMonthSalary 对应 WorkSalary.getMonthSalary(userId, year, month)。
func getMonthSalary(userID string, year, month int) (map[string]any, error) {
	startDate := fmt.Sprintf("%04d-%02d-01", year, month)
	endDate := fmt.Sprintf("%04d-%02d-31", year, month)

	rows, err := queryRows(db.DB(), `
      SELECT ws.*, wj.company, wj.job_type, wj.job_color
      FROM `+salaryTable+` ws
      LEFT JOIN `+jobTable+` wj ON ws.job_id = wj.id
      WHERE ws.user_id = ? AND ws.work_date >= ? AND ws.work_date <= ? AND ws.is_deleted = 0
      ORDER BY ws.work_date_dt ASC, ws.job_type ASC`,
		userID, startDate, endDate)
	if err != nil {
		return nil, err
	}

	dailyStats := map[string]map[string]any{}
	dateOrder := []string{}
	formalTotal := 0.0
	parttimeTotal := 0.0

	for _, row := range rows {
		date := toStr(row["work_date"])
		if _, ok := dailyStats[date]; !ok {
			dailyStats[date] = map[string]any{
				"formal":    nil,
				"parttimes": []map[string]any{},
				"day_total": 0.0,
			}
			dateOrder = append(dateOrder, date)
		}
		ds := dailyStats[date]
		if toStr(row["job_type"]) == "formal" {
			ds["formal"] = row
			formalTotal += toF(row["income"])
		} else {
			ds["parttimes"] = append(ds["parttimes"].([]map[string]any), row)
			parttimeTotal += toF(row["income"])
		}
		ds["day_total"] = toF(ds["day_total"]) + toF(row["income"])
	}

	dailyList := []map[string]any{}
	// 🔒 SYNC-A32（2026-10-12）：Node 是 Object.keys(dailyStats).sort()
	//   （work/model/salary.js:374），按 work_date 字符串升序输出；
	//   原 Go 沿用 SQL 返回序（work_date_dt = datetime，含时分秒），
	//   跨月/补录数据顺序可能与 Node 不同。显式排序对齐。
	sort.Strings(dateOrder)
	for _, date := range dateOrder {
		ds := dailyStats[date]
		dailyList = append(dailyList, map[string]any{
			"date":      date,
			"formal":    ds["formal"],
			"parttimes": ds["parttimes"],
			"day_total": round2(toF(ds["day_total"])),
		})
	}

	return map[string]any{
		"year":           year,
		"month":          month,
		"formal_total":   round2(formalTotal),
		"parttime_total": round2(parttimeTotal),
		"total_income":   round2(formalTotal + parttimeTotal),
		"daily_list":     dailyList,
	}, nil
}

// SalaryDelete 对应 WorkSalary.delete(userId, workDate)（硬删除），返回 affectedRows。
func SalaryDelete(userID, workDate string) (int64, error) {
	return execAffected(db.DB(),
		"DELETE FROM "+salaryTable+" WHERE work_date = ? AND user_id = ?",
		workDate, userID)
}

// orStrOr 对应 `x || def`（字符串版）。
func orStrOr(v any, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}
