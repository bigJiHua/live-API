package work

import (
	"time"

	"live/api/internal/db"
	"live/api/internal/idgen"
)

// ============================================================================
// 工作信息模型 —— from: model/job.js（work_job 表）
// 1个用户 = 1个正式工 + N个兼职工。
// ============================================================================

const jobTable = "work_job"

// JobCreateParams 对应 WorkJob.create 入参。
type JobCreateParams struct {
	UserID         string
	JobType        any
	Company        any
	JobColor       any
	Status         any
	JoinDate       any
	LeaveDate      any
	PayDay         any
	BaseSalary     any
	BaseWorkDays   any
	HourlyWage     any
	SubsidyMeal    any
	SubsidyTraffic any
	SubsidyPost    any
	Social         any
	Fund           any
	TaxRate        any
	Remark         any
}

// jobCreate 对应 WorkJob.create。
func jobCreate(p JobCreateParams) (map[string]any, error) {
	// 正式工限制：1个用户只能有1个正式工作
	if toStr(p.JobType) == "formal" {
		rows, err := queryRows(db.DB(),
			"SELECT id FROM "+jobTable+" WHERE user_id = ? AND job_type = 'formal' AND is_deleted = 0",
			p.UserID)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			return nil, errOrdinary("正式工只能有一条，如需更换请先删除旧的")
		}
	}

	// 兼职工必填时薪
	if toStr(p.JobType) == "parttime" {
		if !jsTruthy(p.HourlyWage) || toF(p.HourlyWage) <= 0 {
			return nil, errOrdinary("兼职工必须填写时薪")
		}
	}

	// 正式工必填月薪
	if toStr(p.JobType) == "formal" {
		if !jsTruthy(p.BaseSalary) || toF(p.BaseSalary) <= 0 {
			return nil, errOrdinary("正式工必须填写月基本工资")
		}
		if !jsTruthy(p.BaseWorkDays) || jsParseIntValue(p.BaseWorkDays) <= 0 {
			return nil, errOrdinary("正式工必须填写月应出勤天数")
		}
	}

	// 校验日期：离职日期 > 入职日期
	if jsTruthy(p.JoinDate) && jsTruthy(p.LeaveDate) && toStr(p.LeaveDate) <= toStr(p.JoinDate) {
		return nil, errOrdinary("离职日期必须大于入职日期")
	}

	// remark 限制50字符
	if jsTruthy(p.Remark) && runeLen(toStr(p.Remark)) > 50 {
		return nil, errOrdinary("备注不能超过50个字符")
	}

	id := idgen.BillID()
	// 对应 Node 参数默认值（JS falsy 语义：0/空串 → 默认值）：
	// company || ''  jobColor || '#07c160'  status?1:0  joinDate/leaveDate || null
	// payDay || 15  baseSalary || 0  baseWorkDays || 22  hourlyWage || 0
	// subsidy*/social/fund/taxRate || 0  remark || null
	statusVal := 1
	if p.Status != nil {
		if jsTruthy(p.Status) {
			statusVal = 1
		} else {
			statusVal = 0
		}
	}
	_, err := db.DB().Exec(
		`INSERT INTO `+jobTable+` 
      (id, user_id, job_type, company, job_color, status, join_date, leave_date, pay_day,
       base_salary, base_work_days, hourly_wage,
       subsidy_meal, subsidy_traffic, subsidy_post, 
       social, fund, tax_rate, remark, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, p.UserID, p.JobType,
		orDef(p.Company, ""), orDef(p.JobColor, "#07c160"),
		statusVal,
		orNullValue(p.JoinDate), orNullValue(p.LeaveDate), orDef(p.PayDay, 15),
		orDef(p.BaseSalary, 0), orDef(p.BaseWorkDays, 22), orDef(p.HourlyWage, 0),
		orDef(p.SubsidyMeal, 0), orDef(p.SubsidyTraffic, 0), orDef(p.SubsidyPost, 0),
		orDef(p.Social, 0), orDef(p.Fund, 0), orDef(p.TaxRate, 0), orNullValue(p.Remark))
	if err != nil {
		return nil, err
	}
	return jobFindById(id, p.UserID)
}

// jobFindById 对应 WorkJob.findById(id, userId)。
func jobFindById(id, userID string) (map[string]any, error) {
	return queryRow(db.DB(),
		"SELECT * FROM "+jobTable+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		id, userID)
}

// jobFindAll 对应 WorkJob.findAll(userId)。
func jobFindAll(userID string) ([]map[string]any, error) {
	return queryRows(db.DB(),
		`SELECT * FROM `+jobTable+` 
      WHERE user_id = ? AND is_deleted = 0 
      ORDER BY job_type ASC`,
		userID)
}

// jobFindActiveFormal 对应 WorkJob.findActiveFormal(userId, workDate)。
func jobFindActiveFormal(userID, workDate string) ([]map[string]any, error) {
	return queryRows(db.DB(),
		`SELECT * FROM `+jobTable+` 
      WHERE user_id = ? AND is_deleted = 0 
        AND job_type = 'formal' 
        AND status = 1
        AND join_date <= ?
        AND (leave_date IS NULL OR leave_date >= ?)`,
		userID, workDate, workDate)
}

// jobFindActiveParttimes 对应 WorkJob.findActiveParttimes(userId, workDate)。
func jobFindActiveParttimes(userID, workDate string) ([]map[string]any, error) {
	return queryRows(db.DB(),
		`SELECT * FROM `+jobTable+` 
      WHERE user_id = ? AND is_deleted = 0 
        AND job_type = 'parttime'
        AND join_date <= ?
        AND (leave_date IS NULL OR leave_date >= ?)
      ORDER BY company ASC`,
		userID, workDate, workDate)
}

// jobUpdate 对应 WorkJob.update(id, userId, updates)。
// updates 键为数据库列名（company/job_color/.../remark）。
func jobUpdate(id, userID string, updates map[string]any) (map[string]any, error) {
	allowedFields := map[string]bool{
		"company": true, "job_color": true, "status": true, "join_date": true, "leave_date": true,
		"pay_day": true, "base_salary": true, "base_work_days": true, "hourly_wage": true,
		"subsidy_meal": true, "subsidy_traffic": true, "subsidy_post": true,
		"social": true, "fund": true, "tax_rate": true, "remark": true,
	}
	amountFields := map[string]bool{
		"base_salary": true, "base_work_days": true, "hourly_wage": true,
		"subsidy_meal": true, "subsidy_traffic": true, "subsidy_post": true,
		"social": true, "fund": true, "pay_day": true,
	}

	var fields []string
	var params []any
	for key, v := range updates {
		if !allowedFields[key] || v == nil {
			continue
		}
		// 金额字段校验不能为负
		if amountFields[key] && jsNumLessThan(v, 0) {
			return nil, errOrdinary(key + " 不能为负数")
		}
		fields = append(fields, key+" = ?")
		params = append(params, v)
	}

	if len(fields) == 0 {
		return jobFindById(id, userID)
	}

	// 校验日期
	existing, err := jobFindById(id, userID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, errOrdinary("工作记录不存在")
	}

	if updates["leave_date"] != nil || updates["join_date"] != nil {
		joinDate := existing["join_date"]
		if updates["join_date"] != nil {
			joinDate = updates["join_date"]
		}
		leaveDate := existing["leave_date"]
		if updates["leave_date"] != nil {
			leaveDate = updates["leave_date"]
		}
		if jsTruthy(joinDate) && jsTruthy(leaveDate) && toStr(leaveDate) <= toStr(joinDate) {
			return nil, errOrdinary("离职日期必须大于入职日期")
		}
	}

	if updates["remark"] != nil && jsTruthy(updates["remark"]) && runeLen(toStr(updates["remark"])) > 50 {
		return nil, errOrdinary("备注不能超过50个字符")
	}

	params = append(params, id, userID)
	if _, err := db.DB().Exec(
		"UPDATE "+jobTable+" SET "+joinFields(fields)+" WHERE id = ? AND user_id = ? AND is_deleted = 0",
		params...); err != nil {
		return nil, err
	}

	// 自动化：如果是正式工且更新了离职日期，自动删除离职日之后到月底的薪酬记录
	newLeaveDate := existing["leave_date"]
	if updates["leave_date"] != nil {
		newLeaveDate = updates["leave_date"]
	}
	if toStr(existing["job_type"]) == "formal" && updates["leave_date"] != nil {
		// 对应 Node：today = new Date().toISOString().split('T')[0]（UTC 日期，维持原样）
		today := time.Now().UTC().Format("2006-01-02")
		leave := toStr(newLeaveDate)
		// 如果新离职日期 <= 今天，清理未来薪酬
		if leave != "" && leave <= today && len(leave) >= 7 {
			year := leave[:4]
			month := leave[5:7]
			// endOfMonth = `${year}-${month}-${new Date(year, month, 0).getDate()}`
			monthNum := jsParseInt(month)
			endOfMonth := year + "-" + month + "-" + pad2(daysInMonth(jsParseInt(year), monthNum))
			if _, err := db.DB().Exec(
				"DELETE FROM "+salaryTable+" WHERE user_id = ? AND job_id = ? AND work_date > ? AND work_date <= ? AND job_type = 'formal'",
				userID, id, newLeaveDate, endOfMonth); err != nil {
				return nil, err
			}
		}
	}

	return jobFindById(id, userID)
}

// jobDelete 对应 WorkJob.delete(id, userId)（软删除）。
func jobDelete(id, userID string) (bool, error) {
	n, err := execAffected(db.DB(),
		"UPDATE "+jobTable+" SET is_deleted = 1 WHERE id = ? AND user_id = ?",
		id, userID)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
