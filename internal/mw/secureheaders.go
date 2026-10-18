package mw

// 🔒 SYNC-006（2026-10-11）：安全响应头中间件 —— Node 端 helmet（app.js:87-90，默认配置 +
// CORP: cross-origin）的 Go 等价物。此前 Go 端 X-Frame-Options/HSTS/CSP 等零命中。
//
// 头集合与 helmet 7.x 默认值逐项对齐（CSP 为 helmet 默认文档策略；JSON API 无感，
// 统一携带可防未来新增 HTML 端点时遗漏）。HSTS 头经 http 传输会被浏览器忽略 ⇒ 内网联调无影响。

import "net/http"

// SecureHeaders 给所有响应加安全头（挂全局链，静态资源同样覆盖）。
func SecureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy",
			"default-src 'self';base-uri 'self';font-src 'self' https: data:;"+
				"form-action 'self';frame-ancestors 'self';img-src 'self' data:;"+
				"object-src 'none';script-src 'self';script-src-attr 'none';"+
				"style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// Node 自定义：cross-origin（web 前端跨域加载 /api/public 图片需要）
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		h.Set("Origin-Agent-Cluster", "?1")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-DNS-Prefetch-Control", "off")
		h.Set("X-Download-Options", "noopen")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("X-XSS-Protection", "0")
		// 对齐 Node：不暴露服务器指纹。helmet 的 hidePoweredBy 只删 X-Powered-By，
		// 并不写 Server 头；Go net/http 默认也不发 —— 但 Set("Server","") 会**真的
		// 写出一个空 Server 头**（比不写更怪），故用 Del 显式移除防后人加回。
		h.Del("Server")
		next.ServeHTTP(w, r)
	})
}
