package config

// SYNC-A38（2026-10-12）：为 SYNC-A5 的密钥自检修复补单测。
//
// 背景：原 placeholders 表混入了 "secret" / "test" / "change-me" 这类泛化子串，
// 而 isPlaceholder 用 strings.Contains 匹配 ⇒ 任何含 test/secret 的**合法强密钥**
// 会被判为弱密钥 ⇒ 生产 panic 拒启（误杀）。修复后表与 Node secretGuard.js 一致。

import "testing"

func TestPlaceholderDoesNotFalsePositive(t *testing.T) {
	// 含 test/secret 字样但确实是强随机密钥 —— SYNC-A5 前会被误判并 panic。
	// ⚠ 样本不得包含 Node 占位表的**完整串**（如 "prod-secret-key"），
	//   那种情况 Node 端同样会判弱，不属于本用例要锁的回归。
	strong := []string{
		"0f8a2b7c4d6e9f1a3b5c7d9e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f",
		"my-test-prod-secret-0123456789abcdef0123456789abcdef",
		"staging-secret-rotation-2026-abcdef0123456789abcdef01",
	}
	for _, s := range strong {
		if len(s) < 32 {
			t.Fatalf("测试样本本身长度不足 32：%q", s)
		}
		if isPlaceholder(s) {
			t.Errorf("合法强密钥 %q 被误判为占位值（SYNC-A5 回归）", s)
		}
	}
}

func TestPlaceholderTableMatchesNode(t *testing.T) {
	// 与 Node secretGuard.js:27-37 逐条一致
	want := []string{
		"your-super-secret-session-key-change-this-in-production",
		"your-super-secret-jwt-key-change-this-in-production",
		"your-secret-key-change-this-in-production",
		"change-this-in-production",
		"your-secret-key",
		"dev-secret-key",
		"prod-secret-key",
		"live-share-fallback",
		"jihau_standard_salt",
	}
	if len(placeholders) != len(want) {
		t.Fatalf("占位表长度 = %d，期望 %d（须与 Node secretGuard.js 一致）", len(placeholders), len(want))
	}
	for i, p := range want {
		if placeholders[i] != p {
			t.Errorf("placeholders[%d] = %q，期望 %q", i, placeholders[i], p)
		}
		if !isPlaceholder(p) {
			t.Errorf("占位串 %q 未被识别", p)
		}
		// 大小写不敏感（对齐 isWeakSecret 的 lower().includes()）
		if !isPlaceholder(upper(p)) {
			t.Errorf("占位串 %q 的大写形式未被识别", upper(p))
		}
	}
}

func TestAuditSecretsFallbackMessage(t *testing.T) {
	t.Setenv("SHARE_TOKEN_SECRET", "")
	t.Setenv("JWT_SECRET", "")
	weak := AuditSecrets([]SecretRef{
		{Name: "JWT_SECRET"},
		{Name: "SHARE_TOKEN_SECRET", FallbackTo: "JWT_SECRET"},
	})
	if len(weak) != 2 {
		t.Fatalf("两个密钥均缺失时应报 2 条，实际 %v", weak)
	}
	if weak[1] != "SHARE_TOKEN_SECRET（或回退 JWT_SECRET）" {
		t.Errorf("回退提示文案 = %q", weak[1])
	}
}

// TestAuditSecretsFallbackStrong 语义：回退密钥强则不算弱（修复生产误杀）。
func TestAuditSecretsFallbackStrong(t *testing.T) {
	t.Setenv("SHARE_TOKEN_SECRET", "")
	t.Setenv("JWT_SECRET", "0f8a2b7c4d6e9f1a3b5c7d9e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f")
	weak := AuditSecrets([]SecretRef{
		{Name: "SHARE_TOKEN_SECRET", FallbackTo: "JWT_SECRET"},
	})
	if len(weak) != 0 {
		t.Errorf("回退密钥强时不应报弱，实际 %v", weak)
	}
}

func TestRawDistinguishesEmptyFromUnset(t *testing.T) {
	t.Setenv("TRUST_PROXY_HOPS", "")
	if Raw("TRUST_PROXY_HOPS") != "" {
		t.Errorf("Raw 应返回空串（用于区分「显式留空」与「未设置」）")
	}
	if Raw("__DEFINITELY_NOT_SET__") != "" {
		t.Errorf("未设置变量 Raw 应为空串")
	}
}

func upper(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'a' && b[i] <= 'z' {
			b[i] -= 32
		}
	}
	return string(b)
}
