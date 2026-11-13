const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProfileGenerationService, blockedBySuppression, PROFILE_SCHEMA, PROFILE_PROMPT, LIMITS } = require('../../src/modules/ai/service/profileGeneration');
const { createPersonalizationStore } = require('../../src/modules/ai/service/personalizationStore');
const { adaptChatRequest } = require('../../src/modules/ai/service/providerCapabilities');
const { estimateTokens } = require('../../src/modules/ai/service/modelContext');

const revision = 'a'.repeat(64), updatedRevision = 'b'.repeat(64);
const now = () => new Date('2026-11-12T07:00:00.000Z');
const user = 'owner-private-id';
const text = '我喜欢用简短的中文回复，先给结论再解释。';
const candidate = (values = {}) => ({ category: 'communication', text: '偏好简短中文回复，先给结论。',
  evidence: [{ sourceIndex: 0, quote: text }], replaceIndex: null, ...values });
const response = items => ({ message: { role: 'assistant', content: JSON.stringify({ items }) } });
function fixture({ rows = [{ id: 9, content: text, created_at: now() }], items = [], suppressedProfile = [],
  settings = {}, cursor = 0, updatedAt = null, result, memories = [], suppressedMemories = [], runtimeConfig = {} } = {}) {
  let state = { revision, contractVersion: 1, settings: { useMemory: true, useProfile: true, autoProfile: true, ...settings },
    profile: { items, updatedAt, historyCursor: cursor }, suppressedProfile, suppressedMemories, disabledMemories: [], deletedMemories: [] };
  const executor = { execute: jest.fn(async (sql, params) => {
    const matched = rows.filter(row => row.id > params[2]).sort((a, b) => /ORDER BY m.id DESC/.test(sql) ? b.id - a.id : a.id - b.id);
    return [[...matched.slice(0, params[3])]];
  }) };
  const provider = jest.fn(async () => result || response([candidate()]));
  const store = { get: jest.fn(async () => structuredClone(state)), update: jest.fn(async (_, input, actor) => {
    if (input.expectedRevision !== state.revision) throw Object.assign(new Error('Conflict'), { status: 409 });
    state = { ...state, profile: input.profile, revision: updatedRevision }; return structuredClone(state);
  }) };
  const memoryStore = { list: jest.fn(async () => ({ files: memories })), read: jest.fn(async (_, args) => memories.find(item => item.path === args.path)) };
  const getRuntime = () => ({ config: { baseUrl: 'https://api.example.com', model: 'fixture-model', apiKey: 'private-api-key-value', ...runtimeConfig } });
  const service = createProfileGenerationService({ executor, provider, getRuntime, personalizationStore: store, memoryStore, now });
  return { service, provider, executor, store, memoryStore, state: () => state, setState: next => { state = next; } };
}

test('generates grounded profile from owner-bound history without exposing credentials or message identifiers', async () => {
  const f = fixture();
  const result = await f.service.generate(user, { expectedRevision: revision });
  expect(result.profile.items[0]).toMatchObject({ category: 'communication', origin: 'ai', confirmed: false,
    evidence: [{ quote: text, sourceLabel: '历史对话中的用户原话', sourceTime: now().toISOString() }] });
  expect(result.profile.historyCursor).toBe(9);
  expect(f.executor.execute.mock.calls[0][0]).toMatch(/c.user_id = m.user_id/);
  expect(f.executor.execute.mock.calls[0][0]).toMatch(/m.role = 'user'/);
  expect(f.executor.execute.mock.calls[0][1]).toEqual([user, user, 0, 80]);
  const [config, messages, tools, control] = f.provider.mock.calls[0];
  expect(config.providerTimeoutMs).toBe(60000);
  expect(tools).toEqual([]);
  expect(control).toMatchObject({ toolChoice: 'none', schemaName: 'user_profile', maxTokens: 4096 });
  expect(JSON.stringify(messages)).not.toMatch(/owner-private-id|private-api-key-value|"id":9/);
  expect(f.store.update).toHaveBeenCalledWith(user, expect.objectContaining({ expectedRevision: revision }), { actor: 'ai' });
});

test('rejects fabricated evidence without persisting an inferred fact', async () => {
  const f = fixture({ result: response([candidate({ evidence: [{ sourceIndex: 0, quote: '我喜欢冗长英文回复' }] })]) });
  await expect(f.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_PROFILE_INVALID' });
  expect(f.store.update).not.toHaveBeenCalled();
});

test('preserves user-confirmed entries on rebuild and rejects replacing one', async () => {
  const confirmed = { id: 'profile_manual', category: 'communication', text: '按我的要求使用中文。', origin: 'user', confirmed: true, evidence: [] };
  const f = fixture({ items: [confirmed] });
  expect((await f.service.generate(user, { expectedRevision: revision, mode: 'rebuild' })).profile.items).toContainEqual(confirmed);
  const conflict = fixture({ items: [confirmed], result: response([candidate({ replaceIndex: 0 })]) });
  await expect(conflict.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_PROFILE_INVALID' });
  expect(conflict.store.update).not.toHaveBeenCalled();
});

test('does not drop manually maintained profile entries beyond the model context window', async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ id: `profile_manual_${index}`, category: 'background',
    text: `用户明确维护的背景第${index + 1}条`, origin: 'user', confirmed: true, evidence: [] }));
  const f = fixture({ items });
  const result = await f.service.generate(user, { expectedRevision: revision, mode: 'rebuild' });
  expect(result.profile.items.filter(item => item.origin === 'user')).toHaveLength(100);
});

test('generation context prioritizes user corrections and replacement indexes resolve through that order', async () => {
  const old = { id: 'profile_old_ai', category: 'communication', text: '偏好英文', origin: 'ai', confirmed: false, evidence: [] };
  const manual = { id: 'profile_user', category: 'goals', text: '用户已确认的长期目标', origin: 'user', confirmed: true, evidence: [] };
  const f = fixture({ items: [old, manual], result: response([candidate({ replaceIndex: 1 })]) });
  const result = await f.service.generate(user, { expectedRevision: revision });
  const input = JSON.parse(f.provider.mock.calls[0][1][1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(input.existingItems[0]).toMatchObject({ origin: 'user', confirmed: true });
  expect(result.profile.items.find(item => item.id === 'profile_user')).toEqual(manual);
  expect(result.profile.items.find(item => item.id === 'profile_old_ai').text).toBe(candidate().text);
});

test('allows explicitly mapped new evidence to replace an unconfirmed AI preference', async () => {
  const old = { id: 'profile_old', category: 'communication', text: '偏好英文回复', origin: 'ai', confirmed: false, evidence: [] };
  const f = fixture({ items: [old], result: response([candidate({ replaceIndex: 0 })]) });
  const state = await f.service.generate(user, { expectedRevision: revision });
  expect(state.profile.items).toHaveLength(1);
  expect(state.profile.items[0]).toMatchObject({ id: 'profile_old', text: candidate().text, confirmed: false });
});

test('does not reintroduce suppressed profile entries or hidden credentials', async () => {
  expect(blockedBySuppression(candidate(), [{ category: 'communication', text: candidate().text }])).toBe(true);
  expect(blockedBySuppression(candidate(), [{ category: 'communication', text: '喜欢开门见山', evidence: [{ quote: text }] }])).toBe(true);
  const f = fixture({ suppressedProfile: [{ category: 'communication', text: candidate().text }] });
  expect((await f.service.generate(user, { expectedRevision: revision })).profile.items).toEqual([]);
  const unsafe = fixture({ result: response([candidate({ text: 'apiKey: private-api-key-value' })]) });
  await expect(unsafe.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_MEMORY_SENSITIVE_DATA' });
  expect(unsafe.store.update).not.toHaveBeenCalled();
});

test('scrubs hidden IDs, full numbers, email and provider keys before sending historical sources', async () => {
  const source = `${text} owner-private-id private-api-key-value 13800138000 someone@example.com`;
  const f = fixture({ rows: [{ id: 10, content: source, created_at: now() }] });
  await f.service.generate(user, { expectedRevision: revision });
  const payload = f.provider.mock.calls[0][1][1].content;
  expect(payload).not.toMatch(/owner-private-id|private-api-key-value|13800138000|someone@example.com/);
  expect(payload).toContain(text);
});

test('no new history and disabled auto profile produce no provider call', async () => {
  const f = fixture({ rows: [], memories: [{ path: 'preference.md', title: '沟通偏好', content: text, updated: now().toISOString() }] });
  expect((await f.service.generate(user, { expectedRevision: revision })).revision).toBe(revision);
  expect(f.provider).not.toHaveBeenCalled();
  const disabled = fixture({ settings: { autoProfile: false } });
  await disabled.service.maybeGenerate(user);
  expect(disabled.executor.execute).not.toHaveBeenCalled();
  expect(disabled.provider).not.toHaveBeenCalled();
});

test('historical user source of a deleted memory cannot regenerate as profile', async () => {
  const f = fixture({ suppressedMemories: [{ path: 'removed.md', content: text, source: text }] });
  await f.service.generate(user, { expectedRevision: revision, mode: 'rebuild' });
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.store.update).not.toHaveBeenCalled();
  const manual = fixture({ suppressedMemories: [{ path: 'removed.md', content: '另一个删除的偏好', source: '用户在记忆管理页填写' }] });
  await manual.service.generate(user, { expectedRevision: revision });
  expect(manual.provider).toHaveBeenCalledTimes(1);
});

test('auto updates require both the message threshold and elapsed interval', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, content: text, created_at: now() }));
  const recent = fixture({ rows, updatedAt: '2026-11-12T06:59:00.000Z' });
  await recent.service.maybeGenerate(user);
  expect(recent.provider).not.toHaveBeenCalled();
  const few = fixture({ rows: rows.slice(0, 7) });
  await few.service.maybeGenerate(user);
  expect(few.provider).not.toHaveBeenCalled();
  const enough = fixture({ rows });
  expect((await enough.service.maybeGenerate(user)).profile.historyCursor).toBe(8);
  expect(enough.provider).toHaveBeenCalledTimes(1);
});

test('never advances the incremental cursor past unprocessed budget overflow', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, content: text + '甲'.repeat(3900), created_at: now() }));
  const f = fixture({ rows, result: response([]) });
  const result = await f.service.generate(user, { expectedRevision: revision });
  expect(result.profile.historyCursor).toBeGreaterThan(0);
  expect(result.profile.historyCursor).toBeLessThan(8);
  const payload = JSON.parse(f.provider.mock.calls[0][1][1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(payload.sources.reduce((length, source) => length + source.text.length, 0)).toBeLessThanOrEqual(24000);
});

test('cancelled and stale generation cannot overwrite newer manual changes', async () => {
  const cancelled = fixture();
  const controller = new AbortController(); controller.abort();
  await expect(cancelled.service.generate(user, { expectedRevision: revision, signal: controller.signal })).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect(cancelled.provider).not.toHaveBeenCalled();
  const stale = fixture();
  stale.provider.mockImplementation(async () => { stale.setState({ ...stale.state(), revision: updatedRevision }); return response([candidate()]); });
  await expect(stale.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ status: 409 });
  expect(stale.state().profile.items).toEqual([]);
});

test('abort during a provider call leaves no late profile write', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release;
  f.provider.mockImplementation(async () => new Promise(resolve => { release = resolve; }));
  const pending = f.service.generate(user, { expectedRevision: revision, signal: controller.signal });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  release(response([candidate()]));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.store.update).not.toHaveBeenCalled();
});

test('profile provider consumes the shared daily budget and stores only audit metadata', async () => {
  const f = fixture();
  const invoke = jest.fn(async work => work());
  const guard = { run: jest.fn(async (_, input, work) => ({ ...await work({ invoke, check() {} }), request: { requestId: input.requestId } })) };
  const callLog = { record: jest.fn() };
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    memoryStore: f.memoryStore, callLog, now, getRuntime: () => ({ requestGuard: guard,
      config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'private-provider-key', dailyProviderLimit: 20 } }) });
  const result = await service.generate(user, { expectedRevision: revision, requestId: 'profile-request' });
  expect(guard.run).toHaveBeenCalledWith(user, expect.objectContaining({ lane: 'v3-chat', maxProviderCalls: 1, dailyProviderLimit: 20 }), expect.any(Function));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(result.request).toBeUndefined();
  const audit = callLog.record.mock.calls[0][0];
  expect(audit).toMatchObject({ lane: 'profile-generation', phase: 'provider', status: 'ok', request: { sourceCount: 1, mode: 'incremental' } });
  expect(JSON.stringify(audit)).not.toContain(text);
  expect(JSON.stringify(audit)).not.toContain('private-provider-key');
});

test('budget denial prevents provider calls and profile writes', async () => {
  const f = fixture();
  const guard = { run: jest.fn(async () => { throw Object.assign(new Error('Daily budget'), { code: 'AI_DAILY_CALL_LIMIT' }); }) };
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    now, getRuntime: () => ({ requestGuard: guard, config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } }) });
  await expect(service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_DAILY_CALL_LIMIT' });
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.store.update).not.toHaveBeenCalled();
});

test('generated profile persists in the shared store and user deletion blocks rephrased regeneration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-profile-generation-'));
  try {
    const store = createPersonalizationStore({ root, now });
    const f = fixture();
    const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: store,
      getRuntime: () => ({ config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } }), now });
    const generated = await service.generate(user, { expectedRevision: (await store.get(user)).revision });
    expect((await store.get(user)).profile.items).toEqual(generated.profile.items);
    const deleted = await store.update(user, { expectedRevision: generated.revision,
      profile: { items: [], updatedAt: generated.profile.updatedAt, historyCursor: generated.profile.historyCursor } });
    f.provider.mockImplementation(async () => response([candidate({ text: '希望中文沟通直入主题，不铺垫。' })]));
    const rebuilt = await service.generate(user, { expectedRevision: deleted.revision, mode: 'rebuild' });
    expect(rebuilt.profile.items).toEqual([]);
    expect(rebuilt.profile.historyCursor).toBe(9);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('changing model connection during generation prevents a stale provider result from being saved', async () => {
  const f = fixture();
  const runtime = { connectionId: 'connection-one', config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } };
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider,
    personalizationStore: f.store, getRuntime: () => runtime, now });
  f.provider.mockImplementation(async () => { runtime.connectionId = 'connection-two'; return response([candidate()]); });
  await expect(service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_CONNECTION_EXPIRED' });
  expect(f.store.update).not.toHaveBeenCalled();
});

test('a configured 45 second provider timeout permits a single response after the previous 30 second cutoff', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    const invoke = jest.fn(async work => work());
    const guard = { run: jest.fn(async (_, input, work) => work({ invoke, check() {} })) };
    const runtime = { config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture', providerTimeoutMs: 45000 }, requestGuard: guard };
    const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
      getRuntime: () => runtime, now });
    f.provider.mockImplementation(async () => new Promise(resolve => setTimeout(() => resolve(response([candidate()])), 35000)));
    const pending = service.generate(user, { expectedRevision: revision });
    await jest.advanceTimersByTimeAsync(0);
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(f.provider.mock.calls[0][0].providerTimeoutMs).toBe(45000);
    expect(guard.run).toHaveBeenCalledWith(user, expect.objectContaining({ timeoutMs: 55000, maxProviderCalls: 1 }), expect.any(Function));
    await jest.advanceTimersByTimeAsync(30001);
    expect(f.store.update).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect((await pending).profile.items).toHaveLength(1);
    expect(f.store.update).toHaveBeenCalledTimes(1);
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test('configured deadline aborts the provider and rejects a late response without retry or profile write', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    const runtime = { config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture', providerTimeoutMs: 45000 } };
    const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
      getRuntime: () => runtime, now });
    let release, providerSignal;
    f.provider.mockImplementation(async (_, __, ___, control) => new Promise(resolve => { release = resolve; providerSignal = control.signal; }));
    const pending = service.generate(user, { expectedRevision: revision });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(44999);
    expect(providerSignal.aborted).toBe(false);
    expect(f.store.update).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect((await outcome).error).toMatchObject({ code: 'AI_PROFILE_TIMEOUT', status: 504 });
    expect(providerSignal.aborted).toBe(true);
    release(response([candidate()]));
    await jest.advanceTimersByTimeAsync(0);
    expect(f.store.update).not.toHaveBeenCalled();
    expect(f.provider).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test.each([1000, 5000, 45000, 105000])('profile and shared guard honor the same administrator timeout: %i ms', async providerTimeoutMs => {
  const f = fixture();
  const invoke = jest.fn(async work => work());
  const guard = { run: jest.fn(async (_, input, work) => work({ invoke, check() {} })) };
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    getRuntime: () => ({ requestGuard: guard, config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture', providerTimeoutMs } }), now });
  await service.generate(user, { expectedRevision: revision });
  expect(f.provider.mock.calls[0][0].providerTimeoutMs).toBe(providerTimeoutMs);
  expect(guard.run.mock.calls[0][1]).toMatchObject({ timeoutMs: providerTimeoutMs + 10000, maxProviderCalls: 1 });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(invoke).toHaveBeenCalledTimes(1);
});

test('missing provider timeout defaults to 60 seconds and the guard reserves 10 seconds for persistence', async () => {
  const f = fixture();
  const guard = { run: jest.fn(async (_, input, work) => work({ invoke: work => work(), check() {} })) };
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    getRuntime: () => ({ requestGuard: guard, config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } }), now });
  await service.generate(user, { expectedRevision: revision });
  expect(f.provider.mock.calls[0][0].providerTimeoutMs).toBe(60000);
  expect(guard.run.mock.calls[0][1].timeoutMs).toBe(70000);
});

test.each([0, 999, 105001, 45000.5, '45000'])('invalid timeout configuration is rejected instead of silently widened: %s', async providerTimeoutMs => {
  const f = fixture();
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    getRuntime: () => ({ config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture', providerTimeoutMs } }), now });
  await expect(service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_CONFIG_REQUIRED' });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.store.update).not.toHaveBeenCalled();
});

test('failed automatic generation cools down paid attempts while explicit generation remains immediate', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, content: text, created_at: now() }));
  const f = fixture({ rows }); let at = now().getTime();
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    getRuntime: () => ({ config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } }), now: () => new Date(at) });
  f.provider.mockImplementation(async () => { throw Object.assign(new Error('Provider failed'), { code: 'AI_PROVIDER_FAILED' }); });
  await expect(service.maybeGenerate(user)).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
  expect(f.provider).toHaveBeenCalledTimes(1);
  const readsAfterFailure = f.executor.execute.mock.calls.length;
  expect(await service.maybeGenerate(user)).toBeNull();
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.executor.execute).toHaveBeenCalledTimes(readsAfterFailure);
  await expect(service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
  expect(f.provider).toHaveBeenCalledTimes(2);
  at += 30 * 60 * 1000;
  await expect(service.maybeGenerate(user)).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.store.update).not.toHaveBeenCalled();
});

test.each([
  [{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }, 8192, 12],
  [{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', maxOutputTokens: 2048 }, 2048, 3],
  [{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', maxOutputTokens: null }, 8192, 12],
  [{ baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', maxOutputTokens: 'max' }, 8192, 12],
  [{ baseUrl: 'https://maas.qianwenaiapi.com', model: 'deepseek-v4-flash-0731' }, 4096, 6],
  [{ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' }, 1024, 1],
])('profile limits follow the real provider adapter output ceiling: %j', async (runtimeConfig, maxTokens, maxItems) => {
  const f = fixture({ runtimeConfig });
  await f.service.generate(user, { expectedRevision: revision });
  const [config, messages, tools, control] = f.provider.mock.calls[0];
  const body = adaptChatRequest(config, messages, tools, control);
  expect(body.max_tokens).toBe(maxTokens);
  expect(control.maxTokens).toBe(maxTokens);
  const input = JSON.parse(messages[1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(input.generationLimits).toEqual({ maxItems, textChars: 120, maxEvidence: 2, quoteChars: 100, maxOutputTokens: maxTokens });
  expect(control.responseSchema.properties.items.maxItems).toBe(maxItems);
  expect(PROFILE_SCHEMA.properties.items.maxItems).toBe(12);
  expect(PROFILE_SCHEMA.properties.items.items.properties.replaceIndex.maximum).toBe(29);
  expect(PROFILE_PROMPT).toMatch(/最多 12 项.*最多 120 字.*最多 2 条.*最多 100 字/);
});

test('long history is clipped to reserve provider output and resumes at the first unprocessed message', async () => {
  const rows = Array.from({ length: 72 }, (_, index) => ({ id: index + 1,
    content: text + '甲'.repeat(328 - text.length), created_at: now() }));
  const f = fixture({ rows, runtimeConfig: { maxUsageTokens: 30000 } });
  const result = await f.service.generate(user, { expectedRevision: revision });
  const [config, messages, tools, control] = f.provider.mock.calls[0];
  const input = JSON.parse(messages[1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(input.sources.length).toBeGreaterThan(50);
  expect(input.sources.length).toBeLessThan(72);
  expect(result.profile.historyCursor).toBe(input.sources.length);
  expect(estimateTokens({ messages, tools, responseSchema: control.responseSchema }) + 64 + control.maxTokens).toBeLessThanOrEqual(30000);
  expect(adaptChatRequest(config, messages, tools, control).max_tokens).toBe(4096);
  expect(f.provider).toHaveBeenCalledTimes(1);
  const next = fixture({ rows, cursor: result.profile.historyCursor, result: response([]) });
  await next.service.generate(user, { expectedRevision: revision });
  const nextInput = JSON.parse(next.provider.mock.calls[0][1][1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(nextInput.sources.length).toBe(72 - input.sources.length);
  expect(next.executor.execute.mock.calls[0][1][2]).toBe(result.profile.historyCursor);
});

test('remaining total budget narrows output and generation count after retaining one usable source', async () => {
  const f = fixture({ runtimeConfig: { maxUsageTokens: 3500 } });
  await f.service.generate(user, { expectedRevision: revision });
  const [config, messages, tools, control] = f.provider.mock.calls[0];
  const input = JSON.parse(messages[1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(control.maxTokens).toBeGreaterThanOrEqual(256);
  expect(control.maxTokens).toBeLessThan(4096);
  expect(input.generationLimits.maxItems).toBeLessThan(6);
  expect(input.generationLimits.maxItems).toBe(control.responseSchema.properties.items.maxItems);
  expect(estimateTokens({ messages, tools, responseSchema: control.responseSchema }) + 64 + control.maxTokens).toBeLessThanOrEqual(3500);
  expect(adaptChatRequest(config, messages, tools, control).max_tokens).toBe(control.maxTokens);
});

test('insufficient total budget refuses the call without moving the cursor or saving', async () => {
  const f = fixture({ runtimeConfig: { maxUsageTokens: 1000 } });
  await expect(f.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_TOKEN_BUDGET_EXCEEDED',
    message: expect.stringContaining('已有画像保留，请稍后重新整理') });
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.store.update).not.toHaveBeenCalled();
  expect(f.state().profile.historyCursor).toBe(0);
});

test('twelve concise new items are allowed by a capable model while the model still sees thirty existing entries', async () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `profile_manual_capacity_${index}`, category: 'background',
    text: `用户维护的背景${index}`, origin: 'user', confirmed: true, evidence: [] }));
  const generated = Array.from({ length: 12 }, (_, index) => candidate({ text: `偏好简短中文回复${index}` }));
  const f = fixture({ items, result: response(generated), runtimeConfig: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' } });
  await f.service.generate(user, { expectedRevision: revision });
  const input = JSON.parse(f.provider.mock.calls[0][1][1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(input.existingItems).toHaveLength(30);
  expect(f.state().profile.items.filter(item => item.origin === 'user')).toEqual(items);
  expect(f.state().profile.items.filter(item => item.origin === 'ai')).toHaveLength(12);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test.each([
  ['dynamic item count', Array.from({ length: 7 }, () => candidate())],
  ['global item count', Array.from({ length: 13 }, () => candidate())],
  ['text length', [candidate({ text: '甲'.repeat(121) })]],
  ['quote length', [candidate({ evidence: [{ sourceIndex: 0, quote: '甲'.repeat(101) }] })]],
  ['evidence count', [candidate({ evidence: Array.from({ length: 3 }, () => ({ sourceIndex: 0, quote: text })) })]],
])('rejects generated %s beyond prompt and schema capacity without a retry or save', async (_, items) => {
  const f = fixture({ result: response(items), rows: [{ id: 9, content: text + '甲'.repeat(101), created_at: now() }] });
  await expect(f.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_PROFILE_INVALID' });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.store.update).not.toHaveBeenCalled();
});

test.each([
  { code: 'AI_PROVIDER_FAILED', diagnostics: { finishReason: 'length' } },
  { code: 'AI_PROVIDER_INCOMPLETE', diagnostics: { finishReason: 'length' } },
  { code: 'AI_PROVIDER_RESPONSE_LIMIT' },
])('provider output limits report an explicit profile error without a retry or save: %j', async failure => {
  const f = fixture();
  f.provider.mockImplementation(async () => { throw Object.assign(new Error('Provider output failed'), failure); });
  await expect(f.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_PROFILE_OUTPUT_LIMIT', status: 502,
    message: expect.stringContaining('已有画像保留，请稍后重新整理') });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.store.update).not.toHaveBeenCalled();
});

test('reported provider usage above the total budget is rejected before profile persistence', async () => {
  const f = fixture({ result: { ...response([candidate()]), usage: { total_tokens: LIMITS.totalTokens + 1 } } });
  await expect(f.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_TOKEN_BUDGET_EXCEEDED' });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.store.update).not.toHaveBeenCalled();
});

test.each([
  { prompt_tokens: 29000, completion_tokens: 2000 },
  { promptTokens: 29000, completionTokens: 2000 },
])('provider usage components above the total budget are rejected when the total is omitted: %j', async usage => {
  const f = fixture({ result: { ...response([candidate()]), usage } });
  await expect(f.service.generate(user, { expectedRevision: revision })).rejects.toMatchObject({ code: 'AI_TOKEN_BUDGET_EXCEEDED' });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.store.update).not.toHaveBeenCalled();
});

test('bounded rebuild uses recent history, rewinds the cursor and retains unexamined AI conclusions', async () => {
  const old = { id: 'old_profile', category: 'likes', text: '更早整理的长期兴趣', origin: 'ai', confirmed: false,
    evidence: [{ quote: '之前对话中的真实原话。' }] };
  const rows = Array.from({ length: 92 }, (_, index) => ({ id: index + 1,
    content: text + '甲'.repeat(328 - text.length), created_at: now() }));
  const f = fixture({ rows, cursor: 92, items: [old], result: response([]) });
  const rebuilt = await f.service.generate(user, { expectedRevision: revision, mode: 'rebuild' });
  const input = JSON.parse(f.provider.mock.calls[0][1][1].content.replace(/^SOURCE_INPUT:\n/, ''));
  expect(f.executor.execute.mock.calls[0][0]).toMatch(/ORDER BY m.id DESC LIMIT/);
  expect(f.executor.execute.mock.calls[0][1]).toEqual([user, user, 0, 80]);
  expect(input.sources.length).toBeLessThan(80);
  expect(rebuilt.profile.historyCursor).toBe(input.sources.length + 12);
  expect(rebuilt.profile.historyCursor).toBeLessThan(92);
  expect(rebuilt.profile.items).toContainEqual(old);
  expect(f.store.update.mock.calls[0][2]).toEqual({ actor: 'ai', allowHistoryRewind: true });
  const resumed = await f.service.generate(user, { expectedRevision: rebuilt.revision });
  expect(f.executor.execute.mock.calls[1][1][2]).toBe(rebuilt.profile.historyCursor);
  expect(resumed.profile.historyCursor).toBe(92);
  expect(resumed.profile.items).toContainEqual(old);
});

test('shared persistence permits trusted rebuild cursor rewind and subsequent incremental processing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-profile-rebuild-'));
  try {
    const store = createPersonalizationStore({ root, now });
    const initial = await store.update(user, { expectedRevision: (await store.get(user)).revision,
      profile: { items: [], historyCursor: 100 } }, { actor: 'ai' });
    const rows = Array.from({ length: 92 }, (_, index) => ({ id: index + 1,
      content: text + '甲'.repeat(328 - text.length), created_at: now() }));
    const f = fixture({ rows, result: response([]) });
    const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: store,
      getRuntime: () => ({ config: { baseUrl: 'https://maas.qianwenaiapi.com', model: 'deepseek-v4-flash-0731', apiKey: 'fixture' } }), now });
    const rebuilt = await service.generate(user, { expectedRevision: initial.revision, mode: 'rebuild' });
    expect(rebuilt.profile.historyCursor).toBeGreaterThan(0);
    expect(rebuilt.profile.historyCursor).toBeLessThan(92);
    const resumed = await service.generate(user, { expectedRevision: rebuilt.revision });
    expect(f.executor.execute.mock.calls[1][1][2]).toBe(rebuilt.profile.historyCursor);
    expect(resumed.profile.historyCursor).toBe(92);
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ai-profile-rebuild-')) throw new Error('Unsafe cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('successful automatic generation retains its profile timestamp interval', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, content: text, created_at: now() }));
  const f = fixture({ rows }); let at = now().getTime();
  const service = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    getRuntime: () => ({ config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } }), now: () => new Date(at) });
  await service.maybeGenerate(user);
  expect(f.provider).toHaveBeenCalledTimes(1);
  at += 1000;
  await service.maybeGenerate(user);
  expect(f.provider).toHaveBeenCalledTimes(1);
  // Even a fresh service instance respects the successful persisted timestamp.
  const reopened = createProfileGenerationService({ executor: f.executor, provider: f.provider, personalizationStore: f.store,
    getRuntime: () => ({ config: { baseUrl: 'https://api.example.com', model: 'fixture', apiKey: 'fixture' } }), now: () => new Date(at) });
  await reopened.maybeGenerate(user);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('an explicitly zero automatic interval does not throttle failed attempts', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, content: text, created_at: now() }));
  const f = fixture({ rows });
  f.provider.mockImplementation(async () => { throw new Error('Provider failed'); });
  await expect(f.service.maybeGenerate(user, { minimumIntervalMs: 0 })).rejects.toThrow('Provider failed');
  await expect(f.service.maybeGenerate(user, { minimumIntervalMs: 0 })).rejects.toThrow('Provider failed');
  expect(f.provider).toHaveBeenCalledTimes(2);
});
