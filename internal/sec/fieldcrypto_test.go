package sec

// 批 D 单元测试：SYNC-010 字段加密（roundtrip/篡改/存量兼容/互通格式）

import (
	"strings"
	"testing"
)

func testKey64() string { return strings.Repeat("ab", 32) }

func TestFieldRoundtrip(t *testing.T) {
	enc, err := EncryptField(testKey64())
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}
	if !strings.HasPrefix(enc, "enc.v1:") {
		t.Fatalf("缺 enc.v1: 前缀")
	}
	if parts := strings.Split(strings.TrimPrefix(enc, "enc.v1:"), "."); len(parts) != 3 {
		t.Fatalf("应为 3 段, got %d", len(parts))
	}
	got, err := DecryptField(enc)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	if got != testKey64() {
		t.Fatal("roundtrip 不一致")
	}
}

func TestFieldTamperDetected(t *testing.T) {
	enc, _ := EncryptField(testKey64())
	i := strings.LastIndex(enc, ".")
	tampered := enc[:i+1] + strings.Repeat("A", len(enc)-i-1)
	if _, err := DecryptField(tampered); err == nil {
		t.Fatal("篡改 tag 未被检出")
	}
}

func TestFieldLegacyPlaintextPassthrough(t *testing.T) {
	legacy := strings.Repeat("ef", 32)
	got, err := DecryptField(legacy)
	if err != nil || got != legacy {
		t.Fatalf("存量明文应原样透传: got=%q err=%v", got, err)
	}
	if got, err := DecryptField("12345"); err != nil || got != "12345" {
		t.Fatalf("邮件行 userId 应透传: got=%q err=%v", got, err)
	}
}

func TestFieldNeedsReencrypt(t *testing.T) {
	if !NeedsReencrypt(testKey64()) {
		t.Fatal("明文应判待迁移")
	}
	enc, _ := EncryptField(testKey64())
	if NeedsReencrypt(enc) {
		t.Fatal("密文不应判待迁移")
	}
	if NeedsReencrypt("") {
		t.Fatal("空串不应判待迁移")
	}
}

func TestFieldRandomIV(t *testing.T) {
	a, _ := EncryptField(testKey64())
	b, _ := EncryptField(testKey64())
	if a == b {
		t.Fatal("随机 IV：两次加密结果不应相同")
	}
}
