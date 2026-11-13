jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const { createBusinessReadRepository, validateScope } = require('../../src/modules/ai/service/businessRead');
const { normalizeTotals } = require('../../src/modules/ai/service/largeDatasetSql');
const { decimalString } = require('../../src/modules/ai/service/businessRead');

const fixedNow = () => new Date('2026-11-12T04:00:00Z');
const range = { startDate: '2023-11-12', endDate: '2026-11-12' };
const queryId = 'q_' + 'a'.repeat(24);
beforeAll(() => { process.env.SHARE_TOKEN_SECRET = 'large-business-read-fixture-secret-32-characters'; });
function fixture(handler) {
  const executor = { query: jest.fn().mockResolvedValue(), beginTransaction: jest.fn().mockResolvedValue(), rollback: jest.fn().mockResolvedValue(),
    execute: jest.fn(async ({ sql }, params) => [await handler(sql, params)]) };
  return { executor, repo: createBusinessReadRepository({ executor, now: fixedNow }) };
}
function periodRows(extra = {}) {
  const rows = [];
  for (let index = 0; index < 37; index++) {
    const day = new Date(Date.UTC(2023, 10 + index, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(2023, 11 + index, 0)).toISOString().slice(0, 10);
    rows.push({ date: day.slice(0, 7), firstDate: index ? day : range.startDate, lastDate: index === 36 ? range.endDate : last, ...extra });
  }
  return rows;
}

test('three years remain intact while an invalid over-ten-year scope fails explicitly', () => {
  expect(validateScope({ domains: ['fund'], ...range }, fixedNow())).toEqual({ domains: ['fund'], ...range });
  expect(() => validateScope({ domains: ['fund'], startDate: '2010-01-01', endDate: range.endDate }, fixedNow())).toThrow('最多十年');
});

test('monthly salary has full filtered source totals, independent of displayed groups', async () => {
  const rows = periodRows({ company: '专项单位', type: 'formal', hours: '0.00', daySalary: '1000.00', subsidy: '3.00', deductions: '1.00', income: '1002.00', count: 21 });
  const f = fixture((sql) => {
    if (sql.includes('COUNT(*) AS sourceRecordCount')) return [{ sourceRecordCount: 784, income: '50000.34', hours: '0.00', daySalary: '49999.00', subsidy: '4.00', deductions: '2.66' }];
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: 37 }];
    if (sql.startsWith('SELECT ai_groups.*')) return rows;
    if (sql.startsWith('SELECT COALESCE(SUM(s.income)')) return [{ income: '999999.99', count: 999 }];
    return [];
  });
  const result = await f.repo.query('owner', { domains: ['work'], datasetId: 'work-salary', queryId, ...range, resolution: 'month', filter: '专项' });
  const dataset = result.datasets.find(item => item.datasetId === 'work-salary');
  expect(dataset.rows).toHaveLength(37);
  expect(dataset.summary).toMatchObject({ income: '50000.34', count: 784 });
  expect(dataset.queryMeta).toMatchObject({ effectiveScope: range, requestedScope: range, sourceRecordCount: 784,
    matchedRowCount: 37, rowsComplete: true, summaryComplete: true, resolution: 'month', page: { offset: 0, limit: 50, hasMore: false } });
  const relevant = f.executor.execute.mock.calls.filter(([{ sql }]) => sql.includes('AS ai_source'));
  expect(relevant.every(([, params]) => params.slice(0, 3).join('|') === ['owner', range.startDate, range.endDate].join('|'))).toBe(true);
  expect(relevant.every(([{ sql }]) => !sql.includes("'专项'"))).toBe(true);
  expect(f.executor.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
});

test('auto fund series coarsens once to years when fund-month groups exceed the display cap', async () => {
  const rows = ['2023', '2024', '2025', '2026'].flatMap(year => ['基金甲', '基金乙', '基金丙'].map(name => ({ date: year, name,
    profit: '1.2345', capitalDelta: '0.00', count: 10,
    firstDate: year === '2023' ? range.startDate : year + '-01-01', lastDate: year === '2026' ? range.endDate : year + '-12-31' })));
  const f = fixture(sql => {
    if (sql.includes('COUNT(*) AS sourceRecordCount')) return [{ sourceRecordCount: 3291, profit: '148.1400', capitalDelta: '0.00' }];
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: sql.includes('`date`, 4)') ? 12 : 111 }];
    if (sql.startsWith('SELECT ai_groups.*')) return rows;
    return [];
  });
  const dataset = (await f.repo.query('owner', { domains: ['fund'], datasetId: 'fund-history', queryId, ...range })).datasets.find(d => d.datasetId === 'fund-history');
  expect(dataset.rows).toHaveLength(12);
  expect(dataset.summary).toMatchObject({ profit: '148.1400', capitalDelta: '0.00', count: 3291 });
  expect(dataset.queryMeta).toMatchObject({ resolution: 'year', rowsComplete: true, sourceRecordCount: 3291 });
  expect(dataset.columns[0].label).toBe('年份');
});

test('fund detail cursors resume the same query and preserve the all-record summary', async () => {
  const f = fixture((sql, params) => {
    if (sql.includes('COUNT(*) AS sourceRecordCount')) return [{ sourceRecordCount: 100, profit: '123.4567', capitalDelta: '12.34' }];
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: 100 }];
    if (sql.startsWith('SELECT ai_source.*') && sql.includes('LIMIT ? OFFSET ?')) {
      const offset = params.at(-1);
      return Array.from({ length: 3 }, (_, index) => ({ id: 'row-' + (offset + index), fundId: 'f', name: '基金甲', date: '2026-11-01', profit: '1.0000', capitalDelta: '0.00' }));
    }
    return [];
  });
  const args = { domains: ['fund'], datasetId: 'fund-history', queryId, ...range, resolution: 'detail', limit: 2, filter: '甲' };
  const first = (await f.repo.query('owner', args)).datasets.find(d => d.datasetId === 'fund-history');
  const next = (await f.repo.query('owner', { ...args, cursor: first.queryMeta.page.nextCursor })).datasets.find(d => d.datasetId === 'fund-history');
  expect(first.rows.map(row => row.id)).toEqual(['row-0', 'row-1']);
  expect(next.rows.map(row => row.id)).toEqual(['row-2', 'row-3']);
  expect(next.summary).toEqual(first.summary);
  expect(next.queryMeta).toMatchObject({ rowsComplete: false, summaryComplete: true, page: { offset: 2, limit: 2, hasMore: true } });
  await expect(f.repo.query('another-owner', { ...args, cursor: first.queryMeta.page.nextCursor })).rejects.toMatchObject({ code: 'AI_QUERY_CURSOR_INVALID' });
  await expect(f.repo.query('owner', { ...args, filter: '乙', cursor: first.queryMeta.page.nextCursor })).rejects.toMatchObject({ code: 'AI_QUERY_CURSOR_INVALID' });
});

test('period-end snapshots select last records rather than sum stock values', async () => {
  const rows = periodRows({ totalAsset: '100.00', creditDebt: '10.00', netAsset: '90.00' }).map(row => ({ ...row, id: 'snapshot-' + row.date,
    date: row.lastDate, recordedAt: row.lastDate + ' 23:00:00' }));
  const f = fixture(sql => {
    if (sql.includes('COUNT(*) AS sourceRecordCount')) return [{ sourceRecordCount: 1097 }];
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: 37 }];
    if (sql.startsWith('SELECT ai_groups.*')) return rows;
    return [];
  });
  const dataset = (await f.repo.query('owner', { domains: ['asset'], datasetId: 'asset-snapshots', queryId, ...range, resolution: 'month' })).datasets[0];
  expect(dataset.rows).toHaveLength(37);
  expect(dataset.queryMeta).toMatchObject({ summaryComplete: false, rowsComplete: true, sourceRecordCount: 1097 });
  expect(dataset.summary).toEqual({ currency: 'unverified', count: 1097 });
  const selections = f.executor.execute.mock.calls.filter(([{ sql }]) => sql.startsWith('SELECT ai_groups.*'));
  expect(selections[0][0].sql).toContain('NOT EXISTS');
  expect(selections[0][0].sql).toContain('COALESCE(ai_newer.`recordedAt`, \'\')');
  expect(selections[0][0].sql).not.toMatch(/SUM\([^)]*(totalAsset|netAsset)/);
  expect(selections[0][1].slice(0, 6)).toEqual(['owner', range.startDate, range.endDate, 'owner', range.startDate, range.endDate]);
});

test('three-year recurring events include every occurrence year and keep states separate', async () => {
  const f = fixture(sql => {
    if (sql.includes('COUNT(*) AS sourceRecordCount')) return [{ sourceRecordCount: 60 }];
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: 4 }];
    if (sql.startsWith('SELECT ai_groups.*')) return ['2023', '2024', '2025', '2026'].map(year => ({ date: year, type: 'schedule', status: '待完成', count: 15,
      firstDate: year === '2023' ? range.startDate : year + '-01-01', lastDate: year === '2026' ? range.endDate : year + '-12-31' }));
    return [];
  });
  const dataset = (await f.repo.query('owner', { domains: ['todo'], datasetId: 'todo-events', queryId, ...range, resolution: 'year' })).datasets[0];
  expect(dataset.summary.count).toBe(60);
  expect(dataset.rows.every(row => row.status === '待完成')).toBe(true);
  const sql = f.executor.execute.mock.calls.find(([{ sql }]) => sql.startsWith('SELECT ai_groups.*'))[0].sql;
  expect(sql).toContain('SELECT 2023 AS occurrenceYear UNION SELECT 2024 AS occurrenceYear UNION SELECT 2025 AS occurrenceYear UNION SELECT 2026 AS occurrenceYear');
  expect(sql).toContain('GROUP BY LEFT(ai_source.`date`, 4), ai_source.`type`, ai_source.`status`');
});

test('card consumption auto chooses complete annual groups and retains full currency-aware totals', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ cardId: 'card-' + index % 3, cardType: 'credit', name: '示例卡' + index % 3,
    month: String(2023 + Math.floor(index / 3)), currency: 'CNY', amountCNY: index === 11 ? '2900.00' : '100.00',
    count: index === 11 ? 337 : 333, unpricedCount: 0, sourceCurrencies: 'CNY', firstDate: range.startDate, lastDate: range.endDate }));
  const f = fixture(sql => {
    if (sql.includes('COUNT(DISTINCT a.card_id')) return [{ expense: '4000.00', count: 4000, unpricedCount: 0,
      matchedRowCount: sql.includes('LEFT(a.trans_date, 4)') ? 12 : 111 }];
    if (sql.includes('GROUP_CONCAT(DISTINCT')) return rows;
    return [];
  });
  const dataset = (await f.repo.query('owner', { domains: ['card'], datasetId: 'card-monthlyConsumption', queryId, ...range, cardTypes: ['credit'] })).datasets.find(d => d.datasetId === 'card-monthlyConsumption');
  expect(dataset.rows).toHaveLength(12);
  expect(dataset.summary).toMatchObject({ expense: '4000.00', count: 4000, currency: 'CNY' });
  expect(dataset.queryMeta).toMatchObject({ resolution: 'year', sourceRecordCount: 4000, rowsComplete: true, summaryComplete: true,
    filters: { direction: 'expense', cardTypes: ['credit'] } });
  expect(dataset.columns[0].label).toBe('消费年份');
});

test('repayment source currency is CNY and corrupt multi-currency summaries cannot add amounts', () => {
  const one = normalizeTotals('card-repayments', { sourceRecordCount: 2, amount: '39.91', currencyCount: 1, currency: 'CNY' }, decimalString);
  expect(one).toMatchObject({ summary: { amount: '39.91', currency: 'CNY' }, summaryComplete: true });
  const many = normalizeTotals('card-repayments', { sourceRecordCount: 2, amount: '500.00', currencyCount: 2, currency: 'CNY' }, decimalString);
  expect(many.summary).not.toHaveProperty('amount');
  expect(many.summaryComplete).toBe(false);
});
