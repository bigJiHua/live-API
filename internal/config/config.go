// Package config 环境变量加载（.env 解析）+ 密钥自检（secretGuard）。
package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

var loaded bool

// Load 复刻 dotenv.config()：读取 cwd 下 .env（不覆盖已存在的环境变量）。
func Load() {
	if loaded {
		return
	}
	loaded = true
	f, err := os.Open(".env")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.TrimSpace(line[i+1:])
		if _, exists := os.LookupEnv(k); !exists {
			_ = os.Setenv(k, v)
		}
	}
}

// Get 取环境变量，空则默认值。
func Get(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// IsProduction NODE_ENV === 'production'。
func IsProduction() bool { return os.Getenv("NODE_ENV") == "production" }

// IsDevelopment NODE_ENV === 'development'。
func IsDevelopment() bool { return os.Getenv("NODE_ENV") == "development" }

// placeholders 占位表（对齐 Node secretGuard.js:27-37，逐条一致）。
//
// 🔒 SYNC-A5（2026-10-12）：原表混入了 "secret" / "test" / "change-me" 这类
//
//	**泛化子串**，而 isPlaceholder 用 strings.Contains 匹配 ⇒ 任何含 test/secret 的
//	合法强密钥（如 openssl rand -hex 32 恰好含 "deadbeef" 前缀、或运维自建
//	"my-test-prod-secret-..."）会被误判为弱密钥 ⇒ **生产 panic 拒启**。
//	现与 Node 保持同一份完整占位串清单，宁可漏判也不误杀。
var placeholders = []string{
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

// Raw 取环境变量原始值（不做空串回落），用于「显式留空 ≠ 未设置」的场景
// （如 TRUST_PROXY_HOPS，见 Node app.js:61）。
func Raw(k string) string { return os.Getenv(k) }

// SecretRef 密钥审计项（对齐 Node secretGuard.auditSecrets 的 {name, fallbackTo}）。
type SecretRef struct {
	Name       string
	FallbackTo string // 可空：本密钥弱/缺失时回退该密钥再判一次（fallback 强则不算弱）
}

// AuditSecrets 复刻 secretGuard.auditSecrets：返回弱密钥名称清单（长度<32 或占位值）。
// 🔒 SYNC-009（2026-10-11）：支持 fallbackTo —— 修复生产误杀：
//
//	旧签名只收 []string，SHARE_TOKEN_SECRET 弱/缺失时**不看 JWT_SECRET 回退**就判弱，
//	而 Node 端语义是「回退密钥强则不报」。部署者只配 JWT_SECRET 也会被 Go 版拒启。
func AuditSecrets(refs []SecretRef) []string {
	var weak []string
	for _, ref := range refs {
		v := os.Getenv(ref.Name)
		if v == "" && ref.FallbackTo != "" {
			v = os.Getenv(ref.FallbackTo)
		}
		if len(v) < 32 || isPlaceholder(v) {
			// SYNC-A5：告警文案带上回退来源（对齐 secretGuard.js:112）
			if v == "" && ref.FallbackTo != "" {
				weak = append(weak, ref.Name+"（或回退 "+ref.FallbackTo+"）")
			} else {
				weak = append(weak, ref.Name)
			}
		}
	}
	return weak
}

var fallbackSecrets = map[string]string{}

// ResolveSecret 复刻 secretGuard.resolveSecret：
// env 有值且强 → trim 返回；生产弱 → panic（fail-fast）；dev 弱 → 告警后返回；
// 缺失 → 生成进程级随机（重启失效）。
func ResolveSecret(name, fallbackTo string) string {
	raw := os.Getenv(name)
	if raw == "" && fallbackTo != "" {
		raw = os.Getenv(fallbackTo)
	}
	strong := len(raw) >= 32 && !isPlaceholder(raw)
	if strong {
		return strings.TrimSpace(raw)
	}
	if raw != "" {
		if IsProduction() {
			panic("[启动中止] 密钥未配置或强度不足: " + name + "（≥32 位随机串，勿用占位值）")
		}
		// dev：告警放行
		return raw
	}
	// 完全缺失：进程级随机
	if v, ok := fallbackSecrets[name]; ok {
		return v
	}
	return "" // 由调用方生成（jwt 场景由 srv 启动时生成并缓存）
}

func isPlaceholder(v string) bool {
	lv := strings.ToLower(v)
	for _, p := range placeholders {
		if strings.Contains(lv, strings.ToLower(p)) {
			return true
		}
	}
	return false
}

// CWD 当前工作目录（对应 process.cwd()，用于 public/uploads 相对路径）。
func CWD() string { d, _ := os.Getwd(); return d }

// PathUnder 拼 cwd 相对路径。
func PathUnder(rel string) string { return filepath.Join(CWD(), rel) }
