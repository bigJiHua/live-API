jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('query projection regressions must not access the public database'); }),
  getConnection: jest.fn(() => { throw new Error('query projection regressions must not obtain a connection'); }),
}));

const { selectSnapshot } = require('../../src/modules/ai/service/v3Tools');
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const db = require('../../src/common/config/db');

afterEach(() => {
  expect(db.execute).not.toHaveBeenCalled();
  expect(db.getConnection).not.toHaveBeenCalled();
});

const scope = { domains: ['finance'], startDate: '2026-06-01', endDate: '2026-06-30' };
const columns = [
  { key: 'date', label: '日期', type: 'date' },
  { key: 'direction', label: '收支方向', type: 'number' },
  { key: 'amount', label: '原币金额', type: 'decimal' },
  { key: 'currency', label: '币种', type: 'text' },
  { key: 'amountCNY', label: '金额（人民币）', type: 'money' },
  { key: 'category', label: '分类', type: 'text' },
  { key: 'remark', label: '备注', type: 'text' },
];
const uuid = (prefix, index) => `${prefix}0000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

test('fifty finance details retain their true coverage while three unused internal identities stay out of the bounded payload', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: uuid('1', index), cardId: uuid('2', index), categoryId: uuid('3', index),
    date: `2026-06-${String(index % 30 + 1).padStart(2, '0')}`, direction: 0,
    amount: (index + 1).toFixed(2), currency: 'CNY', amountCNY: (index + 1).toFixed(2),
    category: '餐饮', remark: '支付宝餐饮及日常消费；按原始账单备注保留用于核对。',
  }));
  const queryMeta = { version: 1, queryId: 'q_0123456789abcdef01234567', datasetId: 'finance-transactions',
    requestedScope: { startDate: scope.startDate, endDate: scope.endDate },
    effectiveScope: { startDate: scope.startDate, endDate: scope.endDate },
    filters: { direction: 'both', text: '' }, sort: 'dateDesc', matchedRowCount: 268, returnedRowCount: 50,
    sourceRecordCount: 268, rowsComplete: false, summaryComplete: true, rankingComplete: false,
    returnedDateRange: { startDate: '2026-06-01', endDate: '2026-06-30' }, asOf: '2026-11-08T04:00:00.000Z' };
  const original = { datasetId: 'finance-transactions', domain: 'finance', title: '收支明细', columns, rows,
    summary: { income: '3911.24', expense: '5784.61', count: 268, incomeCount: 68, expenseCount: 200,
      unpricedCount: 0, currency: 'CNY' }, queryMeta, totalCount: 268,
    policy: '明细按日期倒序返回前五十条，合计覆盖全部匹配记录。', truncated: true, asOf: queryMeta.asOf };
  const raw = { scope, datasets: [original], choices: {}, asOf: queryMeta.asOf };

  // This is the real failure size: normal detail text plus three otherwise
  // unused owner-bound identities exceed the transport budget.
  expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(16 * 1024);
  const selected = selectSnapshot('query_data', { datasetId: 'finance-transactions', domain: 'finance',
    scope, filter: '', limit: 50 }, raw);
  const dataset = selected.datasets[0];
  expect(dataset.rows).toHaveLength(50);
  expect(dataset.queryMeta).toEqual(queryMeta);
  expect(dataset.totalCount).toBe(268);
  expect(dataset.summary).toMatchObject({ count: 268, incomeCount: 68, expenseCount: 200 });
  for (let index = 0; index < dataset.rows.length; index++) {
    expect(Object.keys(dataset.rows[index])).toEqual(columns.map(column => column.key));
    expect(dataset.rows[index].remark).toBe(rows[index].remark);
    expect(dataset.rows[index].amountCNY).toBe(rows[index].amountCNY);
  }
  const payload = JSON.stringify(selected);
  expect(payload).not.toMatch(/"(?:id|cardId|categoryId|ref|cardRef|categoryRef)"/);
  expect(payload).not.toContain(rows[0].id);
  expect(Buffer.byteLength(payload)).toBeLessThan(16 * 1024);
  expect(raw.datasets[0].rows[0]).toHaveProperty('id', rows[0].id);
});

test('a detail total never treats the direction code as a count and a declared count column still totals correctly', () => {
  const dataset = { datasetId: 'finance-transactions', domain: 'finance', title: '收支明细', truncated: false,
    columns: [
      { key: 'category', label: '分类', type: 'text' },
      { key: 'amountCNY', label: '金额（人民币）', type: 'money' },
      { key: 'direction', label: '收支方向', type: 'number' },
    ], rows: [{ category: '餐饮', amountCNY: '12.50', direction: 0 }, { category: '交通', amountCNY: '7.50', direction: 0 }],
    summary: { expense: '20.00', count: 2, expenseCount: 2, incomeCount: 0, currency: 'CNY' } };
  const detailAnswer = buildQueryAnswer('', [dataset]);
  const detailTable = detailAnswer.slice(detailAnswer.indexOf('| 分类'));
  expect(detailTable).toContain('| 总计 | CNY 20.00 |');
  expect(detailTable).not.toContain('收支方向');
  expect(detailTable).not.toContain('| 总计 | CNY 20.00 | 2 |');

  const counted = { ...dataset, datasetId: 'finance-categories', title: '分类收支',
    columns: [...dataset.columns, { key: 'count', label: '笔数', type: 'number' }],
    rows: [{ category: '餐饮', amountCNY: '12.50', direction: 0, count: 1 },
      { category: '交通', amountCNY: '7.50', direction: 0, count: 1 }] };
  const countedAnswer = buildQueryAnswer('', [counted]);
  const countedTable = countedAnswer.slice(countedAnswer.indexOf('| 分类'));
  expect(countedTable).toContain('| 分类 | 金额（人民币） | 笔数 |');
  expect(countedTable).toContain('| 总计 | CNY 20.00 | 2 |');
  expect(countedTable).not.toContain('收支方向');
});

test('limited finance results guide the user to a supported date range instead of an unavailable next page', () => {
  const dataset = { datasetId: 'finance-transactions', domain: 'finance', columns, rows: [], truncated: true,
    summary: { count: 268, expenseCount: 168, incomeCount: 100 } };
  const answer = buildQueryAnswer('本次未返回全部记录，如需查看其余日期的明细可继续翻页。', [dataset]);
  expect(answer).not.toContain('翻页');
  expect(answer).toContain('缩小日期范围后继续查看');
  expect(answer).not.toContain('共 268');
  expect(dataset.summary).toMatchObject({ count: 268, expenseCount: 168, incomeCount: 100 });
});

test.each(['本次未返回全部记录。', '当前没有展示所有明细。', '本轮未读取全部数据。', '未显示所有记录。'])(
  'limited finance coverage disclaimers remain readable: %s', claim => {
    const dataset = { datasetId: 'finance-transactions', domain: 'finance', columns, rows: [], truncated: true,
      summary: { count: 268, expenseCount: 168, incomeCount: 100 } };
    expect(buildQueryAnswer(claim, [dataset])).toContain(claim);
  });

test.each(['所有记录支出均为0元。', '未返回全部记录但所有记录支出均为0元。', '未返回所有记录所以支出最高是0元。',
  '本次未返回全部记录，所有记录支出均为0元。', '本次未返回全部记录，支出发生时间最早。'])(
  'limited finance disclaimers cannot authorize global properties or extremes: %s', claim => {
    const dataset = { datasetId: 'finance-transactions', domain: 'finance', columns, rows: [], truncated: true,
      summary: { count: 268, expenseCount: 168, incomeCount: 100 } };
    expect(buildQueryAnswer(claim, [dataset])).not.toContain(claim);
  });
