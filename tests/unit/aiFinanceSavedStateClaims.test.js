const { normalizeFinanceSavedStateClaims: normalize } = require('../../src/modules/ai/service/queryFinanceSavedStateClaims');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const captured = require('../fixtures/aiFinanceSavedStateFixture.json');
const source = () => structuredClone(captured.dataset), text = captured.output.answer;
const state = '这些是当前已入账（历史发生）的汇总值';
const proved = '这些是已保存的收支汇总值';
test('the captured paid F04 historical summary state survives with exactly one predicate normalized', () => {
  const result = normalize(text, [source()]);
  expect(result).toBe(text.replace(state, proved));
  expect(() => assertResultClaims(result)).not.toThrow();
  expect(result).toContain('来源268笔已定价收支流水（收入115笔、支出153笔');
  expect(result).toContain('本次查询为只读，未新增或修改任何记录');
});
test('date-window rows can remain partial while the same approved monetary summary is complete', () => {
  const d = source(); expect(d.queryMeta.rowsComplete).toBe(false); expect(d.queryMeta.summaryComplete).toBe(true);
  expect(normalize(text, [d])).toContain(proved);
});
test.each([
  ['no approved query', d => []],
  ['invalid query identity', d => { delete d.queryMeta.queryId; return [d]; }],
  ['wrong dataset provenance', d => { d.queryMeta.datasetId = 'finance-monthly'; return [d]; }],
  ['no complete summary proof', d => { d.queryMeta.summaryComplete = false; return [d]; }],
  ['missing typed financial field', d => { d.columns.find(c => c.key === 'income').type = 'text'; return [d]; }],
  ['ambiguous equal-money second query', d => { const other = structuredClone(d); other.queryMeta.queryId = 'q_' + 'f'.repeat(24); return [d, other]; }],
  ['foreign-currency summary', d => { d.summary.currency = 'USD'; return [d]; }],
  ['unpriced records cannot support a complete historical summary', d => { d.summary.unpricedCount = 1; d.summary.incomplete = true; return [d]; }],
  ['summary belongs to another scope', d => { d.summary.startDate = '2026-05-01'; return [d]; }],
  ['published returned row count does not agree', d => { d.queryMeta.returnedRowCount = 2; return [d]; }],
  ['source record count does not agree with summary', d => { d.queryMeta.sourceRecordCount = 267; return [d]; }],
  ['invalid calendar scope', d => { d.queryMeta.effectiveScope.endDate = '2026-13-30'; return [d]; }],
])('unproved data state cannot neutralize current execution guard: %s', (_, change) => {
  const data = change(source()); expect(normalize(text, data)).toBe(text);
  expect(() => assertResultClaims(normalize(text, data))).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});
test.each([
  ['wrong income field', text.replace('已计入收入 CNY 3911.24', '已计入收入 CNY 5784.61')],
  ['wrong expense field', text.replace('已计入支出 CNY 5784.61', '已计入支出 CNY 3911.24')],
  ['wrong net sign', text.replace('净收支-1873.37元（赤字', '净收支1873.37元（赤字')],
  ['wrong deficit', text.replace('赤字1873.37元', '赤字3911.24元')],
  ['wrong named date scope', text.replaceAll('2026-06-01至2026-06-30', '2026-05-01至2026-05-31')],
  ['no explicit scope proof', text.replaceAll('2026-06-01至2026-06-30', '6月')],
  ['no adjacent field-bound monetary summary', text.replace('已计入收入 CNY 3911.24、已计入支出 CNY 5784.61', '收入和支出已返回')],
  ['a paragraph break cannot borrow preceding summary', text.replace('）。这些是', '）。\n\n这些是')],
  ['no proven currency in anchor', text.replaceAll('已计入收入 CNY ', '已计入收入 ').replaceAll('已计入支出 CNY ', '已计入支出 ')],
  ['future hypothetical summary', text.replace('保存值与历史发生值（按同一数据口径', '假设保存值与历史发生值（按同一数据口径')],
  ['income exponent is not the saved amount', text.replace('CNY 3911.24', 'CNY 3911.24e2')],
  ['expense exponent is not the saved amount', text.replace('CNY 5784.61', 'CNY 5784.61E2')],
  ['net exponent is not the saved amount', text.replace('净收支-1873.37', '净收支-1873.37e2')],
  ['percentage is not a monetary summary cell', text.replace('CNY 3911.24', 'CNY 3911.24%')],
  ['comma-connected numeric continuation is not the saved amount', text.replace('CNY 3911.24', 'CNY 3911.24,000')],
  ['whitespace percentage suffix is not a monetary summary cell', text.replace('CNY 3911.24', 'CNY 3911.24 %')],
])('inaccurate or unbound summary state remains unexempted: %s', (_, answer) => {
  expect(normalize(answer, [source()])).toBe(answer);
  expect(() => assertResultClaims(normalize(answer, [source()]))).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});
test('a partial month cannot be described as a complete month to gain data-state proof', () => {
  const d = source(); d.queryMeta.effectiveScope.endDate = d.summary.endDate = '2026-06-09';
  const answer = text.replaceAll('2026-06-30', '2026-06-09'); expect(normalize(answer, [d])).toBe(answer);
});
test('ASCII historical-state parentheses and a bound above-values subject retain readable Chinese', () => {
  const answer = text.replace(state, '上述金额是当前已入账(历史发生)的汇总值');
  expect(normalize(answer, [source()])).toContain('上述金额是已保存的收支汇总值');
});
test.each([
  '我已经完成入账。', '本次已经完成入账。', '已为你完成入账。', '我已经替你记入账本。',
  'I have posted the transaction.', 'We have updated your account balance.',
])('a real agent execution claim still requires its own execution receipt: %s', claim => {
  const answer = text + '\n' + claim, normalized = normalize(answer, [source()]);
  expect(normalized).toContain(claim);
  expect(() => assertResultClaims(normalized)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});
