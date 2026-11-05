jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Settings test must not open DB'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { createAiService } = require('../../src/modules/ai/service');
const { createSettingsStore, normalizeApiUrl } = require('../../src/modules/ai/service/settings');
const { checkDeepseekConnection } = require('../../src/modules/ai/service/deepseek');
const { AiError } = require('../../src/modules/ai/service/errors');
const env = { AI_MODE: 'mock', NODE_ENV: 'development', AI_SYNTHETIC_DATA: 'true', AI_ALLOW_SESSION_SETTINGS: 'true' };
const settings = { apiUrl: 'https://api.deepseek.com/v1', apiKey: 'synthetic-key-only', model: 'deepseek-flash' };
const call = { role: 'assistant', content: null, tool_calls: [{ id: 'test_call', type: 'function', function: {
  name: 'query_finance_summary', arguments: JSON.stringify({ startDate: '2026-11-01', endDate: '2026-11-05' }) } }] };
describe('temporary DeepSeek settings', () => {
  test.each(['http://api.deepseek.com', 'https://localhost', 'https://127.0.0.1', 'https://api.deepseek.com.evil.test',
    'https://evil.test@api.deepseek.com', 'https://api.deepseek.com:444', 'https://api.deepseek.com/?key=secret',
    'https://api.deepseek.com/other', 'file:///etc/passwd'])('reject non-allowlisted endpoint %s before sending Key', async apiUrl => {
    const checkConnection = jest.fn();
    const s = createAiService({ env, checkConnection });
    await expect(s.configure('a', { ...settings, apiUrl })).rejects.toThrow();
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('official URL variants normalize to fixed destination', () => {
    for (const url of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/chat/completions']) {
      expect(normalizeApiUrl(url)).toBe('https://api.deepseek.com');
    }
  });
  test('settings stay disabled without operator opt-in and reject extra fields', async () => {
    const checkConnection = jest.fn();
    await expect(createAiService({ env: { AI_MODE: 'mock' }, checkConnection }).configure('a', settings)).rejects.toMatchObject({ code: 'AI_SETTINGS_DISABLED' });
    const s = createAiService({ env, checkConnection });
    for (const extra of [{ userId: 'b' }, { messages: [] }, { db: {} }]) await expect(s.configure('a', { ...settings, ...extra })).rejects.toThrow();
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('Key is only used for its owner, never returned, expired connection cannot silently become mock', async () => {
    let clock = 1000;
    const settingsStore = createSettingsStore({ now: () => clock, ttl: 100 });
    const checkConnection = jest.fn().mockResolvedValue();
    const s = createAiService({ env, checkConnection, settingsStore });
    const profile = await s.configure('a', settings);
    expect(JSON.stringify(profile)).not.toContain(settings.apiKey);
    expect(profile).toMatchObject({ configured: true, apiUrl: 'https://api.deepseek.com', expiresAt: 1100 });
    expect(s.getSettings('b').configured).toBe(false);
    expect(s.getCapabilities('a')).toMatchObject({ mode: 'deepseek', requiresConsent: true, dataSource: 'synthetic' });
    expect(s.getCapabilities('b').mode).toBe('mock');
    clock = 1100;
    await expect(s.run('a', { message: '你好', scene: 'chat', consent: true, connectionId: profile.connectionId })).rejects.toMatchObject({ code: 'AI_CONNECTION_EXPIRED' });
    expect(s.getSettings('a').configured).toBe(false);
  });
  test('failed connection leaves previous Key untouched and no raw provider errors escape', async () => {
    const checkConnection = jest.fn().mockResolvedValueOnce().mockRejectedValueOnce(new AiError('连接失败', 502));
    const s = createAiService({ env, checkConnection });
    const first = await s.configure('a', settings);
    await expect(s.configure('a', { ...settings, apiKey: 'different-synthetic-key' })).rejects.toThrow('连接失败');
    expect(s.getSettings('a').connectionId).toBe(first.connectionId);
    s.clearSettings('a'); expect(s.getSettings('a').configured).toBe(false);
  });
  test('real provider and tool loop use synthetic repository without connecting to MySQL', async () => {
    axios.post.mockResolvedValueOnce({ data: { choices: [{ finish_reason: 'tool_calls', message: call }] } })
      .mockResolvedValueOnce({ data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '测试收支已返回' } }] } });
    const s = createAiService({ env, checkConnection: async () => {}, now: () => new Date('2026-11-05T00:00:00Z') });
    const profile = await s.configure('a', settings);
    await expect(s.run('a', { message: '本月收支', scene: 'chat', consent: false, connectionId: profile.connectionId })).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(axios.post).not.toHaveBeenCalled();
    const result = await s.run('a', { message: '本月收支', scene: 'chat', consent: true, connectionId: profile.connectionId });
    expect(result).toMatchObject({ mode: 'deepseek', source: 'synthetic', formalWriteEnabled: false });
    expect(result.trace[0].result.expense).toBe('632.00');
    expect(axios.post.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe(`Bearer ${settings.apiKey}`);
    expect(axios.post.mock.calls[0][1].messages.some(message => message.content?.includes(settings.apiKey))).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
  test('production cannot bypass real read-only database setup via synthetic option', async () => {
    const checkConnection = jest.fn();
    const s = createAiService({ env: { ...env, NODE_ENV: 'production', AI_MODE: 'disabled' }, checkConnection });
    await expect(s.configure('a', settings)).rejects.toMatchObject({ code: 'AI_CONFIG_REQUIRED' });
    expect(checkConnection).not.toHaveBeenCalled();
  });
  test('connection check uses fixed models endpoint and sanitizes credentials on failure', async () => {
    axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'deepseek-flash' }] } });
    await checkDeepseekConnection(settings);
    expect(axios.get.mock.calls[0][0]).toBe('https://api.deepseek.com/models');
    axios.get.mockRejectedValueOnce({ response: { status: 401, data: { message: settings.apiKey } } });
    try { await checkDeepseekConnection(settings); } catch (error) {
      expect(error.code).toBe('AI_KEY_INVALID'); expect(error.message).not.toContain(settings.apiKey);
    }
  });
});
