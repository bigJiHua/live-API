// Package sec 安全基础设施：JWT、RSA、AES-GCM 分享 token、密码学随机。
package sec

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ===== JWT（对应 src/common/config/jwt.js，HS256） =====

type Claims struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Avatar   string `json:"avatar"`
	Email    string `json:"email"`
	jwt.RegisteredClaims
}

// Sign 复刻 jsonwebtoken.sign：payload + iat + exp(expiresIn)。
func Sign(secret string, c Claims, expiresIn time.Duration) (string, error) {
	now := time.Now()
	if c.IssuedAt == nil {
		c.IssuedAt = jwt.NewNumericDate(now)
	}
	if expiresIn > 0 {
		c.ExpiresAt = jwt.NewNumericDate(now.Add(expiresIn))
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return t.SignedString([]byte(secret))
}

// Verify 对应 jwt.verify(token, secret)。
func Verify(secret, token string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	return c, nil
}

// VerifyIgnoreExp 对应 refresh 的 ignoreExpiration 重验。
func VerifyIgnoreExp(secret, token string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		// SYNC-A45（2026-10-13）：补签名方法断言。
		// WithoutClaimsValidation 只关掉 claims 校验，不影响签名；
		// 但缺断言会让 alg=none / 其它算法的 token 也走到这里。
		// Node jwt.verify(token, secret, {ignoreExpiration:true}) 只忽略 exp，
		// 其余校验（含算法）保持不变。
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(secret), nil
	}, jwt.WithoutClaimsValidation())
	if err != nil {
		return nil, err
	}
	return c, nil
}

// ===== 密码学随机（修复 BUG-008：替代 Math.random） =====

// RandBytes 返回 n 个密码学随机字节。
func RandBytes(n int) ([]byte, error) { b := make([]byte, n); _, err := rand.Read(b); return b, err }

// RandBase64URL 对应 crypto.randomBytes(n).toString('base64url')（去 +/=）。
func RandBase64URL(n int) string {
	b, err := RandBytes(n)
	if err != nil {
		panic("sec: crypto/rand unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Digits6 返回 100000-999999 的密码学安全随机 6 位数字（对应 Math.floor(...) 语义）。
func Digits6() string {
	const max = 900000
	b, err := RandBytes(4)
	if err != nil {
		panic("sec: crypto/rand unavailable")
	}
	n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	v := n % max
	var out [6]byte
	v += 100000
	for i := 5; i >= 0; i-- {
		out[i] = byte('0' + v%10)
		v /= 10
	}
	return string(out[:])
}

// SHA256Hex sha256(数据).hex。
func SHA256Hex(data []byte) string {
	s := sha256.Sum256(data)
	const hex = "0123456789abcdef"
	out := make([]byte, 64)
	for i, b := range s {
		out[i*2] = hex[b>>4]
		out[i*2+1] = hex[b&0xf]
	}
	return string(out)
}
