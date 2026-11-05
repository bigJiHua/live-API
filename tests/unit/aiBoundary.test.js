jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Mock test must not open a database'); }) }));
const { createAiService } = require('../../src/modules/ai/service');
const { executeTool, getTools } = require('../../src/modules/ai/service/tools');
const { validateTool, todayShanghai } = require('../../src/modules/ai/service/validation');
const { createMockRepository } = require('../../src/modules/ai/service/mock');
const { createDraftStore } = require('../../src/modules/ai/service/drafts');
const { getConfig, capabilities } = require('../../src/modules/ai/service/config');

const today = '2026-11-05';
const range = { startDate: '2026-11-01', endDate: today };
const input = { message: '昨天午饭花了32元，用支付宝付的', scene: 'draft', consent: false };
const proposal = { direction: 0, amount: '32.00', currency: 'CNY', transDate: today,
  categoryId: 'mock_food', accountId: 'mock_balance', payMethod: '支付宝', remark: '午饭' };
const context = () => ({ scene: 'draft', userId: 'user_a', today, repository: createMockRepository() });
const call = (name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ type: 'function', id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] });
const service = options => createAiService({ env: { AI_MODE: 'mock' }, now: () => new Date(`${today}T00:00:00Z`), ...options });

describe('AI boundary: model output never grants authority', () => {
  test('default disabled; production mock and incomplete real config fail closed', () => {
    expect(capabilities({}).enabled).toBe(false);
    expect(() => getConfig({ AI_MODE: 'mock', NODE_ENV: 'production' })).toThrow();
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
    await expect(executeTool(context(), 'propose_transaction', { ...proposal, categoryId: 'mock_salary' })).rejects.toThrow();
  });
  test('ambiguous choices stay null instead of defaulting to a real account', async () => {
    const draft = await executeTool(context(), 'propose_transaction', { ...proposal, accountId: null, categoryId: null, payMethod: null });
    expect(draft.missingFields).toEqual(['分类', '账户', '支付方式']);
    expect(draft.formalWriteEnabled).toBe(false);
  });
  test('mock end-to-end creates isolated proposal without opening a database', async () => {
    const s = service();
    const result = await s.run('user_a', input);
    expect(result.draft.amount).toBe('32');
    expect(result.draft.transDate).toBe('2026-11-04');
    expect(result.source).toBe('synthetic');
    expect(result.formalWriteEnabled).toBe(false);
    expect(s.getDraft('user_a', result.draft.id).amount).toBe('32');
    expect(() => s.getDraft('user_b', result.draft.id)).toThrow();
  });
  test('drafts expire and returned data cannot mutate stored version', () => {
    let now = 1000;
    const store = createDraftStore({ now: () => now, ttl: 100 });
    const result = store.save('a', proposal);
    result.amount = '999';
    expect(store.get('a', result.id).amount).toBe('32.00');
    now = 1100;
    expect(() => store.get('a', result.id)).toThrow();
  });
  test('failed tool sequence does not save partial drafts', async () => {
    const store = { save: jest.fn(), get: jest.fn() };
    const chat = jest.fn().mockResolvedValueOnce(call('propose_transaction', proposal)).mockResolvedValueOnce(call('commit_transaction', {}));
    await expect(service({ chat, draftStore: store }).run('a', input)).rejects.toThrow();
    expect(store.save).not.toHaveBeenCalled();
  });
  test('model repeated proposal rejected; no repeated formal writes exist', async () => {
    const chat = jest.fn().mockResolvedValue(call('propose_transaction', proposal));
    await expect(service({ chat }).run('a', input)).rejects.toThrow('一笔草稿');
  });
  test('repeated query loop is stopped within bounded model calls', async () => {
    const chat = jest.fn().mockResolvedValue(call('query_finance_summary', range));
    await expect(service({ chat }).run('a', { ...input, scene: 'query' })).rejects.toMatchObject({ code: 'AI_TOOL_LIMIT' });
    expect(chat).toHaveBeenCalledTimes(4);
  });
  test('malformed JSON and malformed tool list fail before accessing repository', async () => {
    const repository = { summary: jest.fn() };
    const bad = call('query_finance_summary', range);
    bad.tool_calls[0].function.arguments = '{invalid';
    await expect(service({ repository, chat: async () => bad }).run('a', { ...input, scene: 'query' })).rejects.toThrow('JSON');
    expect(repository.summary).not.toHaveBeenCalled();
  });
  test('client cannot supply model history, identity, or a consent string', async () => {
    for (const extra of [{ userId: 'b' }, { messages: [] }, { consent: 'true' }]) {
      await expect(service().run('a', { ...input, ...extra })).rejects.toThrow();
    }
  });
  test('real calls require explicit consent before provider or repository access', async () => {
    const chat = jest.fn();
    const s = service({ env: { AI_MODE: 'deepseek', DEEPSEEK_API_KEY: 'test', AI_DB_HOST: 'host',
      AI_DB_NAME: 'test', AI_DB_USER: 'readonly', AI_DB_PASSWORD: 'test' }, chat });
    await expect(s.run('a', input)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(chat).not.toHaveBeenCalled();
  });
});
