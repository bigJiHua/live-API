jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const { createBusinessReadRepository } = require('../../src/modules/ai/service/businessRead');
const { prepareFinanceDatasetQuery } = require('../../src/modules/ai/service/financeDatasetRead');

const now = () => new Date('2026-11-08T04:00:00Z');
const scope = { domains: ['finance'], startDate: '2026-06-01', endDate: '2026-06-30' };
const queryId = 'q_0123456789abcdef01234567';
const totals = (overrides = {}) => ({ income: '3911.2400', expense: '5784.6100', count: '268',
  incomeCount: '100', expenseCount: '168', unpricedCount: '0', ...overrides });
const transaction = (date, amountCNY, overrides = {}) => ({ id: `flow-${date}`, cardId: 'card-a', categoryId: 'food',
  date, direction: 0, amount: amountCNY, currency: 'CNY', amountCNY, category: '餐饮', remark: '', ...overrides });
let conn, repo;

function respond({ total = totals(), rows = [], groups } = {}) {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('AS matchedRowCount')) return [[{ matchedRowCount: groups }]];
    if (sql.includes('AS incomeCount')) return [[total]];
    return [rows];
  });
}

beforeEach(() => {
  conn = { query: jest.fn().mockResolvedValue(), beginTransaction: jest.fn().mockResolvedValue(),
    execute: jest.fn().mockResolvedValue([[]]), rollback: jest.fn().mockResolvedValue(), release: jest.fn() };
  repo = createBusinessReadRepository({ executor: conn, now });
});

test('268 matching source records and 50 returned transactions remain separate and read one consistent snapshot', async () => {
  respond({ rows: Array.from({ length: 51 }, (_, index) => transaction('2026-06-30', String(100 - index))) });
  const { datasets: [dataset] } = await repo.queryDataset('owner-synthetic', { datasetId: 'finance-transactions', scope, queryId, limit: 50 });
  expect(dataset.rows).toHaveLength(50);
  expect(dataset.summary).toMatchObject({ count: 268, incomeCount: 100, expenseCount: 168, expense: '5784.61' });
  expect(dataset.queryMeta).toEqual({ version: 1, queryId, datasetId: 'finance-transactions',
    requestedScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, filters: { direction: 'both', text: '' },
    sort: 'dateDesc', matchedRowCount: 268, returnedRowCount: 50, sourceRecordCount: 268,
    rowsComplete: false, summaryComplete: true, rankingComplete: false,
    returnedDateRange: { startDate: '2026-06-30', endDate: '2026-06-30' }, asOf: '2026-11-08T04:00:00.000Z',
    resolution: 'detail', page: { offset: 0, limit: 50, hasMore: true, nextCursor: expect.any(String) } });
  expect(dataset.policy).toContain('边界日期可能仍有未返回记录');
  expect(dataset.truncated).toBe(true);
  expect(conn.query.mock.calls).toEqual([['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'], ['SET TRANSACTION READ ONLY']]);
  expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.release).toHaveBeenCalledTimes(1);
  for (const [{ sql, timeout }, params] of conn.execute.mock.calls) {
    expect(sql.trim()).toMatch(/^SELECT\b/);
    expect(sql).toContain('a.user_id = ?');
    expect(sql).toContain("a.pay_type <> '转账'");
    expect(sql).toContain("a.category_id <> 'CATEGORY_REPAY'");
    expect(sql).toContain('a.reversed_id IS NULL');
    expect(sql).not.toContain('owner-synthetic');
    expect(sql).not.toMatch(/SELECT\s+\*|\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(params.slice(0, 3)).toEqual(['owner-synthetic', '2026-06-01', '2026-06-30']);
    expect(timeout).toBe(5000);
  }
  expect(conn.execute.mock.calls[1][1].at(-1)).toBe(51);
});

test('month-start purchase exchanges are filtered before truncation and totals use the same literal predicate', async () => {
  const literal = "购汇%' OR 1=1 --";
  respond({ total: totals({ income: '0', expense: '3000', count: 2, incomeCount: 0, expenseCount: 2 }),
    rows: [transaction('2026-06-02', '2000', { category: literal }), transaction('2026-06-01', '1000', { category: literal })] });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-transactions', scope,
    direction: 'expense', filter: literal, limit: 50, queryId });
  expect(dataset.queryMeta).toMatchObject({ matchedRowCount: 2, returnedRowCount: 2, rowsComplete: true,
    filters: { direction: 'expense', text: literal }, returnedDateRange: { startDate: '2026-06-01', endDate: '2026-06-02' } });
  expect(dataset.summary.expense).toBe('3000.00');
  expect(dataset.truncated).toBe(false);
  for (const [{ sql }, params] of conn.execute.mock.calls) {
    expect(sql).toContain('AND a.direction = ?');
    expect(sql).toContain('INSTR(LOWER(');
    expect(sql).not.toContain(literal);
    expect(sql).not.toContain('LIKE');
    expect(params.slice(0, 4)).toEqual(['owner', '2026-06-01', '2026-06-30', 0]);
    expect(params.slice(4, 7)).toEqual([literal, literal, literal]);
  }
});

test('largest single expense is ordered by frozen CNY value across the full range before limit', async () => {
  respond({ total: totals({ income: '0', incomeCount: 0, expenseCount: 268 }),
    rows: [transaction('2026-06-01', '4000.1250', { currency: 'USD', amount: '550.1234' }), transaction('2026-06-30', '200.01')] });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-transactions', scope,
    direction: 'expense', sort: 'amountDesc', limit: 1, queryId });
  expect(dataset.rows[0]).toMatchObject({ date: '2026-06-01', amountCNY: '4000.13', amount: '550.1234' });
  expect(dataset.queryMeta).toMatchObject({ sort: 'amountDesc', rankingComplete: true, rowsComplete: false, returnedRowCount: 1 });
  const sql = conn.execute.mock.calls.at(-1)[0].sql;
  expect(sql).toMatch(/ORDER BY amountCNY IS NULL, amountCNY DESC, a\.trans_date DESC, a\.id DESC LIMIT \?/);
  expect(sql).toContain('a.amount * a.exchange_rate / 100');
  expect(sql).toContain('ROUND(a.amount, 2)');
  expect(sql).toContain('ELSE NULL END');
});

test('daily ranking uses full daily expense aggregates while source and day counts stay distinct', async () => {
  respond({ groups: 30, rows: [
    { date: '2026-06-03', income: '0', expense: '2300.0000', count: '10', unpricedCount: '0' },
    { date: '2026-06-30', income: '0', expense: '200', count: '9', unpricedCount: '0' },
  ] });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-daily', scope,
    sort: 'expenseDesc', limit: 1, queryId });
  expect(dataset.rows).toEqual([{ date: '2026-06-03', income: '0.00', expense: '2300.00', count: 10, unpricedCount: 0 }]);
  expect(dataset.queryMeta).toMatchObject({ matchedRowCount: 30, returnedRowCount: 1, sourceRecordCount: 268,
    sort: 'expenseDesc', rankingComplete: true, rowsComplete: false });
  expect(conn.execute.mock.calls.at(-1)[0].sql).toMatch(/GROUP BY LEFT\(a\.trans_date, 10\) ORDER BY expense DESC, date DESC LIMIT \?/);
  expect(conn.execute.mock.calls.at(-1)[1].at(-1)).toBe(2);
  expect(dataset.columns.map(column => column.key)).toEqual(['date', 'income', 'expense', 'count', 'unpricedCount']);
});

test('largest income day has a distinct full-range income ordering before limit', async () => {
  respond({ total: totals({ income: '9020', expense: '0', count: 115, incomeCount: 115, expenseCount: 0 }), groups: 30,
    rows: [{ date: '2026-06-03', income: '9000', expense: '0', count: 4, unpricedCount: 0 },
      { date: '2026-06-30', income: '20', expense: '0', count: 1, unpricedCount: 0 }] });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-daily', scope,
    direction: 'income', sort: 'incomeDesc', limit: 1, queryId });
  expect(dataset.rows[0]).toMatchObject({ date: '2026-06-03', income: '9000.00', expense: '0.00' });
  expect(dataset.queryMeta).toMatchObject({ sort: 'incomeDesc', rankingComplete: true, rowsComplete: false,
    matchedRowCount: 30, returnedRowCount: 1, sourceRecordCount: 115, filters: { direction: 'income' } });
  expect(conn.execute.mock.calls.at(-1)[0].sql).toMatch(/ORDER BY income DESC, date DESC LIMIT \?/);
  expect(conn.execute.mock.calls.at(-1)[1]).toEqual(['owner', '2026-06-01', '2026-06-30', 1, 2]);
});

test('finance query IDs use the same exact 24-hex contract as preview metadata', async () => {
  const invalidIds = [23, 25, 32, 64].map(length => `q_${'a'.repeat(length)}`);
  for (const invalidId of invalidIds) {
    await expect(repo.queryDataset('owner', { datasetId: 'finance-daily', scope, queryId: invalidId }))
      .rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
  }
  expect(conn.query).not.toHaveBeenCalled();
  expect(prepareFinanceDatasetQuery({ datasetId: 'finance-daily', queryId }).queryId).toBe(queryId);
});

test('category rows count groups and expose dates without claiming individual-amount date correspondence', async () => {
  respond({ total: totals({ count: 252, income: '0', incomeCount: 0, expenseCount: 252 }), groups: 23,
    rows: Array.from({ length: 21 }, (_, index) => ({ categoryId: `fx-${index}`, direction: 0, category: `购汇${index}`,
      amountCNY: String(3000 - index), count: 2, unpricedCount: 0, firstDate: '2026-06-01', lastDate: '2026-06-02' })) });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-categories', scope,
    filter: '购汇', direction: 'expense', queryId });
  expect(dataset.queryMeta).toMatchObject({ matchedRowCount: 23, sourceRecordCount: 252,
    returnedRowCount: 20, sort: 'categoryAmountDesc', returnedDateRange: null });
  expect(dataset.rows[0]).toMatchObject({ firstDate: '2026-06-01', lastDate: '2026-06-02', amountCNY: '3000.00' });
  expect(conn.execute.mock.calls).toHaveLength(3);
  expect(conn.execute.mock.calls.at(-1)[0].sql).toMatch(/ORDER BY amountCNY DESC, a\.direction, a\.category_id LIMIT \?/);
  for (const [{ sql }, params] of conn.execute.mock.calls) {
    expect(sql).toContain('INSTR(LOWER(COALESCE(c.name, \'未分类\')), LOWER(?)) > 0');
    expect(params.slice(0, 5)).toEqual(['owner', '2026-06-01', '2026-06-30', 0, '购汇']);
  }
});

test('daily purchase-exchange ranking filters the category before every aggregate and returns the largest day', async () => {
  respond({ total: totals({ count: 2, income: '0', expense: '3000', incomeCount: 0, expenseCount: 2 }), groups: 2,
    rows: [{ date: '2026-06-01', income: '0', expense: '2000', count: 1, unpricedCount: 0 },
      { date: '2026-06-02', income: '0', expense: '1000', count: 1, unpricedCount: 0 }] });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-daily', scope,
    direction: 'expense', filter: '购汇', sort: 'expenseDesc', limit: 1, queryId });
  expect(dataset.rows[0]).toMatchObject({ date: '2026-06-01', expense: '2000.00' });
  expect(dataset.queryMeta).toMatchObject({ filters: { direction: 'expense', text: '购汇' }, matchedRowCount: 2,
    sourceRecordCount: 2, returnedRowCount: 1, rowsComplete: false, rankingComplete: true });
  for (const [{ sql }, params] of conn.execute.mock.calls) {
    expect(sql).toContain('AND a.direction = ?');
    expect(sql).toContain('INSTR(LOWER(COALESCE(c.name, \'未分类\')), LOWER(?)) > 0');
    expect(params.slice(0, 5)).toEqual(['owner', '2026-06-01', '2026-06-30', 0, '购汇']);
  }
});

test('monthly metadata describes its actual ascending month order and keeps the user requested range separate', async () => {
  respond({ groups: 2, rows: [
    { month: '2026-05', income: '0', expense: '10', count: 1, unpricedCount: 0 },
    { month: '2026-06', income: '20', expense: '0', count: 1, unpricedCount: 0 },
  ], total: totals({ income: '20', expense: '10', count: 2, incomeCount: 1, expenseCount: 1 }) });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-monthly',
    scope: { ...scope, startDate: '2026-05-01' }, requestedScope: { startDate: '2026-05-01', endDate: '2026-12-31' }, queryId });
  expect(dataset.queryMeta).toMatchObject({ sort: 'monthAsc', matchedRowCount: 2, returnedRowCount: 2, rowsComplete: true,
    requestedScope: { startDate: '2026-05-01', endDate: '2026-12-31' }, effectiveScope: { startDate: '2026-05-01', endDate: '2026-06-30' } });
  expect(conn.execute.mock.calls.at(-1)[0].sql).toContain('ORDER BY month ASC LIMIT ?');
});

test('unpriced amounts remain null and invalidate whole-range monetary ranking even when every row is returned', async () => {
  respond({ total: totals({ income: '0', expense: null, count: 1, incomeCount: 0, expenseCount: 1, unpricedCount: 1 }),
    rows: [transaction('2026-06-01', null, { amount: '123.4567', currency: null })] });
  const { datasets: [dataset] } = await repo.queryDataset('owner', { datasetId: 'finance-transactions', scope,
    direction: 'expense', sort: 'amountDesc', queryId });
  expect(dataset.summary.expense).toBeNull();
  expect(dataset.rows[0]).toMatchObject({ amountCNY: null, amount: '123.4567', currency: null });
  expect(dataset.queryMeta).toMatchObject({ rowsComplete: true, summaryComplete: true, rankingComplete: false });
  expect(dataset.policy).toContain('不能确认完整范围的最大值');
});

test('a verified empty set reports zero, while missing counts remain unknown and cannot imply full coverage', async () => {
  respond({ total: totals({ income: '0', expense: '0', count: 0, incomeCount: 0, expenseCount: 0 }) });
  const empty = (await repo.queryDataset('owner', { datasetId: 'finance-transactions', scope, queryId })).datasets[0];
  expect(empty.queryMeta).toMatchObject({ matchedRowCount: 0, returnedRowCount: 0, sourceRecordCount: 0, rowsComplete: true,
    summaryComplete: true, returnedDateRange: null });
  respond({ total: totals({ count: null, incomeCount: null, expenseCount: null }) });
  const unknown = (await repo.queryDataset('owner', { datasetId: 'finance-transactions', scope, queryId })).datasets[0];
  expect(unknown.queryMeta).toMatchObject({ matchedRowCount: null, sourceRecordCount: null, returnedRowCount: 0,
    rowsComplete: false, summaryComplete: false, rankingComplete: false });
});

test.each([
  { datasetId: 'account-balances' },
  { datasetId: 'finance-monthly', filter: '购汇' },
  { datasetId: 'finance-transactions', sort: 'expenseDesc' },
  { datasetId: 'finance-transactions', sort: 'monthAsc' },
  { datasetId: 'finance-transactions', direction: '0' },
  { datasetId: 'finance-transactions', limit: 51 },
  { datasetId: 'finance-transactions', queryId: 'flow-real-id' },
])('invalid finance query is rejected before opening a connection: %j', async options => {
  await expect(repo.queryDataset('owner', { scope, ...options })).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
  expect(conn.query).not.toHaveBeenCalled();
});

test('read errors and inconsistent count evidence rollback and release the readonly connection', async () => {
  respond({ total: totals({ count: 1 }), rows: [transaction('2026-06-02', '20'), transaction('2026-06-01', '10')] });
  await expect(repo.queryDataset('owner', { datasetId: 'finance-transactions', scope, limit: 1, queryId }))
    .rejects.toMatchObject({ code: 'AI_READ_INVALID_RESULT' });
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(prepareFinanceDatasetQuery({ datasetId: 'finance-transactions' }).queryId).toMatch(/^q_[a-f0-9]{24}$/);
});
