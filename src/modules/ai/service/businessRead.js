const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { AiError } = require('./errors');
const { isSupportedDraftCategory } = require('./draftPolicy');
const { financeQueryMoney } = require('./financeQueryMoney');
const { prepareFinanceDatasetQuery, readFinanceDataset } = require('./financeDatasetRead');
const { cardNameSql, cardBankJoin, isAnonymousCardName, dedupeCardNames } = require('./cardNames');
const { CARD_TYPES, statedCardTypes, bankNameVariants } = require('./candidateSelection');
const { getDatasetCapability, CHOICE_GROUPS, CHOICE_SOURCE_DOMAIN } = require('./datasetCapabilities');
const { MAX_RANGE_DAYS, planQuery, pageInfo } = require('./largeQuery');
const { aggregateSql, totalsSql, normalizeTotals, isAggregateDataset } = require('./largeDatasetSql');
const CARD_CONSUMPTION = getDatasetCapability('card-monthlyConsumption');
const CARD_RANKING_SORTS = CARD_CONSUMPTION.acceptedArgs.rankingSorts;

// One shared display rule for every account/card name in this repository.
// Legacy "未命名账户/未命名卡片" fallbacks are intentionally gone: they make
// dozens of cards indistinguishable and block the whole draft main chain.
const CARD_NAME = cardNameSql();
const CARD_BANK_JOIN = cardBankJoin();

const DOMAINS = Object.freeze(['finance', 'account', 'card', 'budget', 'todo', 'work', 'asset', 'fixedAsset', 'fund', 'installment']);
const ROW_LIMIT = 100;
const DAY = 86400000;
const SAVED_TIME_FIELDS = ['updatedAt', 'recordedAt', 'minUpdatedAt', 'maxUpdatedAt'];
// These aliases and ordering expressions are authored by the repository, never by a model.
// Filtering belongs before the finite display window; a zero-row window is not evidence
// that an older matching saved record does not exist.
const GENERIC_DATASET_SQL = Object.freeze({
  'account-balances': { text: ['name', 'type', 'currency', 'updatedAt'], order: [['sourceSort'], ['cardId']], policy: "按卡片配置顺序展示，最后保存时间单独列出。" },
  'card-cards': { text: ['name', 'type', 'status'], order: [['sourceSort'], ['cardId']], policy: "展示部分按下次配置还款日升序排列，有日期的信用卡在前；登记到期月份单独列出，完整性以查询元数据为准。" },
  'card-counts': { text: ['type', 'displayType'], order: [['type']], policy: "按卡片类型分组展示，数量来自全部匹配卡片。" },
  'card-bills': { text: ['name', 'repayStatus', 'updatedAt'], order: [['month', 'DESC'], ['cardId']], policy: "按账单月份从新到旧排列，同月保持固定顺序。" },
  'card-repayments': { text: ['name', 'date', 'method'], order: [['date', 'DESC'], ['id']], policy: "按已保存还款时间从新到旧排列，同一时间保持固定顺序。" },
  'card-pools': { text: ['name'], order: [['poolId']], policy: "共享池按固定保存顺序展示。" },
  'budget-plans': { text: ['title', 'type', 'cycle'], order: [['date', 'DESC'], ['id']], policy: "按计划日期从新到旧排列，同日保持固定顺序。" },
  'todo-events': { text: ['content', 'type', 'status', 'remark'], order: [['date'], ['priority'], ['id']], policy: "按范围内发生日期升序排列，同日按优先级数值升序排列。" },
  'work-salary': { text: ['company', 'type'], order: [['date', 'DESC'], ['id']], policy: "按工作日期从新到旧排列，同日保持固定顺序。" },
  'work-rules': { text: ['company', 'type'], order: [['status', 'DESC'], ['jobId']], policy: "按保存的任职状态优先排列，同状态保持固定顺序。" },
  'asset-snapshots': { text: ['recordedAt'], order: [['date', 'DESC'], ['id']], policy: "按快照日期从新到旧排列，同日保留多条保存记录并保持固定顺序；保存时间单独列出。" },
  'asset-registers': { text: ['recordedAt'], order: [['date', 'DESC'], ['id']], policy: "按登记日期从新到旧排列，同日保留多条保存记录并保持固定顺序；保存时间单独列出。" },
  'asset-composition': { text: ['type', 'currency', 'minUpdatedAt', 'maxUpdatedAt'], order: [['type'], ['currency']], policy: "按账户类型与币种分组排列，每行对应一个类型与币种组合。" },
  'asset-comparison': { text: ['currency', 'reason'], order: [['date', 'DESC']], policy: "按同日对照日期从新到旧排列，同日双方分别采用最新保存记录。" },
  'fixedAsset-saved': { text: ['name', 'tag', 'status'], order: [['isDeleted', 'DESC'], ['buyDate', 'DESC'], ['id']], policy: "查询包含回收站时回收站记录在前；同类记录按购买日期从新到旧排列。" },
  'fund-holdings': { text: ['name'], order: [['id']], policy: "基金登记汇总按固定保存顺序展示。" },
  'fund-history': { text: ['name'], order: [['date', 'DESC'], ['id']], policy: "按收益登记日期从新到旧排列，同日保持固定顺序。" },
  'installment-plans': { text: ['name'], order: [['active', 'DESC'], ['nextDate'], ['id']], policy: "启用计划在前，再按下次计划日期升序排列。" },
});
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;


// Mirrors savedTimestamp's trusted-field projection for SQL text matching.
// Epoch arithmetic uses an explicit UTC base and calendar times default to Shanghai,
// so the comparison does not depend on the database session time zone.
function savedTimestampSql(expression) {
  const text = `CAST(${expression} AS CHAR)`;
  const epoch = `CAST(${text} AS UNSIGNED)`;
  const datetime = `CAST(CONCAT(SUBSTRING(${text}, 1, 10), ' ', SUBSTRING(${text}, 12, 8)) AS DATETIME)`;
  const hasZone = `RIGHT(${text}, 6) REGEXP '^[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'`;
  const offset = `CASE WHEN RIGHT(${text}, 1) = 'Z' THEN 0 WHEN ${hasZone}
    THEN (CASE WHEN SUBSTRING(${text}, LENGTH(${text}) - 5, 1) = '-' THEN -1 ELSE 1 END)
      * (CAST(SUBSTRING(${text}, LENGTH(${text}) - 4, 2) AS SIGNED) * 60 + CAST(RIGHT(${text}, 2) AS SIGNED))
    ELSE 480 END`;
  const fraction = `CASE WHEN SUBSTRING(${text}, 20, 1) = '.' THEN
    RPAD(SUBSTRING(${text}, 21, CASE WHEN RIGHT(${text}, 1) = 'Z' THEN LENGTH(${text}) - 21
      WHEN ${hasZone} THEN LENGTH(${text}) - 26 ELSE LENGTH(${text}) - 20 END), 3, '0') ELSE '000' END`;
  return `CASE
    WHEN ${text} REGEXP '^[1-9][0-9]{12}$' THEN CONCAT(
      DATE_FORMAT(DATE_ADD('1970-01-01 00:00:00', INTERVAL FLOOR(${epoch} / 1000) SECOND), '%Y-%m-%dT%H:%i:%s'),
      '.', LPAD(MOD(${epoch}, 1000), 3, '0'), 'Z')
    WHEN ${text} REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[ T](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])?$'
      AND CAST(SUBSTRING(${text}, 9, 2) AS UNSIGNED) <= DAY(LAST_DAY(CONCAT(SUBSTRING(${text}, 1, 7), '-01')))
    THEN CONCAT(DATE_FORMAT(DATE_SUB(${datetime}, INTERVAL (${offset}) MINUTE), '%Y-%m-%dT%H:%i:%s'), '.', ${fraction}, 'Z')
    ELSE NULL END`;
}

function savedTimestamp(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  // These dedicated database fields store epoch milliseconds or calendar time.
  // Convert them before generic text redaction; arbitrary names/remarks never
  // enter this path and retain the existing long-number privacy boundary.
  if (/^[1-9]\d{12}$/.test(text)) return new Date(Number(text)).toISOString();
  const calendar = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!calendar || !validDate(calendar[1]) || Number(calendar[2])>23 || Number(calendar[3])>59 || Number(calendar[4])>59) return null;
  const withZone = `${calendar[1]}T${calendar[2]}:${calendar[3]}:${calendar[4]}${calendar[5]||''}${calendar[6]||'+08:00'}`;
  const instant = Date.parse(withZone);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

function validateScope(input = {}, now = new Date()) {
  const today = new Date(new Date(now).getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const domains = input.domains == null ? ['finance'] : input.domains;
  if (!Array.isArray(domains) || domains.length > DOMAINS.length
    || domains.some(domain => !DOMAINS.includes(domain)) || new Set(domains).size !== domains.length) {
    throw new AiError('请选择支持的业务范围', 400, 'AI_SCOPE_INVALID');
  }
  const startDate = input.startDate || `${today.slice(0, 7)}-01`;
  const endDate = input.endDate || today;
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate
    || (Date.parse(endDate) - Date.parse(startDate)) / DAY > MAX_RANGE_DAYS) {
    throw new AiError('分析日期须真实有效，单次完整范围最多十年', 400, 'AI_SCOPE_INVALID');
  }
  return { domains: [...domains], startDate, endDate };
}

// Keep SQL DECIMAL values as decimal strings, including rounding at the currency boundary.
// No Number arithmetic on financial data and no write-capable business models are imported.
function decimalString(value, digits = 2) {
  if (value == null) return null;
  const raw = String(value);
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new AiError('数据库金额格式无效，请先核对原记录', 503, 'AI_READ_INVALID_AMOUNT');
  const fraction = match[3] || '';
  let units = BigInt(match[2]) * 10n ** BigInt(digits) + BigInt((fraction.slice(0, digits)).padEnd(digits, '0') || '0');
  if (fraction.length > digits && fraction[digits] >= '5') units += 1n;
  const formatted = units.toString().padStart(digits + 1, '0');
  return `${match[1] && units ? '-' : ''}${digits ? `${formatted.slice(0, -digits)}.${formatted.slice(-digits)}` : formatted}`;
}

const column = (key, label, type = 'text') => ({ key, label, type });
const CARD_TYPE_LABELS = { credit: '信用卡', debit: '借记卡', virtual_balance: '虚拟余额', virtual_cash: '现金', virtual_wechat: '微信', virtual_alipay: '支付宝' };
// Server-authored totals for the query answer: the model never adds amounts.
function summarizeCardMonthly(rows) {
  const cents = value => {
    const text = decimalString(value || '0', 2), negative = text.startsWith('-');
    return BigInt(text.replace(/[-.]/g, '')) * (negative ? -1n : 1n);
  };
  let total = 0n, count = 0, hasPriced = false;
  for (const row of rows) {
    if (row.amountCNY != null && row.amountCNY !== '') hasPriced = true;
    total += cents(row.amountCNY); count += Number(row.count || 0);
  }
  const absolute = (total < 0n ? -total : total).toString().padStart(3, '0');
  return { ...(hasPriced ? { expense: `${total < 0n ? '-' : ''}${absolute.slice(0, -2)}.${absolute.slice(-2)}` } : {}), count, currency: 'CNY' };
}
function nextRepaymentDate(day, today) {
  const value = Number(day);
  if (!Number.isInteger(value) || value < 1 || value > 31 || !validDate(today)) return null;
  const [year, month] = today.split('-').map(Number);
  for (let offset = 0; offset < 2; offset++) {
    const base = new Date(Date.UTC(year, month - 1 + offset, 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(value, last))).toISOString().slice(0, 10);
    if (candidate >= today) return candidate;
  }
  return null;
}
function expirationMonth(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}(?:-\d{2})?$/.test(value)) return null;
  const month = value.slice(0, 7);
  if (!validDate(`${month}-01`) || (value.length === 10 && !validDate(value))) return null;
  return month;
}
function budgetKeywords(message = '') {
  if (typeof message !== 'string' || /不要|不找|不是|排除|不用|别找|还是|不确定/.test(message)) return [];
  return ['香港', '一日游'].filter(term => message.includes(term));
}
const normalize = (rows, moneyKeys = [], decimalKeys = []) => rows.map(row => {
  const value = { ...row };
  for (const key of SAVED_TIME_FIELDS) if (Object.hasOwn(value, key)) value[key] = savedTimestamp(value[key]);
  for (const key of moneyKeys) if (Object.hasOwn(value, key)) value[key] = decimalString(value[key]);
  for (const key of decimalKeys) if (Object.hasOwn(value, key)) value[key] = decimalString(value[key], key === 'amount' && value.currency === 'CNY' ? 2 : 4);
  return value;
});
const financeValid = `a.user_id = ? AND a.is_deleted = 0 AND a.reversed_id IS NULL
  AND a.pay_type <> '转账' AND a.category_id <> 'CATEGORY_REPAY'
  AND a.trans_date >= ? AND a.trans_date <= ?`;
const { cny, unpriced, currency: verifiedCurrency, total: valuedTotal, forDirection } = financeQueryMoney();

function createBusinessReadRepository({ executor, dbConfig, now = () => new Date() } = {}) {
  // No default/fallback to the application's writable database account.
  const pool = executor || (dbConfig ? mysql.createPool({ ...dbConfig, connectionLimit: 2, queueLimit: 8,
    waitForConnections: true, multipleStatements: false, connectTimeout: 5000, decimalNumbers: false }) : null);
  async function read(work, consistent = false) {
    if (!pool) throw new AiError('AI 只读数据库尚未配置', 503, 'AI_READ_UNAVAILABLE');
    let conn;
    try {
      conn = pool.getConnection ? await pool.getConnection() : pool;
      if (consistent) await conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await conn.query('SET TRANSACTION READ ONLY');
      await conn.beginTransaction();
      const select = async (sql, params) => {
        const [rows] = await conn.execute({ sql, timeout: 5000 }, params);
        if (!Array.isArray(rows)) throw new Error('Invalid read result');
        return rows;
      };
      const value = await work(select);
      await conn.rollback();
      return value;
    } catch (error) {
      if (conn) await conn.rollback().catch(() => {});
      if (error instanceof AiError) throw error;
      const failed = new AiError('只读查询失败，请检查只读账户权限及数据库结构', 503, 'AI_READ_FAILED');
      const causeCode = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'READ_OPERATION_FAILED';
      const causeColumn = /^Unknown column '([\w.]+)'/.exec(error.sqlMessage || '')?.[1];
      Object.defineProperty(failed, 'causeCode', { value: causeCode });
      if (causeColumn) Object.defineProperty(failed, 'causeColumn', { value: causeColumn });
      throw failed;
    } finally { if (conn && conn.release) conn.release(); }
  }

  async function query(userId, input = {}) {
    if (typeof userId !== 'string' || !userId || userId.length > 64) throw new AiError('当前用户无效', 401, 'AI_USER_INVALID');
    if (input.groupBy != null && !getDatasetCapability(input.datasetId)?.acceptedArgs.groupings.includes(input.groupBy))
      throw new AiError('此数据集不支持指定的统计粒度', 400, 'AI_TOOL_ARGUMENT_INVALID');
    const scope = validateScope({ ...(input.scope || {}), ...input }, now());
    const asOf = new Date(now()).toISOString();
    const queryId = input.queryId || `q_${crypto.randomBytes(12).toString('hex')}`;
    const { startDate, endDate, domains } = scope;
    const emptyChoices = () => ({ cards: [], categories: [], funds: [], todos: [], fixedAssets: [],
      moods: ['开心', '平静', '难过', '累', '兴奋', '郁闷'] });
    if (!domains.length) return { scope, datasets: [], choices: emptyChoices(), asOf };
    const completeRangeRead = Boolean(input.datasetId && !['card-counts', 'asset-composition'].includes(input.datasetId)
      && (input.cursor || input.resolution && input.resolution !== 'auto'
        || (Date.parse(endDate) - Date.parse(startDate)) / DAY >= 366));
    return read(async select => {
      const datasets = [];
      const choices = emptyChoices();
      const range = [userId, startDate, endDate];
      const fullRangeQueries = new Map();
      const largeReads = new Map();
      const useLargeRead = completeRangeRead;
      const datasetRows = async (datasetId, sql, params) => {
        if (input.datasetId !== datasetId) return select(sql, params);
        const spec = GENERIC_DATASET_SQL[datasetId];
        if (!spec || !/ LIMIT 101$/.test(sql) || !sql.includes(' ORDER BY '))
          throw new AiError('数据集只读查询定义无效', 503, 'AI_READ_INVALID_RESULT');
        const filter = input.filter == null ? '' : input.filter;
        if (typeof filter !== 'string' || filter.length > 80)
          throw new AiError('查询文本筛选无效', 400, 'AI_TOOL_ARGUMENT_INVALID');
        const source = sql.slice(0, sql.lastIndexOf(' ORDER BY '));
        const condition = filter && spec.text.length ? ` WHERE (${spec.text.map(key =>
          `INSTR(LOWER(${SAVED_TIME_FIELDS.includes(key) ? savedTimestampSql(`ai_source.\`${key}\``) : `CAST(ai_source.\`${key}\` AS CHAR)`}), LOWER(?)) > 0`).join(' OR ')})` : '';
        const bound = [...params, ...(condition ? spec.text.map(() => filter) : [])];
        const from = `FROM (${source}) AS ai_source${condition}`;
        if (useLargeRead) {
          const baseInput = { ...input, scope, sort: input.sort || getDatasetCapability(datasetId).defaults.sort };
          let plan = planQuery(baseInput, userId, now());
          const filteredSql = `SELECT ai_source.* ${from}`;
          const aggregate = () => aggregateSql(datasetId, plan.resolution, filteredSql, bound);
          let projection = aggregate();
          let projectedSql = projection ? `FROM (${projection.sql}) AS ai_groups` : from;
          let projectedParams = projection ? projection.params : bound;
          const countGroups = async () => {
            const [row] = await select(`SELECT COUNT(*) AS matchedRowCount ${projectedSql}`, projectedParams);
            const count = Number(row?.matchedRowCount);
            if (row?.matchedRowCount == null || !Number.isSafeInteger(count) || count < 0) throw new AiError('数据集匹配数量无效', 503, 'AI_READ_INVALID_COUNT');
            return count;
          };
          let matchedRowCount = await countGroups();
          // A coarser series is allowed only for auto on the first page.
          if (projection && plan.resolution === 'month' && matchedRowCount > plan.limit && !input.cursor
            && (input.resolution == null || input.resolution === 'auto')) {
            plan = planQuery({ ...baseInput, resolution: 'year' }, userId, now());
            projection = aggregate(); projectedSql = `FROM (${projection.sql}) AS ai_groups`; projectedParams = projection.params;
            matchedRowCount = await countGroups();
          }
          let totals = { sourceRecordCount: matchedRowCount, summary: { count: matchedRowCount } };
          if (isAggregateDataset(datasetId)) {
            const [row] = await select(totalsSql(datasetId, filteredSql), bound);
            totals = normalizeTotals(datasetId, row, decimalString);
          }
          const order = projection ? projection.order : spec.order.map(([key, direction = 'ASC']) => `\`${key}\` ${direction}`).join(', ');
          const result = await select(`SELECT ${projection ? 'ai_groups.*' : 'ai_source.*'} ${projectedSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
            [...projectedParams, plan.limit + 1, plan.offset]);
          if (plan.offset > matchedRowCount || result.length !== Math.min(plan.limit + 1, matchedRowCount - plan.offset)
            || totals.sourceRecordCount < matchedRowCount)
            throw new AiError('数据集数量与返回窗口不一致', 503, 'AI_READ_INVALID_RESULT');
          largeReads.set(datasetId, { plan, matchedRowCount, totals, projection });
          fullRangeQueries.set(datasetId, { matchedRowCount, filter, sourceRecordCount: totals.sourceRecordCount });
          return result;
        }
        // Group count and underlying account count are separate facts. Only this
        // owner-bound composition query proves a source count through its COUNT(*) groups.
        const sourceCountSelection = datasetId === 'asset-composition'
          ? ', COALESCE(SUM(ai_source.`count`), 0) AS sourceRecordCount' : '';
        const counts = await select(`SELECT COUNT(*) AS matchedRowCount${sourceCountSelection} ${from}`, bound);
        const countText = String(counts[0]?.matchedRowCount ?? '');
        if (!/^(?:0|[1-9]\d*)$/.test(countText) || !Number.isSafeInteger(Number(countText)))
          throw new AiError('数据集匹配数量无效', 503, 'AI_READ_INVALID_COUNT');
        const sourceCount = {};
        if (datasetId === 'asset-composition') {
          const sourceText = String(counts[0]?.sourceRecordCount ?? '');
          if (!/^(?:0|[1-9]\d*)$/.test(sourceText) || !Number.isSafeInteger(Number(sourceText))
            || Number(sourceText) < Number(countText))
            throw new AiError('数据集来源数量无效', 503, 'AI_READ_INVALID_COUNT');
          sourceCount.sourceRecordCount = Number(sourceText);
        }
        fullRangeQueries.set(datasetId, { matchedRowCount: Number(countText), filter, ...sourceCount });
        // ORDER BY output aliases also supports function-derived dates on the
        // deployed MySQL optimizer; qualified aliases are not stable after merge.
        const order = spec.order.map(([key, direction = 'ASC']) => `\`${key}\` ${direction}`).join(', ');
        return select(`SELECT ai_source.* ${from} ORDER BY ${order} LIMIT 101`, bound);
      };
      const add = (domain, key, title, columns, raw, policy, summary = {}, options = {}) => {
        const datasetId = `${domain}-${key}`;
        const large = largeReads.get(datasetId);
        if (large) {
          const { plan, matchedRowCount, totals, projection } = large;
          const effectiveColumns = projection?.columns || columns;
          const rows = normalize(raw.slice(0, plan.limit), effectiveColumns.filter(c => c.type === 'money').map(c => c.key),
            effectiveColumns.filter(c => c.type === 'decimal').map(c => c.key));
          const dates = rows.flatMap(row => [row.firstDate, row.lastDate, /^\d{4}-\d{2}-\d{2}$/.test(row.date || '') ? row.date : null])
            .filter(date => validDate(date)).sort();
          const page = pageInfo(plan, matchedRowCount, rows.length, asOf);
          const sourceCount = isAggregateDataset(datasetId) ? totals.sourceRecordCount : null;
          const queryMeta = { version: 1, queryId, datasetId,
            requestedScope: input.requestedScope || { startDate, endDate }, effectiveScope: { startDate, endDate },
            filters: { direction: 'both', text: input.filter || '' }, sort: getDatasetCapability(datasetId).defaults.sort,
            matchedRowCount, returnedRowCount: rows.length, sourceRecordCount: sourceCount,
            rowsComplete: plan.offset === 0 && matchedRowCount === rows.length,
            summaryComplete: totals.summaryComplete === true,
            rankingComplete: false, returnedDateRange: dates.length ? { startDate: dates[0], endDate: dates.at(-1) } : null,
            asOf, resolution: plan.resolution, page };
          datasets.push({ datasetId, domain, title: projection ? `${title}（${plan.resolution === 'month' ? '按月' : '按年'}）` : title,
            columns: effectiveColumns, rows, summary: { ...summary, ...totals.summary }, queryMeta,
            totalCount: matchedRowCount, policy: `${policy} ${projection?.policy || ''} 本次保留完整请求范围；来源登记条数与返回分组行数分别说明，合计由全范围SQL生成，不由展示页相加。${page.hasMore ? ' 明细或分组未全部展示，可用同范围、筛选和实际粒度携带nextCursor续查。' : ''}`,
            asOf, isEstimated: false, truncated: page.hasMore || plan.offset > 0, ...options });
          return rows;
        }
        const truncated = raw.length > ROW_LIMIT;
        const rows = normalize(raw.slice(0, ROW_LIMIT), columns.filter(c => c.type === 'money').map(c => c.key),
          columns.filter(c => c.type === 'decimal').map(c => c.key));
        const reliability = columns.some(col => col.key === 'unpricedCount')
          ? { ...summary, incomplete: summary.incomplete === true || rows.some(row => Number(row.unpricedCount || 0) > 0) } : summary;
        const fullRangeQuery = fullRangeQueries.get(`${domain}-${key}`);
        datasets.push({ datasetId: `${domain}-${key}`, domain, title, columns, rows,
          summary: fullRangeQuery?.filter ? {} : reliability,
          policy: `${policy}${GENERIC_DATASET_SQL[`${domain}-${key}`]?.policy ? ` ${GENERIC_DATASET_SQL[`${domain}-${key}`].policy}` : ''}`,
          asOf, isEstimated: false, truncated, ...options, ...(fullRangeQuery ? { fullRangeQuery } : {}) });
        return rows;
      };
      // The requested candidate group decides what has to be read. A category
      // request must not fail because this owner has more than 100 accounts, and
      // a card request must not read the unrelated category table.
      const choiceGroup = typeof input.group === 'string' && input.group ? input.group : null;
      // list_choices passes candidateOnly. It must never enter the business-domain
      // dataset loop for unrelated ledgers: only candidate sources that live in a
      // dataset (todos/funds/fixed assets) need one query. The group maps come
      // from datasetCapabilities so a new group cannot skip this narrowing.
      const candidateOnly = input.candidateOnly === true;
      const candidateDomains = new Set();
      if (candidateOnly) for (const domain of domains) {
        for (const group of choiceGroup ? [choiceGroup] : CHOICE_GROUPS[domain] || []) {
          if (CHOICE_SOURCE_DOMAIN[group]) candidateDomains.add(CHOICE_SOURCE_DOMAIN[group]);
        }
      }
      const needsCards = input.datasetId === 'card-monthlyConsumption'
        || (!input.datasetId && (!choiceGroup || choiceGroup === 'cards')
          && domains.some(d => ['finance', 'account', 'card'].includes(d)));
      const needsCategories = !input.datasetId && (!choiceGroup || choiceGroup === 'categories')
        && domains.some(d => ['finance', 'budget', 'installment'].includes(d));
      if (needsCards) {
        // Narrow the target group before LIMIT 101 so unrelated accounts can
        // never trigger the scope guard or push the matching card out of view.
        const cardParams = [userId];
        let cardConditions = '';
        if (typeof input.cardType === 'string' && CARD_TYPES.includes(input.cardType)) {
          cardConditions += ' AND c.card_type = ?';
          cardParams.push(input.cardType);
        }
        const bankNames = bankNameVariants(input.bankName);
        if (bankNames.length) {
          cardConditions += ` AND bank.name IN (${bankNames.map(() => '?').join(',')})`;
          cardParams.push(...bankNames);
        }
        if (typeof input.filter === 'string' && input.filter) {
          cardConditions += ` AND INSTR(LOWER(${CARD_NAME}), LOWER(?)) > 0`;
          cardParams.push(input.filter);
        }
        // Shared display rule + shared dedupe: a name in the model's reply must
        // resolve to exactly one card, in both the V3 and legacy repositories.
        choices.cards = await select(`SELECT c.id, ${CARD_NAME} AS name,
          c.card_type AS type, c.card_type AS cardType, bank.name AS bankName,
          CASE WHEN c.last4_no REGEXP '^[0-9]{1,4}$' THEN c.last4_no ELSE NULL END AS tail FROM card_base c ${CARD_BANK_JOIN}
          WHERE c.user_id = ? AND c.is_deleted = 0 AND c.status = '正常'${cardConditions}
          ORDER BY c.sort, c.id LIMIT 101`, cardParams);
        if (choices.cards.length > ROW_LIMIT) throw new AiError('账户候选超过一百个，请缩小范围或手动操作', 400, 'AI_SCOPE_TOO_LARGE');
        dedupeCardNames(choices.cards);
      }
      if (needsCategories) {
        // Mirrors filterCandidateRows: an explicit direction wins; plain
        // "支出/收入" in filter becomes a direction, not a literal name match.
        const direction = ['expense', 'income'].includes(input.direction) ? input.direction
          : input.filter === '支出' ? 'expense' : input.filter === '收入' ? 'income' : null;
        const nameFilter = ['支出', '收入'].includes(input.filter) ? ''
          : typeof input.filter === 'string' ? input.filter : '';
        const categoryParams = [userId];
        let categoryConditions = '';
        if (direction) {
          categoryConditions += ' AND type = ?';
          categoryParams.push(direction);
        }
        if (nameFilter) {
          categoryConditions += ' AND INSTR(LOWER(name), LOWER(?)) > 0';
          categoryParams.push(nameFilter);
        }
        const categories = await select(`SELECT id, name, type FROM bus_category WHERE user_id = ?
          AND is_deleted = 0 AND type IN ('income', 'expense')${categoryConditions} ORDER BY sort, id LIMIT 101`, categoryParams);
        if (categories.length > ROW_LIMIT) throw new AiError('分类候选超过一百个，请缩小范围或手动操作', 400, 'AI_SCOPE_TOO_LARGE');
        choices.categories = categories.filter(isSupportedDraftCategory);
      }

      for (const domain of domains) {
        if (candidateOnly && !candidateDomains.has(domain)) continue;
        if (domain === 'finance') {
          const total = (await select(`SELECT ${forDirection(1)} AS income,
            ${forDirection(0)} AS expense,
            COUNT(*) AS count, COALESCE(SUM(${unpriced}), 0) AS unpricedCount FROM account a WHERE ${financeValid}`, range))[0] || {};
          const summary = { ...normalize([total], ['income', 'expense'])[0], currency: 'CNY', startDate, endDate,
            incomplete: Number(total.unpricedCount || 0) > 0 };
          const policy = '消费口径：剔除转账、信用卡还款、已删除及冲正；已知外币按每笔有效冻结汇率折人民币至分。缺失或无效币种、缺失或非正汇率未计入金额，不能视为完整总额；全部未定价时金额为空。';
          add(domain, 'monthly', '收支月度趋势', [column('month', '月份', 'date'), column('income', '收入', 'money'),
            column('expense', '支出', 'money'), column('count', '笔数', 'number'), column('unpricedCount', '未定价笔数', 'number')],
          await select(`SELECT LEFT(a.trans_date, 7) AS month,
            ${forDirection(1)} AS income,
            ${forDirection(0)} AS expense,
            COUNT(*) AS count, COALESCE(SUM(${unpriced}), 0) AS unpricedCount FROM account a WHERE ${financeValid}
            GROUP BY LEFT(a.trans_date, 7) ORDER BY month LIMIT 101`, range), policy, summary);
          add(domain, 'categories', '分类收支', [column('direction', '收支方向', 'number'), column('category', '分类'),
            column('amountCNY', '金额（人民币）', 'money'), column('count', '笔数', 'number'), column('unpricedCount', '未定价笔数', 'number'),
            column('firstDate', '首笔日期', 'date'), column('lastDate', '末笔日期', 'date')],
          await select(`SELECT a.category_id AS categoryId, a.direction, COALESCE(c.name, '未分类') AS category,
            ${valuedTotal} AS amountCNY, COUNT(*) AS count, COALESCE(SUM(${unpriced}), 0) AS unpricedCount,
            MIN(LEFT(a.trans_date, 10)) AS firstDate, MAX(LEFT(a.trans_date, 10)) AS lastDate
            FROM account a LEFT JOIN bus_category c ON c.id = a.category_id AND c.user_id = a.user_id AND c.is_deleted = 0
            WHERE ${financeValid} GROUP BY a.category_id, a.direction, COALESCE(c.name, '未分类') ORDER BY amountCNY DESC LIMIT 101`, range), policy, summary);
          add(domain, 'transactions', '收支明细', [column('date', '日期', 'date'), column('direction', '收支方向', 'number'),
            column('amount', '原币金额', 'decimal'), column('currency', '币种'), column('amountCNY', '金额（人民币）', 'money'),
            column('category', '分类'), column('remark', '备注')], await select(`SELECT a.id, a.card_id AS cardId,
            a.category_id AS categoryId, LEFT(a.trans_date, 10) AS date, a.direction, a.amount, ${verifiedCurrency} AS currency,
            ${cny} AS amountCNY, COALESCE(c.name, '未分类') AS category, a.remark FROM account a
            LEFT JOIN bus_category c ON c.id = a.category_id AND c.user_id = a.user_id AND c.is_deleted = 0
            WHERE ${financeValid} ORDER BY a.trans_date DESC, a.id DESC LIMIT 101`, range), policy, summary);
        } else if (domain === 'account') {
          add(domain, 'balances', '账户余额快照', [column('name', '账户'), column('type', '账户类型'), column('balance', '余额', 'money'),
            column('currency', '币种'), column('updatedAt', '最后保存时间')], await datasetRows('account-balances', `SELECT c.id AS cardId, c.sort AS sourceSort,
            ${CARD_NAME} AS name, c.card_type AS type, b.balance, b.currency, b.update_time AS updatedAt
            FROM card_base c LEFT JOIN account_balance b ON b.card_id = c.id AND b.user_id = c.user_id AND b.is_deleted = 0 ${CARD_BANK_JOIN}
            WHERE c.user_id = ? AND c.is_deleted = 0 ORDER BY c.sort, c.id LIMIT 101`, [userId]),
          '读取账户已保存余额快照；没有快照返回空值，不重建余额。不同币种不能直接相加；信用卡负余额为负债。', {}, { coverage: 'saved-balance-snapshot' });
        } else if (domain === 'card') {
          const today = new Date(new Date(now()).getTime() + 8 * 3600000).toISOString().slice(0, 10);
          const cards = await datasetRows('card-cards', `SELECT c.id AS cardId, c.sort AS sourceSort, ${CARD_NAME} AS name, c.card_type AS type,
            c.share_pool_id AS poolId, c.credit_limit AS creditLimit, c.temp_limit AS tempLimit, c.bill_day AS billDay,
            c.repay_day AS repayDay, c.expire_date AS savedExpiration, c.status FROM card_base c ${CARD_BANK_JOIN}
            WHERE c.user_id = ? AND c.is_deleted = 0 ORDER BY c.sort, c.id LIMIT 101`, [userId]);
          add(domain, 'cards', '卡片清单与基础设置', [column('name', '卡片'), column('type', '类型'), column('creditLimit', '固定额度', 'money'),
            column('tempLimit', '临时额度', 'money'), column('billDay', '账单日', 'number'), column('repayDay', '还款日', 'number'),
            column('expirationMonth', '登记到期月份', 'date'), column('nextRepayDate', '下次配置还款日', 'date'), column('status', '状态')],
          cards.map(({ savedExpiration, ...card }) => ({ ...card, expirationMonth: expirationMonth(savedExpiration),
            nextRepayDate: card.type === 'credit' ? nextRepaymentDate(card.repayDay, today) : null }))
            .sort((left, right) => (left.nextRepayDate ? 0 : 1) - (right.nextRepayDate ? 0 : 1)
              || String(left.nextRepayDate || '').localeCompare(String(right.nextRepayDate || ''))),
          '卡片清单（别名、卡类型）与基础设置（账单日、还款日、到期、共享池）同属本数据集，一次取数即可回答清单或设置问题，不必再取第二个卡数据集；信用卡已按下次配置还款日升序排在前（借记卡/无日期在后），问「哪张最近到期、哪张快该还款」直接看前几行。', {},
          { userPolicy: '到期按登记月份展示，不猜具体到期日；下次还款日按配置与当前上海日期计算，月不足按月底，仅日期参考，不代表有欠款或已安排还款。共享池额度不能逐卡相加，不同步账单/还款/对账。' });
          add(domain, 'counts', '本人卡片数量', [column('type', '类型'), column('count', '数量', 'number')],
          await datasetRows('card-counts', `SELECT card_type AS type,
            CASE card_type WHEN 'credit' THEN '信用卡' WHEN 'debit' THEN '借记卡'
              WHEN 'virtual_balance' THEN '虚拟余额' WHEN 'virtual_cash' THEN '现金'
              WHEN 'virtual_wechat' THEN '微信' WHEN 'virtual_alipay' THEN '支付宝' ELSE card_type END AS displayType,
            COUNT(*) AS count FROM card_base WHERE user_id = ?
            AND is_deleted = 0 GROUP BY card_type ORDER BY card_type LIMIT 101`, [userId]),
          '按本人未删除卡片类型统计全部数量，包含挂失/注销保存记录；正常候选单独列出，不用展示分页数量冒充全量。');
          const matches = choices.cards.filter(card => card.name && !isAnonymousCardName(card.name) && card.name.length >= 2 && (input.message || '').includes(card.name));
          const cardFilter = matches.length === 1 ? ' AND a.card_id = ?' : '';
          const suppliedTypes = Array.isArray(input.cardTypes) ? input.cardTypes.filter(type => CARD_TYPES.includes(type)) : [];
          const requestedTypes = suppliedTypes.length ? suppliedTypes : statedCardTypes(input.message || '').filter(type => ['credit', 'debit'].includes(type));
          const typeFilter = requestedTypes.length ? ` AND c.card_type IN (${requestedTypes.map(() => '?').join(',')})` : '';
          const monthlyParams = [...range, ...(matches.length === 1 ? [matches[0].id] : []), ...requestedTypes];
          const textFilter = input.datasetId === 'card-monthlyConsumption' && typeof input.filter === 'string' &&
            !['信用卡', '借记卡', '储蓄卡', '现金', '虚拟余额'].includes(input.filter) ? input.filter : '';
          const nameFilter = textFilter ? ` AND ${CARD_NAME} LIKE ? ESCAPE '='` : '';
          if (textFilter) monthlyParams.push(`%${textFilter.replace(/=/g, '==').replace(/%/g, '=%').replace(/_/g, '=_')}%`);
          const groupBy = input.datasetId === 'card-monthlyConsumption' && CARD_CONSUMPTION.acceptedArgs.groupings.includes(input.groupBy)
            ? input.groupBy : CARD_CONSUMPTION.defaults.groupBy;
          const cardQueryInput = { ...input, scope, filter: textFilter, cardTypes: requestedTypes, groupBy,
            direction: 'expense', sort: CARD_RANKING_SORTS.includes(input.sort) ? input.sort : CARD_CONSUMPTION.defaults.sort };
          let monthlyPlan = useLargeRead && input.datasetId === 'card-monthlyConsumption' ? planQuery(cardQueryInput, userId, now()) : null;
          if (monthlyPlan && groupBy === 'card' && monthlyPlan.resolution !== 'detail')
            monthlyPlan = planQuery({ ...cardQueryInput, resolution: 'detail' }, userId, now());
          if (monthlyPlan && groupBy === 'cardMonth' && monthlyPlan.resolution === 'detail')
            monthlyPlan = planQuery({ ...cardQueryInput, resolution: 'month' }, userId, now());
          let periodLength = monthlyPlan?.resolution === 'year' ? 4 : 7;
          let monthProjection = groupBy === 'cardMonth' ? `LEFT(a.trans_date, ${periodLength}) AS month, ` : '';
          let monthGrouping = groupBy === 'cardMonth' ? `LEFT(a.trans_date, ${periodLength}), ` : '';
          const monthlyOrder = groupBy === 'cardMonth' ? 'month DESC, a.card_id' : 'a.card_id';
          const monthlySort = CARD_RANKING_SORTS.includes(input.sort) ? `amountCNY DESC, ${monthlyOrder}` : monthlyOrder;
          let monthlyFacts;
          if (input.datasetId === 'card-monthlyConsumption') {
            const getFacts = async () => (await select(`SELECT ${valuedTotal} AS expense, COUNT(*) AS count,
              COALESCE(SUM(${unpriced}), 0) AS unpricedCount,
              COUNT(DISTINCT a.card_id${groupBy === 'cardMonth' ? `, LEFT(a.trans_date, ${periodLength})` : ''}) AS matchedRowCount
              FROM account a JOIN card_base c ON c.id = a.card_id AND c.user_id = a.user_id AND c.is_deleted = 0 ${CARD_BANK_JOIN}
              WHERE ${financeValid} AND a.direction = 0${cardFilter}${typeFilter}${nameFilter}`, monthlyParams))[0];
            let facts = await getFacts();
            if (monthlyPlan?.resolution === 'month' && Number(facts?.matchedRowCount) > monthlyPlan.limit && !input.cursor
              && (input.resolution == null || input.resolution === 'auto') && !CARD_RANKING_SORTS.includes(input.sort)) {
              monthlyPlan = planQuery({ ...cardQueryInput, resolution: 'year' }, userId, now());
              periodLength = 4;
              monthProjection = groupBy === 'cardMonth' ? 'LEFT(a.trans_date, 4) AS month, ' : '';
              monthGrouping = groupBy === 'cardMonth' ? 'LEFT(a.trans_date, 4), ' : '';
              facts = await getFacts();
            }
            if (monthlyPlan && (!facts || ['matchedRowCount', 'count', 'unpricedCount'].some(key => facts[key] == null
              || !Number.isSafeInteger(Number(facts[key])) || Number(facts[key]) < 0)
              || Number(facts.matchedRowCount) > Number(facts.count) || Number(facts.unpricedCount) > Number(facts.count)))
              throw new AiError('卡消费全范围数量无效', 503, 'AI_READ_INVALID_COUNT');
            if (facts && Number.isSafeInteger(Number(facts.matchedRowCount))) monthlyFacts = {
              summary: { ...normalize([facts], ['expense'])[0], count: Number(facts.count), expenseCount: Number(facts.count), incomeCount: 0,
                unpricedCount: Number(facts.unpricedCount), currency: 'CNY', incomplete: Number(facts.unpricedCount) > 0 },
              matchedRowCount: Number(facts.matchedRowCount), sort: CARD_RANKING_SORTS.includes(input.sort) ? input.sort : CARD_CONSUMPTION.defaults.sort,
              cardTypes: requestedTypes, filter: textFilter, groupBy, direction: 'expense' };
          }
          const monthlyRaw = await select(`SELECT
            a.card_id AS cardId, ${monthProjection}${CARD_NAME} AS name, c.card_type AS cardType,
            'CNY' AS currency, ${valuedTotal} AS amountCNY, COUNT(*) AS count,
            COALESCE(SUM(${unpriced}), 0) AS unpricedCount,
            ${monthlyPlan ? 'MIN(LEFT(a.trans_date, 10)) AS firstDate, MAX(LEFT(a.trans_date, 10)) AS lastDate,' : ''}
            GROUP_CONCAT(DISTINCT COALESCE(${verifiedCurrency}, 'unknown') ORDER BY a.currency SEPARATOR ',') AS sourceCurrencies
            FROM account a JOIN card_base c ON c.id = a.card_id AND c.user_id = a.user_id AND c.is_deleted = 0 ${CARD_BANK_JOIN}
            WHERE ${financeValid} AND a.direction = 0${cardFilter}${typeFilter}${nameFilter}
            GROUP BY a.card_id, ${monthGrouping}c.alias, bank.name, c.last4_no, c.card_type ORDER BY ${monthlySort} ${monthlyPlan ? 'LIMIT ? OFFSET ?' : 'LIMIT 101'}`,
            monthlyPlan ? [...monthlyParams, monthlyPlan.limit + 1, monthlyPlan.offset] : monthlyParams);
          const monthlyRows = monthlyRaw.map(({ cardType, ...row }) => ({ ...row, type: CARD_TYPE_LABELS[cardType] || '其他卡片' }));
          if (monthlyPlan && (monthlyPlan.offset > monthlyFacts.matchedRowCount
            || monthlyRaw.length !== Math.min(monthlyPlan.limit + 1, monthlyFacts.matchedRowCount - monthlyPlan.offset)))
            throw new AiError('卡消费数量与返回窗口不一致', 503, 'AI_READ_INVALID_RESULT');
          const monthlySummary = monthlyFacts?.summary || (monthlyRaw.length <= ROW_LIMIT ? summarizeCardMonthly(monthlyRows) : {});
          const monthlyColumns = [...(groupBy === 'cardMonth' ? [column('month', monthlyPlan?.resolution === 'year' ? '消费年份' : '消费月', 'date')] : []), column('name', '卡片'),
            column('type', '类型'), column('currency', '统计币种'), column('amountCNY', '已定价消费', 'money'), column('count', '消费笔数', 'number'),
            column('unpricedCount', '未定价笔数', 'number'), column('sourceCurrencies', '原币种')];
          const monthlyTitle = groupBy === 'card' ? '按卡区间消费统计（人民币）' : monthlyPlan?.resolution === 'year' ? '按卡消费年度统计（人民币）' : '按卡消费月度统计（人民币）';
          const monthlyPolicy = `消费流水口径而非账单：剔除转账/还款/删除/冲正，${groupBy === 'card' ? '按查询日期范围逐卡合计，每行一张卡' : monthlyPlan?.resolution === 'year' ? '按消费年逐卡统计' : '按消费月逐卡统计'}，已知币种按有效冻结汇率折人民币至分；币种或汇率不可靠的消费未计金额，全部未定价时金额为空，不是完整总额。只在用户明确匹配唯一别名时限制单卡，否则展示候选；有限结果不能自行合成全量。`;
          if (monthlyPlan) {
            const rows = normalize(monthlyRows.slice(0, monthlyPlan.limit), ['amountCNY']);
            const page = pageInfo(monthlyPlan, monthlyFacts.matchedRowCount, rows.length, asOf);
            const dates = rows.flatMap(row => [row.firstDate, row.lastDate]).filter(date => validDate(date)).sort();
            datasets.push({ datasetId: 'card-monthlyConsumption', domain: 'card', title: monthlyTitle, columns: monthlyColumns, rows,
              summary: monthlySummary, policy: monthlyPolicy + ' 日期完整保留；汇总与排名在全量匹配消费上计算，展示页不用于重新合计。',
              asOf, isEstimated: false, totalCount: monthlyFacts.matchedRowCount, truncated: page.hasMore || monthlyPlan.offset > 0,
              queryMeta: { version: 1, queryId, datasetId: 'card-monthlyConsumption', requestedScope: input.requestedScope || { startDate, endDate },
                effectiveScope: { startDate, endDate }, filters: { direction: 'expense', text: textFilter,
                  ...(requestedTypes.length ? { cardTypes: requestedTypes } : {}) }, sort: monthlyFacts.sort, groupBy,
                matchedRowCount: monthlyFacts.matchedRowCount, returnedRowCount: rows.length, sourceRecordCount: monthlySummary.count,
                rowsComplete: monthlyPlan.offset === 0 && rows.length === monthlyFacts.matchedRowCount,
                summaryComplete: true, rankingComplete: monthlyPlan.offset === 0 && CARD_RANKING_SORTS.includes(input.sort) && monthlySummary.unpricedCount === 0,
                returnedDateRange: dates.length ? { startDate: dates[0], endDate: dates.at(-1) } : null,
                asOf, resolution: monthlyPlan.resolution, page } });
          } else add(domain, 'monthlyConsumption', monthlyTitle, monthlyColumns, monthlyRows, monthlyPolicy, monthlySummary,
            { aggregates: { expense: { column: 'amountCNY', kind: 'money' }, count: { column: 'count', kind: 'number' } },
              ...(monthlyFacts ? { cardMonthlyQuery: monthlyFacts } : {}) });
          add(domain, 'bills', '信用卡账单快照', [column('name', '信用卡'), column('month', '账单月', 'date'),
            column('billAmount', '本期账单', 'money'), column('needRepay', '待还', 'money'), column('repaid', '已还', 'money'),
            column('repayStatus', '还款状态'), column('updatedAt', '最后保存时间')], await datasetRows('card-bills', `SELECT b.id,
            b.card_id AS cardId, ${CARD_NAME} AS name, b.bill_month AS month,
            b.bill_start_date AS startDate, b.bill_end_date AS endDate, b.bill_amount AS billAmount, b.need_repay AS needRepay,
            b.repaid, b.repay_status AS repayStatus, b.update_time AS updatedAt FROM card_bill b
            JOIN card_base c ON c.id = b.card_id AND c.user_id = b.user_id AND c.is_deleted = 0 ${CARD_BANK_JOIN}
            WHERE b.user_id = ? AND b.is_deleted = 0 AND c.card_type = 'credit' AND b.bill_month >= ? AND b.bill_month <= ?
            ORDER BY b.bill_month DESC, b.card_id LIMIT 101`, [userId, startDate.slice(0, 7), endDate.slice(0, 7)]),
          '已保存账单快照，可能尚未同步最新流水；跨月待还不能直接相加当作总欠款，不执行精密重算。', {}, { coverage: 'saved-bill-snapshot' });
          add(domain, 'repayments', '信用卡还款历史', [column('name', '信用卡'), column('month', '账单月', 'date'),
            column('amount', '还款金额', 'money'), column('date', '还款时间'), column('method', '方式')], await datasetRows('card-repayments', `SELECT r.id,
            r.card_id AS cardId, ${CARD_NAME} AS name, r.bill_month AS month,
            r.repay_amount AS amount, r.repay_time AS date, r.repay_method AS method,
            'CNY' AS currency FROM card_repay r
            JOIN card_base c ON c.id = r.card_id AND c.user_id = r.user_id AND c.is_deleted = 0 ${CARD_BANK_JOIN}
            WHERE r.user_id = ? AND r.is_deleted = 0 AND r.repay_time >= ? AND r.repay_time < DATE_ADD(?, INTERVAL 1 DAY)
            AND (r.account_id IS NULL OR NOT EXISTS (SELECT 1 FROM account a2 WHERE a2.id = r.account_id
              AND a2.user_id = r.user_id AND a2.is_deleted = 1)) ORDER BY r.repay_time DESC, r.id LIMIT 101`, range),
          '仅历史已保存还款记录，不把计划当还款，不开放实际还款。');
          add(domain, 'pools', '共享额度池配置', [column('name', '共享池'), column('creditLimit', '固定额度', 'money'), column('tempLimit', '临时额度', 'money')],
          await datasetRows('card-pools', `SELECT id AS poolId, bank_name AS name, total_credit_limit AS creditLimit, total_temp_limit AS tempLimit
            FROM card_credit_pool WHERE user_id = ? AND is_deleted = 0 ORDER BY id LIMIT 101`, [userId]),
          '共享额度以池为单位计一次；此处为保存的配置，不代表实时可用额度。');
        } else if (domain === 'budget') {
          const keywords = budgetKeywords(input.message);
          const keywordCondition = keywords.length ? ' AND (' + keywords.map(() => '(title LIKE ? OR route LIKE ? OR budget_details LIKE ?)')
            .join(/或者|或/.test(input.message || '') ? ' OR ' : ' AND ') + ')' : '';
          const keywordParams = keywords.flatMap(term => Array(3).fill(`%${term}%`));
          add(domain, 'plans', '预算计划', [column('title', '计划'), column('type', '类型'), column('planned', '预算金额', 'money'),
            column('registeredUsed', '登记使用额', 'money'), column('remaining', '登记剩余额', 'money'), column('cycle', '周期'),
            column('date', '计划日期', 'date'), column('executed', '是否执行', 'number')], await datasetRows('budget-plans', `SELECT id, title,
            budget_type AS type, budget_amount AS planned, used_amount AS registeredUsed, ROUND(budget_amount - used_amount, 2) AS remaining,
            cycle, LEFT(plan_date, 10) AS date, is_excute AS executed FROM budget WHERE user_id = ? AND is_deleted = 0
            AND plan_date >= ? AND plan_date <= ?${keywordCondition} ORDER BY plan_date DESC, id LIMIT 101`, [...range, ...keywordParams]),
          `预算 used_amount 是手动登记使用额，不是实际流水消费。${keywords.length ? `固定关键词候选：${keywords.join('、')}；仅参数化匹配标题/路线/明细，多个命中不自动选中。` : '没有明确固定关键词时不自动过滤。'}按获准日期读取，不外发原明细JSON，不改计划/执行状态。`);
        } else if (domain === 'todo') {
          const firstYear = Number(startDate.slice(0, 4)), lastYear = Number(endDate.slice(0, 4));
          const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
          const yearSql = years.map(year => `SELECT ${year} AS occurrenceYear`).join(' UNION ');
          const rows = add(domain, 'events', '待办日程', [column('content', '内容'), column('type', '事件类型'), column('date', '范围内发生日期', 'date'),
            column('originalDate', '原登记日期', 'date'),
            column('status', '保存状态'), column('priority', '优先级', 'number'), column('isRecurring', '每年重复', 'number'), column('remark', '备注')],
          await datasetRows('todo-events', `SELECT ai_todo.id, ai_todo.content, ai_todo.type, ai_todo.date, ai_todo.originalDate,
            ai_todo.status, ai_todo.priority, ai_todo.isRecurring, ai_todo.remark FROM (
              SELECT id, content, event_type AS type, LEFT(happen_date, 10) AS originalDate,
                CASE WHEN is_recurring = 1 THEN CONCAT(years.occurrenceYear, '-', RIGHT(LEFT(happen_date, 10), 5))
                  ELSE LEFT(happen_date, 10) END AS date, status, priority, is_recurring AS isRecurring, remark
              FROM todo JOIN (${yearSql}) AS years
              WHERE user_id = ? AND is_deleted = 0 AND content <> '1'
                AND (is_recurring = 1 OR years.occurrenceYear = YEAR(happen_date))
                AND (is_recurring <> 1 OR DAY(happen_date) <= DAY(LAST_DAY(CONCAT(years.occurrenceYear, '-', MONTH(happen_date), '-01'))))
            ) AS ai_todo WHERE ai_todo.date >= ? AND ai_todo.date <= ?
            ORDER BY date, priority, id LIMIT 101`, range),
          '剔除飞机模式占位；每年重复事件按范围内实际发生日期展示，同时保留原登记日期；非闰年的二月二十九日不生成事件。状态为保存值，不自动完成或修改提醒。');
          choices.todos = rows.map(({ id, content, status, date }) => ({ id, name: content, status, date }));
        } else if (domain === 'work') {
          const totals = (await select(`SELECT COALESCE(SUM(s.income), 0) AS income, COUNT(*) AS count FROM work_salary s
            JOIN work_job j ON j.id = s.job_id AND j.user_id = s.user_id AND j.is_deleted = 0
            WHERE s.user_id = ? AND s.is_deleted = 0 AND s.work_date_dt BETWEEN ? AND ?`, range))[0] || {};
          add(domain, 'salary', '已登记每日工资', [column('date', '日期', 'date'), column('company', '工作'), column('type', '类型'),
            column('hours', '工时', 'decimal'), column('daySalary', '基本工资', 'money'), column('subsidy', '补贴', 'money'),
            column('deductions', '扣款合计', 'money'), column('income', '实得记录', 'money'), column('status', '保存状态', 'number')],
          await datasetRows('work-salary', `SELECT s.id, s.job_id AS jobId, DATE_FORMAT(s.work_date_dt, '%Y-%m-%d') AS date,
            j.company, s.job_type AS type, s.work_hours AS hours, s.day_salary AS daySalary, s.subsidy,
            ROUND(s.cut + s.social + s.fund + s.tax, 2) AS deductions, s.income, s.status FROM work_salary s
            JOIN work_job j ON j.id = s.job_id AND j.user_id = s.user_id AND j.is_deleted = 0
            WHERE s.user_id = ? AND s.is_deleted = 0 AND s.work_date_dt BETWEEN ? AND ? ORDER BY s.work_date_dt DESC, s.id LIMIT 101`, range),
          '只读已保存工资记录；实得工资记录不代表账户到账。没有记录不能当作零工资，不触发自动生成或补写。', normalize([totals], ['income'])[0]);
          add(domain, 'rules', '工资规则参考', [column('company', '工作'), column('type', '类型'), column('status', '任职状态', 'number'),
            column('baseSalary', '月基本工资', 'money'), column('workDays', '标准工作日', 'number'), column('hourlyWage', '时薪', 'money'),
            column('dailyEstimate', '正式工每日参考估算', 'money')], await datasetRows('work-rules', `SELECT id AS jobId, company, job_type AS type, status,
            base_salary AS baseSalary, base_work_days AS workDays, hourly_wage AS hourlyWage, join_date AS joinDate, leave_date AS leaveDate,
            CASE WHEN job_type = 'formal' AND status = 1 THEN ROUND(
              ROUND(base_salary / COALESCE(NULLIF(base_work_days, 0), 22), 2) - ROUND(social / COALESCE(NULLIF(base_work_days, 0), 22), 2)
              - ROUND(fund / COALESCE(NULLIF(base_work_days, 0), 22), 2)
              - ROUND(ROUND(base_salary / COALESCE(NULLIF(base_work_days, 0), 22), 2) * tax_rate / 100, 2), 2) ELSE NULL END AS dailyEstimate
            FROM work_job WHERE user_id = ? AND is_deleted = 0 ORDER BY status DESC, id LIMIT 101`, [userId]),
          '纯 SQL 每日规则参考估算，不是工资流水；月补贴不按日计入，未提供兼职工时不估算收入，具体日期仍需符合入职/离职范围。', {}, { isEstimated: true });
        } else if (domain === 'asset') {
          const columns = [column('date', '日期', 'date'), column('totalAsset', '流动资产', 'money'), column('creditDebt', '信用卡负债', 'money'),
            column('netAsset', '净资产', 'money'), column('recordedAt', '保存时间')];
          add(domain, 'snapshots', '流动资产系统快照', columns, await datasetRows('asset-snapshots', `SELECT id, record_date AS date,
            total_asset AS totalAsset, credit_debt AS creditDebt, total_balance AS netAsset, record_time AS recordedAt
            FROM asset_snapshot WHERE user_id = ? AND is_deleted = 0 AND record_date BETWEEN ? AND ? ORDER BY record_date DESC, id LIMIT 101`, range),
          '已保存流动资产快照，范围不含固定资产和基金；总额无币种字段，旧生成逻辑可能混币，不能视为已证明人民币总额；不重建余额或重新清算。', { currency: 'unverified' }, { coverage: 'liquid-assets-snapshot' });
          add(domain, 'registers', '手工资产登记', columns, await datasetRows('asset-registers', `SELECT id, register_date AS date,
            total_asset AS totalAsset, credit_debt AS creditDebt, total_balance AS netAsset, register_time AS recordedAt
            FROM asset_register WHERE user_id = ? AND is_deleted = 0 AND register_date BETWEEN ? AND ? ORDER BY register_date DESC, id LIMIT 101`, range),
          '手工核算登记，与系统流动资产快照分别呈现；总额未登记币种，不声称已证明人民币或自动比较差额；不读取原始资产JSON，不把两者重复相加。', { currency: 'unverified' }, { coverage: 'manual-asset-register' });
          add(domain, 'composition', '已保存账户余额组成（分币种）', [column('type', '账户类型'), column('currency', '保存币种'),
            column('positiveAssets', '非信用正资产', 'money'), column('creditDebt', '信用负余额', 'money'),
            column('creditOverflow', '信用正余额', 'money'), column('otherDebt', '非信用负余额', 'money'),
            column('count', '账户数', 'number'), column('missingSnapshots', '缺快照或币种', 'number'),
            column('minUpdatedAt', '最早快照时间'), column('maxUpdatedAt', '最新快照时间')], await datasetRows('asset-composition', `SELECT
            c.card_type AS type, COALESCE(b.currency, '未登记') AS currency, COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN c.card_type <> 'credit' AND b.balance >= 0 THEN b.balance ELSE 0 END), 0) AS positiveAssets,
            COALESCE(SUM(CASE WHEN c.card_type = 'credit' AND b.balance < 0 THEN -b.balance ELSE 0 END), 0) AS creditDebt,
            COALESCE(SUM(CASE WHEN c.card_type = 'credit' AND b.balance > 0 THEN b.balance ELSE 0 END), 0) AS creditOverflow,
            COALESCE(SUM(CASE WHEN c.card_type <> 'credit' AND b.balance < 0 THEN -b.balance ELSE 0 END), 0) AS otherDebt,
            COALESCE(SUM(b.card_id IS NULL OR b.currency IS NULL), 0) AS missingSnapshots,
            MIN(b.update_time) AS minUpdatedAt, MAX(b.update_time) AS maxUpdatedAt
            FROM card_base c LEFT JOIN account_balance b ON b.card_id = c.id AND b.user_id = c.user_id AND b.is_deleted = 0
            WHERE c.user_id = ? AND c.is_deleted = 0 GROUP BY c.card_type, COALESCE(b.currency, '未登记')
            ORDER BY c.card_type, currency LIMIT 101`, [userId]),
          '仅读已保存余额，按账户类型和币种分组，绝不混币。非信用正资产、信用负余额/正余额、其它负余额分开；信用余额快照不等于CreditCore实时欠款，不以共享额度当负债；缺快照不重建，缺项不能视为完整总额。', {}, { coverage: 'saved-balance-by-type-currency' });
          add(domain, 'comparison', '同日手工登记与系统保存值对照', [column('date', '同日日期', 'date'),
            column('manualNetAsset', '手工保存净值（币种未确认）', 'money'), column('systemNetAsset', '系统保存净值（币种未确认）', 'money'),
            column('netDifference', '可比人民币差额', 'money'), column('currency', '币种证据'), column('reason', '可比限制')],
          await datasetRows('asset-comparison', `SELECT r.register_date AS date, r.total_balance AS manualNetAsset, s.total_balance AS systemNetAsset,
            NULL AS netDifference, 'unverified' AS currency, '保存总额无币种字段，系统旧快照可能混币；不能证明同口径人民币，不推导差额' AS reason
            FROM asset_register r JOIN asset_snapshot s ON s.user_id = r.user_id AND s.record_date = r.register_date AND s.is_deleted = 0
            WHERE r.user_id = ? AND r.is_deleted = 0 AND r.register_date BETWEEN ? AND ?
            AND NOT EXISTS (SELECT 1 FROM asset_register newer WHERE newer.user_id = r.user_id AND newer.is_deleted = 0
              AND newer.register_date = r.register_date AND (newer.register_time > r.register_time OR
                (newer.register_time = r.register_time AND newer.id > r.id)))
            AND NOT EXISTS (SELECT 1 FROM asset_snapshot newer WHERE newer.user_id = s.user_id AND newer.is_deleted = 0
              AND newer.record_date = s.record_date AND (newer.record_time > s.record_time OR
                (newer.record_time = s.record_time AND newer.id > s.id)))
            ORDER BY r.register_date DESC LIMIT 101`, range),
          '只对照同日双方最新已保存总额，不跨日期、不补快照、不改变数据。两张总额表无currency列且旧系统现金SUM未分币种，不能证明同口径CNY，差额保持空值；不是异常账务判断，也不推导汇率或进行对账。', { currency: 'unverified' }, { coverage: 'same-day-saved-totals-unverified-currency' });
        } else if (domain === 'fixedAsset') {
          const includeDeleted = /回收站|恢复|彻底删除|永久删除/.test(input.message || '');
          const rows = add(domain, 'saved', '固定资产账面快照', [column('name', '资产'), column('tag', '品类'), column('buyPrice', '购买价', 'money'),
            column('savedValue', '已保存账面价值', 'money'), column('secondhandPrice', '登记二手价', 'money'), column('monthlyDepreciation', '登记月折旧', 'money'),
            column('totalDepreciation', '登记累计折旧', 'money'), column('lastDepreciationDate', '上次折旧日期', 'date'), column('status', '状态'),
            column('isDeleted', '在回收站', 'number')],
          await datasetRows('fixedAsset-saved', `SELECT id, info AS name, tag, buy_price AS buyPrice, now_val AS savedValue, secondhand_price AS secondhandPrice,
            month_deprec AS monthlyDepreciation, total_deprec AS totalDepreciation, buy_date AS buyDate,
            last_deprec_date AS lastDepreciationDate, status, is_deleted AS isDeleted FROM fixed_asset WHERE user_id = ?
            AND is_deleted IN (0, ?) ORDER BY is_deleted DESC, buy_date DESC, id LIMIT 101`, [userId, includeDeleted ? 1 : 0]),
          '仅读已保存账面值，可能未折旧到今天；不调用会自动折旧的列表接口，不执行正式折旧或精密重算。', {}, { coverage: 'saved-fixed-asset-values' });
          choices.fixedAssets = rows.map(({ id, name, status, isDeleted }) => ({ id, name, status: Number(isDeleted) === 1 ? '回收站' : status }));
        } else if (domain === 'fund') {
          if (candidateOnly) {
            // A fund candidate needs only id/name from the fund source table.
            // The holdings aggregate JOINs bus_fund_history, an unrelated ledger
            // whose failure must not block or delay a fund candidate.
            const candidates = await select(`SELECT f.id, f.fund_name AS name FROM fund f
              WHERE f.user_id = ? AND f.is_deleted = 0 ORDER BY f.id LIMIT 101`, [userId]);
            choices.funds = candidates.map(({ id, name }) => ({ id, name }));
          } else {
            const base = 'COALESCE(CAST(f.invest AS DECIMAL(16,4)), 0)';
            const profit = 'COALESCE(CAST(h.net_value AS DECIMAL(16,4)), 0)';
            const capital = 'COALESCE(CAST(h.market_val AS DECIMAL(16,4)), 0)';
            const legacy = `(${capital} = ${base} AND ABS(${profit}) > ABS(${base}) * 0.5)`;
            const profitExpr = `CASE WHEN ${legacy} THEN ${profit} - ${base} ELSE ${profit} END`;
            const capitalExpr = `CASE WHEN ${legacy} THEN 0 ELSE ${capital} END`;
            const rows = add(domain, 'holdings', '基金登记汇总', [column('name', '基金'), column('principal', '登记本金', 'money'),
              column('profit', '已登记收益合计', 'decimal'), column('marketValue', '登记市值', 'money'), column('lastReportDate', '最后登记日期', 'date')],
            await datasetRows('fund-holdings', `SELECT f.id, f.fund_name AS name, ROUND(${base} + COALESCE(SUM(${capitalExpr}), 0), 2) AS principal,
              ROUND(COALESCE(SUM(${profitExpr}), 0), 4) AS profit,
              ROUND(${base} + COALESCE(SUM(${capitalExpr}), 0) + COALESCE(SUM(${profitExpr}), 0), 2) AS marketValue,
              f.last_report_date AS lastReportDate FROM fund f LEFT JOIN bus_fund_history h ON h.fund_id = f.id
              WHERE f.user_id = ? AND f.is_deleted = 0 GROUP BY f.id, f.fund_name, f.invest, f.last_report_date
              ORDER BY f.id LIMIT 101`, [userId]),
            '基金历史 net_value 为用户收益增量、market_val 为本金增量，兼容旧快照口径；仅登记汇总，AI 不推算收益、本金或汇率。');
            choices.funds = rows.map(({ id, name }) => ({ id, name }));
            add(domain, 'history', '基金日收益登记历史', [column('name', '基金'), column('date', '登记日期', 'date'),
              column('profit', '收益增量', 'decimal'), column('capitalDelta', '本金增量', 'money')],
            await datasetRows('fund-history', `SELECT h.id, h.fund_id AS fundId, f.fund_name AS name, LEFT(h.record_date, 10) AS date,
              ROUND(${profitExpr}, 4) AS profit, ROUND(${capitalExpr}, 2) AS capitalDelta FROM bus_fund_history h
              JOIN fund f ON f.id = h.fund_id AND f.user_id = ? AND f.is_deleted = 0
              WHERE h.record_date >= ? AND h.record_date <= ? ORDER BY h.record_date DESC, h.id LIMIT 101`, range),
            '仅已登记历史及旧快照兼容转换；不取基金账户、交易账户，不补齐缺失收益或本金。');
          }
        } else if (domain === 'installment') {
          const raw = await datasetRows('installment-plans', `SELECT r.id, r.name, r.amount, r.repeat_count AS periods, r.is_active AS active,
            r.next_date AS nextDate, r.end_date AS endDate, r.month_records AS monthRecords FROM bus_recurring r
            LEFT JOIN bus_category c ON c.id = r.category_id AND c.user_id = r.user_id AND c.is_deleted = 0
            WHERE r.user_id = ? AND r.is_deleted = 0 AND (c.name = '分期' OR r.account_id LIKE '%"type":"installment"%')
            ORDER BY r.is_active DESC, r.next_date, r.id LIMIT 101`, [userId]);
          // Never externalize account_id/month_records JSON: it contains actual card/flow IDs.
          const safeRows = raw.map(({ monthRecords, ...row }) => {
            let records;
            try { records = typeof monthRecords === 'string' ? JSON.parse(monthRecords) : monthRecords; } catch (_) { records = null; }
            const states = { pending: 0, entered: 0, void: 0, entering: 0, unknown: 0 };
            for (const [month, entry] of Object.entries(records || {}).slice(0, 120)) {
              if (!/^\d{4}-\d{2}$/.test(month) || month < startDate.slice(0, 7) || month > endDate.slice(0, 7)) continue;
              const status = entry && typeof entry === 'object' ? entry.status : undefined;
              states[Object.hasOwn(states, status) ? status : 'unknown'] += 1;
            }
            return { ...row, ...states };
          });
          add(domain, 'plans', '分期计划与保存状态', [column('name', '计划'), column('amount', '每期计划金额', 'money'),
            column('periods', '总期数', 'number'), column('active', '启用状态', 'number'), column('nextDate', '计划下次日期', 'date'),
            column('pending', '范围内待入账', 'number'), column('entered', '范围内已入账', 'number'), column('void', '范围内中止', 'number'),
            column('entering', '范围内入账中', 'number'), column('unknown', '范围内未知状态', 'number')], safeRows,
          '只读已保存期次状态；不触发自动作废、入账或账单对账。计划金额不是消费；未知状态不能当已入账。');
        }
      }
      return { scope, datasets, choices, asOf };
    }, completeRangeRead);
  }
  async function queryDataset(userId, input = {}) {
    if (typeof userId !== 'string' || !userId || userId.length > 64) throw new AiError('当前用户无效', 401, 'AI_USER_INVALID');
    const spec = prepareFinanceDatasetQuery(input);
    const scope = validateScope({ ...(input.scope || {}), domains: ['finance'] }, now());
    const asOf = new Date(now()).toISOString();
    return read(select => readFinanceDataset({ select, userId, scope, spec, asOf, financeValid, decimalString }), true);
  }
  return { query, queryDataset, close: () => (!executor && pool ? pool.end() : Promise.resolve()) };
}

module.exports = { createBusinessReadRepository, validateScope, decimalString, nextRepaymentDate, expirationMonth, budgetKeywords, savedTimestamp, DOMAINS, ROW_LIMIT };
