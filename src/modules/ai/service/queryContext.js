const { CARD_TYPES } = require('./candidateSelection');
const { AiError } = require('./errors');
const { SORTS, DIRECTIONS, META_FILTER_KEYS, getDatasetCapability } = require('./datasetCapabilities');
const { classifyCurrentTurn } = require('./currentTurnIntent');
const { validQueryPage, validResolution } = require('./queryMetadata');
const { isNextPageRequest } = require('./largeQuery');
const METRICS = new Set(['summary', 'transactions', 'transaction-max', 'daily-max', 'category-summary']);
const STATUSES = new Set(['pending', 'succeeded', 'failed']);
const DATE = /^20\d{2}-\d{2}-\d{2}$/;
const MAX_LAST_RESULTS = 4;
const COVERAGE_CARD_TYPES = new Set(CARD_TYPES);
const validDate = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const pad = value => String(value).padStart(2, '0');
const dayText = value => value.toISOString().slice(0, 10);
const shiftDays = (today, days) => dayText(new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000));
const monthRange = (year, month) => ({ startDate: `${year}-${pad(month)}-01`,
  endDate: dayText(new Date(Date.UTC(year, month, 0))) });
const safeName = value => typeof value === 'string' && value.trim() && value.length <= 80
  && !/r_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)
  ? value.trim() : null;

// Presentation limits and metadata counts are not amount-ranking intent.
// Keep semantic "最高/最大/第一名" in the remaining user utterance.
function stripQueryPresentationText(message) {
  if (typeof message !== 'string') return '';
  return message
    .replace(/(?:最多|至多|不超过|不多于)\s*(?:只\s*)?(?:展示|显示|返回|列出(?:来)?|输出|提供|给(?:我)?|看(?:看)?)\s*(?:前\s*)?(?:第\s*)?(?:[一二三四五六七八九十百两〇零\d]+\s*(?:条|笔|行|项|张|天|个月|月|种|个)(?:记录|明细|流水|数据|结果|分类|卡片)?)?/g, ' ')
    .replace(/(?:最多|至多|不超过|不多于)\s*(?:前\s*)?[一二三四五六七八九十百两〇零\d]+\s*(?:条|笔|行|项|张|天|个月|月|种|个)(?:记录|明细|流水|数据|结果|分类|卡片)?/g, ' ')
    .replace(/(?:只|仅)?\s*(?:展示|显示|返回|列出(?:来)?|输出|提供|给(?:我)?|看(?:看)?)\s*(?:前\s*)?第\s*[一二三四五六七八九十百两〇零\d]+\s*(?:条|笔|行|项|张|天|个月|月|种|个)(?:记录|明细|流水|数据|结果|分类|卡片)?/g, ' ')
    .replace(/第\s*一\s*(?:条|筆|笔|行|项|张)(?:记录|明细|流水|数据|结果|卡片)?/g, ' ')
    .replace(/(?:实际|本次|本轮|查询|范围内|已)?\s*(?:匹配|展示|显示|返回|读取|输出|筛选|结果|记录|数据)(?:的)?(?:记录|数据|结果)?(?:数量|条数|行数)/g, ' ');
}

function safeCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capability = getDatasetCapability(value.datasetId)?.effectiveMeta;
  const range = input => input && validDate(input.startDate) && validDate(input.endDate) && input.startDate <= input.endDate
    ? { startDate: input.startDate, endDate: input.endDate } : null;
  const requestedScope = range(value.requestedScope), effectiveScope = range(value.effectiveScope);
  if (value.version !== 1 || !requestedScope || !effectiveScope || typeof value.datasetId !== 'string'
    || !/^[A-Za-z]+-[A-Za-z]+$/.test(value.datasetId) || value.datasetId.length > 64
    || !Number.isSafeInteger(value.returnedRowCount) || value.returnedRowCount < 0 || value.returnedRowCount > 100
    || !(capability?.sorts || SORTS).includes(value.sort)
    || !value.filters || !(capability?.directions || DIRECTIONS).includes(value.filters.direction)
    || typeof value.filters.text !== 'string' || value.filters.text.length > 80
    || typeof value.asOf !== 'string' || value.asOf.length > 80 || !Number.isFinite(Date.parse(value.asOf))) return null;
  if (Object.keys(value.filters).some(key => !(capability?.filterKeys || META_FILTER_KEYS).includes(key))) return null;
  if (value.groupBy !== undefined && !capability?.groupings.includes(value.groupBy)) return null;
  if (value.resolution !== undefined && !validResolution(value.resolution)) return null;
  if (value.page !== undefined && !validQueryPage(value.page, value)) return null;
  const filterCardTypes = value.filters.cardTypes;
  if (filterCardTypes !== undefined && (!capability?.cardTypes
    || !Array.isArray(filterCardTypes) || filterCardTypes.length > COVERAGE_CARD_TYPES.size
    || filterCardTypes.some(type => !COVERAGE_CARD_TYPES.has(type)) || new Set(filterCardTypes).size !== filterCardTypes.length)) return null;
  for (const key of ['matchedRowCount', 'sourceRecordCount'])
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  // Older coverage records lack directional counts; missing stays unknown.
  const directionCounts = {};
  for (const key of ['incomeCount', 'expenseCount']) {
    if (value[key] != null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
    directionCounts[key] = value[key] ?? null;
  }
  for (const key of ['rowsComplete', 'summaryComplete', 'rankingComplete']) if (typeof value[key] !== 'boolean') return null;
  if (value.matchedRowCount !== null && value.matchedRowCount < value.returnedRowCount
    || value.rowsComplete && value.matchedRowCount !== value.returnedRowCount) return null;
  const filter = value.filters.text === '' ? '' : safeName(value.filters.text);
  if (filter === null) return null;
  if (value.queryId != null && (typeof value.queryId !== 'string' || !/^q_[a-f0-9]{24}$/.test(value.queryId))) return null;
  const returnedDateRange = value.returnedDateRange == null ? null : range(value.returnedDateRange);
  if (value.returnedDateRange != null && (!returnedDateRange || returnedDateRange.startDate < effectiveScope.startDate
    || returnedDateRange.endDate > effectiveScope.endDate)) return null;
  const cardTypes = Array.isArray(value.cardTypes || value.filters.cardTypes)
    ? [...new Set((value.cardTypes || value.filters.cardTypes).filter(type => COVERAGE_CARD_TYPES.has(type)))] : [];
  return { version: 1, source: 'previous-turn', status: 'succeeded', datasetId: value.datasetId,
    requestedScope, effectiveScope, filters: { direction: value.filters.direction, text: filter,
      ...(filterCardTypes !== undefined ? { cardTypes: [...filterCardTypes] } : {}) }, sort: value.sort,
    matchedRowCount: value.matchedRowCount, returnedRowCount: value.returnedRowCount, sourceRecordCount: value.sourceRecordCount,
    ...directionCounts,
    rowsComplete: value.rowsComplete, summaryComplete: value.summaryComplete, rankingComplete: value.rankingComplete,
    ...(value.queryId ? { queryId: value.queryId } : {}), ...(cardTypes.length ? { cardTypes } : {}),
    ...(value.groupBy !== undefined ? { groupBy: value.groupBy } : {}),
    ...(value.resolution !== undefined ? { resolution: value.resolution } : {}),
    ...(value.page !== undefined ? { page: { ...value.page } } : {}),
    returnedDateRange,
    asOf: value.asOf, ...(typeof value.turnId === 'string' && /^[\w-]{1,64}$/.test(value.turnId) ? { turnId: value.turnId } : {}) };
}

// Only semantic query metadata survives a turn. Old rows and random refs are
// deliberately absent; amounts and ranking facts must be read again.
function sanitizeQueryContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const active = value.activeQuery;
  if (!active || !validDate(active.startDate) || !validDate(active.endDate)
    || active.startDate > active.endDate) return null;
  const explicit = active.explicit || {};
  const query = { startDate: active.startDate, endDate: active.endDate,
    direction: [0, 1].includes(active.direction) ? active.direction : null,
    category: safeName(active.category), metric: METRICS.has(active.metric) ? active.metric : 'summary',
    status: STATUSES.has(active.status) ? active.status : 'pending',
    explicit: Object.fromEntries(['period', 'direction', 'category', 'metric', 'subjectReset']
      .map(key => [key, explicit[key] === true])), allowComparison: active.allowComparison === true,
    periodSource: ['current', 'inherited', 'default'].includes(active.periodSource) ? active.periodSource
      : explicit.period === true ? 'current' : 'inherited' };
  const result = { version: 1, activeQuery: query };
  if (typeof value.turnId === 'string' && /^[\w-]{1,64}$/.test(value.turnId)) result.turnId = value.turnId;
  if (typeof value.errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.errorCode)) result.errorCode = value.errorCode;
  if (Array.isArray(value.lastResults)) {
    const lastResults = value.lastResults.slice(-MAX_LAST_RESULTS).map(safeCoverage).filter(Boolean);
    if (lastResults.length) result.lastResults = lastResults;
  }
  return result;
}

function explicitPeriod(message, today, previous) {
  const dates = message.match(/20\d{2}-\d{2}-\d{2}/g) || [];
  const invalidCalendar = () => { throw new AiError('用户明确的查询日期无效，或开始日期晚于结束日期，请重新明确日期', 400, 'AI_SCOPE_INVALID'); };
  if (dates.length) {
    if (!dates.every(validDate) || dates[0] > (dates[1] || dates[0])) invalidCalendar();
    return { startDate: dates[0], endDate: dates[1] || dates[0] };
  }
  const calendarDays = [...message.matchAll(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/g)];
  if (calendarDays.length) {
    const first = calendarDays[0];
    const year = Number(first[1] || previous?.startDate?.slice(0, 4) || today.slice(0, 4));
    const startDate = `${year}-${pad(first[2])}-${pad(first[3])}`;
    // The range endpoint may omit its month/year: "11月1日至9日".
    const tail = /^\s*(?:至|到|—|–|-|~|～)\s*(?:(20\d{2})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*(?:日|号)/
      .exec(message.slice(first.index + first[0].length));
    let endDate = startDate;
    if (tail) {
      const endMonth = Number(tail[2] || first[2]);
      const endYear = Number(tail[1] || year + (tail[2] && endMonth < Number(first[2]) ? 1 : 0));
      endDate = `${endYear}-${pad(endMonth)}-${pad(tail[3])}`;
    } else if (calendarDays[1]) {
      const second = calendarDays[1];
      endDate = `${second[1] || year}-${pad(second[2])}-${pad(second[3])}`;
    }
    if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) invalidCalendar();
    return { startDate, endDate };
  }
  // The existing business scope counts the current calendar month as one:
  // on Nov 8, recent three months means Sep 1 through Nov 8. Resolve it before
  // single-day words so "最近三个月，截至今天" does not collapse to today.
  const recentMonths = /(?:最近|近|过去)\s*(\d{1,3}|[零〇一二两三四五六七八九十]{1,3})\s*(?:个)?\s*月(?:份)?/.exec(message);
  if (recentMonths) {
    // Rolling or completed-month requests need their own explicit semantics;
    // do not silently reinterpret them as the inclusive calendar-month window.
    if (/滚动|完整|不含本月|不包括本月|截至上个?月/.test(message)) return null;
    const chineseMonths = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(recentMonths[1]);
    const count = Number(recentMonths[1]) || chineseMonths[recentMonths[1]]
      || (tens ? (tens[1] ? chineseMonths[tens[1]] : 1) * 10 + (tens[2] ? chineseMonths[tens[2]] : 0) : null);
    if (!Number.isInteger(count) || count < 1 || count > 120) return null;
    const anchor = new Date(`${today}T00:00:00Z`);
    return { startDate: dayText(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - count + 1, 1))), endDate: today };
  }
  const recentYears = /(?:最近|近|过去)\s*(\d{1,2}|[一二两三四五六七八九十])\s*年/.exec(message);
  if (recentYears) {
    if (/完整年度|完整年|自然年|不含今年|不包括今年|截至去年/.test(message)) return null;
    const years = Number(recentYears[1]) || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[recentYears[1]]);
    if (!Number.isInteger(years) || years < 1 || years > 10) return null;
    const end = new Date(today + 'T00:00:00Z'), year = end.getUTCFullYear() - years, month = end.getUTCMonth();
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return { startDate: dayText(new Date(Date.UTC(year, month, Math.min(end.getUTCDate(), last)))), endDate: today };
  }
  const yearSpan = /(20\d{2})\s*年?\s*(?:至|到|—|–|-|~|～)\s*(20\d{2})\s*年/.exec(message);
  if (yearSpan) {
    if (yearSpan[1] > yearSpan[2]) invalidCalendar();
    return { startDate: yearSpan[1] + '-01-01', endDate: yearSpan[2] + '-12-31' };
  }
  const day = /前天/.test(message) ? -2 : /昨天/.test(message) ? -1 : /今天/.test(message) ? 0 : null;
  if (day !== null) { const date = shiftDays(today, day); return { startDate: date, endDate: date }; }
  const recent = /最近\s*(\d{1,4})\s*天/.exec(message);
  if (recent && Number(recent[1]) > 0 && Number(recent[1]) <= 3653)
    return { startDate: shiftDays(today, 1 - Number(recent[1])), endDate: today };
  const local = new Date(`${today}T00:00:00Z`);
  if (/上个?月|本月|这个月|当月|下个?月/.test(message)) {
    const offset = /上个?月/.test(message) ? -1 : /下个?月/.test(message) ? 1 : 0;
    const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1));
    const range = monthRange(target.getUTCFullYear(), target.getUTCMonth() + 1);
    return offset === 0 ? { ...range, endDate: today } : range;
  }
  const monthSpan = /(?:(20\d{2})\s*年\s*)?(\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月(?:份)?\s*(?:至|到|～|~|—|–|-)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月(?:份)?/.exec(message);
  if (monthSpan) {
    const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    const firstMonth = Number(monthSpan[2]) || chinese[monthSpan[2]], lastMonth = Number(monthSpan[4]) || chinese[monthSpan[4]];
    if (!Number.isInteger(firstMonth) || !Number.isInteger(lastMonth) || firstMonth < 1 || firstMonth > 12 || lastMonth < 1 || lastMonth > 12) invalidCalendar();
    const firstYear = Number(monthSpan[1]) || (/去年/.test(message) ? local.getUTCFullYear() - 1
      : /今年/.test(message) ? local.getUTCFullYear() : Number(previous?.startDate?.slice(0, 4)) || local.getUTCFullYear());
    const lastYear = Number(monthSpan[3]) || firstYear + (lastMonth < firstMonth ? 1 : 0);
    const startDate = monthRange(firstYear, firstMonth).startDate, endDate = monthRange(lastYear, lastMonth).endDate;
    if (startDate > endDate) invalidCalendar();
    return { startDate, endDate };
  }
  const month = /(?:(20\d{2})\s*年\s*)?(\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月(?:份)?/.exec(message);
  if (month) {
    const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    const number = Number(month[2]) || chinese[month[2]];
    if (number >= 1 && number <= 12) {
      const year = month[1] ? Number(month[1]) : /去年/.test(message) ? local.getUTCFullYear() - 1
        : /今年/.test(message) ? local.getUTCFullYear() : Number(previous?.startDate?.slice(0, 4)) || local.getUTCFullYear();
      // A month name can identify an earlier subtask rather than reopen its
      // entire month. Preserve only an affirmative unchanged-range return to
      // that same month; exact dates, different months and fresh reads win.
      const keepRange = [...message.matchAll(/(?:日期|时间)?范围\s*不变/g)].some(match =>
        !/(?:不要|不用|无需|不需要|(?<!分)别)\s*$/.test(message.slice(0, match.index).split(/[，,。；;！？!?\n]/).at(-1)));
      const sameMonth = validDate(previous?.startDate) && validDate(previous?.endDate)
        && previous.startDate.slice(0, 7) === year + '-' + pad(number)
        && previous.endDate.slice(0, 7) === previous.startDate.slice(0, 7);
      if (sameMonth && keepRange && /(?:回到|沿用|延续|继续|接着)\s*(?:刚才|之前|上述|原来|这个|该)/.test(message)
        && !/全月|整月|整个月|完整月份/.test(message)) return null;
      return monthRange(year, number);
    }
  }
  return null;
}

function isComparisonRequest(message) {
  return /对比|比较|分别|相比/.test(message)
    || /(?:\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月(?:份)?[^。！？]{0,18}比[^。！？]{0,18}(?:\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月/.test(message);
}
function extractComparisonScopes(message, today, previous = null) {
  if (typeof message !== 'string' || !validDate(today) || !isComparisonRequest(message)) return [];
  const scopes = [];
  for (const match of message.matchAll(/(?:(20\d{2})\s*年\s*)?(\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月(?:份)?(?!\s*\d{1,2}\s*(?:日|号))/g)) {
    const scope = explicitPeriod(match[0], today, previous);
    if (scope && !scopes.some(item => item.startDate === scope.startDate && item.endDate === scope.endDate)) scopes.push(scope);
  }
  return scopes.slice(0, 4);
}
function isQueryRequestText(message) {
  return typeof message === 'string' && /查|看|统计|分析|汇总|多少|哪|什么|怎么|图|比例|占比|数量|最大|最多|最高|最贵|排行|排名|是否|有没有|吗|[?？]/.test(message);
}
function isBusinessFollowupText(message) {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  return isNextPageRequest(text) || /^(?:那|那么)?\s*(?:(?:\d{1,2}|十一|十二|十|[一二三四五六七八九])\s*月(?:份)?\s*)?呢[?？。!！]*$/.test(text)
    || /^(?:那|那么)?\s*(?:借记卡|储蓄卡|信用卡|贷记卡|银行卡|卡片)\s*呢[?？。!！]*$/.test(text)
    || /^(?:其中|这两笔|这三笔|这些|它)(?:[?？。!！]*$|的|里|中|花|支出|收入|金额|数量|占比|比例|一共|总共|合计|多少|最大|最多|哪)/.test(text)
    || /^(?:同样|继续|接着|还是)[?？。!！]*$/.test(text)
    || /^(?:改成|我说|不是|更正|最大|最多|最高|最贵|哪天|哪一天)/.test(text)
    || /^(?:延续|沿用|继续|接着|回到|同样|按)\s*(?:按\s*)?(?:刚才|之前|上述|这个|该|同一|原来)/.test(text)
    || /^(?:日期范围|日期|范围|时间范围)[^。！？]{0,12}不变|^清空(?:文字|文本)?筛选/.test(text)
    || /^(?:那|那么)?\s*(?:数量|张数|几张|多少张)(?:呢)?[?？。!！]*$/.test(text);
}
function hasExplicitTransactionAmount(message) {
  return typeof message === 'string' && /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)\s*(?:元|块|毛|角|分|人民币|CNY|RMB)/i.test(message);
}
function isNewTransactionStatement(message) {
  if (typeof message !== 'string' || isQueryRequestText(message)) return false;
  return /花了|花费|支付了|付了|买了|买菜|购买|收到|收了|记一笔|帮我记|记录这笔/.test(message)
    || hasExplicitTransactionAmount(message) && /支出|收入|消费|支付|付|买|收/.test(message);
}
function isAccountSupplementText(message) {
  if (typeof message === 'string' && /(?:借记卡|储蓄卡|信用卡|贷记卡|银行卡|卡片)\s*呢[?？。!！]*$/.test(message.trim())) return false;
  if (typeof message !== 'string' || /查|看|统计|分析|汇总|多少|哪|最大|最多|最高|图|比例|占比|支出|收入|收支|消费|账单|流水|数量|张数|\d+(?:\.\d+)?\s*(?:元|块)|[?？]/.test(message.replace(/那张|这张/g, ''))) return false;
  return /(?:借记卡|储蓄卡|信用卡|银行卡|尾号)/.test(message)
    || /(?:说错|记错|写错|填错|选错|报错|搞错|更正)/.test(message) && /(?:银行|卡|账户|支付方式)/.test(message)
    || /(?:^|\s|银行)\d{1,4}\s*(?:那张|这张|这一个|那个|付的|支付|$)/.test(message.trim());
}

function buildQueryContext({ message, today, previous } = {}) {
  if (typeof message !== 'string' || !validDate(today)) return null;
  const intent = classifyCurrentTurn(message);
  if (intent.businessSuppressed) return null;
  const text = intent.businessMessage.trim();
  if (isAccountSupplementText(text) || isNewTransactionStatement(text)) return null;
  const prior = intent.topicReset ? null : sanitizeQueryContext(previous)?.activeQuery || null;
  const period = explicitPeriod(text, today, prior);
  const finance = /支出|收入|收支|消费|花费|花[的了]?|买了|买菜|购买|支付|付了|收到|收了|购汇|结汇|账单|流水|账本|余额|分类|账户|金额|单笔|一笔/.test(text);
  const question = isQueryRequestText(text) || /走势|趋势/.test(text);
  const followup = Boolean(prior) && isBusinessFollowupText(text);
  const nounQuery = finance && /^[^\d。！？]{1,30}(?:支出|收入|收支|消费|流水|账单)$/.test(text);
  if (!finance && /天气|气温|待办|日程|生日|纪念日|日记|提醒|备份/.test(text)) return null;
  // A dated purchase statement is still a draft request, never a query update.
  if (!(finance && question) && !(period && /呢|怎样|怎么样|情况|收支|支出|收入|图/.test(text)) && !followup && !nounQuery) return null;
  if (/买了|买一|购买|记一笔|帮我记|记录这笔/.test(text) && !question) return null;
  const category = /购汇/.test(text) ? '购汇' : /结汇/.test(text) ? '结汇' : null;
  const sameSubject = /这两笔|这些|它|该分类|这个分类|其中|里面|同类/.test(text);
  const broadSummary = /收支|收入\s*(?:和|与|及|、)?\s*支出|支出\s*(?:和|与|及|、)?\s*收入|总支出|全部支出|所有支出/.test(text);
  const hasMaximum = /最大|最高|最多|最贵/.test(stripQueryPresentationText(text));
  const asksDay = /哪一天|哪天|哪一日|哪日|每天|每日|按日/.test(text);
  const transactionMax = hasMaximum && (/一笔|单笔/.test(text) || Boolean(category) && asksDay);
  const dailyMax = hasMaximum && asksDay && !transactionMax;
  const dailySummary = !hasMaximum && /逐日|每日|每天|按日|日度/.test(text) && /汇总|统计/.test(text);
  const clearFilter = /清空(?:文字|文本)?筛选|清除(?:文字|文本)?筛选|取消(?:文字|文本)?筛选/.test(text);
  const income = /收入/.test(text);
  const expense = /支出|消费|花费|花[的了]?|购汇/.test(text) || !income && (transactionMax || dailyMax);
  const explicitDirection = broadSummary || expense || income;
  const direction = broadSummary ? null : expense ? 0 : income ? 1 : prior?.direction ?? null;
  const details = /明细|列出来|全部列|逐笔|每一笔/.test(text);
  const totalAmount = !hasMaximum && /多少钱|多少(?:元|块)|(?:支出|收入|收支|消费|花费|花了)[^。！？]{0,12}多少|总共|一共|合计|总额|总计/.test(text);
  const explicitMetric = transactionMax || dailyMax || dailySummary || details || totalAmount || broadSummary || nounQuery || /汇总|统计|图表|走势|趋势|分类|排行|排名/.test(text);
  const metric = transactionMax ? 'transaction-max' : dailyMax ? 'daily-max' : details ? 'transactions'
    : dailySummary || totalAmount || broadSummary || nounQuery || /图表|走势|趋势|汇总/.test(text) ? 'summary'
      : category || /分类|排行|排名/.test(text) ? 'category-summary' : prior?.metric || 'summary';
  const subjectReset = clearFilter || !category && !sameSubject && (broadSummary || dailyMax || dailySummary
    || (transactionMax || totalAmount) && /支出|消费|花|收入|收支/.test(text));
  const range = period || (prior ? { startDate: prior.startDate, endDate: prior.endDate }
    : { startDate: `${today.slice(0, 7)}-01`, endDate: today });
  return sanitizeQueryContext({ version: 1, ...(!intent.topicReset && sanitizeQueryContext(previous)?.lastResults ? { lastResults: previous.lastResults } : {}), activeQuery: { ...range, direction,
    category: category || (subjectReset ? null : prior?.category || null), metric, status: 'pending',
    explicit: { period: Boolean(period), direction: explicitDirection, category: Boolean(category), metric: Boolean(explicitMetric), subjectReset },
    allowComparison: isComparisonRequest(text), periodSource: period ? 'current' : prior ? 'inherited' : 'default' } });
}

function bindQuerySubject(context, { filter, message } = {}) {
  const safe = sanitizeQueryContext(context), subject = safeName(filter);
  if (!safe || !subject || /^(?:支出|收入|收支|全部|所有|最大|最多|最高)$/.test(subject)
    || typeof message !== 'string' || !message.toLocaleLowerCase().includes(subject.toLocaleLowerCase())) return safe;
  // A literal named in the current utterance may replace an old subject. The
  // service still validates the original tool arguments and reads fresh facts.
  safe.activeQuery.category = subject;
  safe.activeQuery.explicit.category = true;
  safe.activeQuery.explicit.subjectReset = false;
  return safe;
}

function attachQueryResults(context, datasets, { turnId } = {}) {
  const safe = sanitizeQueryContext(context);
  if (!safe || !Array.isArray(datasets)) return safe;
  const lastResults = datasets.filter(dataset => dataset?.queryMeta?.datasetId === dataset.datasetId
    && dataset.queryMeta.returnedRowCount === dataset.rows?.length)
    .map(dataset => safeCoverage({ ...dataset.queryMeta, incomeCount: dataset.summary?.incomeCount ?? null,
      expenseCount: dataset.summary?.expenseCount ?? null, turnId })).filter(Boolean).slice(-MAX_LAST_RESULTS);
  if (lastResults.length) safe.lastResults = lastResults;
  if (safe.activeQuery.periodSource === 'default' && lastResults.length && !safe.activeQuery.allowComparison) {
    const finance = lastResults.filter(result => result.datasetId.startsWith('finance-'));
    const scopes = new Set(finance.map(result => JSON.stringify({ scope: result.effectiveScope, filters: result.filters })));
    if (finance.length && scopes.size === 1) {
      const result = finance[0];
      Object.assign(safe.activeQuery, result.effectiveScope, { periodSource: 'inherited',
        direction: result.filters.direction === 'expense' ? 0 : result.filters.direction === 'income' ? 1 : null,
        category: result.filters.text || null });
    }
  }
  return safe;
}

function resolveQueryArgs(args, context) {
  const active = sanitizeQueryContext(context)?.activeQuery;
  if (!active || !args || typeof args !== 'object') return args;
  const result = { ...args };
  const force = !active.allowComparison;
  // Resolved user scope wins over a stale month/category emitted by the model.
  if (force && active.periodSource !== 'default' || !result.startDate) result.startDate = active.startDate;
  if (force && active.periodSource !== 'default' || !result.endDate) result.endDate = active.endDate;
  if (force && (active.explicit.direction || active.direction !== null) || !Object.hasOwn(result, 'direction')) result.direction = active.direction;
  if (force && (active.explicit.category || active.explicit.subjectReset || active.category !== null) || !Object.hasOwn(result, 'category')) result.category = active.category;
  if (force || !result.metric) result.metric = active.metric;
  if (force && active.explicit.subjectReset) result.filter = '';
  return result;
}

function finalizeQueryContext(context, { status, turnId, errorCode } = {}) {
  const safe = sanitizeQueryContext(context);
  if (!safe) return null;
  if (STATUSES.has(status)) safe.activeQuery.status = status;
  if (status !== 'failed') delete safe.errorCode;
  if (typeof turnId === 'string') safe.turnId = turnId;
  if (status === 'failed' && errorCode) safe.errorCode = errorCode;
  return sanitizeQueryContext(safe);
}

module.exports = { buildQueryContext, resolveQueryArgs, finalizeQueryContext, sanitizeQueryContext, attachQueryResults, bindQuerySubject,
  explicitPeriod, extractComparisonScopes, isComparisonRequest, isAccountSupplementText, stripQueryPresentationText,
  isQueryRequestText, hasExplicitTransactionAmount, isNewTransactionStatement, isBusinessFollowupText,
  sanitizeQueryCoverageResult: safeCoverage };
