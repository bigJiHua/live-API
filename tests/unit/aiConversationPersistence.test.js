jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getConnection: jest.fn() }));
const db = require('../../src/common/config/db');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { createAiService } = require('../../src/modules/ai/service');

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
  expect(db.execute.mock.calls[1][1]).toEqual(['conversation', 'owner', 10]);
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
  const service = createAiService({ env: { AI_MODE: 'deepseek', NODE_ENV: 'test', DEEPSEEK_API_KEY: 'unit-key',
    AI_DB_HOST: 'not-connected', AI_DB_NAME: 'unit', AI_DB_USER: 'readonly', AI_DB_PASSWORD: 'unit' },
    repository: {}, chat: async () => ({ role: 'assistant', content: 'answer' }), conversationStore });
  let returned = false;
  const run = service.run('owner', { scene: 'chat', message: 'query', consent: true }).then(result => { returned = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  expect(conversationStore.append).toHaveBeenCalledTimes(1);
  expect(returned).toBe(false);
  finish();
  expect((await run).answer).toBe('answer');
  await service.close();
});
