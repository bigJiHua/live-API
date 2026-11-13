const { createDataGrantStore } = require('../../src/modules/ai/service/dataGrant');
const { AiError } = require('../../src/modules/ai/service/errors');

// D-027：白名单存储与预览门控。executor 用内存表模拟 ai_data_grant 单行 upsert。
function memoryExecutor() {
  let row = null; // 库中尚无行 = 从未授权
  return {
    get current() { return row; },
    execute: jest.fn(async (sql, args) => {
      if (/INSERT INTO ai_data_grant/.test(sql)) {
        row = { user_id: 'owner', provider_host: args[1], domains: args[2], granted_at: args[3], revoked_at: null };
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE ai_data_grant SET revoked_at/.test(sql)) { if (row) row.revoked_at = args[0]; return [{ affectedRows: row ? 1 : 0 }]; }
      if (/SELECT provider_host/.test(sql)) return [row ? [{ ...row }] : []];
      throw new Error('unexpected sql: ' + sql);
    }),
  };
}

describe('ai_data_grant store', () => {
  test('put persists the whitelist and get presents it bound to the provider host', async () => {
    const executor = memoryExecutor();
    const store = createDataGrantStore({ executor, now: () => 1730000000000 });
    expect(await store.get('owner')).toEqual({ contractVersion: 1, granted: false, providerHost: null, domains: [], grantedAt: null });
    const saved = await store.put('owner', { providerHost: 'token.sensenova.cn', domains: ['finance', 'account'] });
    expect(saved).toEqual({ contractVersion: 1, granted: true, providerHost: 'token.sensenova.cn', domains: ['finance', 'account'], grantedAt: 1730000000000 });
    expect(await store.get('owner')).toMatchObject({ granted: true, providerHost: 'token.sensenova.cn', domains: ['finance', 'account'] });
  });

  test('invalid host or domain list is rejected without touching storage', async () => {
    const executor = memoryExecutor();
    const store = createDataGrantStore({ executor });
    for (const input of [{ providerHost: '', domains: ['finance'] }, { providerHost: 'http://evil', domains: ['finance'] },
      { providerHost: 'ok.host', domains: [] }, { providerHost: 'ok.host', domains: ['not-a-domain'] },
      { providerHost: 'ok.host', domains: ['finance', 'finance'] }]) {
      await expect(store.put('owner', input)).rejects.toMatchObject({ code: 'AI_GRANT_INVALID' });
    }
    expect(executor.execute).not.toHaveBeenCalled();
  });

  test('revoke keeps the row as audit evidence and get reports ungranted', async () => {
    const executor = memoryExecutor();
    const store = createDataGrantStore({ executor });
    await store.put('owner', { providerHost: 'ok.host', domains: ['finance'] });
    await store.revoke('owner');
    expect(await store.get('owner')).toEqual({ contractVersion: 1, granted: false, providerHost: null, domains: [], grantedAt: null });
    await expect(store.revoke('owner')).resolves.toMatchObject({ granted: false });
    await store.put('owner', { providerHost: 'ok.host', domains: ['todo'] });
    expect(await store.get('owner')).toMatchObject({ granted: true, domains: ['todo'] }, 're-grant clears revocation');
  });

  test('session grants and domain grants coexist without clearing each other', async () => {
    const executor = memoryExecutor();
    const store = createDataGrantStore({ executor, now: () => 1730000000000 });
    executor.execute.mockImplementation(async (sql, args) => {
      const conversation = /FROM ai_conversation/.test(sql);
      if (conversation) return [[{ id: args[0] }]];
      if (/INSERT INTO ai_data_grant/.test(sql)) {
        executor.row = { user_id: 'owner', provider_host: args[1], domains: args[2], granted_at: args[3], revoked_at: null };
        return [{ affectedRows: 1 }];
      }
      if (/SELECT provider_host/.test(sql)) return [executor.row ? [{ ...executor.row }] : []];
      throw new Error('unexpected sql: ' + sql);
    });
    await store.put('owner', { providerHost: 'ok.host', domains: ['finance'] });
    const session = await store.put('owner', { providerHost: 'ok.host', conversationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      lifetime: '1h', access: 'read' });
    expect(session.granted).toBe(true);
    expect(await store.get('owner')).toMatchObject({ granted: true, domains: ['finance'] });
    expect(await store.get('owner', '0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({ granted: true });
    await store.revoke('owner');
    expect(await store.get('owner')).toMatchObject({ granted: false });
    expect(await store.get('owner', '0f8fad5b-d9cb-469f-a165-70867728950e')).toMatchObject({ granted: true },
      'revoking the domain whitelist keeps the session grant');
  });
});

describe('preview grant coverage gate', () => {
  const makeError = (code, missing) => Object.assign(new AiError('gate', 403, code), missing ? { missingDomains: missing } : {});

  test('empty-domain requests never consult the grant', async () => {
    const requireCoverage = jest.fn();
    const store = createDataGrantStore({ executor: memoryExecutor() });
    await store.requireCoverage('owner', [], 'any.host');
    expect(requireCoverage).not.toHaveBeenCalled();
  });

  test('missing grant, host change and out-of-whitelist domains are rejected with actionable codes', async () => {
    const executor = memoryExecutor();
    const store = createDataGrantStore({ executor });
    await expect(store.requireCoverage('owner', ['finance'], 'any.host')).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
    await store.put('owner', { providerHost: 'token.sensenova.cn', domains: ['finance'] });
    await expect(store.requireCoverage('owner', ['finance'], 'api.deepseek.com')).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
    await expect(store.requireCoverage('owner', ['finance', 'card'], 'token.sensenova.cn')).rejects.toMatchObject({
      code: 'AI_DOMAIN_NOT_GRANTED', missingDomains: ['card'],
    });
    await expect(store.requireCoverage('owner', ['finance'], 'token.sensenova.cn')).resolves.toBeUndefined();
  });

  test('transaction boundary checks and locks the owner grant through the provided connection', async () => {
    const executor = memoryExecutor(), connection = memoryExecutor();
    const store = createDataGrantStore({ executor });
    const transactionalStore = createDataGrantStore({ executor: connection });
    await transactionalStore.put('owner', { providerHost: 'token.sensenova.cn', domains: ['finance'] });
    connection.execute.mockClear();
    await expect(store.requireCoverage('owner', ['finance'], 'token.sensenova.cn', { executor: connection, lock: true })).resolves.toBeUndefined();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(connection.execute).toHaveBeenCalledWith(expect.stringMatching(/WHERE user_id = \? LIMIT 1 FOR UPDATE$/), ['owner']);
    await transactionalStore.revoke('owner');
    await expect(store.requireCoverage('owner', ['finance'], 'token.sensenova.cn', { executor: connection, lock: true }))
      .rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  });

  test('business preview propagates the gate error with the missing domains attached', async () => {
    const crypto = require('crypto');
    const { createLegacyBusinessService: createBusinessService } = require('../helpers/legacyBusinessService');
    const id = () => crypto.randomUUID();
    const config = { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://token.sensenova.cn/v1', model: 'm', apiKey: 'k' };
    const state = { config, connectionId: null, businessPolicy: { enabled: true, domains: ['finance', 'card', 'todo'] },
      conversationStore: { open: jest.fn(async () => ({ id: id(), history: [] })), session: jest.fn(), append: jest.fn() },
      requestGuard: { run: async (userId, request, work) => work({ check() {}, invoke: async fn => fn() }) } };
    const legacy = { getRuntime: () => state, financialPreflight: jest.fn() };
    const grants = { requireCoverage: jest.fn(async (userId, domains) => {
      const missing = domains.filter(domain => domain !== 'finance');
      if (missing.length) throw makeError('AI_DOMAIN_NOT_GRANTED', missing);
    }) };
    const service = createBusinessService({ legacyService: legacy, grants, repository: { query: async () => ({}) }, provider: jest.fn() });
    await expect(service.preview('owner', { message: '看看信用卡账单', scope: { domains: ['finance', 'card'] } }))
      .rejects.toMatchObject({ code: 'AI_DOMAIN_NOT_GRANTED', missingDomains: ['card'] });
    expect(grants.requireCoverage).toHaveBeenCalledWith('owner', ['finance', 'card'], 'token.sensenova.cn');
  });
});
