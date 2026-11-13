// Manual zero-provider-cost verification. Rebuilds ONLY live_ai_test, never the source business DB.
const assert = require('assert/strict');
const mysql = require('mysql2/promise');
const { TEST_DB, TEST_USER, rebuildDatabase, seedFixtures } = require('../real/harness');
const { seedLiveDomains } = require('./liveFixtures');
const { createBusinessReadRepository } = require('../../src/modules/ai/service/businessRead');

async function verify() {
  if (process.env.AI_EVAL_SEED_VERIFY !== '1' || TEST_DB !== 'live_ai_test')
    throw new Error('需显式 AI_EVAL_SEED_VERIFY=1；仅重建 live_ai_test');
  const admin = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  let pool;
  try {
    pool = await rebuildDatabase(admin);
    const fixture = await seedFixtures(pool, 'fixture.example.invalid', 'https://fixture.example.invalid');
    const dates = await seedLiveDomains(pool, fixture);
    const reader = createBusinessReadRepository({ executor: pool });
    const query = async (domain, id, endDate = dates.today) => {
      const snapshot = await reader.query(TEST_USER, { domains: [domain], datasetId: id, startDate: dates.olderMonth, endDate });
      const dataset = snapshot.datasets.find(entry => entry.datasetId === id);
      assert.ok(dataset?.rows?.length, `${id} must return seeded rows`);
      return dataset;
    };
    const budget = await query('budget', 'budget-plans');
    assert.equal(budget.rows[0].planned, '2000.00'); assert.equal(budget.rows[0].registeredUsed, '1450.00');
    const todo = await query('todo', 'todo-events', [dates.soon, dates.nextMonth].sort().at(-1));
    assert.deepEqual(new Set(todo.rows.map(row => row.content)), new Set(['缴房租', '信用卡还款']));
    const salary = await query('work', 'work-salary');
    assert.deepEqual(new Set(salary.rows.map(row => row.income)), new Set(['8500.00', '8800.00']));
    const rules = await query('work', 'work-rules'); assert.equal(rules.rows[0].hourlyWage, '50.00');
    const funds = await query('fund', 'fund-holdings');
    assert.deepEqual(new Set(funds.rows.map(row => row.marketValue)), new Set(['12850.00', '5200.00']));
    assert.deepEqual(new Set(funds.rows.map(row => row.principal)), new Set(['12000.00', '5400.00']));
    const installment = await query('installment', 'installment-plans');
    assert.equal(installment.rows[0].amount, '416.67'); assert.equal(installment.rows[0].periods, 6); assert.equal(installment.rows[0].pending, 1);
    const assets = await query('asset', 'asset-composition');
    assert.equal(assets.rows.find(row => row.type === 'debit').positiveAssets, '52000.00');
    assert.equal(assets.rows.find(row => row.type === 'credit').creditDebt, '8500.00');
    assert.equal(assets.rows.find(row => row.type === 'virtual_wechat').positiveAssets, '320.00');
    const { createWebSearchBudget } = require('../../src/modules/ai/service/webSearchBudget');
    const secondPool = mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: TEST_DB, connectionLimit: 6 });
    try {
      await pool.execute('INSERT INTO ai_config (id,search_daily_calls,updated_at) VALUES (1,2,?)', [Date.now()]);
      const stores = [createWebSearchBudget({ executor: pool }), createWebSearchBudget({ executor: secondPool })];
      const batch = day => Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % 2].reserve({ day, limit: 1000 })));
      assert.equal((await batch('2026-11-12')).filter(Boolean).length, 2, 'two executors share the configured daily limit');
      assert.equal(await createWebSearchBudget({ executor: secondPool }).reserve({ day: '2026-11-12', limit: 1000 }), false, 'new store does not reset usage');
      assert.equal((await batch('2026-11-13')).filter(Boolean).length, 2, 'next day resets exactly once');
      assert.equal(await stores[0].reserve({ day: '2026-11-12', limit: 1000 }), false, 'delayed old day cannot reset usage');
      const [usage] = await pool.execute('SELECT search_usage_day,search_calls_used FROM ai_config WHERE id=1');
      assert.equal(usage[0].search_usage_day, '2026-11-13'); assert.equal(usage[0].search_calls_used, 2);
    } finally { await pool.execute('DELETE FROM ai_config WHERE id=1'); await secondPool.end(); }
    console.log(JSON.stringify({ database: TEST_DB, today: dates.today, verified: ['budget', 'todo', 'work-salary', 'work-rules', 'fund', 'installment', 'asset', 'search-budget-concurrency-and-rollover'], providerCalls: 0 }));
  } finally { await pool?.end(); await admin.end(); }
}
if (require.main === module) verify().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify };
