jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { createDataGrantStore, DOMAIN_LABELS } = require('../../src/modules/ai/service/dataGrant');
const crypto = require('crypto');
const first = crypto.randomUUID(), second = crypto.randomUUID();
function setup() {
  let stamp = 1000000, row = null;
  const executor = { execute: jest.fn(async (sql, args) => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [args[1] === 'owner' && [first, second].includes(args[0]) ? [{ id: args[0] }] : []];
    if (sql.startsWith('SELECT provider_host')) return [row ? [{ ...row }] : []];
    if (sql.startsWith('INSERT INTO ai_data_grant')) { row = { provider_host: args[1], domains: args[2], granted_at: args[3], revoked_at: null }; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE ai_data_grant SET domains')) { if (row) row.domains = args[0]; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE ai_data_grant SET revoked_at')) { if (row) row.revoked_at = args[0]; return [{ affectedRows: 1 }]; }
    throw new Error('Unexpected SQL');
  }) };
  const store = createDataGrantStore({ executor, now: () => stamp });
  const grant = (conversationId = first, extra = {}) => store.put('owner', { providerHost: 'provider.test', conversationId, access: 'read', lifetime: 'conversation', ...extra });
  const check = (conversationId = first, host = 'provider.test', access = 'read', domains = ['finance']) => store.requireCoverage('owner', domains, host, { conversationId, access });
  return { store, executor, grant, check, advance: ms => { stamp += ms; } };
}
test('one conversation grant covers all business data, survives store reload and keeps conversations independent', async () => {
  const f = setup();
  await expect(f.check()).rejects.toMatchObject({ authorizationRequest: { access: 'read', conversationId: first } });
  const saved = await f.grant(); expect(saved.domains).toEqual(Object.keys(DOMAIN_LABELS)); expect(saved.expiresAt).toBeNull();
  await expect(f.check(first, 'provider.test', 'read', Object.keys(DOMAIN_LABELS))).resolves.toBeUndefined();
  await expect(f.check(second)).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  await f.grant(second);
  const reloaded = createDataGrantStore({ executor: f.executor, now: () => 1000000 });
  expect((await reloaded.get('owner', first)).granted).toBe(true);
  expect((await reloaded.get('owner', second)).granted).toBe(true);
  await f.store.revoke('owner', first);
  await expect(f.check()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  await expect(f.check(second)).resolves.toBeUndefined();
});
test('timed authorization expires exactly at the deadline and provider changes require consent', async () => {
  const f = setup(); await f.grant(first, { lifetime: '15m' });
  f.advance(899999); await expect(f.check()).resolves.toBeUndefined();
  f.advance(1); await expect(f.check()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  await f.grant(); await expect(f.check(first, 'another.test')).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
});
test('read grants cannot prepare operations; an operate grant covers reads and operations', async () => {
  const f = setup(); await f.grant();
  await expect(f.check(first, 'provider.test', 'operate')).rejects.toMatchObject({ authorizationRequest: { access: 'operate' } });
  await f.grant(first, { access: 'operate' });
  await expect(f.check()).resolves.toBeUndefined(); await expect(f.check(first, 'provider.test', 'operate')).resolves.toBeUndefined();
});
test('grants reject foreign conversations, invalid lifetimes and client-controlled data ranges', async () => {
  const f = setup();
  await expect(f.grant(crypto.randomUUID())).rejects.toMatchObject({ code: 'AI_CONVERSATION_EXPIRED' });
  for (const extra of [{ lifetime: 'forever' }, { access: 'admin' }, { domains: ['finance'] }])
    await expect(f.grant(first, extra)).rejects.toMatchObject({ code: 'AI_GRANT_INVALID' });
  expect((await f.store.get('owner', first)).granted).toBe(false);
});
