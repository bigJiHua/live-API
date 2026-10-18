package sec

// SYNC-010（2026-10-11）：字段级加密 —— 1:1 对齐 Node common/utils/fieldCrypto.js。
//
// 背景：握手接口把设备级 AES 密钥（64 hex）明文写进 device_crypto.aes_key。
// 拿到数据库 dump 的人可离线解密对应设备的全部请求体（财务数据）。
//
// 格式（与 Node 互通 —— 两版共用同一 MySQL）：
//   enc.v1:<ivB64url>.<ciphertextB64url>.<tagB64url>（AES-256-GCM）
// 注意：Go 的 gcm.Seal 把 tag 附在密文尾部，必须拆开分别编码才能与 Node 的
// iv.ct.tag 三段格式互通（Node 端 split('.') 后逐段解析）。
//
// 适用范围：仅「握手行」。device_crypto.aes_key 是双用途字段：
// 邮件行（fingerprint="email_verify_*"）存的是 userId 且被 WHERE aes_key = ?
// 精确匹配（6+ 处）—— GCM 随机 IV 加密会破坏匹配，邮件行保持明文（非遗漏）。

import (
	"crypto/aes"
	"crypto/cipher"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"strings"
)

// FieldCryptoPrefix 密文版本前缀（换算法/密钥可平滑迁移）。
const FieldCryptoPrefix = "enc.v1:"

// ErrFieldMalformed 密文格式坏（段数不对/编码错）。
var ErrFieldMalformed = errors.New("field: malformed ciphertext")

// fieldCryptoKey 取钥：FIELD_ENCRYPT_KEY 显式配置优先（>=32 字符），
// 缺省从 SHARE_TOKEN_SECRET（回退 JWT_SECRET）派生 —— 不新增强制 env。
//
// 🔒 SYNC-A37（2026-10-12）：三密钥全缺时不再用 sha256("") 当密钥。
// Node 侧 fieldCrypto.js:36-43 走 resolveSecret("SHARE_TOKEN_SECRET",
// {fallbackTo:"JWT_SECRET"}) ⇒ 生产环境会抛错拒绝启动；
// 原 Go 裸读 env 后 sha256("")，得到一个全网可预测的常量密钥
// ⇒ 设备 AES 密钥可被离线复现/解密。生产缺配置时必须 panic。
func fieldCryptoKey() []byte {
	src := os.Getenv("FIELD_ENCRYPT_KEY")
	if len(src) < 32 {
		src = os.Getenv("SHARE_TOKEN_SECRET")
	}
	if len(src) < 32 {
		src = os.Getenv("JWT_SECRET")
	}
	if len(src) < 32 && os.Getenv("NODE_ENV") == "production" {
		panic("[启动中止] 字段加密密钥未配置：请设置 FIELD_ENCRYPT_KEY、" +
			"SHARE_TOKEN_SECRET 或 JWT_SECRET（≥32 位随机串）")
	}
	sum := sha256.Sum256([]byte(src))
	return sum[:]
}

// IsFieldEncrypted 值是否已加密。
func IsFieldEncrypted(stored string) bool {
	return strings.HasPrefix(stored, FieldCryptoPrefix)
}

// EncryptField 加密一个字段值 -> enc.v1:iv.ct.tag。
func EncryptField(plaintext string) (string, error) {
	block, err := aes.NewCipher(fieldCryptoKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := crand.Read(iv); err != nil {
		return "", err
	}
	ctAndTag := gcm.Seal(nil, iv, []byte(plaintext), nil)
	tagLen := gcm.Overhead()
	ct, tag := ctAndTag[:len(ctAndTag)-tagLen], ctAndTag[len(ctAndTag)-tagLen:]
	b64 := base64.RawURLEncoding.EncodeToString
	return FieldCryptoPrefix + b64(iv) + "." + b64(ct) + "." + b64(tag), nil
}

// DecryptField 解密一个字段值。
// 未加密（存量明文/邮件行 userId）=> 原样返回，绝不报错 —— 存量数据迁移前也能正常工作。
// 已加密但篡改/密钥不符 => 返回错误（GCM tag 校验失败）。
func DecryptField(stored string) (string, error) {
	if !IsFieldEncrypted(stored) {
		return stored, nil
	}
	raw := strings.TrimPrefix(stored, FieldCryptoPrefix)
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return "", ErrFieldMalformed
	}
	iv, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", err
	}
	ct, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(fieldCryptoKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// NeedsReencrypt 待迁移判定：有值且未加密（存量明文握手行）。
// 无法区分「明文密钥」与「邮件行明文 userId」—— 调用方必须同时检查
// fingerprint 是否以 email_verify 开头（见 mw/body.go 惰性迁移）。
func NeedsReencrypt(stored string) bool {
	return stored != "" && !IsFieldEncrypted(stored)
}
