jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));

const { prepareFinanceDatasetQuery, readFinanceDataset } = require('../../src/modules/ai/service/financeDatasetRead');
const { decimalString } = require('../../src/modules/ai/service/businessRead');

const asOf = '2026-11-12T04:00:00.000Z';
const scope = { domains: ['finance'], startDate: '2023-11-12', endDate: '2026-11-12' };
const queryId = 'q_1234567890abcdef12345678';
const financeValid = "a.user_id = ? AND a.is_deleted = 0 AND a.reversed_id IS NULL AND a.pay_type <> '转账' AND a.category_id <> 'CATEGORY_REPAY' AND a.trans_date >= ? AND a.trans_date <= ?";
const totals = { income: '400000.37', expense: '180000.93', count: '4975', incomeCount: '44', expenseCount: '4931', unpricedCount: '0' };

function periodRows(start, end, year = false) {
  const dates = [];
  for (let date = new Date(start + 'T00:00:00Z'); date.toISOString().slice(0, 10) <= end;) {
    const month = date.toISOString().slice(0, year ? 4 : 7);
    if (!dates.includes(month)) dates.push(month);
    date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  return dates.map(month => ({ month, income: '10000.0100', expense: '4800.2500', count: '100', unpricedCount: '0' }));
}

function execution({ months = periodRows(scope.startDate, scope.endDate), years = periodRows(scope.startDate, scope.endDate, true), details = [], total = totals } = {}) {
  const select = jest.fn(async (sql, params) => {
    if (sql.includes(' AS incomeCount')) return [total];
    const grouped = sql.includes('GROUP BY LEFT(a.trans_date,');
    const data = grouped ? sql.includes('LEFT(a.trans_date, 4)') ? years : months : details;
    if (sql.includes(' AS matchedRowCount')) return [{ matchedRowCount: String(data.length) }];
    const offset = sql.includes(' OFFSET ?') ? params.at(-1) : 0;
    const count = sql.includes(' OFFSET ?') ? params.at(-2) : params.at(-1);
    return data.slice(offset, offset + count);
  });
  return select;
}

async function read(options, select, queryScope = scope) {
  const spec = prepareFinanceDatasetQuery({ queryId, ...options });
  return (await readFinanceDataset({ select, userId: 'mock-owner', scope: queryScope, spec, asOf, financeValid, decimalString })).datasets[0];
}

test('three-year monthly trend retains all 37 periods and full-range server totals', async () => {
  const select = execution();
  const dataset = await read({ datasetId: 'finance-monthly' }, select);
  expect(dataset.rows).toHaveLength(37);
  expect(dataset.rows[0].month).toBe('2023-11');
  expect(dataset.rows.at(-1).month).toBe('2026-11');
  expect(dataset.queryMeta).toMatchObject({ resolution: 'month', requestedScope: { startDate: scope.startDate, endDate: scope.endDate },
    effectiveScope: { startDate: scope.startDate, endDate: scope.endDate }, matchedRowCount: 37, sourceRecordCount: 4975,
    rowsComplete: true, summaryComplete: true, page: { offset: 0, hasMore: false, nextCursor: null } });
  expect(dataset.summary).toMatchObject({ income: '400000.37', expense: '180000.93', count: 4975 });
  for (const [sql, params] of select.mock.calls) {
    expect(params.slice(0, 3)).toEqual(['mock-owner', '2023-11-12', '2026-11-12']);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  }
  expect(select.mock.calls[0][0]).not.toContain('LIMIT');
});

test('ten-year automatic trend uses annual groups without losing the requested dates', async () => {
  const queryScope = { ...scope, startDate: '2017-01-01' };
  const select = execution({ months: periodRows(queryScope.startDate, queryScope.endDate), years: periodRows(queryScope.startDate, queryScope.endDate, true) });
  const dataset = await read({ datasetId: 'finance-monthly' }, select, queryScope);
  expect(dataset.queryMeta).toMatchObject({ resolution: 'year', rowsComplete: true, matchedRowCount: 10,
    effectiveScope: { startDate: '2017-01-01', endDate: '2026-11-12' } });
  expect(dataset.columns[0]).toMatchObject({ key: 'month', label: '年份' });
  expect(dataset.rows.map(row => row.month)).toEqual(Array.from({ length: 10 }, (_, i) => String(2017 + i)));
  expect(select.mock.calls.at(-1)[0]).toContain('GROUP BY LEFT(a.trans_date, 4)');
});

test('explicit month resolution keeps its grain and provides a signed next page', async () => {
  const select = execution();
  const first = await read({ datasetId: 'finance-monthly', resolution: 'month', limit: 20 }, select);
  expect(first.rows).toHaveLength(20);
  expect(first.queryMeta).toMatchObject({ resolution: 'month', rowsComplete: false, summaryComplete: true,
    page: { offset: 0, limit: 20, hasMore: true } });
  expect(typeof first.queryMeta.page.nextCursor).toBe('string');
  const second = await read({ datasetId: 'finance-monthly', resolution: 'month', limit: 20, cursor: first.queryMeta.page.nextCursor }, select);
  expect(second.rows).toHaveLength(17);
  expect(second.rows[0].month).toBe('2025-07');
  expect(second.queryMeta).toMatchObject({ resolution: 'month', rowsComplete: false, rankingComplete: false,
    page: { offset: 20, hasMore: false, nextCursor: null } });
  expect(second.summary).toEqual(first.summary);
  expect(select.mock.calls.at(-1)[0]).toContain('LIMIT ? OFFSET ?');
  expect(select.mock.calls.at(-1)[1].slice(-2)).toEqual([21, 20]);
});

test('detail pagination does not recalculate whole-range amounts from its returned page', async () => {
  const details = Array.from({ length: 41 }, (_, index) => ({ id: 'r' + index, date: '2026-11-12', direction: 0,
    amount: '0.0100', currency: 'CNY', amountCNY: '0.01', category: '餐饮', remark: String(index) }));
  const total = { ...totals, count: '41', incomeCount: '0', expenseCount: '41', income: '0', expense: '9020.39' };
  const select = execution({ details, total });
  const first = await read({ datasetId: 'finance-transactions', limit: 20, resolution: 'detail' }, select);
  const second = await read({ datasetId: 'finance-transactions', limit: 20, resolution: 'detail', cursor: first.queryMeta.page.nextCursor }, select);
  expect(second.rows.map(row => row.remark)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 20)));
  expect(second.summary.expense).toBe('9020.39');
  expect(second.queryMeta).toMatchObject({ sourceRecordCount: 41, matchedRowCount: 41, rowsComplete: false,
    summaryComplete: true, page: { offset: 20, hasMore: true } });
});

test('largest expense day remains daily when an automatic query uses expenseDesc', async () => {
  const days = [{ date: '2023-11-12', income: '0', expense: '9000.0100', count: '30', unpricedCount: '0' },
    { date: '2026-11-12', income: '0', expense: '0.39', count: '1', unpricedCount: '0' }];
  const select = jest.fn(async sql => sql.includes(' AS incomeCount') ? [totals]
    : sql.includes(' AS matchedRowCount') ? [{ matchedRowCount: '1097' }] : days);
  const dataset = await read({ datasetId: 'finance-daily', sort: 'expenseDesc', direction: 'expense', limit: 1 }, select);
  expect(dataset.queryMeta).toMatchObject({ resolution: 'detail', matchedRowCount: 1097, rankingComplete: true });
  expect(dataset.rows[0]).toMatchObject({ date: '2023-11-12', expense: '9000.01' });
  expect(select.mock.calls.at(-1)[0]).toContain('GROUP BY LEFT(a.trans_date, 10) ORDER BY expense DESC, date DESC');
});

test('unknown currency never establishes complete monetary ranking across a large scope', async () => {
  const total = { ...totals, count: '1', incomeCount: '0', expenseCount: '1', expense: null, unpricedCount: '1' };
  const details = [{ id: 'unknown', date: '2023-11-12', direction: 0, amount: '1.2345', currency: null,
    amountCNY: null, category: '其他', remark: '' }];
  const dataset = await read({ datasetId: 'finance-transactions', direction: 'expense', sort: 'amountDesc' }, execution({ total, details }));
  expect(dataset.queryMeta).toMatchObject({ rowsComplete: true, rankingComplete: false, summaryComplete: true });
  expect(dataset.summary).toMatchObject({ expense: null, incomplete: true });
});

test('record datasets reject period grouping before attempting SQL', () => {
  expect(() => prepareFinanceDatasetQuery({ datasetId: 'finance-transactions', resolution: 'month' }))
    .toThrow('查询筛选或排序参数无效');
});
