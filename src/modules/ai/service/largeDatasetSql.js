'use strict';

const { AiError } = require('./errors');
const column = (key, label, type = 'text') => ({ key, label, type });
const q = key => `ai_source.\`${key}\``;
const sum = (key, digits = 2) => `ROUND(SUM(${q(key)}), ${digits}) AS \`${key}\``;
// Models choose only registered datasets/granularity. All SQL projections are fixed.
const DEFINITIONS = Object.freeze({
  'work-salary': {
    groups: ['company', 'type'], amounts: { hours: 2, daySalary: 2, subsidy: 2, deductions: 2, income: 2 },
    columns: [column('company', '工作'), column('type', '类型'), column('hours', '工时', 'decimal'),
      column('daySalary', '登记基本工资合计', 'money'), column('subsidy', '登记补贴合计', 'money'),
      column('deductions', '登记扣款合计', 'money'), column('income', '登记实得合计', 'money')],
    policy: '按期间、工作单位和类型聚合已登记工资；合计不证明账户到账。',
  },
  'fund-history': {
    groups: ['name'], amounts: { profit: 4, capitalDelta: 2 },
    columns: [column('name', '基金'), column('profit', '登记收益增量合计', 'decimal'), column('capitalDelta', '登记本金增量合计', 'money')],
    policy: '按期间和基金聚合登记收益及本金增量；未登记日期不补零，不把登记增量解释为单位净值或每日市值。',
  },
  'budget-plans': {
    groups: ['type'], amounts: { planned: 2, registeredUsed: 2, remaining: 2 },
    columns: [column('type', '预算类型'), column('planned', '计划金额合计', 'money'),
      column('registeredUsed', '登记使用额合计', 'money'), column('remaining', '登记剩余额合计', 'money')],
    policy: '按期间和预算类型聚合计划保存值；登记使用额不等于消费流水，不修改计划状态。',
  },
  'todo-events': {
    groups: ['type', 'status'], amounts: {},
    columns: [column('type', '事件类型'), column('status', '保存状态')],
    policy: '按期间、事件类型和保存状态计数；待完成与已完成分别展示，不推断完成时间。',
  },
  'card-repayments': {
    groups: ['currency'], amounts: { amount: 2 },
    columns: [column('currency', '统计币种'), column('amount', '登记还款额合计', 'money')],
    policy: '登记还款额为人民币，按期间汇总，不把该金额解释为原外币消费金额。',
  },
});
const SNAPSHOTS = new Set(['asset-snapshots', 'asset-registers']);
const isAggregateDataset = id => Object.hasOwn(DEFINITIONS, id) || SNAPSHOTS.has(id);

function aggregateSql(datasetId, resolution, filteredSql, params) {
  if (!['month', 'year'].includes(resolution)) return null;
  const length = resolution === 'month' ? 7 : 4;
  if (SNAPSHOTS.has(datasetId)) {
    return {
      // MySQL 5.7: anti-join selects exactly the last matching snapshot per period.
      sql: `SELECT ai_source.* FROM (${filteredSql}) AS ai_source WHERE NOT EXISTS (SELECT 1 FROM (${filteredSql}) AS ai_newer
        WHERE LEFT(ai_newer.\`date\`, ${length}) = LEFT(ai_source.\`date\`, ${length})
          AND (ai_newer.\`date\` > ai_source.\`date\`
            OR ai_newer.\`date\` = ai_source.\`date\` AND COALESCE(ai_newer.\`recordedAt\`, '') > COALESCE(ai_source.\`recordedAt\`, '')
            OR ai_newer.\`date\` = ai_source.\`date\` AND COALESCE(ai_newer.\`recordedAt\`, '') = COALESCE(ai_source.\`recordedAt\`, '') AND ai_newer.\`id\` > ai_source.\`id\`))`,
      params: [...params, ...params], order: '`date` ASC, `id` ASC',
      columns: [column('date', resolution === 'month' ? '月末最后登记日期' : '年末最后登记日期', 'date'),
        column('totalAsset', '期末保存资产', 'money'), column('creditDebt', '期末保存负债', 'money'),
        column('netAsset', '期末保存净值', 'money'), column('recordedAt', '保存时间')],
      policy: '每期选择范围内最后一条匹配快照，绝不把存量资产跨日期相加；查询边界所在期只覆盖请求范围内记录。',
      summaryComplete: false, amounts: {},
    };
  }
  const definition = DEFINITIONS[datasetId];
  if (!definition) throw new AiError('此数据集不支持月或年聚合，请使用明细续查', 400, 'AI_TOOL_ARGUMENT_INVALID');
  const period = `LEFT(${q('date')}, ${length})`;
  const groups = definition.groups.map(q);
  const fields = [`${period} AS \`date\``, ...groups.map((expression, index) => `${expression} AS \`${definition.groups[index]}\``),
    ...Object.entries(definition.amounts).map(([key, digits]) => sum(key, digits)), 'COUNT(*) AS `count`',
    `MIN(LEFT(${q('date')}, 10)) AS firstDate`, `MAX(LEFT(${q('date')}, 10)) AS lastDate`];
  return {
    sql: `SELECT ${fields.join(', ')} FROM (${filteredSql}) AS ai_source GROUP BY ${[period, ...groups].join(', ')}`,
    params, order: ['`date` ASC', ...definition.groups.map(key => `\`${key}\` ASC`)].join(', '),
    columns: [column('date', resolution === 'month' ? '月份' : '年份', 'date'), ...definition.columns, column('count', '来源登记条数', 'number')],
    policy: definition.policy, amounts: definition.amounts, summaryComplete: true,
  };
}

function totalsSql(datasetId, filteredSql) {
  const definition = DEFINITIONS[datasetId];
  const fields = ['COUNT(*) AS sourceRecordCount', 'MIN(LEFT(ai_source.`date`, 10)) AS firstDate', 'MAX(LEFT(ai_source.`date`, 10)) AS lastDate'];
  if (definition) for (const [key, digits] of Object.entries(definition.amounts)) fields.push(sum(key, digits));
  if (datasetId === 'card-repayments') fields.push('COUNT(DISTINCT ai_source.`currency`) AS currencyCount', 'MIN(ai_source.`currency`) AS currency');
  return `SELECT ${fields.join(', ')} FROM (${filteredSql}) AS ai_source`;
}

function normalizeTotals(datasetId, row, decimalString) {
  const count = Number(row?.sourceRecordCount);
  if (row?.sourceRecordCount == null || !Number.isSafeInteger(count) || count < 0) throw new AiError('数据集来源数量无效', 503, 'AI_READ_INVALID_COUNT');
  const definition = DEFINITIONS[datasetId];
  const summary = { count };
  if (definition) for (const [key, digits] of Object.entries(definition.amounts)) {
    if (datasetId === 'card-repayments' && Number(row.currencyCount) !== 1) continue;
    summary[key] = decimalString(row[key], digits);
  }
  if (datasetId === 'card-repayments' && Number(row.currencyCount) === 1) summary.currency = row.currency;
  if (SNAPSHOTS.has(datasetId)) summary.currency = 'unverified';
  return { sourceRecordCount: count, summary,
    summaryComplete: Boolean(definition) && (datasetId !== 'card-repayments' || Number(row.currencyCount) === 1 && row.currency && row.currency !== 'unknown') };
}

module.exports = { aggregateSql, totalsSql, normalizeTotals, isAggregateDataset };
