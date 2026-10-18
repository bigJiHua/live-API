const db = require("../../../common/config/db");
const idUtils = require("../../../common/utils/idUtils");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const CreditAccount = require("../../account/model/credit");
const CardBill = require("../../card/model/bill");
// 🔄 2026-10-13（api.md P1-6）：补偿撤销流水后需要重算账单
const CreditCore = require("../../card/core/CreditCore");
dayjs.extend(utc);
dayjs.extend(timezone);

// 分期「计划入账日」之后的宽限天数：plan_date ~ plan_date+N 天内可入账，超过即作废。
// 入账与作废判定均基于 plan_date，二者严格互补、不重叠。
// 默认 30 天≈一个账单周期：服务短暂停机后仍能补入账，只有整期错过才作废。
// 如需更严格（如只容忍 7 天）可设 INSTALLMENT_GRACE_DAYS=7。
const INSTALLMENT_GRACE_DAYS = Number(process.env.INSTALLMENT_GRACE_DAYS) || 30;

// 进程内互斥锁：按 `${分期id}:${月份}` 串行化入账动作，防止定时扫描与 HTTP 请求
// 并发时双双读到 pending 而重复建流水。仅在单实例部署下有效（多实例需改用 MySQL GET_LOCK）。
const ENTER_LOCKS = new Map();
async function withEnterLock(key, fn) {
  const prev = ENTER_LOCKS.get(key);
  if (prev) {
    try {
      await prev;
    } catch {
      /* 前一次失败不影响本次 */
    }
  }
  const task = (async () => fn())();
  ENTER_LOCKS.set(key, task);
  try {
    return await task;
  } finally {
    if (ENTER_LOCKS.get(key) === task) ENTER_LOCKS.delete(key);
  }
}

class RecurringExpense {
  static tableName = "bus_recurring";

  static today() {
    // 北京时间"今天"，避免 UTC 服务器下 toISOString 取错日
    return dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD");
  }

  static now() {
    return String(Date.now());
  }

  static parseMonthRecords(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  static normalizeMonth(month) {
    if (/^\d{4}-\d{2}$/.test(month || "")) return month;
    throw new Error("月份格式应为 YYYY-MM");
  }

  static daysInMonth(month) {
    const [year, monthNo] = month.split("-").map(Number);
    return new Date(year, monthNo, 0).getDate();
  }

  static getMonthDate(row, month) {
    const day = Math.max(1, Number(row.day_of_cycle || 1));
    const safeDay = Math.min(day, this.daysInMonth(month));
    return `${month}-${String(safeDay).padStart(2, "0")}`;
  }

  static getMonthRecord(row, month) {
    const records = this.parseMonthRecords(row.month_records);
    const record = records[month] || {};
    return {
      month,
      status: record.status || "pending",
      amount: record.amount !== undefined ? record.amount : row.amount,
      remind_time: record.remind_time || null,
      done_time: record.done_time || null,
      remark: record.remark || "",
    };
  }

  static attachMonthInfo(row, month) {
    const record = this.getMonthRecord(row, month);
    const happenDate = this.getMonthDate(row, month);
    return {
      ...row,
      amount: Number(row.amount || 0),
      month,
      happen_date: happenDate,
      month_status: record.effectiveStatus || record.status,
      month_overdue: !!record.overdue,
      month_amount: Number(record.amount || row.amount || 0),
      month_record: record,
      month_records: this.parseMonthRecords(row.month_records),
      is_done: (record.effectiveStatus || record.status) === "done",
      is_skipped: record.status === "skipped",
      is_due: happenDate <= this.today(),
    };
  }

  static toCalendarEvent(row, month) {
    // 分期：仅 repeat_count 范围内生成事件
    if (row.repeat_count) {
      const records = this.parseMonthRecords(row.month_records);
      const sortedMonths = Object.keys(records).sort();
      const idx = sortedMonths.indexOf(month);
      if (idx === -1 || idx >= row.repeat_count) return null;
    }

    const item = this.attachMonthInfo(row, month);
    // 已中止(void)的分期期次不再在日历体现
    if (item.month_status === "void") return null;
    const statusMap = { done: "已完成", skipped: "已取消", pending: "待完成", entered: "已入账", void: "已中止" };

    // 分期：追加第N/M期
    let content = item.name;
    if (row.repeat_count) {
      const records = this.parseMonthRecords(row.month_records);
      const sortedMonths = Object.keys(records).sort();
      const periodIdx = sortedMonths.indexOf(month);
      if (periodIdx >= 0) {
        content = `${item.name} 第${periodIdx + 1}/${row.repeat_count}期`;
      }
    }

    return {
      id: `recurring_${item.id}_${month}`,
      source: "recurring",
      recurring_id: item.id,
      content,
      event_type: "fixed_expense",
      happen_date: item.happen_date,
      status: statusMap[item.month_status] || "待完成",
      priority: 2,
      need_remind: 1,
      is_recurring: item.cycle === "year" ? 1 : 0,
      cycle: item.cycle || "month",
      amount: item.month_amount,
      category_id: item.category_id,
      category_name: item.category_name || "",
      remark: item.remark || "",
      month_status: item.month_status,
      month_overdue: item.month_overdue,
      is_fixed_expense: true,
    };
  }

  static async findAll(userId, { month, includeInactive = false, installmentOnly = false, excludeInstallment = false } = {}) {
    const params = [userId];
    let where = "WHERE r.user_id = ? AND r.is_deleted = 0";
    if (!includeInactive) {
      where += " AND r.is_active = 1";
    }
    if (installmentOnly) {
      where += " AND (c.name = '分期' OR r.account_id LIKE '%\"type\":\"installment\"%')";
    } else if (excludeInstallment) {
      where += " AND (c.name IS NULL OR (c.name != '分期' AND (r.account_id NOT LIKE '%\"type\":\"installment\"%' OR r.account_id IS NULL)))";
    }

    const [rows] = await db.execute(
      `SELECT r.*, c.name AS category_name, cb.alias AS account_name, cb.last4_no AS account_last4, cb.card_type
       FROM ${this.tableName} r
       LEFT JOIN bus_category c ON r.category_id = c.id AND c.is_deleted = 0
       LEFT JOIN card_base cb ON r.account_id = cb.id AND cb.is_deleted = 0
       ${where}
       ORDER BY r.is_active DESC, r.day_of_cycle ASC, r.create_time DESC`,
      params
    );

    // 按年周期过滤：只返回匹配月份的项
    let filtered = rows;
    if (month) {
      const safeMonth = this.normalizeMonth(month);
      const [, monthNum] = safeMonth.split("-").map(Number);
      filtered = rows.filter(row => {
        // 截止日期（end_date）判断：
        // 1) 真实已过期（截止日早于今天）→ 隐藏（覆盖所有周期类型）
        // 2) 被查看的月份已超过截止日期所在月份 → 隐藏
        //    （例如 end_date=2026-10-31，查看 2026-11 时不应再出现该事件）
        if (row.end_date) {
          if (row.end_date < this.today()) return false;
          const endMonth = row.end_date.substring(0, 7);
          if (endMonth < safeMonth) return false;
        }
        if (row.cycle === "year" && row.month_of_cycle) {
          return Number(row.month_of_cycle) === monthNum;
        }
        return true;
      });
    }

    if (!month) return filtered.map(row => ({ ...row, month_records: this.parseMonthRecords(row.month_records) }));
    return filtered.map(row => this.attachMonthInfo(row, month));
  }

  /**
   * 查询全量启用中的分期（跨用户，仅定时扫描 cron 使用）。
   * 命中口径与 findAll 的 installmentOnly 保持一致。
   */
  static async findActiveInstallments() {
    const [rows] = await db.execute(
      `SELECT r.* FROM ${this.tableName} r
       WHERE r.is_deleted = 0 AND r.is_active = 1
         AND r.repeat_count IS NOT NULL
         AND r.account_id LIKE '%"type":"installment"%'`
    );
    return rows.map((row) => ({
      ...row,
      month_records: this.parseMonthRecords(row.month_records),
    }));
  }

  static async findById(id, userId) {
    const [rows] = await db.execute(
      `SELECT r.*, c.name AS category_name, cb.alias AS account_name, cb.last4_no AS account_last4, cb.card_type
       FROM ${this.tableName} r
       LEFT JOIN bus_category c ON r.category_id = c.id AND c.is_deleted = 0
       LEFT JOIN card_base cb ON r.account_id = cb.id AND cb.is_deleted = 0
       WHERE r.id = ? AND r.user_id = ? AND r.is_deleted = 0`,
      [id, userId]
    );
    const row = rows[0];
    if (!row) return null;
    return { ...row, month_records: this.parseMonthRecords(row.month_records) };
  }

  static async create({ userId, name, amount, categoryId, accountId, cycle, dayOfCycle, monthOfCycle, remindDays, remark, isActive, endDate, repeatCount, notifyChannel, monthRecords }) {
    if (!name || !String(name).trim()) throw new Error("固定支出名称不能为空");
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount < 0) throw new Error("金额不能为负数");

    const finalCycle = cycle || "month";
    if (!["month", "year"].includes(finalCycle)) {
      throw new Error("周期仅支持 month / year");
    }
    if (finalCycle === "year" && (!monthOfCycle || Number(monthOfCycle) < 1 || Number(monthOfCycle) > 12)) {
      throw new Error("年度周期需指定 month_of_cycle (1-12)");
    }

    const day = Math.max(1, Math.min(31, Number(dayOfCycle || 1)));
    const monthVal = monthOfCycle ? Math.max(1, Math.min(12, Number(monthOfCycle))) : null;
    const id = idUtils.billId();
    const now = this.now();
    const nextDate = finalCycle === "year"
      ? this.getNextDateYear(day, monthVal)
      : this.getNextDate(day);

    const initialRecords = (monthRecords && typeof monthRecords === 'object') ? JSON.stringify(monthRecords) : "{}";

    await db.execute(
      `INSERT INTO ${this.tableName}
       (id, user_id, name, amount, category_id, account_id, cycle, day_of_cycle, month_of_cycle,
        next_date, remind_days, remark, month_records, end_date, repeat_count, notify_channel,
        is_active, create_time, update_time, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        id,
        userId,
        String(name).trim(),
        numAmount,
        categoryId || null,
        accountId || null,
        finalCycle,
        day,
        monthVal,
        nextDate,
        Number(remindDays || 0),
        remark || null,
        initialRecords,
        endDate || null,
        repeatCount ? Number(repeatCount) : null,
        notifyChannel || "app",
        isActive === false || isActive === 0 ? 0 : 1,
        now,
        now,
      ]
    );

    return this.findById(id, userId);
  }

  static getNextDate(dayOfCycle) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let date = this.getMonthDate({ day_of_cycle: dayOfCycle }, currentMonth);
    if (date < this.today()) {
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const nextMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
      date = this.getMonthDate({ day_of_cycle: dayOfCycle }, nextMonth);
    }
    return date;
  }

  static getNextDateYear(dayOfCycle, monthOfCycle) {
    const now = new Date();
    const year = now.getFullYear();
    const day = Math.max(1, Math.min(31, Number(dayOfCycle || 1)));
    const month = Number(monthOfCycle || 1);
    const thisYearDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (thisYearDate >= this.today()) {
      return thisYearDate;
    }
    return `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  static async update(id, userId, updates) {
    const existing = await this.findById(id, userId);
    if (!existing) throw new Error("固定支出不存在");

    const map = {
      name: "name",
      amount: "amount",
      categoryId: "category_id",
      accountId: "account_id",
      cycle: "cycle",
      dayOfCycle: "day_of_cycle",
      monthOfCycle: "month_of_cycle",
      remindDays: "remind_days",
      remark: "remark",
      isActive: "is_active",
      endDate: "end_date",
      repeatCount: "repeat_count",
      notifyChannel: "notify_channel",
    };

    if (updates.name !== undefined && !String(updates.name).trim()) {
      throw new Error("固定支出名称不能为空");
    }
    if (updates.amount !== undefined && Number(updates.amount) < 0) {
      throw new Error("金额不能为负数");
    }

    // 合并 cycle：优先用传入值，否则用现有值
    const resolvedCycle = updates.cycle !== undefined ? updates.cycle : existing.cycle;
    if (!["month", "year"].includes(resolvedCycle)) {
      throw new Error("周期仅支持 month / year");
    }

    const resolvedMonthOfCycle = updates.monthOfCycle !== undefined ? updates.monthOfCycle : existing.month_of_cycle;
    if (resolvedCycle === "year" && (!resolvedMonthOfCycle || Number(resolvedMonthOfCycle) < 1 || Number(resolvedMonthOfCycle) > 12)) {
      throw new Error("年度周期需指定 month_of_cycle (1-12)");
    }

    const fields = [];
    const params = [];
    Object.entries(map).forEach(([key, column]) => {
      if (updates[key] !== undefined) {
        fields.push(`${column} = ?`);
        if (key === "dayOfCycle") {
          params.push(Math.max(1, Math.min(31, Number(updates[key] || 1))));
        } else if (key === "monthOfCycle") {
          params.push(Math.max(1, Math.min(12, Number(updates[key] || 1))));
        } else if (key === "remindDays") {
          params.push(Number(updates[key] || 0));
        } else if (key === "repeatCount") {
          params.push(updates[key] ? Number(updates[key]) : null);
        } else if (key === "isActive") {
          params.push(updates[key] ? 1 : 0);
        } else if (key === "categoryId" || key === "accountId" || key === "endDate" || key === "notifyChannel") {
          params.push(updates[key] || null);
        } else {
          params.push(updates[key]);
        }
      }
    });

    // 当 day_of_cycle 或 month_of_cycle 或 cycle 变更时，重算 next_date
    if (updates.dayOfCycle !== undefined || updates.monthOfCycle !== undefined || updates.cycle !== undefined) {
      const dayVal = updates.dayOfCycle !== undefined ? Math.max(1, Math.min(31, Number(updates.dayOfCycle || 1))) : Number(existing.day_of_cycle || 1);
      const monthVal = updates.monthOfCycle !== undefined
        ? Math.max(1, Math.min(12, Number(updates.monthOfCycle || 1)))
        : Number(existing.month_of_cycle || 0);
      if (resolvedCycle === "year") {
        fields.push("next_date = ?");
        params.push(this.getNextDateYear(dayVal, monthVal || undefined));
      } else {
        fields.push("next_date = ?");
        params.push(this.getNextDate(dayVal));
      }
    }

    if (fields.length === 0) return existing;
    fields.push("update_time = ?");
    params.push(this.now(), id, userId);

    await db.execute(
      `UPDATE ${this.tableName} SET ${fields.join(", ")} WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      params
    );

    return this.findById(id, userId);
  }

  static async delete(id, userId) {
    const [result] = await db.execute(
      `UPDATE ${this.tableName} SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?`,
      [this.now(), id, userId]
    );
    return result.affectedRows > 0;
  }

  static async updateMonthStatus(id, userId, { month, status, amount, remark }) {
    const safeMonth = this.normalizeMonth(month);
    if (!["pending", "done", "skipped"].includes(status)) {
      throw new Error("状态只能是 pending/done/skipped");
    }

    const existing = await this.findById(id, userId);
    if (!existing) throw new Error("固定支出不存在");

    // 分期限定：只能操作 month_records 中已有月份，防止超范围插入
    if (existing.repeat_count) {
      const existingRecords = this.parseMonthRecords(existing.month_records);
      const validMonths = Object.keys(existingRecords);
      if (!validMonths.includes(safeMonth)) {
        throw new Error(`分期仅限已登记月份操作，${safeMonth} 不在范围内`);
      }
      // 分期三态护栏：已入账(entered)/已中止(void) 的期次不可经此入口随意改写，
      // 避免与已建消费流水矛盾、破坏防重复入账。已入账请去账单手动冲正。
      const cur = existingRecords[safeMonth] || {};
      if (cur.status === "entered") {
        throw new Error("该期已入账，不可直接标记，请去账单手动冲正");
      }
      if (cur.status === "void") {
        throw new Error("该期已中止，不可再修改");
      }
    }

    const records = this.parseMonthRecords(existing.month_records);
    const current = records[safeMonth] || {};
    records[safeMonth] = {
      ...current,
      status,
      amount: amount !== undefined ? amount : (current.amount !== undefined ? current.amount : existing.amount),
      remark: remark !== undefined ? remark : (current.remark || ""),
      remind_time: current.remind_time || null,
      done_time: status === "done" ? this.now() : null,
    };

    // 检查是否已满 repeat_count（分期完成）
    let shouldDeactivate = false;
    if (status === "done" && existing.repeat_count) {
      const doneCount = Object.values(records).filter(r => r.status === "done").length;
      if (doneCount >= Number(existing.repeat_count)) {
        shouldDeactivate = true;
      }
    }

    await db.execute(
      `UPDATE ${this.tableName} SET month_records = ?, is_active = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      [JSON.stringify(records), shouldDeactivate ? 0 : (existing.is_active || 1), this.now(), id, userId]
    );

    const row = await this.findById(id, userId);
    const result = this.attachMonthInfo(row, safeMonth);
    result.auto_deactivated = shouldDeactivate;
    return result;
  }

  static async getMonthSummary(userId, month) {
    const rows = await this.findAll(userId, { month, includeInactive: false });
    const active = rows.filter(item => !item.is_skipped);
    const done = active.filter(item => item.is_done);
    const totalAmount = active.reduce((sum, item) => sum + Number(item.month_amount || 0), 0);
    const doneAmount = done.reduce((sum, item) => sum + Number(item.month_amount || 0), 0);
    return {
      month,
      total: active.length,
      done: done.length,
      pending: active.length - done.length,
      totalAmount,
      doneAmount,
      pendingAmount: totalAmount - doneAmount,
      categoryStats: this.getCategoryStats(active),
    };
  }

  static getCategoryStats(rows) {
    const map = new Map();
    rows.forEach(item => {
      const amountVal = Number(item.month_amount || 0);
      const isEvent = !item.category_id && amountVal === 0;
      const key = isEvent ? "event_reminder" : (item.category_id || "uncategorized");
      const current = map.get(key) || {
        category_id: isEvent ? "" : (item.category_id || ""),
        category_name: isEvent ? "事件提醒" : (item.category_name || "未分类"),
        amount: 0,
        count: 0,
      };
      current.amount += amountVal;
      current.count += 1;
      map.set(key, current);
    });
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
  }

  // 批量装饰分期行：超过期限即时作废(写库) + 把 effectiveStatus / overdue 写回 month_records，供日历/提醒/汇总读取
  static async decorateRowsForCalendar(rows) {
    await Promise.all(
      rows.map(async (row) => {
        const acc = this.parseAccountInfo(row.account_id);
        if (acc?.type !== "installment") return;
        try {
          // 读取即写库：把已过期且未入账的期次标记为 void（任何 GET 都能即时看到灰态）
          await this.voidExpiredInstallments(row);
          const decorated = await this.decorateInstallmentStatus(row);
          row.month_records = JSON.stringify(decorated);
        } catch {
          /* 装饰失败不影响日历主流程 */
        }
      })
    );
  }

  static async getCalendarEvents(userId, year, monthNo) {
    const month = `${year}-${String(monthNo).padStart(2, "0")}`;
    const rows = await this.findAll(userId, { month, includeInactive: false });
    await this.decorateRowsForCalendar(rows);
    return rows.map((row) => this.toCalendarEvent(row, month)).filter(Boolean);
  }

  static async getUpcomingReminders(userId, scope = "default") {
    const bjToday = dayjs().tz("Asia/Shanghai");
    const fromDays = scope === "all" ? 0 : 3;
    const toDays = scope === "all" ? 30 : 10;
    const start = bjToday.add(fromDays, "day").format("YYYY-MM-DD");
    const end = bjToday.add(toDays, "day").format("YYYY-MM-DD");
    const months = new Set([start.substring(0, 7), end.substring(0, 7)]);
    const result = [];

    for (const month of months) {
      const rows = await this.findAll(userId, { month, includeInactive: false });
      await this.decorateRowsForCalendar(rows);
      rows.forEach(row => {
        const event = this.toCalendarEvent(row, month);
        if (!event) return;
        if (event.happen_date >= start && event.happen_date <= end && event.month_status !== "done" && event.month_status !== "skipped") {
          result.push(event);
        }
      });
    }

    return result.sort((a, b) => a.happen_date.localeCompare(b.happen_date));
  }

  /**
   * 【日历提醒专用】获取当前自然月的固定支出/事件提醒（V2）。
   * ⚠️ 不复用 getUpcomingReminders 的 30 天滚动窗口——它会跨月把下个月的
   *    recurring 数据也带进当前月（例：8月视图出现 9月的固定支出）。
   * 本函数只返回「发生日期落在当前自然月」且未完成/未跳过的记录。
   * @param {string} userId
   * @param {object} opts { month? }  默认当前自然月
   * @returns {Promise<Array>}
   */
  static async getUpcomingRemindersCurrentMonth(userId, opts = {}) {
    const month = opts.month || dayjs().tz('Asia/Shanghai').format('YYYY-MM');
    const rows = await this.findAll(userId, { month, includeInactive: false });
    await this.decorateRowsForCalendar(rows);
    const result = [];
    rows.forEach((row) => {
      const event = this.toCalendarEvent(row, month);
      if (!event) return;
      if (event.happen_date >= `${month}-01` && event.happen_date <= `${month}-31`) {
        if (event.month_status !== "done" && event.month_status !== "skipped") {
          result.push(event);
        }
      }
    });
    return result.sort((a, b) => a.happen_date.localeCompare(b.happen_date));
  }

  static parseAccountInfo(raw) {
    try {
      return JSON.parse(raw || "{}") || {};
    } catch {
      return {};
    }
  }

  static async updateMonthRecords(id, userId, records) {
    await db.execute(
      `UPDATE ${this.tableName} SET month_records = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0`,
      [JSON.stringify(records), this.now(), id, userId]
    );
  }

  /**
   * 分期入账：触发月份直接入账（仅未入账 pending 期可入）。
   * 加强判断：当前系统日期必须落在目标月份的账单周期内
   * （账单日 billingDay ~ 下月 billingDay），否则拒绝。
   * 复用 CreditAccount.create 创建真实消费流水（不动 CreditCore），
   * 将返回的流水 ID 写回 month_records[month].remark，status='entered'。
   */
  /**
   * 解析某一期的「计划入账日」plan_date（dayjs，北京时区，已 startOf('day')）：
   *  - 新数据：取 month_records[month].plan_date，由前端按「首期入账日期 + 入账归属」推算写入。
   *    用户可选「本月账单 / 次月账单」（不同银行口径不同，如浦发本月入账、工行次月入账），
   *    创建后每期固定在该月「账单日前 2 天」入账。
   *  - 存量数据：无 plan_date 时回退旧算法「该期月份 账单日+1」，
   *    保证历史分期的账单归属（次月账单）与时机判定完全不变。
   */
  static resolvePlanDate(row, month, records = null) {
    const recs = records || this.parseMonthRecords(row.month_records);
    const rec = recs?.[month];
    if (rec?.plan_date) {
      return dayjs.tz(rec.plan_date, "Asia/Shanghai").startOf("day");
    }
    const acc = this.parseAccountInfo(row.account_id);
    const billingDay = Number(acc.billing_day) || 1;
    const targetMonth = dayjs.tz(`${month}-01`, "Asia/Shanghai").startOf("month");
    return targetMonth.date(Math.min(billingDay + 1, targetMonth.daysInMonth())).startOf("day");
  }

  /**
   * 是否到达该期入账时机：plan_date <= 今天 <= plan_date + 宽限天数。
   * 与 isEnterExpired 严格互补，二者不会同时对同一期为真。
   */
  static canEnterNow(row, month, records = null) {
    const planDate = this.resolvePlanDate(row, month, records);
    const today = dayjs().tz("Asia/Shanghai").startOf("day");
    return !today.isBefore(planDate) && !today.isAfter(planDate.add(INSTALLMENT_GRACE_DAYS, "day"));
  }

  /**
   * 该期是否已超期（超过 plan_date + 宽限天数仍未入账）→ 应自动作废。
   */
  static isEnterExpired(row, month, records = null) {
    const planDate = this.resolvePlanDate(row, month, records);
    const today = dayjs().tz("Asia/Shanghai").startOf("day");
    return today.isAfter(planDate.add(INSTALLMENT_GRACE_DAYS, "day"));
  }

  /**
   * 该期入账流水归属的账单月。复用 CardBill 的周期规则（不自行推导、不碰 CreditCore）：
   * 消费日 <= 账单日 → 当月账单；> 账单日 → 次月账单。
   */
  static resolveBillMonth(row, month, records = null) {
    const acc = this.parseAccountInfo(row.account_id);
    const billingDay = Number(acc.billing_day) || 1;
    const pd = this.resolvePlanDate(row, month, records);
    return CardBill.getBillMonthByDate(new Date(pd.year(), pd.month(), pd.date()), billingDay);
  }

  /**
   * 分期入账（对外入口）：加进程内互斥锁后执行，避免定时扫描与 HTTP 请求并发重复建流水。
   */
  static async enterInstallment(id, month, userId) {
    return withEnterLock(`${id}:${month}`, () => this.enterInstallmentUnsafe(id, month, userId));
  }

  static async enterInstallmentUnsafe(id, month, userId) {
    const row = await this.findById(id, userId);
    if (!row) throw new Error("分期不存在");
    const records = this.parseMonthRecords(row.month_records);
    const m = records[month];
    if (!m) throw new Error("该期不存在");
    // 幂等：已入账（remark 已有流水 ID）直接返回，避免重复建流水
    if (m.status === "entered" && m.remark) {
      return { flowId: m.remark, month, idx: 0, transDate: "", skipped: true };
    }
    // 自愈：旧代码占坑态 entering（remark 为空、无真实流水）视为未入账，复位后重入。
    // 账单侧已确认无任何对应流水时，直接重新建流，避免永久卡死。
    if (m.status === "entering" && !m.remark) {
      console.warn(`[installment] 自愈 entering->pending id=${id} month=${month}`);
      const heal = this.parseMonthRecords(row.month_records);
      heal[month] = { ...heal[month], status: "pending", remark: "" };
      await this.updateMonthRecords(id, userId, heal);
      m.status = "pending";
    }
    if (m.status !== "pending") {
      throw new Error(m.status === "void" ? "该期已中止" : "该期已入账或已处理");
    }
    const acc = this.parseAccountInfo(row.account_id);
    const billingDay = Number(acc.billing_day) || 1;
    const totalPeriods = Number(acc.total_periods) || Number(row.repeat_count) || 1;

    // 入账时机校验：必须已到达该期的计划入账日（账单日前 2 天），且未超宽限期
    const planDate = this.resolvePlanDate(row, month, records);
    const today = dayjs().tz("Asia/Shanghai").startOf("day");
    if (today.isBefore(planDate)) {
      throw new Error(
        `该期计划入账日为 ${planDate.format("YYYY-MM-DD")}（账单日前 2 天），尚未到达，暂不入账`
      );
    }
    if (this.isEnterExpired(row, month, records)) {
      throw new Error(
        `该期计划入账日 ${planDate.format("YYYY-MM-DD")} 已超过 ${INSTALLMENT_GRACE_DAYS} 天仍未入账，请确认或中止`
      );
    }

    // 第几期（按月份升序）
    const sortedMonths = Object.keys(this.parseMonthRecords(row.month_records)).sort();
    const idx = sortedMonths.indexOf(month) + 1;
    // 流水交易日期 = 计划入账日，账单归属由 CardBill.getBillMonthByDate 决定
    const transDate = planDate.format("YYYY-MM-DD");

    // 复用信用卡消费入账内部方法（事务 + 锁卡 + 额度校验 + CreditCore.syncCardBills），不改动 CreditCore
    // 🔄 2026-10-13 修复（api.md P1-6）：占坑 + 补偿，保证"建流水"与"改期次状态"最终一致。
    //   原实现：CreditAccount.create（独立事务已提交）→ updateMonthRecords（另一连接），
    //   两步非原子 —— 中间失败/进程崩溃后 month_records 仍是 pending，重试会重复建流水。
    //   现实现：
    //     ① 先置 entering（无流水ID占坑）—— 若 create 前任何一步失败，
    //        上方自愈逻辑（entering 且 remark 为空 → 复位 pending）允许重试；
    //     ② create 成功后写 entered + flowId —— 若这一步失败，
    //        补偿软删刚提交的流水并重算账单，再抛错（month_records 与账本一致，可安全重试）。
    const occupying = this.parseMonthRecords(row.month_records);
    occupying[month] = { ...occupating[month], status: "entering", remark: "" };
    await this.updateMonthRecords(id, userId, occupying);

    const flow = await CreditAccount.create({
      userId,
      direction: 0,
      categoryId: "installment",
      amount: Number(m.amount),
      transDate,
      remark: `${acc.card_name || row.name}分期 第${idx}/${totalPeriods}期消费入账`,
      cardId: acc.card_id,
      payType: "installment",
      payMethod: "installment",
      currency: "CNY",
      exchangeRate: 1,
    });

    const flowId = flow?.id || flow?.data?.id;
    if (!flowId) throw new Error("入账流水创建失败");

    // 成功后写回流水 ID + entered（不再用占坑 entering，避免中间态泄漏）
    const updated = this.parseMonthRecords(row.month_records);
    updated[month] = {
      ...updated[month],
      status: "entered",
      remark: String(flowId),
      plan_date: transDate,
      bill_month: this.resolveBillMonth(row, month, updated),
      entered_at: dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss"),
      done_time: dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss"),
    };
    try {
      await this.updateMonthRecords(id, userId, updated);
    } catch (e) {
      // 补偿：流水已提交但期次状态没写上 → 软删流水 + 重算账单，
      // 保证 month_records 与账本一致（该期回到 entering 无 remark 态，自愈后可重试，不会重复入账）
      console.error(`[installment] 期次状态写入失败，撤销本次入账 id=${id} month=${month} flow=${flowId}:`, e);
      try {
        await db.execute(
          "UPDATE account SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?",
          [String(Date.now()), flowId, userId]
        );
        await CreditCore.syncCardBills(acc.card_id, userId);
      } catch (compErr) {
        // 补偿自身失败：留下 entering 占坑 + 已提交流水，需人工对账（绝不静默）
        console.error(`[installment] 补偿失败，需人工对账 id=${id} month=${month} flow=${flowId}:`, compErr);
        throw new Error(`入账状态更新失败且补偿失败，请人工对账（流水 ${flowId}）`);
      }
      throw new Error(`入账状态更新失败，已撤销本次流水（${flowId}），请重试`);
    }

    return { flowId, month, idx, transDate };
  }

  /**
   * 分期中止：仅未入账(pending)的期次可中止，标记 void + done_time；
   * 已入账/已中止的期次跳过并说明原因（已入账需用户去账单手动冲正）。
   */
  static async abortInstallment(id, months, userId) {
    const row = await this.findById(id, userId);
    if (!row) throw new Error("分期不存在");
    const records = this.parseMonthRecords(row.month_records);
    const aborted = [];
    const skipped = [];
    (months || []).forEach((month) => {
      const m = records[month];
      if (!m) {
        skipped.push({ month, reason: "不存在" });
        return;
      }
      if (m.status === "pending" || m.status === "entering") {
        records[month] = {
          ...m,
          status: "void",
          remark: m.remark || "",
          done_time: dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss"),
        };
        aborted.push(month);
      } else {
        skipped.push({
          month,
          reason: m.status === "void" ? "已中止" : "已入账/已处理，请去账单手动冲正",
        });
      }
    });
    if (aborted.length) await this.updateMonthRecords(id, userId, records);
    // 全部期次都不再是待入账(pending/entering) → 整个分期视为已结束/失效：
    // 置 is_active=0（卡片整体灰色、不再触发日历/自动入账），并在 remark 标注。
    let finished = false;
    const remaining = Object.values(records).filter(
      (r) => r.status === "pending" || r.status === "entering"
    );
    if (aborted.length && remaining.length === 0) {
      const [rows] = await db.execute(
        `SELECT remark FROM ${this.tableName} WHERE id = ? AND user_id = ? AND is_deleted = 0 LIMIT 1`,
        [id, userId]
      );
      const oldRemark = rows[0]?.remark || "";
      const finishedRemark = oldRemark.includes("已全部中止")
        ? oldRemark
        : `${oldRemark}｜已全部中止，分期结束`.trim();
      await db.execute(
        `UPDATE ${this.tableName} SET is_active = 0, remark = ?, update_time = ? WHERE id = ? AND user_id = ? AND is_deleted = 0`,
        [finishedRemark, this.now(), id, userId]
      );
      finished = true;
    }
    return { aborted, skipped, finished };
  }

  /**
   * 超过期限自动作废：对仍处于 pending / entering(无流水)，且已过「计划入账日 + 宽限天数」
   * 仍未入账的期次，标记 void（remark="超过期限，自动作废"）。
   * 由定时扫描与日历/提醒读取触发写库，保证能看到「超过期限」灰态。
   */
  static async voidExpiredInstallments(row) {
    if (!row || !row.repeat_count) return false;
    const records = this.parseMonthRecords(row.month_records);
    let mutated = false;
    for (const month of Object.keys(records)) {
      const rec = records[month];
      const s = rec.status;
      if (s !== "pending" && !(s === "entering" && !rec.remark)) continue;
      // 超期判定与入账时机判定同源（都基于 plan_date）：
      //   未到 plan_date      → 等待
      //   plan_date ~ +宽限   → 可入账
      //   超过 plan_date+宽限 → 作废
      if (this.isEnterExpired(row, month, records)) {
        records[month] = {
          ...rec,
          status: "void",
          remark: "超过期限，自动作废",
          done_time: dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss"),
        };
        mutated = true;
        console.warn(`[installment] 超过期限自动作废 id=${row.id} month=${month}`);
      }
    }
    // 修正：此前误传 (row.user_id, row.user_id)，SQL 条件变成 id = user_id，
    // 不命中任何行且静默无报错 → 自动作废写库从未生效。
    if (mutated) await this.updateMonthRecords(row.id, row.user_id, records);
    return mutated;
  }

  /**
   * 系统自动入账：对已到达计划入账日且尚未入账(pending)的期次，自动触发入账。
   * 由定时扫描与列表读取时调用，替代前端手动「入账」按钮。
   * 设计原则：
   *  - 仅 installment（repeat_count 存在）且 status='pending' 且 canEnterNow 为真时触发；
   *  - 复用 enterInstallment（entered+remark 幂等防重复，entering 占坑态自愈重入），不改动 CreditCore；
   *  - 单期失败不影响整体（仅告警），保证列表/日历读取始终可用；
   *  - 已 entered/void 的期次会被 enterInstallment 自身拒绝，安全跳过。
   */
  static async autoEnterPending(id, userId) {
    const row = await this.findById(id, userId);
    if (!row || !row.repeat_count) return;
    const records = this.parseMonthRecords(row.month_records);
    // 纳入 pending + entering(无流水占坑，需自愈重入) 的期次
    const pendingMonths = Object.keys(records).filter((k) => {
      const s = records[k].status;
      return s === "pending" || (s === "entering" && !records[k].remark);
    });
    if (!pendingMonths.length) return;
    // entering 自愈：无流水占坑 → 复位 pending。必须【先落库】再入账，
    // 否则入账成功后末尾再用内存旧 records 覆盖，会把 remark(流水ID) 抹掉，破坏防重复入账。
    let mutated = false;
    for (const month of pendingMonths) {
      const rec = records[month];
      if (rec.status === "entering" && !rec.remark) {
        records[month] = { ...rec, status: "pending", remark: "" };
        mutated = true;
      }
    }
    if (mutated) await this.updateMonthRecords(id, userId, records);

    for (const month of pendingMonths) {
      const rec = records[month];
      if (rec.status !== "pending") continue;
      if (!this.canEnterNow(row, month, records)) continue; // 未到计划入账日（含未来期）→ 跳过；已超期 → 由 voidExpiredInstallments 作废
      // 已到达计划入账日 → 自动入账
      try {
        await this.enterInstallment(id, month, userId);
      } catch (e) {
        console.warn(`[installment] 自动入账失败 id=${id} month=${month}:`, e.message);
      }
    }
  }

  /**
   * 计算分期各期“有效状态”：entered 期若所属账单周期已还清(need_repay<=0)
   * 则视为已还(done)。只读 card_bill，不写库、不改动 CreditCore。
   * 返回新的 month_records（新增 effectiveStatus 字段）。
   */
  static async decorateInstallmentStatus(row) {
    const records = this.parseMonthRecords(row.month_records);
    const acc = this.parseAccountInfo(row.account_id);
    const cardId = acc.card_id;
    // 补齐每期的计划入账日与归属账单月（存量数据用回退算法补齐）。
    // 仅用于接口展示，不写库。
    Object.keys(records).forEach((month) => {
      const rec = records[month] || {};
      if (!rec.plan_date) {
        rec.plan_date = this.resolvePlanDate(row, month, records).format("YYYY-MM-DD");
      }
      if (!rec.bill_month) {
        rec.bill_month = this.resolveBillMonth(row, month, records);
      }
      records[month] = rec;
    });
    if (!cardId) return records;
    const enteredMonths = Object.keys(records).filter((k) => records[k].status === "entered");
    if (!enteredMonths.length) return records;
    // 账单归属由「计划入账日」经 CardBill 周期规则推导（不自行 +1 个月）：
    //  - 本月入账（浦发口径）：plan_date <= 账单日 → 归属当月账单
    //  - 次月入账（工行口径）：plan_date >  账单日 → 归属次月账单
    //  - 存量分期无 plan_date 时回退为「该期月份 账单日+1」→ 仍归属次月账单，行为不变
    const billMonths = new Set();
    const monthToBillMonth = {};
    enteredMonths.forEach((month) => {
      const billMonth = this.resolveBillMonth(row, month, records);
      monthToBillMonth[month] = billMonth;
      billMonths.add(billMonth);
    });
    const [billRows] = await db.execute(
      `SELECT bill_month, need_repay, is_overdue FROM card_bill WHERE card_id = ? AND user_id = ? AND bill_month IN (?) AND is_deleted = 0`,
      [cardId, row.user_id, [...billMonths]]
    );
    const billMap = {};
    (billRows || []).forEach((b) => {
      billMap[b.bill_month] = {
        needRepay: parseFloat(b.need_repay),
        isOverdue: b.is_overdue === 1 || b.is_overdue === "1" || b.is_overdue === true,
      };
    });
    enteredMonths.forEach((month) => {
      const billMonth = monthToBillMonth[month];
      const b = billMap[billMonth];
      const nr = b?.needRepay;
      const overdue = !!b?.isOverdue;
      records[month].effectiveStatus = nr !== undefined && nr <= 0.01 ? "done" : "entered";
      // 逾期：已入账且归属账单处于逾期状态（前端据此显示红色"逾期"）
      records[month].overdue = records[month].effectiveStatus === "entered" && overdue;
    });
    return records;
  }
}

module.exports = RecurringExpense;
