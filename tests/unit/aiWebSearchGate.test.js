// §3b 联网搜索授权门测试：用户开关（默认关/逐字节一致）、统一 key 派生、
// 会话级联网授权（每次调用必须落在有效授权下）、web-only 会话不得读数据。
const { getConfig } = require('../../src/modules/ai/service/config');
const { createDataGrantStore } = require('../../src/modules/ai/service/dataGrant');
const { createPreferenceStore } = require('../../src/modules/ai/service/preferences');
const { createEvalFixture } = require('../eval/offlineHarness');
const { AiError } = require('../../src/modules/ai/service/errors');

const baseEnv = { NODE_ENV: 'test', AI_MODE: 'deepseek', AI_DB_HOST: 'localhost', AI_DB_NAME: 'isolated',
  AI_DB_USER: 'fixture-readonly', AI_DB_PASSWORD: 'fixture-password' };
const deepseekEnv = { ...baseEnv, AI_BASE_URL: 'https://api.deepseek.com', AI_API_KEY: 'user-chat-key' };
const zhipuEnv = { ...baseEnv, AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4', AI_API_KEY: 'user-glm-key' };
const sensenovaEnv = { ...baseEnv, AI_BASE_URL: 'https://token.sensenova.cn/v1', AI_API_KEY: 'site-sky-key' };

describe('配置派生：统一 key + 用户门', () => {
  test('聊天源=DeepSeek + 用户开 → 复用聊天连接 key/base', () => {
    const config = getConfig({ ...deepseekEnv, AI_WEB_SEARCH_ENABLED: 'true' });
    expect(config.searchEnabled).toBe(true);
    expect(config.searchProvider).toBe('deepseek');
    expect(config.searchBaseUrl).toBe('https://api.deepseek.com');
    expect(config.searchApiKey).toBe('user-chat-key');
    expect(config.searchCapabilityReady).toBe(true);
  });

  test('聊天源=智谱 + 用户开 → 派生 zhipu + 默认 search_std', () => {
    const config = getConfig({ ...zhipuEnv, AI_WEB_SEARCH_ENABLED: 'true' });
    expect(config.searchEnabled).toBe(true);
    expect(config.searchProvider).toBe('zhipu');
    expect(config.searchEngine).toBe('search_std');
    expect(config.searchApiKey).toBe('user-glm-key');
  });

  test('用户关（默认）→ searchEnabled=false 且不携带搜索字段', () => {
    const config = getConfig({ ...deepseekEnv });
    expect(config.searchEnabled).toBeUndefined();
    expect(config.searchCapabilityReady).toBe(true);
    expect(config.searchApiKey).toBeUndefined();
  });

  test('聊天源=商汤 + 用户开 + 无槽位 → 能力不可得，搜索关闭', () => {
    const config = getConfig({ ...sensenovaEnv, AI_WEB_SEARCH_ENABLED: 'true' });
    expect(config.searchEnabled).toBeUndefined();
    expect(config.searchCapabilityReady).toBe(false);
  });

  test('商汤聊天 + 显式槽位 + 用户开 → 站点代配生效', () => {
    const config = getConfig({ ...sensenovaEnv, AI_WEB_SEARCH_ENABLED: 'true',
      AI_SEARCH_BASE_URL: 'https://api.deepseek.com', AI_SEARCH_API_KEY: 'site-search-key', AI_SEARCH_PROVIDER: 'deepseek' });
    expect(config.searchEnabled).toBe(true);
    expect(config.searchApiKey).toBe('site-search-key');
  });

  test('无效槽位启动即响（独立于用户门）', () => {
    expect(() => getConfig({ ...sensenovaEnv, AI_SEARCH_BASE_URL: 'http://example.com',
      AI_SEARCH_API_KEY: 'k', AI_SEARCH_PROVIDER: 'deepseek' })).toThrow(AiError);
    expect(() => getConfig({ ...deepseekEnv, AI_SEARCH_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      AI_SEARCH_API_KEY: 'k', AI_SEARCH_PROVIDER: 'zhipu', AI_SEARCH_ENGINE: 'bogus' })).toThrow(AiError);
  });
});

describe('§3b 用户偏好：双旗标', () => {
  test('set 三态合并且 getFlags 读取', async () => {
    const store = createPreferenceStore();
    await store.set('user-1', true);
    expect(store.getFlags('user-1')).toEqual({ thinking: true, webSearch: false });
    await store.set('user-1', undefined, true);
    expect(store.getFlags('user-1')).toEqual({ thinking: true, webSearch: true });
    await store.set('user-1', false, undefined);
    expect(store.getFlags('user-1')).toEqual({ thinking: false, webSearch: true });
    expect(store.get('user-1')).toBe(false);
  });

  test('带 executor 持久化双列', async () => {
    const rows = [];
    const executor = { execute: jest.fn(async (sql, params) => {
      if (sql.startsWith('SELECT')) return [rows];
      if (sql.startsWith('INSERT')) { rows.length = 0; rows.push({ user_id: params[0],
        thinking_enabled: params[1] ? 1 : 0, web_search_enabled: params[2] ? 1 : 0 }); return [{ affectedRows: 1 }]; }
      throw new Error('unexpected ' + sql.slice(0, 30));
    }) };
    const store = createPreferenceStore({ executor });
    await store.set('user-1', undefined, true);
    expect(rows[0].web_search_enabled).toBe(1);
    const reloaded = createPreferenceStore({ executor });
    await reloaded.warmup();
    expect(reloaded.getFlags('user-1')).toEqual({ thinking: false, webSearch: true });
  });
});

function grantExecutor(row) {
  let current = row;
  return { execute: jest.fn(async (sql, params = []) => {
    if (sql.startsWith('SELECT') && sql.includes('ai_data_grant')) return [[current].filter(Boolean)];
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation' }]];
    if (sql.startsWith('INSERT INTO ai_data_grant') || sql.startsWith('UPDATE ai_data_grant')) {
      current = { user_id: params[0], provider_host: params[1], domains: params[2],
        granted_at: params[3], revoked_at: params[4] ?? null };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('DELETE FROM ai_data_grant')) { current = null; return [{ affectedRows: 1 }]; }
    throw new Error('unexpected ' + sql.slice(0, 40));
  }) };
}
const v3GrantRow = stored => ({ user_id: 'owner', provider_host: 'token.sensenova.cn',
  domains: JSON.stringify(stored), granted_at: Date.now(), revoked_at: null });

describe('§3b 会话级联网授权（每次调用必须在有效授权下）', () => {
  test('web-only 会话：联网门通过、数据读取被拒', async () => {
    const store = createDataGrantStore({ executor: grantExecutor(v3GrantRow({
      version: 3, domains: [], sessions: [{ conversationId: '11111111-1111-4111-8111-111111111111',
        providerHost: 'token.sensenova.cn', webSearch: { grantedAt: Date.now(), expiresAt: Date.now() + 3600000 } }] })) });
    await expect(store.requireWebSearch('owner', '11111111-1111-4111-8111-111111111111', 'token.sensenova.cn')).resolves.toBeUndefined();
    await expect(store.requireCoverage('owner', ['finance'], 'token.sensenova.cn',
      { conversationId: '11111111-1111-4111-8111-111111111111', access: 'read' })).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  });

  test('host 不匹配 → 授权卡错误携带 access=web_search', async () => {
    const store = createDataGrantStore({ executor: grantExecutor(v3GrantRow({
      version: 3, domains: [], sessions: [{ conversationId: '11111111-1111-4111-8111-111111111111',
        providerHost: 'token.sensenova.cn', webSearch: { grantedAt: Date.now(), expiresAt: Date.now() + 3600000 } }] })) });
    await expect(store.requireWebSearch('owner', '11111111-1111-4111-8111-111111111111', 'api.deepseek.com'))
      .rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED',
        authorizationRequest: expect.objectContaining({ access: 'web_search', version: 1 }) });
  });

  test('过期子授权 → 拒绝', async () => {
    const store = createDataGrantStore({ executor: grantExecutor(v3GrantRow({
      version: 3, domains: [], sessions: [{ conversationId: '11111111-1111-4111-8111-111111111111',
        providerHost: 'token.sensenova.cn', webSearch: { grantedAt: Date.now() - 7200000, expiresAt: Date.now() - 3600000 } }] })) });
    await expect(store.requireWebSearch('owner', '11111111-1111-4111-8111-111111111111', 'token.sensenova.cn'))
      .rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  });

  test('PUT web_search 建立子授权；数据授权升级不丢失它', async () => {
    const executor = grantExecutor(null);
    const store = createDataGrantStore({ executor });
    const granted = await store.put('owner', { providerHost: 'token.sensenova.cn', conversationId: '11111111-1111-4111-8111-111111111111',
      lifetime: '24h', access: 'web_search' });
    expect(granted).toMatchObject({ granted: true, access: 'web_search', providerHost: 'token.sensenova.cn',
      lifetime: '24h', expiresAt: expect.any(Number) });
    await expect(store.requireWebSearch('owner', '11111111-1111-4111-8111-111111111111', 'token.sensenova.cn')).resolves.toBeUndefined();
    await store.put('owner', { providerHost: 'token.sensenova.cn', conversationId: '11111111-1111-4111-8111-111111111111',
      lifetime: '24h', access: 'read' });
    const grant = await store.get('owner', '11111111-1111-4111-8111-111111111111');
    expect(grant.access).toBe('read');
    expect(grant.webSearch).toBeTruthy();
    await expect(store.requireWebSearch('owner', '11111111-1111-4111-8111-111111111111', 'token.sensenova.cn')).resolves.toBeUndefined();
  });
});

describe('§3b 端到端：无授权的联网调用整轮带授权卡失败', () => {
  test('AI_GRANT_REQUIRED + authorizationRequest.access=web_search', async () => {
    const searchEnv = { ...deepseekEnv, AI_WEB_SEARCH_ENABLED: 'true' };
    const config = getConfig(searchEnv);
    const def = { message: '搜索公开发布的资讯', mode: 'chat', datasets: [],
      toolScript: [['web_search', { query: '公开发布' }]], final: { answer: '不应到达' } };
    const f = createEvalFixture(def, { config, grants: { requireCoverage: jest.fn(),
      requireWebSearch: jest.fn(async () => { throw Object.assign(new AiError('联网搜索为付费能力，需要你的授权后才能使用', 403, 'AI_GRANT_REQUIRED'),
        { authorizationRequest: { version: 1, conversationId: 'x', providerHost: 'token.sensenova.cn', access: 'web_search', reason: 'r', expiresAt: 1 } }); }) } });
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED',
      authorizationRequest: expect.objectContaining({ access: 'web_search' }) });
    expect(f.provider.mock.calls[0][2].some(item => item.function.name === 'web_search')).toBe(true);
  });
});
