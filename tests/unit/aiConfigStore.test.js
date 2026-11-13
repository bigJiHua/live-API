const { createAiConfigStore } = require('../../src/modules/ai/service/aiConfigStore');
const { getConfig } = require('../../src/modules/ai/service/config');
const { AiError } = require('../../src/modules/ai/service/errors');

const flush = () => new Promise(resolve => setImmediate(resolve));
const row = values => [{ id: 1, daily_provider_calls: null, max_usage_tokens: null, max_output_tokens: null,
  provider_timeout_ms: null, turn_timeout_ms: null, updated_at: 0, ...values }];

test('无行时 get() 为空对象——与现状逐字节一致', async () => {
  const executor = { execute: jest.fn(async () => [[]]) };
  const store = createAiConfigStore({ executor });
  await store.warmup();
  expect(store.get()).toEqual({});
  expect(store.isReady()).toBe(true);
});

test('NULL 列不下发槽位，非 NULL 列映射为 env 字符串槽位', async () => {
  const executor = { execute: jest.fn(async () => [row({ max_usage_tokens: 45000, daily_provider_calls: 150 })]) };
  const store = createAiConfigStore({ executor });
  await store.warmup();
  expect(store.get()).toEqual({ AI_V3_MAX_USAGE_TOKENS: '45000', AI_V3_DAILY_PROVIDER_CALLS: '150' });
});

test('六列全覆盖', async () => {
  const executor = { execute: jest.fn(async () => [row({ daily_provider_calls: 1, max_usage_tokens: 2,
    max_output_tokens: 3, provider_timeout_ms: 4, turn_timeout_ms: 5, history_tokens: 6 })]) };
  const store = createAiConfigStore({ executor });
  await store.warmup();
  expect(store.get()).toEqual({ AI_V3_DAILY_PROVIDER_CALLS: '1', AI_V3_MAX_USAGE_TOKENS: '2',
    AI_V3_MAX_OUTPUT_TOKENS: '3', AI_PROVIDER_TIMEOUT_MS: '4', AI_V3_TURN_TIMEOUT_MS: '5',
    AI_CONTEXT_HISTORY_TOKENS: '6' });
});

test('表未建时降级纯 env 模式，不阻断启动', async () => {
  const executor = { execute: jest.fn(async () => { throw Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE' }); }) };
  const store = createAiConfigStore({ executor });
  await expect(store.warmup()).resolves.toBeUndefined();
  expect(store.get()).toEqual({});
  expect(store.isReady()).toBe(true);
});

test('搜索列待迁移时原六项覆盖继续生效', async () => {
  const executor = { execute: jest.fn(async sql => {
    if (sql.includes('search_daily_calls')) throw Object.assign(new Error('missing new column'), { code: 'ER_BAD_FIELD_ERROR' });
    return [row({ daily_provider_calls: 30 })];
  }) };
  const store = createAiConfigStore({ executor });
  await store.warmup();
  expect(store.get()).toEqual({ AI_V3_DAILY_PROVIDER_CALLS: '30' });
});

test('搜索预算通过 ai_config 下发站点槽位', async () => {
  const store = createAiConfigStore({ executor: { execute: jest.fn(async () => [row({ search_daily_calls: 9 })]) } });
  await store.warmup();
  expect(store.get()).toEqual({ AI_WEB_SEARCH_DAILY_CALLS: '9' });
});

test('SWR：过了 refreshMs 后 get() 触发后台刷新，本次仍旧值、下次新值', async () => {
  let data = row({ max_usage_tokens: 45000 });
  const executor = { execute: jest.fn(async () => [data]) };
  const store = createAiConfigStore({ executor, refreshMs: 0 });
  await store.warmup();
  data = row({ max_usage_tokens: 99000 });
  expect(store.get().AI_V3_MAX_USAGE_TOKENS).toBe('45000');
  await flush();
  expect(store.get().AI_V3_MAX_USAGE_TOKENS).toBe('99000');
  expect(executor.execute.mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('覆盖值经 getConfig 生效，越界值与 env 非法同路径拒绝', () => {
  const base = { AI_MODE: 'deepseek', AI_BASE_URL: 'https://api.example.com', AI_API_KEY: 'k',
    AI_DB_HOST: '127.0.0.1', AI_DB_PORT: '3306', AI_DB_NAME: 'db', AI_DB_USER: 'ai_readonly',
    AI_DB_PASSWORD: 'p', NODE_ENV: 'test' };
  expect(getConfig({ ...base, AI_V3_DAILY_PROVIDER_CALLS: '250' }).dailyProviderLimit).toBe(250);
  expect(getConfig({ ...base, AI_V3_MAX_USAGE_TOKENS: '50000' }).maxUsageTokens).toBe(50000);
  expect(getConfig({ ...base, AI_V3_DAILY_PROVIDER_CALLS: '100000' }).dailyProviderLimit).toBe(100000);
  expect(() => getConfig({ ...base, AI_V3_DAILY_PROVIDER_CALLS: '100001' })).toThrow(AiError);
  expect(() => getConfig({ ...base, AI_V3_MAX_USAGE_TOKENS: '999' })).toThrow(AiError);
});
