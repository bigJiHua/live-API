jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Settings test must not open DB'); }),
  getConnection: jest.fn(() => { throw new Error('Settings test must not open DB'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Settings test must not open DB'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { createTestService, testEnv } = require('../helpers/aiFixture');
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
  test('settings stay disabled without operator opt-in and reject extra fields', async () => {
    const checkConnection = jest.fn();
    await expect(createTestService({ checkConnection }).configure('a', settings)).rejects.toMatchObject({ code: 'AI_SETTINGS_DISABLED' });
    const s = createTestService({ env, checkConnection });
    for (const extra of [{ userId: 'b' }, { messages: [] }, { db: {} }]) await expect(s.configure('a', { ...settings, ...extra })).rejects.toThrow();
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('Key is only used for its owner, never returned, and expired connections must be renewed', async () => {
    let clock = 1000;
    const settingsStore = createSettingsStore({ now: () => clock, ttl: 100 });
    const checkConnection = jest.fn().mockResolvedValue();
    const s = createTestService({ env, checkConnection, settingsStore });
    const profile = await s.configure('a', settings);
    expect(JSON.stringify(profile)).not.toContain(settings.apiKey);
    expect(profile).toMatchObject({ configured: true, apiUrl: 'https://api.deepseek.com/v1', expiresAt: 1100 });
    expect(checkConnection).toHaveBeenCalledWith({ ...settings, baseUrl: settings.apiUrl });
    expect(s.getSettings('b').configured).toBe(false);
    expect(s.getCapabilities('a')).toMatchObject({ mode: 'deepseek', requiresConsent: true, dataSource: 'user-readonly' });
    expect(s.getCapabilities('b').mode).toBe('deepseek');
    clock = 1100;
    await expect(s.run('a', { message: '你好', scene: 'chat', consent: true, connectionId: profile.connectionId })).rejects.toMatchObject({ code: 'AI_CONNECTION_EXPIRED' });
    expect(s.getSettings('a').configured).toBe(false);
  });
  test('failed connection leaves previous Key untouched and no raw provider errors escape', async () => {
    const checkConnection = jest.fn().mockResolvedValueOnce().mockRejectedValueOnce(new AiError('连接失败', 502));
    const s = createTestService({ env, checkConnection });
    const first = await s.configure('a', settings);
    await expect(s.configure('a', { ...settings, apiKey: 'different-synthetic-key' })).rejects.toThrow('连接失败');
    expect(s.getSettings('a').connectionId).toBe(first.connectionId);
    s.clearSettings('a'); expect(s.getSettings('a').configured).toBe(false);
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
    const s = createTestService({ env: { ...env, NODE_ENV: 'production', AI_MODE: 'disabled', AI_SYNTHETIC_DATA: 'true' }, checkConnection });
    await expect(s.configure('a', settings)).rejects.toMatchObject({ code: 'AI_CONFIG_REQUIRED' });
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
