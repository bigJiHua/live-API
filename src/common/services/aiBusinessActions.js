const crypto = require('crypto');
const Joi = require('joi');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const Fund = require('../../modules/fund/model');
const { AiError } = require('../../modules/ai/service/errors');
const { toScaledInteger, scaledToString } = require('../utils/decimal');
dayjs.extend(utc);
dayjs.extend(timezone);

// This registry is the only way an AI proposal reaches a business write. Field
// names, table names and SQL operations never come from the provider response.
const text = max => Joi.string().trim().max(max);
const targetId = text(50);
const date = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value : helpers.error('any.invalid');
});
const positiveMoney = Joi.string().pattern(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/)
  .custom((value, helpers) => toScaledInteger(value, 2) > 0n ? value : helpers.error('any.invalid'));
// v3Prompt asks for explicitly signed daily returns; "+12.5000" is a literal
// quote from the user's utterance and must survive the same evidence path as
// negative amounts. decimal.js / v3Evidence canonical() already accept "+".
const returnAmount = Joi.string().pattern(/^[+-]?(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/);
const todoFields = {
  content: text(255), eventType: Joi.string().valid('schedule', 'birthday', 'anniversary', 'countdown'),
  happenDate: date, priority: Joi.number().integer().min(1).max(3), needRemind: Joi.boolean(),
  remindDays: Joi.number().integer().min(0).max(365), isRecurring: Joi.boolean(), remark: text(50).allow(''),
};
const definitions = Object.freeze({
  'budget.create': { fields: { title: text(50), route: text(50).allow(''), budgetType: Joi.string().valid('吃', '买', '行'),
    budgetAmount: positiveMoney, cycle: Joi.string().valid('月', '季', '年'), planDate: date, notes: text(2000).allow('') },
    required: ['title', 'budgetType', 'budgetAmount', 'cycle', 'planDate'] },
  'todo.create': { fields: todoFields, required: ['content', 'eventType', 'happenDate'] },
  'todo.update': { fields: { targetId, ...todoFields }, required: ['targetId'], target: 'todo' },
  'todo.complete': { fields: { targetId, status: Joi.string().valid('待完成', '已完成') }, required: ['targetId', 'status'], target: 'todo' },
  'todo.delete': { fields: { targetId }, required: ['targetId'], target: 'todo' },
  'diary.create': { fields: { content: text(20000), mood: Joi.string().valid('开心', '平静', '难过', '累', '兴奋', '郁闷'), date },
    required: ['content', 'mood', 'date'] },
  'card.metadata': { fields: { targetId, alias: text(30).allow(''), status: Joi.string().valid('正常', '挂失', '注销') },
    required: ['targetId'], target: 'card' },
  // Creating an asset initializes depreciation in the original form. AI can
  // prefill it, but cannot initialize or recalculate financial asset fields.
  'fixedAsset.create': { fields: { info: text(255), tag: text(50), buyPrice: positiveMoney,
    useYears: Joi.number().positive().max(100), residualRate: Joi.number().min(0).max(100), buyDate: date },
    required: ['info', 'tag', 'buyPrice', 'useYears', 'residualRate', 'buyDate'], unavailable: '请在固定资产页面补齐图片并核对；资产初始化和折旧计算不通过 AI 执行' },
  'fixedAsset.update': { fields: { targetId, info: text(255), tag: text(50) }, required: ['targetId'], target: 'asset' },
  'fixedAsset.delete': { fields: { targetId }, required: ['targetId'], target: 'asset' },
  'fixedAsset.restore': { fields: { targetId }, required: ['targetId'], target: 'asset' },
  'fixedAsset.permanentDelete': { fields: { targetId }, required: ['targetId'], target: 'asset' },
  'fund.returnBatch': { fields: { fundId: targetId, entries: Joi.array().min(1).max(31).items(Joi.object({
    date: date.required(), amount: returnAmount.required(),
  }).unknown(false)) }, required: ['fundId', 'entries'], target: 'fund' },
  'system.backup': { fields: {}, required: [], target: 'admin' },
});

function fail(message, code = 'AI_PROPOSAL_INVALID', status = 400) { throw new AiError(message, status, code); }
function shanghaiDate(now) { return dayjs(now).tz('Asia/Shanghai').format('YYYY-MM-DD'); }
function normalizeBusinessFields(kind, input, { now = Date.now() } = {}) {
  if (!Object.hasOwn(definitions, kind)) fail('该业务没有向 AI 开放', 'AI_ACTION_NOT_ALLOWED', 403);
  const definition = definitions[kind];
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('业务提案字段格式不正确');
  const cleaned = { ...input };
  // Null/blank required fields represent an incomplete editable proposal; an
  // unknown key still fails validation even if its value is blank.
  for (const key of Object.keys(cleaned)) {
    if (!Object.hasOwn(definition.fields, key)) fail('提案包含未开放的字段', 'AI_ACTION_NOT_ALLOWED', 403);
    if (cleaned[key] == null || (typeof cleaned[key] === 'string' && !cleaned[key].trim() && definition.required.includes(key))) delete cleaned[key];
  }
  if (kind === 'diary.create') {
    if (!cleaned.date || cleaned.date === '今天') cleaned.date = shanghaiDate(now);
  }
  const { error, value } = Joi.object(definition.fields).unknown(false).validate(cleaned, { abortEarly: false, convert: false });
  if (error) fail('提案字段或精度不符合业务要求');
  if (kind === 'todo.create') Object.assign(value, {
    priority: value.priority ?? 2, needRemind: value.needRemind ?? false,
    remindDays: value.remindDays ?? 0, isRecurring: value.isRecurring ?? false,
  });
  if (value.isRecurring && value.eventType && !['birthday', 'anniversary'].includes(value.eventType)) fail('只有生日和纪念日可以每年重复');
  if (kind === 'diary.create' && value.date !== shanghaiDate(now)) fail('日记只能追加到当天');
  if (kind === 'fund.returnBatch' && value.entries) {
    const dates = value.entries.map(entry => entry.date);
    if (new Set(dates).size !== dates.length) fail('收益批次包含重复日期');
    if (dates.some(item => item > shanghaiDate(now))) fail('不能录入未来收益');
    value.entries.sort((a, b) => a.date.localeCompare(b.date));
  }
  const missingFields = definition.required.filter(key => value[key] === undefined);
  if (['todo.update', 'card.metadata', 'fixedAsset.update'].includes(kind) && !Object.keys(value).some(key => key !== 'targetId')) missingFields.push('changes');
  return { fields: value, missingFields, ...(definition.unavailable ? { actionUnavailable: true, actionReason: definition.unavailable } : {}) };
}

const TARGETS = Object.freeze({
  todo: { table: 'todo', columns: 'id, content, event_type, happen_date, status, priority, need_remind, remind_time, is_recurring, remark, update_time, is_deleted', label: 'content' },
  card: { table: 'card_base', columns: 'id, alias, card_type, status, update_time, is_deleted', label: 'alias' },
  asset: { table: 'fixed_asset', columns: 'id, info, tag, status, buy_price, now_val, total_deprec, last_deprec_date, is_deleted', label: 'info' },
  fund: { table: 'fund', columns: 'id, fund_name, invest, net_value, market_val, rate, last_report_date, is_deleted', label: 'fund_name' },
});
function snapshotOf(row, label, type) {
  // Show the old editable metadata so people can assess the proposed change.
  // Financial dependency fields contribute to the revision but stay hidden.
  const revision = crypto.createHash('sha256').update(JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]]))).digest('hex');
  const metadata = type === 'card' ? { alias: row.alias || '',status: row.status || '' }
    : type === 'todo' ? { content: row.content || '',happenDate: row.happen_date || null,status: row.status || '' }
    : type === 'asset' ? { info: row.info || '',tag: row.tag || '',isDeleted: Boolean(Number(row.is_deleted)),status: row.status || '' } : {};
  return { id: row.id,type: type === 'asset' ? 'fixedAsset' : type,label: row[label] || '',...metadata,revision };
}
async function loadTarget(conn, userId, kind, fields, lock = false) {
  const type = definitions[kind].target;
  if (!type) return { row: null, targetSnapshot: null };
  if (type === 'admin') {
    const [rows] = await conn.execute(`SELECT id, identity FROM user_info WHERE id=? AND is_deleted=0${lock ? ' FOR UPDATE' : ''}`, [userId]);
    if (rows.length !== 1 || rows[0].identity !== 'admin') fail('只有管理员可以执行系统备份', 'AI_ACTION_FORBIDDEN', 403);
    return { row: rows[0], targetSnapshot: snapshotOf(rows[0], 'identity', 'admin') };
  }
  const id = fields[type === 'fund' ? 'fundId' : 'targetId'];
  if (!id) return { row: null, targetSnapshot: null };
  const target = TARGETS[type];
  const [rows] = await conn.execute(`SELECT ${target.columns} FROM ${target.table} WHERE id=? AND user_id=?${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
  if (rows.length !== 1) fail('目标不存在或不属于当前用户', 'AI_TARGET_NOT_FOUND', 404);
  const row = rows[0];
  const deleted = Number(row.is_deleted) === 1;
  if ((kind === 'fixedAsset.restore' || kind === 'fixedAsset.permanentDelete') ? !deleted : deleted) fail('目标状态已变化，请重新选择', 'AI_TARGET_CONFLICT', 409);
  if (type === 'card' && (['xxxx', 'yyyy'].includes(id) || /^virtual_/.test(row.card_type || ''))) fail('系统虚拟账户不开放修改', 'AI_ACTION_FORBIDDEN', 403);
  return { row, targetSnapshot: snapshotOf(row, target.label, type) };
}
async function lockUser(conn, userId) {
  const [rows] = await conn.execute('SELECT id FROM user_info WHERE id=? AND is_deleted=0 FOR UPDATE', [userId]);
  if (rows.length !== 1) fail('用户不存在', 'AI_ACTION_FORBIDDEN', 403);
}
async function assertTodoCapacity(conn, userId, happenDate, excludeId = '') {
  const [rows] = await conn.execute('SELECT COUNT(*) AS total FROM todo WHERE user_id=? AND happen_date=? AND is_deleted=0 AND id<>?', [userId, happenDate, excludeId]);
  if (Number(rows[0]?.total) >= 10) fail('该日期已添加 10 个事件，达到每日上限');
}
function reminderTime(fields) {
  return fields.needRemind ? String(dayjs.tz(`${fields.happenDate} 09:00:00`, 'Asia/Shanghai').subtract(fields.remindDays || 0, 'day').valueOf()) : null;
}
async function updateFixed(conn, table, allowed, fields, whereSql, whereParams) {
  const keys = Object.keys(allowed).filter(key => fields[key] !== undefined);
  if (!keys.length) fail('没有可修改字段');
  const [result] = await conn.execute(`UPDATE ${table} SET ${keys.map(key => `${allowed[key]}=?`).join(', ')} ${whereSql}`, [...keys.map(key => fields[key]), ...whereParams]);
  if (result.affectedRows !== 1) fail('业务目标已变化', 'AI_TARGET_CONFLICT', 409);
}
function roundRatio(numerator, denominator) {
  const quotient = numerator / denominator, remainder = numerator % denominator;
  return quotient + ((remainder < 0n ? -remainder : remainder) * 2n >= denominator ? (numerator < 0n ? -1n : 1n) : 0n);
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function createAiBusinessActions({ now = Date.now, backupManager, schedule = setImmediate } = {}) {
  const manager = () => backupManager || require('../../modules/dataManager/service/exportTask');
  async function execute(conn, userId, proposal, target, { executor = conn } = {}) {
    const kind = proposal.kind, fields = proposal.fields, stamp = String(now());
    const recordId = crypto.randomUUID();
    const receipt = { kind, recordId, committedAt: now() };
    if (kind === 'budget.create') {
      const today = shanghaiDate(now());
      await conn.execute(`INSERT INTO budget (id,user_id,title,route,budget_type,budget_amount,used_amount,budget_details,cycle,plan_date,is_over_budget,is_excute,create_time,update_time,is_deleted)
        VALUES (?,?,?,?,?,?,0,?,?,?,0,0,?,?,0)`, [recordId, userId, fields.title, fields.route || null, fields.budgetType, fields.budgetAmount,
        JSON.stringify({ notes: fields.notes || '' }), fields.cycle, fields.planDate, today, today]);
    } else if (kind === 'todo.create') {
      await lockUser(conn, userId);
      await assertTodoCapacity(conn, userId, fields.happenDate);
      await conn.execute(`INSERT INTO todo (id,user_id,content,event_type,happen_date,status,priority,need_remind,remind_time,is_recurring,remark,create_time,update_time,is_deleted)
        VALUES (?,?,?,?,?,'待完成',?,?,?,?,?,?,?,0)`, [recordId, userId, fields.content, fields.eventType, fields.happenDate, fields.priority,
        fields.needRemind ? 1 : 0, reminderTime(fields), fields.isRecurring ? 1 : 0, fields.remark || null, stamp, stamp]);
    } else if (kind === 'todo.update') {
      await lockUser(conn, userId);
      const merged = { content: target.content, eventType: target.event_type, happenDate: target.happen_date,
        priority: target.priority, needRemind: Boolean(Number(target.need_remind)), isRecurring: Boolean(Number(target.is_recurring)),
        remark: target.remark || '', ...fields };
      if (merged.isRecurring && !['birthday', 'anniversary'].includes(merged.eventType)) fail('只有生日和纪念日可以每年重复');
      if (merged.happenDate !== target.happen_date) await assertTodoCapacity(conn, userId, merged.happenDate, fields.targetId);
      const updates = { ...fields, updateTime: stamp };
      if (fields.needRemind !== undefined) updates.needRemind = fields.needRemind ? 1 : 0;
      if (fields.isRecurring !== undefined) updates.isRecurring = fields.isRecurring ? 1 : 0;
      if (['needRemind', 'remindDays', 'happenDate'].some(key => fields[key] !== undefined)) {
        // Preserve the old reminder offset if only the event date is edited.
        const oldOffset = target.remind_time && target.happen_date ? Math.round((dayjs.tz(`${target.happen_date} 09:00:00`, 'Asia/Shanghai').valueOf() - Number(target.remind_time)) / 86400000) : 0;
        merged.remindDays = fields.remindDays ?? Math.max(0, Math.min(365, oldOffset));
        updates.remindTime = reminderTime(merged);
      }
      await updateFixed(conn, 'todo', { content: 'content', eventType: 'event_type', happenDate: 'happen_date', priority: 'priority',
        needRemind: 'need_remind', remindTime: 'remind_time', isRecurring: 'is_recurring', remark: 'remark', updateTime: 'update_time' },
      updates, 'WHERE id=? AND user_id=? AND is_deleted=0', [fields.targetId, userId]);
      receipt.recordId = fields.targetId;
    } else if (kind === 'todo.complete' || kind === 'todo.delete') {
      await updateFixed(conn, 'todo', kind === 'todo.complete' ? { status: 'status', updateTime: 'update_time' } : { isDeleted: 'is_deleted', updateTime: 'update_time' },
        { status: fields.status, isDeleted: 1, updateTime: stamp }, 'WHERE id=? AND user_id=? AND is_deleted=0', [fields.targetId, userId]);
      receipt.recordId = fields.targetId;
    } else if (kind === 'diary.create') {
      await lockUser(conn, userId);
      const content = `<p>${escapeHtml(fields.content).replace(/\n/g, '<br>')}</p>`;
      if (Buffer.byteLength(content,'utf8') > 65535) fail('转义后的日记内容超出存储长度，请缩短后核对');
      const start = dayjs.tz(`${fields.date} 00:00:00`, 'Asia/Shanghai').valueOf();
      const [rows] = await conn.execute('SELECT id FROM moment WHERE user_id=? AND parent_id=id AND create_time>=? AND create_time<? AND is_deleted=0 ORDER BY create_time ASC LIMIT 1 FOR UPDATE', [userId, String(start), String(start + 86400000)]);
      await conn.execute(`INSERT INTO moment (id,user_id,parent_id,content,img_url,mood,location,visible_type,create_time,update_time,is_deleted)
        VALUES (?,?,?,?,NULL,?,NULL,?,?,?,0)`, [recordId, userId, rows[0]?.id || recordId, content,
        JSON.stringify(fields.mood), '{"vt":0,"vs":0,"pw":0}', stamp, stamp]);
    } else if (kind === 'card.metadata') {
      await updateFixed(conn, 'card_base', { alias: 'alias', status: 'status', updateTime: 'update_time' }, { ...fields, updateTime: stamp },
        'WHERE id=? AND user_id=? AND is_deleted=0', [fields.targetId, userId]);
      receipt.recordId = fields.targetId;
    } else if (kind === 'fixedAsset.update') {
      await updateFixed(conn, 'fixed_asset', { info: 'info', tag: 'tag' }, fields, 'WHERE id=? AND user_id=? AND is_deleted=0', [fields.targetId, userId]);
      receipt.recordId = fields.targetId;
    } else if (['fixedAsset.delete', 'fixedAsset.restore', 'fixedAsset.permanentDelete'].includes(kind)) {
      const oldDeleted = kind === 'fixedAsset.delete' ? 0 : 1;
      const [result] = await conn.execute(kind === 'fixedAsset.permanentDelete'
        ? 'DELETE FROM fixed_asset WHERE id=? AND user_id=? AND is_deleted=1'
        : 'UPDATE fixed_asset SET is_deleted=? WHERE id=? AND user_id=? AND is_deleted=?',
      kind === 'fixedAsset.permanentDelete' ? [fields.targetId, userId] : [kind === 'fixedAsset.restore' ? 0 : 1, fields.targetId, userId, oldDeleted]);
      if (result.affectedRows !== 1) fail('资产状态已变化', 'AI_TARGET_CONFLICT', 409);
      receipt.recordId = fields.targetId;
    } else if (kind === 'fund.returnBatch') {
      const dates = fields.entries.map(entry => entry.date);
      const [existing] = await conn.execute(`SELECT record_date FROM bus_fund_history WHERE fund_id=? AND record_date IN (${dates.map(() => '?').join(',')}) FOR UPDATE`, [fields.fundId, ...dates]);
      if (existing.length) fail('部分日期已有收益记录，请先核对，整批未写入', 'AI_FUND_DATE_CONFLICT', 409);
      const recordIds = [];
      for (const entry of fields.entries) {
        const id = crypto.randomUUID(); recordIds.push(id);
        await conn.execute('INSERT INTO bus_fund_history (id,fund_id,net_value,market_val,record_date,create_time) VALUES (?,?,?,0,?,?)', [id, fields.fundId, entry.amount, entry.date, stamp]);
      }
      // Reuse the established legacy snapshot interpretation; AI provides no
      // principal, market value or rate. Maintain the existing summary once.
      const [summary] = await conn.execute(`SELECT COALESCE(SUM(${Fund.historyProfitExpr('h', 'f')}),0) AS profit_sum,
        COALESCE(SUM(${Fund.historyCapitalExpr('h', 'f')}),0) AS capital_sum FROM bus_fund_history h JOIN fund f ON h.fund_id=f.id
        WHERE h.fund_id=? AND f.user_id=? AND f.is_deleted=0`, [fields.fundId, userId]);
      const profit = toScaledInteger(summary[0]?.profit_sum ?? '0', 4);
      const principal = toScaledInteger(target.invest, 4) + toScaledInteger(summary[0]?.capital_sum ?? '0', 4);
      const market = principal + profit;
      const marketCents = roundRatio(market, 100n);
      if (profit < -9999999999n || profit > 9999999999n || marketCents < -999999999999n || marketCents > 999999999999n) fail('累计金额超出数据库精度，整批未写入');
      const rate = principal > 0n ? scaledToString(roundRatio(profit * 10000n, principal), 2) + '%' : '0.00%';
      if (rate.length > 20) fail('收益率超出数据库范围，整批未写入');
      const [result] = await conn.execute('UPDATE fund SET net_value=?,market_val=?,rate=? WHERE id=? AND user_id=? AND is_deleted=0',
        [scaledToString(profit, 4), scaledToString(marketCents, 2), rate, fields.fundId, userId]);
      if (result.affectedRows !== 1) fail('基金状态已变化', 'AI_TARGET_CONFLICT', 409);
      Object.assign(receipt, { recordId: fields.fundId, recordIds, count: recordIds.length });
    } else if (kind === 'system.backup') {
      await recoverBackupJobs(conn);
      const [active] = await conn.execute("SELECT id FROM ai_background_job WHERE status IN ('queued','running') LIMIT 1 FOR UPDATE");
      if (active.length || manager().getRunningTask('system_backup')) fail('已有系统备份执行中，请等待现有回执', 'AI_BACKUP_BUSY', 409);
      const jobRef = crypto.randomUUID();
      const queued = { kind, jobRef, status: 'queued', completed: false };
      await conn.execute("INSERT INTO ai_background_job (id,user_id,proposal_id,status,receipt,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?)", [jobRef, userId, proposal.id, JSON.stringify(queued), stamp, stamp]);
      return { receipt: queued, afterCommit: () => schedule(() => { void runBackupJob(executor, userId, jobRef).catch(() => {}); }) };
    } else fail('该业务不能通过 AI 执行', 'AI_ACTION_NOT_ALLOWED', 403);
    return { receipt };
  }

  async function runBackupJob(executor, userId, jobRef) {
    // CAS is durable. This worker never retries a backup, including after a
    // process restart or a lost response from the old in-memory task manager.
    try {
      const [claimed] = await executor.execute("UPDATE ai_background_job SET status='running',updated_at=? WHERE id=? AND user_id=? AND status='queued'", [String(now()), jobRef, userId]);
      if (claimed.affectedRows !== 1) return;
      if (manager().getRunningTask('system_backup')) fail('已有系统备份执行中');
      const task = await manager().createSystemBackupTask({ includeData: true });
      await executor.execute('UPDATE ai_background_job SET worker_id=?,updated_at=? WHERE id=? AND user_id=? AND status=\'running\'', [task.id, String(now()), jobRef, userId]);
    } catch (_) {
      if (executor) await executor.execute("UPDATE ai_background_job SET status='failed',error_message=?,receipt=?,updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','running')", ['备份启动状态不确定，请在数据管理页面核对；不会自动重试', JSON.stringify({ kind: 'system.backup', jobRef, status: 'failed', completed: false }), String(now()), jobRef, userId]);
    }
  }

  async function getReceipt(executor, userId, receipt) {
    if (receipt?.kind !== 'system.backup' || !receipt.jobRef) return receipt;
    const [rows] = await executor.execute('SELECT id,status,worker_id,receipt,updated_at FROM ai_background_job WHERE id=? AND user_id=?', [receipt.jobRef, userId]);
    if (rows.length !== 1) return { ...receipt, status: 'failed', completed: false };
    const job = rows[0];
    if (['succeeded', 'failed'].includes(job.status)) return typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt;
    const task = job.worker_id ? manager().getTaskStatus(job.worker_id) : null;
    const unknown = !task && now() - Number(job.updated_at) > (job.status === 'queued' ? 60000 : 15 * 60000);
    const status = task?.status === 'completed' ? 'succeeded' : (['failed', 'cancelled'].includes(task?.status) || unknown) ? 'failed' : job.status;
    const current = { kind: 'system.backup', jobRef: job.id, status, completed: status === 'succeeded' };
    if (status !== job.status) await executor.execute('UPDATE ai_background_job SET status=?,receipt=?,error_message=?,updated_at=? WHERE id=? AND user_id=? AND status=?', [status, JSON.stringify(current), status === 'failed' ? '备份未完成或回执丢失，不会自动重试，请在数据管理页面核对' : null, String(now()), job.id, userId, job.status]);
    return current;
  }
  async function recoverBackupJobs(executor) {
    // A manual backup request may discover old orphan jobs even if nobody has
    // opened their chat cards. Refresh at most 100 receipts; never start jobs.
    const [jobs] = await executor.execute("SELECT id,user_id,receipt FROM ai_background_job WHERE status IN ('queued','running') LIMIT 100 FOR UPDATE");
    for (const job of jobs) {
      const stored = typeof job.receipt === 'string' ? JSON.parse(job.receipt) : job.receipt;
      await getReceipt(executor,job.user_id,stored || { kind: 'system.backup',jobRef: job.id });
    }
  }
  return { normalize: (kind, fields) => normalizeBusinessFields(kind, fields, { now: now() }),
    prepare: (conn, userId, kind, fields, lock = false) => loadTarget(conn, userId, kind, fields, lock), execute, getReceipt, runBackupJob, recoverBackupJobs };
}

module.exports = { definitions, normalizeBusinessFields, createAiBusinessActions };
