jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live DB forbidden'); }), getConnection: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw Error('Live SQL pool forbidden'); }) }));
const crypto = require('node:crypto');
const { createTestService, createMemoryRequestGuard } = require('../helpers/aiFixture');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createUserBudgetStore, BUDGET_FIELDS } = require('../../src/modules/ai/service/userBudgetSettings');
const { createAiConfigStore } = require('../../src/modules/ai/service/aiConfigStore');
const { adaptChatRequest } = require('../../src/modules/ai/service/providerCapabilities');

const defaults = { dailyProviderCalls: 100, maxUsageTokens: 1000, maxOutputTokens: 128, providerTimeoutMs: 1000, turnTimeoutMs: 30000 };
const reset = Object.fromEntries(Object.keys(defaults).map(key => [key, null]));
const plain = () => ({ message: { role: 'assistant', content: '你好，可以继续交流。' }, usage: { total_tokens: 100 } });

async function setup(provider = jest.fn(async () => plain())) {
  const rows = new Map();
  const executor = { execute: jest.fn(async (sql, params) => {
    if (sql.includes('FROM ai_config')) return [[Object.fromEntries(BUDGET_FIELDS.map(field => [field.column, defaults[field.key]]))]];
    if (sql.startsWith('SELECT user_id,')) return [[...rows.values()].map(row => ({ ...row }))];
    if (sql.startsWith('INSERT INTO ai_user_preference')) {
      rows.set(params[0], { user_id: params[0], ...Object.fromEntries(BUDGET_FIELDS.map((field, i) => [field.column, params[i + 1]])) });
      return [{ affectedRows: 1 }];
    }
    throw Error('Unexpected budget fixture SQL');
  }) };
  const guard = createMemoryRequestGuard();
  const legacy = createTestService({ aiConfigStore: createAiConfigStore({ executor }), userBudgetStore: createUserBudgetStore({ executor }), requestGuard: guard });
  await legacy.warmupSettings();
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor: guard.fixtureExecutor, provider,
    callLog: { record() {} }, memoryStore: { list: async () => ({ files: [], warnings: [] }) },
    historyReader: { loadSummary: async () => null, search: async () => [] }, grants: { requireCoverage: async () => {} } });
  const conversation = await legacy.getRuntime('budget-runtime-owner').conversationStore.open('budget-runtime-owner');
  const send = (message = '你好') => service.chat('budget-runtime-owner', { requestId: crypto.randomUUID(), conversationId: conversation.id, message, mode: 'chat', consent: true });
  const save = overrides => legacy.setBudgetSettings('budget-runtime-owner', { ...defaults, ...overrides });
  return { legacy, service, guard, provider, send, save };
}

test('saved daily quota blocks real V3 provider admission, and raising it admits the next call without rebuilding services', async () => {
  const f = await setup();
  await f.save({ dailyProviderCalls: 1 });
  await f.send();
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_DAILY_CALL_LIMIT', providerCalls: 0 });
  expect(f.provider).toHaveBeenCalledTimes(1);
  await f.save({ dailyProviderCalls: 2 });
  await f.send();
  expect(f.provider).toHaveBeenCalledTimes(2);
});

test('saved cumulative token quota stops the next V3 call; raising it permits calculation and final response', async () => {
  const provider = jest.fn(async (_, messages) => messages.some(message => message.role === 'tool') ? plain() : {
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'calculate-fixture', type: 'function',
      function: { name: 'calculate', arguments: JSON.stringify({ expression: '2+3' }) } }] }, usage: { total_tokens: 1500 } });
  const f = await setup(provider);
  await expect(f.send('帮我计算2加3')).rejects.toMatchObject({ code: 'AI_TOKEN_BUDGET_EXCEEDED', providerCalls: 1 });
  expect(provider).toHaveBeenCalledTimes(1);
  await f.save({ maxUsageTokens: 2000 });
  await f.send('帮我计算2加3');
  expect(provider).toHaveBeenCalledTimes(3);
});

test('saved output and provider timeout reach every V3 provider call and serialized max_tokens; reset restores site defaults', async () => {
  const f = await setup();
  await f.save({ maxOutputTokens: 8192, providerTimeoutMs: 2300 });
  await f.send();
  const [config, messages, tools, control] = f.provider.mock.calls[0];
  expect(config.providerTimeoutMs).toBe(2300);
  expect(adaptChatRequest(config, messages, tools, control, true).max_tokens).toBe(8192);
  await f.legacy.setBudgetSettings('budget-runtime-owner', reset);
  await f.send();
  const [restored, restoredMessages, restoredTools, restoredControl] = f.provider.mock.calls[1];
  expect(restored.providerTimeoutMs).toBe(1000);
  expect(adaptChatRequest(restored, restoredMessages, restoredTools, restoredControl, true).max_tokens).toBe(128);
});

test('saved turn timeout actually aborts a running V3 provider; increasing it allows work beyond the old deadline', async () => {
  jest.useFakeTimers();
  try {
    const provider = jest.fn((_, __, ___, control) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(plain()), 40000);
      control.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('Provider aborted by turn guard')); }, { once: true });
    }));
    const f = await setup(provider);
    const first = f.send().then(result => ({ result }), error => ({ error }));
    await jest.advanceTimersByTimeAsync(30000);
    expect((await first).error).toMatchObject({ code: 'AI_TURN_TIMEOUT', providerCalls: 1 });
    expect(provider.mock.calls[0][3].signal.aborted).toBe(true);
    await f.save({ turnTimeoutMs: 60000 });
    const second = f.send().then(result => ({ result }), error => ({ error }));
    await jest.advanceTimersByTimeAsync(40000);
    expect((await second).result.request.providerCalls).toBe(1);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});
