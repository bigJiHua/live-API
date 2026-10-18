// main.go — API_Go 入口，复刻 app.js 启动流程：
// 1. dotenv 加载 2. 密钥自检(fail-fast) 3. 连接池探测 4. init 初始化 5. recurring cron 6. listen
package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"live/api/internal/config"
	"live/api/internal/db"
	"live/api/internal/resp"
	"live/api/internal/srv"

	// 全部业务模块（blank import 触发 init() → srv.Add 注册路由，NewMux 按 canonicalOrder 排序装配）
	// 🔒 2026-10-13（api.md §11 冗余接口清理，与 Node 同步）：删除 bankcat（bank-category）、
	//    dbadm（database）、resource 三个模块；category 的 bank 子路由、account 的 stats/all、
	//    card 的 bill/rebuild-all、flow 的 /{id} 同步删除。
	_ "live/api/internal/mod/account"    // account + accountBalance
	_ "live/api/internal/mod/asset"      // 资产（init 注入 account.AutoSaveSnapshotHook）
	_ "live/api/internal/mod/auth"       // auth + user
	_ "live/api/internal/mod/budget"     // 预算
	_ "live/api/internal/mod/card"       // card + card-bill + card-repay
	_ "live/api/internal/mod/cardbill"   // card_bill 模型（card/creditcore 依赖）
	_ "live/api/internal/mod/category"   // category
	_ "live/api/internal/mod/creditcore" // CreditCore + foreignRegister（account 依赖）
	_ "live/api/internal/mod/datamgr"    // dataManager
	_ "live/api/internal/mod/fixedasset" // 固定资产
	_ "live/api/internal/mod/flow"       // 流水日历
	_ "live/api/internal/mod/fund"       // 理财
	_ "live/api/internal/mod/geo"        // 地理位置
	_ "live/api/internal/mod/init"       // 系统初始化 + cron 注册（须最后）
	_ "live/api/internal/mod/moment"     // 动态/日记
	_ "live/api/internal/mod/recurring"  // 周期支出/分期（StartCron 由 init 调用）
	_ "live/api/internal/mod/security"   // PIN 安全
	_ "live/api/internal/mod/share"      // 公开分享
	_ "live/api/internal/mod/todo"       // 待办
	_ "live/api/internal/mod/upload"     // 上传
	_ "live/api/internal/mod/work"       // 工作工资
)

func main() {
	// 1. 环境变量
	config.Load()
	resp.IsDev = config.IsDevelopment

	// 2. 密钥自检（对应 secretGuard.auditSecrets，生产弱密钥拒绝启动）
	weak := config.AuditSecrets([]config.SecretRef{
		{Name: "JWT_SECRET"},
		{Name: "SHARE_TOKEN_SECRET", FallbackTo: "JWT_SECRET"},
	})
	if len(weak) > 0 {
		detail := fmt.Sprintf("密钥未配置或强度不足：%v。要求 ≥ 32 位随机字符串且不能是占位值，可用 openssl rand -hex 32 生成。", weak)
		if config.IsProduction() {
			fmt.Fprintf(os.Stderr, "[启动中止] %s（生产环境拒绝以弱密钥启动）\n", detail)
			os.Exit(1)
		}
		// SYNC-A17（2026-10-12）：对齐 app.js:22 —— dev 环境也要告警放行，
		//   原实现静默跳过，部署者无从得知自己在用弱密钥。
		fmt.Fprintf(os.Stderr, "[security] ⚠ %s 当前为开发环境，已放行；生产环境将拒绝启动。\n", detail)
	}

	// 🔒 SYNC-A18（2026-10-12）端口隔离：Go 版默认端口改为 **7777**。
	//   背景：API_Go/.env 是从 api/.env 复制的，PORT=666 与 Node 端撞车 ——
	//   两端同时起会互相抢占端口，且 Nuxt/web 的代理指向无法区分是哪一端在服务，
	//   排障时极难定位。现 Go 端固定独立端口 7777（.env 亦已改为 7777），
	//   Node 端保持 666 不动，两端可并行运行对照。
	port := config.Get("PORT", "7777")
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.NewMux(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	// 3. 数据库连接探测（与 Node 一致：失败不退出，仅打印）
	go func() {
		if err := db.Ping(); err != nil {
			fmt.Printf("❌ 数据库连接失败: %s\n", err.Error())
			fmt.Printf("   目标: %s@%s:%s/%s\n",
				config.Get("DB_USER", "root"), config.Get("DB_HOST", "localhost"),
				config.Get("DB_PORT", "3306"), config.Get("DB_NAME", "live"))
			return
		}
		fmt.Printf("🗄️  数据库连接成功: %s@%s:%s/%s\n",
			config.Get("DB_USER", "root"), config.Get("DB_HOST", "localhost"),
			config.Get("DB_PORT", "3306"), config.Get("DB_NAME", "live"))
	}()

	// 4-5. 初始化与 cron（mod/init 注册的钩子，按注册顺序执行）
	srv.RunStartupHooks()

	fmt.Printf("🚀 服务已启动: http://localhost:%s\n", port)
	fmt.Printf("🌍 环境: %s\n", config.Get("NODE_ENV", "dev"))
	fmt.Printf("📡 API 地址: http://localhost:%s/api/v1\n", port)
	fmt.Printf("⚠️  注意：Go 版使用独立端口 %s（Node 版为 666），两端可并行运行对照。\n", port)

	if err := server.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "server error: %s\n", err)
		os.Exit(1)
	}
}
