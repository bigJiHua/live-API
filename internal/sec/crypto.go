package sec

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"strings"
	"sync"
)

// ===== RSA（对应 src/common/utils/rsaKeys.js，RSA-2048） =====

var (
	rsaOnce   sync.Once
	rsaPriv   *rsa.PrivateKey
	rsaPubPEM string
)

// rsaKeyFile RSA 私钥持久化路径（进程 CWD 相对，可用 RSA_KEY_FILE 覆盖）。
//
// ⚠️ 与 Node 的差异点：Node rsaKeys.js 为进程内存级（注释依赖「前端每次登录先握手」），
// 但原生 APP HandshakeManager 会把握手拿到的公钥缓存 2 小时 —— 服务端重启换键后，
// APP 旧公钥加密的密码字符在服务端全部解密失败 ⇒ resolvePassword 返回 "" ⇒
// 登录 400「请输入账号和密码」（账号校验都正常，仅密码为空），且该 400 不触发
// APP 的重握手自愈（只认 401/KEY_ERR）。故 Go 端把密钥落盘：重启不变键，
// APP 的 2h 会话缓存始终可解；web 每次握手取公钥，不受任何影响。
func rsaKeyFile() string {
	if p := os.Getenv("RSA_KEY_FILE"); p != "" {
		return p
	}
	return "rsa_key.pem"
}

func ensureRSA() {
	rsaOnce.Do(func() {
		// 1) 尝试加载持久化密钥（文件损坏/解析失败则走重新生成并覆盖）
		if priv, pub, err := loadRSAKey(rsaKeyFile()); err == nil {
			rsaPriv, rsaPubPEM = priv, pub
			return
		}
		// 2) 生成新密钥对
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic("sec: rsa generate failed: " + err.Error())
		}
		rsaPriv = key
		der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
		if err != nil {
			panic("sec: rsa marshal failed: " + err.Error())
		}
		rsaPubPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
		// 3) 落盘（失败不阻断：退化为进程内存级，对齐 Node 行为）
		_ = saveRSAKey(rsaKeyFile(), key)
	})
}

// loadRSAKey 从 path 读取 PKCS8 私钥 PEM，返回私钥与 SPKI 公钥 PEM。
func loadRSAKey(path string) (*rsa.PrivateKey, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, "", errors.New("sec: rsa key file: no PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, "", err
	}
	priv, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, "", errors.New("sec: rsa key file: not RSA")
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		return nil, "", err
	}
	pubPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return priv, pubPEM, nil
}

// saveRSAKey 以 PKCS8 私钥 PEM 写入 path（0600）。
func saveRSAKey(path string, key *rsa.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	return os.WriteFile(path, data, 0o600)
}

// PublicKeyPEM 对应 getPublicKey()（SPKI PEM，JSEncrypt 可用）。
func PublicKeyPEM() string { ensureRSA(); return rsaPubPEM }

// DecryptChars 对应 decryptChars：逐元素 PKCS1v15 解密，utf8 字符串拼接；
// 单元素失败静默映射 ""（keep BUG-007 语义的一部分：失败即空串）。
func DecryptChars(chars []string) string {
	ensureRSA()
	var sb strings.Builder
	for _, c := range chars {
		raw, err := base64.StdEncoding.DecodeString(c)
		if err != nil {
			continue // 单元素失败 → ""
		}
		out, err := rsa.DecryptPKCS1v15(rand.Reader, rsaPriv, raw)
		if err != nil {
			continue
		}
		sb.Write(out)
	}
	return sb.String()
}

// ResolvePassword 对应 resolvePassword：数组→逐字符解密；字符串→原样返回（keep BUG-007）。
func ResolvePassword(raw any) string {
	switch t := raw.(type) {
	case []any:
		strs := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				strs = append(strs, s)
			}
		}
		return DecryptChars(strs)
	case string:
		return t
	}
	return ""
}

// ===== AES-256-CBC 请求体解密（对应 middleware/authSecurityData.js） =====

// ErrMalformedUTF8 / ErrInvalidJSON 对应 Node 的两类解密异常。
var (
	ErrMalformedUTF8 = errors.New("MALFORMED_UTF8")
	ErrInvalidJSON   = errors.New("INVALID_JSON")
	ErrNoKey         = errors.New("NO_AES_KEY")
)

// DecryptBody 解密 {_p} 信封：key hex(64)→32B；IV=payload 前 32 hex；其余 base64 密文。
// 返回明文 JSON 字符串。
func DecryptBody(keyHex, payload string) (string, error) {
	key, err := hex.DecodeString(keyHex)
	if err != nil || len(key) != 32 {
		return "", ErrNoKey
	}
	if len(payload) < 32 {
		return "", ErrMalformedUTF8
	}
	iv, err := hex.DecodeString(payload[:32])
	if err != nil || len(iv) != 16 {
		return "", ErrMalformedUTF8
	}
	ct, err := base64.StdEncoding.DecodeString(payload[32:])
	if err != nil {
		return "", ErrInvalidJSON
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", ErrNoKey
	}
	if len(ct) == 0 || len(ct)%16 != 0 {
		return "", ErrInvalidJSON
	}
	plain := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ct)
	// PKCS7 去填充
	n := len(plain)
	if n == 0 {
		return "", ErrMalformedUTF8
	}
	pad := int(plain[n-1])
	if pad == 0 || pad > 16 || pad > n {
		return "", ErrMalformedUTF8
	}
	for _, b := range plain[n-pad:] {
		if int(b) != pad {
			return "", ErrMalformedUTF8
		}
	}
	plain = plain[:n-pad]
	if !isValidUTF8(plain) {
		return "", ErrMalformedUTF8
	}
	return string(plain), nil
}

func isValidUTF8(b []byte) bool {
	for i := 0; i < len(b); {
		if b[i] < 0x80 {
			i++
			continue
		}
		// 严谨 UTF8 校验
		var size int
		switch {
		case b[i]&0xE0 == 0xC0:
			size = 2
		case b[i]&0xF0 == 0xE0:
			size = 3
		case b[i]&0xF8 == 0xF0:
			size = 4
		default:
			return false
		}
		if i+size > len(b) {
			return false
		}
		for j := 1; j < size; j++ {
			if b[i+j]&0xC0 != 0x80 {
				return false
			}
		}
		i += size
	}
	return true
}

// ===== AES-256-GCM 分享 token（对应 src/common/utils/shareToken.js） =====

// GenerateShareToken：key=sha256(SECRET)（32B AES-256），12B IV，输出 iv.ct.tag(base64url)。
// payload JSON: {did, vs, pw, exp(ms)}。注意：不校验 exp（keep BUG-009，由调用方校验）。
func GenerateShareToken(secret, payloadJSON string) (string, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(payloadJSON), nil)
	ct, tag := sealed[:len(sealed)-16], sealed[len(sealed)-16:]
	b64 := base64.RawURLEncoding.EncodeToString
	return b64(nonce) + "." + b64(ct) + "." + b64(tag), nil
}

// VerifyShareToken 解密分享 token；不校验 exp（keep BUG-009）。
func VerifyShareToken(secret, token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("INVALID_TOKEN")
	}
	dec := base64.RawURLEncoding.DecodeString
	nonce, err := dec(parts[0])
	if err != nil {
		return "", errors.New("MALFORMED_TOKEN")
	}
	ct, err := dec(parts[1])
	if err != nil {
		return "", errors.New("MALFORMED_TOKEN")
	}
	tag, err := dec(parts[2])
	if err != nil {
		return "", errors.New("MALFORMED_TOKEN")
	}
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, append(ct, tag...), nil)
	if err != nil {
		return "", errors.New("MALFORMED_TOKEN")
	}
	// 🔒 SYNC-A36（2026-10-12）：补必填字段校验（shareToken.js:60-65）——
	//   Node 解密后 JSON.parse 并校验 did/vs/pw/exp，缺失抛 INVALID_PAYLOAD。
	//   原实现只解密就返回裸 JSON 串，空/残缺 payload 会被放行，
	//   调用方若依赖该异常做 401/404 判断就会走偏。
	var payload map[string]any
	if err := json.Unmarshal(plain, &payload); err != nil {
		return "", errors.New("MALFORMED_TOKEN")
	}
	if !truthy(payload["did"]) || payload["vs"] == nil ||
		payload["pw"] == nil || !truthy(payload["exp"]) {
		return "", errors.New("INVALID_PAYLOAD")
	}
	return string(plain), nil
}

// truthy 复刻 JS 布尔真值语义（0/""/false/null/undefined 皆为假）。
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0 && t == t // 排除 NaN
	case int64:
		return t != 0
	}
	return true
}
