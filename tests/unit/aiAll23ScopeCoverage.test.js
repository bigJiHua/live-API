jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { validateTool, selectSnapshot } = require('../../src/modules/ai/service/v3Tools');
const { buildTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryTaskBindings } = require('../../src/modules/ai/service/queryTaskBindings');
const { choiceCoverage } = require('../../src/modules/ai/service/v3Tools');
const { selectTaskContext } = require('../../src/modules/ai/service/contextState');
const now = '2026-11-09T01:00:00.000Z';
const raw = (id, summary, rows = []) => ({ asOf: now, choices: {}, datasets: [{ datasetId: id,
  domain: id.split('-')[0], title: '保存数据', columns: [{ key: 'name', label: '名称', type: 'text' }],
  rows, summary, policy: '保存值', asOf: now, truncated: false }] });
const args = id => ({ ...validateTool('query_data', { datasetId: id }, '2026-11-09'), queryId: 'q_' + 'a'.repeat(24) });

test('unverified currency metadata alone cannot certify a full-range summary', () => {
  const snapshot = selectSnapshot('query_data', args('asset-snapshots'), raw('asset-snapshots', { currency: 'unverified' }));
  expect(snapshot.datasets[0].queryMeta.summaryComplete).toBe(false);
  expect(snapshot.datasets[0].queryMeta.rowsComplete).toBe(true);
});
test('filtered SQL facts retain exact matched count beyond the result window', () => {
  const a = { ...args('fund-history'), filter: '旧基金', limit: 1 };
  const source = raw('fund-history', {}, [{ name: '旧基金' }, { name: '旧基金' }]);
  Object.assign(source.datasets[0], { truncated: true, fullRangeQuery: { matchedRowCount: 137, filter: '旧基金' } });
  const dataset = selectSnapshot('query_data', a, source).datasets[0];
  expect(dataset.queryMeta).toMatchObject({ matchedRowCount: 137, returnedRowCount: 1, rowsComplete: false });
  expect(dataset.totalCount).toBe(137);
});
test.each([
  ['查看工资规则', 'work'], ['查看系统流动资产快照', 'asset'], ['查看账户余额快照', 'account'],
  ['查看分期计划保存状态', 'installment'],
])('a %s task keeps its own subject instead of adopting the preceding finance month', (message, subject) => {
  const context = buildTaskContext({ message, today: '2026-11-09',
    queryContext: { activeQuery: { startDate: '2026-05-01', endDate: '2026-05-31', metric: 'transaction-max' } } });
  expect(context).toMatchObject({ mode: 'query', subject, metric: 'summary' });
  expect(context.scope?.startDate).not.toBe('2026-05-01');
});
test('month-only followup selects the latest active subject', () => {
  const task = (subject, month) => ({ version: 1, mode: 'query', subject, metric: 'summary', status: 'succeeded',
    scope: { startDate: `2026-${month}-01`, endDate: `2026-${month}-28` } });
  const finance = task('finance', '05'), fund = task('fund', '09');
  expect(selectTaskContext({ version: 1, tasks: [finance, fund] }, { message: '那10月份呢？', previous: fund }).subject).toBe('fund');
});
test('separate asset and salary clauses are represented by separate task bindings', () => {
  const bindings = buildQueryTaskBindings({ message: '查看2026年5月流动资产快照；另外查看2026年6月已登记工资', today: '2026-11-09' });
  expect(bindings.map(b => b.taskContext.subject)).toEqual(['asset', 'work']);
  expect(bindings.map(b => b.taskContext.scope.startDate)).toEqual(['2026-05-01', '2026-06-01']);
});
test('one returned candidate cannot prove uniqueness outside a truncated source', () => {
  const source = { choices: { funds: [{ id: 'fixture-fund', name: '同名基金' }] },
    datasets: [{ datasetId: 'fund-holdings', truncated: true }] };
  const coverage = choiceCoverage({ domain: 'fund', group: 'funds', filter: '同名基金', limit: 1 }, source,
    { choices: source.choices });
  expect(coverage.funds).toEqual({ total: null, returned: 1, truncated: true });
});
