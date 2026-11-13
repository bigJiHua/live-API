jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const { validCountClaims } = require('../../src/modules/ai/service/queryCountClaims');
const { validMonthlyTransactionClaims } = require('../../src/modules/ai/service/queryMonthlyProse');

// Synthetic monthly data: the cutoff day deliberately differs from every
// published numeric value, while wrong dates/counts sometimes collide with one.
function monthly() {
  const scope = { startDate: '2026-06-01', endDate: '2026-10-13' };
  return { datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
    columns: [{ key: 'month', type: 'date' }, { key: 'income', type: 'money' },
      { key: 'expense', type: 'money' }, { key: 'net', type: 'money' }, { key: 'count', type: 'number' }],
    rows: [
      { month: '2026-06', income: '3400.00', expense: '2500.00', net: '900.00', count: 130 },
      { month: '2026-07', income: '120.00', expense: '4900.00', net: '-4780.00', count: 43 },
      { month: '2026-08', income: '13200.00', expense: '1400.00', net: '11800.00', count: 18 },
      { month: '2026-09', income: '100.00', expense: '100.00', net: '0.00', count: 6 },
      { month: '2026-10', income: '0.00', expense: '300.00', net: '-300.00', count: 14 },
    ], summary: { income: '16820.00', expense: '9200.00', net: '7620.00', count: 211,
      incomeCount: 6, expenseCount: 205, unpricedCount: 0, currency: 'CNY', incomplete: false },
    truncated: false, isEstimated: false,
    queryMeta: { version: 1, queryId: 'q_aaaaaaaaaaaaaaaaaaaaaaaa', datasetId: 'finance-monthly',
      requestedScope: scope, effectiveScope: scope, filters: { direction: 'both', text: '' }, sort: 'monthAsc',
      matchedRowCount: 5, returnedRowCount: 5, sourceRecordCount: 211,
      rowsComplete: true, summaryComplete: true, rankingComplete: true } };
}

test('verified conversational summary leads without a forced summary or duplicate detail table', () => {
  const text = '看你近5个月记下来的账，整体还有结余：收入16,820.00元，支出9,200.00元，净结余7,620.00元。\n\n'
    + '各个月的差别挺大，8月收入13,200.00元，撑起了这段时间的整体结余。\n\n'
    + '10月截至13日花了300.00元，还没有收入记录，这个月要等后面再看。';
  expect(buildQueryAnswer(text, [monthly()])).toBe(text);
});

test('a parenthetical full-range total does not become the final month count', () => {
  const text = '近5个月（2026-06-01 至 2026-10-13，10月仅统计到13日）合计收入16,820.00元，支出9,200.00元，净结余7,620.00元，共211笔。';
  expect(validCountClaims(text, [monthly()])).toBe(true);
  expect(buildQueryAnswer(text, [monthly()])).toBe(text);
});

test.each(['10月才过13天，已记支出300.00元。', '10月已过13天，已记支出300.00元。',
  '10月前13天已记支出300.00元。'])('elapsed calendar days retain the natural wording: %s', text => {
  expect(buildQueryAnswer(text, [monthly()])).toContain(text);
});

test.each(['10月截至14日花了300.00元。', '10月才过14天，已记支出300.00元。', '9月截至13日花了100.00元。',
  '近6个月收入16,820.00元。', '10月共211笔。',
  '2026-06-01 至 2026-09-13，共211笔。', '净结余7,999.00元。'])
  ('unsupported dates, periods, row counts and amounts still fail: %s', text => {
    expect(buildQueryAnswer(text, [monthly()])).not.toContain(text);
  });

test('a valid range followed by an explicit month still uses that month count', () => {
  const data = monthly();
  expect(validCountClaims('2026-06-01 至 2026-10-13，10月共211笔。', [data])).toBe(false);
  expect(validCountClaims('2026-06-01 至 2026-10-13，10月共14笔。', [data])).toBe(true);
});

test('fallback retains published net and an incomplete-month note without a detail table', () => {
  const result = buildQueryAnswer('净结余7,999.00元。', [monthly()]);
  expect(result).toContain('7620.00');
  expect(result).toContain('2026-10-13');
  expect(result).not.toContain('|');
});

test('cutoff dates are not proven by an unrelated query or an unscoped dataset', () => {
  const data = monthly(); delete data.queryMeta;
  expect(buildQueryAnswer('10月截至13日花了300.00元。', [data])).not.toContain('截至13日');
});

test('monthly totals cannot become a particular large income in a conversational suggestion', () => {
  const summary = '整体还有结余，净收支7,620.00元。';
  const unsupported = '如果想了解8月那笔较大收入的来源，可以具体查。';
  expect(buildQueryAnswer(summary + unsupported, [monthly()])).toBe(summary);
  expect(buildQueryAnswer(summary + '可以看看8月的收入构成。', [monthly()]))
    .toBe(summary + '可以看看8月的收入构成。');
});

test('a proven sole income and an explanation of the evidence limit remain valid', () => {
  const data = monthly(); data.summary.incomeCount = 1;
  expect(validMonthlyTransactionClaims('那笔收入的金额已包含在汇总中。', [data])).toBe(true);
  expect(validMonthlyTransactionClaims('月度合计不能证明某一笔收入的来源。', [monthly()])).toBe(true);
  expect(validMonthlyTransactionClaims('那笔大额收入的来源。', [{ datasetId: 'finance-transactions' }])).toBe(true);
});
