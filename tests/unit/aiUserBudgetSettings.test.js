jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public database forbidden'); }), getConnection: jest.fn() }));
const { createUserBudgetStore, validateBudgetSettings, BUDGET_FIELDS } = require('../../src/modules/ai/service/userBudgetSettings');
const { createTestService } = require('../helpers/aiFixture');
const { createPreferenceStore } = require('../../src/modules/ai/service/preferences');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const values = { dailyProviderCalls: 10000, maxUsageTokens: 1000000, maxOutputTokens: 'max', providerTimeoutMs: 105000, turnTimeoutMs: 300000 };
const reset = Object.fromEntries(Object.keys(values).map(key => [key, null]));
function database() {
  const rows = new Map([['owner', { user_id: 'owner', thinking_enabled: 1, web_search_enabled: 1 }]]);
  const executor = { execute: jest.fn(async (sql, args) => {
    if (sql.startsWith('SELECT')) return [[...rows.values()].map(row => ({ ...row }))];
    const [userId, ...fields] = args;
    const row = rows.get(userId) || { user_id: userId };
    BUDGET_FIELDS.forEach((field, index) => { row[field.column] = fields[index]; });
    rows.set(userId, row); return [{ affectedRows: 1 }];
  }) };
  return { executor, rows };
}
test('本人额度可高于站点默认，运行配置、额度守卫和前端超时保持一致，恢复默认仅影响本人', async () => {
  const preferences = createPreferenceStore(); await preferences.set('owner', true, true);
  const guard = createMemoryRequestGuard();
  const service = createTestService({ preferenceStore: preferences, requestGuard: guard,
    aiConfigStore: { get: () => ({ AI_V3_DAILY_PROVIDER_CALLS: '1', AI_V3_MAX_USAGE_TOKENS: '30000', AI_PROVIDER_TIMEOUT_MS: '60000', AI_V3_TURN_TIMEOUT_MS: '120000' }) } });
  await service.warmupSettings();
  await service.setBudgetSettings('owner', { ...values, dailyProviderCalls: 100000, maxUsageTokens: 10000000 });
  expect(service.getRuntime('owner')).toMatchObject({ turnTimeoutMs: 300000,
    config: { dailyProviderLimit: 100000, maxUsageTokens: 10000000, providerTimeoutMs: 105000 } });
  expect(service.getCapabilities('owner').requestPolicy).toMatchObject({ dailyProviderCalls: 100000, turnTimeoutMs: 300000 });
  expect(service.getBudgetSettings('other').values.dailyProviderCalls).toBe(1);
  await guard.run('owner', { lane: 'v3-chat', requestId: 'first-budget', maxProviderCalls: 5, dailyProviderLimit: 1, input: {} }, async budget => { await budget.invoke(async () => null); return {}; });
  await expect(guard.run('owner', { lane: 'v3-chat', requestId: 'raised-budget', maxProviderCalls: 5,
    dailyProviderLimit: service.getRuntime('owner').config.dailyProviderLimit, input: {} }, async budget => { await budget.invoke(async () => null); return {}; })).resolves.toMatchObject({ request: { providerCalls: 1 } });
  await service.setBudgetSettings('owner', reset);
  expect(service.getRuntime('owner')).toMatchObject({ turnTimeoutMs: 120000, config: { dailyProviderLimit: 1 } });
  expect(preferences.getFlags('owner')).toEqual({ thinking: true, webSearch: true });
});
test('max、数字和恢复默认持久化，重建 store 可恢复，偏好旗标不被覆盖', async () => {
  const { executor, rows } = database(); const store = createUserBudgetStore({ executor });
  await store.set('owner', values);
  expect(rows.get('owner')).toMatchObject({ thinking_enabled: 1, web_search_enabled: 1, max_output_tokens: 'max' });
  const restarted = createUserBudgetStore({ executor }); await restarted.warmup();
  expect(restarted.get('owner')).toEqual(values); expect(restarted.get('other')).toEqual(reset);
  await restarted.set('owner', { ...values, maxOutputTokens: 8192 });
  expect(restarted.get('owner').maxOutputTokens).toBe(8192);
  await restarted.set('owner', reset); expect(rows.get('owner').max_output_tokens).toBeNull();
  expect(rows.get('owner').thinking_enabled).toBe(1);
});
test('保存失败不更新缓存，未迁移时明确失败且暖机可重试', async () => {
  const { executor } = database(); const store = createUserBudgetStore({ executor });
  executor.execute.mockRejectedValueOnce(new Error('missing columns'));
  await expect(store.warmup()).rejects.toMatchObject({ code: 'AI_BUDGET_SETTINGS_UNAVAILABLE' });
  await store.warmup(); await store.set('owner', values);
  executor.execute.mockRejectedValueOnce(new Error('write failed'));
  await expect(store.set('owner', reset)).rejects.toMatchObject({ code: 'AI_BUDGET_SETTINGS_UNAVAILABLE' });
  expect(store.get('owner')).toEqual(values);
});
test.each([{ ...values, userId: 'other' }, { ...values, maxOutputTokens: 'MAX' }, { ...values, dailyProviderCalls: 100001 },
  { ...values, maxUsageTokens: 10000001 },
  { ...values, maxUsageTokens: 999 }, { ...values, providerTimeoutMs: 105001 }, { ...values, turnTimeoutMs: 300001 },
  { ...values, dailyProviderCalls: '10000' }])('拒绝额外身份字段、越界及错误格式：%j', input => {
  expect(() => validateBudgetSettings(input)).toThrow(expect.objectContaining({ code: 'AI_REQUEST_INVALID' }));
});
test('后台旧查询不能覆盖刚保存的值', async () => {
  const { executor } = database(); let stamp = 0;
  const store = createUserBudgetStore({ executor, clock: () => stamp, refreshMs: 100 });
  await store.set('owner', values);
  let complete;
  executor.execute.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  stamp = 101; store.get('owner');
  await store.set('owner', { ...values, dailyProviderCalls: 500 });
  complete([[{ user_id: 'owner', daily_provider_calls: 10000 }]]);
  await new Promise(resolve => setImmediate(resolve));
  expect(store.get('owner').dailyProviderCalls).toBe(500);
});
