package mw

import (
	"crypto/rand"
	"encoding/hex"
	"sync"

	"live/api/internal/config"
)

// fix BUG-012：统一密钥源。jwt.js 签发与守卫/风控验签共用此 secret；
// 生产环境弱密钥（缺失/过短/占位值）在启动时 panic（fail-fast），
// dev 缺失时生成进程级随机并打警告（与 Node secretGuard 行为一致）。
var (
	secretOnce sync.Once
	jwtSec     string
	shareSec   string
)

func jwtSecret() string {
	secretOnce.Do(resolveSecrets)
	return jwtSec
}

// JWTSecret 导出统一密钥源（fix BUG-012：签发/验签共用；auth 模块签发 token 用）。
func JWTSecret() string { return jwtSecret() }

// ShareSecret 导出分享 token 密钥源：SHARE_TOKEN_SECRET，回退 JWT_SECRET。
// 对应 src/common/utils/shareToken.js 的 resolveSecret("SHARE_TOKEN_SECRET", {fallbackTo: "JWT_SECRET"})。
func ShareSecret() string { return shareSecret() }

func shareSecret() string {
	secretOnce.Do(resolveSecrets)
	return shareSec
}

func resolveSecrets() {
	jwtSec = config.ResolveSecret("JWT_SECRET", "")
	if jwtSec == "" {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		jwtSec = hex.EncodeToString(b)
	}
	shareSec = config.ResolveSecret("SHARE_TOKEN_SECRET", "JWT_SECRET")
	if shareSec == "" {
		shareSec = jwtSec
	}
}
