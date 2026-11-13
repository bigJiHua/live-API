jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { validFundAmountClaims, fundQueryExplanation } = require('../../src/modules/ai/service/queryFundProse');
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
// Anonymous monetary and name-prefix collisions; no real ledger fixture.
const scope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const queryMeta = datasetId => ({ datasetId, effectiveScope: scope, filters: { direction: 'both', text: '' },
  matchedRowCount: 2, returnedRowCount: 2, sourceRecordCount: null, rowsComplete: true, summaryComplete: false });
const holdings = () => ({ datasetId: 'fund-holdings', domain: 'fund', title: '基金登记汇总', queryMeta: queryMeta('fund-holdings'),
  columns: [{ key: 'name', type: 'text' }, { key: 'principal', type: 'money' }, { key: 'profit', type: 'decimal' }, { key: 'marketValue', type: 'money' }],
  rows: [{ name: '示例基金', principal: '1200.00', profit: '45.6700', marketValue: '1245.67' },
    { name: '示例基金2号', principal: '0.00', profit: '8.9000', marketValue: '8.90' }], summary: {}, truncated: false });
const history = () => ({ datasetId: 'fund-history', domain: 'fund', title: '基金日收益登记历史', queryMeta: queryMeta('fund-history'),
  columns: [{ key: 'name', type: 'text' }, { key: 'date', type: 'date' }, { key: 'profit', type: 'decimal' }, { key: 'capitalDelta', type: 'money' }],
  rows: [{ name: '示例基金2号', date: '2026-06-04', profit: '-4.5000', capitalDelta: '0.00' },
    { name: '示例基金2号', date: '2026-06-03', profit: '7.2000', capitalDelta: '150.00' }], summary: {}, truncated: false });

test.each([
  ['示例基金登记本金1200.00，已登记收益合计45.67，登记市值1245.67', true],
  ['示例基金2号登记本金0，已登记收益合计8.9000，登记市值8.90', true],
  ['示例基金本金为0', false], ['示例基金本金为零', false], ['示例基金 principal is zero', false],
  ['示例基金登记本金45.67', false], ['示例基金已登记收益合计1200.00', false],
  ['示例基金2号登记市值1245.67', false], ['示例基金2号登记本金1200.00', false],
  ['示例基金已登记收益合计-45.67', false], ['示例基金已登记收益合计+45.6700', true],
  ['示例基金本金1,200.00', true], ['示例基金本金1200.0000', true],
  ['示例基金本金增量1200.00', false], ['示例基金收益增量45.67', false],
])('holding values bind their exact fund and monetary field: %s', (sentence, expected) => {
  expect(validFundAmountClaims(sentence, [holdings()])).toBe(expected);
});
test.each([
  ['示例基金2号2026-06-04收益增量-4.5000，本金增量0.00', true],
  ['示例基金2号2026-06-03收益增量7.20，本金增量150.00', true],
  ['2026-06-04收益增量-4.50，本金增量0', true],
  ['示例基金2号2026-06-04收益增量4.50', false],
  ['示例基金2号2026-06-04收益增量7.20', false],
  ['示例基金2号2026-06-03本金增量0', false],
  ['示例基金2号2026-06-04收益合计-4.50', false],
  ['示例基金2号2026-06-04本金0', false],
  ['示例基金2号2026-06-05收益增量-4.50', false],
  ['示例基金2号收益增量-4.50', false],
  ['示例基金2026-06-04收益增量-4.50', false],
  ['示例基金2号6月4日收益增量负4.50', true],
  ['示例基金2号06-04收益增量-4.50', true],
])('daily values also bind the date, sign and increment field: %s', (sentence, expected) => {
  expect(validFundAmountClaims(sentence, [history()])).toBe(expected);
});
test('wrong explanations leave a complete useful authoritative answer', () => {
  const answer = buildQueryAnswer('说明：示例基金本金为0；示例基金市值为本金与已登记收益之和。', [holdings()]);
  expect(answer).not.toContain('示例基金本金为0');
  expect(answer).toContain('示例基金：登记本金 1200.00，已登记收益合计 45.6700，登记市值 1245.67');
  expect(answer).toContain('示例基金2号：登记本金 0.00，已登记收益合计 8.9000，登记市值 8.90');
  expect(answer).toContain('示例基金市值为本金与已登记收益之和');
});
test('history output preserves every date and all profit and capital cells', () => {
  const answer = buildQueryAnswer('示例基金2号2026-06-04收益增量7.20', [history()]);
  expect(answer).toContain('2026-06-04：收益增量 -4.5000，本金增量 0.00');
  expect(answer).toContain('2026-06-03：收益增量 7.2000，本金增量 150.00');
  expect(answer).not.toContain('2026-06-04收益增量7.20');
});
test('unknown saved values do not become zero', () => {
  const rows = holdings(); rows.rows[0].profit = null;
  expect(validFundAmountClaims('示例基金已登记收益合计0', [rows])).toBe(false);
  expect(buildQueryAnswer('', [rows])).toContain('已登记收益合计 未登记');
});
test('truncated source rows do not produce a whole-scope total', () => {
  const rows = holdings(); rows.truncated = true; rows.queryMeta.rowsComplete = false; rows.queryMeta.matchedRowCount = 8;
  const answer = buildQueryAnswer('基金收益合计54.57', [rows]);
  expect(answer).toContain('部分登记记录，不能相加作为完整合计');
  expect(answer).not.toContain('54.57');
  expect((answer.match(/^- /gm) || []).length).toBe(2);
});
test('empty history answers missing saved records rather than zero', () => {
  const rows = history(); rows.rows = []; rows.queryMeta.matchedRowCount = rows.queryMeta.returnedRowCount = 0;
  expect(buildQueryAnswer('收益增量0', [rows])).toContain('没有已保存记录，不代表本金或收益为零');
});
test('repeated filtering is stable and does not share global regular-expression lastIndex', () => {
  const text = ['示例基金登记本金1200.00', '示例基金2号登记本金0', '示例基金登记市值1245.67', '示例基金2号登记市值8.90'].join('\n');
  expect(fundQueryExplanation(text, [holdings()])).toBe('');
  expect(fundQueryExplanation(text, [holdings()])).toBe('');
});
test('a longer unreturned name cannot borrow a returned prefix name', () => {
  const rows = holdings(); rows.rows = [rows.rows[0]];
  expect(validFundAmountClaims('示例基金2号本金1200', [rows])).toBe(false);
});
