const { createBusinessReadRepository } = require('../../src/modules/ai/service/businessRead');
const { selectSnapshot } = require('../../src/modules/ai/service/v3Tools');
const scope = { startDate: '2026-11-01', endDate: '2026-11-09' };
const group = (type, currency, count, missingSnapshots = 0) => ({ type, currency, count, missingSnapshots,
  positiveAssets: '1.00', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00' });
function executor(groups, matchedRowCount, sourceRecordCount) {
  return { query: jest.fn().mockResolvedValue(), beginTransaction: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue(),
    execute: jest.fn(async ({ sql }) => {
      if (!sql.includes('FROM card_base c LEFT JOIN account_balance')) return [[]];
      if (sql.includes('COUNT(*) AS matchedRowCount')) return [[{ matchedRowCount, sourceRecordCount }]];
      return [groups];
    }) };
}
test.each([
  ['source accounts differ from group rows and missing snapshots', [group('credit', '未登记', 3, 3), group('debit', 'CNY', 5)], 2, 8, '', 50],
  ['display limit one retains all account source count', [group('credit', '未登记', 3, 3), group('debit', 'CNY', 5)], 2, 8, '', 1],
  ['literal currency filter has its own source count', [group('debit', 'USD', 5)], 1, 5, 'USD', 50],
  ['mixed currency source count adds counts only', [group('debit', 'CNY', 2), group('debit', 'USD', 3)], 2, 5, '', 50],
  ['proven empty filter returns zero source accounts', [], 0, 0, '%_不存在', 3],
  ['reader window does not reduce full source count', Array.from({ length: 101 }, (_, i) => group('debit', `C${i}`, 10)), 120, 1200, '', 1],
])('%s', async (_, groups, matched, source, filter, limit) => {
  const db = executor(groups, matched, source);
  const raw = await createBusinessReadRepository({ executor: db }).query('fixture-owner', { domains: ['asset'], datasetId: 'asset-composition', filter, ...scope });
  const original = raw.datasets.find(d => d.datasetId === 'asset-composition');
  expect(original.fullRangeQuery).toEqual({ matchedRowCount: matched, sourceRecordCount: source, filter });
  const output = selectSnapshot('query_data', { datasetId: 'asset-composition', scope, requestedScope: scope, direction: 'both', filter, limit,
    queryId: 'q_1234567890abcdef12345678' }, raw).datasets[0];
  expect(output.queryMeta).toMatchObject({ matchedRowCount: matched, sourceRecordCount: source, returnedRowCount: Math.min(groups.length, 100, limit),
    rowsComplete: matched === Math.min(groups.length, 100, limit), summaryComplete: false, rankingComplete: false });
  expect(output.summary).toEqual({});
  const [{ sql }, params] = db.execute.mock.calls.find(([{ sql }]) => sql.includes('COUNT(*) AS matchedRowCount') && sql.includes('FROM card_base c LEFT JOIN account_balance'));
  expect(sql).toContain('COALESCE(SUM(ai_source.`count`), 0) AS sourceRecordCount');
  expect(sql).not.toContain('LIMIT 101'); expect(sql).not.toContain('fixture-owner');
  expect(params[0]).toBe('fixture-owner');
  if (filter) { expect(sql).not.toContain(filter); expect(params.slice(1)).toEqual(Array(4).fill(filter)); }
  expect(db.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
  expect(db.rollback).toHaveBeenCalledTimes(1);
});
test.each([null, -1, '1.50', '9007199254740992', 3])('rejects invalid or contradictory source count %s', async value => {
  const db = executor([], 4, value);
  await expect(createBusinessReadRepository({ executor: db }).query('fixture-owner', { domains: ['asset'], datasetId: 'asset-composition', ...scope }))
    .rejects.toMatchObject({ code: 'AI_READ_INVALID_COUNT', status: 503 });
  expect(db.rollback).toHaveBeenCalledTimes(1);
});
test('unrelated dataset cannot reuse composition-only source count', () => {
  const raw = { scope, choices: {}, asOf: '2026-11-09T04:00:00Z', datasets: [{ datasetId: 'budget-plans', domain: 'budget', title: '预算',
    columns: [{ key: 'title', label: '预算', type: 'text' }], rows: [{ title: '测试预算', count: 999 }], summary: {}, truncated: false,
    fullRangeQuery: { matchedRowCount: 1, sourceRecordCount: 999, filter: '' }, asOf: '2026-11-09T04:00:00Z' }] };
  const value = selectSnapshot('query_data', { datasetId: 'budget-plans', scope, filter: '', limit: 1, queryId: 'q_1234567890abcdef12345678' }, raw);
  expect(value.datasets[0].queryMeta.sourceRecordCount).toBeNull();
});
