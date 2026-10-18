// Package srv 复刻 app.js + src/api/index.js 的中间件装配与路由注册顺序。
package srv

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"live/api/internal/config"
	"live/api/internal/mw"
	"live/api/internal/resp"
)

// moduleRegistrar 模块注册函数签名。每个模块包暴露 Register(mux)。
type moduleRegistrar struct {
	name string
	fn   func(mux *http.ServeMux)
}

// registrars 各模块 init() 时登记；NewMux 按 canonicalOrder 排序后装配，
// 保证与 Node api/src/api/index.js 的挂载顺序一致（不依赖 init 顺序）。
var registrars []moduleRegistrar

// canonicalOrder 复刻 api/src/api/index.js 的路由注册顺序（dashboard 不挂载）。
// 🔒 2026-10-13（api.md §11）：bank/bank-category/database/resource 四组已与 Node 同步删除。
var canonicalOrder = []string{
	"auth", "security", "account", "accountBalance", "category",
	"card", "card-bill", "card-repay", "user", "upload",
	"moment", "asset", "todo", "work", "fixedAsset", "budget", "fund",
	"recurring", "flow", "dataManager", "geo", "share",
}

// Add 登记模块路由（模块包 init() 中调用）。
func Add(name string, fn func(mux *http.ServeMux)) {
	registrars = append(registrars, moduleRegistrar{name: name, fn: fn})
}

func sortedRegistrars() []moduleRegistrar {
	out := make([]moduleRegistrar, len(registrars))
	copy(out, registrars)
	idx := map[string]int{}
	for i, n := range canonicalOrder {
		idx[n] = i
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && idx[out[j].name] < idx[out[j-1].name]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// startupHooks 启动钩子（初始化、cron 等），由 mod/init 注册。
var startupHooks []func()

// OnStartup 注册启动钩子。
func OnStartup(fn func()) { startupHooks = append(startupHooks, fn) }

// RunStartupHooks 按注册顺序执行启动钩子。
func RunStartupHooks() {
	for _, fn := range startupHooks {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					fmt.Printf("⚠️ 启动钩子 panic: %v\n", rec)
				}
			}()
			fn()
		}()
	}
}

// cors 复刻 app.js 白名单。
//
// devPrivateOriginRe dev 环境放行本机/内网调试源：webview-APP 经手机热点或虚拟网卡
// 联调时，页面源可能是 192.168.137.1:5174 这类任意内网 IP（vite 的 Network 地址
// 随活动网卡变化），硬编码清单会漏拦正常联调流量，故改为匹配全部内网段。
// 仅限 5173/5174（vite dev 端口），生产环境不生效。
var devPrivateOriginRe = regexp.MustCompile(
	`^http://(localhost|127\.0\.0\.1|(10|192\.168|172\.(1[6-9]|2\d|3[01]))(\.\d{1,3}){2}):(5173|5174)$`)

func corsMiddleware(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range strings.Split(config.Get("CORS_EXTRA_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	if fu := os.Getenv("FRONTEND_URL"); fu != "" {
		allowed[fu] = true
	}
	isDev := !config.IsProduction()
	if isDev {
		for _, o := range []string{
			"http://localhost:5173", "http://localhost:5174",
			"http://127.0.0.1:5173", "http://127.0.0.1:5174",
		} {
			allowed[o] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (allowed[origin] || (isDev && devPrivateOriginRe.MatchString(origin))) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			// SYNC-A7（2026-10-12）：补 x-app-sign-sha256（Node app.js:142）——
			//   漏配会让浏览器/webview 的预检直接拒掉该头 ⇒ APP_SIGN_ENFORCE=strict
			//   时 APP 端全量 403。清单须与 Node app.js:122-146 逐项一致。
			w.Header().Set("Access-Control-Allow-Headers",
				"Content-Type, Authorization, viewportwidth, viewportheight, pixelratio, navigatorplatform, "+
					"X-Requested-With, x-client-timestamp, x-fingerprint-hash, x-user-agent-custom, x-client-nonce, "+
					"x-device-model, x-os-name, x-device-type, x-scene, X-FP-ID, x-route-verify-token, "+
					"x-app-sign-sha256, x-sign, x-client-ip")
			// SYNC-A7：cors 中间件默认 maxAge=600 + Vary: Origin（防 CDN/代理串源）
			w.Header().Set("Access-Control-Max-Age", "600")
			w.Header().Add("Vary", "Origin")
		}
		// SYNC-A7：只对**预检**（带 Access-Control-Request-Method）短路 204，
		//   普通 OPTIONS 探测应继续走业务链路（对齐 express cors 行为）。
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// logger 复刻 morgan。
// SYNC-A8（2026-10-12）：Node app.js:149 是 `morgan(production ? "combined" : "dev")`，
//
//	**生产也输出**。原实现仅 dev 打印 ⇒ 生产请求日志全量丢失，排障/审计能力下降。
//	现统一输出单行结构化日志（含 ip），并保留 statusWriter 的 Flusher/Hijacker
//	透传能力（静态资源与 SSE 场景需要）。
func logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		fmt.Printf("%s %s %s %d %s ip=%s\n",
			start.Format("2006-01-02T15:04:05.000Z07:00"),
			r.Method, r.URL.Path, sw.status,
			time.Since(start).Round(time.Microsecond), mw.ClientIP(r))
		// 非 2xx（4xx/5xx = 排障关注的问题响应）追加响应体摘要行，
		// 让「非法请求！」「请输入账号和密码」这类具体拦截原因直接可读（对齐 morgan 排障体验）。
		if sw.status >= 400 {
			msg := strings.TrimSpace(sw.body.String())
			if msg == "" {
				msg = "(no body)"
			}
			fmt.Printf("   └─ %s %s → %d %s\n%s\n",
				r.Method, r.URL.RequestURI(), sw.status,
				time.Since(start).Round(time.Millisecond), msg)
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
	// body 非 2xx 时的响应体截取（logBodyMax 上限），供 logger 打印问题详情。
	body bytes.Buffer
}

// logBodyMax 问题响应体打印上限（字节），防止大响应刷屏。
const logBodyMax = 512

// Unwrap 透传原始 ResponseWriter（保持 http.ResponseController 能力）。
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Flush 透传（静态大文件 / SSE）。
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Write 透传写出的同时，为非 2xx 响应截取前 logBodyMax 字节作排障摘要。
func (s *statusWriter) Write(p []byte) (int, error) {
	if s.status >= 400 && s.body.Len() < logBodyMax {
		n := logBodyMax - s.body.Len()
		if len(p) < n {
			n = len(p)
		}
		s.body.Write(p[:n])
	}
	return s.ResponseWriter.Write(p)
}

// NotFound 复刻 notFoundHandler：{code:404, message}。
func NotFound(w http.ResponseWriter, r *http.Request) {
	resp.JSON(w, 404, map[string]any{
		"code":    404,
		"message": "非法访问: " + r.Method + " " + r.URL.Path + "！",
	})
}

// healthServiceID 站点身份标识（必须与 Node app.js 的 HEALTH_SERVICE_ID、
// APP 的 SiteProbe.SERVICE_ID 三处保持一致）。
const healthServiceID = "live-finance"

// healthHandler 复刻 Node `GET /api/health`（APP「接入站点」探测用，2026-10-17）：
// 不鉴权、不查库、不写库，只证明「该地址上跑着本项目的后端」。
func healthHandler(w http.ResponseWriter, r *http.Request) {
	resp.JSON(w, http.StatusOK, map[string]any{
		"status":  200,
		"message": "ok",
		"data": map[string]any{
			"service": healthServiceID,
			"version": config.Get("APP_VERSION", ""),
			"time":    time.Now().UTC().Format(time.RFC3339),
		},
	})
}

// healthBypass 把 /api/health 提到 PIN/APP 签名守卫**之外**（对齐 Node：健康检查在
// app.use(pinSecurityGuard) / appSignatureGuard 之前注册）。
//
// Why：探针/运维监控不该被 PIN 风控或 APK 签名白名单拦住 —— 否则 strict 模式下
// curl 探活会 403，APP 端也无法用最简请求判断「地址是否可达」。
// 仍保留外层的 SecureHeaders / cors / logger / Recover。
func healthBypass(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/api/health" {
			healthHandler(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// NewMux 装配完整应用（中间件顺序 = app.js）。
func NewMux() http.Handler {
	// 业务路由（/api/v1）
	apiMux := http.NewServeMux()
	for _, m := range sortedRegistrars() {
		m.fn(apiMux)
	}
	// SYNC-A6（2026-10-12）：/api/v1 下未匹配的路径必须回 Node 的 JSON 404，
	// 否则 ServeMux 默认吐 text/plain "404 page not found"（前端拿不到 code/message）。
	apiMux.HandleFunc("/", NotFound)

	root := http.NewServeMux()
	// /api/v1：securityCheck 全局 → 业务路由
	root.Handle("/api/v1/", mw.SecurityCheck(apiMux))
	// /api/public：静态资源（与 Node public 目录一致，相对 cwd）
	publicDir := config.PathUnder("public")
	root.Handle("/api/public/", http.StripPrefix("/api/public/", staticHandler(publicDir)))
	root.HandleFunc("/", NotFound)

	// 全局链（自外向内 = Node app.js 的执行顺序）：
	//   SecureHeaders → Recover → cors → logger → body(解密) → pinGuard → appSignature → root
	//
	// ⚠ 后包装 = 外层，故「先写的后执行」。
	// 🔒 SYNC-A6：pinSecurityGuard 必须在 appSignatureGuard **之内**（即先执行）——
	//   Node app.js:176-179 是 app.use(pin) → app.use(appSignature)，签名层在外。
	//   原实现把两者装反，同一请求（需 PIN + 签名不匹配）Node 返 8303 challenge、
	//   Go 返 403「客户端身份校验失败」，前端重试流程对不上。
	var h http.Handler = root
	h = mw.AppSignatureGuard(h) // 🔒 SYNC-011：APP 签名自检（外层，对齐 Node pin 之后）
	h = mw.PinSecurityGuard(h)  // 🔒 PIN 风控（内层，先于签名执行）
	// 站点健康检查不走上面两个守卫（对齐 Node app.js 的注册位置）
	h = healthBypass(h)
	h = mw.BodyLoader(h)
	h = logger(h)
	h = corsMiddleware(h)
	h = mw.Recover(h)
	// 🔒 SYNC-006：安全响应头（helmet 等价物）—— 放最外层，
	//   panic/404/静态资源响应也带头。
	h = mw.SecureHeaders(h)
	return h
}

// staticHandler 复刻 express.static（仅文件服务，无目录列表）。
func staticHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up := r.URL.Path
		if strings.Contains(up, "..") {
			resp.JSON(w, 403, map[string]any{"status": 403, "message": "Forbidden"})
			return
		}
		full := filepath.Join(dir, filepath.Clean(up))
		if st, err := os.Stat(full); err == nil && st.IsDir() {
			http.NotFound(w, r)
			return
		}
		fs.ServeHTTP(w, r)
	})
}
