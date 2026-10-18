package budget

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"live/api/internal/resp"
)

// ============================================================================
// 校验规则 —— from: rules/index.js（Joi 语义手写：逐字段、错误文案、首条返回）
// validate 中间件：abortEarly:false 收集全部错误后返回 errors[0]（res.say(msg, 400)）。
// ============================================================================

// joiNumberRx 复刻 joi number 的转换正则：/^\s*[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?\s*$/
var joiNumberRx = regexp.MustCompile(`^\s*[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?\s*$`)

// planDateRx 对应 plan_date: joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)。
var planDateRx = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// dataObject 取 body.data 对象（对应 Joi schema joi.object({data: joi.object({...}).unknown(true)}).unknown(true)）。
// data 缺失按 Joi required 语义报 400（校准契约：空 body ⇒ Node 有校验 ⇒ 400，不得放行产生 500）。
func dataObject(b resp.Body) (map[string]any, string) {
	v, ok := b.Raw["data"]
	if !ok {
		return nil, "data is required"
	}
	if m, ok := v.(map[string]any); ok {
		return m, ""
	}
	return nil, "data must be of type object"
}

// ValidateIDParam 复刻 BudgetRules.idParam：params.id 必填。
func ValidateIDParam(r *http.Request) string {
	if r.PathValue("id") == "" {
		return "ID不能为空"
	}
	return ""
}

// ValidateCreate 复刻 rules/index.js create（字段顺序即 Joi 错误收集顺序，首条返回）。
func ValidateCreate(b resp.Body) string {
	d, typeErr := dataObject(b)
	if typeErr != "" {
		return typeErr
	}
	if d == nil {
		return ""
	}

	// title: joi.string().required().max(50)
	if v, ok := d["title"]; !ok {
		return "预算标题不能为空"
	} else if s, errStr := joiStr(v); errStr != "" {
		return "title must be a string"
	} else if jsLen(s) > 50 {
		return "预算标题最多50个字符"
	}

	// budget_type: joi.string().valid('吃', '买', '行').required()
	if v, ok := d["budget_type"]; !ok {
		return "预算类型不能为空"
	} else if s, errStr := joiStr(v); errStr != "" {
		return "budget_type must be a string"
	} else if s != "吃" && s != "买" && s != "行" {
		return "预算类型只能是 吃/买/行"
	}

	// budget_amount: joi.number().positive().required()
	if v, ok := d["budget_amount"]; !ok {
		return "预算金额不能为空"
	} else if f, errStr := joiNum(v); errStr != "" {
		return "budget_amount must be a number"
	} else if f <= 0 {
		return "预算金额必须大于0"
	}

	// cycle: joi.string().valid('月', '季', '年').required()
	if v, ok := d["cycle"]; !ok {
		return "周期不能为空"
	} else if s, errStr := joiStr(v); errStr != "" {
		return "cycle must be a string"
	} else if s != "月" && s != "季" && s != "年" {
		return "周期只能是 月/季/年"
	}

	// plan_date: joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
	if v, ok := d["plan_date"]; !ok {
		return "预计日期不能为空"
	} else if s, errStr := joiStr(v); errStr != "" {
		return "plan_date must be a string"
	} else if !planDateRx.MatchString(s) {
		return "预计日期格式为 yyyy-MM-dd"
	}

	// route: joi.string().allow(null, '').max(50)（无自定义 messages → Joi 默认文案）
	if v, ok := d["route"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return "route must be a string"
		} else if s != "" && jsLen(s) > 50 {
			return "route must be less than or equal to 50 characters long"
		}
	}

	// budget_details: joi.object().allow(null)
	if v, ok := d["budget_details"]; ok && v != nil {
		if _, isObj := v.(map[string]any); !isObj {
			return "budget_details must be of type object"
		}
	}

	return ""
}

// ValidateUpdate 复刻 rules/index.js update（全部可选；显式 null 按 allow 放行）。
func ValidateUpdate(b resp.Body) string {
	d, typeErr := dataObject(b)
	if typeErr != "" {
		return typeErr
	}
	if d == nil {
		return ""
	}

	// title: joi.string().max(50)
	if v, ok := d["title"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return "title must be a string"
		} else if jsLen(s) > 50 {
			return "预算标题最多50个字符"
		}
	}

	// route: joi.string().allow(null, '').max(50)
	if v, ok := d["route"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return "route must be a string"
		} else if s != "" && jsLen(s) > 50 {
			return "路线最多50个字符"
		}
	}

	// budget_type: joi.string().valid('吃', '买', '行')
	if v, ok := d["budget_type"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return "budget_type must be a string"
		} else if s != "吃" && s != "买" && s != "行" {
			return "预算类型只能是 吃/买/行"
		}
	}

	// budget_amount: joi.number().positive()
	if v, ok := d["budget_amount"]; ok && v != nil {
		if f, errStr := joiNum(v); errStr != "" {
			return "budget_amount must be a number"
		} else if f <= 0 {
			return "预算金额必须大于0"
		}
	}

	// used_amount: joi.number().min(0)
	if v, ok := d["used_amount"]; ok && v != nil {
		if f, errStr := joiNum(v); errStr != "" {
			return "used_amount must be a number"
		} else if f < 0 {
			return "已使用金额不能为负数"
		}
	}

	// budget_details: joi.object().allow(null)
	if v, ok := d["budget_details"]; ok && v != nil {
		if _, isObj := v.(map[string]any); !isObj {
			return "budget_details must be of type object"
		}
	}

	// cycle: joi.string().valid('月', '季', '年')
	if v, ok := d["cycle"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return "cycle must be a string"
		} else if s != "月" && s != "季" && s != "年" {
			return "周期只能是 月/季/年"
		}
	}

	// plan_date: joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
	if v, ok := d["plan_date"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return "plan_date must be a string"
		} else if !planDateRx.MatchString(s) {
			return "预计日期格式为 yyyy-MM-dd"
		}
	}

	// is_over_budget: joi.number().valid(0, 1)
	if v, ok := d["is_over_budget"]; ok && v != nil {
		if f, errStr := joiNum(v); errStr != "" {
			return "is_over_budget must be a number"
		} else if f != 0 && f != 1 {
			return "是否超支只能是 0 或 1"
		}
	}

	// is_excute: joi.number().valid(0, 1)
	if v, ok := d["is_excute"]; ok && v != nil {
		if f, errStr := joiNum(v); errStr != "" {
			return "is_excute must be a number"
		} else if f != 0 && f != 1 {
			return "是否执行只能是 0 或 1"
		}
	}

	return ""
}

// ===== Joi 原子校验复刻 =====

// joiStr 复刻 joi string 的 validate：仅接受字符串（数字/布尔/null 均 string.base）。
func joiStr(v any) (string, string) {
	if s, ok := v.(string); ok {
		return s, ""
	}
	return "", "base"
}

// joiNum 复刻 joi number 的 validate（convert:true → 数字字符串可转换）。
func joiNum(v any) (float64, string) {
	switch t := v.(type) {
	case float64:
		return t, ""
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, "base"
		}
		return f, ""
	case string:
		if !joiNumberRx.MatchString(t) {
			return 0, "base"
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, "base"
		}
		return f, ""
	}
	return 0, "base"
}

// jsLen 对应 JS String#length（UTF-16 code unit 数）。
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }
