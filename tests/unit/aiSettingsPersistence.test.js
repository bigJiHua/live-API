jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Review test must not open DB'); }),
  getConnection: jest.fn(() => { throw new Error('Review test must not open DB'); }),
}));
jest.mock('mysql2/promise', () => ({
  createPool: jest.fn(() => { throw new Error('Review test must not open DB'); }),
  createConnection: jest.fn(() => { throw new Error('Review test must not open DB'); }),
}));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const { createPreferenceStore } = require('../../src/modules/ai/service/preferences');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { createDataGrantStore } = require('../../src/modules/ai/service/dataGrant');
const { encryptField } = require('../../src/common/utils/fieldCrypto');
const { createTestService, testEnv } = require('../helpers/aiFixture');
const { getConfig } = require('../../src/modules/ai/service/config');

const env = testEnv({ AI_ALLOW_SESSION_SETTINGS: 'true', AI_BASE_URL: 'https://global.example/v1',
  AI_API_KEY: 'synthetic-global-key', AI_MODEL: 'global-model' });
const input = { apiUrl: 'https://chosen.example/v1', apiKey: 'synthetic-user-key', model: 'chosen-model' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function persistedRow() {
  return { user_id: 'owner', connection_id: '00000000-0000-4000-8000-000000000001',
    name: 'chosen.example', provider_host: input.apiUrl, model: input.model,
    api_key_cipher: encryptField(input.apiKey), key_fingerprint: '0123456789abcdef', is_active: 1, updated_at: 1 };
}
// 内存版 ai_provider_profile：UPDATE 以旧 connection_id 定位，行不存在时返回 affectedRows: 0。
function providerExecutor({ updateAffectedRows = 1 } = {}) {
  const rows = new Map();
  const executor = { execute: jest.fn(async (sql, args) => {
    if (sql.startsWith('SELECT user_id, connection_id')) return [Array.from(rows.values())];
    if (/INSERT INTO ai_provider_profile/.test(sql)) {
      const [userId, connectionId, name, host, model, cipher, fp, stamp] = args;
      rows.set(connectionId, { user_id: userId, connection_id: connectionId, name, provider_host: host, model,
        api_key_cipher: cipher, key_fingerprint: fp, is_active: 0, updated_at: stamp });
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE ai_provider_profile SET is_active/.test(sql)) {
      const [selected, userId] = args;
      for (const row of rows.values()) if (row.user_id === userId) row.is_active = row.connection_id === selected ? 1 : 0;
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE ai_provider_profile SET connection_id=/.test(sql)) {
      if (!updateAffectedRows) return [{ affectedRows: 0 }];
      const [connectionId, name, host, model, cipher, fp, stamp, userId, previousId] = args;
      const row = rows.get(previousId);
      if (!row || row.user_id !== userId) return [{ affectedRows: 0 }];
      rows.delete(previousId);
      Object.assign(row, { connection_id: connectionId, name, provider_host: host, model, api_key_cipher: cipher,
        key_fingerprint: fp, updated_at: stamp });
      rows.set(connectionId, row);
      return [{ affectedRows: 1 }];
    }
    throw new Error('unexpected sql: ' + sql);
  }) };
  return { rows, executor };
}

afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createConnection).not.toHaveBeenCalled();
});

test('account connection is the only provider source; environment aliases are ignored', async () => {
  const service = createTestService({ env, checkConnection: async () => {}, settingsStore: createSettingsStore() });
  await service.configure('owner', input);
  expect(service.getRuntime('owner').config).toMatchObject({ baseUrl: input.apiUrl, model: input.model, apiKey: input.apiKey });
  // .env 里仍有 AI_API_KEY/AI_BASE_URL/AI_MODEL，但未添加接入商的账号不再借用
  expect(() => service.getRuntime('other')).toThrow(expect.objectContaining({ code: 'AI_PROVIDER_REQUIRED' }));
});

test('switching models refreshes mandatory versus optional thinking capabilities', async () => {
  const service = createTestService({ env, checkConnection: async () => {}, settingsStore: createSettingsStore() });
  await service.configure('owner', { apiUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'synthetic-user-key', model: 'glm-5.3-flash' });
  await service.setPreference('owner', { thinking: false });
  expect(service.getPreferences('owner')).toMatchObject({ thinkingEnabled: true, thinkingSupported: false, thinkingRequired: true });
  expect(service.getCapabilities('owner').modelCapabilities).toMatchObject({ provider: 'glm', maxOutputTokens: 131072 });
  await service.configure('owner', { apiUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' });
  expect(service.getPreferences('owner')).toMatchObject({ thinkingEnabled: false, thinkingSupported: true, thinkingRequired: false });
});

test('configuration and model listing never fall back to environment credentials', async () => {
  axios.get.mockResolvedValue({ data: { data: [{ id: 'chosen-model' }] } });
  const checkConnection = jest.fn(async () => {});
  const service = createTestService({ env, checkConnection, settingsStore: createSettingsStore() });
  await expect(service.fetchProviderModels('owner')).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  await expect(service.configure('owner', { apiUrl: input.apiUrl, model: input.model })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  await service.configure('owner', input);
  await service.fetchProviderModels('owner');
  expect(axios.get.mock.calls.at(-1)[1].headers.Authorization).toBe(`Bearer ${input.apiKey}`);
  // 同地址省略 Key 复用该接入商 Key；换目标地址必须显式提供 Key
  await service.configure('owner', { apiUrl: input.apiUrl + '/', model: 'different-model' });
  expect(checkConnection).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: input.apiKey }));
  await expect(service.configure('owner', { apiUrl: 'https://new-target.example/v1', model: 'next-model' }))
    .rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(service.getRuntime('owner').config.model).toBe('different-model');
});

test('cold synchronous getters fail closed until the shared warmup completes', async () => {
  const load = deferred();
  const executor = { execute: jest.fn(() => load.promise) };
  const settingsStore = createSettingsStore({ executor });
  const service = createTestService({ env, settingsStore });
  expect(() => service.getSettings('owner')).toThrow(expect.objectContaining({ code: 'AI_SETTINGS_LOADING' }));
  expect(() => service.getRuntime('owner')).toThrow(expect.objectContaining({ code: 'AI_SETTINGS_LOADING' }));
  const a = service.warmupSettings(), b = service.warmupSettings();
  expect(a).toBe(b);
  await flush();
  expect(executor.execute).toHaveBeenCalledTimes(1);
  load.resolve([[persistedRow()]]);
  await a;
  expect(service.getSettings('owner')).toMatchObject({ configured: true, apiUrl: input.apiUrl });
  expect(service.getRuntime('owner').config.apiKey).toBe(input.apiKey);
});

test('failed settings warmup rejects safely and the next request retries recovery', async () => {
  const executor = { execute: jest.fn().mockRejectedValueOnce(Object.assign(new Error('private db failure'), { code: 'ER_NO_SUCH_TABLE' }))
    .mockResolvedValueOnce([[persistedRow()]]) };
  const service = createTestService({ env, settingsStore: createSettingsStore({ executor }) });
  await expect(service.warmupSettings()).rejects.toMatchObject({ code: 'AI_SETTINGS_UNAVAILABLE', status: 503 });
  await service.warmupSettings();
  expect(executor.execute).toHaveBeenCalledTimes(2);
  expect(service.getSettings('owner').configured).toBe(true);
});

test('configuration reports success and rotates connection only after persistence confirms', async () => {
  const write = deferred();
  let slowWrite = false;
  const executor = { execute: jest.fn(async sql => {
    if (sql.startsWith('SELECT')) return [[]];
    return slowWrite ? write.promise : [{ affectedRows: 1 }];
  }) };
  const store = createSettingsStore({ executor });
  const service = createTestService({ env, settingsStore: store, checkConnection: async () => {} });
  const original = await service.configure('owner', input);
  slowWrite = true;
  let complete = false;
  const pending = service.configure('owner', { ...input, model: 'new-model' }).then(value => { complete = true; return value; });
  await flush();
  expect(complete).toBe(false);
  expect(service.getSettings('owner').connectionId).toBe(original.connectionId);
  expect(service.getRuntime('owner').config.model).toBe(input.model);
  write.resolve([{ affectedRows: 1 }]);
  const saved = await pending;
  expect(saved.connectionId).not.toBe(original.connectionId);
  expect(service.getRuntime('owner').config.model).toBe('new-model');
});

test.each([
  ['model', { model: 'rotated-model' }],
  ['apiKey', { apiKey: 'synthetic-rotated-key' }],
  ['apiUrl', { apiUrl: 'https://rotated.example/v1', model: 'rotated-model' }],
])('editing %s through the old connection id updates one row and survives restart', async (_field, patch) => {
  const { rows, executor } = providerExecutor();
  const store = createSettingsStore({ executor });
  await store.save('owner', input);
  const oldId = store.list('owner')[0].connectionId;
  await store.save('owner', { ...input, ...patch }, { connectionId: oldId });
  const expected = { ...input, ...patch };
  const items = store.list('owner');
  expect(items).toHaveLength(1);
  const newId = items[0].connectionId;
  expect(newId).not.toBe(oldId);
  expect(rows.size).toBe(1);
  expect(rows.has(oldId)).toBe(false);
  expect(rows.get(newId)).toMatchObject({ connection_id: newId, provider_host: expected.apiUrl, model: expected.model });
  // 模拟重启：新 store 从同一数据库恢复，读到的是新值且处于激活状态。
  const restarted = createSettingsStore({ executor });
  await restarted.warmup();
  // get() 只返回生效接入商；同时数据库里该行 is_active = 1。
  expect(restarted.get('owner')).toMatchObject({ connectionId: newId,
    apiUrl: expected.apiUrl, model: expected.model, apiKey: expected.apiKey });
  expect(rows.get(newId).is_active).toBe(1);
});

test('insert and rotation retain identical persisted and live timestamps with an advancing clock after restart', async () => {
  const { rows, executor } = providerExecutor();
  let tick = 1794380000000;
  const now = jest.fn(() => ++tick);
  const store = createSettingsStore({ executor, now });
  const readers = [];
  const expectRestored = async live => {
    const restarted = createSettingsStore({ executor, now });
    readers.push(restarted);
    await restarted.warmup();
    const { active: _restoredActive, ...restoredProfile } = restarted.get('owner');
    const { active: _liveActive, ...liveProfile } = live;
    expect(restoredProfile).toEqual(liveProfile);
  };
  try {
    await store.save('owner', input);
    const initial = store.get('owner');
    const insert = executor.execute.mock.calls.find(([sql]) => /INSERT INTO ai_provider_profile/.test(sql));
    expect(insert[1][7]).toBe(initial.updatedAt);
    expect(insert[1][8]).toBe(initial.updatedAt);
    expect(rows.get(initial.connectionId).updated_at).toBe(initial.updatedAt);
    await expectRestored(initial);

    await store.save('owner', { ...input, model: 'timestamp-rotated-model', apiKey: 'synthetic-timestamp-rotated-key' },
      { connectionId: initial.connectionId });
    const rotated = store.get('owner');
    const update = executor.execute.mock.calls.find(([sql]) => /UPDATE ai_provider_profile SET connection_id=/.test(sql));
    expect(rotated.connectionId).not.toBe(initial.connectionId);
    expect(rotated.updatedAt).toBeGreaterThan(initial.updatedAt);
    expect(update[1][6]).toBe(rotated.updatedAt);
    expect(rows.get(rotated.connectionId).updated_at).toBe(rotated.updatedAt);
    expect(rows.size).toBe(1);
    expect(rows.get(rotated.connectionId).is_active).toBe(1);
    await expectRestored(rotated);
  } finally { store.close(); readers.forEach(reader => reader.close()); }
});

test('a zero-row update fails with AI_PROVIDER_NOT_FOUND and leaves memory untouched', async () => {
  const { rows, executor } = providerExecutor({ updateAffectedRows: 0 });
  const store = createSettingsStore({ executor });
  await store.save('owner', input);
  const before = store.list('owner');
  await expect(store.save('owner', { ...input, model: 'rotated-model' }, { connectionId: before[0].connectionId }))
    .rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_FOUND', status: 404 });
  expect(store.list('owner')).toEqual(before);
  expect(rows.size).toBe(1);
  expect(rows.get(before[0].connectionId).model).toBe(input.model);
});

test('activation failure is never reported as success and memory keeps the old connection', async () => {
  const { executor } = providerExecutor();
  const store = createSettingsStore({ executor });
  await store.save('owner', input);
  const before = store.list('owner');
  executor.execute.mockImplementation(async sql => {
    if (/UPDATE ai_provider_profile SET is_active/.test(sql)) throw new Error('private db failure');
    if (/UPDATE ai_provider_profile SET connection_id=/.test(sql)) return [{ affectedRows: 1 }];
    throw new Error('unexpected sql: ' + sql);
  });
  await expect(store.save('owner', { ...input, model: 'rotated-model' }, { connectionId: before[0].connectionId }))
    .rejects.toMatchObject({ code: 'AI_SETTINGS_UNAVAILABLE', status: 503 });
  expect(store.list('owner')).toEqual(before);
});

test('production connection wrapper rolls back rotation when activation fails', async () => {
  let failActivate = false;
  const base = providerExecutor();
  const execute = jest.fn(async (sql, args) => {
    if (failActivate && /UPDATE ai_provider_profile SET is_active/.test(sql)) throw new Error('private db failure');
    return base.executor.execute(sql, args);
  });
  const conn = { execute, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(async () => {}), release: jest.fn() };
  const store = createSettingsStore({ executor: { execute, getConnection: jest.fn(async () => conn) } });
  await store.save('owner', input);
  const before = store.list('owner');
  failActivate = true;
  await expect(store.save('owner', { ...input, model: 'rotated-model' }, { connectionId: before[0].connectionId }))
    .rejects.toMatchObject({ code: 'AI_SETTINGS_UNAVAILABLE', status: 503 });
  expect(conn.beginTransaction).toHaveBeenCalledTimes(2);
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.release).toHaveBeenCalledTimes(2);
  expect(store.list('owner')).toEqual(before);
});

test('failed persistence preserves the previous key, model and connection', async () => {
  const executor = { execute: jest.fn(async sql => sql.startsWith('SELECT') ? [[persistedRow()]] : Promise.reject(new Error('private db failure'))) };
  const service = createTestService({ env, settingsStore: createSettingsStore({ executor }), checkConnection: async () => {} });
  await service.warmupSettings();
  const before = service.getSettings('owner');
  await expect(service.configure('owner', { ...input, apiKey: 'synthetic-new-key', model: 'new-model' })).rejects.toMatchObject({ code: 'AI_SETTINGS_UNAVAILABLE', status: 503 });
  expect(service.getSettings('owner')).toEqual(before);
  expect(service.getRuntime('owner').config.apiKey).toBe(input.apiKey);
});

test('clearing a key waits for SQL and failed removal leaves the connection usable', async () => {
  const deletion = deferred();
  const executor = { execute: jest.fn(async sql => sql.startsWith('SELECT') ? [[persistedRow()]] : deletion.promise) };
  const service = createTestService({ env, settingsStore: createSettingsStore({ executor }) });
  await service.warmupSettings();
  const pending = service.clearSettings('owner');
  await flush();
  expect(service.getSettings('owner').configured).toBe(true);
  deletion.reject(new Error('private removal failure'));
  await expect(pending).rejects.toMatchObject({ code: 'AI_SETTINGS_UNAVAILABLE' });
  expect(service.getSettings('owner').configured).toBe(true);
  executor.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
  await service.clearSettings('owner');
  expect(service.getSettings('owner').configured).toBe(false);
});

test('preference recovery retries after failure and persistence errors retain the stored choice', async () => {
  const executor = { execute: jest.fn().mockRejectedValueOnce(new Error('private read failure'))
    .mockResolvedValueOnce([[{ user_id: 'owner', thinking_enabled: 1 }]])
    .mockRejectedValueOnce(new Error('private write failure')) };
  const preferences = createPreferenceStore({ executor });
  await expect(preferences.warmup()).rejects.toMatchObject({ code: 'AI_PREFERENCE_UNAVAILABLE' });
  await preferences.warmup();
  expect(preferences.get('owner')).toBe(true);
  await expect(preferences.set('owner', false)).rejects.toMatchObject({ code: 'AI_PREFERENCE_UNAVAILABLE' });
  expect(preferences.get('owner')).toBe(true);
});

test.each(['toString', '__proto__', 'constructor'])('prototype property %s is not an authorization domain', async domain => {
  const executor = { execute: jest.fn() };
  await expect(createDataGrantStore({ executor }).put('owner', { providerHost: 'chosen.example', domains: [domain] }))
    .rejects.toMatchObject({ code: 'AI_GRANT_INVALID' });
  expect(executor.execute).not.toHaveBeenCalled();
});

test('normal migration runner applies the consolidated AI migration once and stays idempotent', async () => {
  const { runMigrations } = require('../../src/init/migrationRunner');
  const filename = '019_consolidated_20261111.sql';
  const statements = fs.readFileSync(path.join(__dirname, '../../mysql/migrations', filename), 'utf8')
    .replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/)
    .map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  const applied = new Set(fs.readdirSync(path.join(__dirname, '../../mysql/migrations')).filter(name => name.endsWith('.sql') && name !== filename));
  const created = [];
  const conn = { query: jest.fn(async sql => { created.push(sql); return [{ affectedRows: 0 }]; }),
    execute: jest.fn(async (sql, args) => {
      if (sql.includes('SELECT filename')) return [[...applied].map(name => ({ filename: name }))];
      if (sql.includes('INSERT INTO')) applied.add(args[0]);
      return [{ affectedRows: 1 }];
    }) };
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runMigrations(conn)).toEqual({ count: 1 });
    expect(created).toEqual(statements);
    expect(created.some(sql => /^CREATE TABLE IF NOT EXISTS `ai_data_grant`/.test(sql))).toBe(true);
    expect(created.some(sql => /^CREATE TABLE IF NOT EXISTS `ai_provider_setting`/.test(sql))).toBe(true);
    expect(applied.has(filename)).toBe(true);
    expect(await runMigrations(conn)).toEqual({ count: 0 });
    expect(created).toHaveLength(statements.length);
  } finally { log.mockRestore(); }
});

test('consolidated migration creates multi-provider settings and migrates the legacy row idempotently', async () => {
  const { runMigrations } = require('../../src/init/migrationRunner');
  const filename = '019_consolidated_20261111.sql';
  const statements = fs.readFileSync(path.join(__dirname, '../../mysql/migrations', filename), 'utf8')
    .replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/)
    .map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  const applied = new Set(fs.readdirSync(path.join(__dirname, '../../mysql/migrations')).filter(name => name.endsWith('.sql') && name !== filename));
  const queries = [];
  const conn = { query: jest.fn(async sql => { queries.push(sql); return [{ affectedRows: 0 }]; }),
    execute: jest.fn(async (sql, args) => {
      if (sql.includes('SELECT filename')) return [[...applied].map(name => ({ filename: name }))];
      if (sql.includes('INSERT INTO')) applied.add(args[0]);
      return [{ affectedRows: 1 }];
    }) };
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await runMigrations(conn)).toEqual({ count: 1 });
    expect(queries).toEqual(statements);
    expect(queries.some(sql => /^CREATE TABLE IF NOT EXISTS `ai_provider_profile`/.test(sql))).toBe(true);
    expect(queries.some(sql => /^INSERT IGNORE INTO `ai_provider_profile`/.test(sql))).toBe(true);
    expect(queries.join('\n')).not.toMatch(/DROP TABLE|DELETE FROM/i);
    expect(applied.has(filename)).toBe(true);
    expect(await runMigrations(conn)).toEqual({ count: 0 });
    expect(queries).toHaveLength(statements.length);
  } finally { log.mockRestore(); }
});

test('legacy provider backfill is gated on the old or consolidated migration record', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../mysql/migrations/019_consolidated_20261111.sql'), 'utf8');
  const statements = sql.replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/)
    .map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  const backfill = statements.find(statement => /^INSERT IGNORE INTO `ai_provider_profile`/.test(statement));
  expect(backfill).toContain('NOT EXISTS');
  expect(backfill).toContain('`_migrations`');
  expect(backfill).toContain('023_ai_provider_profiles.sql');
  expect(backfill).toContain('019_consolidated_20261111.sql');
});

test('external conversation append uses the caller transaction without acquiring or committing another connection', async () => {
  const external = { execute: jest.fn(async sql => sql.startsWith('SELECT') ? [[{ id: 'conversation' }]] : [{ affectedRows: 1 }]) };
  const executor = { getConnection: jest.fn(() => { throw new Error('Must use caller transaction'); }) };
  await createConversationStore({ executor }).append('owner', 'conversation', { message: 'hello', answer: 'answer' }, external);
  expect(executor.getConnection).not.toHaveBeenCalled();
  expect(external.execute).toHaveBeenCalledTimes(4);
});

test.each([1000, 60000, 105000])('provider deadline accepts %d milliseconds', value => {
  expect(getConfig(testEnv({ AI_PROVIDER_TIMEOUT_MS: String(value) })).providerTimeoutMs).toBe(value);
});
test.each(['999', '105001', 'NaN', '12.5'])('invalid provider deadline %s rejects configuration', value => {
  expect(() => getConfig(testEnv({ AI_PROVIDER_TIMEOUT_MS: value }))).toThrow(expect.objectContaining({ code: 'AI_CONFIG_REQUIRED' }));
});
