jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));
const { explicitPeriod, buildQueryContext, resolveQueryArgs, sanitizeQueryCoverageResult } = require('../../src/modules/ai/service/queryContext');
const { buildTaskContext } = require('../../src/modules/ai/service/taskContext');
const today = '2026-11-08';

test.each(['最近三个月', '最近3个月', '近三个月', '近 3 个 月', '最近三月', '过去三个月', '最近三个月，截至今天'])
  ('%s uses three calendar months including the current partial month', text => {
    expect(explicitPeriod(`${text}哪张借记卡支出最高？`, today))
      .toEqual({ startDate: '2026-09-01', endDate: today });
  });

test.each([
  ['最近一个月', '2026-11-08', '2026-11-01'],
  ['最近两个月', '2026-11-08', '2026-10-01'],
  ['最近十一月', '2026-11-08', '2026-01-01'],
  ['最近十二个月', '2026-11-08', '2025-12-01'],
  ['近3个月', '2026-01-02', '2025-11-01'],
  ['近十二个月', '2024-02-29', '2023-03-01'],
])('%s on %s handles count and year boundaries', (text, anchor, startDate) => {
  expect(explicitPeriod(text, anchor)).toEqual({ startDate, endDate: anchor });
});

test('explicit recent months replace the prior period in query and card task context', () => {
  const previous = buildQueryContext({ message: '5月支出最高是哪一天？', today });
  const message = '最近三个月哪张借记卡的支出最高？';
  const queryContext = buildQueryContext({ message, today, previous });
  const taskContext = buildTaskContext({ message, today, queryContext });
  expect(queryContext.activeQuery).toMatchObject({ startDate: '2026-09-01', endDate: today,
    periodSource: 'current', explicit: { period: true } });
  expect(taskContext).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-consumption',
    cardTypes: ['debit'], scope: { startDate: '2026-09-01', endDate: today } });
  expect(resolveQueryArgs({ startDate: '2026-08-01', endDate: today }, queryContext))
    .toMatchObject({ startDate: '2026-09-01', endDate: today });
});

test('a short followup inherits the established recent-month range without mistaking it for March', () => {
  const previous = buildQueryContext({ message: '最近三个月的支出？', today });
  expect(buildQueryContext({ message: '支出最大的一笔？', today, previous }).activeQuery)
    .toMatchObject({ startDate: '2026-09-01', endDate: today, periodSource: 'inherited' });
  expect(explicitPeriod('三月支出', today)).toEqual({ startDate: '2026-03-01', endDate: '2026-03-31' });
});

test('explicit calendar dates retain priority and recent days keep their existing inclusive behavior', () => {
  expect(explicitPeriod('最近三个月，具体查2026-08-15到2026-10-15', today))
    .toEqual({ startDate: '2026-08-15', endDate: '2026-10-15' });
  expect(explicitPeriod('最近90天支出', today)).toEqual({ startDate: '2026-08-11', endDate: today });
});

test.each(['最近0个月', '近121个月', '最近三个月滚动范围', '最近三个完整月', '最近三个月不含本月'])
  ('%s is not silently reinterpreted as the supported month window', text => {
    expect(explicitPeriod(text, today)).toBeNull();
  });

test.each(['近13个月', '最近十三个月', '近十三月'])('%s supports a complete multi-year calendar-month range', text => {
  expect(explicitPeriod(text, today)).toEqual({ startDate: '2025-11-01', endDate: today });
});

const coverage = (rest = {}) => ({ version: 1, datasetId: 'card-monthlyConsumption',
  requestedScope: { startDate: '2026-09-01', endDate: today }, effectiveScope: { startDate: '2026-09-01', endDate: today },
  filters: { direction: 'expense', text: '', cardTypes: ['debit'] }, sort: 'amountDesc', groupBy: 'card',
  matchedRowCount: 2, returnedRowCount: 1, sourceRecordCount: 20,
  rowsComplete: false, summaryComplete: true, rankingComplete: true, returnedDateRange: null,
  asOf: '2026-11-08T12:00:00.000Z', ...rest });

test('saved card coverage retains its grouping and actual type/direction filter without old rows', () => {
  expect(sanitizeQueryCoverageResult(coverage({ rows: [{ amountCNY: '999.00' }] }))).toMatchObject({
    groupBy: 'card', filters: { direction: 'expense', text: '', cardTypes: ['debit'] }, cardTypes: ['debit'] });
  expect(JSON.stringify(sanitizeQueryCoverageResult(coverage({ rows: [{ amountCNY: '999.00' }] })))).not.toContain('999.00');
  expect(sanitizeQueryCoverageResult(coverage({ groupBy: 'cardMonth' })).groupBy).toBe('cardMonth');
});

test.each([
  { groupBy: 'month' },
  { groupBy: 'card', datasetId: 'finance-monthly' },
  { filters: { direction: 'expense', text: '', cardTypes: ['debit', 'debit'] } },
  { filters: { direction: 'expense', text: '', cardTypes: ['unknown'] } },
  { filters: { direction: 'expense', text: '', cardTypes: 'debit' } },
  { filters: { direction: 'expense', text: '', cardTypes: ['debit'], sql: 'SELECT private' } },
  { datasetId: 'finance-monthly', groupBy: undefined },
])('invalid grouping or card filters cannot enter saved query coverage: %j', extra => {
  expect(sanitizeQueryCoverageResult(coverage(extra))).toBeNull();
});

test('old coverage without optional card grouping/type filters remains valid', () => {
  const result = sanitizeQueryCoverageResult(coverage({ groupBy: undefined, filters: { direction: 'both', text: '' } }));
  expect(result).not.toBeNull(); expect(result).not.toHaveProperty('groupBy');
  expect(result.filters).toEqual({ direction: 'both', text: '' });
});
