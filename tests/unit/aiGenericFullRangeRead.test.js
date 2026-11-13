jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const { createBusinessReadRepository } = require('../../src/modules/ai/service/businessRead');
const now = () => new Date('2026-11-09T04:00:00Z');
function executor(handler) {
  return { query: jest.fn().mockResolvedValue(), beginTransaction: jest.fn().mockResolvedValue(),
    execute: jest.fn(async ({ sql }, params) => [await handler(sql, params)]), rollback: jest.fn().mockResolvedValue() };
}
test('fund text matching beyond the original 100-row window is counted and selected before LIMIT', async () => {
  const db = executor((sql, params) => {
    if (sql.includes('FROM fund f LEFT JOIN')) return [];
    if (!sql.includes('FROM bus_fund_history')) return [];
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: 1 }];
    if (sql.includes('ai_source') && params.includes('仅旧基金')) return [{ id: 'history-old', fundId: 'fund-old', name: '仅旧基金', date: '2026-01-05', profit: '0.9900', capitalDelta: '0.00' }];
    return Array.from({ length: 101 }, (_, i) => ({ id: `recent-${i}`, fundId: 'fund-new', name: '近期基金', date: '2026-11-04', profit: '1.0000', capitalDelta: '0.00' }));
  });
  const repo = createBusinessReadRepository({ executor: db, now });
  const value = await repo.query('owner', { domains: ['fund'], datasetId: 'fund-history', filter: '仅旧基金', startDate: '2026-01-01', endDate: '2026-11-09' });
  const dataset = value.datasets.find(d => d.datasetId === 'fund-history');
  expect(dataset.rows).toEqual([expect.objectContaining({ name: '仅旧基金', date: '2026-01-05' })]);
  expect(dataset.fullRangeQuery).toEqual({ matchedRowCount: 1, filter: '仅旧基金' });
  const calls = db.execute.mock.calls.filter(([{ sql }]) => sql.includes('ai_source'));
  expect(calls).toHaveLength(2);
  for (const [{ sql }, params] of calls) {
    expect(params).toEqual(['owner', '2026-01-01', '2026-11-09', '仅旧基金']);
    expect(sql).toContain('INSTR(LOWER(CAST(ai_source.`name` AS CHAR)), LOWER(?)) > 0');
    expect(sql).not.toContain('仅旧基金');
  }
  expect(calls.find(([{ sql }]) => !sql.includes('COUNT(*)'))[0].sql).toMatch(/ORDER BY `date` DESC, `id` ASC LIMIT 101$/);
});
test('generic counts cover 101+ rows, wildcard input is literal, and unrelated dataset stays unfiltered', async () => {
  const db = executor((sql, params) => {
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: 143 }];
    if (sql.includes('FROM budget')) return Array.from({ length: 101 }, (_, i) => ({ id: `b-${i}`, title: `预算%_${i}`, date: '2026-11-08', planned: '10.00', registeredUsed: '0.00', remaining: '10.00' }));
    return [];
  });
  const dataset = (await createBusinessReadRepository({ executor: db, now }).query('owner', { domains: ['budget'], datasetId: 'budget-plans', filter: '%_', startDate: '2026-11-01', endDate: '2026-11-09' })).datasets[0];
  expect(dataset.fullRangeQuery).toEqual({ matchedRowCount: 143, filter: '%_' });
  expect(dataset.rows).toHaveLength(100); expect(dataset.truncated).toBe(true);
  expect(db.execute.mock.calls.find(([{ sql }]) => sql.includes('COUNT(*) AS matchedRowCount'))[1]).toEqual(['owner', '2026-11-01', '2026-11-09', '%_', '%_', '%_']);
});
test('yearly event query projects occurrence date in requested year and retains original date', async () => {
  const db = executor(sql => {
    if (!sql.includes('FROM todo')) return [];
    if (sql.includes('occurrenceYear')) return [{ id: 'annual', content: '生日', type: 'birthday', date: '2026-11-09', originalDate: '2010-11-09', status: '待办', priority: 1, isRecurring: 1, remark: '' }];
    return [{ id: 'annual', content: '生日', type: 'birthday', date: '2010-11-09', status: '待办', priority: 1, isRecurring: 1, remark: '' }];
  });
  const d = (await createBusinessReadRepository({ executor: db, now }).query('owner', { domains: ['todo'], startDate: '2026-11-09', endDate: '2026-11-09' })).datasets[0];
  expect(d.rows[0]).toMatchObject({ date: '2026-11-09', originalDate: '2010-11-09' });
  expect(d.columns).toContainEqual({ key: 'originalDate', label: '原登记日期', type: 'date' });
  const sql = db.execute.mock.calls.find(([{ sql }]) => sql.includes('FROM todo'))[0].sql;
  expect(sql).toContain('DAY(LAST_DAY('); // Feb 29 is skipped in a non-leap occurrence year.
  expect(sql).toContain('ai_todo.date >= ? AND ai_todo.date <= ?');
});
test('cross-year recurring events use two distinct occurrence years without duplicating saved one-off events', async () => {
  const db = executor(() => []);
  await createBusinessReadRepository({ executor: db, now }).query('owner', { domains: ['todo'], startDate: '2026-12-20', endDate: '2027-01-15' });
  const [{ sql }, params] = db.execute.mock.calls.find(([{ sql }]) => sql.includes('FROM todo'));
  expect(sql).toContain('SELECT 2026 AS occurrenceYear UNION SELECT 2027');
  expect(sql).toContain('is_recurring = 1 OR years.occurrenceYear = YEAR(happen_date)');
  expect(params).toEqual(['owner', '2026-12-20', '2027-01-15']);
});
test('query-only card counts and balances are not blocked by more than 100 unrelated card candidates', async () => {
  const db = executor(sql => {
    if (sql.includes("status = '正常'")) return Array.from({ length: 101 }, (_, i) => ({ id: `card-${i}`, name: `卡${i}` }));
    if (sql.includes('COUNT(*) AS matchedRowCount')) return [{ matchedRowCount: sql.includes('account_balance') ? 150 : 1 }];
    if (sql.includes('FROM card_base WHERE')) return [{ type: 'credit', displayType: '信用卡', count: 150 }];
    if (sql.includes('FROM card_base c LEFT JOIN account_balance')) return Array.from({ length: 101 }, (_, i) => ({ cardId: `card-${i}`, name: `卡${i}`, type: 'credit', balance: null, currency: null, updatedAt: null }));
    return [];
  });
  const repo = createBusinessReadRepository({ executor: db, now });
  const cardCounts = await repo.query('owner', { domains: ['card'], datasetId: 'card-counts', filter: '信用卡' });
  expect(cardCounts.datasets.find(d => d.datasetId === 'card-counts')).toMatchObject({ rows: [{ type: 'credit', displayType: '信用卡', count: 150 }], fullRangeQuery: { matchedRowCount: 1, filter: '信用卡' } });
  const balances = await repo.query('owner', { domains: ['account'], datasetId: 'account-balances' });
  expect(balances.datasets[0].rows).toHaveLength(100);
  expect(balances.datasets[0].fullRangeQuery.matchedRowCount).toBe(150);
  expect(balances.choices.cards).toEqual([]);
  expect(db.execute.mock.calls.some(([{ sql }]) => sql.includes("status = '正常'"))).toBe(false);
  // A candidate selection still retains its explicit safety limit.
  await expect(repo.query('owner', { domains: ['card'] })).rejects.toMatchObject({ code: 'AI_SCOPE_TOO_LARGE' });
});
test('SQL filtering of saved times uses normalized UTC text and never untrusted expressions', async () => {
  const db = executor(sql => sql.includes('COUNT(*) AS matchedRowCount') ? [{ matchedRowCount: 0 }] : []);
  await createBusinessReadRepository({ executor: db, now }).query('owner', { domains: ['asset'], datasetId: 'asset-snapshots', filter: '2026-11-05' });
  const [{ sql }, params] = db.execute.mock.calls.find(([{ sql }]) => sql.includes('COUNT(*) AS matchedRowCount'));
  expect(sql).toContain("DATE_ADD('1970-01-01 00:00:00'");
  expect(sql).toContain('ELSE 480 END');
  expect(sql).toContain('%Y-%m-%dT%H:%i:%s');
  expect(params.at(-1)).toBe('2026-11-05');
  expect(sql).not.toContain('2026-11-05');
});
