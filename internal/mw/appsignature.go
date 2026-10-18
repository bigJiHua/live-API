package mw

// 🔒 SYNC-011（2026-10-11）：APP 签名自检守卫 —— 1:1 对齐 Node common/middleware/appSignatureGuard.js（P1-28）。
//
// ## 威胁模型
// 拦「重打包的假 APP」：反编译官方 APK、改代码、换密钥重签（指纹必变）。
// 防不住官方密钥泄露与 root hook —— 是抬高门槛，不是绝对防护。
//
// ## 三模式（APP_SIGN_SHA256 是否配置决定，APP_SIGN_ENFORCE 选 strict）
//   未配置（默认）     → 守卫不启用（开源用户零影响）
//   配置 + loose(默认) → 带头必匹配；不带头放行（浏览器/curl）
//   配置 + strict      → 全部必带且匹配（纯 APP 部署用）
//
// ## 与 Node 的装配差异
// Node 全局挂载（含 404/静态路径）；Go 这里挂在 root 之外、PinSecurityGuard 之外
//（对齐 Node「pin 之后」的顺序），因此本守卫看到的是原始路径 —— /api/public 豁免
// 在这里判断（对齐 Node 复审修复：浏览器 <img> 加载静态资源不带自定义头）。

import (
	"log"
	"net/http"
	"regexp"
	"strings"

	"live/api/internal/config"
	"live/api/internal/resp"
)

var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// GetWhitelist 读白名单：逗号分隔多个指纹（部署者换签可平滑共存新旧两版 APP）。
func GetWhitelist() []string {
	var out []string
	for _, s := range strings.Split(config.Get("APP_SIGN_SHA256", ""), ",") {
		s = strings.ToLower(strings.TrimSpace(s))
		if hex64Re.MatchString(s) {
			out = append(out, s)
		}
	}
	return out
}

// IsStrict 是否 strict 模式（默认 loose）。
func IsStrict() bool {
	return strings.EqualFold(config.Get("APP_SIGN_ENFORCE", "loose"), "strict")
}

// AppSignatureGuard 包裹式中间件（对齐 Node 全局挂载语义）。
func AppSignatureGuard(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		whitelist := GetWhitelist()

		// 未配置白名单 ⇒ 守卫不启用（对齐 Node：开源用户 / 开发环境零影响）
		if len(whitelist) == 0 {
			h.ServeHTTP(w, r)
			return
		}

		// 公开静态资源豁免（Node 复审修复同款）：浏览器 <img> 不带自定义头，
		// strict 下不豁免会全部 403；公开资源不构成「客户端身份」语义。
		if strings.HasPrefix(r.URL.Path, "/api/public") {
			h.ServeHTTP(w, r)
			return
		}

		reported := strings.ToLower(strings.TrimSpace(r.Header.Get("X-App-Sign-Sha256")))

		if reported == "" {
			if IsStrict() {
				resp.Say(w, "客户端身份校验失败", 403)
				return
			}
			// loose：浏览器 / curl / 未升级的旧版 APP 放行（接受的残余风险）
			h.ServeHTTP(w, r)
			return
		}

		matched := false
		for _, w2 := range whitelist {
			if reported == w2 {
				matched = true
				break
			}
		}
		if !matched {
			log.Printf("[app-signature] 签名不匹配 ip=%s reported=%s... path=%s",
				ClientIP(r), reported[:min(16, len(reported))], r.URL.Path)
			resp.Say(w, "客户端身份校验失败", 403)
			return
		}

		h.ServeHTTP(w, r)
	})
}
