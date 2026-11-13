jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Live database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChatStream: jest.fn(() => { throw new Error('Live provider forbidden'); }) }));
const { fixture, final, calls, id, now } = require('../fixtures/aiV3MemoryFixture');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { asksConversationArtifactState, loadConversationArtifactState, conversationArtifactStateAnswer } = require('../../src/modules/ai/service/conversationArtifacts');
const { AiError } = require('../../src/modules/ai/service/errors');

const row = (kind, status = 'pending', count = 1, ready = 1) => ({ kind, status, current_status: status, count, ready });
function replay({ drafts = [row('transaction.create')], proposals = [row('diary.create')], mode = 'operate', grantError, readError, responses } = {}) {
  const grants = { requireCoverage: jest.fn(async () => { if (grantError) throw grantError; }) };
  const f = fixture(responses || [final({ answer: '目前实际保存待核对草稿 0 个，李白和买菜当时只是说明文字，没有真正生成。' })], { grants, memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  const read = jest.fn(async sql => {
    if (readError) throw readError;
    if (sql.includes('FROM bus_ai_draft')) return [typeof drafts === 'function' ? drafts() : drafts];
    if (sql.includes('FROM ai_business_proposal')) return [typeof proposals === 'function' ? proposals() : proposals];
    throw new Error('Unexpected fixture SQL: ' + sql);
  });
  const conn = { execute: read, beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn() };
  const executor = { execute: read, getConnection: jest.fn(async () => conn) };
  const service = createV3Service({ legacyService: f.legacy, executor, repository: f.repository, provider: f.provider,
    grants, memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) }, historyReader: { search: jest.fn(async () => []) },
    businessService: {}, proposals: { create: jest.fn(() => { throw new Error('No new proposal authorized by status query'); }) },
    callLog: { record: () => {} }, now });
  const send = (message = '目前实际保存了几个待核对草稿？') => service.chat('offline-memory-owner', { requestId: id(), conversationId: f.conversationId, consent: true, mode, message });
  return { ...f, send, grants, read, conn };
}

test.each(['operate', 'chat', 'analysis'])('%s sees persisted drafts and diary proposals; false zero is replaced with authority state', async mode => {
  const f = replay({ mode, responses: [mode === 'operate' ? final({ answer: '待核对草稿 0 个，当时没有真正生成。' }) : { role: 'assistant', content: '待核对草稿 0 个，当时没有真正生成。' }] });
  const result = await f.send();
  expect(result.answer).toContain('实际保存过 2 个');
  expect(result.answer).toContain('当前待核对或确认的有 2 个');
  expect(result.answer).not.toContain('当时没有');
  expect(result.operationOutcome).toMatchObject({ state: 'none', formalWriteExecuted: false, artifacts: [] });
  const input = JSON.parse(f.provider.mock.calls[0][1][1].content.slice('TASK_INPUT:\n'.length));
  expect(input.actualArtifacts).toMatchObject({ createdCount: 2, awaitingConfirmationCount: 2, scope: 'current-conversation' });
  expect(input.actualArtifacts.groups.map(group => group.kind)).toEqual(['transaction.create', 'diary.create']);
  expect(f.read.mock.calls).toHaveLength(4); // Initial prompt and final transactional answer.
  expect(f.read.mock.calls.every(([, params]) => params[1] === 'offline-memory-owner' && params[2] === f.conversationId)).toBe(true);
  expect(f.grants.requireCoverage.mock.calls[0][3]).toMatchObject({ conversationId: f.conversationId, access: 'read' });
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);
});

test('a diary proposal is counted without a latest transaction draft or legacy getter', async () => {
  const f = replay({ drafts: [] });
  const result = await f.send('日记草稿是否保存了？');
  expect(result.answer).toContain('记账草稿 0 个，业务提案 1 个');
  expect(f.legacy.getDraft).not.toHaveBeenCalled();
});

test('operate mode supplies aggregate transaction status without reading its original payload', async () => {
  const f = replay(); f.state.latestDraftId = 'private-draft-state';
  f.legacy.getDraft.mockImplementation(() => { throw new Error('Original artifact payload must not be read'); });
  await f.send('这笔草稿当前状态是什么？');
  const input = JSON.parse(f.provider.mock.calls[0][1][1].content.slice('TASK_INPUT:\n'.length));
  expect(input.actualDrafts).toEqual([{ status: 'pending', sourceText: null, count: 1 }]);
  expect(input.hasPriorDraft).toBe(true);
  expect(f.legacy.getDraft).not.toHaveBeenCalled();
});

test('expired cards remain in created counts but cannot be submitted', async () => {
  const f = replay({ drafts: [row('transaction.create', 'expired')], proposals: [row('diary.create', 'expired')] });
  const result = await f.send();
  expect(result.answer).toContain('实际保存过 2 个');
  expect(result.answer).toContain('当前待核对或确认的有 0 个');
  expect(result.answer).toContain('2 个已过期，确实曾生成，但现在不能提交');
  expect(f.read.mock.calls[0][0]).toContain("expires_at<=? THEN 'expired'");
  expect(f.read.mock.calls[1][0]).toContain("expires_at<=? THEN 'expired'");
});

test('final answer refreshes state if a card is confirmed while the provider is replying', async () => {
  let completed = false;
  const f = replay({ drafts: [], proposals: () => [row('diary.create', completed ? 'committed' : 'pending')],
    responses: [() => { completed = true; return final({ answer: '还需确认日记草稿。' }); }] });
  const result = await f.send();
  expect(result.answer).toContain('当前待核对或确认的有 0 个');
  expect(result.answer).toContain('1 个已有正式执行回执');
});

test('ungranted status queries read no artifacts or legacy draft and call no provider', async () => {
  const f = replay({ grantError: new AiError('请授权', 403, 'AI_GRANT_REQUIRED') });
  f.state.latestDraftId = 'private-draft';
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(f.read).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled(); expect(f.legacy.getDraft).not.toHaveBeenCalled();
});

test('revocation after the snapshot stops before the first provider disclosure', async () => {
  const f = replay();
  let checks = 0;
  f.grants.requireCoverage.mockImplementation(async () => { if (++checks > 1) throw new AiError('授权已撤回', 403, 'AI_GRANT_REQUIRED'); });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.provider).not.toHaveBeenCalled();
});

test('a failed authority read cannot produce a zero count', async () => {
  const f = replay({ readError: new Error('offline SQL read unavailable') });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_ARTIFACT_STATE_UNAVAILABLE', status: 503 });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test('the exact total-created question counts committed and expired cards, not only pending', async () => {
  const f = replay({ drafts: [row('transaction.create', 'expired')], proposals: [row('diary.create', 'committed')] });
  const result = await f.send('你总共生成了多少个草稿？');
  expect(result.answer).toContain('实际保存过 2 个');
  expect(result.answer).toContain('1 个已过期，确实曾生成');
  expect(result.answer).toContain('1 个已有正式执行回执');
  expect(result.answer).not.toContain('没有真正生成');
});

test.each(['生成过多少草稿？', '生成了几个草稿？', '请你生成过多少个草稿？'])('past creation question %s reads actual counts', async message => {
  const f = replay();
  expect((await f.send(message)).answer).toContain('实际保存过 2 个');
  expect(f.read).toHaveBeenCalledTimes(4);
});

test('an empty text-history search cannot negate persisted artifact counts', async () => {
  const f = replay({ responses: [calls('history_search', { query: '草稿' }), final({ answer: '历史查询没有记录，所以没有生成过草稿。' })] });
  const result = await f.send('你总共生成了多少个草稿？');
  expect(result.answer).toContain('实际保存过 2 个');
  expect(result.answer).not.toContain('没有生成过');
  expect(result.toolTrace[0].tool).toBe('history_search');
});

test('casual chat and a new writing request do not prefetch artifact state', async () => {
  const f = replay({ mode: 'chat', responses: [{ role: 'assistant', content: '你好' }] });
  f.state.latestDraftId = 'old-financial-draft';
  f.legacy.getDraft.mockImplementation(() => { throw new Error('Casual or writing requests must not read an old draft'); });
  expect((await f.send('你好')).answer).toBe('你好');
  expect(f.read).not.toHaveBeenCalled();
  expect((await f.send('帮我写一篇关于李白的日记，保存成待确认草稿。')).answer).toBe('你好');
  expect(f.legacy.getDraft).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  expect(asksConversationArtifactState('帮我生成一份可保存的草稿')).toBe(false);
  expect(asksConversationArtifactState('帮我写一篇关于李白的日记，保存成待确认草稿。')).toBe(false);
  expect(asksConversationArtifactState('之前帮我写的李白日记，草稿保存了吗？')).toBe(true);
});

test('only complete current cards await confirmation; incomplete, discarded and committed remain distinct', async () => {
  const executor = { execute: jest.fn().mockResolvedValueOnce([[row('transaction.create', 'reviewed', 2)]])
    .mockResolvedValueOnce([[row('diary.create', 'pending', 1, 0), row('todo.create', 'discarded', 3), row('todo.create', 'committed', 1)]]) };
  const state = await loadConversationArtifactState({ executor, userId: 'owner', conversationId: 'conversation', now });
  expect(state).toMatchObject({ createdCount: 7, awaitingConfirmationCount: 2 });
  expect(conversationArtifactStateAnswer(state)).toContain('1 个仍需补充信息');
  expect(conversationArtifactStateAnswer(state)).toContain('3 个已放弃');
  expect(conversationArtifactStateAnswer(state)).toContain('1 个已有正式执行回执');
  expect(conversationArtifactStateAnswer(state, 'en')).toContain('saved 7 drafts or proposals');
});

test('a proven empty conversation is different from omitted state or invalid database counts', async () => {
  const f = replay({ drafts: [], proposals: [] });
  expect((await f.send()).answer).toBe('本会话目前没有实际保存过草稿或提案。');
  expect(conversationArtifactStateAnswer(null)).toBe('');
  const executor = { execute: jest.fn().mockResolvedValueOnce([[row('transaction.create', 'pending', 'not-count')]]).mockResolvedValueOnce([[]]) };
  await expect(loadConversationArtifactState({ executor, userId: 'owner', conversationId: 'conversation', now })).rejects.toMatchObject({ code: 'AI_ARTIFACT_STATE_UNAVAILABLE' });
});
