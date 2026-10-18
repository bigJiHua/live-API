package card

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"live/api/internal/resp"
)

// ============================================================================
// 校验规则 —— from: rules/index.js（Joi 语义手写：逐字段、错误文案、首条返回）
// ============================================================================

// joiNumberRx 复刻 joi/lib/types/number.js numberRx。
var joiNumberRx = regexp.MustCompile(`^\s*[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?\s*$`)

// ymdRx 对应 createRepay 的 repayTime pattern /^\d{4}-\d{2}-\d{2}$/。
var ymdRx = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// cardData 取 body.data 对象。对应 Joi schema `joi.object({data: joi.object({...}).unknown(true)}).unknown(true)`：
//   - data 缺失：不校验（create/update 规则未要求 data 必填），返回 has=false
//   - data 非对象：报 "data must be of type object"
//
// 注：复刻 joi/lib/types/keys.js:977 —— data 对象声明了 .unknown(true)，stripUnknown 不生效，
// 未知键（pointsRate/sharePoolId 等）原样保留并传给模型层。
func cardData(b resp.Body) (map[string]any, bool, string) {
	v, ok := b.Raw["data"]
	if !ok {
		return nil, false, ""
	}
	if m, ok := v.(map[string]any); ok {
		return m, true, ""
	}
	return nil, false, "data must be of type object"
}

// joiNum 复刻 joi number 的 coerce+validate：字符串需匹配 numberRx 才转换；
// 布尔/对象/null 一律 number.base。返回 (值, "base")。
func joiNum(v any) (float64, string) {
	switch t := v.(type) {
	case float64:
		return t, ""
	case int64:
		return float64(t), ""
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

// joiBool 复刻 joi boolean 的 coerce（'true'/'false' 字符串，大小写不敏感）+ validate。
func joiBool(v any) (bool, string) {
	switch t := v.(type) {
	case bool:
		return t, ""
	case string:
		switch strings.ToLower(t) {
		case "true":
			return true, ""
		case "false":
			return false, ""
		}
	}
	return false, "base"
}

// convNum Joi convert：数字字段的字符串形态转 float64（供模型层按 Node 清洗后的值消费）。
func convNum(v any) any {
	switch t := v.(type) {
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return f
		}
	case string:
		if f, err := joiNum(t); err == "" {
			return f
		}
	}
	return v
}

// convBool Joi convert：布尔字段的字符串形态转 bool。
func convBool(v any) any {
	if s, ok := v.(string); ok {
		if b, errStr := joiBool(s); errStr == "" {
			return b
		}
	}
	return v
}

// ============================================================================
// 字段级 Joi 语义 —— SYNC-A39（2026-10-12）
//
// 原实现有两个系统性偏差，本节统一纠正：
//
//  1) **空串拦截**：旧代码写 `else if s == "" { return "... is not allowed to be empty" }`，
//     但 Joi 的 `.required()` 只拒 `undefined` / `null`，**接受空串 ""**
//     （拒空串是 `.empty('')` 的职责，而 rules/index.js 里没有任何 .empty() 调用）。
//     ⇒ 影响 bankId/last4No/cardBin/openDate/expireDate/sourceFrom/feeFreeRule/
//       cardId/billId/repayTime/cardLevel/mainSub/cardOrg/cardLength/currency/status/color
//       共 16 个字段：Node 放行，Go 端 400。
//
//  2) **显式 null 被整体跳过**：旧代码统一写 `if v, ok := d[k]; ok && v != nil { 校验 }`，
//     导致 JSON null 直接跳过校验并原样落库。但 Joi 中 `joi.number()` / `joi.string()`
//     / `joi.boolean()` 除非显式 `.allow(null)`，一律对 null 报 base 错误。
//
// 三个辅助函数把「缺失 / 显式 null / 空串」三种状态与「required / allow(null)」
// 两个开关的正交关系集中表达，避免在 60 多个字段上手写出错。
// ============================================================================

// joiStrField 处理一个 joi string 字段。
//
// 参数：
//   - required：是否声明了 .required()
//   - allowNull：是否声明了 .allow(null)
//   - reqMsg：required 失败时的自定义文案（空串则用 "<key> is required"）
//
// 返回 ("", "") 表示"无需拦截"（未提供，或显式 null 且允许）。
func joiStrField(key string, d map[string]any, required, allowNull bool, reqMsg string) (string, string) {
	v, ok := d[key]
	if !ok {
		if required {
			if reqMsg != "" {
				return "", reqMsg
			}
			return "", key + " is required"
		}
		return "", "" // undefined：交由 default / 后续 optional 处理
	}
	if v == nil {
		switch {
		case required:
			if reqMsg != "" {
				return "", reqMsg
			}
			return "", key + " is required"
		case allowNull:
			return "", "" // .allow(null)：显式 null 放行
		default:
			return "", key + " must be a string" // string.base
		}
	}
	s, errStr := joiStr(v)
	if errStr != "" {
		return "", key + " must be a string"
	}
	// ⚠ 此处**不能**因 s == "" 报错 —— 见本节说明第 1 点。
	return s, ""
}

// joiNumField 处理一个 joi number 字段，语义同 joiStrField。
func joiNumField(key string, d map[string]any, required, allowNull bool, reqMsg string) (float64, string) {
	v, ok := d[key]
	if !ok {
		if required {
			if reqMsg != "" {
				return 0, reqMsg
			}
			return 0, key + " is required"
		}
		return 0, ""
	}
	if v == nil {
		switch {
		case required:
			if reqMsg != "" {
				return 0, reqMsg
			}
			return 0, key + " is required"
		case allowNull:
			return 0, ""
		default:
			return 0, key + " must be a number" // number.base
		}
	}
	f, errStr := joiNum(v)
	if errStr != "" {
		return 0, key + " must be a number"
	}
	return f, ""
}

// joiBoolField 处理一个 joi boolean 字段，语义同 joiStrField。
func joiBoolField(key string, d map[string]any, required, allowNull bool, reqMsg string) (bool, string) {
	v, ok := d[key]
	if !ok {
		if required {
			if reqMsg != "" {
				return false, reqMsg
			}
			return false, key + " is required"
		}
		return false, ""
	}
	if v == nil {
		switch {
		case required:
			if reqMsg != "" {
				return false, reqMsg
			}
			return false, key + " is required"
		case allowNull:
			return false, ""
		default:
			return false, key + " must be a boolean" // boolean.base
		}
	}
	b, errStr := joiBool(v)
	if errStr != "" {
		return false, key + " must be a boolean"
	}
	return b, ""
}

// ===== 建卡规则 createCard =====

// cleanCreateCard 复刻 createValidator(CardRules.create)：逐字段校验（首条错误）+
// Joi convert + default 预填（Node 校验通过后 req.body.data 被替换为清洗值）。
// from: rules/index.js:6-94
func cleanCreateCard(b resp.Body) (map[string]any, string) {
	d, has, typeErr := cardData(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, "" // data 缺省：Node 侧内层 schema 不执行
	}
	out := cloneMap(d)
	credit := toStr(d["cardType"]) == "credit"

	// ---- 通用必填字段（schema 定义顺序 = 错误返回顺序）----
	// ⚠ SYNC-A39：这 7 个字段都是 joi.string().required()，**接受空串**
	//（拒空串需 .empty('')，而 rules/index.js 无任何 .empty() 调用）。
	if _, errStr := joiStrField("bankId", d, true, false, "bankId 银行ID 不能为空"); errStr != "" {
		return nil, errStr
	}
	sType, errStr := joiStrField("cardType", d, true, false, "cardType 卡类型 不能为空")
	if errStr != "" {
		return nil, errStr
	} else if sType != "debit" && sType != "credit" {
		return nil, "cardType 只能是 debit(借记卡) 或 credit(信用卡)"
	}
	if _, errStr := joiStrField("last4No", d, true, false, "last4No 卡号后四位 不能为空"); errStr != "" {
		return nil, errStr
	}
	// cardBin: joi.string().length(6).required() —— 空串走到长度检查即报 6 位错误（与 Node 同）
	if sBin, errStr := joiStrField("cardBin", d, true, false, "cardBin 卡BIN前6位 不能为空"); errStr != "" {
		return nil, errStr
	} else if len([]rune(sBin)) != 6 {
		return nil, "cardBin 卡BIN前6位必须是6位数"
	}
	if _, errStr := joiStrField("openDate", d, true, false, "openDate 开卡日期 不能为空"); errStr != "" {
		return nil, errStr
	}
	if _, errStr := joiStrField("expireDate", d, true, false, "expireDate 过期日期 不能为空"); errStr != "" {
		return nil, errStr
	}
	if _, errStr := joiStrField("sourceFrom", d, true, false, "sourceFrom 数据来源 不能为空"); errStr != "" {
		return nil, errStr
	}

	// ---- 信用卡必填字段（when cardType = credit）----
	// creditLimit: when credit → required().min(0)；otherwise default(0)（不 allow null）
	if f, errStr := joiNumField("creditLimit", d, credit, false,
		"creditLimit 信用额度（信用卡必填）不能为空"); errStr != "" {
		return nil, errStr
	} else if credit && f < 0 {
		return nil, "信用额度不能为负数"
	}
	// tempLimit: joi.number().default(0)
	if _, errStr := joiNumField("tempLimit", d, false, false, ""); errStr != "" {
		return nil, errStr
	}
	// billDay / repayDay: when credit → integer 1-31 required；otherwise default(0)
	for _, key := range []string{"billDay", "repayDay"} {
		reqMsg := key + " " + cnDayName(key) + "（信用卡必填）不能为空"
		f, errStr := joiNumField(key, d, credit, false, reqMsg)
		if errStr != "" {
			return nil, errStr
		}
		if credit {
			if f != float64(int64(f)) {
				return nil, key + " " + cnDayName(key) + "必须是整数"
			} else if f < 1 || f > 31 {
				return nil, key + " " + cnDayName(key) + "必须在 1-31 之间"
			}
		}
	}
	// annualFee: when credit → required；otherwise default(0)
	if _, errStr := joiNumField("annualFee", d, credit, false,
		"annualFee 年费（信用卡必填）不能为空"); errStr != "" {
		return nil, errStr
	}
	// feeFreeRule: when credit → required()（拒 null、空串放行）；otherwise allow('',null).default('')
	if credit {
		if _, errStr := joiStrField("feeFreeRule", d, true, false,
			"feeFreeRule 免年费规则（信用卡必填）不能为空"); errStr != "" {
			return nil, errStr
		}
	} else {
		if _, errStr := joiStrField("feeFreeRule", d, false, true, ""); errStr != "" {
			return nil, errStr
		}
	}

	// ---- 通用非必填字段（声明顺序：cardLevel→color，均不 allow(null)）----
	for _, key := range []string{
		"cardLevel", "mainSub", "cardOrg", "cardLength", "currency", "status", "color",
	} {
		if _, errStr := joiStrField(key, d, false, false, ""); errStr != "" {
			return nil, errStr
		}
	}
	// alias / cardImg / tag / remark: joi.string().allow('', null).default('')
	for _, key := range []string{"alias", "cardImg", "tag", "remark"} {
		if _, errStr := joiStrField(key, d, false, true, ""); errStr != "" {
			return nil, errStr
		}
	}
	for _, key := range []string{"isDefault", "isHide"} {
		if _, errStr := joiBoolField(key, d, false, false, ""); errStr != "" {
			return nil, errStr
		}
	}
	if _, errStr := joiNumField("sort", d, false, false, ""); errStr != "" {
		return nil, errStr
	}

	// ---- Joi convert（数字/布尔字符串形态）+ default 预填 ----
	applyCardCreateDefaults(out, credit)
	return out, ""
}

// cnDayName 账单日/还款日的中文段名（构造 Joi 自定义文案）。
func cnDayName(key string) string {
	if key == "billDay" {
		return "账单日"
	}
	return "还款日"
}

// applyCardCreateDefaults 应用 Joi default + convert（模型层随后按 Node `||` 兜底再取）。
func applyCardCreateDefaults(out map[string]any, credit bool) {
	defStr := map[string]string{
		"bankId": "", "cardType": "debit", "last4No": "", "cardBin": "",
		"openDate": "", "expireDate": "", "sourceFrom": "",
		"cardLevel": "普卡", "mainSub": "主卡", "cardOrg": "银联", "cardLength": "19",
		"alias": "", "cardImg": "", "currency": "CNY", "status": "正常",
		"tag": "", "remark": "", "color": "#0052cc", "feeFreeRule": "",
	}
	for k, v := range defStr {
		if _, ok := out[k]; !ok {
			out[k] = v
		}
	}
	// SYNC-A39：sort 的 Joi 默认值是 **99**（rules/index.js:88 `joi.number().default(99)`），
	// 旧实现写成 0 ⇒ 新建卡片 sort=0，在列表「sort ASC」排序下全部排到最前。
	for _, k := range []string{"creditLimit", "tempLimit", "billDay", "repayDay", "annualFee"} {
		if v, ok := out[k]; ok && v != nil {
			out[k] = convNum(v)
		} else if !ok {
			out[k] = float64(0) // 这些字段的 Node 默认值均为 0
		}
	}
	if _, ok := out["sort"]; !ok {
		out["sort"] = float64(99) // rules/index.js:88 default(99)
	} else if out["sort"] != nil {
		out["sort"] = convNum(out["sort"])
	}
	if credit {
		if _, ok := out["feeFreeRule"]; !ok {
			out["feeFreeRule"] = "" // credit 分支 required，缺失已被校验拦截
		}
	}
	for _, k := range []string{"isDefault", "isHide"} {
		if v, ok := out[k]; ok && v != nil {
			out[k] = convBool(v)
		} else if !ok {
			out[k] = false
		}
	}
}

// ===== 改卡规则 updateCard =====

// cleanUpdateCard 复刻 createValidator(CardRules.updateCard)（非必填；账单日/还款日仅信用卡要求 1-31）。
// from: rules/index.js:97-146
func cleanUpdateCard(b resp.Body) (map[string]any, string) {
	d, has, typeErr := cardData(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, "data is required" // 校准契约：空 body ⇒ Node 有校验 ⇒ 400
	}
	out := cloneMap(d)
	credit := toStr(d["cardType"]) == "credit"

	// ⚠ SYNC-A39：以下严格按 rules/index.js:100-143 的**声明顺序**执行 ——
	//   validate.js 用 abortEarly:false 但只返回 errors[0]，声明顺序决定哪条先报。
	//
	// ⚠ SYNC-A39：annualFee 是 joi.number().allow(null)（rules/index.js:141），
	//   旧实现把它混进下面的字符串列表当 string 校验 ⇒ 改卡传 annualFee:"3600" 被 400，
	//   而同一函数末尾又把它放进 convNum 列表自相矛盾。现已归位到数字段。

	// bankId: joi.string().allow('', null)
	if _, errStr := joiStrField("bankId", d, false, true, ""); errStr != "" {
		return nil, errStr
	}
	// cardType: joi.string().valid("debit","credit")
	sType, errStr := joiStrField("cardType", d, false, false, "")
	if errStr != "" {
		return nil, errStr
	} else if sType != "" && sType != "debit" && sType != "credit" {
		return nil, "cardType 只能是 debit(借记卡) 或 credit(信用卡)"
	}
	// cardLevel / mainSub / cardOrg / cardLength / last4No / cardBin / alias / cardImg
	// / openDate / expireDate：joi.string().allow('', null)
	for _, key := range []string{
		"cardLevel", "mainSub", "cardOrg", "cardLength", "last4No", "cardBin",
		"alias", "cardImg", "openDate", "expireDate",
	} {
		if _, errStr := joiStrField(key, d, false, true, ""); errStr != "" {
			return nil, errStr
		}
	}
	// billDay / repayDay: joi.number().allow(null).when(cardType) —— 信用卡额外要求 1-31
	for _, key := range []string{"billDay", "repayDay"} {
		f, errStr := joiNumField(key, d, false, true, "")
		if errStr != "" {
			if credit {
				// credit 分支覆盖了 number.base 文案
				return nil, key + " " + cnDayName(key) + "必须是数字"
			}
			return nil, errStr
		}
		if !credit {
			continue
		}
		if _, present := d[key]; !present || d[key] == nil {
			continue // allow(null)：显式 null 不做 1-31 检查（对齐 Node）
		}
		if f != float64(int64(f)) {
			return nil, key + " " + cnDayName(key) + "必须是整数"
		} else if f < 1 || f > 31 {
			return nil, key + " " + cnDayName(key) + "必须在 1-31 之间"
		}
	}
	// currency / status: joi.string().allow('', null)
	for _, key := range []string{"currency", "status"} {
		if _, errStr := joiStrField(key, d, false, true, ""); errStr != "" {
			return nil, errStr
		}
	}
	// isDefault / isHide: joi.boolean()
	for _, key := range []string{"isDefault", "isHide"} {
		if _, errStr := joiBoolField(key, d, false, false, ""); errStr != "" {
			return nil, errStr
		}
	}
	// sort: joi.number()
	if _, errStr := joiNumField("sort", d, false, false, ""); errStr != "" {
		return nil, errStr
	}
	// tag / remark / color: joi.string().allow('', null)
	for _, key := range []string{"tag", "remark", "color"} {
		if _, errStr := joiStrField(key, d, false, true, ""); errStr != "" {
			return nil, errStr
		}
	}
	// annualFee: joi.number().allow(null)  ← 数字，不是 string
	if _, errStr := joiNumField("annualFee", d, false, true, ""); errStr != "" {
		return nil, errStr
	}
	// feeFreeRule / sourceFrom: joi.string().allow('', null)
	for _, key := range []string{"feeFreeRule", "sourceFrom"} {
		if _, errStr := joiStrField(key, d, false, true, ""); errStr != "" {
			return nil, errStr
		}
	}

	// convert
	for _, key := range []string{"billDay", "repayDay", "annualFee", "sort"} {
		if v, ok := out[key]; ok && v != nil {
			out[key] = convNum(v)
		}
	}
	for _, key := range []string{"isDefault", "isHide"} {
		if v, ok := out[key]; ok && v != nil {
			out[key] = convBool(v)
		}
	}
	return out, ""
}

// ===== 改账单规则 updateBill =====

// cleanUpdateBill 复刻 createValidator(CardRules.updateBill)（全部非必填）。
// from: rules/index.js:150-162
func cleanUpdateBill(b resp.Body) (map[string]any, string) {
	d, has, typeErr := cardData(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, "data is required" // 校准契约：空 body ⇒ Node 有校验 ⇒ 400
	}
	out := cloneMap(d)
	// rules/index.js:154-159，全部 joi.number()/joi.boolean()（**无** .allow(null)）
	for _, key := range []string{"creditLimit", "tempLimit", "pointsRate", "repaid", "remindDays"} {
		if _, errStr := joiNumField(key, d, false, false, ""); errStr != "" {
			return nil, errStr
		}
		if v, ok := out[key]; ok && v != nil {
			out[key] = convNum(v)
		}
	}
	if _, errStr := joiBoolField("remindSwitch", d, false, false, ""); errStr != "" {
		return nil, errStr
	}
	if v, ok := out["remindSwitch"]; ok && v != nil {
		out["remindSwitch"] = convBool(v)
	}
	return out, ""
}

// ===== 建还款规则 createRepay（keep BUG-060：billId 强制必填，模型层支持无 billId，维持原样）=====

// cleanCreateRepay 复刻 createValidator(CardRules.createRepay)。
// keep BUG-060：Joi 强制 billId 必填（model/repay.js:170 支持无 billId 还款），校验层收窄维持原样。
// from: rules/index.js:167-198
func cleanCreateRepay(b resp.Body) (map[string]any, string) {
	d, has, typeErr := cardData(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, "data is required" // 校准契约：空 body ⇒ Node 有校验 ⇒ 400
	}
	out := cloneMap(d)

	// ⚠ SYNC-A39：cardId/billId/repayMethod/repayTime 均为 .required()，**接受空串**。
	//   repayTime 为空串时 Node 落到 .pattern() 报「格式应为 YYYY-MM-DD」，而非空串错误。

	// cardId: joi.string().required()
	if _, errStr := joiStrField("cardId", d, true, false, "cardId 卡片ID 不能为空"); errStr != "" {
		return nil, errStr
	}
	// billId: joi.string().required() —— keep BUG-060
	if _, errStr := joiStrField("billId", d, true, false, "billId 账单ID 不能为空"); errStr != "" {
		return nil, errStr
	}
	// repayAmount: joi.number().required().min(0.01)
	if f, errStr := joiNumField("repayAmount", d, true, false,
		"repayAmount 还款金额 不能为空"); errStr != "" {
		return nil, errStr
	} else if f < 0.01 {
		return nil, "还款金额必须大于 0"
	}
	// repayMethod: joi.string().required().valid('balance','bank_card','cash')
	sMethod, errStr := joiStrField("repayMethod", d, true, false, "repayMethod 还款方式 不能为空")
	if errStr != "" {
		return nil, errStr
	} else if sMethod != "balance" && sMethod != "bank_card" && sMethod != "cash" {
		return nil, "repayMethod 只支持: balance/bank_card/cash"
	}
	// repayMethodCardId: when repayMethod = bank_card → required()；otherwise allow('').optional()
	// （allow('') 只放行空串，**不**放行 null ⇒ 非银行卡分支的 null 报 string.base）
	if sMethod == "bank_card" {
		if v, ok := d["repayMethodCardId"]; !ok || v == nil || toStr(v) == "" {
			return nil, "银行卡还款时 repayMethodCardId 不能为空"
		}
	} else {
		if _, errStr := joiStrField("repayMethodCardId", d, false, false, ""); errStr != "" {
			return nil, errStr
		}
	}
	// repayTime: joi.string().required().pattern(/^\d{4}-\d{2}-\d{2}$/)
	if sTime, errStr := joiStrField("repayTime", d, true, false,
		"repayTime 还款时间 不能为空"); errStr != "" {
		return nil, errStr
	} else if !ymdRx.MatchString(sTime) {
		return nil, "repayTime 格式应为 YYYY-MM-DD"
	}
	// remark: joi.string().allow('').optional()（allow('') 不放行 null）
	if _, errStr := joiStrField("remark", d, false, false, ""); errStr != "" {
		return nil, errStr
	}

	if v, ok := out["repayAmount"]; ok && v != nil {
		out["repayAmount"] = convNum(v)
	}
	return out, ""
}

// ===== 改还款规则 updateRepay =====

// cleanUpdateRepay 复刻 createValidator(CardRules.updateRepay)（非必填）。
// from: rules/index.js:201-212
func cleanUpdateRepay(b resp.Body) (map[string]any, string) {
	d, has, typeErr := cardData(b)
	if typeErr != "" {
		return nil, typeErr
	}
	if !has {
		return nil, "data is required" // 校准契约：空 body ⇒ Node 有校验 ⇒ 400
	}
	out := cloneMap(d)
	// repayAmount: joi.number().min(0.01) + 自定义 number.base/number.min 文案
	if f, errStr := joiNumField("repayAmount", d, false, false, ""); errStr != "" {
		return nil, "repayAmount 还款金额必须是数字" // 覆盖 number.base 默认文案
	} else if _, present := d["repayAmount"]; present && f < 0.01 {
		return nil, "还款金额必须大于 0"
	}
	if v, ok := out["repayAmount"]; ok && v != nil {
		out["repayAmount"] = convNum(v)
	}
	// repayMethod / repayTime / remark: joi.string()（无 allow(null)）
	for _, key := range []string{"repayMethod", "repayTime", "remark"} {
		if _, errStr := joiStrField(key, d, false, false, ""); errStr != "" {
			return nil, errStr
		}
	}
	return out, ""
}

// ===== 规则装配（对应 createValidator 中间件） =====

// ruleCtxKey 清洗后 data 的 context 键。
type ruleCtxKey struct{}

// withRule 复刻 createValidator(schema)：校验失败 res.say(首条错误, 400)；
// 通过后把 Joi convert/default 清洗后的 data 存入 context（对应 Node 校验后 req.body 被替换为清洗值）。
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

// ruleData 取清洗后的 data（nil = req.body.data 缺失，对应 Node undefined）。
func ruleData(r *http.Request) map[string]any {
	v, _ := r.Context().Value(ruleCtxKey{}).(map[string]any)
	return v
}
