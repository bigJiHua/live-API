const { planQuery, pageInfo, CURSOR_TTL_MS } = require('../../src/modules/ai/service/largeQuery');
const { fitQueryWindow } = require('../../src/modules/ai/service/queryWindow');
const { resumePageInput } = require('../../src/modules/ai/service/queryWindow');
const { buildTaskContext } = require('../../src/modules/ai/service/taskContext');
const { explicitPeriod } = require('../../src/modules/ai/service/queryContext');
const { validateTool } = require('../../src/modules/ai/service/v3Tools');
const { redactContextData } = require('../../src/modules/ai/service/modelContext');
const clock = new Date('2026-11-12T04:00:00Z');
const scope = { domains: ['finance'], startDate: '2023-11-12', endDate: '2026-11-12' };
const input = { datasetId: 'finance-transactions', scope, requestedScope: { startDate: scope.startDate, endDate: scope.endDate },
  direction: 'both', sort: 'dateDesc', filter: '', resolution: 'detail', limit: 20 };

test('V3 preserves three years while retaining explicit display limits', () => {
  const args = validateTool('query_data', { datasetId: 'finance-monthly', startDate: scope.startDate, endDate: scope.endDate }, '2026-11-12');
  expect(args.scope).toEqual(scope);
  expect(args).not.toHaveProperty('queryNotice.rangeIncomplete');
  expect(planQuery(args, 'owner', clock)).toMatchObject({ resolution: 'month', limit: 50, offset: 0 });
  expect(() => validateTool('query_data', { datasetId: 'finance-monthly', startDate: '2000-01-01', endDate: scope.endDate }, '2026-11-12')).toThrow('十年');
});

test('multi-year wording resolves its full range before 截至今天 can become one day', () => {
  for (const phrase of ['近3年', '近三年', '过去三年，截至今天'])
    expect(explicitPeriod(phrase, '2026-11-12')).toEqual({ startDate: '2023-11-12', endDate: '2026-11-12' });
  expect(explicitPeriod('最近36个月，截至今天', '2026-11-12')).toEqual({ startDate: '2023-12-01', endDate: '2026-11-12' });
  expect(explicitPeriod('近三年', '2024-02-29')).toEqual({ startDate: '2021-02-28', endDate: '2024-02-29' });
  expect(explicitPeriod('2023年至2026年', '2026-11-12')).toEqual({ startDate: '2023-01-01', endDate: '2026-12-31' });
});

test('signed continuation resumes the exact owner and scope, allowing a new page size', () => {
  const cursor = pageInfo(planQuery(input, 'owner', clock), 4984, 20).nextCursor;
  expect(planQuery({ ...input, limit: 10, cursor }, 'owner', clock).offset).toBe(20);
  for (const changed of [{ scope: { ...scope, startDate: '2024-01-01' } }, { filter: '吃饭' }, { sort: 'amountDesc' }, { resolution: 'year' }])
    expect(() => planQuery({ ...input, ...changed, cursor }, 'owner', clock)).toThrow();
  expect(() => planQuery({ ...input, cursor }, 'another-owner', clock)).toThrow('续查凭据');
  expect(() => planQuery({ ...input, cursor: cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A') }, 'owner', clock)).toThrow('续查凭据');
  expect(() => planQuery({ ...input, cursor }, 'owner', new Date(clock.getTime() + CURSOR_TTL_MS))).toThrow('续查凭据');
});

test('unknown row counts issue no unverifiable continuation', () => {
  expect(pageInfo(planQuery(input, 'owner', clock), null, 20)).toMatchObject({ hasMore: false, nextCursor: null });
});

test('capacity trimming preserves full totals and resumes after disclosed rows', () => {
  const args = { ...input, limit: 50 };
  const plan = planQuery(args, 'owner', clock);
  const dataset = { datasetId: args.datasetId, columns: [{ key: 'remark', label: '备注', type: 'text' }],
    rows: Array.from({ length: 50 }, (_, id) => ({ id: String(id), remark: '长备注'.repeat(170) })),
    summary: { income: '12000.00', expense: '9900.00', count: 4984 }, policy: '完整SQL汇总',
    queryMeta: { resolution: 'detail', matchedRowCount: 4984, returnedRowCount: 50, rowsComplete: false,
      summaryComplete: true, rankingComplete: false, sort: 'dateDesc', filters: { direction: 'both', text: '' },
      page: pageInfo(plan, 4984, 50), asOf: clock.toISOString(), returnedDateRange: null } };
  const snapshot = { scope, datasets: [dataset], choices: {} };
  fitQueryWindow(snapshot, args, 'owner', 6000, clock);
  expect(dataset.rows.length).toBeLessThan(50);
  expect(dataset.summary).toEqual({ income: '12000.00', expense: '9900.00', count: 4984 });
  expect(dataset.queryMeta).toMatchObject({ returnedRowCount: dataset.rows.length, summaryComplete: true, rowsComplete: false });
  expect(planQuery({ ...args, cursor: dataset.queryMeta.page.nextCursor }, 'owner', clock).offset).toBe(dataset.rows.length);
});

test('validated machine cursors survive history text redaction', () => {
  const cursor = pageInfo(planQuery(input, 'owner', clock), 100, 20).nextCursor;
  expect(redactContextData({ page: { nextCursor: cursor }, note: 'free prose' }, () => '[redacted]'))
    .toEqual({ page: { nextCursor: cursor }, note: '[redacted]' });
});

test('next-page intent preserves the previous subject and binds its latest cursor', () => {
  const args = validateTool('query_data', { datasetId: 'work-salary', startDate: scope.startDate, endDate: scope.endDate, resolution: 'detail', limit: 20 }, '2026-11-12');
  const page = pageInfo(planQuery(args, 'owner', clock), 784, 20);
  const coverage = { results: [{ datasetId: 'work-salary', requestedScope: args.requestedScope, resolution: 'detail',
    filters: { direction: 'both', text: '' }, sort: 'dateDesc', page }] };
  const resumed = resumePageInput('下一页', { datasetId: 'work-salary' }, coverage);
  expect(resumed).toMatchObject({ startDate: scope.startDate, endDate: scope.endDate, cursor: page.nextCursor, resolution: 'detail' });
  expect(resumed).not.toHaveProperty('direction');
  expect(() => resumePageInput('下一页', { datasetId: 'fund-history' }, coverage)).toThrow('下一页');
  const previous = { ...buildTaskContext({ message: '查询2023-11-12至2026-11-12的工资明细', today: '2026-11-12' }), targetDatasetId: 'work-salary' };
  const restored = buildTaskContext({ message: '下一页', previous, today: '2026-11-12' });
  expect(restored).toMatchObject({ subject: 'work', targetDatasetId: 'work-salary', mode: 'query' });
});
