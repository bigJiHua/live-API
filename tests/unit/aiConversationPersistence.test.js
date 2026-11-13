jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getConnection: jest.fn() }));
const db = require('../../src/common/config/db');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { createAiService } = require('../../src/modules/ai/service');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const { createTestRepository } = require('../helpers/aiFixture');
const { buildQueryContext, attachQueryResults } = require('../../src/modules/ai/service/queryContext');
// 2026-11-08：provider 只从数据库层读取，测试用内存接入商代替 .env 凭据。
function seededSettingsStore() {
  const store = createSettingsStore();
  store.save('owner', { apiUrl: 'https://api.deepseek.com', apiKey: 'unit-key', model: 'deepseek-flash' });
  return store;
}

let conn;
beforeEach(() => {
  jest.clearAllMocks();
  conn = { execute: jest.fn().mockImplementation(async sql => sql.startsWith('SELECT') ? [[{ id: 'conversation' }]] : [{ affectedRows: 1 }]),
    beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(), release: jest.fn() };
  db.getConnection.mockResolvedValue(conn);
});

test('successful turn saves both messages and updates timestamp in one transaction', async () => {
  await createConversationStore().append('owner', 'conversation', { message: 'query', answer: 'answer', trace: [] });
  expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO ai_message'))).toHaveLength(2);
  expect(conn.execute.mock.calls.find(([sql]) => sql.startsWith('UPDATE ai_conversation')))
    .toEqual([expect.stringContaining('updated_at = NOW()'), [null, 'conversation', 'owner']]);
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
});

test.each([7500, 12000])('V3 persists and restores all %i Markdown characters in every history read', async length => {
  const answer = ('# 文章\n\n正文 **强调** 与 [链接](https://example.com)。\n').repeat(400).slice(0, length);
  const store = createConversationStore();
  await store.append('owner', 'conversation', { message: '写一篇 MD 文章', answer, requestId: 'prose_request',
    business: { contractVersion: 3 }, thinking: '想'.repeat(5000) });
  const inserts = conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO ai_message'));
  expect(inserts).toHaveLength(2);
  expect(inserts[1][1][2]).toBe(answer);
  const meta = JSON.parse(inserts[1][1][4]);
  expect(meta.thinking).toHaveLength(4000);
  const row = { id: 8, role: 'assistant', content: inserts[1][1][2], meta, created_at: null, draft_id: null };
  for (const read of [() => store.messages('owner', 'conversation'), () => store.messagesSince('owner', 'conversation', 7),
    () => store.open('owner', 'conversation')]) {
    db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]]).mockResolvedValueOnce([[{ ...row }]]);
    const result = await read();
    const messages = Array.isArray(result) ? result : result.messages || result.history;
    expect(messages[0].content).toBe(answer);
  }
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).not.toHaveBeenCalled();
});

test('V3 rejects an over-budget reply before saving either message or a truncated success', async () => {
  await expect(createConversationStore().append('owner', 'conversation', { message: '写文章', answer: '文'.repeat(12001),
    business: { contractVersion: 3 } })).rejects.toMatchObject({ code: 'AI_ANSWER_TOO_LONG' });
  expect(db.getConnection).not.toHaveBeenCalled();
  expect(conn.execute).not.toHaveBeenCalled();
  expect(conn.commit).not.toHaveBeenCalled();
});

test.each([undefined, { contractVersion: 2 }])('legacy history keeps its existing 4000-character budget (%j)', async business => {
  await createConversationStore().append('owner', 'conversation', { message: 'query', answer: '文'.repeat(7500), business });
  const insert = conn.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  expect(insert[1][2]).toHaveLength(4000);
});

test('query turns persist one shared identity and only semantic query context', async () => {
  const context = buildQueryContext({ message: '6月份收支', today: '2026-11-08' });
  context.rows = [{ amount: '999.00', ref: `r_${'a'.repeat(32)}` }];
  await createConversationStore().append('owner', 'conversation', {
    message: '6月份收支', answer: '查询完成', requestId: 'query_june', queryContext: context,
  });
  const inserts = conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO ai_message'));
  const userMeta = JSON.parse(inserts[0][1][3]);
  const assistantMeta = JSON.parse(inserts[1][1][4]);
  expect(userMeta.turnId).toBe('query_june');
  expect(assistantMeta.turnId).toBe(userMeta.turnId);
  expect(assistantMeta.queryContext).toMatchObject({ turnId: 'query_june', activeQuery: { startDate: '2026-06-01', status: 'succeeded' } });
  expect(assistantMeta.queryContext.rows).toBeUndefined();
});

test('history restores bound query and failure turns without attaching standalone cards', async () => {
  const context = buildQueryContext({ message: '6月份收支', today: '2026-11-08' });
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[
      { id: 15, role: 'assistant', content: '卡片更新', meta: { standalone: true } },
      { id: 14, role: 'assistant', content: '已查询', meta: { turnId: 'query_june', queryContext: context } },
      { id: 13, role: 'user', content: '6月份收支', meta: { turnId: 'query_june' }, created_at: '2026-11-08T00:30:00Z' },
      { id: 12, role: 'assistant', content: '失败', meta: { turnId: 'query_failed', failure: { requestId: 'query_failed', code: 'AI_PREVIEW_INVALID' } } },
      { id: 11, role: 'user', content: '5月份支出', meta: { turnId: 'query_failed' } },
    ]]);
  const history = (await createConversationStore().open('owner', 'conversation')).history;
  expect(history.map(item => item.turnId || null)).toEqual(['query_failed', 'query_failed', 'query_june', 'query_june', null]);
  expect(history[2].sourceDate).toBe('2026-11-08');
  expect(history[3].queryContext.activeQuery.startDate).toBe('2026-06-01');
  expect(history[4]).toMatchObject({ standalone: true });
});

test('query context restore is independent from the ten-message prose window and remains owner scoped', async () => {
  const context = buildQueryContext({ message: '6月份收支', today: '2026-11-08' });
  db.execute.mockImplementation(async (sql, params) => {
    if (sql.startsWith('SELECT id, latest_draft_id')) return [[{ id: 'conversation', latest_draft_id: null }]];
    if (sql.startsWith('SELECT id, role')) return [[{ id: 50, role: 'user', content: '谢谢', meta: { turnId: 'other_turn' } }]];
    if (sql.startsWith('SELECT id, meta')) {
      expect(params).toEqual(['conversation', 'owner']);
      return [[{ id: 10, meta: { business: { queryContext: context, datasets: [{ rows: [{ ref: 'old' }] }] } } }]];
    }
    throw new Error('unexpected query');
  });
  const store = createConversationStore();
  const opened = await store.open('owner', 'conversation');
  expect(opened.history[0].queryContext).toBeUndefined();
  const restored = await store.loadQueryContext('owner', 'conversation');
  expect(restored.activeQuery.startDate).toBe('2026-06-01');
  expect(restored.datasets).toBeUndefined();
  const [sql] = db.execute.mock.calls.find(([statement]) => statement.startsWith('SELECT id, meta'));
  expect(sql).toContain('user_id = ?');
  expect(sql).toContain("'$.sentAt'");
  expect(sql).toContain('DESC, id DESC LIMIT 20');
});

test('invalid recent query metadata is skipped without restoring old rows', async () => {
  const context = buildQueryContext({ message: '6月份收支', today: '2026-11-08' });
  db.execute.mockResolvedValueOnce([[
    { id: 51, meta: { queryContext: { activeQuery: { startDate: 'bad', endDate: 'bad' } } } },
    { id: 49, meta: { queryContext: context } },
  ]]);
  expect((await createConversationStore().loadQueryContext('owner', 'conversation')).activeQuery.startDate).toBe('2026-06-01');
});

test('bounded previous-query coverage persists and restores independently without old amounts or refs', async () => {
  const queryMeta = { version: 1, datasetId: 'finance-monthly', requestedScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, filters: { direction: 'both', text: '' }, sort: 'monthAsc',
    matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 268, rowsComplete: true, summaryComplete: true, rankingComplete: true,
    asOf: '2026-11-08T04:00:00.000Z' };
  const context = attachQueryResults(buildQueryContext({ message: '6月份收支', today: '2026-11-08' }),
    [{ datasetId: 'finance-monthly', rows: [{ income: '3911.24', ref: 'old-ref' }], queryMeta }], { turnId: 'june_result' });
  await createConversationStore().append('owner', 'conversation', { message: '6月份收支', answer: '已查询', requestId: 'june_result', queryContext: context });
  const insert = conn.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  const meta = JSON.parse(insert[1][4]);
  expect(meta.queryContext.lastResults[0]).toMatchObject({ source: 'previous-turn', sourceRecordCount: 268, returnedRowCount: 1 });
  expect(JSON.stringify(meta.queryContext)).not.toMatch(/3911\.24|old-ref/);
  db.execute.mockResolvedValueOnce([[{ id: 10, meta }]]);
  const restored = await createConversationStore().loadQueryContext('owner', 'conversation');
  expect(restored.lastResults[0]).toMatchObject({ turnId: 'june_result', effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    matchedRowCount: 1, sourceRecordCount: 268, rowsComplete: true, summaryComplete: true, rankingComplete: true });
});

test('a local card action saves only its assistant draft and never invents a user utterance',async()=>{
  const store=createConversationStore();
  await store.append('owner','conversation',{message:'',answer:'',draft:{id:'draft'}});
  let inserts=conn.execute.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO ai_message'));
  expect(inserts).toHaveLength(1);expect(inserts[0][0]).toContain("'assistant'");expect(inserts[0][1][3]).toBe('draft');
  expect(conn.execute.mock.calls.find(([sql])=>sql.startsWith('UPDATE ai_conversation'))[1]).toEqual(['draft','conversation','owner']);
  await store.append('owner','conversation',{message:'请记录这笔零食',answer:'',draft:{id:'draft'}});
  inserts=conn.execute.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO ai_message'));
  const user=inserts.filter(([sql])=>sql.includes("'user'"));expect(user).toHaveLength(1);
  expect(user[0][1][2]).toBe('请记录这笔零食');expect(JSON.stringify(inserts)).not.toContain('补充字段后生成记账草稿');
});

test('assistant insert failure rolls back the user message and does not report success', async () => {
  conn.execute.mockImplementation(async sql => {
    if (sql.includes("'assistant'")) throw new Error('insert failed');
    return sql.startsWith('SELECT') ? [[{ id: 'conversation' }]] : [{ affectedRows: 1 }];
  });
  await expect(createConversationStore().append('owner', 'conversation', { message: 'query', answer: 'answer', trace: [] })).rejects.toThrow('insert failed');
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
});

test('other owner cannot append or remove a conversation', async () => {
  conn.execute.mockResolvedValue([[]]);
  const store = createConversationStore();
  await expect(store.append('other', 'conversation', { message: 'x', answer: 'x', trace: [] })).rejects.toMatchObject({ status: 404 });
  await expect(store.remove('other', 'conversation')).rejects.toMatchObject({ status: 404 });
  for (const [sql, params] of conn.execute.mock.calls) {
    expect(sql).toMatch(/^SELECT/);
    expect(params).toEqual(['conversation', 'other']);
  }
});

test('message reads are scoped to both conversation and current user', async () => {
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[{ role: 'user', content: 'query' }]]);
  const opened = await createConversationStore().open('owner', 'conversation');
  expect(opened.history).toEqual([{ role: 'user', content: 'query' }]);
  expect(db.execute.mock.calls[1][0]).toContain('user_id = ?');
  expect(db.execute.mock.calls[1][1]).toEqual(['conversation', 'owner', 'conversation', 'owner', 4]);
});

test('failed turns persist the user utterance and one server-authored notice', async () => {
  conn.execute.mockImplementation(async sql => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation' }]];
    if (sql.startsWith('SELECT id FROM ai_message')) return [[]];
    return [{ affectedRows: 1 }];
  });
  const saved = await createConversationStore().appendFailure('owner', 'conversation', {
    message: '上个月信用卡支出情况如何？', notice: 'AI 供应商响应超时，本次已停止。',
    requestId: 'req_failed_1', errorCode: 'AI_PROVIDER_TIMEOUT',
  });
  expect(saved).toBe(true);
  const inserts = conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO ai_message'));
  expect(inserts).toHaveLength(2);
  expect(inserts[0][0]).toContain("'user'");
  expect(inserts[0][1]).toEqual(['conversation', 'owner', '上个月信用卡支出情况如何？',
    JSON.stringify({ turnId: 'req_failed_1', requestId: 'req_failed_1' })]);
  expect(inserts[1][1]).toEqual(['conversation', 'owner', 'AI 供应商响应超时，本次已停止。',
    JSON.stringify({ turnId: 'req_failed_1', failure: { requestId: 'req_failed_1', code: 'AI_PROVIDER_TIMEOUT', status: 'failed' } })]);
  expect(conn.execute.mock.calls.find(([sql]) => sql.startsWith('UPDATE ai_conversation'))[0])
    .toContain('updated_at = NOW()');
  expect(conn.commit).toHaveBeenCalledTimes(1);
});

test.each(['completed','failed'])('a %s continuation persists the explicit parent on both messages', async status => {
  const retryOf = '1354af98-8618-4ed0-83d0-17e417a0a7d9';
  conn.execute.mockImplementation(async sql => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation' }]];
    if (sql.startsWith('SELECT id FROM ai_message')) return [[]];
    return [{ affectedRows: 1 }];
  });
  const store = createConversationStore(), payload = { message: '继续原问题', requestId: 'continued_request', retryOf };
  if (status === 'completed') await store.append('owner', 'conversation', { ...payload, answer: '已完成' });
  else await store.appendFailure('owner', 'conversation', { ...payload, notice: '仍未完成', errorCode: 'AI_PROVIDER_TIMEOUT' });
  const inserts = conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO ai_message'));
  expect(inserts).toHaveLength(2);
  expect(inserts.map(([, params]) => JSON.parse(params.at(-1)).retryOf)).toEqual([retryOf,retryOf]);
});

test('message reads expose retry lineage for reload without inferring equal text', async () => {
  const parent = '1354af98-8618-4ed0-83d0-17e417a0a7d9', child = '02c44af8-1c32-4699-835d-dce9da279afa';
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[
      { id: 1, role: 'assistant', content: '等待授权', meta: { continuedBy: child, failure: { requestId: parent, status: 'failed', code: 'AI_GRANT_REQUIRED' } } },
      { id: 2, role: 'user', content: '原问题', meta: { requestId: child, retryOf: parent } },
      { id: 3, role: 'assistant', content: '已完成', meta: { requestId: child, retryOf: parent } },
    ]]);
  const list = await createConversationStore().messages('owner', 'conversation');
  expect(list[0]).toMatchObject({ requestId: parent, continuedBy: child });
  expect(list.slice(1).every(row => row.retryOf === parent && row.requestId === child)).toBe(true);
});

test('retry links remain owner and conversation scoped when the parent is below the cursor', async () => {
  const parent = '1354af98-8618-4ed0-83d0-17e417a0a7d9', child = '02c44af8-1c32-4699-835d-dce9da279afa';
  db.execute.mockResolvedValueOnce([[{ retry_of: parent, request_id: child }, { retry_of: 'invalid', request_id: child }]]);
  await expect(createConversationStore().retryLinks('owner', 'conversation')).resolves.toEqual([{ retryOf: parent, requestId: child }]);
  expect(db.execute.mock.calls[0][1]).toEqual(['conversation','owner']);
  expect(db.execute.mock.calls[0][0]).toContain("role = 'assistant'");
  expect(db.execute.mock.calls[0][0]).toContain('ORDER BY id DESC LIMIT 1000');
});

test('a failed turn keeps the provider summary for the restored chat bubble', async () => {
  conn.execute.mockImplementation(async sql => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation' }]];
    if (sql.startsWith('SELECT id FROM ai_message')) return [[]];
    return [{ affectedRows: 1 }];
  });
  await createConversationStore().appendFailure('owner', 'conversation', {
    message: '查一下上个月账单', notice: 'AI 供应商限制了本次请求，请稍后手动重试。',
    requestId: 'req_failed_provider', errorCode: 'AI_PROVIDER_RATE_LIMIT',
    providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests', apiKey: 'private-fixture-key' },
  });
  const insert = conn.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  expect(JSON.parse(insert[1][3]).failure).toEqual({
    requestId: 'req_failed_provider', code: 'AI_PROVIDER_RATE_LIMIT', status: 'failed',
    providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' },
  });
});

test('a failed query preserves its intended period with failed status', async () => {
  conn.execute.mockImplementation(async sql => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation' }]];
    if (sql.startsWith('SELECT id FROM ai_message')) return [[]];
    return [{ affectedRows: 1 }];
  });
  await createConversationStore().appendFailure('owner', 'conversation', {
    message: '6月份收支', notice: '失败', requestId: 'query_failed', errorCode: 'AI_PREVIEW_INVALID',
    queryContext: buildQueryContext({ message: '6月份收支', today: '2026-11-08' }),
  });
  const insert = conn.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  expect(JSON.parse(insert[1][3]).queryContext).toMatchObject({ turnId: 'query_failed', errorCode: 'AI_PREVIEW_INVALID',
    activeQuery: { startDate: '2026-06-01', status: 'failed' } });
});

test('history reads restore the provider summary with the failed turn', async () => {
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[{ id: 7, role: 'assistant', content: 'AI 供应商限制了本次请求，请稍后手动重试。', draft_id: null, created_at: null,
      meta: { failure: { requestId: 'req_failed_provider', code: 'AI_PROVIDER_RATE_LIMIT', status: 'failed',
        providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' } } } }]]);
  const list = await createConversationStore().messages('owner', 'conversation');
  expect(list[0].failure).toEqual({ status: 'failed', code: 'AI_PROVIDER_RATE_LIMIT',
    providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' } });
});

test('the same requestId never writes a duplicate failure row', async () => {
  conn.execute.mockImplementation(async sql => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation' }]];
    if (sql.startsWith('SELECT id FROM ai_message')) return [[{ id: 'existing' }]];
    return [{ affectedRows: 1 }];
  });
  const saved = await createConversationStore().appendFailure('owner', 'conversation', {
    message: '查一下', notice: '超时', requestId: 'req_failed_2', errorCode: 'AI_PROVIDER_TIMEOUT',
  });
  expect(saved).toBe(false);
  expect(conn.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO ai_message'))).toHaveLength(0);
});

test('history keeps the failure marker so the next turn can remember it', async () => {
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[
      { role: 'assistant', content: 'AI 供应商响应超时，本次已停止。', meta: { failure: { requestId: 'req_failed_3', code: 'AI_PROVIDER_TIMEOUT', status: 'failed' } } },
      { role: 'user', content: '上个月信用卡支出情况如何？' },
    ]]);
  const opened = await createConversationStore().open('owner', 'conversation');
  expect(opened.history).toEqual([
    { role: 'user', content: '上个月信用卡支出情况如何？', turnId: 'req_failed_3' },
    { role: 'assistant', content: 'AI 供应商响应超时，本次已停止。',
      turnId: 'req_failed_3',
      failure: { requestId: 'req_failed_3', code: 'AI_PROVIDER_TIMEOUT' } },
  ]);
});

test('message reads expose the failed request id for retry and receipt recovery', async () => {
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[{ id: 42, role: 'assistant', content: 'AI 供应商响应超时，本次已停止。', draft_id: null, created_at: null,
      meta: { failure: { requestId: 'req_failed_4', code: 'AI_PROVIDER_TIMEOUT', status: 'failed' } } }]]);
  const list = await createConversationStore().messages('owner', 'conversation');
  expect(list).toEqual([{ messageId: 42, role: 'assistant', content: 'AI 供应商响应超时，本次已停止。', draftId: null, createdAt: null,
    requestId: 'req_failed_4', failure: { status: 'failed', code: 'AI_PROVIDER_TIMEOUT' } }]);
});

test('incremental reads return only rows after the cursor with the next cursor', async () => {
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[
      { id: 7, role: 'user', content: '你好', draft_id: null, created_at: null, meta: null },
      { id: 9, role: 'assistant', content: '收到', draft_id: null, created_at: null, meta: null },
    ]]);
  const sync = await createConversationStore().messagesSince('owner', 'conversation', 5);
  expect(db.execute.mock.calls[1][0]).toContain('id > ?');
  expect(db.execute.mock.calls[1][1]).toEqual(['conversation', 'owner', 5, 200]);
  expect(sync.lastId).toBe(9);
  expect(sync.messages.map(item => item.messageId)).toEqual([7, 9]);
  expect(sync.messages[0]).toMatchObject({ role: 'user', content: '你好' });
});

test('incremental reads keep the cursor when nothing new arrived', async () => {
  db.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]])
    .mockResolvedValueOnce([[]]);
  const sync = await createConversationStore().messagesSince('owner', 'conversation', 12);
  expect(sync).toEqual({ messages: [], lastId: 12 });
});

test('incremental reads reject invalid cursors and stay scoped to the owner', async () => {
  await expect(createConversationStore().messagesSince('owner', 'conversation', 'abc'))
    .rejects.toMatchObject({ status: 400, code: 'AI_CONVERSATION_SINCE_INVALID' });
  await expect(createConversationStore().messagesSince('owner', 'conversation', -1))
    .rejects.toMatchObject({ status: 400, code: 'AI_CONVERSATION_SINCE_INVALID' });
  db.execute.mockResolvedValue([[]]);
  await expect(createConversationStore().messagesSince('other', 'conversation', 1))
    .rejects.toMatchObject({ status: 404, code: 'AI_CONVERSATION_EXPIRED' });
});

test('conversation removal rolls back if the second delete fails', async () => {
  conn.execute.mockImplementation(async sql => {
    if (sql.startsWith('DELETE FROM ai_conversation')) throw new Error('delete failed');
    return sql.startsWith('SELECT') ? [[{ id: 'conversation' }]] : [{ affectedRows: 1 }];
  });
  await expect(createConversationStore().remove('owner', 'conversation')).rejects.toThrow('delete failed');
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.commit).not.toHaveBeenCalled();
});

test('the service waits for history durability before returning an answer', async () => {
  let finish;
  const saved = new Promise(resolve => { finish = resolve; });
  const conversationStore = { open: async () => ({ id: 'conversation', history: [] }), append: jest.fn(() => saved) };
  const service = require('../helpers/aiFixture').createLegacyTestService({ env: { AI_MODE: 'deepseek', NODE_ENV: 'test', DEEPSEEK_API_KEY: 'unit-key',
    AI_DB_HOST: 'not-connected', AI_DB_NAME: 'unit', AI_DB_USER: 'readonly', AI_DB_PASSWORD: 'unit' },
    repository: createTestRepository(), chat: async () => ({ role: 'assistant', content: 'answer' }), conversationStore,
    requestGuard: createMemoryRequestGuard(), settingsStore: seededSettingsStore() });
  let returned = false;
  const run = service.run('owner', { scene: 'chat', message: 'query', consent: true }).then(result => { returned = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  expect(conversationStore.append).toHaveBeenCalledTimes(1);
  expect(returned).toBe(false);
  finish();
  expect((await run).answer).toBe('answer');
  await service.close();
});
