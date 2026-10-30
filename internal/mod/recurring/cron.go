package recurring

import (
	"strconv"
	"sync"
	"time"

	"live/api/internal/config"
)

// ============================================================================
// 分期计划入账定时扫描任务 —— from: cron.js
// ============================================================================
//
// 背景：分期的入账时机是确定的（每期 plan_date = 账单日前 2 天），
// 此前只能靠「用户打开页面时读取触发」，不开 App 就不会入账。
// 本任务在服务启动后定期静默扫描：到期即入账、超期即作废。
//
// 设计约束（对应 Node cron.js 头部注释）：
//  1. 不引入第三方依赖，原生 time.Ticker + 进程内互斥锁。
//  2. 并发安全：入账动作在 model 层按 `${id}:${month}` 加互斥锁（withEnterLock）。
//  3. 单实例前提：进程内锁只在同一进程内有效；多实例部署需改 MySQL GET_LOCK。
//  4. 全程 recover：单条分期失败仅告警，不影响其他分期与主服务。
//  5. 顺序固定：先作废超期期次、再入账到期期次，避免刚入账又被判超期。
//
// 环境变量（均有默认值）：
//   - INSTALLMENT_SCAN_INTERVAL_MS  扫描间隔，默认 6 小时
//   - INSTALLMENT_SCAN_FIRST_DELAY  首次扫描延迟，默认 30 秒（等服务就绪）
//   - INSTALLMENT_SCAN_DRY_RUN=true 只报告不入账
//   - INSTALLMENT_SCAN_ENABLED=false 完全关闭定时任务
//
// 注意：本包不自行注册定时器；由 internal/mod/init 包在启动钩子中调用 StartCron。

// 环境变量读取均为惰性函数：.env 由 main() 的 config.Load() 在包初始化之后加载，
// 包级 var 会在其之前求值而永远取不到 .env 值（对应 Node 的 process.env 读取时机）。
func scanInterval() time.Duration { return envDurationMS("INSTALLMENT_SCAN_INTERVAL_MS", 6*60*60*1000) }
func firstDelay() time.Duration   { return envDurationMS("INSTALLMENT_SCAN_FIRST_DELAY", 30*1000) }
func scanEnabled() bool           { return config.Get("INSTALLMENT_SCAN_ENABLED", "") != "false" }

func envDurationMS(k string, defMS int64) time.Duration {
	if v := config.Get(k, ""); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return time.Duration(defMS) * time.Millisecond
}

func isDryRun() bool { return config.Get("INSTALLMENT_SCAN_DRY_RUN", "") == "true" }

var (
	cronMu     sync.Mutex
	cronStop   chan struct{}
	cronClosed bool
	scanning   bool // 重入保护（对应 Node scanning）
)

func logLine(msg string) {
	println("[installment-cron][" + time.Now().Format(time.RFC3339) + "] " + msg)
}

// ScanReport 对应 scanOnce 返回值。
type ScanReport struct {
	Scanned int
	Entered []map[string]any
	Voided  []map[string]any
	Failed  []map[string]any
	Skipped bool
	DryRun  bool
}

// ScanOnce 扫描一遍全量启用中的分期：
//   - 已过「计划入账日 + 宽限天数」仍未入账 → 作废
//   - 已到达计划入账日且未入账 → 入账
func ScanOnce() ScanReport {
	cronMu.Lock()
	if scanning {
		cronMu.Unlock()
		logLine("上一次扫描尚未结束，本次跳过")
		return ScanReport{Scanned: 0, Skipped: true}
	}
	scanning = true
	cronMu.Unlock()

	dryRun := isDryRun()
	report := ScanReport{DryRun: dryRun}

	defer func() {
		if rec := recover(); rec != nil {
			logLine("扫描异常: " + errText(rec))
		}
		cronMu.Lock()
		scanning = false
		cronMu.Unlock()
	}()

	rows, err := findActiveInstallments()
	if err != nil {
		logLine("扫描异常: " + err.Error())
		return report
	}
	report.Scanned = len(rows)

	for _, row := range rows {
		id := toStr(row["id"])
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					report.Failed = append(report.Failed, map[string]any{"id": id, "reason": errText(rec)})
				}
			}()

			// 1) 作废超期未入账的期次（先于入账执行）
			beforeVoid := parseMonthRecords(row["month_records"])
			willVoid := []string{}
			for _, month := range sortedKeys(beforeVoid) {
				s := toStr(beforeVoid[month]["status"])
				pending := s == "pending" || (s == "entering" && !jsTruthy(beforeVoid[month]["remark"]))
				if pending && isEnterExpired(row, month, beforeVoid) {
					willVoid = append(willVoid, month)
				}
			}
			if len(willVoid) > 0 {
				if dryRun {
					report.Voided = append(report.Voided, map[string]any{"id": id, "months": willVoid, "dryRun": true})
				} else {
					if _, err := voidExpiredInstallments(row); err != nil {
						report.Failed = append(report.Failed, map[string]any{"id": id, "reason": err.Error()})
						return
					}
					report.Voided = append(report.Voided, map[string]any{"id": id, "months": willVoid})
				}
			}

			// 2) 入账已到达计划入账日的期次
			records := parseMonthRecords(row["month_records"])
			willEnter := []string{}
			for _, month := range sortedKeys(records) {
				s := toStr(records[month]["status"])
				pending := s == "pending" || (s == "entering" && !jsTruthy(records[month]["remark"]))
				if pending && canEnterNow(row, month, records) {
					willEnter = append(willEnter, month)
				}
			}
			if len(willEnter) > 0 {
				if dryRun {
					report.Entered = append(report.Entered, map[string]any{"id": id, "months": willEnter, "dryRun": true})
				} else {
					if _, err := autoEnterPending(id, toStr(row["user_id"])); err != nil {
						report.Failed = append(report.Failed, map[string]any{"id": id, "reason": err.Error()})
						return
					}
					report.Entered = append(report.Entered, map[string]any{"id": id, "months": willEnter})
				}
			}
		}()
	}

	suffix := ""
	if dryRun {
		suffix = "（DRY-RUN，未写库）"
	}
	logLine("扫描完成" + suffix + ": 共 " + strconv.Itoa(report.Scanned) + " 笔分期，入账 " +
		strconv.Itoa(len(report.Entered)) + " 笔，作废 " + strconv.Itoa(len(report.Voided)) +
		" 笔，失败 " + strconv.Itoa(len(report.Failed)) + " 笔")
	return report
}

func errText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return "panic"
}

// StartCron 启动定时扫描（幂等：重复调用先清理旧定时器，对应 Node start()）。
func StartCron() {
	if !scanEnabled() {
		logLine("已通过 INSTALLMENT_SCAN_ENABLED=false 关闭")
		return
	}

	interval := scanInterval()
	delay := firstDelay()

	cronMu.Lock()
	if cronStop != nil && !cronClosed {
		close(cronStop) // 清理旧定时器（对应 clearInterval）
	}
	stopCh := make(chan struct{})
	cronStop = stopCh
	cronClosed = false
	cronMu.Unlock()

	dryRunSuffix := ""
	if isDryRun() {
		dryRunSuffix = "（DRY-RUN 模式，不会写库）"
	}
	logLine("已注册，首次扫描 " + strconv.FormatInt(int64(delay.Seconds()), 10) + "s 后执行，之后每 " +
		strconv.FormatInt(int64(interval.Minutes()), 10) + " 分钟一次" + dryRunSuffix)

	// 首次扫描（对应 setTimeout(...).unref?.()：不阻塞进程退出）
	go func() {
		defer func() { _ = recover() }()
		select {
		case <-time.After(delay):
			ScanOnce()
		case <-stopCh:
		}
	}()

	// 周期扫描（对应 setInterval(...).unref?.()）
	go func() {
		defer func() { _ = recover() }()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				ScanOnce()
			case <-stopCh:
				return
			}
		}
	}()
}

// StopCron 停止定时扫描（对应 stop()）。
func StopCron() {
	cronMu.Lock()
	defer cronMu.Unlock()
	if cronStop != nil && !cronClosed {
		close(cronStop)
		cronClosed = true
	}
}
