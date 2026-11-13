jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Database forbidden'); }) }));
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { buildTaskContext } = require('../../src/modules/ai/service/taskContext');
const make = () => {
  const executor = { execute: jest.fn(async sql => sql.startsWith('SELECT id FROM ai_conversation') ? [[{ id: 'conversation' }]]
    : sql.startsWith('SELECT id FROM ai_message') ? [[]] : [{ affectedRows: 1 }]) };
  return { executor, store: createConversationStore({ executor }) };
};
test('task preferences persist on metadata while unrelated business fields remain unchanged', async () => {
  const { store, executor } = make();
  const taskContext = buildTaskContext({ message: '借记卡信用卡数量比例饼图', today: '2026-11-08' });
  await store.append('owner', 'conversation', { message: '查询', answer: '已查询', requestId: 'pie_turn', taskContext, business: { datasets: [] } });
  const insert = executor.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  const meta = JSON.parse(insert[1][4]);
  expect(meta.taskContext).toMatchObject({ turnId: 'pie_turn', status: 'succeeded', subject: 'cards', metric: 'card-count', chartRequest: { type: 'pie', metric: 'count' } });
  expect(meta.business).toEqual({ datasets: [] });
});
test('failed task saves the requested chart for retry', async () => {
  const { store, executor } = make();
  const taskContext = buildTaskContext({ message: '借记卡信用卡数量比例饼图', today: '2026-11-08' });
  await store.appendFailure('owner', 'conversation', { message: '查询', requestId: 'failed_pie', errorCode: 'AI_PROVIDER_RATE_LIMIT', taskContext });
  const insert = executor.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  expect(JSON.parse(insert[1][3]).taskContext).toMatchObject({ turnId: 'failed_pie', status: 'failed', metric: 'card-count', chartRequest: { type: 'pie', metric: 'count' } });
});
test('task restore is independently owner scoped beyond the history window', async () => {
  const { store, executor } = make();
  const taskContext = buildTaskContext({ message: '借记卡信用卡数量比例饼图', today: '2026-11-08' });
  executor.execute.mockResolvedValueOnce([[{ id: 30, meta: { taskContext } }]]);
  expect((await store.loadTaskContext('owner', 'conversation')).metric).toBe('card-count');
  expect(executor.execute.mock.calls[0][1]).toEqual(['conversation', 'owner']);
  expect(executor.execute.mock.calls[0][0]).toContain('user_id = ?');
});
test('history SQL excludes standalone operation cards before its bounded window', async () => {
  const { store, executor } = make();
  executor.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: null }]]).mockResolvedValueOnce([[]]);
  await store.open('owner', 'conversation');
  expect(executor.execute.mock.calls[1][0]).toContain("JSON_EXTRACT(meta, '$.standalone')");
  expect(executor.execute.mock.calls[1][1]).toEqual(['conversation', 'owner', 'conversation', 'owner', 4]);
  expect(executor.execute.mock.calls[1][0]).toContain("role = 'user' ORDER BY sent_at DESC, id DESC LIMIT ?");
});
test('awaiting-input task status is preserved by a successful clarification message', async () => {
  const { store, executor } = make();
  const taskContext = { ...buildTaskContext({ message: '买菜30元', today: '2026-11-08' }), status: 'awaiting_input' };
  await store.append('owner', 'conversation', { message: '买菜30元', answer: '请补账户', requestId: 'missing_account', taskContext });
  const insert = executor.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO ai_message') && sql.includes("'assistant'"));
  expect(JSON.parse(insert[1][4]).taskContext.status).toBe('awaiting_input');
});
test('local history restores at most three actual draft identities without adding them to model history', async () => {
  const { store, executor } = make();
  executor.execute.mockResolvedValueOnce([[{ id: 'conversation', latest_draft_id: 'draft_one' }]])
    .mockResolvedValueOnce([[{ id: 12, role: 'assistant', content: '三笔草稿', draft_id: 'draft_one',
      meta: { turnId: 'three_drafts', business: { draftIds: ['draft_one', 'draft_two', 'draft_three'] } } },
    { id: 11, role: 'user', content: '三笔消费', meta: { turnId: 'three_drafts' } }]]);
  const history = (await store.open('owner', 'conversation')).history;
  expect(history[1].draftIds).toEqual(['draft_one', 'draft_two', 'draft_three']);
  const { selectHistoryTurns } = require('../../src/modules/ai/service/historyContext');
  expect(JSON.stringify(selectHistoryTurns(history))).not.toMatch(/draft_one|draft_two|draft_three/);
});
