jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));
const { createHistoryReader } = require('../../src/modules/ai/service/historyReader');
const make = rows => {
  const executor = { execute: jest.fn().mockResolvedValue([rows]) };
  return { executor, reader: createHistoryReader({ executor }) };
};

test('history search binds owner and conversation and treats LIKE metacharacters as literal text', async () => {
  const { reader, executor } = make([]);
  expect(await reader.search('owner', 'conversation', { query: ' 100%_! ', limit: 3 })).toEqual([]);
  const [sql, params] = executor.execute.mock.calls[0];
  expect(sql).toContain('WHERE user_id = ? AND conversation_id = ?');
  expect(sql).toContain("content LIKE ? ESCAPE '!'");
  expect(sql).toContain("JSON_EXTRACT(meta, '$.standalone')");
  expect(sql).toContain('ORDER BY id DESC LIMIT ?');
  expect(params).toEqual(['owner', 'conversation', '%100!%!_!!%', 3]);
});

test('SQL-looking history queries remain bound data and cannot change ownership predicates', async () => {
  const { reader, executor } = make([]);
  const query = "' OR user_id <> 'owner' --";
  await reader.search('owner', 'conversation', { query });
  const [sql, params] = executor.execute.mock.calls[0];
  expect(sql).not.toContain(query);
  expect(params).toEqual(['owner', 'conversation', "%' OR user!_id <> 'owner' --%", 5]);
});

test.each([undefined, null, {}, [], { query: '' }, { query: '字'.repeat(81) }, { query: '卡片', limit: 0 },
  { query: '卡片', limit: 11 }, { query: '卡片', limit: '5' }, { query: '卡片', userId: 'other' }])
  ('invalid history search parameters never reach the executor: %j', async input => {
    const { reader, executor } = make([]);
    await expect(reader.search('owner', 'conversation', input)).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

test.each([[null, 'conversation'], ['owner', ''], [' '.repeat(3), 'conversation'], ['owner', '字'.repeat(65)]])
  ('invalid owner/conversation inputs are rejected before any read: %j', async (owner, conversation) => {
    const { reader, executor } = make([]);
    await expect(reader.search(owner, conversation, { query: '卡片' })).rejects.toMatchObject({ code: 'AI_REQUEST_INVALID' });
    await expect(reader.loadSummary(owner, conversation)).rejects.toMatchObject({ code: 'AI_REQUEST_INVALID' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

test('history rows expose bounded original text and dates without database IDs or failure credentials', async () => {
  const { reader } = make([
    { id: 'private_id', role: 'user', content: '字'.repeat(5000), created_at: '2026-11-07T17:00:00.000Z', meta: '{}' },
    { id: 'private_reply', role: 'assistant', content: '失败通知', created_at: 'invalid',
      meta: JSON.stringify({ failure: { code: 'AI_PROVIDER_TIMEOUT', apiKey: 'private_key' } }) },
    { id: 'private_legacy', role: 'assistant', content: '旧回答', created_at: null, meta: '{broken' },
  ]);
  const rows = await reader.search('owner', 'conversation', { query: '原话' });
  expect(rows[0]).toEqual({ role: 'user', text: '字'.repeat(4000), sourceDate: '2026-11-08', sourceTime: '2026-11-07T17:00:00.000Z', status: 'original' });
  expect(rows[1]).toEqual({ role: 'assistant', text: '失败通知', sourceDate: null, status: 'failed' });
  expect(rows[2]).toEqual({ role: 'assistant', text: '旧回答', sourceDate: null, status: 'completed' });
  expect(JSON.stringify(rows)).not.toMatch(/private_id|private_reply|private_legacy|private_key/);
});

test('earliest completed articles use bounded ascending retrieval and exclude questions and failed notices', async () => {
  const { reader, executor } = make([]);
  await reader.search('owner', 'conversation', { query: '文章', order: 'oldest', role: 'assistant', status: 'completed', limit: 2 });
  const [sql, params] = executor.execute.mock.calls[0];
  expect(sql).toContain('WHERE user_id = ? AND conversation_id = ?');
  expect(sql).toContain('role = ?');
  expect(sql).toContain("JSON_EXTRACT(meta, '$.failure') IS NULL");
  expect(sql).toContain('ORDER BY id ASC LIMIT ?');
  expect(params).toEqual(['owner', 'conversation', '%文章%', 'assistant', 2]);
});

test('failed history selection and latest order use fixed SQL rather than caller SQL', async () => {
  const { reader, executor } = make([]);
  await reader.search('owner', 'conversation', { query: '文章', order: 'latest', status: 'failed' });
  const [sql, params] = executor.execute.mock.calls[0];
  expect(sql).toContain("role = 'assistant'");
  expect(sql).toContain("JSON_EXTRACT(meta, '$.failure') IS NOT NULL");
  expect(sql).toContain('ORDER BY id DESC LIMIT ?');
  expect(params).toEqual(['owner', 'conversation', '%文章%', 5]);
});
test('history truncation never cuts an emoji into an unpaired surrogate', async () => {
  const { reader } = make([{ role: 'user', content: '字'.repeat(3999) + '🙂', created_at: null, meta: null }]);
  const rows = await reader.search('owner', 'conversation', { query: '字' });
  expect(rows[0].text).toBe('字'.repeat(3999));
  expect(JSON.stringify(rows)).not.toMatch(/\\ud[89ab][0-9a-f]{2}|\\ud[cdef][0-9a-f]{2}|�/i);
});

test('summary restore skips corrupt metadata and remains independently scoped beyond the prose window', async () => {
  const summary = { version: 1, items: [{ text: '此前要卡片数量饼图', sourceDate: '2026-11-08', status: 'completed' }], truncated: true };
  const { reader, executor } = make([{ meta: '{broken' }, { meta: { contextSummary: { version: 2, items: [] } } },
    { meta: JSON.stringify({ contextSummary: summary }) }]);
  expect(await reader.loadSummary('owner', 'conversation')).toEqual(summary);
  const [sql, params] = executor.execute.mock.calls[0];
  expect(params).toEqual(['owner', 'conversation']);
  expect(sql).toContain("role = 'assistant'");
  expect(sql).toContain("JSON_EXTRACT(meta, '$.standalone')");
  expect(sql).toContain('ORDER BY id DESC LIMIT 20');
});

test('summary restore returns null when no valid saved summary exists', async () => {
  const { reader } = make([{ meta: { contextSummary: { version: 1, items: [], truncated: 'wrong' } } }]);
  expect(await reader.loadSummary('owner', 'conversation')).toBeNull();
});
