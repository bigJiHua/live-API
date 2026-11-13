jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore } = require('../../src/modules/ai/service/memoryStore');
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const owner = 'offline-memory-owner';
const oldRecord = '我喜欢蓝色。';
const remainingRecord = '我不喜欢噪音。';
const deletionRequest = '请删除关于蓝色的记忆。';
let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'v3-memory-empty-patch-replay-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function setup() {
  const memoryStore = createMemoryStore({ root, now });
  const before = await memoryStore.write(owner, { path: 'preferences.md', operation: 'create', title: '偏好', type: 'preference',
    content: `${oldRecord}\n\n${remainingRecord}`, sourceText: oldRecord });
  const patch = (quote = deletionRequest, overrides = {}) => ({ path: before.path, operation: 'patch', title: before.title,
    type: before.type, content: '', expectedRevision: before.revision, oldText: oldRecord,
    evidence: { sourceTurn: 0, quote }, reason: '按用户要求修改已读取的完整记忆记录', ...overrides });
  return { memoryStore, before, patch };
}
const payload = f => JSON.parse(f.provider.mock.calls.at(-1)[1].findLast(message => message.role === 'tool').content);
async function unchanged(s, f, code) {
  expect(payload(f)).toMatchObject({ status: 'error', code });
  expect(await s.memoryStore.read(owner, { path: s.before.path })).toMatchObject({ revision: s.before.revision, content: s.before.content });
  expect(f.repository.query).not.toHaveBeenCalled();
}

test('empty patch deletes only the complete requested record after a matching current-turn read', async () => {
  const s = await setup();
  const answer = '已删除记忆中的蓝色偏好，其他内容保留。';
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch()),
    final({ answer })], { memoryStore: s.memoryStore });
  const result = await f.send(deletionRequest);
  expect(result.answer).toBe(answer);
  expect(payload(f)).toMatchObject({ status: 'saved', path: s.before.path, changed: true, partialDeleted: true });
  const after = await s.memoryStore.read(owner, { path: s.before.path });
  expect(after.content.trim()).toBe(remainingRecord);
  expect(after.revision).not.toBe(s.before.revision);
  expect(f.repository.query).not.toHaveBeenCalled();
});

test.each(['已删除整个记忆文件 preferences.md。', '全部记忆已删除。'])
  ('a real partial deletion cannot support a whole-memory reply: %s', async answer => {
    const s = await setup();
    const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch()),
      final({ answer })], { memoryStore: s.memoryStore });
    const result = await f.send(deletionRequest);
    expect(result.answer).toContain('本轮未确认删除长期记忆');
    expect((await s.memoryStore.read(owner, { path: s.before.path })).content.trim()).toBe(remainingRecord);
  });

test('a real partial deletion does not authorize a shared ledger deletion and failed history reports the committed partial effect', async () => {
  const s = await setup();
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch()),
    final({ answer: '已删除记忆中的蓝色偏好和账本。' })], { memoryStore: s.memoryStore });
  await expect(f.send(deletionRequest)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH',
    message: expect.stringContaining('部分记忆修改已生效') });
  expect((await s.memoryStore.read(owner, { path: s.before.path })).content.trim()).toBe(remainingRecord);
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledWith(owner, f.conversationId,
    expect.objectContaining({ notice: expect.stringContaining('文件中的其他内容保留') }));
  expect(f.history.at(-1).content).toContain('部分记录');
  expect(f.history.at(-1).content).not.toContain('已删除 1 条长期记忆');
  expect(f.repository.query).not.toHaveBeenCalled();
});

test.each(['请保存我的新偏好。', '不要删除关于蓝色的记忆。', '告诉我删除关于蓝色的记忆会怎样。'])
  ('a non-deletion current request cannot authorize empty patch: %s', async message => {
    const s = await setup();
    const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch(message)),
      final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
    await f.send(message);
    await unchanged(s, f, 'AI_MEMORY_DELETE_NOT_REQUESTED');
  });

test('an earlier user deletion request cannot authorize empty patch in a save-only current turn', async () => {
  const s = await setup();
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch()),
    final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
  f.history.push({ role: 'user', content: deletionRequest });
  await f.send('请保存我的新偏好。');
  await unchanged(s, f, 'AI_MEMORY_DELETE_NOT_REQUESTED');
});

test('empty patch evidence must bind the latest turn even if both user turns request deletion', async () => {
  const s = await setup();
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch()),
    final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
  f.history.push({ role: 'user', content: deletionRequest });
  await f.send(deletionRequest);
  await unchanged(s, f, 'AI_MEMORY_DELETE_NOT_REQUESTED');
});

test.each([' \n\t ', '> \n> '])('formatting-only content cannot bypass the empty patch deletion guard', async content => {
  const s = await setup();
  const message = '请保存我的新偏好。';
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch(message, { content })),
    final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
  await f.send(message);
  await unchanged(s, f, 'AI_MEMORY_DELETE_NOT_REQUESTED');
});

test('even a valid historical user deletion reference cannot authorize empty patch', async () => {
  const s = await setup();
  const historyReader = { loadSummary: jest.fn(async () => null), search: jest.fn(async () => [
    { role: 'user', text: deletionRequest, sourceDate: '2026-10-01', status: 'original' }]) };
  const fromHistory = (_, messages) => {
    const reference = JSON.parse(messages.findLast(message => message.role === 'tool').content).matches[0].ref;
    return calls('memory_write', s.patch(deletionRequest, { evidence: { historyRef: reference, quote: deletionRequest } }));
  };
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('history_search', { query: '蓝色' }), fromHistory,
    final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore, historyReader });
  await f.send('查找历史偏好，只保存新的偏好。');
  await unchanged(s, f, 'AI_MEMORY_ARGUMENT_INVALID');
});

test('a correct revision obtained outside this turn cannot authorize empty patch without a read receipt', async () => {
  const s = await setup();
  const f = fixture([calls('memory_write', s.patch()), final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
  await f.send(deletionRequest);
  await unchanged(s, f, 'AI_MEMORY_REVISION_REQUIRED');
});

test('empty patch rejects a supplied revision that differs from the current-turn read receipt', async () => {
  const s = await setup();
  const f = fixture([calls('memory_read', { path: s.before.path }), calls('memory_write', s.patch(deletionRequest,
    { expectedRevision: '0'.repeat(64) })), final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
  await f.send(deletionRequest);
  await unchanged(s, f, 'AI_MEMORY_REVISION_REQUIRED');
});

test('a different file read cannot authorize empty patch even if both files share a revision', async () => {
  const s = await setup();
  const other = await s.memoryStore.write(owner, { path: 'other.md', operation: 'create', title: '偏好', type: 'preference',
    content: `${oldRecord}\n\n${remainingRecord}`, sourceText: oldRecord });
  expect(other.revision).toBe(s.before.revision);
  const f = fixture([calls('memory_read', { path: other.path }), calls('memory_write', s.patch()),
    final({ answer: '这条记忆保留原状。' })], { memoryStore: s.memoryStore });
  await f.send(deletionRequest);
  await unchanged(s, f, 'AI_MEMORY_REVISION_REQUIRED');
});

test('a concurrent memory update after the read remains intact when empty patch has a stale revision', async () => {
  const s = await setup();
  let updated;
  const racedPatch = async () => {
    updated = await s.memoryStore.write(owner, { path: s.before.path, operation: 'replace',
      expectedRevision: s.before.revision, content: `${oldRecord}\n\n${remainingRecord}\n\n我现在喜欢圆形。`, sourceText: '我现在喜欢圆形。' });
    return calls('memory_write', s.patch());
  };
  const f = fixture([calls('memory_read', { path: s.before.path }), racedPatch,
    final({ answer: '记忆保留当前版本。' })], { memoryStore: s.memoryStore });
  await f.send(deletionRequest);
  expect(payload(f)).toMatchObject({ status: 'error', code: 'AI_MEMORY_CONFLICT' });
  expect(await s.memoryStore.read(owner, { path: s.before.path })).toMatchObject({ revision: updated.revision, content: updated.content });
});

test('non-empty patch retains ordinary user-source modification semantics', async () => {
  const s = await setup();
  const message = '我现在更喜欢绿色。';
  const f = fixture([calls('memory_write', s.patch(message, { content: message })),
    final({ answer: '已保存记忆的修改。' })], { memoryStore: s.memoryStore });
  await f.send(message);
  expect(payload(f)).toMatchObject({ status: 'saved', path: s.before.path });
  expect(payload(f).partialDeleted).toBeUndefined();
  const after = await s.memoryStore.read(owner, { path: s.before.path });
  expect(after.content).toContain(message);
  expect(after.content).toContain(remainingRecord);
  expect(after.content).not.toContain(oldRecord);
});
