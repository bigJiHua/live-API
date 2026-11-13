const { DATASETS, getDatasetCapability, SORTS } = require('./datasetCapabilities');
const { accountCompositionRequested, balanceDetailRequested } = require('./assetCompositionIntent');
const { stripQueryPresentationText } = require('./queryContext');
const { naturalFilterPermitted } = require('./queryFilterSemantics');
const { extractExplicitQueryConstraints } = require('./explicitQueryConstraints');
const { classifyCurrentTurn } = require('./currentTurnIntent');

// Names and examples are data, not instructions. Retain offsets for parsers
// that need to return the corresponding unmodified literal text.
function semanticMessage(message) {
  const blank = text => text.replace(/[\s\S]/g, ' ');
  return String(message || '').normalize('NFKC').replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)|`[^`\n]*(?:`|$)/g, blank);
}
const subjectFor = id => DATASETS[id] === 'card' ? 'cards' : DATASETS[id];
function affirmed(text, pattern) {
  for (const match of text.matchAll(new RegExp(pattern.source, 'giu'))) {
    const prefix = text.slice(0, match.index).split(/[，,；;。！？!?\n]|但是|而是|只看|只查/).at(-1);
    if (!/(?:不要|不用|无需|不需要|不查|不看|不按|(?<!分)别|排除)[^，,；;。！？!?]{0,24}$/.test(prefix)) return true;
  }
  return false;
}
function explicitDatasetIntent(message, { subject, metric } = {}) {
  const intent = classifyCurrentTurn(message);
  if (intent.businessSuppressed) return { targetDatasetId: null, ambiguous: false, explicit: false };
  const text = semanticMessage(intent.businessMessage), selected = new Set();
  for (const id of Object.keys(DATASETS)) if (affirmed(text, new RegExp('(?<![A-Za-z0-9_-])' + id + '(?![A-Za-z0-9_-])'))) selected.add(id);
  const add = (id, pattern) => { if (affirmed(text, pattern)) selected.add(id); };
  if (subject === 'finance') {
    if (metric === 'transaction-max') selected.add('finance-transactions');
    else if (metric === 'daily-max') selected.add('finance-daily');
    add('finance-monthly', /月度(?:收支|收入|支出)?(?:汇总|统计|趋势)?|逐月|按月|每月|各月|monthly/);
    add('finance-daily', /逐日|每日|每天|按日|日度|daily/);
    add('finance-categories', /分类(?:收支|收入|支出|汇总|统计|排行)?|category/);
    add('finance-transactions', /收支明细|支出明细|收入明细|消费明细|交易明细|收支流水|交易流水|逐笔|每一笔|单笔|transactions?/);
  } else if (subject === 'cards') {
    const cardList = affirmed(text, /卡片(?:清单|基础设置|设置|配置|别名)|银行卡(?:清单|基础设置|设置|配置|别名)|逐卡配置/);
    const metricId = cardList ? 'card-cards' : { 'card-count': 'card-counts', 'card-list': 'card-cards', 'card-consumption': 'card-monthlyConsumption',
      'card-bills': 'card-bills', 'card-repayments': 'card-repayments', 'card-pools': 'card-pools' }[metric];
    // Metrics count/list have defaults; do not turn a bare card noun into an
    // explicit count query. Other card metrics are established by the parser.
    if (metricId && (metric !== 'card-count' && metric !== 'card-list'
      || affirmed(text, /数量|张数|几张|多少张|按类型|比例|占比|清单|有哪些|列出|列表|设置|配置|别名/))) selected.add(metricId);
    add('card-cards', /卡片清单|银行卡清单|卡片设置|卡片配置|卡片别名|银行卡别名/);
  } else if (subject === 'work') {
    add('work-rules', /工资规则|薪资规则|工作规则|薪酬规则|基本工资|时薪|工资配置|工资设置/);
    add('work-salary', /工资登记|已登记(?:的)?(?:每日)?工资(?!规则|配置|设置)|(?:已保存|每日|历史|登记|实际发放)工资(?!规则|配置|设置)|工资(?:历史|流水|记录)|工时/);
  } else if (subject === 'asset') {
    if (accountCompositionRequested(text)) selected.add('asset-composition');
    const comparison = affirmed(text, /资产比较|资产对比|(?:登记|手工)(?:资产)?[^。！？;；\n]{0,24}(?:与|和|对比|比较)[^。！？;；\n]{0,24}系统|系统[^。！？;；\n]{0,24}(?:与|和|对比|比较)[^。！？;；\n]{0,24}(?:登记|手工)/);
    if (comparison) selected.add('asset-comparison');
    else {
      add('asset-snapshots', /资产(?:历史)?快照|资产[^。！？;；\n]{0,12}(?:系统(?:保存)?)?快照|资产历史|系统保存净值|系统(?:计算|保存)(?:的)?资产|净资产(?:历史|走势|趋势)/);
      add('asset-registers', /资产登记|登记资产|手工资产|手工登记资产/);
    }
  } else if (subject === 'fund') {
    add('fund-holdings', /基金持仓|持仓(?:本金|参考|清单|列表)|基金本金|已保存(?:的)?持仓|基金登记(?:的)?(?:本金|汇总)|登记市值|已登记收益合计/);
    add('fund-history', /基金(?:历史|每日)?收益|收益历史|每日收益|收益(?:与|和|及)资金变动|资金变动历史/);
  } else {
    const single = { account: 'account-balances', budget: 'budget-plans', todo: 'todo-events', fixedAsset: 'fixedAsset-saved', installment: 'installment-plans' }[subject];
    const words = { account: /账户余额|余额快照|保存余额|逐账户余额/, budget: /预算/, todo: /待办|日程|提醒/,
      fixedAsset: /固定资产/, installment: /分期|期次/ }[subject];
    if (single && words && affirmed(text, words)) selected.add(single);
  }
  if (subject === 'finance' && !selected.size && metric === 'summary'
    && affirmed(text, /收支|收入[^。！？;；\n]{0,12}支出|支出[^。！？;；\n]{0,12}收入|总额|合计|汇总/)) selected.add('finance-monthly');
  const own = [...selected].filter(id => subjectFor(id) === subject);
  return { targetDatasetId: own.length === 1 ? own[0] : null, ambiguous: own.length > 1, explicit: own.length > 0 };
}
function buildDatasetIntent({ message, subject, metric, mode, previous, followup, sameTask } = {}) {
  if (mode !== 'query') return {};
  const intent = classifyCurrentTurn(message);
  if (intent.businessSuppressed) return {};
  if (intent.topicReset) { previous = null; followup = false; sameTask = false; }
  const text = semanticMessage(intent.businessMessage), explicit = explicitDatasetIntent(text, { subject, metric });
  const priorTarget = previous?.subject === subject && Object.hasOwn(DATASETS, previous.targetDatasetId || '') ? previous.targetDatasetId : null;
  const target = explicit.targetDatasetId || (!explicit.ambiguous && (followup || sameTask) ? priorTarget : null);
  if (!target) return {};
  const ranking = /最大|最高|最多|最贵|第一|排行|排名|按金额|金额(?:降序|排序)|amountDesc|expenseDesc|incomeDesc/.test(stripQueryPresentationText(text));
  const explicitRank = ranking && explicit.explicit;
  const normalSort = { 'finance-monthly': 'monthAsc', 'finance-daily': 'dateDesc',
    'finance-transactions': 'dateDesc', 'finance-categories': 'categoryAmountDesc' }[target];
  let querySort;
  if (!explicit.explicit && (followup || sameTask) && priorTarget === target && SORTS.includes(previous?.querySort)) querySort = previous.querySort;
  else if (!ranking) querySort = normalSort;
  else if (target === 'finance-transactions') querySort = 'amountDesc';
  else if (target === 'finance-daily' && (metric === 'daily-max' || explicitRank)) querySort = /收入/.test(text) && !/支出|消费|花费/.test(text) ? 'incomeDesc' : 'expenseDesc';
  else if (target === 'finance-categories') querySort = 'categoryAmountDesc';
  // Explanations can discuss an existing read without refreshing it. Actual
  // query and parameter-change followups require current-turn source evidence.
  const explanatory = /为什么|原因|怎么理解|怎么计算|解释|含义|什么口径|口径是什么|字段|建议|分析/.test(text);
  const requireFreshQuery = !explanatory && (/查|看|读取|列出|展示|多少|哪|统计|汇总|图|比较|对比|[?？]/.test(text) || followup);
  return { targetDatasetId: target, ...(querySort ? { querySort } : {}), ...(requireFreshQuery ? { requireFreshQuery: true } : {}) };
}
function readerSortIssue(input) {
  const cap = getDatasetCapability(input?.datasetId);
  const allowed = cap?.acceptedArgs.readerSorts?.length ? cap.acceptedArgs.readerSorts : cap?.acceptedArgs.sorts;
  return input?.sort !== undefined && Array.isArray(allowed) && !allowed.includes(input.sort)
    ? { path: 'sort', rule: 'dataset.readerSort', allowedValues: allowed } : null;
}
function targetDatasetIssue(input, task, { message } = {}) {
  // Explicit account detail is a legitimate second grain; it cannot replace
  // the required composition aggregation or authorize an unrequested read.
  if (task?.mode === 'query' && task.targetDatasetId === 'asset-composition'
    && input?.datasetId === 'account-balances' && balanceDetailRequested(message)) return null;
  return task?.mode === 'query' && task.targetDatasetId && input?.datasetId !== task.targetDatasetId
    ? { path: 'datasetId', rule: 'dataset.intent.required', allowedValues: [task.targetDatasetId] } : null;
}
function pinDatasetSort(input, task) {
  return task?.mode === 'query' && task.targetDatasetId === input?.datasetId && task.querySort
    ? { ...input, sort: task.querySort } : input;
}
function currentNamedFilter(message, filter, datasetId) {
  const text = String(message || ''), semantic = semanticMessage(text);
  const escaped = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of semantic.matchAll(new RegExp(escaped, 'giu'))) {
    const prefix = semantic.slice(0, match.index).split(/[，,。；;！？!?\n]/).at(-1);
    if (!/(?:例如|比如|示例|样例|演示|假设|工具参数|工具示例)|(?:不要|不用|无需|不需要|不查|不看|(?<!分)别|排除)[^，,。；;]{0,24}$/.test(prefix)
      && naturalFilterPermitted(datasetId, filter, { prefix })) return true;
  }
  // An explicitly named quoted account/fund is legitimate data. Fenced tool
  // examples and quoted examples do not authorize their contained filters.
  for (const match of text.matchAll(/“([^”]*)”|‘([^’]*)’|「([^」]*)」|『([^』]*)』|"([^"\n]*)"|'([^'\n]*)'/g)) {
    const quotedValue = match.slice(1).find(value => value !== undefined);
    if (!quotedValue.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) continue;
    const prefix = semantic.slice(0, match.index).split(/[，,。；;！？!?\n]/).at(-1);
    if (!/(?:例如|比如|示例|样例|演示|假设|工具参数|工具示例|不要|不用|无需|不需要|不查|不看|(?<!分)别|排除)/.test(prefix)
      && /查|看|读取|名为|名称|基金|账户|卡片|分期|计划/.test(prefix)
      && naturalFilterPermitted(datasetId, filter, { prefix, quoted: true })) return true;
  }
  return false;
}
function filterBasisIssue(input, { task, message, constraints, previousTask, coverage, queryContext } = {}) {
  if (task?.mode !== 'query' || !task.targetDatasetId) return null;
  const constraintEvidence = extractExplicitQueryConstraints(message, { evidence: true });
  if (constraintEvidence.ambiguousFilters) return { path: 'filter', rule: 'dataset.filter.intent', allowedValues: [''] };
  if (!input?.filter) return null;
  // All-card requests clear only the known type labels already handled by
  // the card pinning path. Arbitrary free-text filters still need evidence.
  if (task.subject === 'cards' && task.allCardTypes === true
    && ['card-counts', 'card-monthlyConsumption'].includes(input.datasetId)
    && /^(?:信用卡?|借记卡?|储蓄卡?|现金|微信|支付宝|虚拟余额)$/.test(input.filter)
    && !String(message || '').includes(input.filter)) return null;
  // Explicit filter/clear instructions are applied publicly after unchanged
  // original validation. Do not reject a stale but legal value before pinning.
  if (Object.hasOwn(constraints || {}, 'filter') || queryContext?.activeQuery?.category) return null;
  const filter = String(input.filter);
  if (currentNamedFilter(message, filter, input.datasetId)) return null;
  const continuation = /延续|沿用|刚才|之前|范围不变|筛选不变|同样/.test(semanticMessage(message));
  const inherited = continuation && previousTask?.subject === task.subject && previousTask.turnId
    && (coverage?.results || []).some(meta => meta.datasetId === task.targetDatasetId && meta.turnId === previousTask.turnId
      && meta.filters?.text === filter && (!previousTask.scope || meta.effectiveScope?.startDate === previousTask.scope.startDate
        && meta.effectiveScope?.endDate === previousTask.scope.endDate));
  return inherited ? null : { path: 'filter', rule: 'dataset.filter.intent', allowedValues: [''] };
}
module.exports = { semanticMessage, subjectFor, explicitDatasetIntent, buildDatasetIntent, readerSortIssue, targetDatasetIssue, pinDatasetSort, filterBasisIssue };
