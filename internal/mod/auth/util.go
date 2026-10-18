package auth

// auth 包本地工具：sec 包暂缺 RandHex（临时实现并注释），parseExpiresIn 同理。
// （clientIP 已删，SYNC-005：统一走 mw.ClientIP。）

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"live/api/internal/config"
)

// randHex 返回 n 字节密码学随机 hex 字符串。
// 对应 CryptoJS.lib.WordArray.random(32).toString()（handshake 的 tempKey，64 hex）。
// 注：sec 包暂无 RandHex，暂本地实现。
func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("auth: crypto/rand unavailable")
	}
	return hex.EncodeToString(b)
}

// clientIP 已删除（SYNC-005，2026-10-11）：改统一调 mw.ClientIP（TRUST_PROXY_HOPS
// 语义），避免与 mw 的实现漂移 —— 旧本地复刻是无条件取 XFF 首段（可伪造 IP 绕风控）。
// 调用点请改用 mw.ClientIP(r)。

// parseExpiresIn 解析 JWT_EXPIRES_IN（对应 jsonwebtoken 的 ms 包："7d"/"2h"/"30m"/"60" 等）；
// 空或无法解析时按 Node 的 `process.env.JWT_EXPIRES_IN || '7d'` 兜底为 7 天。
func parseExpiresIn(v string) time.Duration {
	if v == "" {
		v = "7d"
	}
	unit := v[len(v)-1]
	numStr := v
	switch unit {
	case 'd', 'h', 'm', 's', 'w', 'y':
		numStr = v[:len(v)-1]
	default:
		unit = 's' // 纯数字 = 秒
	}
	n, err := strconv.ParseFloat(numStr, 64)
	if err != nil {
		return 7 * 24 * time.Hour
	}
	switch unit {
	case 'd':
		return time.Duration(n * float64(24*time.Hour))
	case 'h':
		return time.Duration(n * float64(time.Hour))
	case 'm':
		return time.Duration(n * float64(time.Minute))
	case 's':
		return time.Duration(n * float64(time.Second))
	case 'w':
		return time.Duration(n * float64(7*24*time.Hour))
	case 'y':
		return time.Duration(n * float64(365*24*time.Hour))
	}
	return 7 * 24 * time.Hour
}

// jwtExpiresIn 对应 process.env.JWT_EXPIRES_IN || '7d'。
func jwtExpiresIn() time.Duration { return parseExpiresIn(config.Get("JWT_EXPIRES_IN", "")) }

// envInt 对应 parseInt(process.env.X) || def。
func envInt(key string, def int) int {
	if v := config.Get(key, ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// MaskEmail 邮箱脱敏（SYNC-004；对齐 Node logFields.maskEmail）：
// user@example.com → u***@example.com。邮箱是 PII（金融级规范要求最小化展示），日志打码。
func MaskEmail(email string) string {
	at := strings.Index(email, "@")
	if at <= 0 {
		if email == "" {
			return ""
		}
		return "***"
	}
	return email[:1] + "***" + email[at:]
}
