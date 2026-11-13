jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore } = require('../../src/modules/ai/service/memoryStore');
const { createPersonalizationStore } = require('../../src/modules/ai/service/personalizationStore');
const { createMemoryManagementService } = require('../../src/modules/ai/service/memoryManagement');
const { createContextMemoryStore } = require('../../src/modules/ai/service/personalizationContext');
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const owner = 'offline-memory-owner';
let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'v3-personalization-replay-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const taskInput = (f, round = 0) => JSON.parse(f.provider.mock.calls[round][1].find(message => message.role === 'user').content.replace(/^TASK_INPUT:\n/, ''));
const plain = content => ({ role: 'assistant', content });
async function setup() {
  const personalizationStore = createPersonalizationStore({ root: path.join(root, 'personalization'), now });
  const memoryStore = createMemoryStore({ root: path.join(root, 'memory'), now });
  const memories = createMemoryManagementService({ memoryStore, personalizationStore, now });
  const contextMemory = createContextMemoryStore({ memoryStore, personalizationStore, memoryManagement: memories });
  return { personalizationStore, memoryStore, memories, contextMemory };
}
const update = async (store, values) => store.update(owner, { expectedRevision: (await store.get(owner)).revision, ...values });

test('saved English rule reaches a plain Chinese question without language recovery or new data authorization', async () => {
  const s = await setup();
  await update(s.personalizationStore, { rules: [{ id: 'english', text: '请用英文回答', enabled: true }] });
  const grants = { get: jest.fn(async () => ({ granted: false })), requireCoverage: jest.fn(async (_, __, ___, control) => {
    if (control.access) throw new Error('Personal response rules must not require private data authorization');
  }) };
  const answer = 'This assistant can explain your preferences and help you organize useful information in a clear way.';
  const f = fixture([plain(answer)], { memoryStore: s.contextMemory, personalizationStore: s.personalizationStore, grants });
  const result = await f.send('你好，请介绍一下功能', { mode: 'chat' });
  expect(taskInput(f).responseLanguage).toBe('en');
  expect(taskInput(f).personalization.rules).toEqual([{ text: '请用英文回答' }]);
  expect(result.answer).toContain('This assistant');
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.repository.query).not.toHaveBeenCalled();
  expect(grants.requireCoverage.mock.calls.every(([, , , control]) => !control.access)).toBe(true);
});

test.each([false, true])('rule-only ordinary chat remains available with a rejecting session grant (stored profile=%s)', async storedProfile => {
  const s = await setup();
  await update(s.personalizationStore, { rules: [{ id: 'brief', text: '先给结论', enabled: true }],
    ...(storedProfile ? { profile: { items: [{ id: 'private_profile', category: 'likes', text: '喜欢用图表分析预算',
      origin: 'user', confirmed: true, evidence: [], updatedAt: now().toISOString() }], updatedAt: null, historyCursor: 0 } } : {}) });
  const grants = { get: jest.fn(async () => ({ granted: false })), requireCoverage: jest.fn(async (_, __, ___, control) => {
    if (control.access || control.conversationId) throw Object.assign(new Error('Data authorization rejected'), { code: 'AI_GRANT_REQUIRED' });
  }) };
  const f = fixture([plain('结论：可以先介绍主要功能，再补充你关心的细节。')], {
    memoryStore: s.contextMemory, personalizationStore: s.personalizationStore, grants });
  const result = await f.send('可以怎样介绍功能？', { mode: 'chat' });
  expect(result.answer).toContain('结论');
  expect(taskInput(f).personalization.rules).toEqual([{ text: '先给结论' }]);
  expect(taskInput(f).personalization.profile).toEqual([]);
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.repository.query).not.toHaveBeenCalled();
});

test('the current turn explicit Chinese instruction overrides an enabled English rule', async () => {
  const s = await setup();
  await update(s.personalizationStore, { rules: [{ id: 'english', text: '请用英文回答', enabled: true }] });
  const f = fixture([plain('这次用中文介绍：你可以查看记忆、修改画像，并设置回答规则。')], {
    memoryStore: s.contextMemory, personalizationStore: s.personalizationStore,
    grants: { get: jest.fn(async () => ({ granted: false })), requireCoverage: jest.fn(async () => {}) } });
  const result = await f.send('这次请用中文回答，介绍一下功能。', { mode: 'chat' });
  expect(taskInput(f).responseLanguage).toBe('zh');
  expect(result.answer).toContain('这次用中文');
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test.each([
  ['解释代码时用英文回答，财务问题用中文回答。', '请解释这个代码的用途', 'This code stores the current value and returns the previous value when the caller requests it.'],
  ['用英文回答。先给结论，再解释关键原因。', '请介绍主要功能', 'The main feature helps you review saved information and adjust how the assistant responds to your questions.'],
  ['默认用英文回答，但财务问题用中文回答。', '帮我介绍预算功能', '预算功能可以帮助你规划支出，并在复盘时查看实际收支。'],
])('scoped and multi-sentence language rules reach provider without a default-language recovery round', async (rule, message, answer) => {
  const s = await setup();
  await update(s.personalizationStore, { rules: [{ id: 'contextual_language', text: rule, enabled: true }] });
  const f = fixture([plain(answer)], { memoryStore: s.contextMemory, personalizationStore: s.personalizationStore,
    grants: { get: jest.fn(async () => ({ granted: false })), requireCoverage: jest.fn(async () => {}) } });
  const result = await f.send(message, { mode: 'chat' });
  expect(taskInput(f).responseLanguage).toBeNull();
  expect(taskInput(f).personalization.rules).toEqual([{ text: rule }]);
  expect(result.answer).toBe(answer);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('an explicit current Chinese language requirement remains enforceable with a scoped English rule', async () => {
  const s = await setup();
  await update(s.personalizationStore, { rules: [{ id: 'code_english', text: '解释代码时用英文回答，财务问题用中文回答。', enabled: true }] });
  const f = fixture([plain('这次用中文说明代码：它把当前值保存下来，供下一次调用使用。')], {
    memoryStore: s.contextMemory, personalizationStore: s.personalizationStore,
    grants: { get: jest.fn(async () => ({ granted: false })), requireCoverage: jest.fn(async () => {}) } });
  await f.send('这次请用中文回答，解释代码的用途。', { mode: 'chat' });
  expect(taskInput(f).responseLanguage).toBe('zh');
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('tool-driven finalization does not reintroduce a detected Chinese instruction over a scoped English rule', async () => {
  const s = await setup();
  await update(s.personalizationStore, { rules: [{ id: 'code_english', text: '解释代码时用英文回答，财务问题用中文回答。', enabled: true }] });
  await s.memories.create(owner, { title: '代码说明偏好', type: 'preference', content: '解释代码时请说明它如何保存数据。' });
  const answer = 'The saved preference asks for an explanation of how the code stores data and keeps values available for later use.';
  const f = fixture([calls('memory_list', {}), plain(answer)], {
    memoryStore: s.contextMemory, personalizationStore: s.personalizationStore,
    grants: { get: jest.fn(async () => ({ granted: true, providerHost: 'fixture.invalid', access: 'read' })), requireCoverage: jest.fn(async () => {}) } });
  await f.send('查看记忆后解释代码的用途', { mode: 'chat' });
  expect(taskInput(f).responseLanguage).toBeNull();
  expect(f.provider).toHaveBeenCalledTimes(2);
  const finalMessages = f.provider.mock.calls[1][1];
  expect(finalMessages.at(-1).content).not.toContain('本轮 answer 使用中文');
  expect(finalMessages.some(message => message.content?.includes('wrong response language'))).toBe(false);
});

test('confirmed profile is prioritized in paid request context and omitted when profile use is disabled', async () => {
  const s = await setup();
  const items = Array.from({ length: 31 }, (_, index) => ({ id: `profile_${index}`, category: 'communication',
    text: index === 30 ? '用户确认先给结论' : `暂定画像第${index}条`, origin: index === 30 ? 'user' : 'ai',
    confirmed: index === 30, evidence: [{ quote: '我喜欢先看结论' }], updatedAt: now().toISOString() }));
  await update(s.personalizationStore, { profile: { items, updatedAt: null, historyCursor: 0 } });
  const grants = { get: jest.fn(async () => ({ granted: true, providerHost: 'fixture.invalid', access: 'read' })), requireCoverage: jest.fn(async () => {}) };
  const first = fixture([plain('我会先说明主要结论。')], { memoryStore: s.contextMemory, personalizationStore: s.personalizationStore, grants });
  await first.send('怎样安排回答比较好？', { mode: 'chat' });
  expect(taskInput(first).personalization.profile[0]).toMatchObject({ origin: 'user', confirmed: true });
  expect(taskInput(first).personalization.profile).toHaveLength(30);
  expect(taskInput(first).personalization.profileTruncated).toBe(true);
  await update(s.personalizationStore, { settings: { useProfile: false } });
  const second = fixture([plain('可以先列出主要安排。')], { memoryStore: s.contextMemory, personalizationStore: s.personalizationStore, grants });
  await second.send('怎样安排回答比较好？', { mode: 'chat' });
  expect(taskInput(second).personalization.profile).toEqual([]);
  expect(taskInput(second).personalization.profileEnabled).toBe(false);
});

test('disabled memory is absent from initialization and a direct context-tool read cannot reveal it', async () => {
  const s = await setup();
  const memory = await s.memories.create(owner, { title: '回答偏好', type: 'preference', content: '只在介绍技术方案时先给结论。' });
  await update(s.personalizationStore, { disabledMemories: [memory.path] });
  const f = fixture([calls('memory_read', { path: memory.path }), final({ answer: '这条记忆已停用，无法读取。' })], {
    memoryStore: s.contextMemory, personalizationStore: s.personalizationStore });
  await f.send('读取我的回答偏好记忆');
  expect(taskInput(f).memoryIndex.files).toEqual([]);
  const payload = JSON.parse(f.provider.mock.calls[1][1].findLast(message => message.role === 'tool').content);
  expect(payload).toMatchObject({ status: 'error', code: 'AI_MEMORY_DISABLED' });
  expect(payload.content).toBeUndefined();
  expect(f.repository.query).not.toHaveBeenCalled();
});

test('global memory opt-out removes read, write and delete tools and successful chat schedules profile refresh', async () => {
  const s = await setup();
  await update(s.personalizationStore, { settings: { useMemory: false } });
  const profileGeneration = { maybeGenerate: jest.fn(async () => null) };
  const f = fixture([plain('可以继续讨论你的问题。')], { memoryStore: s.contextMemory,
    personalizationStore: s.personalizationStore, profileGeneration,
    grants: { get: jest.fn(async () => ({ granted: false })), requireCoverage: jest.fn(async () => {}) } });
  await f.send('先聊聊功能设计', { mode: 'chat' });
  const names = f.provider.mock.calls[0][2].map(tool => tool.function.name);
  expect(names).not.toEqual(expect.arrayContaining(['memory_read']));
  expect(names).not.toEqual(expect.arrayContaining(['memory_write']));
  expect(names).not.toEqual(expect.arrayContaining(['memory_delete']));
  expect(names.some(name => name.startsWith('memory_'))).toBe(false);
  expect(taskInput(f).memoryIndex.files).toEqual([]);
  expect(taskInput(f).personalization.memoryEnabled).toBe(false);
  await new Promise(resolve => setImmediate(resolve));
  expect(profileGeneration.maybeGenerate).toHaveBeenCalledTimes(1);
  expect(profileGeneration.maybeGenerate).toHaveBeenCalledWith(owner);
});

test('whole memory deletion dispatch uses the current read revision and persists the actual deleted receipt', async () => {
  const s = await setup();
  const memory = await s.memories.create(owner, { title: '回答偏好', type: 'preference', content: '方案解释优先简洁。' });
  const deletion = jest.fn((...args) => s.memories.remove(...args));
  const second = (_, messages) => {
    const read = JSON.parse(messages.findLast(message => message.role === 'tool').content);
    const input = JSON.parse(messages.find(message => message.role === 'user').content.replace(/^TASK_INPUT:\n/, ''));
    return calls('memory_delete', { path: memory.path, expectedRevision: read.revision,
      evidence: { sourceTurn: input.currentTurn, quote: input.userTurns[input.currentTurn] }, reason: '用户本轮明确删除已读取的记忆' });
  };
  const f = fixture([calls('memory_read', { path: memory.path }), second, final({ answer: '已删除这条长期记忆。' })], {
    memoryStore: s.contextMemory, personalizationStore: s.personalizationStore, memoryDeletion: deletion });
  const result = await f.send(`请删除记忆 ${memory.path}。`);
  expect(deletion).toHaveBeenCalledWith(owner, memory.path, { expectedRevision: memory.revision }, expect.objectContaining({ signal: undefined }));
  const payload = JSON.parse(f.provider.mock.calls[2][1].findLast(message => message.role === 'tool').content);
  expect(payload).toMatchObject({ status: 'deleted', deleted: true, path: memory.path });
  await expect(s.memoryStore.read(owner, { path: memory.path })).rejects.toMatchObject({ code: 'AI_MEMORY_NOT_FOUND' });
  expect((await s.personalizationStore.get(owner)).deletedMemories).toContain(memory.path);
  expect(result.answer).toMatch(/删除/);
});
