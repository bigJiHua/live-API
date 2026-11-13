const crypto = require('crypto');
const { AiError } = require('./errors');
const { financeQueryMoney } = require('./financeQueryMoney');
const { DATASETS: DATASET_DOMAINS, SORTS, FINANCE_DIRECTIONS: DIRECTIONS, getDatasetCapability } = require('./datasetCapabilities');
const { markToolParameterError } = require('./toolRecovery');
const { planQuery, pageInfo } = require('./largeQuery');

const DATASETS = Object.freeze(Object.keys(DATASET_DOMAINS).filter(id => DATASET_DOMAINS[id] === 'finance'));
const MONEY = financeQueryMoney();
const CATEGORY = "COALESCE(c.name, '未分类')";
const JOIN = 'FROM account a LEFT JOIN bus_category c ON c.id = a.category_id AND c.user_id = a.user_id AND c.is_deleted = 0';
const POLICY = '消费口径：剔除转账、信用卡还款、已删除及冲正；已知外币按每笔有效冻结汇率折人民币至分。缺失或无效币种、缺失或非正汇率未计入金额，不能视为完整总额；全部未定价时金额为空。';
const col = (key, label, type = 'text') => ({ key, label, type });
const invalid = (path = '$') => markToolParameterError(new AiError('查询筛选或排序参数无效', 400, 'AI_TOOL_ARGUMENT_INVALID'),
  [{ path, rule: 'dataset.reader' }]);

function prepareFinanceDatasetQuery(input = {}) {
  const { datasetId } = input;
  const capability = getDatasetCapability(datasetId);
  // Keep undefined-only input defaults; explicit null still fails validation.
  const defaults = capability?.inputDefaults;
  const direction = input.direction === undefined ? defaults?.direction : input.direction;
  const sort = input.sort === undefined ? defaults?.sort : input.sort;
  const limit = input.limit === undefined ? defaults?.limit : input.limit;
  const filter = input.filter == null ? '' : input.filter;
  const resolution = input.resolution === undefined ? 'auto' : input.resolution;
  if (!DATASETS.includes(datasetId) || !Object.hasOwn(DIRECTIONS, direction)
    || typeof filter !== 'string' || filter.length > 80 || !Number.isInteger(limit) || limit < 1 || limit > 50
    || !SORTS.includes(sort) || !['auto', 'detail', 'month', 'year'].includes(resolution)) throw invalid();
  if (['finance-transactions', 'finance-categories'].includes(datasetId) && !['auto', 'detail'].includes(resolution)) throw invalid('resolution');
  if (input.cursor != null && (typeof input.cursor !== 'string' || input.cursor.length > 2048)) throw invalid('cursor');
  if (filter && !capability.acceptedArgs.filter.reader) throw invalid('filter');
  if (!capability.acceptedArgs.readerSorts.includes(sort)) throw invalid('sort');
  if (input.queryId != null && (typeof input.queryId !== 'string' || !/^q_[a-f0-9]{24}$/.test(input.queryId)))
    throw new AiError('查询筛选或排序参数无效', 400, 'AI_TOOL_ARGUMENT_INVALID');
  return { datasetId, direction, sort: capability.normalization.sort || sort,
    filter, limit, queryId: input.queryId || `q_${crypto.randomBytes(12).toString('hex')}`,
    requestedScope: input.requestedScope, resolution: datasetId === 'finance-monthly' && resolution === 'detail' ? 'month' : resolution,
    limitExplicit: input.limitExplicit === undefined ? input.limit !== undefined : input.limitExplicit,
    ...(input.cursor ? { cursor: input.cursor } : {}) };
}

// Counts are exact nonnegative integers. Missing values stay unknown, never zero.
function count(value) {
  if (value == null) return null;
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new AiError('数据库数量格式无效', 503, 'AI_READ_INVALID_COUNT');
  }
  return Number(text);
}

function dateRange(rows, dateKey) {
  if (!dateKey || !rows.length) return null;
  const dates = rows.map(row => row[dateKey]).filter(value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value));
  if (dates.length !== rows.length) return null;
  dates.sort();
  return { startDate: dates[0], endDate: dates[dates.length - 1] };
}

async function readFinanceDataset({ select, userId, scope, spec, asOf, financeValid, decimalString }) {
  const { datasetId, direction, filter, sort, queryId } = spec;
  let plan = planQuery({ ...spec, scope }, userId, new Date(asOf));
  const params = [userId, scope.startDate, scope.endDate];
  let where = financeValid;
  if (DIRECTIONS[direction] != null) {
    where += ' AND a.direction = ?';
    params.push(DIRECTIONS[direction]);
  }
  if (filter) {
    const expressions = datasetId === 'finance-transactions' ? [CATEGORY, "COALESCE(a.remark, '')", MONEY.currency] : [CATEGORY];
    where += ` AND (${expressions.map(expression => `INSTR(LOWER(${expression}), LOWER(?)) > 0`).join(' OR ')})`;
    params.push(...expressions.map(() => filter));
  }
  const from = `${JOIN} WHERE ${where}`;
  const total = (await select(`SELECT ${MONEY.forDirection(1)} AS income, ${MONEY.forDirection(0)} AS expense,
    COUNT(*) AS count, COALESCE(SUM(CASE WHEN a.direction = 1 THEN 1 ELSE 0 END), 0) AS incomeCount,
    COALESCE(SUM(CASE WHEN a.direction = 0 THEN 1 ELSE 0 END), 0) AS expenseCount,
    COALESCE(SUM(${MONEY.unpriced}), 0) AS unpricedCount ${from}`, params))[0];
  if (!total) throw new AiError('查询汇总未返回有效结果', 503, 'AI_READ_INVALID_RESULT');
  const sourceRecordCount = count(total.count);
  const unpricedCount = count(total.unpricedCount);
  const summary = { income: decimalString(total.income), expense: decimalString(total.expense),
    count: sourceRecordCount, incomeCount: count(total.incomeCount), expenseCount: count(total.expenseCount),
    unpricedCount, currency: 'CNY', startDate: scope.startDate, endDate: scope.endDate,
    incomplete: unpricedCount == null || unpricedCount > 0 };
  let columns, selection, grouping = '', ordering, title, dateKey = null, groupKey;
  if (datasetId === 'finance-transactions') {
    title = '收支明细';
    columns = [col('date', '日期', 'date'), col('direction', '收支方向', 'number'), col('amount', '原币金额', 'decimal'),
      col('currency', '币种'), col('amountCNY', '金额（人民币）', 'money'), col('category', '分类'), col('remark', '备注')];
    selection = `a.id, a.card_id AS cardId, a.category_id AS categoryId, LEFT(a.trans_date, 10) AS date,
      a.direction, a.amount, ${MONEY.currency} AS currency, ${MONEY.cny} AS amountCNY, ${CATEGORY} AS category, a.remark`;
    ordering = sort === 'amountDesc' ? 'amountCNY IS NULL, amountCNY DESC, a.trans_date DESC, a.id DESC' : 'a.trans_date DESC, a.id DESC';
    dateKey = 'date';
  } else if (datasetId === 'finance-categories') {
    title = '分类收支';
    columns = [col('direction', '收支方向', 'number'), col('category', '分类'), col('amountCNY', '金额（人民币）', 'money'),
      col('count', '笔数', 'number'), col('unpricedCount', '未定价笔数', 'number'), col('firstDate', '首笔日期', 'date'), col('lastDate', '末笔日期', 'date')];
    selection = `a.category_id AS categoryId, a.direction, ${CATEGORY} AS category, ${MONEY.total} AS amountCNY,
      COUNT(*) AS count, COALESCE(SUM(${MONEY.unpriced}), 0) AS unpricedCount,
      MIN(LEFT(a.trans_date, 10)) AS firstDate, MAX(LEFT(a.trans_date, 10)) AS lastDate`;
    grouping = ` GROUP BY a.category_id, a.direction, ${CATEGORY}`;
    groupKey = `a.category_id, a.direction, ${CATEGORY}`;
    // MySQL cannot use a grouped aggregate alias inside another ORDER BY expression.
    // Descending order already places NULL after every priced amount.
    ordering = 'amountCNY DESC, a.direction, a.category_id';
  }
  const setPeriodLayout = resolution => {
    const daily = datasetId === 'finance-daily';
    const key = daily ? 'date' : 'month';
    const width = resolution === 'year' ? 4 : resolution === 'month' || !daily ? 7 : 10;
    const label = width === 4 ? '年份' : width === 7 ? '月份' : '日期';
    title = width === 4 ? '收支年度趋势' : width === 7 ? '收支月度趋势' : '收支每日汇总';
    columns = [col(key, label, 'date'), col('income', '收入', 'money'), col('expense', '支出', 'money'),
      col('count', '笔数', 'number'), col('unpricedCount', '未定价笔数', 'number')];
    selection = `LEFT(a.trans_date, ${width}) AS ${key}, ${MONEY.forDirection(1)} AS income,
      ${MONEY.forDirection(0)} AS expense, COUNT(*) AS count, COALESCE(SUM(${MONEY.unpriced}), 0) AS unpricedCount`;
    groupKey = `LEFT(a.trans_date, ${width})`;
    grouping = ` GROUP BY ${groupKey}`;
    ordering = daily && sort === 'expenseDesc' ? 'expense DESC, date DESC'
      : daily && sort === 'incomeDesc' ? 'income DESC, date DESC' : daily ? 'date DESC' : 'month ASC';
    dateKey = daily && width === 10 ? 'date' : null;
  };
  if (['finance-monthly', 'finance-daily'].includes(datasetId)) setPeriodLayout(plan.resolution);
  let matchedRowCount = sourceRecordCount;
  const countGroups = async () => {
    const matched = (await select(`SELECT COUNT(*) AS matchedRowCount FROM (SELECT ${groupKey} ${from}${grouping}) matched_groups`, params))[0];
    return count(matched?.matchedRowCount);
  };
  if (grouping) matchedRowCount = await countGroups();
  // Preserve an explicit month/day request. Automatic trends spanning more
  // than one display page can use complete annual groups instead of dropping
  // earlier months. This happens only on the first page of an unbounded auto
  // request; a cursor never silently changes its bound aggregation grain.
  if (['finance-monthly', 'finance-daily'].includes(datasetId) && spec.resolution === 'auto'
    && plan.resolution === 'month' && plan.isLargeRange && !spec.limitExplicit && !spec.cursor
    && plan.offset === 0 && matchedRowCount > plan.limit) {
    plan = planQuery({ ...spec, scope, resolution: 'year' }, userId, new Date(asOf));
    setPeriodLayout(plan.resolution);
    matchedRowCount = await countGroups();
  }
  const { limit, offset } = plan;
  const raw = await select(`SELECT ${selection} ${from}${grouping} ORDER BY ${ordering} LIMIT ?${offset ? ' OFFSET ?' : ''}`,
    [...params, limit + 1, ...(offset ? [offset] : [])]);
  const rows = raw.slice(0, limit).map(row => {
    const normalized = { ...row };
    for (const column of columns) {
      if (column.type === 'money') normalized[column.key] = decimalString(row[column.key]);
      else if (column.type === 'decimal') normalized[column.key] = decimalString(row[column.key], row.currency === 'CNY' ? 2 : 4);
      else if (column.type === 'number') normalized[column.key] = count(row[column.key]);
    }
    return normalized;
  });
  if (matchedRowCount != null && (raw.length !== Math.min(limit + 1, Math.max(0, matchedRowCount - offset))
    || (sourceRecordCount != null && matchedRowCount > sourceRecordCount))) {
    throw new AiError('查询数量与明细不一致', 503, 'AI_READ_INVALID_RESULT');
  }
  const rowsComplete = offset === 0 && matchedRowCount != null && matchedRowCount === rows.length;
  const summaryComplete = sourceRecordCount != null;
  const rankingComplete = offset === 0 && summaryComplete && matchedRowCount != null && unpricedCount === 0
    && (getDatasetCapability(datasetId).effectiveMeta.rankingSorts.includes(sort) || rowsComplete);
  const queryMeta = { version: 1, queryId, datasetId,
    requestedScope: { startDate: spec.requestedScope?.startDate || scope.startDate, endDate: spec.requestedScope?.endDate || scope.endDate },
    effectiveScope: { startDate: scope.startDate, endDate: scope.endDate },
    filters: { direction, text: filter }, sort, matchedRowCount, returnedRowCount: rows.length, sourceRecordCount,
    rowsComplete, summaryComplete, rankingComplete,
    returnedDateRange: dateRange(rows, dateKey), asOf, resolution: plan.resolution,
    page: pageInfo(plan, matchedRowCount, rows.length, asOf) };
  let policy = `${POLICY} 本次先按日期、收支方向及文本筛选全范围，再统计和排序；汇总笔数是匹配收支流水数，结果行数按数据集粒度计数。`;
  if (filter) policy += ' 文本筛选采用字面子串，汇总与明细使用相同筛选条件。';
  if (plan.resolution !== 'detail') policy += ` 展示粒度为${plan.resolution === 'year' ? '年' : '月'}，每行是该期间的服务端汇总，不能当作单日或单笔。`;
  if (offset) policy += ` 当前从匹配结果第 ${offset + 1} 行继续展示，不包含前面页的明细；全范围合计仍由服务器直接统计。`;
  if (!rowsComplete) policy += ` 本次返回 ${rows.length} 行，未返回全部匹配结果；全范围汇总不以已返回行重新相加。`;
  if (unpricedCount == null || unpricedCount > 0) policy += ' 包含未定价记录或估值覆盖未确定，金额排名仅能描述已定价记录，不能确认完整范围的最大值。';
  else if (!rankingComplete) policy += ' 当前明细未全部返回且未按金额排名，不能根据这一日期窗口确认完整范围的最大值。';
  if (queryMeta.returnedDateRange && !rowsComplete) policy += ' 返回日期只描述已返回行，边界日期可能仍有未返回记录。';
  const dataset = { datasetId, domain: 'finance', title, columns, rows, summary, queryMeta, policy, asOf,
    isEstimated: false, truncated: offset > 0 || raw.length > limit || (matchedRowCount != null && matchedRowCount > rows.length) };
  return { scope, datasets: [dataset], choices: { cards: [], categories: [], funds: [], todos: [], fixedAssets: [], moods: [] }, asOf };
}

module.exports = { prepareFinanceDatasetQuery, readFinanceDataset };
