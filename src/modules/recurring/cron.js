/**
 * 分期计划入账定时扫描任务
 * ==========================================================================
 * 背景：分期的入账时机是确定的（每期 plan_date = 账单日前 2 天），
 *      此前只能靠「用户打开页面时读取触发」，不开 App 就不会入账。
 *      本任务在服务启动后定期静默扫描：到期即入账、超期即作废。
 *
 * 设计约束：
 *  1. 不引入任何第三方依赖，用原生 setInterval + 进程内互斥锁实现。
 *  2. 并发安全：入账动作在 model 层按 `${id}:${month}` 加互斥锁，
 *     定时任务与 HTTP 请求同时命中同一期时不会重复建流水。
 *  3. 单实例前提：进程内锁只在同一进程内有效。若使用 pm2 cluster 等
 *     多实例部署，必须改为 MySQL GET_LOCK，否则仍有并发重复入账风险。
 *  4. 全程 try/catch：单条分期失败仅告警，不影响其他分期与主服务。
 *  5. 顺序固定：先作废超期期次、再入账到期期次，避免刚入账又被判超期。
 *
 * 环境变量（均有默认值，不改即可用）：
 *  - INSTALLMENT_SCAN_INTERVAL_MS  扫描间隔，默认 6 小时
 *  - INSTALLMENT_SCAN_FIRST_DELAY  首次扫描延迟，默认 30 秒（等服务就绪）
 *  - INSTALLMENT_SCAN_DRY_RUN=true 只报告不入账（首次上线建议先跑一遍看清单）
 *  - INSTALLMENT_SCAN_ENABLED=false 完全关闭定时任务
 */

const RecurringExpense = require("./model");

const SCAN_INTERVAL_MS = Number(process.env.INSTALLMENT_SCAN_INTERVAL_MS) || 6 * 60 * 60 * 1000;
const FIRST_DELAY_MS = Number(process.env.INSTALLMENT_SCAN_FIRST_DELAY) || 30 * 1000;
const ENABLED = process.env.INSTALLMENT_SCAN_ENABLED !== "false";

let timer = null;
let scanning = false;

function isDryRun() {
  return process.env.INSTALLMENT_SCAN_DRY_RUN === "true";
}

function log(message) {
  const ts = new Date().toISOString();
  console.log(`[installment-cron][${ts}] ${message}`);
}

/**
 * 扫描一遍全量启用中的分期：
 *  - 已过「计划入账日 + 宽限天数」仍未入账 → 作废
 *  - 已到达计划入账日且未入账 → 入账
 * @returns {{scanned:number, entered:Array, voided:Array, failed:Array}}
 */
async function scanOnce() {
  if (scanning) {
    log("上一次扫描尚未结束，本次跳过");
    return { scanned: 0, entered: [], voided: [], failed: [], skipped: true };
  }
  scanning = true;
  const dryRun = isDryRun();
  const report = { scanned: 0, entered: [], voided: [], failed: [], dryRun };

  try {
    const rows = await RecurringExpense.findActiveInstallments();
    report.scanned = rows.length;

    for (const row of rows) {
      try {
        // 1) 作废超期未入账的期次（先于入账执行）
        const beforeVoid = RecurringExpense.parseMonthRecords(row.month_records);
        const willVoid = Object.keys(beforeVoid).filter((month) => {
          const s = beforeVoid[month].status;
          const pending = s === "pending" || (s === "entering" && !beforeVoid[month].remark);
          return pending && RecurringExpense.isEnterExpired(row, month, beforeVoid);
        });

        if (willVoid.length) {
          if (dryRun) {
            report.voided.push({ id: row.id, months: willVoid, dryRun: true });
          } else {
            await RecurringExpense.voidExpiredInstallments(row);
            report.voided.push({ id: row.id, months: willVoid });
          }
        }

        // 2) 入账已到达计划入账日的期次
        const records = RecurringExpense.parseMonthRecords(row.month_records);
        const willEnter = Object.keys(records).filter((month) => {
          const s = records[month].status;
          const pending = s === "pending" || (s === "entering" && !records[month].remark);
          return pending && RecurringExpense.canEnterNow(row, month, records);
        });

        if (willEnter.length) {
          if (dryRun) {
            report.entered.push({ id: row.id, months: willEnter, dryRun: true });
          } else {
            await RecurringExpense.autoEnterPending(row.id, row.user_id);
            report.entered.push({ id: row.id, months: willEnter });
          }
        }
      } catch (e) {
        report.failed.push({ id: row.id, reason: e.message });
        console.warn(`[installment-cron] 扫描分期失败 id=${row.id}: ${e.message}`);
      }
    }

    const suffix = dryRun ? "（DRY-RUN，未写库）" : "";
    log(
      `扫描完成${suffix}: 共 ${report.scanned} 笔分期，入账 ${report.entered.length} 笔，作废 ${report.voided.length} 笔，失败 ${report.failed.length} 笔`
    );
    if (report.entered.length) log(`入账明细: ${JSON.stringify(report.entered)}`);
    if (report.voided.length) log(`作废明细: ${JSON.stringify(report.voided)}`);
    return report;
  } catch (e) {
    console.error(`[installment-cron] 扫描异常: ${e.message}`);
    return report;
  } finally {
    scanning = false;
  }
}

/**
 * 启动定时扫描（幂等：重复调用会先清理旧定时器，避免 nodemon 热重载重复注册）
 */
function start() {
  if (!ENABLED) {
    log("已通过 INSTALLMENT_SCAN_ENABLED=false 关闭");
    return null;
  }
  if (timer) clearInterval(timer);

  log(
    `已注册，首次扫描 ${Math.round(FIRST_DELAY_MS / 1000)}s 后执行，之后每 ${Math.round(
      SCAN_INTERVAL_MS / 60000
    )} 分钟一次${isDryRun() ? "（DRY-RUN 模式，不会写库）" : ""}`
  );

  setTimeout(() => {
    scanOnce().catch((e) => console.error(`[installment-cron] 首次扫描失败: ${e.message}`));
  }, FIRST_DELAY_MS).unref?.();

  timer = setInterval(() => {
    scanOnce().catch((e) => console.error(`[installment-cron] 定时扫描失败: ${e.message}`));
  }, SCAN_INTERVAL_MS);
  timer.unref?.();

  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, scanOnce };
