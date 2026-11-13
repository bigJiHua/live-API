const { validateQueryMeta } = require('../../src/modules/ai/service/queryMetadata');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');

const scope = { domains: ['finance'], startDate: '2026-06-01', endDate: '2026-06-30' };
const range = { startDate: scope.startDate, endDate: scope.endDate };
function dataset() {
  return { datasetId: 'finance-categories', domain: 'finance', title: '分类收支',
    columns: [{ key: 'category', label: '分类', type: 'text' }, { key: 'firstDate', label: '首笔日期', type: 'date' },
      { key: 'lastDate', label: '末笔日期', type: 'date' }, { key: 'amountCNY', label: '金额', type: 'money' }],
    rows: [{ category: '购汇', firstDate: '2026-06-01', lastDate: '2026-06-03', amountCNY: '100.00' }],
    summary: { expense: '100.00', income: '0.00', count: 2, expenseCount: 2, incomeCount: 0 },
    truncated: false, policy: '同口径全量统计', asOf: '2026-11-08T00:00:00.000Z',
    queryMeta: { version: 1, queryId: 'q_0123456789abcdef01234567', datasetId: 'finance-categories',
      requestedScope: range, effectiveScope: range, filters: { direction: 'expense', text: '购汇' }, sort: 'categoryAmountDesc',
      matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 2, rowsComplete: true,
      summaryComplete: true, rankingComplete: true, returnedDateRange: null, asOf: '2026-11-08T00:00:00.000Z' } };
}
test('category date columns, scoped counts and query identity survive actual preview projection', async () => {
  const store = createPreviewStore({ executor: { execute: jest.fn(async () => [{ affectedRows: 1 }]) }, now: () => Date.parse('2026-11-08T00:00:00Z') });
  const d = dataset();
  const result = await store.prepare('synthetic-owner', { message: '六月购汇是哪天', scope,
    snapshot: { scope, datasets: [d], choices: {}, asOf: d.asOf } });
  expect(result.datasets[0].queryMeta).toEqual(d.queryMeta);
  expect(result.datasets[0].rows[0]).toMatchObject({ firstDate: '2026-06-01', lastDate: '2026-06-03' });
  expect(result.datasets[0].summary).toMatchObject({ count: 2, expenseCount: 2, incomeCount: 0 });
  expect(result.datasets[0].totalCount).toBe(1);
});
test.each([
  { returnedRowCount: 2 }, { matchedRowCount: 0 }, { matchedRowCount: null, rowsComplete: true },
  { effectiveScope: { startDate: '2026-05-01', endDate: '2026-05-31' } },
  { sourceRecordCount: -1 }, { unexpectedSecret: 'denied' },
  { returnedDateRange: { startDate: '2026-05-31', endDate: '2026-06-02' } },
])('invalid coverage evidence cannot enter provider preview: %j', patch => {
  const d = dataset(); expect(() => validateQueryMeta({ ...d.queryMeta, ...patch }, d, scope)).toThrow();
});
test('unknown matched count survives as null instead of being invented from returned rows', () => {
  const d = dataset(); const meta = { ...d.queryMeta, matchedRowCount: null, sourceRecordCount: null, rowsComplete: false,
    summaryComplete: false, rankingComplete: false };
  expect(validateQueryMeta(meta, d, scope)).toMatchObject({ matchedRowCount: null, returnedRowCount: 1, rowsComplete: false });
});
