const { validCountClaims } = require('../../src/modules/ai/service/queryCountClaims');

const scope = month => ({ startDate: `2026-${month}-01`, endDate: `2026-${month}-${month === '06' ? '30' : '31'}` });
function dataset(datasetId = 'finance-transactions', { month = '06', source = 268, returned = 50,
  matched = source, direction = 'both', rows, incomeCount = 100, expenseCount = 168 } = {}) {
  return {
    datasetId, domain: 'finance', truncated: returned < matched,
    columns: [{ key: 'amountCNY', type: 'money' }, { key: 'direction', type: 'number' }],
    // The amount 50 deliberately collides with the returned count; it cannot
    // authorize a claim that all 268 matching source transactions total 50 rows.
    rows: rows || Array.from({ length: returned }, (_, index) => ({ amountCNY: '50.00', direction: index % 2 })),
    summary: { count: source, incomeCount, expenseCount, expense: '5784.61', income: '3911.24' },
    queryMeta: { effectiveScope: scope(month), filters: { direction, text: '' },
      sourceRecordCount: source, matchedRowCount: matched, returnedRowCount: returned },
  };
}
const details = () => dataset();
const monthly = () => dataset('finance-monthly', { returned: 1, matched: 1 });
const categories = () => dataset('finance-categories', { month: '05', source: 252, matched: 23, returned: 23,
  incomeCount: 50, expenseCount: 202 });

test.each([
  ['an equal monetary cell cannot authorize a total transaction count', '共50笔流水。', false],
  ['source and returned quantities can coexist in one sentence', '全月268笔流水，已返回50笔。', true],
  ['explicit returned details use the window count', '已返回50笔明细。', true],
  ['the source count cannot authorize an inflated returned count', '已返回268笔。', false],
  ['an amount before a total does not turn the total into an expense count', '支出50元，共268笔收支。', true],
  ['expense and income source counts use their own fields', '共168笔支出、100笔收入。', true],
  ['a mixed returned window cannot be called all expenses', '已返回50笔支出。', false],
  ['fractional counts are not financial record quantities', '共50.5笔流水。', false],
])('%s', (_, sentence, expected) => {
  expect(validCountClaims(sentence, [details()])).toBe(expected);
});

test.each([
  ['one monthly result row is not one source transaction', '月度汇总共1笔流水。', false],
  ['a monthly row and its source transactions remain separate', '已返回1行月度汇总，涉及268笔流水。', true],
])('%s', (_, sentence, expected) => {
  expect(validCountClaims(sentence, [monthly()])).toBe(expected);
});

test.each([
  ['category result rows cannot masquerade as source transactions', '23笔流水。', false],
  ['category groups and source transactions use separate quantities', '23组分类，涉及252笔流水。', true],
])('%s', (_, sentence, expected) => {
  expect(validCountClaims(sentence, [categories()])).toBe(expected);
});

test('an expense-filtered returned window can state its expense quantity', () => {
  const value = dataset('finance-transactions', { direction: 'expense', source: 168, matched: 168,
    rows: Array.from({ length: 50 }, () => ({ amountCNY: '50.00', direction: 0 })) });
  expect(validCountClaims('已返回50笔支出。', [value])).toBe(true);
});

test('server-observed all-expense returned rows can authorize an explicit returned expense quantity', () => {
  const value = dataset('finance-transactions', { rows: Array.from({ length: 50 }, () => ({ amountCNY: '50.00', direction: 0 })) });
  expect(validCountClaims('已返回50笔支出。', [value])).toBe(true);
});

test('an unknown source total permits the known returned count without inventing a full count', () => {
  const value = details(); value.queryMeta.sourceRecordCount = null; value.queryMeta.matchedRowCount = null;
  expect(validCountClaims('共50笔流水。', [value])).toBe(false);
  expect(validCountClaims('已返回50笔。', [value])).toBe(true);
});

test('the exact source count is available in legacy finance history, while rows alone cannot prove a total', () => {
  const value = monthly(); delete value.queryMeta;
  expect(validCountClaims('共268笔流水。', [value])).toBe(true);
  expect(validCountClaims('共1笔流水。', [value])).toBe(false);
});

test.each([
  ['5月共268笔流水。', false],
  ['6月共252笔流水。', false],
  ['5月共252笔流水，6月共268笔流水。', true],
  ['2026年5月共268笔流水。', false],
  ['2026-05-01至2026-05-31，共268笔流水。', false],
])('explicit months cannot borrow another query quantity: %s', (sentence, expected) => {
  expect(validCountClaims(sentence, [categories(), monthly()])).toBe(expected);
});

test('scope-bound returned counts cannot borrow a different month window', () => {
  const may = dataset('finance-transactions', { month: '05', source: 252, returned: 2, incomeCount: 50, expenseCount: 202 });
  expect(validCountClaims('5月已返回50笔流水。', [may, details()])).toBe(false);
  expect(validCountClaims('5月已返回2笔流水，6月已返回50笔流水。', [may, details()])).toBe(true);
});

test('returned expense wording before the number stays a returned quantity', () => {
  const value = dataset('finance-transactions', { direction: 'expense', source: 168, matched: 168,
    rows: Array.from({ length: 50 }, () => ({ amountCNY: '50.00', direction: 0 })) });
  expect(validCountClaims('已返回支出50笔。', [value])).toBe(true);
});

test('expense wording before the return verb cannot label a mixed window all expenses', () => {
  expect(validCountClaims('支出已返回50笔。', [details()])).toBe(false);
});

test('a grouped monthly row cannot be called a returned ledger record with the alternate 条 unit', () => {
  expect(validCountClaims('已返回1条流水。', [monthly()])).toBe(false);
});

test('a source quantity cannot become a negative record count', () => {
  expect(validCountClaims('共-268笔流水。', [details()])).toBe(false);
});

test('an identified month can cite the server-provided monthly source row count in a multi-month aggregate', () => {
  const value = monthly();
  value.queryMeta.effectiveScope = { startDate: '2026-05-01', endDate: '2026-06-30' };
  value.queryMeta.sourceRecordCount = 520; value.queryMeta.matchedRowCount = 2; value.queryMeta.returnedRowCount = 2;
  value.summary.count = 520;
  value.columns = [{ key: 'month', type: 'date' }, { key: 'count', type: 'number' }];
  value.rows = [{ month: '2026-05', count: 252 }, { month: '2026-06', count: 268 }];
  expect(validCountClaims('5月共252笔流水，6月共268笔流水。', [value])).toBe(true);
});
