package auth

// SYNC-A38（2026-10-12）：为 SYNC-A22（验证码规则误用 PIN 规则）补单测。
//
// Node user/rules/index.js:41-44 / :65-68 的 code 字段是
//   joi.string().length(6).required()  —— 无 pattern，文案「验证码必须是6位」
// 而 pinRule 是 length(6) + ^\d+$，文案「PIN 码必须是 6 位/只能是纯数字」。
// 原实现复用了 PIN 规则 ⇒ 前端会显示"PIN 码"字样，且多出纯数字约束。

import "testing"

func TestValidateEmailCode(t *testing.T) {
	cases := []struct {
		in   any
		want string // 空串 = 通过
	}{
		{"123456", ""},
		{"abcdef", ""}, // Node 无 pattern ⇒ 字母也放行
		{"ABC123", ""}, // 同上
		{"abcde", "验证码必须是6位"},
		{"abcdefg", "验证码必须是6位"},
		{"", "data.code is not allowed to be empty"},
		{nil, "data.code must be a string"},
		{123456, "data.code must be a string"},
	}
	for _, c := range cases {
		if got := validateEmailCode(c.in, "code"); got != c.want {
			t.Errorf("validateEmailCode(%v) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

// TestValidateCodeStillPinsForPIN 确认 PIN 规则未被误改（security/pin/reset 用它）。
func TestValidateCodeStillPinsForPIN(t *testing.T) {
	if got := validateCode("12345", "code"); got != "PIN 码必须是 6 位" {
		t.Errorf("validateCode 长度文案 = %q", got)
	}
	if got := validateCode("abcdef", "code"); got != "PIN 码只能是纯数字" {
		t.Errorf("validateCode 纯数字文案 = %q", got)
	}
	if got := validateCode("123456", "code"); got != "" {
		t.Errorf("validateCode(123456) 应通过，实际 %q", got)
	}
}

// TestMaskEmail 脱敏口径：u***@example.com（logFields.maskEmail）。
func TestMaskEmail(t *testing.T) {
	cases := []struct{ in, want string }{
		{"user@example.com", "u***@example.com"},
		{"a@b.com", "a***@b.com"},
		{"noat", "***"},
		{"", ""},
		{"@example.com", "***"},
	}
	for _, c := range cases {
		if got := MaskEmail(c.in); got != c.want {
			t.Errorf("MaskEmail(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}
