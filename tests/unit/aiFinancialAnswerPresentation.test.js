jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const scope = { startDate: '2026-06-01', endDate: '2026-06-30' };
function dataset(datasetId) {
  const monthly = datasetId === 'finance-monthly';
  const categories = datasetId === 'finance-categories';
  const transactions = datasetId === 'finance-transactions';
  return { datasetId, domain: 'finance', title: '匿名收支', truncated: false,
    columns: categories ? [{ key: 'category', type: 'text' }, { key: 'amountCNY', type: 'money' }]
      : transactions ? [{ key: 'date', type: 'date' }, { key: 'amountCNY', type: 'money' }]
        : [{ key: monthly ? 'month' : 'date', type: 'date' }, { key: 'income', type: 'money' }, { key: 'expense', type: 'money' }],
    rows: categories ? [{ category: '出行', amountCNY: '150.00' }]
      : transactions ? [{ date: '2026-06-05', amountCNY: '150.00' }]
        : [{ [monthly ? 'month' : 'date']: monthly ? '2026-06' : '2026-06-05', income: '100.00', expense: '150.00' }],
    summary: { income: '320.00', expense: '440.00', net: '-120.00', count: 8, expenseCount: 6, incomeCount: 2, currency: 'CNY', unpricedCount: 0 },
    queryMeta: { version: 1, queryId: 'q_aaaaaaaaaaaaaaaaaaaaaaaa', datasetId,
      requestedScope: scope, effectiveScope: scope, filters: { direction: 'both', text: '' },
      sort: monthly ? 'monthAsc' : 'dateDesc', matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 8,
      rowsComplete: true, summaryComplete: true, rankingComplete: true } };
}

test.each(['finance-monthly', 'finance-categories', 'finance-transactions', 'finance-daily'])
  ('%s starts with verified model prose, without adding the full financial summary', datasetId => {
    const text = datasetId === 'finance-categories' ? '出行支出150.00元，是比较集中的一部分。'
      : '这段记录里，收入320.00元、支出440.00元，净收支是-120.00元。';
    expect(buildQueryAnswer(text, [dataset(datasetId)])).toBe(text);
  });

test('a valid monthly judgment does not need to recite aggregate amounts', () => {
  const text = '各个月的收支节奏还需要结合收入构成来看。';
  expect(buildQueryAnswer(text, [dataset('finance-monthly')])).toBe(text);
});

test('mixed financial query evidence does not force the first dataset totals into the answer', () => {
  const text = '收入320.00元、支出440.00元，净收支-120.00元；可以再看看出行这部分的支出。';
  expect(buildQueryAnswer(text, [dataset('finance-monthly'), dataset('finance-categories')])).toBe(text);
});

test('ranking keeps its proven answer without adding unrelated whole-range amounts or counts', () => {
  const data = dataset('finance-daily');
  data.queryMeta.filters.direction = 'expense'; data.queryMeta.sort = 'expenseDesc';
  const answer = buildQueryAnswer('', [data], { activeQuery: { metric: 'daily-max' } });
  expect(answer).toContain('支出最多的一天是 2026-06-05');
  expect(answer).toContain('150.00');
  expect(answer).not.toMatch(/320\.00|440\.00|共 8 笔|已计入/);
});

test.each(['card', 'cardMonth'])('card %s facts do not receive an unrelated aggregate paragraph', groupBy => {
  const data = { datasetId: 'card-monthlyConsumption', domain: 'card', title: '匿名卡消费',
    columns: [{ key: 'name', type: 'text' }, { key: 'month', type: 'date' }, { key: 'amountCNY', type: 'money' }, { key: 'count', type: 'number' }],
    rows: [{ name: '出行卡', month: '2026-06', amountCNY: '240.00', count: 6, unpricedCount: 0 }],
    summary: { expense: '240.00', count: 6, currency: 'CNY', unpricedCount: 0 },
    queryMeta: { queryId: 'q_bbbbbbbbbbbbbbbbbbbbbbbb', groupBy, effectiveScope: scope,
      sort: groupBy === 'card' ? 'amountDesc' : 'dateDesc', rowsComplete: true, rankingComplete: true } };
  const answer = buildQueryAnswer('', [data], null, { metric: 'card-consumption', comparisonScopes: [] });
  expect(answer).toContain('出行卡'); expect(answer).toContain('240.00');
  expect(answer).not.toMatch(/已计入|共 6 笔消费/);
});

test('unusable prose still gets a published-facts fallback, while invented amounts stay removed', () => {
  const answer = buildQueryAnswer('收入9999.00元。', [dataset('finance-transactions')]);
  expect(answer).toContain('收入 CNY 320.00'); expect(answer).toContain('支出 CNY 440.00');
  expect(answer).not.toMatch(/9999|已计入/);
});
