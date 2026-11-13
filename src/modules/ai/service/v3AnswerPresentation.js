// 追加168：从 v3Service.js 纯移动的答复呈现与校验函数群（零逻辑变化）。
// 只依赖模块级 import 与本文件常量，不触碰 createV3Service 闭包状态；
// v3Service 仍对外 re-export validateChart / buildQueryAnswer / withScopePolicy，
// 测试与外部模块的导入路径不变。授权复验→声明校验→事务提交→恢复载荷的
// 编排顺序留在 v3Service，本文件不承载任何编排逻辑。
const { AiError } = require('./errors');
const { FINALIZE_PROMPT } = require('./v3Prompt');
const { languageInstruction } = require('./responseLanguage');
const { isSavedTimestamp, stripVerifiedClockTokens } = require('./queryTemporalProse');
const { stripProvenDailyConditionCountTokens, normalizeDailyConditionClaims } = require('./queryDailyConditionClaims');
const { stripVerifiedShortDates, stripVerifiedMonthlyCalendarTokens } = require('./queryDateProse');
const { normalizeSavedTimestampDisplay } = require('./queryTimestampDisplay');
const { normalizeFinancialRankClaims } = require('./queryFinancialRankClaims');
const { normalizeNumericTextLabels, validRepaymentAmountClaims } = require('./queryRepaymentProse');
const { validCountClaims } = require('./queryCountClaims');
const { validMonthlyTransactionClaims } = require('./queryMonthlyProse');
const { validWindowClaims } = require('./queryWindowClaims');
const { validFundAmountClaims, fundQueryFacts, fundQueryExplanation } = require('./queryFundProse');
const { normalizeQueryPagination, clearOrphanQueryHeadings } = require('./queryCoverageProse');
const { cardCountsPartialRowsTable } = require('./queryCountRankClaims');
const { selectQueryTaskBinding } = require('./queryTaskBindings');
const { createEgressPolicy } = require('./egressPolicy');

function buildFinalizationMessages(messages, responseLanguage, prompt = FINALIZE_PROMPT) {
  // Retain paired native tool messages, but remove unverified intermediate prose.
  // reasoning_content on a tool-call message is a provider transport requirement.
  const approved = messages.filter(message => message.role === 'system' || message.role === 'user' || message.role === 'tool'
    || message.role === 'assistant' && Array.isArray(message.tool_calls)).map(message => message.role === 'assistant'
    ? { ...message, content: null } : message);
  return [...approved, { role: 'user', content: [prompt, languageInstruction(responseLanguage)].filter(Boolean).join('\n') }];
}

function validateChart(chart, datasets, scope, wantsChart = false) {
  // A model-chosen chart must not stand in for the answer: only draw when the
  // user's own words ask for one.
  if (!wantsChart) return { chart: null, note: '' };
  if (!chart) return { chart: null, note: datasets.some(item => !item.rows.length)
    ? '本轮查询没有可绘制的记录，未生成图表。' : '' };
  const matches = datasets.filter(item => item.datasetId === chart.datasetId && (!chart.queryId || item.queryMeta?.queryId === chart.queryId));
  const dataset = matches.length === 1 ? matches[0] : null;
  if (!dataset || !dataset.columns.some(column => column.key === chart.xKey) ||
      chart.yKeys.some(key => !dataset.columns.some(column => column.key === key && ['money', 'decimal', 'number'].includes(column.type)))) {
    throw new AiError('图表只能引用本轮服务器返回的有效数据列', 400, 'AI_CHART_INVALID');
  }
  // A zero-row chart is dropped with a notice instead of throwing: throwing
  // would discard the whole answer, and the client validator must stay untouched
  // because it also validates already-persisted history messages.
  if (!dataset.rows.length) return { chart: null, note: '本轮查询没有可绘制的记录，未生成图表。' };
  if (chart.type === 'pie') {
    if (chart.yKeys.length !== 1) return { chart: null, note: '饼图需要一个数值指标，本次保留查询数据供查看。' };
    if (dataset.rows.some(row => row[chart.yKeys[0]] != null && Number(row[chart.yKeys[0]]) < 0))
      return { chart: null, note: '本轮数据包含负数，不适合绘制饼图；查询数据已保留。' };
  }
  if (dataset.datasetId === 'card-monthlyConsumption' && dataset.queryMeta?.groupBy === 'cardMonth' && chart.xKey === 'month') {
    if (chart.type === 'pie') return { chart: null, note: '不同卡片的月度消费适合使用折线图或柱状图，本次保留逐卡明细。' };
    const pairs = new Set();
    for (const row of dataset.rows) {
      const pair = JSON.stringify([row.cardRef || row.name, row.month]);
      if (pairs.has(pair)) return { chart: null, note: '逐卡月度记录存在重复，未生成可能失真的图表；本次保留查询明细。' };
      pairs.add(pair);
    }
  }
  const ownScope = dataset.queryMeta?.effectiveScope || scope;
  const period = dataset.datasetId !== 'card-counts' && ownScope?.startDate && ownScope?.endDate ? `（${ownScope.startDate} 至 ${ownScope.endDate}）` : '';
  const currencyNote = dataset.summary?.currency === 'unverified' && chart.yKeys.some(key =>
    (dataset.columns || []).some(column => column.key === key && column.type === 'money')) ? '（币种未确认）' : '';
  const verifiedTitle = `${dataset.title}${period}`.slice(0, 80 - currencyNote.length) + currencyNote;
  return { chart: { ...chart, ...(dataset.queryMeta ? { queryId: dataset.queryMeta.queryId } : {}), title: verifiedTitle }, note: '' };
}
// Query-round prose is number-verified, not banned: the model may freely quote
// amounts/counts/totals, but every number in a sentence must match a value
// published by this round's datasets (summary fields or money/number row cells).
// Sentences with any unmatched number are dropped wholesale (invented or
// mis-summed statistics); period words like 上个月 no longer kill a sentence —
// date fragments are stripped before extraction so "2026-10-01" never
// contributes digits. Empty datasets therefore ban all numbered prose.
const DATE_TOKEN_PATTERN = /\d{4}-\d{1,2}-\d{1,2}|\b20\d{2}-(?:0[1-9]|1[0-2])\b(?!-\d)|\d{1,2}月\d{1,2}日|\d{4}\s*年(?:\d{1,2}\s*月)?(?:\d{1,2}\s*日)?|\d{1,2}\s*月(?:初|中|底)?/g;
const NUMBER_TOKEN_PATTERN = /\d[\d,]*(?:\.\d+)?/g;
// 面向用户的答复不暴露实现细节（服务端/接口/数据卡）或推诿式免责声明。
const MODEL_IMPLEMENTATION_SENTENCE = /[^。；;！？\n]*(?:服务端|接口|数据卡|以卡片为准)[^。；;！？\n]*/g;
function allowedNumberValues(datasets) {
  const values = new Set();
  const labels = new Set();
  const add = raw => {
    const number = Number(String(raw ?? '').replace(/,/g, ''));
    if (Number.isFinite(number)) { values.add(number); values.add(Math.abs(number)); }
  };
  for (const dataset of datasets || []) {
    for (const value of Object.values(dataset?.summary || {})) add(value);
    for (const key of ['matchedRowCount', 'returnedRowCount', 'sourceRecordCount']) {
      if (dataset.queryMeta?.[key] != null) add(dataset.queryMeta[key]);
    }
    const columns = Array.isArray(dataset?.columns) ? dataset.columns : [];
    const keys = columns.filter(column => ['money', 'number', 'decimal'].includes(column.type)).map(column => column.key);
    const textKeys = columns.filter(column => column.type === 'text').map(column => column.key);
    for (const row of dataset?.rows || []) {
      for (const key of keys) add(row[key]);
      // 卡名/别名等文本值内嵌的数字（如「尾号8888」）随值本身豁免：
      // 引用数据集文本的句子不应因标签里的数字被整句删除。
      for (const key of textKeys) {
        const label = String(row[key] ?? '').trim();
        if (label.length >= 2 && /\d/.test(label) && !isSavedTimestamp(label)) labels.add(label);
      }
    }
  }
  return { values, labels };
}
function sentenceNumbers(sentence, labels, datasets) {
  // Ordered-list markers are presentation, never amounts or record counts.
  const temporal = stripVerifiedClockTokens(stripProvenDailyConditionCountTokens(sentence, datasets), datasets);
  const shortDates = stripVerifiedShortDates(temporal.text, datasets);
  const calendar = stripVerifiedMonthlyCalendarTokens(shortDates.text, datasets);
  let text = calendar.text.replace(/^\s*(?:[（(]\d+[）)]|\d+(?:[.．](?!\d)|[)）、]))\s*/, '');
  for (const label of labels || []) if (text.includes(label)) text = text.split(label).join(' ');
  const numbers = (text.replace(DATE_TOKEN_PATTERN, ' ').match(NUMBER_TOKEN_PATTERN) || [])
    .map(token => Number(token.replace(/,/g, ''))).filter(number => Number.isFinite(number));
  return temporal.unsupported || shortDates.unsupported || calendar.unsupported ? [...numbers, NaN] : numbers;
}
function scrubModelProse(answer, datasets) {
  const { values: allowed, labels } = allowedNumberValues(datasets);
  const chunks = normalizeFinancialRankClaims(normalizeDailyConditionClaims(normalizeSavedTimestampDisplay(String(answer || '').replace(MODEL_IMPLEMENTATION_SENTENCE, ''), datasets), datasets), datasets)
    .match(/[^。；;！？\n]+[。；;！？]?|\n+/g) || [];
  const kept = chunks
    .map(chunk => /^\n+$/.test(chunk) ? chunk : stripVerifiedShortDates(normalizeNumericTextLabels(chunk, labels), datasets).text)
    .filter(chunk => /^\n+$/.test(chunk) || sentenceNumbers(chunk, labels, datasets).every(number => allowed.has(number))
      && validCountClaims(chunk, datasets) && validMonthlyTransactionClaims(chunk, datasets)
      && validWindowClaims(chunk, datasets) && validFundAmountClaims(chunk, datasets) && validRepaymentAmountClaims(chunk, datasets))
    .join('').replace(/\n{3,}/g, '\n\n');
  return normalizeQueryPagination(clearOrphanQueryHeadings(kept), datasets);
}
// Answer numbers are server-authored: the model never sums or rounds amounts.
// Per-type subtotals for the summary sentence (credit card vs cash etc.).
function typeSegments(dataset) {
  const columns = Array.isArray(dataset?.columns) ? dataset.columns : [];
  const typeColumn = columns.find(column => column.key === 'type');
  const money = columns.find(column => column.type === 'money');
  const number = columns.find(column => column.type === 'number');
  if (!typeColumn || !money || !dataset.rows?.length || dataset.truncated) return [];
  const groups = new Map();
  for (const row of dataset.rows) {
    const label = String(row[typeColumn.key] ?? '');
    const group = groups.get(label) || { label, cents: 0, count: 0 };
    group.cents += Math.round(Number(row[money.key] || 0) * 100);
    group.count += number ? Number(row[number.key] || 0) : 0;
    groups.set(label, group);
  }
  return [...groups.values()].sort((left, right) => right.cents - left.cents)
    .map(group => ({ label: group.label, amount: (group.cents / 100).toFixed(2), count: group.count }));
}
function markdownCell(value) {
  return String(value == null ? '—' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
// The detail table is server-authored; the total row only uses server summary
// values and is omitted when the read layer did not publish a total.
function rowsTable(dataset) {
  if (dataset?.datasetId === 'card-counts' && dataset.truncated === true) return cardCountsPartialRowsTable(dataset);
  if (!dataset || !Array.isArray(dataset.rows) || !dataset.rows.length || dataset.rows.length > 6 || dataset.truncated) return '';
  const columns = Array.isArray(dataset.columns) ? dataset.columns : [];
  const texts = columns.filter(column => column.type === 'text');
  const moneyColumns = columns.filter(column => column.type === 'money').slice(0, 2);
  const number = columns.find(column => column.type === 'number' && column.key === 'count');
  const date = columns.find(column => column.type === 'date');
  const picked = [];
  if (date && new Set(dataset.rows.map(row => row[date.key])).size > 1) picked.push(date);
  for (const column of [...texts.slice(0, 2), ...moneyColumns, number]) if (column && !picked.includes(column)) picked.push(column);
  if (picked.length < 2) return '';
  const lines = [`| ${picked.map(column => markdownCell(column.label)).join(' | ')} |`,
    `| ${picked.map(() => '---').join(' | ')} |`];
  for (const row of dataset.rows) lines.push(`| ${picked.map(column => markdownCell(row[column.key])).join(' | ')} |`);
  const summary = dataset.summary || {}, moneyPicked = picked.filter(column => column.type === 'money');
  const fallbackMoney = moneyPicked.length === 1
    ? ['expense', 'income', 'total', 'balance', 'estimatedTotal'].find(key => summary[key] != null) : null;
  const total = picked.map(column => {
    if (column.type === 'money') {
      const key = Object.hasOwn(summary, column.key) ? column.key : fallbackMoney;
      if (!key || summary[key] == null) return '';
      const currency = /^[A-Z]{3}$/.test(summary.currency || '') ? summary.currency : '币种待核验';
      return markdownCell(`${currency} ${summary[key]}`);
    }
    if (column.type === 'number' && summary.count != null) return markdownCell(summary.count);
    return '';
  });
  if (total.some(Boolean) && picked.some(column => column.type === 'text')) {
    total[Math.max(0, picked.findIndex(column => column.type === 'text'))] = '总计';
    lines.push(`| ${total.join(' | ')} |`);
  }
  return lines.join('\n');
}
// Financial query rounds keep the model's verified prose. Server-authored
// financial summaries are fallbacks when no usable prose remains. Scope,
// totals and rows stay on the data cards (withScopePolicy/card bodies).
// Multi-subject answers rebuild facts independently, so source-specific saved
// state and empty salary caveats must survive without the model's full prose.
function multitaskSavedFacts(datasets) {
  if (datasets.length !== 1) return null;
  const dataset = datasets[0];
  if (dataset.datasetId === 'work-salary' && !dataset.rows.length)
    return '该范围没有已保存的工资记录。没有记录不等于零工资，工资登记也不代表银行到账。';
  if (dataset.datasetId !== 'asset-snapshots') return null;
  if (!dataset.rows.length) return '该范围没有已保存的流动资产系统快照。';
  const fields = [['totalAsset', '流动资产'], ['creditDebt', '信用卡负债'], ['netAsset', '净资产']];
  const keys = new Set(dataset.columns.map(column => column.key));
  const lines = dataset.rows.slice(0, 6).map(row => {
    const facts = fields.filter(([key]) => keys.has(key) && row[key] != null)
      .map(([key, label]) => label + ' ' + markdownCell(row[key]));
    return `${markdownCell(row.date)} 保存快照：${facts.join('，')}。`;
  });
  const currency = dataset.summary?.currency;
  lines.push(/^[A-Z]{3}$/.test(currency || '') ? `保存金额币种为 ${currency}。`
    : '快照币种未确认，不能将保存总额视为已证明的人民币金额。');
  if (dataset.rows.length > 6) lines.push('正文展示部分快照，其余返回记录可在明细中查看。');
  return lines.join('\n\n');
}

function buildQueryAnswer(answer, datasets, queryContext = null, taskContext = null, taskBindings = [], { preserveAuxiliary = false } = {}) {
  if (preserveAuxiliary) {
    // Query facts remain server-derived. Keep the separately requested memory
    // or capability explanation after the same numeric evidence filtering.
    const explanation = scrubModelProse(answer, datasets);
    const facts = buildQueryAnswer('', datasets, queryContext, taskContext, taskBindings);
    return [...new Set([explanation, facts].filter(Boolean))].join('\n\n');
  }
  if (taskBindings.length) {
    // Independent facts must not depend on which tool happened to finish first.
    // Build each subject using only its own approved rows and query scope.
    const facts = taskBindings.map(binding => {
      const ownDatasets = datasets.filter(dataset => selectQueryTaskBinding(taskBindings, dataset.datasetId) === binding);
      if (!ownDatasets.length) {
        const labels = { cards: '卡片', finance: '收支', todo: '日程', budget: '预算', fund: '基金', fixedAsset: '固定资产' };
        return `${labels[binding.taskContext.subject] || '对应'}查询尚无本轮获准数据，暂时无法给出这部分结论。`;
      }
      const ownScope = ownDatasets[0].queryMeta?.effectiveScope || binding.taskContext.scope;
      const period = ownScope ? `（${ownScope.startDate} 至 ${ownScope.endDate}）` : '';
      return `${ownDatasets[0].title}${period}\n\n${multitaskSavedFacts(ownDatasets) ?? buildQueryAnswer('', ownDatasets, binding.queryContext, binding.taskContext)}`;
    }).filter(Boolean);
    if (taskBindings.some(binding => /原因|为什么|建议|分析/.test(binding.text))) {
      const explanation = scrubModelProse(answer, datasets);
      if (explanation) facts.push(explanation);
    }
    return facts.join('\n\n');
  }
  if (datasets.length && datasets.every(dataset => ['fund-holdings', 'fund-history'].includes(dataset.datasetId))) {
    const facts = fundQueryFacts(datasets);
    const explanation = fundQueryExplanation(scrubModelProse(answer, datasets), datasets);
    return [facts, explanation].filter(Boolean).join('\n\n');
  }
  const summary = datasets.map(item => item.summary).find(item => item && (item.income != null || item.expense != null || item.count != null));
  const primary = summary && datasets.find(item => item.summary === summary) || (datasets.length === 1 ? datasets[0] : null);
  const parts = [];
  if (summary) {
    const currency = summary.currency === 'unverified' ? '币种未确认' : summary.currency || 'CNY';
    if (summary.income != null) parts.push(`收入 ${currency} ${summary.income}`);
    if (summary.expense != null) parts.push(`支出 ${currency} ${summary.expense}`);
    if (summary.net != null) parts.push(`净收支 ${currency} ${summary.net}`);
    if (summary.count != null) parts.push(primary?.datasetId === 'card-monthlyConsumption' ? `共 ${summary.count} 笔消费`
      : primary?.domain === 'finance' && primary.queryMeta ? `共 ${summary.count} 笔收支` : `数量 ${summary.count}`);
    if (summary.expenseCount != null && primary?.datasetId !== 'card-monthlyConsumption') parts.push(`支出 ${summary.expenseCount} 笔`);
    if (summary.incomeCount != null && primary?.datasetId !== 'card-monthlyConsumption') parts.push(`收入 ${summary.incomeCount} 笔`);
    const segments = summary.expense != null ? typeSegments(primary) : [];
    if (segments.length > 1)
      parts.push(`其中 ${segments.map(segment => `${segment.label} CNY ${segment.amount}（${segment.count} 笔）`).join('、')}`);
  }
  const sentence = parts.length ? `${parts.join('，')}。` : '';
  const cardRankings = taskContext?.metric === 'card-consumption' ? datasets.filter(dataset => dataset.datasetId === 'card-monthlyConsumption'
    && dataset.queryMeta?.groupBy === 'card' && ['amountDesc', 'expenseDesc'].includes(dataset.queryMeta.sort)) : [];
  if (cardRankings.length === 1) {
    const dataset = cardRankings[0], meta = dataset.queryMeta, row = dataset.rows.find(item => item.amountCNY != null);
    const period = `${meta.effectiveScope.startDate} 至 ${meta.effectiveScope.endDate}`;
    if (!row) return `${period}没有可比较的已定价卡片消费。${Number(dataset.summary.unpricedCount || 0) > 0 ? '存在未定价消费，无法确认完整排名。' : ''}`;
    const fact = `${period}，${meta.rankingComplete ? '' : '按已定价消费，'}${row.name} 的累计支出最高，为 CNY ${row.amountCNY}。`;
    const ties = dataset.rows.filter(item => item.amountCNY === row.amountCNY);
    return [fact, ties.length > 1 ? `已返回结果中有 ${ties.length} 张卡并列最高。` : '',
      Number(dataset.summary.unpricedCount || 0) > 0 ? '存在未定价消费，完整排名尚不能确认。' : ''].filter(Boolean).join('\n\n');
  }
  const cardMonths = taskContext?.metric === 'card-consumption' && !taskContext.comparisonScopes?.length
    ? datasets.filter(dataset => dataset.datasetId === 'card-monthlyConsumption'
      && dataset.queryMeta?.groupBy === 'cardMonth' && dataset.rows.length) : [];
  if (cardMonths.length === 1) {
    const dataset = cardMonths[0], meta = dataset.queryMeta, scope = meta.effectiveScope;
    const monthIndex = text => Number(text.slice(0, 4)) * 12 + Number(text.slice(5, 7)) - 1;
    const monthCount = monthIndex(scope.endDate) - monthIndex(scope.startDate) + 1;
    const months = Array.from({ length: monthCount }, (_, index) => {
      const value = monthIndex(scope.startDate) + index;
      return `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
    });
    const cards = new Map();
    for (const row of dataset.rows) {
      const identity = row.cardRef || row.name;
      if (!cards.has(identity)) cards.set(identity, { name: row.name, rows: new Map() });
      const card = cards.get(identity);
      if (card.rows.has(row.month)) return '逐卡月份记录存在重复，无法确认月度走势。';
      card.rows.set(row.month, row);
    }
    // This query asks for scoped monthly facts, like a ranking or extremum.
    // Publish the authorized cells directly instead of guessing a trajectory
    // from absent months or unverified intermediate model interpretation.
    const visibleCards = [...cards.values()].slice(0, 6);
    const lines = visibleCards.map(card => `- ${markdownCell(Array.from(String(card.name || '未命名卡片')).slice(0, 120).join(''))}：${months.map(month => {
      const row = card.rows.get(month);
      if (!row) return `${month} ${meta.rowsComplete ? '暂无消费记录' : '暂无返回记录'}`;
      const amount = row.amountCNY == null ? '金额未定价' : `已定价支出 CNY ${row.amountCNY}`;
      return `${month} ${amount}（${row.count} 笔）${Number(row.unpricedCount) > 0 ? `，含 ${row.unpricedCount} 笔未定价` : ''}`;
    }).join('；')}。`);
    const endMonth = scope.endDate.slice(0, 7);
    const lastDay = new Date(Date.UTC(Number(endMonth.slice(0, 4)), Number(endMonth.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return [`${scope.startDate} 至 ${scope.endDate}，按卡片分别展示月度消费：`, ...lines,
      cards.size > visibleCards.length ? '正文展示部分卡片，其余返回记录可在明细中查看。' : '',
      meta.rowsComplete ? '' : '本次仅返回部分卡片月份记录，不能据此判断全部月份的消费变化。',
      scope.endDate < lastDay ? `${endMonth} 仅统计到 ${scope.endDate}，不能作为完整月份比较。` : ''].filter(Boolean).join('\n\n');
  }
  const metric = queryContext?.activeQuery?.metric;
  const rankings = datasets.filter(dataset => dataset.queryMeta && (metric === 'transaction-max' && dataset.datasetId === 'finance-transactions'
    && dataset.queryMeta.sort === 'amountDesc' && ['expense', 'income'].includes(dataset.queryMeta.filters.direction)
    || metric === 'daily-max' && dataset.datasetId === 'finance-daily'
      && (dataset.queryMeta.sort === 'expenseDesc' && dataset.queryMeta.filters.direction === 'expense'
        || dataset.queryMeta.sort === 'incomeDesc' && dataset.queryMeta.filters.direction === 'income')));
  const ranked = rankings.length === 1 ? rankings[0] : null;
  if (ranked) {
    const meta = ranked.queryMeta;
    const amountKey = metric === 'daily-max' ? meta.filters.direction === 'income' ? 'income' : 'expense' : 'amountCNY';
    const row = ranked.rows.find(item => item[amountKey] != null);
    const period = `${meta.effectiveScope.startDate} 至 ${meta.effectiveScope.endDate}`;
    const directionName = meta.filters.direction === 'income' ? '收入' : '支出';
    if (!row) return `${period}没有可比较的已定价${directionName}。${Number(ranked.summary.unpricedCount || 0) > 0 ? `存在未定价记录，无法确认最大${directionName}。` : ''}`;
    const qualifier = meta.rankingComplete ? '' : '已定价记录中，';
    const fact = metric === 'daily-max' ? `${period}，${qualifier}${directionName}最多的一天是 ${row.date}，${directionName} CNY ${row[amountKey]}。`
      : `${period}，${qualifier}${directionName}最大的一笔发生在 ${row.date}，${row.category || '未分类'}，CNY ${row.amountCNY}${row.remark ? `，备注「${row.remark}」` : ''}。`;
    const ties = ranked.rows.filter(item => item[amountKey] === row[amountKey]);
    const explanation = scrubModelProse(answer, datasets).split(/(?<=[。；;！？])|\n+/)
      .filter(part => !meta.rankingComplete || !/(?:可能|也许|或许).*(?:更大|更高|更多)|(?:无法|不能|尚不能).*(?:确认|确定).*(?:最大|最多|最高)/.test(part))
      .join('').trim();
    return [fact, ties.length > 1 ? `已返回结果中有 ${ties.length} 项并列最大。` : '',
      explanation].filter(Boolean).join('\n\n');
  }
  const kept = scrubModelProse(answer, datasets)
    .replace(/[，,]{2,}/g, '，').replace(/[。；;！？]{2,}/g, mark => mark[0])
    .replace(/^[，,。；;！？\s]+/, '').trim();
  // A monthly financial explanation should read as the model's verified
  // answer. Totals and rows remain available in the dataset cards; forcing
  // another summary and table around this prose turns it into a ledger dump.
  if (datasets.length === 1 && primary?.datasetId === 'finance-monthly') {
    if (kept) return kept;
    const summary = primary.summary || {}, facts = [];
    const unit = summary.currency === 'CNY' ? '元' : ` ${summary.currency || '（币种未确认）'}`;
    if (summary.income != null) facts.push(`已记录收入${summary.income}${unit}`);
    if (summary.expense != null) facts.push(`支出${summary.expense}${unit}`);
    if (summary.net != null) facts.push(`净收支${summary.net}${unit}`);
    const scope = primary.queryMeta?.effectiveScope;
    const endMonth = scope?.endDate?.slice(0, 7);
    const lastDay = endMonth && new Date(Date.UTC(Number(endMonth.slice(0, 4)), Number(endMonth.slice(5)), 0)).toISOString().slice(0, 10);
    const partialMonth = lastDay && scope.endDate < lastDay ? `${endMonth}仅统计到${scope.endDate}，这个月尚未统计完整。` : '';
    return [facts.length ? `${facts.join('，')}。` : sentence, kept, partialMonth].filter(Boolean).join('\n\n');
  }
  // Apply the same presentation rule to categories, transactions, daily
  // totals, mixed financial datasets and card queries. Published totals are
  // still available in their cards; they are not a mandatory answer prefix.
  const table = primary ? rowsTable(primary) : '';
  // Card counts retain the proven-row table, including partial-count coverage.
  if (primary?.datasetId === 'card-counts') return [
    kept && /\d+\s*张/.test(kept) ? '' : sentence, kept, table,
  ].filter(Boolean).join('\n\n');
  if (kept && (primary?.domain === 'finance' || primary?.domain === 'card'
    || summary?.income != null || summary?.expense != null)) return kept;
  return [sentence, kept, table].filter(Boolean).join('\n\n');
}
// The card notice area (dataset.policy) carries the query scope so the assistant never
// has to voice it; elements are shallow-copied to avoid mutating cached tool snapshots.
function withScopePolicy(datasets, scope) {
  for (let index = 0; index < datasets.length; index++) {
    const dataset = datasets[index];
    if (dataset.datasetId === 'card-counts') continue;
    const ownScope = dataset.queryMeta?.effectiveScope || scope;
    if (!ownScope?.startDate || !ownScope?.endDate) continue;
    const scopePolicy = `查询范围 ${ownScope.startDate} 至 ${ownScope.endDate}。`;
    if (!String(dataset.policy || '').includes(scopePolicy)) {
      datasets[index] = { ...dataset, policy: `${scopePolicy}${dataset.policy || ''}` };
    }
  }
  return datasets;
}
function redactSelectedText(selected, raw, userId, extraSecrets = []) {
  const knownIds = [];
  for (const rows of Object.values(raw.choices || {})) for (const row of rows) if (row?.id) knownIds.push(row.id);
  for (const dataset of raw.datasets || []) for (const row of dataset.rows || []) for (const [key, value] of Object.entries(row)) {
    if ((key === 'id' || /(?:Id|_id)$/.test(key)) && typeof value === 'string') knownIds.push(value);
  }
  const policy = createEgressPolicy({ userId, knownIds, extraSecrets });
  const result = structuredClone(selected);
  for (const dataset of result.datasets) for (const row of dataset.rows) for (const column of dataset.columns) {
    if (column.type === 'text' && typeof row[column.key] === 'string') row[column.key] = policy.scrub(row[column.key]);
  }
  for (const rows of Object.values(result.choices)) for (const row of rows) for (const key of ['name', 'bankName']) {
    if (typeof row?.[key] === 'string') row[key] = policy.scrub(row[key]);
  }
  return result;
}

module.exports = { buildFinalizationMessages, validateChart, allowedNumberValues, sentenceNumbers,
  scrubModelProse, typeSegments, markdownCell, rowsTable, multitaskSavedFacts, buildQueryAnswer,
  withScopePolicy, redactSelectedText };
