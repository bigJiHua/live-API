'use strict';

const { checkDate } = require('./context');
const isAiTable = table => table === 'bus_ai_draft' || table.startsWith('ai_');

function units(value, scale = 4) {
  const match = String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match || (match[3] || '').length > scale) throw new Error('无效金额：' + value);
  return (match[1] ? -1n : 1n) * BigInt(match[2] + (match[3] || '').padEnd(scale, '0'));
}
function cnyUnits(row) {
  const amount = units(row.amount);
  return !row.currency || row.currency === 'CNY' ? amount : amount * units(row.exchange_rate) / 1000000n;
}
function validate(ctx, { requireAllTables = true } = {}) {
  const errors = [];
  let checks = 0;
  const ensure = (condition, message) => { checks++; if (!condition && errors.length < 30) errors.push(message); };
  const { rows, schema, start, end, days } = ctx;
  const maps = Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, new Map(data.map(row => [String(row.id), row]))]));
  const activeAccounts = rows.account.filter(row => !Number(row.is_deleted) && !row.reversed_id);
  const rangeStart = Number(ctx.at(start, '00:00:00'));
  const rangeEnd = Number(ctx.at(end, '23:59:59'));
  const auditFields = new Set(['create_time', 'update_time', 'created_at', 'updated_at', 'create_at', 'update_at', 'operate_time', 'login_time', 'register_time', 'record_time', 'committed_at', 'granted_at', 'revoked_at', 'done_time']);
  const actualDateFields = new Set(['trans_date', 'record_date', 'register_date', 'happen_date', 'work_date', 'work_date_dt', 'buy_date', 'purchase_date', 'settle_date', 'repay_time', 'session_day']);
  for (const [table, definition] of Object.entries(schema)) {
    const data = rows[table] || [];
    if (requireAllTables && (!isAiTable(table) || ctx.aiHistory === true)) ensure(data.length > 0, table + ' 缺少模拟数据');
    const columns = new Map(definition.columns.map(column => [column.name, column]));
    const uniqueClauses = [...definition.createSql.matchAll(/(?:PRIMARY KEY|UNIQUE KEY\s+`[^`]+`)\s*\(([^\n]+)\)/g)];
    for (const clause of uniqueClauses) {
      const keys = [...clause[1].matchAll(/`([^`]+)`/g)].map(match => match[1]);
      const seen = new Set();
      for (const row of data) {
        if (keys.some(key => row[key] == null)) continue;
        const token = JSON.stringify(keys.map(key => String(row[key]).toLowerCase()));
        ensure(!seen.has(token), `${table} 唯一键重复 ${keys.join(',')}`); seen.add(token);
      }
    }
    for (const row of data) {
      for (const key of Object.keys(row)) ensure(columns.has(key), `${table}.${key} 不在建表结构中`);
      for (const column of definition.columns) {
        const value = row[column.name];
        if (value == null) {
          ensure(column.nullable || column.defaultValue != null || column.extra.includes('auto_increment'), `${table}.${column.name} 缺少必填值`);
          continue;
        }
        const length = column.type.match(/^(?:var)?char\((\d+)\)/i);
        if (length) ensure(Array.from(String(value)).length <= Number(length[1]), `${table}.${column.name} 超出长度`);
        if (/^enum/i.test(column.type)) ensure([...column.type.matchAll(/'([^']+)'/g)].some(match => match[1] === value), `${table}.${column.name} 枚举无效 ${value}`);
        if (/^json/i.test(column.type)) {
          try { JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)); }
          catch (_) { ensure(false, `${table}.${column.name} JSON 无效`); }
        }
        if (/^(tinyint|smallint|int|bigint)/i.test(column.type)) ensure(/^-?\d+$/.test(String(value)), `${table}.${column.name} 不是整数`);
        if (/^decimal/i.test(column.type)) {
          const precision = column.type.match(/decimal\((\d+),(\d+)\)/i);
          const number = String(value).match(/^-?(\d+)(?:\.(\d+))?$/);
          ensure(!!number && number[1].length <= Number(precision[1]) - Number(precision[2]) && (number[2] || '').length <= Number(precision[2]), `${table}.${column.name} 金额精度错误`);
        }
        if (actualDateFields.has(column.name) && /^\d{4}-\d{2}-\d{2}/.test(String(value))) {
          const date = String(value).slice(0, 10);
          try { checkDate(date); ensure(date >= start && date <= end, `${table}.${column.name} 超出历史范围 ${date}`); }
          catch (_) { ensure(false, `${table}.${column.name} 无效日期`); }
        }
        if (auditFields.has(column.name)) {
          const stamp = /^\d{13}$/.test(String(value)) ? Number(value)
            : /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? Date.parse(String(value).replace(' ', 'T') + (String(value).length === 10 ? 'T00:00:00' : '') + '+08:00') : null;
          ensure(stamp !== null && Number.isFinite(stamp) && stamp >= rangeStart && stamp <= rangeEnd, `${table}.${column.name} 审计时间超出范围 ${value}`);
        }
      }
      if (row.user_id) ensure(row.user_id === ctx.userId, table + ' 用户归属错误');
    }
  }
  const ref = (row, field, target, nullable = false) => {
    const value = row[field];
    if (value == null && nullable) return;
    ensure(maps[target].has(String(value)), `${field}=${value} 在 ${target} 中没有关联记录`);
  };
  for (const row of rows.account) { ref(row, 'card_id', 'card_base'); ref(row, 'category_id', 'bus_category'); ref(row, 'reversed_id', 'account', true); }
  for (const row of rows.card_base) { ref(row, 'bank_id', 'bus_category'); ref(row, 'share_pool_id', 'card_credit_pool', true); }
  for (const table of ['card_bill', 'card_log', 'account_balance', 'card_repay', 'card_foreign_register']) for (const row of rows[table]) ref(row, 'card_id', 'card_base');
  for (const row of rows.account_balance) {
    const amount = activeAccounts.filter(account => account.card_id === row.card_id).reduce((sum, account) => sum + (Number(account.direction) ? 1n : -1n) * cnyUnits(account), 0n);
    ensure(amount === units(row.balance), '余额与流水不一致：' + row.card_id);
    ensure(amount >= 0n, '现金类账户透支：' + row.card_id);
  }
  for (const transfer of rows.account_transfer) {
    ref(transfer, 'from_card_id', 'card_base'); ref(transfer, 'to_card_id', 'card_base');
    const pair = activeAccounts.filter(row => row.transfer_group_id === transfer.id);
    ensure(pair.length === 2 && pair.some(row => Number(row.direction) === 0 && row.card_id === transfer.from_card_id) && pair.some(row => Number(row.direction) === 1 && row.card_id === transfer.to_card_id), '转账缺少成对流水');
    ensure(pair.every(row => cnyUnits(row) === units(transfer.amount) && row.trans_date === transfer.trans_date), '转账金额或日期不一致');
  }
  for (const repay of rows.card_repay) {
    ref(repay, 'bill_id', 'card_bill'); ref(repay, 'account_id', 'account'); ref(repay, 'repay_card_id', 'card_base');
    const account = maps.account.get(repay.account_id);
    ensure(account && account.category_id === 'CATEGORY_REPAY' && Number(account.direction) === 0 && cnyUnits(account) === units(repay.repay_amount), '还款扣款流水不一致');
    ensure(maps.card_bill.get(repay.bill_id)?.card_id === repay.card_id, '还款账单不属于目标卡');
  }
  for (const bill of rows.card_bill) {
    const accounts = activeAccounts.filter(row => row.card_id === bill.card_id && row.trans_date >= bill.bill_start_date && row.trans_date <= bill.bill_end_date && row.category_id !== 'CATEGORY_REPAY');
    const spent = accounts.reduce((sum, row) => sum + (Number(row.direction) ? -1n : 1n) * cnyUnits(row), 0n);
    const repaid = rows.card_repay.filter(row => row.bill_id === bill.id).reduce((sum, row) => sum + units(row.repay_amount), 0n);
    ensure(units(bill.bill_amount) === spent, '账单消费金额与账期流水不一致：' + bill.bill_month);
    ensure(units(bill.repaid) === repaid, '账单已还金额与还款记录不一致');
    ensure(units(bill.need_repay) === spent - repaid, '账单待还金额不一致');
    ensure(units(bill.avail_limit) >= 0n && units(bill.need_repay) >= 0n, '账单额度或待还为负');
  }
  for (const register of rows.card_foreign_register) {
    ref(register, 'account_id', 'account');
    const account = maps.account.get(register.account_id);
    ensure(account && register.card_id === account.card_id && register.currency === account.currency && units(register.foreign_amount) === units(account.amount), '外币原始流水不一致');
    ensure(units(register.registered_rmb) === units(register.foreign_amount) * units(register.registered_rate) / 1000000n, '外币登记折算错误');
    if (register.status === 'reconciled') ensure(units(register.actual_rmb) === cnyUnits(account), '外币结算折算错误');
  }
  for (const row of rows.bus_fund_history) ref(row, 'fund_id', 'fund');
  for (const fund of rows.fund) {
    const history = rows.bus_fund_history.filter(row => row.fund_id === fund.id);
    const profit = history.reduce((sum, row) => sum + units(row.net_value), 0n);
    const additions = history.reduce((sum, row) => sum + units(row.market_val), 0n);
    ensure(units(fund.net_value) === profit, '基金累计收益与每日记录不一致');
    ensure(units(fund.market_val) === units(fund.invest) + additions + profit, '基金市值与本金及收益不一致');
  }
  for (const row of rows.work_salary) {
    ref(row, 'job_id', 'work_job');
    const job = maps.work_job.get(row.job_id);
    ensure(row.work_date >= job.join_date && (!job.leave_date || row.work_date <= job.leave_date), '工资日期不在任职范围内');
    const earned = units(row.day_salary) + units(row.subsidy) - units(row.cut) - units(row.social) - units(row.fund) - units(row.tax);
    ensure(earned === units(row.income), '每日薪酬计算不一致');
  }
  for (const month of ctx.months) {
    const income = activeAccounts.filter(row => row.trans_date.slice(0, 7) === month && Number(row.direction) === 1 && row.category_id === ctx.id('category:salary'));
    if (income.length) {
      const earned = rows.work_salary.filter(row => row.work_date.slice(0, 7) === month).reduce((sum, row) => sum + units(row.income), 0n);
      ensure(income.reduce((sum, row) => sum + cnyUnits(row), 0n) === earned, '月工资与每日工作收入不一致 ' + month);
    }
  }
  for (const row of rows.moment) ref(row, 'parent_id', 'moment');
  for (const row of rows.sys_attachment) {
    const target = row.bus_type === 'moment' ? 'moment' : row.bus_type === 'product' ? 'fixed_asset' : null;
    if (target && row.bus_id) ref(row, 'bus_id', target);
  }
  for (const table of ['asset_snapshot', 'asset_register']) for (const row of rows[table]) ensure(units(row.total_asset) - units(row.credit_debt) === units(row.total_balance), '资产净额不一致');
  const dailyAccounts = new Map(days.map(date => [date, activeAccounts.filter(row => row.trans_date === date)]));
  const walletBalances = new Map(rows.card_base.filter(row => row.card_type !== 'credit').map(row => [row.id, 0n]));
  const cardDebt = new Map(rows.card_base.filter(row => row.card_type === 'credit').map(row => [row.id, 0n]));
  for (const date of days) {
    for (const row of dailyAccounts.get(date)) {
      const amount = (Number(row.direction) ? 1n : -1n) * cnyUnits(row);
      if (walletBalances.has(row.card_id)) walletBalances.set(row.card_id, walletBalances.get(row.card_id) + amount);
      else cardDebt.set(row.card_id, cardDebt.get(row.card_id) - amount);
    }
    for (const row of rows.card_repay.filter(row => row.repay_time === date)) cardDebt.set(row.card_id, cardDebt.get(row.card_id) - units(row.repay_amount));
    const totalAsset = [...walletBalances.values()].reduce((sum, amount) => sum + amount, 0n);
    const totalDebt = [...cardDebt.values()].reduce((sum, amount) => sum + (amount > 0n ? amount : 0n), 0n);
    const snapshot = rows.asset_snapshot.find(row => row.record_date === date);
    ensure(snapshot && units(snapshot.total_asset) === totalAsset && units(snapshot.credit_debt) === totalDebt, '每日快照与当日累计流水不一致 ' + date);
    ensure([...walletBalances.values()].every(amount => amount >= 0n), '历史钱包余额透支 ' + date);
    ensure(activeAccounts.some(row => row.trans_date === date), '每日流水缺失 ' + date);
    ensure(rows.asset_snapshot.some(row => row.record_date === date), '每日资产快照缺失 ' + date);
    for (const fund of rows.fund) ensure(rows.bus_fund_history.some(row => row.fund_id === fund.id && row.record_date === date), '每日基金收益缺失 ' + date);
  }
  for (const row of rows.bus_ai_draft) { ref(row, 'conversation_id', 'ai_conversation', true); ref(row, 'committed_record_id', 'account', true); }
  for (const row of rows.bus_ai_draft.filter(row => row.status === 'committed')) {
    const account = maps.account.get(row.committed_record_id);
    ensure(account && row.account_id === account.card_id && row.trans_date === account.trans_date && units(row.amount) === units(account.amount) && Number(row.direction) === Number(account.direction), '已提交AI草稿与正式流水不一致');
  }
  for (const row of rows.ai_message) { ref(row, 'conversation_id', 'ai_conversation'); ref(row, 'draft_id', 'bus_ai_draft', true); }
  for (const row of rows.ai_transaction_candidate) { ref(row, 'conversation_id', 'ai_conversation', true); ref(row, 'draft_id', 'bus_ai_draft', true); }
  for (const row of rows.ai_chat_activity) { ref(row, 'conversation_id', 'ai_conversation'); ref(row, 'request_id', 'ai_request_run'); }
  for (const row of rows.ai_background_job) {
    ref(row, 'proposal_id', 'ai_business_proposal');
    if (ctx.aiHistory === true) ensure(['failed', 'succeeded'].includes(row.status), 'mock 后台任务处于可执行状态');
  }
  if (ctx.aiHistory === true) for (const row of rows.ai_request_lane) ensure(!row.active_request_id && Number(row.locked_until) === 0, 'mock 持有并发锁');
  for (const row of rows.ai_provider_profile) if (row.provider_host.includes('.invalid')) ensure(Number(row.is_active) === 0, 'mock 供应商配置可被激活');
  const counts = Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, data.length]));
  if (errors.length) throw new Error('Mock 数据校验失败：\n' + errors.join('\n'));
  return { passed: true, checks, start, end, coveredDays: days.length, tableCount: Object.keys(schema).length,
    aiHistory: ctx.aiHistory === true, totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0), counts };
}

module.exports = { validate, units, cnyUnits, isAiTable };
