jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('No public database'); }),
  getConnection: jest.fn(() => { throw new Error('No public database'); }) }));
const crypto = require('crypto');
const { createEgressPolicy } = require('../../src/modules/ai/service/egressPolicy');

test('legacy private-text budget redacts complete credentials and identifiers before slicing', () => {
  const secret = 'credentialBoundaryLongSecret0123456789', internalId = 'internalIdentityBoundary0123456789';
  const egress = createEgressPolicy({ extraSecrets: [secret], knownIds: [internalId] });
  expect(egress.scrub('文'.repeat(11996) + secret)).not.toContain('cred');
  expect(egress.scrub('文'.repeat(11996) + internalId)).not.toContain('inte');
});
const { createLegacyTestService: createTestService, createTestRepository, createMemoryDraftStore, createMemoryConversationStore, call } = require('../helpers/aiFixture');

test('recursive egress removes identities/credentials/URLs and returns only current opaque identifiers', () => {
  const policy = createEgressPolicy({ userId: 'private-owner' });
  const projected = policy.project({ userId: 'private-owner', password: 'private-secret', choices: {
    categories: [{ id: 'real-category', name: '餐饮' }], accounts: [{ id: 'real-card', name: '储蓄卡', card_bin: '123456' }] },
    rows: [{ amount: '9999999999.99', remark: '电话13812345678 https://private.test/x user@example.com', cardId: 'real-card' }] });
  expect(projected.choices.accounts[0].id).toMatch(/^r_[0-9a-f]{32}$/);
  expect(projected.rows[0].cardId).toBe(projected.choices.accounts[0].id);
  expect(JSON.stringify(projected)).not.toMatch(/private-owner|private-secret|real-card|real-category|13812345678|private.test|user@example|card_bin/);
  const outbound = policy.messages([{ role: 'tool', tool_call_id: 'protocol-call', content: JSON.stringify(projected) }]);
  expect(JSON.parse(outbound[0].content).rows[0].amount).toBe('9999999999.99');
  expect(policy.decodeArguments('propose_transaction', { accountId: projected.choices.accounts[0].id,
    categoryId: projected.choices.categories[0].id })).toEqual({ accountId: 'real-card', categoryId: 'real-category' });
  expect(() => policy.decodeArguments('propose_transaction', { accountId: 'real-card' })).toThrow();
  expect(() => policy.decodeArguments('propose_transaction', { accountId: projected.choices.categories[0].id })).toThrow();
  const next = createEgressPolicy({ userId: 'private-owner' });
  expect(() => next.decodeArguments('propose_transaction', { accountId: projected.choices.accounts[0].id })).toThrow();
});

test('refs containing long numeric runs are never damaged by numeric redaction', () => {
  jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('12345678901234567890abcdefabcdef', 'hex'));
  try {
    const policy = createEgressPolicy({ userId: 'owner' });
    const value = policy.project({ accounts: [{ id: 'owned-card', name: '账户' }] });
    const wire = policy.messages([{ role: 'tool', content: JSON.stringify(value) }])[0].content;
    expect(JSON.parse(wire).accounts[0].id).toBe(value.accounts[0].id);
    expect(policy.decodeArguments('propose_transaction', { accountId: JSON.parse(wire).accounts[0].id })).toEqual({ accountId: 'owned-card' });
  } finally { jest.restoreAllMocks(); }
});

test('only explicitly allowed preview refs survive one scrub without becoming locally resolvable or persistent', () => {
  const trusted = 'r_' + '1'.repeat(32), unknown = 'r_' + 'f'.repeat(32);
  const owner = 'private-owner', uuid = '12345678-1234-1234-1234-123456789abc';
  const policy = createEgressPolicy({ userId: owner });
  const value = JSON.stringify({ accountRef: trusted, categoryRef: unknown, remark: `${owner} ${uuid} ${trusted.toUpperCase()}`, amount: '9999999999.99' });
  const scrubbed = JSON.parse(policy.scrub(value, [trusted, owner, uuid]));
  expect(scrubbed.accountRef).toBe(trusted); expect(scrubbed.categoryRef).toBe('[历史标识]');
  expect(scrubbed.remark).not.toMatch(/private-owner|12345678-1234|R_/); expect(scrubbed.amount).toBe('9999999999.99');
  expect(policy.scrub(trusted)).toBe('[历史标识]');
  expect(() => policy.decodeArguments('propose_transaction', { accountId: trusted })).toThrow();
});

test('an allowed ref-shaped value is still removed when it is also a configured credential', () => {
  const credential = 'r_' + '2'.repeat(32);
  const policy = createEgressPolicy({ userId: 'private-owner', extraSecrets: [credential] });
  expect(policy.scrub(JSON.stringify({ accountRef: credential }), [credential])).not.toContain(credential);
});

test('free-text egress preserves public Markdown, URLs, email, numbers, unknown UUIDs and whitespace exactly', () => {
  const policy = createEgressPolicy({ userId: 'private-owner' });
  const value = '# Public notes\n\n[Documentation](https://example.org/docs?q=20261111125714)\n' +
    'Contact: reader@example.org\nUUID: 12345678-1234-4234-8234-123456789abc\n' +
    'Number: 1234567890123456789012345678901234567890\n\n```js\n  const amount = 12345678901234567890;\n\treturn amount;\n```\n';
  expect(policy.scrubText(value)).toBe(value);
});

test('free-text egress redacts the entire configured secret across 12K before any caller length limit', () => {
  const secret = 'complete-boundary-provider-secret';
  const prefix = 'x'.repeat(11991), suffix = '\n  retained tail\n' + 'z'.repeat(14000);
  const policy = createEgressPolicy({ extraSecrets: [secret] });
  const result = policy.scrubText(prefix + secret + suffix);
  expect(result).toBe(prefix + '[redacted]' + suffix);
  expect(result.length).toBeGreaterThan(24000);
  expect(result).not.toContain(secret.slice(0, 9));
  expect(result).not.toContain(secret.slice(9));
});

test('free-text egress still hides configured credentials and known internal IDs while preserving unrelated public content', () => {
  const knownId = '11223344-1234-4234-8234-123456789abc', publicId = 'abcdef12-1234-4234-8234-123456789abc';
  const credentialRef = 'r_' + '2'.repeat(32);
  const policy = createEgressPolicy({ userId: 'private-owner', knownIds: [knownId],
    extraSecrets: ['configured-provider-key', credentialRef] });
  policy.project({ accounts: [{ id: 'actual-card-id' }] });
  const value = `private-owner ${knownId} actual-card-id configured-provider-key ${credentialRef}\n` +
    `Bearer session-credential api_key=inline-credential sk-provider-abcdef\n${publicId} https://example.org reader@example.org`;
  expect(policy.scrubText(value, [credentialRef])).toBe('[内部标识] [内部标识] [内部标识] [redacted] [redacted]\n' +
    `Bearer [redacted] api_key=[redacted] [redacted]\n${publicId} https://example.org reader@example.org`);
});

test('free-text current refs remain resolvable but temporary and unknown refs never gain a mapping', () => {
  const policy = createEgressPolicy({ userId: 'private-owner' });
  const current = policy.project({ accounts: [{ id: 'owned-card' }] }).accounts[0].id;
  const allowed = 'r_' + '1'.repeat(32), unknown = 'r_' + 'f'.repeat(32);
  expect(policy.scrubText(`${current} ${allowed} ${unknown} ${current.toUpperCase()}`, [allowed])).toBe(
    `${current} ${allowed} [历史标识] [历史标识]`);
  expect(policy.decodeArguments('propose_transaction', { accountId: current })).toEqual({ accountId: 'owned-card' });
  expect(() => policy.decodeArguments('propose_transaction', { accountId: allowed })).toThrow();
  expect(() => policy.decodeArguments('propose_transaction', { accountId: unknown })).toThrow();
  expect(policy.scrubText(allowed)).toBe('[历史标识]');
});

test('legacy real-chat selects refs and reconstructs IDs only for the local draft executor', async () => {
  const repository = createTestRepository(), sent = [];
  const chat = async messages => {
    sent.push(structuredClone(messages));
    const last = messages.at(-1);
    if (last.role !== 'tool') return call('list_record_choices', {});
    const result = JSON.parse(last.content);
    if (!result.accounts) return { role: 'assistant', content: '请在卡片上核对。' };
    return call('propose_transaction', { direction: 0, amount: '39.91', currency: 'CNY', transDate: '2026-11-05',
      categoryId: result.categories[0].id, accountId: result.accounts[0].id, payMethod: '支付宝', remark: '午饭' });
  };
  const service = createTestService({ repository, chat });
  const result = await service.run('owner-private', { scene: 'chat', message: '余额账户午饭39.91元', consent: true });
  expect(result.draft).toMatchObject({ accountId: 'fixture_balance', categoryId: 'fixture_food', amount: '39.91' });
  expect(JSON.stringify(sent)).not.toMatch(/owner-private|fixture_balance|fixture_food|fixture_cash|fixture_salary/);
  expect(sent).toHaveLength(3);
  await service.close();
});

test('a model returning a guessed real ID fails before any draft or history write', async () => {
  const store = createMemoryDraftStore(), conversationStore = createMemoryConversationStore();
  store.save = jest.fn(store.save); conversationStore.append = jest.fn(conversationStore.append);
  const service = createTestService({ draftStore: store, conversationStore, chat: async () => call('propose_transaction', {
    direction: 0, amount: '10', currency: 'CNY', transDate: '2026-11-05', categoryId: 'fixture_food', accountId: 'fixture_balance',
    payMethod: '支付宝', remark: '' }) });
  await expect(service.run('owner', { scene: 'chat', message: '余额账户午饭10元', consent: true })).rejects.toMatchObject({ code: 'AI_REF_INVALID' });
  expect(store.save).not.toHaveBeenCalled(); expect(conversationStore.append).not.toHaveBeenCalled();
  await service.close();
});
