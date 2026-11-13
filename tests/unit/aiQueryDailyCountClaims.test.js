const { validCountClaims } = require('../../src/modules/ai/service/queryCountClaims');
function daily() {
  return { datasetId: 'finance-daily', domain: 'finance', title: '每日收支',
    columns: [{ key: 'date', type: 'date' }, { key: 'income', type: 'money' }, { key: 'expense', type: 'money' },
      { key: 'count', type: 'number' }, { key: 'unpricedCount', type: 'number' }, { key: 'net', type: 'money' }],
    rows: [{ date: '2026-06-02', income: '1472.06', expense: '1093.97', count: 15, unpricedCount: 0, net: '378.09' },
      { date: '2026-06-18', income: '8.56', expense: '1015.19', count: 13, unpricedCount: 0, net: '-1006.63' }],
    summary: { count: 268, incomeCount: 115, expenseCount: 153 },
    queryMeta: { queryId: 'q_000000000000000000000001', effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
      filters: { direction: 'both', text: '' }, sourceRecordCount: 268, matchedRowCount: 30, returnedRowCount: 2 } };
}
test.each([
  ['6月2日：收入1472.06元，支出1093.97元，15笔，净收+378.09元。', true],
  ['6月18日：收入8.56元，支出1015.19元，13笔，净支-1006.63元。', true],
  ['2026-06-02：共15笔。', true],
  ['2026年6月2日：笔数15。', true],
  ['6月2日：未定价笔数0。', true],
  ['6月2日：13笔。', false],
  ['6月18日：15笔。', false],
  ['6月2日：支出15笔。', false],
  ['6月2日：收入15笔。', false],
  ['6月2日：支出笔数15。', false],
  ['6月2日：收入笔数15。', false],
  ['6月2日：15.5笔。', false],
  ['6月2日：-15笔。', false],
  ['6月30日：268笔。', false],
  ['6月31日：15笔。', false],
  ['2025年6月2日：15笔。', false],
  ['6月全月共268笔收支。', true],
  ['2026-06-01至2026-06-30共268笔收支。', true],
  ['本次展示2行，来源268笔收支。', true],
])('daily quantities attach to the approved date row: %s', (text, expected) => {
  expect(validCountClaims(text, [daily()])).toBe(expected);
});
test('a numeric internal row field is not evidence unless its count column is published', () => {
  const d = daily(); d.columns = d.columns.filter(column => column.key !== 'count');
  expect(validCountClaims('6月2日：15笔。', [d])).toBe(false);
});
test('same date across distinct query results is ambiguous even when numeric counts coincide', () => {
  const d = daily(), sibling = daily(); sibling.queryMeta.queryId = 'q_000000000000000000000002';
  sibling.queryMeta.filters.text = '另一筛选';
  expect(validCountClaims('6月2日：15笔。', [d, sibling])).toBe(false);
});
test('a cross-year query needs the date row year stated explicitly', () => {
  const d = daily(); d.queryMeta.effectiveScope.startDate = '2025-12-01';
  expect(validCountClaims('6月2日：15笔。', [d])).toBe(false);
  expect(validCountClaims('2026年6月2日：15笔。', [d])).toBe(true);
});
test('a date not returned in this limited query cannot borrow another row or full-range count', () => {
  const d = daily(); d.rows = d.rows.slice(1); d.queryMeta.returnedRowCount = 1;
  expect(validCountClaims('6月2日：15笔。', [d])).toBe(false);
  expect(validCountClaims('6月2日：268笔。', [d])).toBe(false);
});
test('published direction-specific day counts support only their own field', () => {
  const d = daily(); d.columns.push({ key: 'incomeCount', type: 'number' }, { key: 'expenseCount', type: 'number' });
  Object.assign(d.rows[0], { incomeCount: 8, expenseCount: 7 });
  expect(validCountClaims('6月2日：收入笔数8，支出笔数7。', [d])).toBe(true);
  expect(validCountClaims('6月2日：收入笔数7，支出笔数8。', [d])).toBe(false);
});
