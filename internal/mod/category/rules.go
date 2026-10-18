package category

import (
	"context"
	"net/http"

	"live/api/internal/resp"
)

// ============================================================================
// 校验规则 —— from: rules/index.js（Joi 语义手写：逐字段、错误文案、首条返回）
// ============================================================================

// validTypes 对应 Node validTypes = ["income", "expense", "asset", "fixed", "bank"]。
var validTypes = []string{"income", "expense", "asset", "fixed", "bank"}

// CleanCreate 复刻 createValidator(CategoryRules.create)：
// name/type 必填，iconUrl/remark 允许 null/""；data 缺失时不校验（与 Node 一致）。
// from: rules/index.js:7-21
func CleanCreate(b resp.Body) (map[string]any, string) {
	d, has, typeErr := ruleDataObject(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, ""
	}
	// name: joi.string().required()
	if v, ok := d["name"]; !ok || v == nil {
		return nil, "name 分类名称 不能为空"
	} else if s, errStr := joiStr(v); errStr != "" {
		return nil, "name must be a string"
	} else if s == "" {
		return nil, "name is not allowed to be empty"
	}
	// type: joi.string().valid(...validTypes).required()
	if v, ok := d["type"]; !ok || v == nil {
		return nil, "type 类型 不能为空"
	} else if s, errStr := joiStr(v); errStr != "" {
		return nil, "type must be a string"
	} else if !containsStr(validTypes, s) {
		return nil, "type 只能是 income/expense/asset/fixed/bank"
	}
	// iconUrl / remark: joi.string().allow(null, "")
	for _, key := range []string{"iconUrl", "remark"} {
		if v, ok := d[key]; ok && v != nil {
			if _, errStr := joiStr(v); errStr != "" {
				return nil, key + " must be a string"
			}
		}
	}
	return d, ""
}

// CleanUpdate 复刻 createValidator(CategoryRules.update)（非必填）。
// from: rules/index.js:24-32
func CleanUpdate(b resp.Body) (map[string]any, string) {
	d, has, typeErr := ruleDataObject(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, ""
	}
	// name: joi.string()
	if v, ok := d["name"]; ok && v != nil {
		if _, errStr := joiStr(v); errStr != "" {
			return nil, "name must be a string"
		}
	}
	// type: joi.string().valid(...validTypes)
	if v, ok := d["type"]; ok && v != nil {
		if s, errStr := joiStr(v); errStr != "" {
			return nil, "type must be a string"
		} else if !containsStr(validTypes, s) {
			return nil, "type must be one of income/expense/asset/fixed/bank"
		}
	}
	// iconUrl / remark: joi.string().allow(null, "")
	for _, key := range []string{"iconUrl", "remark"} {
		if v, ok := d[key]; ok && v != nil {
			if _, errStr := joiStr(v); errStr != "" {
				return nil, key + " must be a string"
			}
		}
	}
	return d, ""
}

// ===== 本文件助手（Joi 语义） =====

// ruleDataObject 取 body.data 对象：data 缺失按 Joi required 语义报 400（校准契约：
// 空 body ⇒ Node 有校验 ⇒ 400，不得放行进控制器产生 500）；data 非对象报 object.base。
func ruleDataObject(b resp.Body) (map[string]any, bool, string) {
	v, ok := b.Raw["data"]
	if !ok {
		return nil, false, "data is required"
	}
	if m, ok := v.(map[string]any); ok {
		return m, true, ""
	}
	return nil, false, "data must be of type object"
}

// joiStr 复刻 joi string 的 validate：仅接受字符串。
func joiStr(v any) (string, string) {
	if s, ok := v.(string); ok {
		return s, ""
	}
	return "", "base"
}

// containsStr 对应 Array.prototype.includes。
func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ===== 规则装配（对应 createValidator 中间件） =====

// ruleCtxKey 校验后 data 的 context 键。
type ruleCtxKey struct{}

// withRule 复刻 createValidator(schema)：校验失败 res.say(首条错误, 400)；
// 通过后把 data 存入 context（Node 校验后 req.body 被替换为校验值）。
func withRule(clean func(resp.Body) (map[string]any, string), fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		d, msg := clean(resp.Parse(r))
		if msg != "" {
			resp.Say(w, msg, 400)
			return
		}
		fn(w, r.WithContext(context.WithValue(r.Context(), ruleCtxKey{}, d)))
	}
}

// ruleData 取校验后的 data（nil = req.body.data 缺失，对应 Node undefined）。
func ruleData(r *http.Request) map[string]any {
	v, _ := r.Context().Value(ruleCtxKey{}).(map[string]any)
	return v
}
