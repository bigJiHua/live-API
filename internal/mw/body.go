package mw

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/sec"
	"live/api/internal/tim"
)

// BodyLoader 全局 body 中间件：复刻 express.json() + authSecurityData.decryptWithSecurity。
// - application/json（含加密 {_p}）：解密/解析后存入 context（resp.Parse 优先读取）
// - x-www-form-urlencoded：扁平解析（对应 express.urlencoded）
// - 其它（multipart 等）：raw bytes 回填 r.Body 供 multipart 解析，不解析
func BodyLoader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		_ = r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(raw)) // 回填，兼容 multipart
		ct := r.Header.Get("Content-Type")
		switch {
		case strings.Contains(ct, "application/json"):
			handleJSONBody(w, r, raw, next)
		case strings.Contains(ct, "application/x-www-form-urlencoded"):
			vals, _ := url.ParseQuery(string(raw))
			m := map[string]any{}
			for k, v := range vals {
				if len(v) > 0 {
					m[k] = v[0]
				}
			}
			// 🔒 SYNC-A44（2026-10-13）：Data 必须是 `body.data`，**不能**是扁平 map 本身。
			//
			// Node `express.urlencoded({extended:true})` 后 req.body 是**扁平对象**，
			// `req.body.data` 为 undefined。而 accountLockCheck.js:147 写的是
			//     const { nameOrEmail } = req.body.data || {};
			// ⇒ 表单编码的 /auth/login 在 Node 必走 `!nameOrEmail` → 401「非法未知参数请求！」。
			//
			// 旧实现把同一个 map 同时当 Raw 与 Data，于是 lookup("data.nameOrEmail")
			// 剥掉 "data." 前缀后在 Data（=扁平 m）里命中顶层 nameOrEmail ⇒ Go 放行进入密码校验。
			// 结果：多出一条 Node 不允许的登录通道（凭据出现在 URL 编码体里）。
			serveWithBody(next, w, r, resp.Body{Raw: m, Data: dataSub(m)})
		default:
			next.ServeHTTP(w, r)
		}
	})
}

// dataSub 取 body 的 data 子对象（不存在或非对象时返回 nil）。
//
// 🔒 SYNC-A44（2026-10-13）：对应 Node 里 req.body.data 的语义 ——
// 只有 body 确实含一个**对象形态**的 data 字段时才算有 data。
// urlencoded 编码后 body 是扁平对象，data 不存在 ⇒ 返回 nil。
func dataSub(m map[string]any) map[string]any {
	if d, ok := m["data"].(map[string]any); ok {
		return d
	}
	return nil
}

func handleJSONBody(w http.ResponseWriter, r *http.Request, raw []byte, next http.Handler) {
	var m map[string]any
	if len(raw) > 0 {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		_ = dec.Decode(&m)
	}
	if m == nil {
		m = map[string]any{}
	}
	fp := r.Header.Get("x-fp-id")
	scene := r.Header.Get("x-scene")
	if scene == "" {
		scene = "login"
	}
	payload, _ := m["_p"].(string)

	if fp == "" || payload == "" {
		// 明文放行（keep：缺 fp 或 _p 直接 next）
		b := resp.Body{Raw: m, Data: map[string]any{}}
		if d, ok := m["data"].(map[string]any); ok {
			b.Data = d
		}
		serveWithBody(next, w, r, b)
		return
	}

	// 加密路径：查 device_crypto 取 aes_key
	var keyHex string
	var lockedUntil any
	if err := db.DB().QueryRow(
		"SELECT aes_key, locked_until FROM device_crypto WHERE fingerprint = ? AND scene = ? LIMIT 1", fp, scene).
		Scan(&keyHex, &lockedUntil); err != nil {
		resp.Say(w, "安全隧道未建立", 401)
		return
	}
	if lockedUntil != nil {
		if ms, ok := toMS(lockedUntil); ok && ms > tim.Now().UnixMilli() {
			resp.Say(w, "设备环境异常，请稍后再试", 423) // keep BUG-003：locked_until 无人写入，分支实际不可达
			return
		}
	}
	// SYNC-010（2026-10-11）：库里存的是 GCM 密文（enc.v1:...），先解出真 key；
	//   存量明文行由 DecryptField 原样透传（升级前落库的数据照常工作）。
	realKey, ferr := sec.DecryptField(keyHex)
	if ferr != nil {
		// 篡改/密钥不符 => 与解密失败同路径（对齐 Node authSecurityData catch）
		_, _ = db.DB().Exec("UPDATE device_crypto SET fail_count = fail_count + 1 WHERE fingerprint = ?", fp)
		resp.Say(w, "请求数据非法", 400)
		return
	}

	// P1-9 惰性迁移：存量明文握手行 => 顺手加密回写（失败不阻断）。
	//    邮件行（fingerprint=email_verify_*，aes_key 存 userId 且被 WHERE 精确匹配）绝不迁移。
	if sec.NeedsReencrypt(keyHex) && !strings.HasPrefix(fp, "email_verify") {
		if encKey, eerr := sec.EncryptField(keyHex); eerr == nil {
			_, _ = db.DB().Exec(
				"UPDATE device_crypto SET aes_key = ? WHERE fingerprint = ? AND scene = ?",
				encKey, fp, scene)
		}
	}

	plain, derr := sec.DecryptBody(realKey, payload)
	if derr != nil {
		msg := "请求数据非法"
		if derr == sec.ErrMalformedUTF8 {
			msg = "安全校验未通过(KEY_ERR)"
		}
		// keep BUG-004：fail_count 只按 fingerprint 累加，不带 scene
		_, _ = db.DB().Exec("UPDATE device_crypto SET fail_count = fail_count + 1 WHERE fingerprint = ?", fp)
		resp.Say(w, msg, 400)
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(plain), &parsed); err != nil || parsed == nil {
		_, _ = db.DB().Exec("UPDATE device_crypto SET fail_count = fail_count + 1 WHERE fingerprint = ?", fp)
		resp.Say(w, "请求数据非法", 400)
		return
	}
	b := resp.Body{Raw: parsed, Data: map[string]any{}}
	if d, ok := parsed["data"].(map[string]any); ok {
		b.Data = d
	}
	// SYNC-A45（2026-10-13）：补 req.device 写入。
	// Node authSecurityData.js:70 有 req.device = device（device_crypto 完整行），
	// auth/controller/index.js:126-134 读 req.device.locked_until 返 423。旧 Go 完全无 WithDevice
	// 写入点（全仓零调用）而 auth/controller.go:70 在读 ⇒ 死代码。
	// 当前 locked_until 两端均无人写入（keep BUG-003），暂无可观察差异；
	// 但一旦任一端开始写它，Go 会静默失效。
	serveWithBody(next, w, resp.WithDevice(r, map[string]any{
		"fingerprint":  fp,
		"scene":        scene,
		"locked_until": lockedUntil,
	}), b)
}

func serveWithBody(next http.Handler, w http.ResponseWriter, r *http.Request, b resp.Body) {
	next.ServeHTTP(w, resp.WithBody(r, b))
}

// toMS 把 DB 读出的 bigint（int64/[]byte/string）转毫秒。
func toMS(v any) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case []byte:
		s := strings.TrimSpace(string(t))
		if s == "" {
			return 0, false
		}
		n, err := strconv.ParseInt(s, 10, 64)
		return n, err == nil
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, false
		}
		n, err := strconv.ParseInt(s, 10, 64)
		return n, err == nil
	}
	return 0, false
}
