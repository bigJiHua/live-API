// Live-eval-only fixtures. No production pool or shared real-suite fixture changes.
const crypto = require('crypto');
const { canonical, moneyLiterals } = require('../../src/modules/ai/service/v3Evidence');

function liveDates(today) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(today) || new Date(`${today}T00:00:00Z`).toISOString().slice(0, 10) !== today)
    throw new Error('live eval 日期无效');
  const date = new Date(`${today}T00:00:00Z`);
  const month = offset => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  const day = offset => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10);
  return { today, currentMonth: month(0), previousMonth: month(-1), olderMonth: month(-2), nextMonth: month(1), soon: day(2) };
}

async function seedLiveDomains(pool, fixture) {
  const [database] = await pool.query('SELECT DATABASE() AS name');
  if (database[0]?.name !== 'live_ai_test' || fixture.userId !== 'ai_real_test_user')
    throw new Error('live eval 种子仅允许 live_ai_test / ai_real_test_user');
  const dates = liveDates(fixture.today), uid = () => crypto.randomUUID(), time = String(Date.now());
  const user = fixture.userId, job = uid(), installmentCategory = uid();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`INSERT INTO budget (id,user_id,title,budget_type,budget_amount,used_amount,budget_details,cycle,plan_date,create_time,update_time)
      VALUES (?,?,?,'吃','2000.00','1450.00','[]','月',?,?,?)`, [uid(), user, `${dates.currentMonth.slice(5, 7)}月餐饮预算`, dates.currentMonth, time, time]);
    for (const [content, date] of [['缴房租', dates.soon], ['信用卡还款', dates.nextMonth]])
      await conn.execute(`INSERT INTO todo (id,user_id,content,event_type,happen_date,status,create_time,update_time)
        VALUES (?,?,?,'日程',?,'待完成',?,?)`, [uid(), user, content, date, time, time]);
    await conn.execute(`INSERT INTO work_job (id,user_id,job_type,company,hourly_wage,join_date)
      VALUES (?,?,'parttime','加班时薪','50.00',?)`, [job, user, dates.olderMonth]);
    for (const [date, income] of [[dates.olderMonth, '8500.00'], [dates.previousMonth, '8800.00']])
      await conn.execute(`INSERT INTO work_salary (id,user_id,job_id,job_type,work_date,work_date_dt,day_salary,income,status)
        VALUES (?,?,?,'parttime',?,?,?,?,2)`, [uid(), user, job, date, date, income, income]);
    // Current reader aggregates invest + capital deltas + profit deltas; fund.market_val alone is not read.
    for (const [name, principal, profit] of [['沪深300指数A', '12000.00', '850.00'], ['债基B', '5400.00', '-200.00']]) {
      const fund = uid();
      await conn.execute(`INSERT INTO fund (id,user_id,fund_name,invest,last_report_date,create_time) VALUES (?,?,?,?,?,?)`,
        [fund, user, name, principal, dates.today, time]);
      await conn.execute(`INSERT INTO bus_fund_history (id,fund_id,net_value,market_val,record_date,create_time) VALUES (?,?,?,'0.00',?,?)`,
        [uid(), fund, profit, dates.today, time]);
    }
    await conn.execute(`INSERT INTO bus_category (id,user_id,name,type) VALUES (?,?,'分期','expense')`, [installmentCategory, user]);
    await conn.execute(`INSERT INTO bus_recurring (id,user_id,name,amount,category_id,account_id,cycle,next_date,repeat_count,month_records,create_time)
      VALUES (?,?,'手机分期','416.67',?,?,'month',?,6,?,?)`, [uid(), user, installmentCategory,
      JSON.stringify({ type: 'installment', cardId: fixture.accountId }), dates.today,
      JSON.stringify({ [dates.today.slice(0, 7)]: { status: 'pending' } }), time]);
    // Account composition comes from saved card balances, not asset_snapshot.
    await conn.execute('UPDATE card_base SET alias=? WHERE id=? AND user_id=?', ['招行储蓄卡', fixture.accountId, user]);
    await conn.execute('UPDATE account_balance SET balance=?, update_time=? WHERE card_id=? AND user_id=?',
      ['32500.00', time, fixture.accountId, user]);
    for (const [type, name, balance, tail] of [['debit', '第二张储蓄卡', '19500.00', '0002'], ['credit', '招行信用卡', '-8500.00', '0003'], ['virtual_wechat', '微信账户', '320.00', '0004']]) {
      const card = uid();
      await conn.execute(`INSERT INTO card_base (id,user_id,bank_id,card_type,last4_no,card_bin,alias,open_date,expire_date,currency,create_time,update_time)
        VALUES (?,?,?,?,?,'000001',?,?,'2030-01-01','CNY',?,?)`, [card, user, '真库测试银行', type, tail, name, dates.olderMonth, time, time]);
      await conn.execute(`INSERT INTO account_balance (id,user_id,card_id,balance,currency,update_time) VALUES (?,?,?,?,'CNY',?)`, [uid(), user, card, balance, time]);
    }
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
  return dates;
}

// Keep offline's fixed clock intact; live date expectations follow the seeded calendar.
function liveCase(caseDef, dates) {
  const copy = structuredClone(caseDef);
  if (copy.id === 'todo-next-month') copy.expect.answerContains = [dates.nextMonth];
  if (copy.id === 'work-salary-history') copy.message = `查一下${dates.olderMonth}到${dates.today}已登记的工资。`;
  return copy;
}

function numericValue(value) {
  const text = String(value).normalize('NFKC').replace(/−/g, '-').trim();
  if (text.includes(',')) {
    if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) return null;
    return canonical(text.replace(/,/g, ''));
  }
  return canonical(text);
}

function numberTokens(text) {
  // Mask complete calendar dates before tokenizing; slash/Chinese display dates are not money.
  const cleaned = String(text).normalize('NFKC').replace(/−/g, '-').replace(/([+-])([¥￥])/g, '$2$1')
    .replace(/https?:\/\/\S+|20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{4}[-/]\d{2}|\d{4}年|\d{1,2}月|\d{1,2}日|\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?/g, ' ')
    .replace(/(?:今天|日期|截至|截止|登记日)[（(:：\s]*(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])(?!\d|\s*(?:元|块|人民币|CNY|=))[）)]?/g, ' ')
    .replace(/(?<!\d)(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\s*(?:至|到|—|~|～)\s*(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])(?!\d|\s*(?:元|块|人民币|CNY|=))/g, ' ');
  return [...cleaned.matchAll(/(?<![\dA-Za-z._])[+-]?\d(?:[\d,]*\d)?(?:\.\d+)?(?![\dA-Za-z._])/g)].map(match => ({
    raw: match[0], value: numericValue(match[0]), after: cleaned.slice(match.index + match[0].length).trimStart(),
  }));
}

function extractAmounts(text) {
  return [...new Set(numberTokens(text).filter(token => token.raw.includes('.')
    || /^(?:元|块|人民币|CNY|%|％)/.test(token.after)
    || token.raw.replace(/[+,-]/g, '').length >= 2 && (!/^[\u4e00-\u9fffA-Za-z]/.test(token.after) || /^笔/.test(token.after)))
    // Malformed monetary grouping stays an unmatched token rather than silently disappearing.
    .map(token => token.value ?? token.raw))];
}

function containsDatePoint(answer, point, { nextMonth } = {}) {
  const parts = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(point);
  if (!parts) return String(answer).includes(point);
  const [year, month, day] = parts.slice(1).map(Number);
  const text = String(answer).replace(/[*_`]/g, '');
  if (new RegExp(`(?<!\\d)${point}(?!\\d)`).test(text)) return true;
  if (new RegExp(`${year}\\s*年\\s*${month}\\s*月\\s*${day}\\s*(?:日|号)`).test(text)) return true;
  const partial = new RegExp(`${month}\\s*月\\s*${day}\\s*(?:日|号)`, 'g');
  for (const match of text.matchAll(partial)) {
    const before = text.slice(Math.max(0, match.index - 200), match.index);
    const anchors = [...before.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月/g)];
    const anchor = anchors.at(-1);
    if (anchor ? Number(anchor[1]) === year && Number(anchor[2]) === month
      : nextMonth?.slice(0, 7) === point.slice(0, 7)) return true;
  }
  return false;
}

function containsExpectedPoints(answer, points = [], dateContext = {}) {
  const tokens = new Set(numberTokens(answer).map(token => token.value).filter(value => value != null));
  return points.every(point => {
    const value = numericValue(point);
    return value == null ? containsDatePoint(answer, point, dateContext) : tokens.has(value);
  });
}

function numbersInDatasets(datasets) {
  const numbers = new Set();
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    else if (typeof value === 'number' || typeof value === 'string') {
      const number = numericValue(value);
      if (number != null) numbers.add(number);
    }
  };
  for (const dataset of datasets || []) { visit(dataset.rows || []); visit(dataset.summary || {}); }
  return numbers;
}

function verifiedCalcReceipts(rows, traces) {
  const digests = new Set((traces || []).filter(trace => trace.tool === 'calculate' && trace.records === 1).map(trace => trace.digest));
  const receipts = [];
  for (const row of rows || []) {
    if (row.status !== 'ok') continue;
    let payload;
    try { payload = typeof row.response_payload === 'string' ? JSON.parse(row.response_payload) : row.response_payload; }
    catch (_) { continue; }
    const result = payload?.result;
    if (payload?.tool !== 'calculate' || !digests.has(payload.digest) || !result || result.status === 'error'
      || !['money', 'number'].includes(result.mode) || typeof result.expression !== 'string' || numericValue(result.value) == null) continue;
    if (crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex') !== payload.digest) continue;
    receipts.push({ value: result.value, mode: result.mode });
  }
  return receipts;
}

function groundedAnswer(answer, datasets, caseDef, result = {}, actualCalcReceipts = []) {
  if (/[+-]?\d+(?:\.\d+)?[eE][+-]?\d+\s*(?:元|块|人民币|CNY|%|％)/.test(answer)) return false;
  const numbers = numbersInDatasets(datasets);
  for (const value of caseDef.expect?.allowedNumbers || []) {
    const number = numericValue(value); if (number != null) numbers.add(number);
  }
  for (const receipt of actualCalcReceipts) {
    const value = numericValue(receipt.value);
    if (value != null) numbers.add(value);
  }
  // Only transaction drafts may cite user money. A matching final draft is still required.
  const expectedDraftAmount = canonical(caseDef.expect?.proposalAmount);
  if (caseDef.draft && result.draft && expectedDraftAmount != null && canonical(result.draft.amount) === expectedDraftAmount)
    for (const value of moneyLiterals(caseDef.message)) numbers.add(value);
  return extractAmounts(answer).every(value => numbers.has(value));
}

module.exports = { liveDates, seedLiveDomains, liveCase, extractAmounts, numbersInDatasets, groundedAnswer, containsExpectedPoints, verifiedCalcReceipts };
