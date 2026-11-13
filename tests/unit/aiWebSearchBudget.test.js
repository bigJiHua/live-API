jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
const { createWebSearchBudget } = require('../../src/modules/ai/service/webSearchBudget');
const { applySearchMigration, COLUMNS } = require('../../tools/ai-search-migrate');

test('without an injected executor search budget fails closed', async () => {
  await expect(createWebSearchBudget().reserve({ day: '2026-11-12', limit: 50 })).rejects.toMatchObject({ code: 'AI_WEB_SEARCH_BUDGET_UNAVAILABLE' });
});
test('concurrent searches consume a single global allowance and a new runner cannot reset it', async () => {
  let used = 0;
  const executor = { execute: jest.fn(async sql => {
    if (sql.startsWith('INSERT IGNORE')) return [{ affectedRows: 0 }];
    return [{ affectedRows: used < 2 ? (++used, 1) : 0 }];
  }) };
  const first = createWebSearchBudget({ executor });
  const second = createWebSearchBudget({ executor });
  const outcomes = await Promise.all([first, second, first].map(store => store.reserve({ day: '2026-11-12', limit: 2 })));
  expect(outcomes.filter(Boolean)).toHaveLength(2);
  expect(await createWebSearchBudget({ executor }).reserve({ day: '2026-11-12', limit: 2 })).toBe(false);
  expect(executor.execute.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))[0]).toContain('COALESCE(search_daily_calls,?)');
});
test('SQL failure never returns an allowance or leaks SQL error text', async () => {
  const executor = { execute: jest.fn(async () => { throw new Error('password=private SQL'); }) };
  await expect(createWebSearchBudget({ executor }).reserve({ day: '2026-11-12', limit: 2 }))
    .rejects.toMatchObject({ code: 'AI_WEB_SEARCH_BUDGET_UNAVAILABLE', message: '搜索预算暂不可用，未调用搜索源' });
});
test('migration is idempotent, AI-config only, and importing it does not connect', async () => {
  const executor = { execute: jest.fn(async sql => {
    if (sql.startsWith('ALTER TABLE')) throw Object.assign(new Error('exists'), { code: 'ER_DUP_FIELDNAME' });
    return [COLUMNS.map(([COLUMN_NAME]) => ({ COLUMN_NAME }))];
  }) };
  expect(await applySearchMigration(executor)).toMatchObject({ idempotent: true, businessWrites: 0 });
  expect(executor.execute.mock.calls.filter(([sql]) => sql.startsWith('ALTER')).every(([sql]) => sql.startsWith('ALTER TABLE ai_config ADD COLUMN'))).toBe(true);
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
});
