jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));
const { buildTaskContext, sanitizeTaskContext, finalizeTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryContext, resolveQueryArgs, extractComparisonScopes } = require('../../src/modules/ai/service/queryContext');
const today = '2026-11-08';
const build = (message, rest = {}) => buildTaskContext({ message, today, ...rest });

test('the actual debit/credit pie request means card count without inheriting today consumption', () => {
  const queryContext = buildQueryContext({ message: '今天消费多少', today });
  const result = build('给我画个饼图 饼图内容是借记卡 信用卡的比例', { queryContext });
  expect(result).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-count', cardTypes: ['debit', 'credit'],
    chartRequest: { type: 'pie', metric: 'count' }, comparisonScopes: [] });
  expect(result.scope).toBeUndefined();
});
test('a quantity correction preserves the requested pie and excludes virtual account types', () => {
  const previous = build('借记卡和信用卡消费金额给我饼图');
  expect(previous.metric).toBe('card-consumption');
  const result = build('我说的是当前已有的借记卡和信用卡的数量比例，不是收支哦', { previous });
  expect(result).toMatchObject({ subject: 'cards', metric: 'card-count', cardTypes: ['debit', 'credit'],
    chartRequest: { type: 'pie', metric: 'count' } });
  expect(result.scope).toBeUndefined();
});
test.each([
  ['不是信用卡，只看借记卡', ['debit']],
  ['不要借记卡，信用卡数量', ['credit']],
  ['只看借记卡，不要信用卡', ['debit']],
  ['不要信用卡', ['debit']],
  ['不是信用卡消费，我说的是借记卡和信用卡数量', ['debit', 'credit']],
  ['刚才说不要信用卡，现在信用卡和借记卡都要', ['debit', 'credit']],
])('a card type correction excludes negated types and keeps the existing pie: %s', (message, cardTypes) => {
  const previous = build('借记卡和信用卡数量比例给我饼图');
  const result = build(message, { previous });
  expect(result).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-count', cardTypes,
    chartRequest: { type: 'pie', metric: 'count' } });
  expect(result.scope).toBeUndefined();
});
test('declining a chart modification retains the pie while declining the chart clears it', () => {
  const previous = build('借记卡和信用卡数量比例给我饼图');
  expect(build('不用改饼图，只看借记卡数量', { previous }))
    .toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-count', cardTypes: ['debit'],
      chartRequest: { type: 'pie', metric: 'count' } });
  expect(build('不要饼图，只给文字', { previous }).chartRequest).toBeNull();
  expect(build('不画饼图了，只看借记卡数量', { previous }).chartRequest).toBeNull();
});
test('a fresh finance question clears prior card count and pie preferences', () => {
  const previous = build('借记卡信用卡数量比例饼图');
  const queryContext = buildQueryContext({ message: '6月支出和收入给我图表', today });
  expect(build('6月支出和收入给我图表', { previous, queryContext })).toMatchObject({ subject: 'finance', metric: 'summary',
    cardTypes: [], chartRequest: { type: 'bar', metric: 'amount' }, scope: { startDate: '2026-06-01', endDate: '2026-06-30' } });
});
test('a finance month comparison carries two independent scopes and preserves model selected dates', () => {
  const message = '6月比5月支出多多少？';
  const queryContext = buildQueryContext({ message, today });
  expect(queryContext.activeQuery.allowComparison).toBe(true);
  const result = build(message, { queryContext });
  expect(result.comparisonScopes).toEqual([{ startDate: '2026-06-01', endDate: '2026-06-30' },
    { startDate: '2026-05-01', endDate: '2026-05-31' }]);
  expect(resolveQueryArgs({ startDate: '2026-05-01', endDate: '2026-05-31' }, queryContext).startDate).toBe('2026-05-01');
});
test.each(['六月比五月收入多多少', '分别看6月和5月的支出', '对比2025年6月和2026年5月'])('comparison understands %s', message => {
  expect(extractComparisonScopes(message, today)).toHaveLength(2);
});
test('a card ratio does not accidentally enable a multi-month comparison', () => {
  expect(extractComparisonScopes('借记卡与信用卡的比例饼图', today)).toEqual([]);
});
test.each(['7476', '7476那张', '农业银行7476那张', '用的借记卡'])('account reply %s never inherits an old query', message => {
  const oldQuery = buildQueryContext({ message: '6月支出最大的一笔', today });
  expect(buildQueryContext({ message, today, previous: oldQuery })).toBeNull();
  const previous = build('6月支出最大的一笔', { queryContext: oldQuery });
  expect(build(message, { previous, queryContext: null }).mode).toBe('chat');
  expect(build(message, { previous, pendingContext: { status: 'awaiting_input' } }).mode).toBe('pending-supplement');
});
test('a card income/expense question remains a query rather than account-only input', () => {
  expect(buildQueryContext({ message: '信用卡支出', today })).not.toBeNull();
});

test('changing card type then requesting a monthly trend preserves the actual prior date range', () => {
  const previous = build('最近三个月哪张借记卡支出最高？');
  expect(previous.scope).toEqual({ startDate: '2026-09-01', endDate: '2026-11-08' });
  const credit = build('信用卡呢？', { previous });
  expect(credit).toMatchObject({ subject: 'cards', metric: 'card-consumption', cardTypes: ['credit'], scope: previous.scope });
  const trend = build('按月份给我看走势。', { previous: credit });
  expect(trend).toMatchObject({ subject: 'cards', cardTypes: ['credit'], scope: previous.scope,
    chartRequest: { type: 'line', metric: 'amount' } });
  const current = build('这个月信用卡支出呢？', { previous: credit });
  expect(current.scope).toEqual({ startDate: '2026-11-01', endDate: '2026-11-08' });
});
test('new consumption does not silently supplement an older pending batch', () => {
  expect(build('今天又买了12元午饭，用现金', { pendingContext: { status: 'awaiting_input' } }).mode).toBe('record');
});
test.each(['今天支出30元，农业借记卡支付', '今天收入100元', '用借记卡支出30元', '那张借记卡支出30元'])
  ('a new monetary statement starts a record rather than inheriting the old query or batch: %s', message => {
    const oldQuery = buildQueryContext({ message: '6月支出最大的一笔是？', today });
    const previous = build('6月支出最大的一笔是？', { queryContext: oldQuery });
    const queryContext = buildQueryContext({ message, today, previous: oldQuery });
    expect(queryContext).toBeNull();
    const task = build(message, { previous, queryContext, pendingContext: { status: 'awaiting_input' } });
    expect(task).toMatchObject({ mode: 'record', subject: 'finance', metric: null, cardTypes: [], chartRequest: null });
    expect(task.scope?.startDate).not.toBe('2026-06-01');
  });
test.each(['查5月买菜花了30元那笔', '看5月买菜花了30元那笔', '查一下5月买了什么'])
  ('an explicit historical purchase query cannot become a record while a batch is pending: %s', message => {
    const queryContext = buildQueryContext({ message, today });
    expect(build(message, { queryContext, pendingContext: { status: 'awaiting_input' } }))
      .toMatchObject({ mode: 'query', subject: 'finance', scope: { startDate: '2026-05-01', endDate: '2026-05-31' } });
  });
test('a receipt status question is not a new income statement', () => {
  expect(build('收到100元了吗？', { pendingContext: { status: 'awaiting_input' } }).mode).toBe('query');
});
test('a bare reference or date cannot independently revive a previous finance query or create a record', () => {
  const previous = build('6月支出最大的一笔是？', { queryContext: buildQueryContext({ message: '6月支出最大的一笔是？', today }) });
  expect(build('那', { previous }).mode).toBe('chat');
  expect(build('5月30日', { previous, pendingContext: { status: 'awaiting_input' } }).mode).toBe('chat');
});
test('pending cancellation does not confuse a cancelled reminder with a cancelled transaction', () => {
  expect(build('这三笔不记了', { pendingContext: { status: 'awaiting_input' } }).mode).toBe('pending-cancel');
  expect(build('取消提醒', { pendingContext: { status: 'awaiting_input' } }).mode).not.toBe('pending-cancel');
});
test('list details reset a previous maximum metric', () => {
  const previous = buildQueryContext({ message: '今天支出最大的一笔是？', today });
  expect(buildQueryContext({ message: '今天5笔收支全部列出来我看看', today, previous }).activeQuery.metric).toBe('transactions');
});
test('a new total expense question synchronizes task and query scope while clearing the previous maximum metric', () => {
  const oldQuery = buildQueryContext({ message: '6月支出最大的一笔是？', today });
  const previous = build('6月支出最大的一笔是？', { queryContext: oldQuery });
  const message = '看5月份花了多少钱';
  const queryContext = buildQueryContext({ message, today, previous: oldQuery });
  expect(build(message, { previous, queryContext, pendingContext: { status: 'awaiting_input' } }))
    .toMatchObject({ mode: 'query', subject: 'finance', metric: 'summary',
      scope: { startDate: '2026-05-01', endDate: '2026-05-31' } });
});
test('persisted failed task keeps the corrected chart request without carrying query facts or references', () => {
  const result = finalizeTaskContext({ ...build('借记卡信用卡数量比例饼图'), rows: [{ amount: '99.00' }], ref: 'old-ref' },
    { status: 'failed', turnId: 'failed_chart', errorCode: 'AI_PROVIDER_RATE_LIMIT' });
  expect(result).toMatchObject({ status: 'failed', turnId: 'failed_chart', chartRequest: { type: 'pie', metric: 'count' } });
  expect(JSON.stringify(result)).not.toMatch(/99\.00|old-ref/);
  expect(finalizeTaskContext(result, { status: 'succeeded', turnId: 'retry_chart' }).errorCode).toBeUndefined();
});
test('task sanitization removes unsupported types, scopes and business data', () => {
  const safe = sanitizeTaskContext({ version: 1, mode: 'query', subject: 'cards', metric: 'card-count',
    cardTypes: ['credit', 'cash', 'credit'], comparisonScopes: [{ startDate: 'bad', endDate: 'bad' }], amount: '100', apiKey: 'secret' });
  expect(safe.cardTypes).toEqual(['credit']);
  expect(safe.comparisonScopes).toEqual([]);
  expect(safe.amount).toBeUndefined(); expect(safe.apiKey).toBeUndefined();
});

test('metadata row counts do not replace card consumption with card count', () => {
  const message = '查看最近三个月所有卡片逐卡逐月的消费流水金额。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。';
  expect(build(message)).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-consumption' });
  expect(build('信用卡和借记卡数量分别是多少，最多展示10条？')).toMatchObject({ metric: 'card-count' });
});

test('a bare quantity continuation changes card consumption to card count', () => {
  const previous = build('最近三个月信用卡消费是多少？');
  expect(build('数量呢？', { previous })).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-count', cardTypes: ['credit'] });
});

test('a card list with bill-day settings does not become a saved bill lookup', () => {
  expect(build('查看当前我的卡片清单和账单日、还款日、登记到期月份。最多展示10条，并说明匹配数量。'))
    .toMatchObject({ subject: 'cards', metric: 'card-list' });
  expect(build('查看2026年9月至11月已保存信用卡账单和待还金额。')).toMatchObject({ metric: 'card-bills' });
});

test('budget and card followups retain the full stated date range', () => {
  expect(build('查看2026年11月1日至9日预算计划。最多展示10条。').scope)
    .toEqual({ startDate: '2026-11-01', endDate: '2026-11-09' });
  const previous = build('查看2026年5月1日至8月31日信用卡还款历史。');
  expect(build('延续刚才这个查询，日期范围不变，清空文字筛选，改为只展示1条。', { previous }))
    .toMatchObject({ subject: 'cards', metric: 'card-repayments', scope: previous.scope });
});
