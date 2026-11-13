const { explicitPeriod, extractComparisonScopes, isComparisonRequest, isAccountSupplementText,
  isQueryRequestText, hasExplicitTransactionAmount, isNewTransactionStatement, isBusinessFollowupText, stripQueryPresentationText } = require('./queryContext');

const { accountCompositionRequested, resolveAssetCompositionMetric } = require('./assetCompositionIntent');
const { DATASETS, SORTS } = require('./datasetCapabilities');
const { semanticMessage, subjectFor, buildDatasetIntent } = require('./queryDatasetIntent');
const { classifyCurrentTurn } = require('./currentTurnIntent');

const MODES = new Set(['query', 'record', 'pending-supplement', 'pending-cancel', 'chat']);
const SUBJECTS = new Set(['finance', 'cards', 'account', 'todo', 'diary', 'budget', 'fund', 'fixedAsset', 'work', 'asset', 'installment']);
const METRICS = new Set(['summary', 'transactions', 'transaction-max', 'daily-max', 'category-summary', 'card-count', 'card-consumption', 'card-list', 'card-bills', 'card-repayments', 'card-pools', 'asset-composition']);
const STATUSES = new Set(['pending', 'succeeded', 'failed', 'awaiting_input']);
const validDate = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const scope = value => value && validDate(value.startDate) && validDate(value.endDate) && value.startDate <= value.endDate
  ? { startDate: value.startDate, endDate: value.endDate } : null;
function inferTaskSubject(message) {
  if (typeof message !== 'string') return null;
  message = semanticMessage(classifyCurrentTurn(message).businessMessage);
  return /固定资产/.test(message) ? 'fixedAsset'
    : /流动资产|净资产|资产[^。！？;；\n]{0,12}(?:快照|净值)|系统保存资产|手工[^。！？;；\n]{0,12}系统[^。！？;；\n]{0,12}资产|资产快照|资产登记|手工资产|资产构成|资产组成|资产负债|系统保存净值/.test(message) ? 'asset'
    : /工资|薪资|薪酬|工作规则|已登记工资/.test(message) ? 'work'
    : /分期|期次/.test(message) ? 'installment'
    : /账户余额|余额快照|保存余额/.test(message) ? 'account'
    : /借记卡|储蓄卡|信用卡|贷记卡|卡片|银行卡|共享池|共享额度/.test(message) ? 'cards'
    : /待办|日程|提醒/.test(message) ? 'todo' : /日记/.test(message) ? 'diary' : /预算/.test(message) ? 'budget'
      : /基金|收益/.test(message) ? 'fund' : /固定资产/.test(message) ? 'fixedAsset'
        : /收支|支出|收入|消费|流水|账单|账本|花费|花[的了]?|买了|买菜|购买|支付|付了|收到|收了|购汇|结汇|单笔|一笔|明细/.test(message) ? 'finance' : null;
}
function isTaskFollowupText(message) {
  return isBusinessFollowupText(message);
}
function cardTypeSelection(text) {
  const selected = new Map();
  let negated = false;
  for (const match of text.matchAll(/借记卡|储蓄卡|信用卡/g)) {
    const before = text.slice(0, match.index).split(/[，,。；;！？!?]/).at(-1);
    const after = text.slice(match.index + match[0].length).split(/[，,。；;！？!?]/)[0];
    const excluded = /(?:不是|不要|不用|不看|不查|不统计|不包括|不含|排除|除去|去掉)\s*(?:把\s*)?(?:(?:借记卡|储蓄卡|信用卡)\s*(?:和|与|及|或|、)\s*)*$/.test(before)
      || /^\s*(?:不要|不用|不看|不查|不统计|排除|除去|去掉)/.test(after);
    negated ||= excluded;
    selected.set(match[0] === '信用卡' ? 'credit' : 'debit', !excluded);
  }
  return { mentioned: selected.size > 0, negated, types: ['debit', 'credit'].filter(type => selected.get(type) === true),
    excluded: ['debit', 'credit'].filter(type => selected.get(type) === false) };
}
function sanitizeTaskContext(value) {
  if (!value || value.version !== 1 || !MODES.has(value.mode)) return null;
  const result = { version: 1, mode: value.mode, subject: SUBJECTS.has(value.subject) ? value.subject : null,
    metric: METRICS.has(value.metric) ? value.metric : null,
    cardTypes: Array.isArray(value.cardTypes) ? [...new Set(value.cardTypes.filter(type => ['debit', 'credit'].includes(type)))] : [],
    chartRequest: value.chartRequest && ['pie', 'bar', 'line'].includes(value.chartRequest.type)
      && ['count', 'amount'].includes(value.chartRequest.metric) ? { type: value.chartRequest.type, metric: value.chartRequest.metric } : null,
    comparisonScopes: Array.isArray(value.comparisonScopes) ? value.comparisonScopes.map(scope).filter(Boolean).slice(0, 4) : [],
    status: STATUSES.has(value.status) ? value.status : 'pending' };
  // Only an explicitly unrestricted card task may carry this optional intent.
  if (value.allCardTypes === true && result.subject === 'cards' && !result.cardTypes.length) result.allCardTypes = true;
  if (result.mode === 'query' && Object.hasOwn(DATASETS, value.targetDatasetId || '')
    && subjectFor(value.targetDatasetId) === result.subject) {
    result.targetDatasetId = value.targetDatasetId;
    if (SORTS.includes(value.querySort)) result.querySort = value.querySort;
    if (value.requireFreshQuery === true) result.requireFreshQuery = true;
  }
  const ownScope = scope(value.scope);
  if (ownScope) result.scope = ownScope;
  if (typeof value.turnId === 'string' && /^[\w-]{1,64}$/.test(value.turnId)) result.turnId = value.turnId;
  if (typeof value.errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.errorCode)) result.errorCode = value.errorCode;
  return result;
}
function buildTaskContext({ message, today, previous, pendingContext, queryContext } = {}) {
  if (typeof message !== 'string' || !validDate(today)) return null;
  const intent = classifyCurrentTurn(message);
  const text = semanticMessage(intent.businessMessage).trim();
  if (intent.businessSuppressed) return sanitizeTaskContext({ version: 1, mode: 'chat', status: 'pending' });
  const prior = intent.topicReset ? null : sanitizeTaskContext(previous);
  const pending = pendingContext?.status === 'awaiting_input';
  const cardSelection = cardTypeSelection(text);
  const accountOnly = isAccountSupplementText(text) && !cardSelection.negated;
  if (accountOnly && !pending) return sanitizeTaskContext({ ...(prior || {}), version: 1, mode: 'chat', status: 'pending' });
  const hasQuery = isQueryRequestText(text) || accountCompositionRequested(text);
  const pendingCancel = pending && /取消|不记了|不用记|别记|不录入|不入账/.test(text)
    && !/待办|提醒|日程|预算|图表|查询/.test(text);
  const newRecord = isNewTransactionStatement(text);
  const supplement = pending && !hasQuery && !newRecord && !hasExplicitTransactionAmount(text) && (isAccountSupplementText(text)
    || /^(?:都是|全部|这几笔|这三笔|这两笔)?\s*(?:用|付|记为|归到|分类|现金|微信|支付宝|余额)/.test(text));
  const correction = /我说|不是|而是|改成|更正|应该|按.*(?:数量|张数)/.test(text) || cardSelection.negated;
  const followup = isTaskFollowupText(text);
  const explicitCardTypes = cardSelection.types;
  const hasSpecificCardType = cardSelection.mentioned || /(?:现金|微信|支付宝|虚拟余额|余额账户)/.test(text);
  const allCardsRequested = !hasSpecificCardType
    && /(?:全部|所有|全类型)(?:的)?(?:卡片|银行卡)|(?:卡片|银行卡)(?:都|全)(?:要|算|包括)/.test(text);
  const cardWords = cardSelection.mentioned || /卡片|银行卡/.test(text);
  const notConsumption = /不是\s*(?:收支|消费|支出|金额)|不(?:看|按|要)\s*(?:收支|消费|支出|金额)/.test(text);
  const consumption = !notConsumption && /消费|收支|支出|花费|金额/.test(text);
  const quantity = /数量|张数|几张|多少张/.test(stripQueryPresentationText(text)) || notConsumption;
  const chartReference = /图表|饼图|折线|曲线|走势|趋势|柱状|画.*图/.test(text);
  let subject = pendingCancel || supplement || newRecord ? 'finance' : cardWords ? 'cards'
    : inferTaskSubject(text) || (followup || chartReference ? prior?.subject || null : null)
      || (queryContext?.activeQuery || chartReference ? 'finance' : null);
  const mode = pendingCancel ? 'pending-cancel' : supplement ? 'pending-supplement' : newRecord ? 'record'
    : (hasQuery || followup || correction) && subject ? 'query' : 'chat';
  if (mode === 'chat' && prior) return sanitizeTaskContext({ ...prior, mode, status: 'pending' });
  const financeContext = subject === 'finance' ? queryContext?.activeQuery : null;
  let metric = subject === 'cards' ? quantity || !consumption && /比例|占比|饼图/.test(text) ? 'card-count'
    : consumption ? 'card-consumption' : /清单|有哪些|列出/.test(text) ? 'card-list'
      : prior?.subject === 'cards' ? prior.metric : 'card-count'
    : financeContext?.metric || (subject === prior?.subject && followup ? prior.metric : 'summary');
  if (subject === 'cards' && /共享池|共享额度/.test(text)) metric = 'card-pools';
  else if (subject === 'cards' && /还款历史|还款记录|还款明细/.test(text)) metric = 'card-repayments';
  else if (subject === 'cards' && /账单(?!\s*日)|待还|欠款/.test(text) && !/消费/.test(text)) metric = 'card-bills';
  if (subject === 'asset') metric = resolveAssetCompositionMetric(text, metric);
  if (mode === 'record' || mode.startsWith('pending-')) metric = null;
  const sameTask = prior?.subject === subject && (followup || correction || chartReference
    || subject === 'cards' && cardSelection.mentioned && /呢[?？。!！]*$/.test(text) || /还是|回到|继续|接着/.test(text));
  const allCardTypes = subject === 'cards' && (allCardsRequested || !hasSpecificCardType && sameTask && prior?.allCardTypes === true);
  const cardTypes = subject === 'cards' ? allCardTypes ? [] : cardSelection.mentioned
    ? explicitCardTypes.length ? explicitCardTypes : (prior?.cardTypes?.length ? prior.cardTypes : ['debit', 'credit'])
      .filter(type => !cardSelection.excluded.includes(type))
    : sameTask ? prior.cardTypes : [] : [];
  const chartType = /饼图/.test(text) ? 'pie' : /折线|曲线|走势|趋势/.test(text) ? 'line' : /柱状/.test(text) ? 'bar'
    : /图表|画.*图/.test(text) ? sameTask && prior?.chartRequest?.type || 'bar' : null;
  const cancelChart = /不(?:要|用)(?!\s*(?:再\s*)?(?:改|修改|更改|调整|换)).*(?:图|饼)|不画.*(?:图|饼)/.test(text);
  const chartRequest = cancelChart ? null : chartType
    ? { type: chartType, metric: metric === 'card-count' ? 'count' : 'amount' }
    : sameTask && prior.chartRequest ? { ...prior.chartRequest, metric: metric === 'card-count' ? 'count' : 'amount' } : null;
  const comparisonScopes = extractComparisonScopes(text, today, prior?.scope || queryContext?.activeQuery);
  const ownScope = subject === 'cards' && metric === 'card-count' ? null
    : explicitPeriod(text, today, prior?.subject === subject ? prior?.scope : financeContext)
      || (sameTask ? prior?.scope : null) || financeContext;
  const datasetIntent = buildDatasetIntent({ message: text, subject, metric, mode, previous: prior, followup, sameTask });
  return sanitizeTaskContext({ version: 1, mode, subject, metric, ...datasetIntent, cardTypes, ...(allCardTypes ? { allCardTypes: true } : {}), chartRequest,
    comparisonScopes: comparisonScopes.length ? comparisonScopes : sameTask && !isComparisonRequest(text) ? prior.comparisonScopes : [],
    ...(ownScope ? { scope: ownScope } : {}), status: 'pending' });
}
function finalizeTaskContext(context, { status, turnId, errorCode } = {}) {
  const safe = sanitizeTaskContext(context);
  if (!safe) return null;
  if (STATUSES.has(status)) safe.status = status;
  if (typeof turnId === 'string') safe.turnId = turnId;
  if (status === 'failed' && errorCode) safe.errorCode = errorCode;
  else delete safe.errorCode;
  return sanitizeTaskContext(safe);
}
module.exports = { buildTaskContext, sanitizeTaskContext, finalizeTaskContext, inferTaskSubject, isTaskFollowupText };
