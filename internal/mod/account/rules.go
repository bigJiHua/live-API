package account

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"live/api/internal/resp"
)

// ============================================================================
// 校验规则 —— from: rules/index.js（Joi 语义手写：逐字段、错误文案、首条返回）
// ============================================================================

// joiNumberRx 复刻 joi/lib/types/number.js numberRx：
// /^\s*[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e([+-]?\d+))?\s*$/i
var joiNumberRx = regexp.MustCompile(`^\s*[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?\s*$`)

// dataObject 取 body.data 对象。对应 Joi schema `joi.object({data: joi.object({...}).unknown(true)}).unknown(true)`：
//   - data 缺失：不校验（create/update 规则未要求 data 必填）
//   - data 非对象：报 "data must be of type object"（Joi object.base 默认文案，去引号）
func dataObject(b resp.Body) (map[string]any, string) {
	v, ok := b.Raw["data"]
	if !ok {
		return nil, ""
	}
	if m, ok := v.(map[string]any); ok {
		return m, ""
	}
	return nil, "data must be of type object"
}

// ValidateCreate 复刻 rules/index.js create：direction 0/1、amount>0.01、transDate 必填等，
// abortEarly:false 收集全部错误后由 validate 中间件返回第一条（createValidator → res.say(msg, 400)）。
func ValidateCreate(b resp.Body) string {
	d, typeErr := dataObject(b)
	if typeErr != "" {
		return typeErr
	}
	if d == nil {
		return ""
	}

	// direction: joi.number().valid(0, 1).required()
	if v, ok := d["direction"]; !ok {
		return "direction 收支方向 不能为空"
	} else if f, errStr := joiNum(v); errStr != "" {
		return "direction must be a number"
	} else if f != 0 && f != 1 {
		return "direction 只能是 0(支出) 或 1(收入)"
	}

	// categoryId: joi.string().required()
	if _, ok := d["categoryId"]; !ok {
		return "categoryId 分类ID 不能为空"
	} else if _, errStr := joiStr(d["categoryId"]); errStr != "" {
		return "categoryId must be a string"
	}

	// payType: joi.string().required()
	if _, ok := d["payType"]; !ok {
		return "payType 支出类型 不能为空"
	} else if _, errStr := joiStr(d["payType"]); errStr != "" {
		return "payType must be a string"
	}

	// payMethod: joi.string().required()
	if _, ok := d["payMethod"]; !ok {
		return "payMethod 支付方式 不能为空"
	} else if _, errStr := joiStr(d["payMethod"]); errStr != "" {
		return "payMethod must be a string"
	}

	// amount: joi.number().min(0.01).required()
	if _, ok := d["amount"]; !ok {
		return "amount 金额 不能为空"
	} else if f, errStr := joiNum(d["amount"]); errStr != "" {
		return "amount 金额必须是数字"
	} else if f < 0.01 {
		return "amount 金额必须大于 0"
	}

	// transDate: joi.string().required()
	if _, ok := d["transDate"]; !ok {
		return "transDate 收支日期 不能为空"
	} else if _, errStr := joiStr(d["transDate"]); errStr != "" {
		return "transDate must be a string"
	}

	// cardId: joi.string().required()
	if _, ok := d["cardId"]; !ok {
		return "cardId 关联卡片ID 不能为空"
	} else if _, errStr := joiStr(d["cardId"]); errStr != "" {
		return "cardId must be a string"
	}

	// currency: joi.string().default('CNY')
	if v, ok := d["currency"]; ok {
		if _, errStr := joiStr(v); errStr != "" {
			return "currency must be a string"
		}
	}

	// exchangeRate: joi.number().min(0.001).precision(5).default(1)
	if v, ok := d["exchangeRate"]; ok {
		if f, errStr := joiNum(v); errStr != "" {
			return "exchangeRate must be a number"
		} else if f < 0.001 {
			return "exchangeRate must be greater than or equal to 0.001"
		} else if joiPrecisionDecimals(f) > 5 {
			return "exchangeRate must have no more than 5 decimal places"
		}
	}

	// remark: joi.string().allow('', null)
	if v, ok := d["remark"]; ok && v != nil {
		if _, errStr := joiStr(v); errStr != "" {
			return "remark must be a string"
		}
	}

	// transferGroupId: joi.string().allow('', null)
	if v, ok := d["transferGroupId"]; ok && v != nil {
		if _, errStr := joiStr(v); errStr != "" {
			return "transferGroupId must be a string"
		}
	}

	return ""
}

// ValidateUpdate 复刻 rules/index.js update（非必填；amount 允许 null）。
func ValidateUpdate(b resp.Body) string {
	d, typeErr := dataObject(b)
	if typeErr != "" {
		return typeErr
	}
	if d == nil {
		return ""
	}

	// direction: joi.number().valid(0, 1)（无自定义 messages → Joi 默认文案）
	if v, ok := d["direction"]; ok {
		if f, errStr := joiNum(v); errStr != "" {
			return "direction must be a number"
		} else if f != 0 && f != 1 {
			return "direction must be one of 0, 1"
		}
	}

	// categoryId/payType/payMethod/currency/transDate/remark/cardId: joi.string().allow('', null)
	for _, key := range []string{"categoryId", "payType", "payMethod", "currency", "transDate", "remark", "cardId"} {
		if v, ok := d[key]; ok && v != nil {
			if _, errStr := joiStr(v); errStr != "" {
				return key + " must be a string"
			}
		}
	}

	// amount: joi.number().min(0.01).allow(null)
	if v, ok := d["amount"]; ok && v != nil {
		if f, errStr := joiNum(v); errStr != "" {
			return "amount 金额必须是数字"
		} else if f < 0.01 {
			return "amount 金额必须大于 0"
		}
	}

	// exchangeRate: joi.number().min(0.001).precision(5).allow(null)
	if v, ok := d["exchangeRate"]; ok && v != nil {
		if f, errStr := joiNum(v); errStr != "" {
			return "exchangeRate must be a number"
		} else if f < 0.001 {
			return "exchangeRate must be greater than or equal to 0.001"
		} else if joiPrecisionDecimals(f) > 5 {
			return "exchangeRate must have no more than 5 decimal places"
		}
	}

	return ""
}

// joiNum 复刻 joi number 的 coerce+validate：字符串需匹配 numberRx 才转换；
// 布尔/对象/null 一律 number.base。返回 (值, "base")。
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

// joiStr 复刻 joi string 的 validate：仅接受字符串（数字/布尔/null 均 string.base）。
func joiStr(v any) (string, string) {
	if s, ok := v.(string); ok {
		return s, ""
	}
	return "", "base"
}

// joiPrecisionDecimals 复刻 joi number precision 校验的 decimals 计算：
// value.toString() 的小数位数（去掉指数部分影响，常规值等价小数位数）。
func joiPrecisionDecimals(f float64) int {
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if dot := strings.IndexByte(s, '.'); dot >= 0 {
		return len(s) - dot - 1
	}
	return 0
}
