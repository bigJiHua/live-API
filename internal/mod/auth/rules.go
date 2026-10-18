package auth

// from: src/modules/auth/rules/index.js + src/modules/user/rules/index.js
// Joi 17.13.3 校验语义逐字复刻（错误文案 = Joi 默认/自定义文案经 validate.js 去引号后的结果，首条返回）。
// validate.js 的 stripUnknown 会剔除 Schema 外字段，但 Node 各 controller 只读 Schema 内定义的键，
// 故 Go 端无需实际裁剪，仅做等价校验。

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"live/api/internal/resp"
)

// guardRule 复刻 common/middleware/validate.js：校验失败 res.say(errors[0].message, 400)。
func guardRule(check func(resp.Body) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if msg := check(resp.Parse(r)); msg != "" {
				resp.Say(w, msg, 400)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// GuardRule 导出 guardRule 供 security 包复用（Node：security/api 直接引用 auth/rules + validate）。
func GuardRule(check func(resp.Body) string) func(http.Handler) http.Handler { return guardRule(check) }

// dataObject 取 req.body.data。
// 返回 (data, errMsg)：errMsg 非空 = 校验失败；data 为 nil 且 errMsg 为空 = data 键缺失
// （Node 中 data 非必填时校验放行，由 controller 侧处理：解构异常 → 500 / 格式校验 → 400）。
// data 为 null 或非对象（string 等）→ Joi object.base："data must be of type object"。
// required=true 时缺失 → any.required："data is required"。
func dataObject(b resp.Body, required bool) (map[string]any, string) {
	v, ok := b.Raw["data"]
	if !ok {
		if required {
			return nil, "data is required"
		}
		return nil, ""
	}
	if v == nil {
		return nil, "data must be of type object"
	}
	m, isObj := v.(map[string]any)
	if !isObj {
		return nil, "data must be of type object"
	}
	return m, ""
}

// optionalData 便捷封装：data 缺失时放行（返回 nil）。
func optionalData(b resp.Body) (map[string]any, string) {
	d, msg := dataObject(b, false)
	if msg != "" {
		return nil, msg
	}
	return d, ""
}

func hasKey(d map[string]any, key string) bool {
	_, ok := d[key]
	return ok
}

// ================= auth 登录规则（AuthRules.login） =================

// ValidateLogin 对应 dataSchema：nameOrEmail(string 3-50 required) + password(alternatives)。
func ValidateLogin(b resp.Body) string {
	d, msg := optionalData(b)
	if msg != "" {
		return msg
	}
	if d == nil {
		return "" // data 缺失：Node 校验放行，Login controller 复现解构异常（500）
	}
	v, ok := d["nameOrEmail"]
	if !ok || v == nil {
		return "data.nameOrEmail is required"
	}
	s, isStr := v.(string)
	if !isStr {
		return "data.nameOrEmail must be a string"
	}
	if s == "" {
		return "data.nameOrEmail is not allowed to be empty"
	}
	if n := utf8.RuneCountInString(s); n < 3 {
		return "data.nameOrEmail length must be at least 3 characters long"
	} else if n > 50 {
		return "data.nameOrEmail length must be less than or equal to 50 characters long"
	}
	v, ok = d["password"]
	if !ok {
		return "密码不能为空"
	}
	return validatePassword(v, "password")
}

var pwdSpecial = "!@#$%^&*(),.?\":{}|<>"

// validatePassword 对应 password: alternatives(plainPwdRule, encryptedPwdRule)。
// Joi 实测语义：唯一错误 → 返回该错误文案；多个错误 → alternatives.match 自定义文案。
func validatePassword(v any, label string) string {
	if v == nil {
		return "data." + label + " must be one of [string, array]"
	}
	switch t := v.(type) {
	case string:
		if t == "" {
			return "data." + label + " is not allowed to be empty"
		}
		if !passwordOK(t) {
			return "密码必须包含大小写字母、数字和特殊字符，且长度为6-30位"
		}
	case []any:
		var errs []string
		if len(t) < 6 {
			errs = append(errs, "密码长度必须为 6-30 位")
		}
		if len(t) > 30 {
			errs = append(errs, "密码长度必须为 6-30 位")
		}
		for i, e := range t {
			s, isStr := e.(string)
			if !isStr {
				errs = append(errs, fmt.Sprintf("data.%s[%d] must be a string", label, i))
				continue
			}
			if n := utf8.RuneCountInString(s); n < 8 {
				errs = append(errs, fmt.Sprintf("data.%s[%d] length must be at least 8 characters long", label, i))
			} else if n > 1024 {
				errs = append(errs, fmt.Sprintf("data.%s[%d] length must be less than or equal to 1024 characters long", label, i))
			}
		}
		if len(errs) == 1 {
			return errs[0]
		}
		if len(errs) > 1 {
			return "密码格式不正确"
		}
	default:
		return "data." + label + " must be one of [string, array]"
	}
	return ""
}

// passwordOK 对应 /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>])[^]{6,30}$/
// （Go RE2 无前向断言，按字符集逐项判定）。
func passwordOK(s string) bool {
	r := []rune(s)
	if len(r) < 6 || len(r) > 30 {
		return false
	}
	var low, up, dig, sp bool
	for _, c := range r {
		switch {
		case c >= 'a' && c <= 'z':
			low = true
		case c >= 'A' && c <= 'Z':
			up = true
		case c >= '0' && c <= '9':
			dig = true
		case strings.ContainsRune(pwdSpecial, c):
			sp = true
		}
	}
	return low && up && dig && sp
}

// ================= PIN 规则（pinAnyRule / pinRule / pinEncryptedRule） =================

// ValidateVerifyPin 对应 AuthRules.verifyPin（data 非必填，缺失交由 handler）。
func ValidateVerifyPin(b resp.Body) string {
	d, msg := optionalData(b)
	if msg != "" {
		return msg
	}
	if d == nil {
		return ""
	}
	if !hasKey(d, "pin") {
		return "PIN 码不能为空"
	}
	return validatePin(d["pin"], "pin")
}

// ValidateSetPin 对应 AuthRules.setPin。
func ValidateSetPin(b resp.Body) string {
	d, msg := optionalData(b)
	if msg != "" {
		return msg
	}
	if d == nil {
		return ""
	}
	if !hasKey(d, "pin") {
		return "PIN 码不能为空"
	}
	return validatePin(d["pin"], "pin")
}

// ValidateChangePin 对应 AuthRules.changePin（字段顺序 oldPin → newPin）。
func ValidateChangePin(b resp.Body) string {
	d, msg := optionalData(b)
	if msg != "" {
		return msg
	}
	if d == nil {
		return ""
	}
	if !hasKey(d, "oldPin") {
		return "PIN 码不能为空"
	}
	if m := validatePin(d["oldPin"], "oldPin"); m != "" {
		return m
	}
	if !hasKey(d, "newPin") {
		return "PIN 码不能为空"
	}
	return validatePin(d["newPin"], "newPin")
}

// ValidateResetPin 对应 AuthRules.resetPin（字段顺序 verificationCode(pinRule) → newPin(pinAnyRule)）。
func ValidateResetPin(b resp.Body) string {
	d, msg := optionalData(b)
	if msg != "" {
		return msg
	}
	if d == nil {
		return ""
	}
	if !hasKey(d, "verificationCode") {
		return "PIN 码不能为空"
	}
	if m := validateCode(d["verificationCode"], "verificationCode"); m != "" {
		return m
	}
	if !hasKey(d, "newPin") {
		return "PIN 码不能为空"
	}
	return validatePin(d["newPin"], "newPin")
}

// validatePin 对应 pinAnyRule = alternatives(pinRule, pinEncryptedRule)。required。
func validatePin(v any, label string) string {
	if v == nil {
		return "data." + label + " must be one of [string, array]"
	}
	switch t := v.(type) {
	case string:
		if t == "" {
			return "data." + label + " is not allowed to be empty"
		}
		if utf8.RuneCountInString(t) != 6 {
			return "PIN 码必须是 6 位"
		}
		if !allDigits(t) {
			return "PIN 码只能是纯数字"
		}
	case []any:
		var errs []string
		if len(t) != 6 {
			errs = append(errs, "PIN 码必须是 6 位")
		}
		for i, e := range t {
			s, isStr := e.(string)
			if !isStr {
				errs = append(errs, fmt.Sprintf("data.%s[%d] must be a string", label, i))
				continue
			}
			if n := utf8.RuneCountInString(s); n < 8 {
				errs = append(errs, "PIN 密文格式异常")
			} else if n > 1024 {
				errs = append(errs, fmt.Sprintf("data.%s[%d] length must be less than or equal to 1024 characters long", label, i))
			}
		}
		if len(errs) == 1 {
			return errs[0]
		}
		if len(errs) > 1 {
			return "PIN 码格式不正确"
		}
	default:
		return "data." + label + " must be one of [string, array]"
	}
	return ""
}

// validateCode 对应 pinRule（单 string schema：length 6 + pattern ^\d+$）。required。
func validateCode(v any, label string) string {
	if v == nil {
		return "data." + label + " must be a string"
	}
	s, isStr := v.(string)
	if !isStr {
		return "data." + label + " must be a string"
	}
	if s == "" {
		return "data." + label + " is not allowed to be empty"
	}
	if utf8.RuneCountInString(s) != 6 {
		return "PIN 码必须是 6 位"
	}
	if !allDigits(s) {
		return "PIN 码只能是纯数字"
	}
	return ""
}

// validateEmailCode 对应 user/rules 的 `joi.string().length(6)`
// （index.js:41-44 / :65-68），**不带 pattern**、文案是「验证码必须是6位」。
//
// 🔒 SYNC-A22（2026-10-12）：原实现复用了 PIN 规则（validateCode）——
//
//	① 多了纯数字约束（Node 允许任意 6 位字符串）；
//	② 错误文案完全错位，前端会显示「PIN 码必须是 6 位」而非「验证码必须是6位」。
func validateEmailCode(v any, label string) string {
	if v == nil {
		return "data." + label + " must be a string"
	}
	s, isStr := v.(string)
	if !isStr {
		return "data." + label + " must be a string"
	}
	if s == "" {
		return "data." + label + " is not allowed to be empty"
	}
	if utf8.RuneCountInString(s) != 6 {
		return "验证码必须是6位"
	}
	return ""
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ================= 风险路由 PIN 规则（AuthRules.verifyRoutePin） =================

// ValidateVerifyRoutePin 对应 AuthRules.verifyRoutePin（字段顺序 pin → challengeId → requestUrl → method）。
func ValidateVerifyRoutePin(b resp.Body) string {
	d, msg := optionalData(b)
	if msg != "" {
		return msg
	}
	if d == nil {
		return "" // data 缺失：Node `req.body.data || {}` 兼容，交由 handler 格式校验
	}
	if !hasKey(d, "pin") {
		return "PIN 码不能为空"
	}
	if m := validatePin(d["pin"], "pin"); m != "" {
		return m
	}
	v, ok := d["challengeId"]
	if !ok {
		return "data.challengeId is required"
	}
	if v == nil {
		return "data.challengeId must be one of [number, string]"
	}
	switch t := v.(type) {
	case string:
		if t == "" {
			return "data.challengeId is not allowed to be empty"
		}
	case float64, int, int64:
	default:
		return "data.challengeId must be one of [number, string]"
	}
	if m := validateStr(d, "requestUrl", 255, true); m != "" {
		return m
	}
	return validateStr(d, "method", 16, true)
}

// validateStr 对应 joi.string().max(n).required()（含 must be a string / is not allowed to be empty）。
func validateStr(d map[string]any, key string, max int, required bool) string {
	v, ok := d[key]
	if !ok || v == nil {
		if required {
			return "data." + key + " is required"
		}
		return ""
	}
	s, isStr := v.(string)
	if !isStr {
		return "data." + key + " must be a string"
	}
	if s == "" {
		return "data." + key + " is not allowed to be empty"
	}
	if utf8.RuneCountInString(s) > max {
		return "data." + key + " length must be less than or equal to " + strconv.Itoa(max) + " characters long"
	}
	return ""
}

// ================= 用户模块规则（src/modules/user/rules/index.js） =================

var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// ValidateEmailSendCode 对应 UserRules.emailSendCode。
// 🔒 2026-10-12 修复（api.md P1-1）：data 必填；email 可选但须邮箱格式；
//
//	type 可选且仅 email/pwd（Joi default "email"）。stripUnknown 剥离 data 内/顶层
//	未定义字段（含客户端可能塞入的 userId），与控制器 `req.userId` 归一形成双层防护。
func ValidateEmailSendCode(b resp.Body) string {
	d, msg := dataObject(b, true)
	if msg != "" {
		return msg
	}
	if v, ok := d["email"]; ok && v != nil {
		s, isStr := v.(string)
		if !isStr {
			return "data.email must be a string"
		}
		if s == "" {
			return "data.email is not allowed to be empty"
		}
		if !emailRe.MatchString(s) {
			return "邮箱格式不正确"
		}
	}
	if v, ok := d["type"]; ok && v != nil {
		s, isStr := v.(string)
		if !isStr {
			return "data.type must be a string"
		}
		if s != "email" && s != "pwd" {
			return "data.type must be one of [email, pwd]"
		}
	}
	return ""
}

// ValidateProfile 对应 UserRules.profile（data 必填；username/avatar/email 可选）。
func ValidateProfile(b resp.Body) string {
	d, msg := dataObject(b, true)
	if msg != "" {
		return msg
	}
	if v, ok := d["username"]; ok {
		s, isStr := v.(string)
		if !isStr {
			return "data.username must be a string"
		}
		if s == "" {
			return "data.username is not allowed to be empty"
		}
		if n := utf8.RuneCountInString(s); n < 2 {
			return "昵称最少需要2个字符"
		} else if n > 10 {
			return "昵称最多10个字符"
		}
	}
	if v, ok := d["avatar"]; ok {
		s, isStr := v.(string)
		if !isStr {
			return "data.avatar must be a string"
		}
		if s != "" && !isURI(s) {
			return "头像地址格式不正确"
		}
	}
	if v, ok := d["email"]; ok {
		s, isStr := v.(string)
		if !isStr {
			return "data.email must be a string"
		}
		if s == "" {
			return "data.email is not allowed to be empty"
		}
		if !emailRe.MatchString(s) {
			return "邮箱格式不正确"
		}
	}
	return ""
}

// isURI 对应 joi.string().uri() 默认行为（须带 scheme + host，不允许相对路径）。
func isURI(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme != "" && u.Host != ""
}

// ValidateEmailChange 对应 UserRules.emailChange（字段顺序 email → code）。
func ValidateEmailChange(b resp.Body) string {
	d, msg := dataObject(b, true)
	if msg != "" {
		return msg
	}
	v, ok := d["email"]
	if !ok {
		return "邮箱不能为空"
	}
	if v == nil {
		return "data.email must be a string"
	}
	s, isStr := v.(string)
	if !isStr {
		return "data.email must be a string"
	}
	if s == "" {
		return "data.email is not allowed to be empty"
	}
	if !emailRe.MatchString(s) {
		return "邮箱格式不正确"
	}
	v, ok = d["code"]
	if !ok {
		return "验证码不能为空"
	}
	return validateEmailCode(v, "code")
}

// ValidatePasswordChangeWithCode 对应 UserRules.passwordChangeWithCode（oldPassword → newPassword → code）。
func ValidatePasswordChangeWithCode(b resp.Body) string {
	d, msg := dataObject(b, true)
	if msg != "" {
		return msg
	}
	if m := validatePwdField(d, "oldPassword", "旧密码不能为空"); m != "" {
		return m
	}
	if m := validatePwdField(d, "newPassword", "新密码不能为空"); m != "" {
		return m
	}
	v, ok := d["code"]
	if !ok {
		return "验证码不能为空"
	}
	return validateEmailCode(v, "code")
}

// validatePwdField 对应 joi.string().min(6).required()（自定义 min 文案"密码至少6位"）。
func validatePwdField(d map[string]any, key, requiredMsg string) string {
	v, ok := d[key]
	if !ok {
		return requiredMsg
	}
	if v == nil {
		return "data." + key + " must be a string"
	}
	s, isStr := v.(string)
	if !isStr {
		return "data." + key + " must be a string"
	}
	if s == "" {
		return "data." + key + " is not allowed to be empty"
	}
	if utf8.RuneCountInString(s) < 6 {
		return "密码至少6位"
	}
	return ""
}
