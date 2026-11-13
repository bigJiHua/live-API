jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Settings test must not open DB'); }),
  getConnection: jest.fn(() => { throw new Error('Settings test must not open DB'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Settings test must not open DB'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { createLegacyTestService: createTestService, testEnv } = require('../helpers/aiFixture');
const { createSettingsStore, normalizeApiUrl } = require('../../src/modules/ai/service/settings');
const { checkDeepseekConnection, deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { AiError } = require('../../src/modules/ai/service/errors');
const env = testEnv({ AI_ALLOW_SESSION_SETTINGS: 'true' });
const settings = { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'synthetic-key-only', model: 'deepseek-flash' };
const call = { role: 'assistant', content: null, tool_calls: [{ id: 'test_call', type: 'function', function: {
  name: 'query_finance_summary', arguments: JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-05' }) } }] };
describe('temporary DeepSeek settings', () => {
  afterAll(() => {
    const db = require('../../src/common/config/db');
    expect(db.execute).not.toHaveBeenCalled(); expect(db.getConnection).not.toHaveBeenCalled();
    expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
  });
  test.each(['http://api.deepseek.com', 'http://remote.test/v1', 'https://evil.test@api.deepseek.com',
    'https://api.deepseek.com/?key=secret', 'https://api.deepseek.com/#secret', 'file:///etc/passwd'])
  ('reject unsafe endpoint %s before sending Key', async apiUrl => {
    const checkConnection = jest.fn();
    const s = createTestService({ env, checkConnection });
    await expect(s.configure('a', { ...settings, apiUrl })).rejects.toThrow();
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test.each([
    ['https://api.deepseek.com', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1'],
    ['https://provider.test:444/compatible/', 'https://provider.test:444/compatible'],
    ['https://localhost/v1', 'https://localhost/v1'],
    ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1'],
  ])('preserves the chosen OpenAI-compatible base %s', (url, expected) => {
    expect(normalizeApiUrl(url)).toBe(expected);
  });
  test('provider settings are on by default, an explicit false disables writes, and extra fields are rejected', async () => {
    const checkConnection = jest.fn();
    await expect(createTestService({ env: { ...env, AI_ALLOW_SESSION_SETTINGS: 'false' }, checkConnection })
      .configure('a', settings)).rejects.toMatchObject({ code: 'AI_SETTINGS_DISABLED' });
    const s = createTestService({ env, checkConnection });
    for (const extra of [{ userId: 'b' }, { messages: [] }, { db: {} }]) await expect(s.configure('a', { ...settings, ...extra })).rejects.toThrow();
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('Key is only used for its owner, never returned, and persists encrypted across restarts (D-028)', async () => {
    // 2026-11-08：多接入商表 ai_provider_profile；每个账号可有多行，is_active 标记生效的一家。
    const rows = new Map();
    const executor = { execute: jest.fn(async (sql, args) => {
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
        const [connectionId, name, host, model, cipher, fp, stamp, userId, previousId] = args;
        const row = rows.get(previousId);
        if (!row || row.user_id !== userId) return [{ affectedRows: 0 }];
        rows.delete(previousId);
        Object.assign(row, { connection_id: connectionId, name, provider_host: host, model, api_key_cipher: cipher,
          key_fingerprint: fp, updated_at: stamp });
        rows.set(connectionId, row);
        return [{ affectedRows: 1 }];
      }
      if (/DELETE FROM ai_provider_profile/.test(sql)) {
        if (args.length === 1) { for (const [id, row] of rows) if (row.user_id === args[0]) rows.delete(id); }
        else rows.delete(args[1]);
        return [{ affectedRows: 1 }];
      }
      if (/SELECT user_id, connection_id/.test(sql)) return [Array.from(rows.values())];
      throw new Error('unexpected sql: ' + sql);
    }) };
    const settingsStore = createSettingsStore({ executor });
    const checkConnection = jest.fn().mockResolvedValue();
    const s = createTestService({ env, checkConnection, settingsStore });
    const profile = await s.configure('a', settings);
    expect(JSON.stringify(profile)).not.toContain(settings.apiKey);
    expect(profile).toMatchObject({ configured: true, apiUrl: 'https://api.deepseek.com/v1', expiresAt: null,
      name: 'api.deepseek.com', hasKey: true });
    expect(profile.keyFingerprint).toBeTruthy();
    expect(profile.profiles).toHaveLength(1);
    expect(profile.profiles[0]).toMatchObject({ active: true, apiUrl: settings.apiUrl, model: settings.model });
    expect(JSON.stringify(profile)).not.toContain('*********');
    expect(checkConnection).toHaveBeenCalledWith(expect.objectContaining({ ...settings, baseUrl: settings.apiUrl }));
    expect(s.getSettings('b').configured).toBe(false);
    expect(s.getSettings('b').profiles).toEqual([]);
    expect(s.getCapabilities('a')).toMatchObject({ mode: 'deepseek', requiresConsent: true, dataSource: 'user-readonly' });
    // 未添加接入商的账号不再借用 .env Key，能力接口明确显示未启用
    expect(s.getCapabilities('b').enabled).toBe(false);
    // configure 成功已经确认落库；密文不含明文 Key，指纹与 host/model 一并保存。
    const saved = rows.get(profile.connectionId);
    expect(saved.api_key_cipher.startsWith('enc.v1:')).toBe(true);
    expect(saved.api_key_cipher).not.toContain(settings.apiKey);
    expect(saved.provider_host).toBe('https://api.deepseek.com/v1');
    expect(saved.model).toBe('deepseek-flash');
    expect(saved.key_fingerprint).toBe(profile.keyFingerprint);
    // 模拟重启：新 store 从同一 executor 恢复，同账号多端共享同一连接（含 connectionId）
    const store2 = createSettingsStore({ executor });
    await store2.warmup();
    const s2 = createTestService({ env, checkConnection: async () => {}, settingsStore: store2 });
    const restored = s2.getSettings('a');
    expect(restored).toMatchObject({ configured: true, apiUrl: settings.apiUrl, model: settings.model, connectionId: profile.connectionId, keyFingerprint: profile.keyFingerprint });
    expect(JSON.stringify(restored)).not.toContain(settings.apiKey);
    // 换 Key 重配 → connectionId 轮换；旧 connectionId 立即失效（原 TTL 语义的替代）
    await expect(s2.configure('a', { ...settings, apiKey: 'different-synthetic-key' })).resolves.toMatchObject({ configured: true });
    await expect(s2.run('a', { message: '你好', scene: 'chat', consent: true, connectionId: profile.connectionId })).rejects.toMatchObject({ code: 'AI_CONNECTION_EXPIRED' });
    // 清除 → DB 行删除 + 配置消失（不再回落 env 全局 Key）
    await s2.clearSettings('a');
    expect(rows.size).toBe(0);
    expect(s2.getSettings('a').configured).toBe(false);
    expect(s2.getSettings('a').profiles).toEqual([]);
  });
  test('failed connection leaves previous Key untouched and no raw provider errors escape', async () => {
    const checkConnection = jest.fn().mockResolvedValueOnce().mockRejectedValueOnce(new AiError('连接失败', 502));
    const s = createTestService({ env, checkConnection });
    const first = await s.configure('a', settings);
    await expect(s.configure('a', { ...settings, apiKey: 'different-synthetic-key' })).rejects.toThrow('连接失败');
    expect(s.getSettings('a').connectionId).toBe(first.connectionId);
    s.clearSettings('a'); expect(s.getSettings('a').configured).toBe(false);
  });
  test('multiple providers can be stored, switched and deleted without exposing any Key', async () => {
    const store = createSettingsStore();
    const checkConnection = jest.fn().mockResolvedValue();
    const s = createTestService({ env, checkConnection, settingsStore: store });
    const first = await s.configure('a', { name: 'DeepSeek', apiUrl: 'https://api.deepseek.com/v1',
      apiKey: 'synthetic-key-one', model: 'deepseek-flash' });
    const second = await s.configure('a', { name: '商汤', apiUrl: 'https://token.sensenova.cn/v1',
      apiKey: 'synthetic-key-two', model: 'sensenova-6.8-flash' });
    expect(second.profiles).toHaveLength(2);
    expect(second.activeConnectionId).toBe(second.connectionId);
    expect(second.connectionId).not.toBe(first.connectionId);
    const payload = JSON.stringify(second);
    expect(payload).not.toContain('synthetic-key-one');
    expect(payload).not.toContain('synthetic-key-two');
    expect(payload).not.toMatch(/apiKey"/);
    expect(second.profiles.find(item => item.name === '商汤')).toMatchObject({ active: true,
      apiUrl: 'https://token.sensenova.cn/v1', model: 'sensenova-6.8-flash', keyFingerprint: expect.any(String) });
    expect(s.getRuntime('a').config).toMatchObject({ baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'synthetic-key-two' });
    // 使用另一家 → 生效连接编号立刻变化（v3 会话据此拦截旧连接）
    const activated = await s.activateProvider('a', first.connectionId);
    expect(activated.connectionId).toBe(first.connectionId);
    expect(s.getRuntime('a').config).toMatchObject({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'synthetic-key-one' });
    // 删除生效接入商 → 自动切到最近保存的另一家
    const fallback = await s.deleteProvider('a', first.connectionId);
    expect(fallback.profiles).toHaveLength(1);
    expect(fallback.connectionId).toBe(second.connectionId);
    expect(fallback.configured).toBe(true);
    // 名称不能重复，否则前端无法区分
    await expect(s.configure('a', { name: '商汤', apiUrl: 'https://third.example/v1',
      apiKey: 'synthetic-key-three', model: 'third-model' })).rejects.toMatchObject({ code: 'AI_PROVIDER_NAME_TAKEN' });
    const empty = await s.deleteProvider('a', second.connectionId);
    expect(empty.configured).toBe(false);
    expect(empty.profiles).toEqual([]);
    expect(JSON.stringify(empty)).not.toContain('synthetic-key');
  });
  test('the same provider URL can hold two named accounts with separate keys', async () => {
    const store = createSettingsStore();
    const s = createTestService({ env, checkConnection: async () => {}, settingsStore: store });
    const first = await s.configure('a', { name: '商汤 A', apiUrl: 'https://token.sensenova.cn/v1',
      apiKey: 'synthetic-key-one', model: 'sensenova-6.8-flash' });
    const second = await s.configure('a', { name: '商汤 B', apiUrl: 'https://token.sensenova.cn/v1',
      apiKey: 'synthetic-key-two', model: 'sensenova-6.8-flash-lite' });
    expect(second.profiles).toHaveLength(2);
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(store.list('a').map(item => item.apiKey).sort()).toEqual(['synthetic-key-one', 'synthetic-key-two']);
    await s.activateProvider('a', first.connectionId);
    expect(s.getRuntime('a').config).toMatchObject({ apiKey: 'synthetic-key-one', model: 'sensenova-6.8-flash' });
    expect(JSON.stringify(second)).not.toContain('synthetic-key-one');
  });
  test('provider and tool loop use the injected repository without connecting to MySQL', async () => {
    axios.post.mockResolvedValueOnce({ data: { choices: [{ finish_reason: 'tool_calls', message: call }] } })
      .mockResolvedValueOnce({ data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '测试收支已返回' } }] } });
    const s = createTestService({ env, checkConnection: async () => {},
      chat: (messages, tools) => deepseekChat({ baseUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model }, messages, tools) });
    const profile = await s.configure('a', settings);
    await expect(s.run('a', { message: '本月收支', scene: 'chat', consent: false, connectionId: profile.connectionId })).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(axios.post).not.toHaveBeenCalled();
    const result = await s.run('a', { message: '本月收支', scene: 'chat', consent: true, connectionId: profile.connectionId });
    expect(result).toMatchObject({ mode: 'deepseek', source: 'user-readonly', formalWriteEnabled: false });
    expect(result.trace[0].result.expense).toBe('51.20');
    expect(axios.post.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe(`Bearer ${settings.apiKey}`);
    expect(axios.post.mock.calls[0][1].messages.some(message => message.content?.includes(settings.apiKey))).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  test('production cannot bypass real read-only database setup via synthetic option', async () => {
    const checkConnection = jest.fn();
    const s = createTestService({ env: { ...env, NODE_ENV: 'production', AI_MODE: 'deepseek', AI_SYNTHETIC_DATA: 'true' }, checkConnection });
    await expect(s.configure('a', settings)).rejects.toMatchObject({ code: 'AI_CONFIG_REQUIRED' });
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('the site-level AI_MODE=disabled locks provider management', async () => {
    const checkConnection = jest.fn();
    const s = createTestService({ env: { ...env, AI_MODE: 'disabled' }, checkConnection });
    await expect(s.configure('a', settings)).rejects.toMatchObject({ code: 'AI_SETTINGS_DISABLED' });
    expect(s.getCapabilities('a').enabled).toBe(false);
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('connection check uses the selected base models endpoint and sanitizes credentials on failure', async () => {
    axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'deepseek-flash' }] } });
    await checkDeepseekConnection({ ...settings, baseUrl: settings.apiUrl });
    expect(axios.get.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/models');
    axios.get.mockRejectedValueOnce({ response: { status: 401, data: { message: settings.apiKey } } });
    try { await checkDeepseekConnection({ ...settings, baseUrl: settings.apiUrl }); } catch (error) {
      expect(error.code).toBe('AI_KEY_INVALID'); expect(error.message).not.toContain(settings.apiKey);
    }
  });
});
