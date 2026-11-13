jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Boundary test must not open a database'); }),
  getConnection: jest.fn(() => { throw new Error('Boundary test must not open a database'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Boundary test must not open a database'); }) }));
jest.mock('axios', () => ({ get: jest.fn(() => { throw new Error('Unexpected provider call'); }),
  post: jest.fn(() => { throw new Error('Unexpected provider call'); }) }));
const { executeTool, getTools } = require('../../src/modules/ai/service/tools');
const { validateTool, todayShanghai } = require('../../src/modules/ai/service/validation');
const { getConfig, capabilities } = require('../../src/modules/ai/service/config');
const { createLegacyTestService: createTestService, createTestRepository, call, testEnv } = require('../helpers/aiFixture');
const db = require('../../src/common/config/db');

afterAll(() => {
  expect(db.execute).not.toHaveBeenCalled();
  expect(db.getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
  expect(require('axios').post).not.toHaveBeenCalled();
});

const today = '2026-11-05';
const range = { startDate: '2026-11-01', endDate: today };
const input = { message: '昨天午饭花了32元，使用余额账户，支付宝付款', scene: 'draft', consent: true };
const proposal = { direction: 0, amount: '32.00', currency: 'CNY', transDate: today,
  categoryId: 'fixture_food', accountId: 'fixture_balance', payMethod: '支付宝', remark: '午饭' };
const context = () => ({ scene: 'draft', userId: 'user_a', today, repository: createTestRepository() });
const service = options => createTestService(options);

describe('AI boundary: model output never grants authority', () => {
  test('default disabled; runtime mock or synthetic data and incomplete real config fail closed', () => {
    expect(capabilities({}).enabled).toBe(false);
    for (const NODE_ENV of [undefined, 'development', 'production']) {
      expect(() => getConfig({ AI_MODE: 'mock', NODE_ENV })).toThrow();
      expect(() => getConfig(testEnv({ NODE_ENV, AI_SYNTHETIC_DATA: 'true' }))).toThrow();
    }
    expect(getConfig({ AI_MODE: 'mock', NODE_ENV: 'test' }).dataSource).toBe('synthetic');
    expect(() => getConfig({ AI_MODE: 'deepseek', DEEPSEEK_API_KEY: 'test' })).toThrow();
  });
  test('reject root DB identity even with other real config present', () => {
    expect(() => getConfig({ AI_MODE: 'deepseek', DEEPSEEK_API_KEY: 'test', AI_DB_HOST: 'host',
      AI_DB_NAME: 'test', AI_DB_USER: 'root', AI_DB_PASSWORD: 'test' })).toThrow();
  });
  test('Shanghai date ignores machine timezone', () => {
    expect(todayShanghai(new Date('2026-11-04T17:00:00Z'))).toBe(today);
  });
  test.each(['userId', 'sql', 'url', 'is_deleted', 'transferGroupId'])('reject additional model field %s', field => {
    expect(() => validateTool('query_finance_summary', { ...range, [field]: 'injected' }, today)).toThrow();
  });
  test.each(['not-a-date', '2026-02-30', '2025-02-29', '2026-1-01'])('reject invalid date %s', date => {
    expect(() => validateTool('query_finance_summary', { ...range, startDate: date }, today)).toThrow();
  });
  test('accept real leap day and reject future, reversed or excessive ranges', () => {
    expect(validateTool('query_finance_summary', { startDate: '2024-02-29', endDate: '2024-03-01' }, today)).toBeDefined();
    for (const dates of [{ startDate: today, endDate: '2026-11-06' },
      { startDate: today, endDate: '2026-11-01' }, { startDate: '2026-01-01', endDate: today }]) {
      expect(() => validateTool('query_finance_summary', dates, today)).toThrow();
    }
  });
  test.each([0, -1, 21, 1.5, '20'])('reject invalid record limit %s', limit => {
    expect(() => validateTool('query_transactions', { ...range, limit }, today)).toThrow();
  });
  test.each(['0', '-1', 'NaN', '1e6', '0.00001'])('reject invalid amount %s', amount => {
    expect(() => validateTool('propose_transaction', { ...proposal, amount }, today)).toThrow();
  });
  test('reject model identities and business flags in proposals', () => {
    expect(() => validateTool('propose_transaction', { ...proposal, userId: 'other' }, today)).toThrow();
    expect(() => validateTool('propose_transaction', { ...proposal, payType: '还款' }, today)).toThrow();
  });
  test.each(['execute_sql', 'createDebitAccount', 'commit_transaction', '__proto__'])('deny unregistered or writable tool %s', async name => {
    await expect(executeTool(context(), name, {})).rejects.toMatchObject({ code: 'AI_TOOL_DENIED' });
  });
  test('query scene cannot propose writes; no confirm tool is advertised', async () => {
    await expect(executeTool({ ...context(), scene: 'query' }, 'propose_transaction', proposal)).rejects.toThrow();
    expect(getTools('draft').map(item => item.function.name)).toEqual(['list_record_choices', 'propose_transaction']);
  });
  test('execution identity comes from the server; user parameters are not accepted', async () => {
    const repository = { summary: jest.fn().mockResolvedValue({ count: 0 }) };
    await executeTool({ ...context(), scene: 'query', repository }, 'query_finance_summary', range);
    expect(repository.summary).toHaveBeenCalledWith('user_a', range);
  });
  test('deny nonexistent or other-user accounts and mismatched categories', async () => {
    await expect(executeTool(context(), 'propose_transaction', { ...proposal, accountId: 'other_user_card' })).rejects.toThrow();
    await expect(executeTool(context(), 'propose_transaction', { ...proposal, categoryId: 'fixture_salary' })).rejects.toThrow();
  });
  test('ambiguous choices stay null instead of defaulting to a real account', async () => {
    const draft = await executeTool(context(), 'propose_transaction', { ...proposal, accountId: null, categoryId: null, payMethod: null });
    expect(draft.missingFields).toEqual(['分类', '账户', '支付方式']);
    expect(draft.formalWriteEnabled).toBe(false);
  });
  test('injected tool loop creates an isolated proposal without opening a database', async () => {
    const s = service();
    const result = await s.run('user_a', input);
    expect(result.draft.amount).toBe('32');
    expect(result.draft.transDate).toBe('2026-11-04');
    expect(result.source).toBe('user-readonly');
    expect(result.mode).toBe('deepseek');
    expect(result.formalWriteEnabled).toBe(false);
    expect((await s.getDraft('user_a', result.draft.id)).amount).toBe('32');
    await expect(s.getDraft('user_b', result.draft.id)).rejects.toMatchObject({ status: 404 });
  });
  test('failed tool sequence does not save partial drafts', async () => {
    const store = { save: jest.fn(), get: jest.fn() };
    const chat = jest.fn().mockResolvedValueOnce(call('propose_transaction', { ...proposal, accountId: null, categoryId: null })).mockResolvedValueOnce(call('commit_transaction', {}));
    await expect(service({ chat, draftStore: store }).run('a', input)).rejects.toThrow();
    expect(store.save).not.toHaveBeenCalled();
  });
  test('model repeated proposal rejected; no repeated formal writes exist', async () => {
    const store = { save: jest.fn(), get: jest.fn() };
    const chat = jest.fn(async messages => {
      if (messages.at(-1).role !== 'tool') return call('list_record_choices', {});
      const choices = JSON.parse(messages.at(-1).content), fields = { ...proposal, transDate: '2026-11-04',
        accountId: choices.accounts[0].id, categoryId: choices.categories[0].id };
      return { role: 'assistant', content: null, tool_calls: [call('propose_transaction', fields).tool_calls[0], call('propose_transaction', fields).tool_calls[0]] };
    });
    await expect(service({ chat, draftStore: store }).run('a', input)).rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
    expect(chat).toHaveBeenCalledTimes(2); expect(store.save).not.toHaveBeenCalled();
  });
  test('repeated query loop is stopped within bounded model calls', async () => {
    const chat = jest.fn().mockResolvedValue(call('query_finance_summary', range));
    await expect(service({ chat }).run('a', { ...input, message: '查询本月收支', scene: 'query' })).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED' });
    expect(chat).toHaveBeenCalledTimes(2);
  });
  test('malformed JSON and malformed tool list fail before accessing repository', async () => {
    const repository = { choices: createTestRepository().choices, summary: jest.fn() };
    const bad = call('query_finance_summary', range);
    bad.tool_calls[0].function.arguments = '{invalid';
    await expect(service({ repository, chat: async () => bad }).run('a', { ...input, message: '查询本月收支', scene: 'query' })).rejects.toMatchObject({ code: 'AI_INVALID_INPUT' });
    expect(repository.summary).not.toHaveBeenCalled();
  });
  test('client cannot supply model history, identity, or a consent string', async () => {
    for (const extra of [{ userId: 'b' }, { messages: [] }, { history: [] }, { consent: 'true' }]) {
      await expect(service().run('a', { ...input, ...extra })).rejects.toThrow();
    }
  });
  test('real calls require explicit consent before provider or repository access', async () => {
    const chat = jest.fn();
    const repository = { choices: jest.fn(), summary: jest.fn() };
    const s = service({ chat, repository });
    await expect(s.run('a', { ...input, consent: false })).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(chat).not.toHaveBeenCalled();
    expect(repository.choices).not.toHaveBeenCalled();
    expect(repository.summary).not.toHaveBeenCalled();
  });
});

describe('continuous chat and interactive draft isolation', () => {
  const chatInput = { ...input, scene: 'chat' };
  test('chat chooses query or draft without separate user modes', async () => {
    const s = service();
    const greeting = await s.run('a', { ...chatInput, message: '你好' });
    expect(greeting.trace).toEqual([]);
    const result = await s.run('a', { ...chatInput, conversationId: greeting.conversationId });
    expect(result.conversationId).toBe(greeting.conversationId);
    expect(result.draft.amount).toBe('32');
    const query = await s.run('a', { ...chatInput, conversationId: result.conversationId, message: '查看本月明细' });
    expect(query.trace[0].tool).toBe('query_transactions');
    expect(getTools('chat')).toHaveLength(4);
  });
  test('model receives previous turns and current edited draft on follow-up', async () => {
    const s = service();
    const result = await s.run('a', chatInput);
    const edited = await s.editDraft('a', result.draft.id, { version: 1, fields: { ...proposal, amount: '35', accountId: 'fixture_cash' } });
    expect(edited).toMatchObject({ version: 2, amount: '35', accountName: '现金账户' });
    const follow = await s.run('a', { ...chatInput, conversationId: result.conversationId, message: '刚才这笔草稿多少钱？' });
    expect(follow.answer).toContain('35元');
    await expect(s.run('b', { ...chatInput, conversationId: result.conversationId })).rejects.toMatchObject({ status: 404 });
    const chat = jest.fn().mockResolvedValue({ role: 'assistant', content: 'hello' });
    const custom = service({ chat });
    const first = await custom.run('a', { ...chatInput, message: '你好' });
    await custom.run('a', { ...chatInput, message: '继续', conversationId: first.conversationId });
    expect(chat.mock.calls[1][0].filter(item => item.role === 'user').map(item => item.content)).toEqual(['你好', '继续']);
  });
  test('editing validates identity, fields, category direction, amount and future date', async () => {
    const s = service();
    const { draft } = await s.run('a', chatInput);
    await expect(s.editDraft('b', draft.id, { version: 1, fields: proposal })).rejects.toMatchObject({ status: 404 });
    for (const fields of [{ ...proposal, userId: 'b' }, { ...proposal, accountId: 'other' },
      { ...proposal, categoryId: 'fixture_salary' }, { ...proposal, amount: '-1' }, { ...proposal, transDate: '2026-11-06' }]) {
      await expect(s.editDraft('a', draft.id, { version: 1, fields })).rejects.toThrow();
    }
    expect((await s.getDraft('a', draft.id)).version).toBe(1);
  });
  test('versions prevent stale updates, review stays isolated, discarded is terminal', async () => {
    const s = service();
    const { draft } = await s.run('a', chatInput);
    const updated = await s.editDraft('a', draft.id, { version: 1, fields: proposal });
    expect(updated.expiresAt).toBe(draft.expiresAt);
    await expect(s.editDraft('a', draft.id, { version: 1, fields: proposal })).rejects.toMatchObject({ status: 409, code: 'AI_DRAFT_CONFLICT' });
    const reviewed = await s.actOnDraft('a', draft.id, { version: 2, action: 'review' });
    expect(reviewed).toMatchObject({ status: 'reviewed', version: 3, formalWriteEnabled: false, needsReview: true });
    await expect(s.actOnDraft('b', draft.id, { version: 3, action: 'discard' })).rejects.toMatchObject({ status: 404 });
    await expect(s.actOnDraft('a', draft.id, { version: 3, action: 'commit' })).rejects.toThrow();
    const discarded = await s.actOnDraft('a', draft.id, { version: 3, action: 'discard' });
    expect(discarded.status).toBe('discarded');
    await expect(s.editDraft('a', draft.id, { version: 4, fields: proposal })).rejects.toMatchObject({ code: 'AI_DRAFT_DISCARDED' });
  });
  test('incomplete input cannot be reviewed; local field completion creates a new pending draft with no model request', async () => {
    const s = service();
    const result = await s.run('a', { ...chatInput, message: '记账35元' });
    expect(result.draft).toBeNull(); expect(result.inputCandidate.fields.amount).toBe('35');
    expect(result.request.providerCalls).toBe(0);
    await expect(s.actOnDraft('a', result.inputCandidate.id, { version: 1, action: 'review' })).rejects.toMatchObject({ status: 404 });
    const completed = await s.createLocalTransactionDraft('a', { requestId: require('crypto').randomUUID(),
      sourceCandidateId: result.inputCandidate.id, conversationId: result.conversationId, fields: { ...proposal, amount: '35' } });
    expect(completed.request.providerCalls).toBe(0); expect(completed.draft.status).toBe('pending');
    expect(completed.draft.sourceCandidateId).toBe(result.inputCandidate.id);
  });
});
