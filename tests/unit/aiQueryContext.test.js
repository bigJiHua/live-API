const { buildQueryContext, resolveQueryArgs, finalizeQueryContext, sanitizeQueryContext, bindQuerySubject, attachQueryResults, explicitPeriod } = require('../../src/modules/ai/service/queryContext');
const today = '2026-11-08';
const build = (message, previous) => buildQueryContext({ message, today, previous });

test('a June summary followed by largest transaction retains June and selects expenses', () => {
  const june = build('看一下6月份的支出和收入，给图表给我');
  const next = build('支出最大的一笔是？', june);
  expect(next.activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30',
    direction: 0, category: null, metric: 'transaction-max', periodSource: 'inherited' });
  expect(resolveQueryArgs({ datasetId: 'finance-transactions', startDate: '2026-05-01', endDate: '2026-05-31',
    category: '购汇', direction: 1, filter: '购汇' }, next)).toMatchObject({
    startDate: '2026-06-01', endDate: '2026-06-30', direction: 0, category: null, filter: '', metric: 'transaction-max' });
});

test('explicit June income and expense clears the prior May foreign exchange subject', () => {
  const may = build('5月份支出最多的购汇是哪一天？');
  expect(may.activeQuery).toMatchObject({ category: '购汇', metric: 'transaction-max', direction: 0 });
  const june = build('那你看一下6月份的支出和收入，给图表给我', may);
  expect(june.activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30', category: null,
    direction: null, metric: 'summary', explicit: { subjectReset: true } });
});

test('month-only continuation keeps the previous category and metric', () => {
  const may = build('5月份支出最多的购汇是哪一天？');
  expect(build('6月呢？', may).activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30',
    category: '购汇', direction: 0, metric: 'transaction-max' });
});

test('largest spending day resets a prior category unless that category is referenced', () => {
  const may = build('5月份支出最多的购汇是哪一天？');
  expect(build('花的最多是哪一天？在5月份。', may).activeQuery).toMatchObject({ category: null, metric: 'daily-max', direction: 0 });
  expect(build('这两笔花的最多是哪一天？', may).activeQuery).toMatchObject({ category: '购汇', metric: 'daily-max' });
});

test('an explicit comparison permits independent model-selected periods and subjects', () => {
  const context = build('分别比较5月和6月支出');
  expect(resolveQueryArgs({ datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-06-30',
    direction: 0, category: null }, context)).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
});

test('relative days use the trusted utterance date and month arithmetic crosses years', () => {
  expect(buildQueryContext({ message: '昨天支出最多的一笔？', today: '2026-01-01' }).activeQuery)
    .toMatchObject({ startDate: '2025-12-31', endDate: '2025-12-31' });
  expect(buildQueryContext({ message: '上个月支出多少？', today: '2026-01-01' }).activeQuery)
    .toMatchObject({ startDate: '2025-12-01', endDate: '2025-12-31' });
});

test('explicit calendar days and income maxima retain the requested scope and direction', () => {
  expect(build('5月1日到5月20日收入最大的一笔').activeQuery).toMatchObject({
    startDate: '2026-05-01', endDate: '2026-05-20', direction: 1, metric: 'transaction-max' });
  expect(build('6月份金额最大的一笔是？').activeQuery).toMatchObject({
    startDate: '2026-06-01', direction: 0, metric: 'transaction-max' });
});

test('income day extrema keep June and income direction when following an expense query', () => {
  const previous = build('6月支出最多是哪一天？');
  const current = build('改成收入，最多的是哪一天？', previous);
  expect(current.activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30',
    direction: 1, metric: 'daily-max', periodSource: 'inherited' });
  const completed = attachQueryResults(current, [{ datasetId: 'finance-daily', rows: [{}], summary: { incomeCount: 115, expenseCount: 0 },
    queryMeta: { version: 1, queryId: 'q_0123456789abcdef01234567', datasetId: 'finance-daily',
      requestedScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
      filters: { direction: 'income', text: '' }, sort: 'incomeDesc', matchedRowCount: 30, returnedRowCount: 1, sourceRecordCount: 115,
      rowsComplete: false, summaryComplete: true, rankingComplete: true, returnedDateRange: null, asOf: '2026-11-08T04:00:00.000Z' } }]);
  expect(sanitizeQueryContext(completed).lastResults[0]).toMatchObject({ sort: 'incomeDesc', filters: { direction: 'income' }, rankingComplete: true });
});

test('a purchase statement or unrelated chat does not change query context', () => {
  const june = build('6月份收支图表');
  expect(build('今天买了8.5元零食，微信支付', june)).toBeNull();
  expect(build('帮我记一笔18元奶茶', june)).toBeNull();
  expect(build('谢谢', june)).toBeNull();
});

test.each(['6月花了多少钱', '看5月份花了多少钱', '5月支出多少', '5月收入多少'])
  ('an explicit total amount question resets an inherited maximum metric: %s', message => {
    const previous = build('6月支出最大的一笔是？');
    expect(build(message, previous).activeQuery).toMatchObject({ metric: 'summary', explicit: { metric: true } });
  });
test('a broad total expense question clears a previous category while a same-category total preserves it', () => {
  const previous = build('5月份支出最多的购汇是哪一天？');
  expect(build('6月花了多少钱', previous).activeQuery).toMatchObject({ category: null, metric: 'summary' });
  expect(build('这两笔一共多少钱呢', previous).activeQuery).toMatchObject({ category: '购汇', metric: 'summary' });
  expect(build('最大的一笔多少钱', previous).activeQuery.metric).toBe('transaction-max');
});
test('a historical purchase lookup remains a query and a bare reference cannot replace the current scope', () => {
  const previous = build('6月支出最大的一笔是？');
  expect(build('查5月买菜花了30元那笔', previous).activeQuery)
    .toMatchObject({ startDate: '2026-05-01', endDate: '2026-05-31' });
  expect(build('那', previous)).toBeNull();
  expect(build('5月30日', previous)).toBeNull();
});

test('an unknown query period defaults only when model arguments also omit the period', () => {
  const context = build('查看支出');
  expect(context.activeQuery.periodSource).toBe('default');
  expect(resolveQueryArgs({ datasetId: 'finance-monthly', startDate: '2026-07-01', endDate: '2026-07-31' }, context))
    .toMatchObject({ startDate: '2026-07-01', endDate: '2026-07-31' });
  expect(resolveQueryArgs({ datasetId: 'finance-monthly' }, context)).toMatchObject({ startDate: '2026-11-01', endDate: today });
});

test('failed query context retains intent and is sanitized without old rows or refs', () => {
  const context = build('6月份收支');
  context.rows = [{ amountCNY: '999.00', ref: `r_${'a'.repeat(32)}` }];
  context.activeQuery.ref = `r_${'b'.repeat(32)}`;
  const failed = finalizeQueryContext(context, { status: 'failed', turnId: 'failed_1', errorCode: 'AI_PREVIEW_INVALID' });
  expect(failed).toMatchObject({ turnId: 'failed_1', errorCode: 'AI_PREVIEW_INVALID', activeQuery: { status: 'failed', startDate: '2026-06-01' } });
  expect(JSON.stringify(failed)).not.toContain('999.00');
  expect(JSON.stringify(failed)).not.toContain('r_');
  expect(build('支出最大的一笔是？', failed).activeQuery).toMatchObject({ startDate: '2026-06-01', status: 'pending', metric: 'transaction-max' });
  expect(finalizeQueryContext(failed, { status: 'succeeded' }).errorCode).toBeUndefined();
});

test('invalid persisted context cannot establish a query period', () => {
  expect(sanitizeQueryContext({ activeQuery: { startDate: '2026-02-30', endDate: '2026-03-01' } })).toBeNull();
  expect(sanitizeQueryContext({ activeQuery: { startDate: '2026-07-01', endDate: '2026-06-30' } })).toBeNull();
});

test('an arbitrary literal category survives a month-only continuation but stale model filters cannot bind', () => {
  const dining = bindQuerySubject(build('餐饮支出'), { filter: '餐饮', message: '餐饮支出' });
  expect(dining.activeQuery).toMatchObject({ category: '餐饮', direction: 0, metric: 'summary' });
  const june = build('那6月呢？', dining);
  expect(resolveQueryArgs({ datasetId: 'finance-monthly', filter: '购汇' }, june)).toMatchObject({
    startDate: '2026-06-01', endDate: '2026-06-30', category: '餐饮' });
  const overall = build('6月份收入和支出', dining);
  expect(bindQuerySubject(overall, { filter: '餐饮', message: '6月份收入和支出' }).activeQuery.category).toBeNull();
  expect(bindQuerySubject(overall, { filter: '支出', message: '6月份收入和支出' }).activeQuery.category).toBeNull();
});

test('weather and reminder followups do not replace a finance query context', () => {
  const june = build('6月份收支');
  expect(build('明天天气怎么样呢？', june)).toBeNull();
  expect(build('明天提醒我取快递', june)).toBeNull();
});

const coverage = overrides => ({ version: 1, datasetId: 'finance-monthly', requestedScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
  effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, filters: { direction: 'both', text: '' }, sort: 'monthAsc',
  matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 268, rowsComplete: true, summaryComplete: true, rankingComplete: true,
  asOf: '2026-11-08T04:00:00.000Z', ...overrides });

test('next-turn coverage retains source ranges and counts without old rows, amounts, or refs', () => {
  const dataset = { datasetId: 'finance-monthly', rows: [{ income: '3911.24', ref: 'old-ref' }],
    summary: { count: 268, incomeCount: 34, expenseCount: 234 },
    queryMeta: coverage({ amountCNY: '999.00', ref: 'old-ref' }) };
  const completed = attachQueryResults(build('6月份收支'), [dataset], { turnId: 'june_result' });
  const july = build('7月份收入和支出', completed);
  expect(july.activeQuery.startDate).toBe('2026-07-01');
  expect(july.lastResults).toEqual([expect.objectContaining({ source: 'previous-turn', status: 'succeeded', turnId: 'june_result',
    datasetId: 'finance-monthly', effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, matchedRowCount: 1,
    returnedRowCount: 1, sourceRecordCount: 268, incomeCount: 34, expenseCount: 234,
    rowsComplete: true, summaryComplete: true, rankingComplete: true })]);
  expect(JSON.stringify(july.lastResults)).not.toMatch(/3911\.24|999\.00|old-ref|"rows"|"ref"/);
  const failed = finalizeQueryContext(july, { status: 'failed', turnId: 'july_failed', errorCode: 'AI_READ_FAILED' });
  expect(failed.activeQuery.status).toBe('failed');
  expect(failed.lastResults[0].turnId).toBe('june_result');
  expect(failed.lastResults[0].sourceRecordCount).toBe(268);
  expect(failed.lastResults[0]).toMatchObject({ incomeCount: 34, expenseCount: 234 });
});

test('coverage is bounded, retains unknown counts as null, and rejects mismatched returned counts', () => {
  const datasets = Array.from({ length: 6 }, (_, index) => ({ datasetId: 'finance-monthly', rows: [{}],
    queryMeta: coverage({ sourceRecordCount: index + 1 }) }));
  const bounded = attachQueryResults(build('6月份收支'), datasets, { turnId: 'query_many' });
  expect(bounded.lastResults.map(result => result.sourceRecordCount)).toEqual([3, 4, 5, 6]);
  const unknown = attachQueryResults(build('6月份收支'), [{ datasetId: 'finance-monthly', rows: [{}],
    queryMeta: coverage({ matchedRowCount: null, sourceRecordCount: null, rowsComplete: false, summaryComplete: false, rankingComplete: false }) }]);
  expect(unknown.lastResults[0]).toMatchObject({ matchedRowCount: null, sourceRecordCount: null,
    incomeCount: null, expenseCount: null, rowsComplete: false });
  expect(attachQueryResults(build('6月份收支'), [{ datasetId: 'finance-monthly', rows: [{}], queryMeta: coverage({ returnedRowCount: 2 }) }]).lastResults).toBeUndefined();
});

test('a default period is refined to one actual verified finance scope for subsequent continuations', () => {
  const context = build('查看以前的支出');
  expect(context.activeQuery.periodSource).toBe('default');
  const actual = attachQueryResults(context, [{ datasetId: 'finance-monthly', rows: [{}], queryMeta: coverage({
    requestedScope: { startDate: '2025-01-01', endDate: '2025-12-31' }, effectiveScope: { startDate: '2025-01-01', endDate: '2025-12-31' },
    filters: { direction: 'expense', text: '餐饮' } }) }]);
  expect(actual.activeQuery).toMatchObject({ startDate: '2025-01-01', endDate: '2025-12-31', category: '餐饮', direction: 0, periodSource: 'inherited' });
  expect(build('最大的一笔呢？', actual).activeQuery).toMatchObject({ startDate: '2025-01-01', endDate: '2025-12-31' });
  const explicit = attachQueryResults(build('6月份支出'), [{ datasetId: 'finance-monthly', rows: [{}], queryMeta: coverage({
    requestedScope: { startDate: '2025-01-01', endDate: '2025-12-31' }, effectiveScope: { startDate: '2025-01-01', endDate: '2025-12-31' } }) }]);
  expect(explicit.activeQuery.startDate).toBe('2026-06-01');
});

test('different actual scopes do not refine an ambiguous default period', () => {
  const context = build('查看以前的支出');
  const actual = attachQueryResults(context, [{ datasetId: 'finance-monthly', rows: [{}], queryMeta: coverage() },
    { datasetId: 'finance-monthly', rows: [{}], queryMeta: coverage({ requestedScope: { startDate: '2026-05-01', endDate: '2026-05-31' },
      effectiveScope: { startDate: '2026-05-01', endDate: '2026-05-31' } }) }]);
  expect(actual.activeQuery).toMatchObject({ startDate: '2026-11-01', periodSource: 'default' });
});

test.each([
  '查看6月份逐日收入与支出的每日汇总。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。',
  '查看6月每日收入统计，最多显示十条。',
  '6月每日支出汇总，最多返回50条。',
  '6月按日收入与支出汇总，不超过50条记录。',
  '6月每日支出统计，至多列出前五十条。',
])('a presentation row limit cannot turn daily totals into an expense champion: %s', message => {
  const previous = build('6月支出最多是哪一天？');
  const result = build(message, previous);
  expect(result.activeQuery).toMatchObject({ metric: 'summary', category: null,
    startDate: '2026-06-01', endDate: '2026-06-30' });
  if (/收入与支出/.test(message)) expect(result.activeQuery.direction).toBeNull();
});

test.each([
  ['6月支出最多的是哪一天？最多展示1条。', 'daily-max', 0],
  ['6月收入最高的是哪一天？只返回第一条。', 'daily-max', 1],
  ['6月支出最大的一笔是哪天？最多返回10笔。', 'transaction-max', 0],
])('a real maximum stays a maximum after removing presentation text: %s', (message, metric, direction) => {
  expect(build(message).activeQuery).toMatchObject({ metric, direction });
});

test('a filter and display continuation clears the filter while retaining metric and dates', () => {
  const previous = build('6月购汇支出最大的一笔？');
  const current = build('延续刚才这个查询，日期范围不变，清空文字筛选，改为只展示1条。', previous);
  expect(current.activeQuery).toMatchObject({ category: null, metric: 'transaction-max',
    startDate: '2026-06-01', endDate: '2026-06-30', periodSource: 'inherited' });
  expect(resolveQueryArgs({ datasetId: 'finance-transactions', filter: '购汇', direction: 'expense' }, current).filter).toBe('');
});

test.each([
  ['2026年11月1日至9日预算计划', '2026-11-01', '2026-11-09'],
  ['2026年11月1日至11月9日待办', '2026-11-01', '2026-11-09'],
  ['2026年5月1日至8月31日还款', '2026-05-01', '2026-08-31'],
  ['2026年11月9日工资', '2026-11-09', '2026-11-09'],
  ['2026年11月1号到9号日程', '2026-11-01', '2026-11-09'],
  ['2026年12月30日至1月2日待办', '2026-12-30', '2027-01-02'],
  ['2026-11-01至2026-11-09预算', '2026-11-01', '2026-11-09'],
  ['2024年2月29日收支', '2024-02-29', '2024-02-29'],
])('an explicitly stated date range keeps its abbreviated endpoint: %s', (message, startDate, endDate) => {
  expect(explicitPeriod(message, today)).toEqual({ startDate, endDate });
});

test.each(['2026年2月30日收支', '2026年2月28日至30日预算', '2026-02-30收支', '2026年11月9日至1日工资'])
  ('an invalid explicit date cannot silently fall back to a default month: %s', message => {
    expect(() => explicitPeriod(message, today)).toThrow(expect.objectContaining({ code: 'AI_SCOPE_INVALID' }));
  });
