jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Database forbidden'); }) }));
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { buildTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryContext } = require('../../src/modules/ai/service/queryContext');
const { attachQueryCoverage } = require('../../src/modules/ai/service/contextState');
const { buildPendingTransactionContext } = require('../../src/modules/ai/service/pendingTransactions');
const { sanitizeTopicBoundary, messageSentAt, compareMessageRows } = require('../../src/modules/ai/service/topicBoundary');

const conversationId = '11111111-1111-4111-8111-111111111111';
const oldTurn = '22222222-2222-4222-8222-222222222222';
const resetTurn = '33333333-3333-4333-8333-333333333333';
const now = Date.parse('2026-11-12T04:00:00Z'), today = '2026-11-12';
const marker = turnId => ({ version: 1, kind: 'explicit-reset', turnId });
const summary = { version: 1, items: [{ text: '9月收支', sourceDate: '2026-09-01', status: 'completed' }], truncated: false };
const finance = (month, turnId) => {
  const message = `查${month}月支出`, queryContext = buildQueryContext({ message, today });
  const taskContext = buildTaskContext({ message, today, queryContext });
  const scope = { startDate: `2026-${String(month).padStart(2, '0')}-01`, endDate: month === 11 ? today : '2026-09-30' };
  const queryCoverage = attachQueryCoverage(null, [{ datasetId: 'finance-monthly', rows: [{ month: scope.startDate.slice(0, 7) }],
    summary: { incomeCount: 0, expenseCount: 1 }, queryMeta: { version: 1, queryId: `q_${'a'.repeat(24)}`,
      datasetId: 'finance-monthly', requestedScope: scope, effectiveScope: scope, filters: { direction: 'expense', text: '' },
      sort: 'monthAsc', matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 1,
      rowsComplete: true, summaryComplete: true, rankingComplete: true, returnedDateRange: null, asOf: new Date(now).toISOString() } }], { turnId });
  return { queryContext, taskContext, taskContexts: { version: 1, tasks: [taskContext] }, queryCoverage };
};
const pending = () => buildPendingTransactionContext({ conversationId, turnId: oldTurn, now,
  userTurns: ['今天买菜20元'], userTurnDates: [today], userTurnIds: [oldTurn],
  transactions: [{ fields: { direction: 0, amount: '20.00', currency: 'CNY', transDate: today, remark: '买菜' },
    evidence: { sourceTurn: 0, quote: '今天买菜20元' }, missingFields: ['账户'] }] });

// The fixture executes the relevant WHERE/ORDER/LIMIT behavior, including the
// cutoff subquery. Production SQL is also asserted below rather than inferred
// solely from returned rows.
function fixture() {
  const messages = [], conversations = new Map([[conversationId, { userId: 'owner', latestDraftId: 'existing-draft' }]]);
  const executor = { execute: jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT id, latest_draft_id') || sql.startsWith('SELECT id FROM ai_conversation')) {
      const row = conversations.get(params[0]);
      return [row?.userId === params[1] ? [{ id: params[0], latest_draft_id: row.latestDraftId }] : []];
    }
    if (sql.startsWith('INSERT INTO ai_message')) {
      const assistant = sql.includes("'assistant'"), hasDraft = sql.includes('draft_id');
      messages.push({ id: messages.length + 1, conversation_id: params[0], user_id: params[1],
        role: assistant ? 'assistant' : 'user', content: params[2], draft_id: hasDraft ? params[3] : null,
        meta: JSON.parse(params[assistant && hasDraft ? 4 : 3]), created_at: new Date(now) });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_conversation')) {
      if (params.length === 3 && params[0]) conversations.get(params[1]).latestDraftId = params[0];
      return [{ affectedRows: 1 }];
    }
    const owned = messages.filter(row => row.conversation_id === params[0] && row.user_id === params[1]);
    const boundaryRow = owned.slice().sort(compareMessageRows).findLast(row => row.role === 'user' && row.meta?.topicBoundary?.version === 1
      && row.meta.topicBoundary.kind === 'explicit-reset' && row.meta.topicBoundary.turnId === row.meta.turnId);
    const topicBoundary = boundaryRow ? { ...boundaryRow.meta.topicBoundary, messageId: boundaryRow.id, sentAt: messageSentAt(boundaryRow) } : null;
    const bounded = sql.includes('NOT EXISTS (SELECT 1 FROM ai_message boundary') && boundaryRow
      ? owned.filter(row => compareMessageRows(row, boundaryRow) >= 0) : owned;
    if (sql.startsWith('SELECT id FROM ai_message')) return [owned.filter(row => row.role === 'assistant'
      && [row.meta.requestId, row.meta.failure?.requestId, row.meta.business?.request?.requestId].includes(params[2])).slice(0, 1)];
    if (sql.startsWith('SELECT id, (SELECT JSON_OBJECT')) return [owned.length ? [{ id: owned.at(-1).id, topic_boundary: topicBoundary }] : []];
    if (sql.startsWith('SELECT id, role')) {
      if (sql.includes('AS topic_boundary')) {
        const rows = bounded.filter(row => !row.meta?.standalone).sort(compareMessageRows);
        const cutoff = rows.filter(row => row.role === 'user').slice(-params[4])[0];
        return [rows.filter(row => cutoff && compareMessageRows(row, cutoff) >= 0).slice().reverse()
          .map(row => ({ ...structuredClone(row), topic_boundary: JSON.stringify(topicBoundary) }))];
      }
      if (sql.includes('AND id > ?')) return [bounded.filter(row => row.id > params[2]).sort((a, b) => a.id - b.id)
        .slice(0, params[3]).map(row => structuredClone(row))];
      return [bounded.slice().sort((a, b) => a.id - b.id).slice(0, params[2]).map(row => structuredClone(row))];
    }
    if (sql.startsWith('SELECT id, meta')) {
      let rows = bounded.filter(row => row.role === 'assistant');
      if (sql.includes("'$.standalone'")) rows = rows.filter(row => !row.meta?.standalone);
      if (sql.includes("'$.business.pendingTransactions'")) rows = rows.filter(row => row.meta.business?.pendingTransactions);
      else if (sql.includes("'$.contextSummary'")) rows = rows.filter(row => row.meta.contextSummary);
      else if (sql.includes("'$.queryCoverage'")) rows = rows.filter(row => row.meta.queryCoverage || row.meta.queryContext?.lastResults);
      else if (sql.includes("'$.taskContexts'")) rows = rows.filter(row => row.meta.taskContexts || row.meta.taskContext);
      else if (sql.includes("'$.queryContext.activeQuery'")) rows = rows.filter(row => row.meta.queryContext?.activeQuery);
      else rows = rows.filter(row => row.meta.taskContext);
      return [rows.slice().sort(compareMessageRows).reverse().slice(0, sql.includes('LIMIT 1') && !sql.includes('LIMIT 20') ? 1 : 20).map(row => structuredClone(row))];
    }
    throw new Error(`Unexpected offline SQL: ${sql}`);
  }) };
  return { messages, conversations, executor, store: createConversationStore({ executor, now: () => now }) };
}

async function seedOld(f) {
  await f.store.append('owner', conversationId, { message: '9月支出', answer: '旧查询', requestId: oldTurn,
    ...finance(9, oldTurn), contextSummary: summary, business: { pendingTransactions: pending() }, draft: { id: 'existing-draft' } });
}
async function restored(f) {
  const store = createConversationStore({ executor: f.executor, now: () => now });
  return { store, open: await store.open('owner', conversationId, { historyLimit: 12 }),
    query: await store.loadQueryContext('owner', conversationId), task: await store.loadTaskContext('owner', conversationId),
    tasks: await store.loadTaskContexts('owner', conversationId), coverage: await store.loadQueryCoverage('owner', conversationId),
    summary: await store.loadContextSummary('owner', conversationId), pending: await store.loadPendingTransactionContext('owner', conversationId) };
}

test('an explicit reset prevents every conversational context loader from crossing the boundary after reload', async () => {
  const f = fixture(); await seedOld(f);
  expect(await f.store.loadPendingTransactionContext('owner', conversationId)).toMatchObject({ status: 'awaiting_input' });
  await f.store.append('owner', conversationId, { message: '忘记上面的内容，我们开启新的话题', answer: '好',
    requestId: resetTurn, topicBoundary: marker(resetTurn) });
  const state = await restored(f);
  expect(state.open.history.map(row => row.content)).toEqual(['忘记上面的内容，我们开启新的话题', '好']);
  expect(state.open.topicBoundary).toEqual({ ...marker(resetTurn), messageId: 3, sentAt: now });
  expect(state.open.latestDraftId).toBe('existing-draft');
  expect([state.query, state.task, state.summary, state.pending]).toEqual([null, null, null, null]);
  expect(state.tasks).toEqual({ version: 1, tasks: [] });
  expect(state.coverage).toEqual({ version: 1, results: [] });
  const contextReads = f.executor.execute.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, meta'));
  for (const [sql, params] of contextReads) {
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM ai_message boundary');
    expect(sql).toContain("'$.sentAt'");
    expect(sql).toContain('boundary.conversation_id = ai_message.conversation_id');
    expect(sql).toContain('boundary.user_id = ai_message.user_id');
    expect(sql).toContain("boundary.role = 'user'");
    expect(params).toEqual([conversationId, 'owner']);
  }
  const visible = await state.store.messages('owner', conversationId);
  expect(visible.map(row => row.content)).toEqual(['9月支出', '旧查询', '忘记上面的内容，我们开启新的话题', '好']);
  expect(f.executor.execute.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false);
});

test('a reset with a new query retains only the new task and query state', async () => {
  const f = fixture(); await seedOld(f);
  const fresh = finance(11, resetTurn);
  await f.store.append('owner', conversationId, { message: '忘记上面的内容。查11月支出', answer: '新查询',
    requestId: resetTurn, topicBoundary: marker(resetTurn), ...fresh });
  const state = await restored(f);
  expect(state.query.activeQuery).toMatchObject({ startDate: '2026-11-01', status: 'succeeded' });
  expect(state.task.scope).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
  expect(state.tasks.tasks).toHaveLength(1);
  expect(state.tasks.tasks[0].scope.startDate).toBe('2026-11-01');
  expect(state.coverage.results[0].effectiveScope.startDate).toBe('2026-11-01');
  expect(state.summary).toBeNull();
  expect(state.pending).toBeNull();
});

test('a failed reset still isolates prior tasks and keeps its own failure state', async () => {
  const f = fixture(); await seedOld(f);
  await f.store.appendFailure('owner', conversationId, { message: '开启新的话题。查11月支出', notice: '本轮失败',
    requestId: resetTurn, errorCode: 'AI_PROVIDER_TIMEOUT', topicBoundary: marker(resetTurn), ...finance(11, resetTurn) });
  const state = await restored(f);
  expect(state.open.history[1]).toMatchObject({ failure: { code: 'AI_PROVIDER_TIMEOUT' } });
  expect(state.query.activeQuery).toMatchObject({ startDate: '2026-11-01', status: 'failed' });
  expect(state.task).toMatchObject({ status: 'failed', turnId: resetTurn });
  expect(state.tasks.tasks).toHaveLength(1);
  expect(state.pending).toBeNull();
  expect(f.messages.filter(row => row.meta.topicBoundary).map(row => row.meta.topicBoundary)).toEqual([marker(resetTurn), marker(resetTurn)]);
});

test('a boundary remains discoverable after the reset text leaves the prose window', async () => {
  const f = fixture(); await seedOld(f);
  await f.store.append('owner', conversationId, { message: '换个话题', answer: '好', requestId: resetTurn, topicBoundary: marker(resetTurn) });
  for (let index = 0; index < 20; index++) await f.store.append('owner', conversationId, {
    message: `闲聊${index}`, answer: '好', requestId: `chat_${index}` });
  const state = await restored(f);
  expect(state.open.history.map(row => row.content)).not.toContain('换个话题');
  expect(state.open.topicBoundary).toEqual({ ...marker(resetTurn), messageId: 3, sentAt: now });
  expect(await state.store.loadTopicBoundary('owner', conversationId)).toEqual(state.open.topicBoundary);
  expect([state.query, state.task, state.summary, state.pending]).toEqual([null, null, null, null]);
});

test.each(['普通聊天', '记住这个偏好：如果我说“开启新的话题”，请简短回答', '不要开启新的话题', '如果我说开启新的话题会怎样'])
  ('payload markers cannot manufacture a reset from this user text: %s', async message => {
    const f = fixture(); await seedOld(f);
    await f.store.append('owner', conversationId, { message, answer: '答复', requestId: resetTurn, topicBoundary: marker(resetTurn) });
    expect(f.messages.slice(-2).some(row => row.meta.topicBoundary)).toBe(false);
    expect(await f.store.loadTopicBoundary('owner', conversationId)).toBeNull();
    expect((await f.store.loadQueryContext('owner', conversationId)).activeQuery.startDate).toBe('2026-09-01');
  });

test('a marker must bind the actual admitted turn and user text, including failure writes', async () => {
  const f = fixture(); await seedOld(f);
  await f.store.append('owner', conversationId, { message: '开启新的话题', answer: '好', requestId: resetTurn, topicBoundary: marker(oldTurn) });
  await f.store.appendFailure('owner', conversationId, { notice: '失败', requestId: 'failed_without_text', topicBoundary: marker('failed_without_text') });
  expect(f.messages.slice(2).some(row => row.meta.topicBoundary)).toBe(false);
  expect(await f.store.loadTopicBoundary('owner', conversationId)).toBeNull();
  expect(sanitizeTopicBoundary({ version: 1, kind: 'explicit-reset', turnId: 123 })).toBeNull();
});

test('another owner or conversation cannot contribute a boundary to context reads', async () => {
  const f = fixture(); await seedOld(f);
  f.messages.push({ id: 3, conversation_id: conversationId, user_id: 'other', role: 'user', content: '开启新的话题',
    meta: { turnId: resetTurn, topicBoundary: marker(resetTurn) } });
  f.messages.push({ id: 4, conversation_id: 'other-conversation', user_id: 'owner', role: 'user', content: '开启新的话题',
    meta: { turnId: resetTurn, topicBoundary: marker(resetTurn) } });
  expect(await f.store.loadTopicBoundary('owner', conversationId)).toBeNull();
  expect((await f.store.loadQueryContext('owner', conversationId)).activeQuery.startDate).toBe('2026-09-01');
  expect((await f.store.open('owner', conversationId)).history).toHaveLength(2);
});

test('an older failed request stored after a newer success retains its sent position and cannot replace latest state', async () => {
  const f = fixture(), first = now - 2000, second = now - 1000;
  await f.store.append('owner', conversationId, { message: '查11月支出', answer: '后发先完成', requestId: resetTurn,
    sentAt: second, ...finance(11, resetTurn) });
  await f.store.appendFailure('owner', conversationId, { message: '查9月支出', notice: '先发晚失败', requestId: oldTurn,
    sentAt: first, errorCode: 'AI_PROVIDER_TIMEOUT', ...finance(9, oldTurn), contextSummary: summary });
  const state = await restored(f);
  expect(state.open.history.map(row => row.content)).toEqual(['查9月支出', '先发晚失败', '查11月支出', '后发先完成']);
  expect(state.query.activeQuery.startDate).toBe('2026-11-01');
  expect(state.task.scope.startDate).toBe('2026-11-01');
  expect(state.tasks.tasks[0].scope.startDate).toBe('2026-11-01');
  expect((await f.store.messages('owner', conversationId)).map(row => row.requestId)).toEqual([oldTurn, oldTurn, resetTurn, resetTurn]);
  const incremental = await f.store.messagesSince('owner', conversationId, 0);
  expect(incremental.messages.map(row => row.messageId)).toEqual([3, 4, 1, 2]);
  expect(incremental.lastId).toBe(4);
  expect(incremental.messages.map(row => row.sentAt)).toEqual([first, first, second, second]);
});

test('a late old failure cannot cross a newer topic reset despite its larger message ID', async () => {
  const f = fixture();
  await f.store.append('owner', conversationId, { message: '开启新的话题', answer: '新话题', requestId: resetTurn,
    sentAt: now - 1000, topicBoundary: marker(resetTurn) });
  await f.store.appendFailure('owner', conversationId, { message: '今天买菜20元', notice: '旧请求晚失败', requestId: oldTurn,
    sentAt: now - 2000, errorCode: 'AI_PROVIDER_TIMEOUT', ...finance(9, oldTurn), contextSummary: summary,
    business: { pendingTransactions: pending() } });
  const state = await restored(f);
  expect(state.open.history.map(row => row.content)).toEqual(['开启新的话题', '新话题']);
  expect(state.open.topicBoundary).toEqual({ ...marker(resetTurn), messageId: 1, sentAt: now - 1000 });
  expect([state.query, state.task, state.summary, state.pending]).toEqual([null, null, null, null]);
  expect(state.tasks.tasks).toEqual([]);
  expect(state.coverage.results).toEqual([]);
});

test('a reset stored late cannot hide a query that was actually sent after it', async () => {
  const f = fixture();
  await f.store.append('owner', conversationId, { message: '查11月支出', answer: '后发查询', requestId: oldTurn,
    sentAt: now - 1000, ...finance(11, oldTurn) });
  await f.store.appendFailure('owner', conversationId, { message: '开启新的话题', notice: '新话题请求失败', requestId: resetTurn,
    sentAt: now - 2000, topicBoundary: marker(resetTurn), errorCode: 'AI_PROVIDER_TIMEOUT' });
  const state = await restored(f);
  expect(state.open.history.map(row => row.content)).toEqual(['开启新的话题', '新话题请求失败', '查11月支出', '后发查询']);
  expect(state.query.activeQuery.startDate).toBe('2026-11-01');
  expect(state.task.scope.startDate).toBe('2026-11-01');
  expect(state.open.topicBoundary.messageId).toBe(3);
});

test('the latest reset is selected by sent time even when an earlier reset is saved last', async () => {
  const f = fixture();
  await f.store.append('owner', conversationId, { message: '开启新的话题', answer: '较新断点', requestId: resetTurn,
    sentAt: now - 1000, topicBoundary: marker(resetTurn) });
  await f.store.append('owner', conversationId, { message: '换个话题', answer: '较旧断点晚存', requestId: oldTurn,
    sentAt: now - 2000, topicBoundary: marker(oldTurn) });
  expect((await f.store.open('owner', conversationId)).history.map(row => row.content)).toEqual(['开启新的话题', '较新断点']);
  expect((await f.store.loadTopicBoundary('owner', conversationId)).turnId).toBe(resetTurn);
});

test('source dates derive from request receipt time rather than a delayed next-day database insert', async () => {
  const f = fixture(), sentAt = Date.parse('2026-11-11T15:59:59Z');
  await f.store.appendFailure('owner', conversationId, { message: '昨天买菜20元', notice: '跨日失败', requestId: oldTurn,
    sentAt, errorCode: 'AI_PROVIDER_TIMEOUT' });
  const opened = await f.store.open('owner', conversationId);
  expect(opened.history[0]).toMatchObject({ sourceDate: '2026-11-11', sentAt });
  expect((await f.store.messages('owner', conversationId))[0].sentAt).toBe(sentAt);
});

test('equal sent timestamps preserve a stable message-ID order and old metadata falls back to its database date', async () => {
  const f = fixture();
  await f.store.append('owner', conversationId, { message: '第一条', answer: '第一答', requestId: oldTurn, sentAt: now });
  await f.store.append('owner', conversationId, { message: '第二条', answer: '第二答', requestId: resetTurn, sentAt: now });
  expect((await f.store.open('owner', conversationId)).history.map(row => row.content)).toEqual(['第一条', '第一答', '第二条', '第二答']);
  const legacy = { id: 50, created_at: new Date(now - 1000), meta: {} };
  expect(messageSentAt(legacy)).toBe(now - 1000);
  expect(messageSentAt({ ...legacy, meta: { sentAt: '123' } })).toBe(now - 1000);
});

test('a very late old failure does not consume a slot in the recent sent-time history window', async () => {
  const f = fixture();
  for (let index = 0; index < 6; index++) await f.store.append('owner', conversationId, {
    message: `新问题${index}`, answer: `新答复${index}`, requestId: `recent_${index}`, sentAt: now - 1000 + index });
  await f.store.appendFailure('owner', conversationId, { message: '很早的旧问题', notice: '很晚才存的失败',
    requestId: oldTurn, sentAt: now - 2000, errorCode: 'AI_PROVIDER_TIMEOUT' });
  const open = await f.store.open('owner', conversationId, { historyLimit: 4 });
  expect(open.history.map(row => row.content)).toEqual(['新问题2', '新答复2', '新问题3', '新答复3', '新问题4', '新答复4', '新问题5', '新答复5']);
  const sql = f.executor.execute.mock.calls.find(([query]) => query.includes('AS topic_boundary') && query.startsWith('SELECT id, role'))[0];
  expect(sql).toContain('ORDER BY sent_at DESC, id DESC LIMIT ?');
  expect(sql).toContain('recent_user.sent_at, recent_user.id');
});
