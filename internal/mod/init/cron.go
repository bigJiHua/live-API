package init

// cron.go — 复刻 app.js 启动逻辑中的分期定时任务注册：
// startInstallmentCron()（对应 Node src/modules/recurring/cron.js 的 start）。
//
// 由 recurring 包交付 StartCron（分记录表扫描/入账/作废，静默失败不影响主服务）。
//
// 🔒 SYNC-A33（2026-10-12）：原实现在本文件 init() 里直接注册启动钩子，
// 而 Go 的 init() 执行顺序是**文件名字母序**（cron.go < index.go）⇒ cron 钩子
// 先于 init 钩子执行。Node 的顺序是 app.js:223-236：
// `await init()` **之后**才 `startInstallmentCron()`。
// 顺序颠倒时，INSTALLMENT_SCAN_FIRST_DELAY=0 会在建表/迁移完成前就扫库。
// 现改为：cron 由 index.go 的 startupInit 在 runInit() 之后调用。
import "live/api/internal/mod/recurring"

// startInstallmentCron 由 startupInit 在初始化流程结束后调用（对齐 app.js 顺序）。
func startInstallmentCron() {
	recurring.StartCron()
}
