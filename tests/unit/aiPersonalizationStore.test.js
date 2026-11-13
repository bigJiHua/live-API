const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPersonalizationStore } = require('../../src/modules/ai/service/personalizationStore');
const { createMemoryStore } = require('../../src/modules/ai/service/memoryStore');
const { createMemoryManagementService } = require('../../src/modules/ai/service/memoryManagement');

let root, store, memory, management;
const clock = () => new Date('2026-11-12T08:00:00.000Z');
const item = (extra = {}) => ({ id: 'profile_test', category: 'communication', text: '回答简洁。', origin: 'ai',
  confirmed: false, evidence: [{ quote: '请回答简洁。' }], ...extra });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-personalization-test-'));
  store = createPersonalizationStore({ root: path.join(root, 'personalization'), now: clock });
  memory = createMemoryStore({ root: path.join(root, 'memory'), now: clock });
  management = createMemoryManagementService({ personalizationStore: store, memoryStore: memory, now: clock });
});
afterEach(async () => {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ai-personalization-test-')) throw new Error('Unsafe cleanup');
  await fs.rm(root, { recursive: true, force: true });
});

test('first read is side-effect free, user settings persist and remain owner bound', async () => {
  const initial = await store.get('owner-a');
  expect(initial).toMatchObject({ contractVersion: 1, rules: [], settings: { useMemory: true, useProfile: true, autoProfile: true } });
  expect(await fs.readdir(root)).toEqual([]);
  const saved = await store.update('owner-a', { expectedRevision: initial.revision, rules: [{ id: 'rule_one', text: '先回答结论。', enabled: true }] });
  expect(saved.revision).not.toBe(initial.revision);
  const reopened = createPersonalizationStore({ root: path.join(root, 'personalization'), now: clock });
  expect((await reopened.get('owner-a')).rules).toEqual(saved.rules);
  expect((await reopened.get('owner-b')).rules).toEqual([]);
  await expect(store.update('owner-a', { expectedRevision: initial.revision, rules: [] })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_CONFLICT', status: 409 });
});

test('unknown permission fields and malformed rules cannot enter user preferences', async () => {
  const state = await store.get('owner');
  await expect(store.update('owner', { expectedRevision: state.revision, permissions: { allowDelete: true } })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
  await expect(store.update('owner', { expectedRevision: state.revision, settings: { allowTransfer: true } })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
  await expect(store.update('owner', { expectedRevision: state.revision, rules: [{ id: 'rule_one', text: 'sk-proj-1234567890abcdef', enabled: true }] })).rejects.toMatchObject({ code: 'AI_MEMORY_SENSITIVE_DATA' });
});

test('AI can add evidence-backed inferred items but cannot edit confirmed user content', async () => {
  let state = await store.get('owner');
  state = await store.update('owner', { expectedRevision: state.revision, profile: { items: [item()], historyCursor: 3 } }, { actor: 'ai' });
  expect(state.profile.items[0]).toMatchObject({ origin: 'ai', confirmed: false });
  state = await store.update('owner', { expectedRevision: state.revision, profile: { ...state.profile, items: [item({ confirmed: true })] } });
  await expect(store.update('owner', { expectedRevision: state.revision, profile: { items: [item({ text: '回答冗长。' })], historyCursor: 8 } }, { actor: 'ai' })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
  await expect(store.update('owner', { expectedRevision: state.revision, profile: { items: [], historyCursor: 8 } }, { actor: 'ai' })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
  await expect(store.update('owner', { expectedRevision: state.revision, rules: [] }, { actor: 'ai' })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
});

test('public updates cannot reset history and ordinary AI updates retain a monotonic cursor', async () => {
  let state = await store.get('owner');
  state = await store.update('owner', { expectedRevision: state.revision,
    profile: { items: [], historyCursor: 100 } }, { actor: 'ai' });
  state = await store.update('owner', { expectedRevision: state.revision,
    profile: { items: [], historyCursor: 10 } }, { actor: 'ai' });
  expect(state.profile.historyCursor).toBe(100);
  state = await store.update('owner', { expectedRevision: state.revision,
    profile: { items: [], historyCursor: 10 } }, { allowHistoryRewind: true });
  expect(state.profile.historyCursor).toBe(100);
  await expect(store.update('owner', { expectedRevision: state.revision,
    profile: { items: [], historyCursor: 10 }, allowHistoryRewind: true }))
    .rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
});

test('user removal creates suppression and direct user edits are marked confirmed', async () => {
  let state = await store.get('owner');
  state = await store.update('owner', { expectedRevision: state.revision, profile: { items: [item()] } }, { actor: 'ai' });
  state = await store.update('owner', { expectedRevision: state.revision, profile: { items: [] } });
  expect(state.suppressedProfile).toEqual([{ category: 'communication', text: '回答简洁。', evidence: [{ quote: '请回答简洁。' }] }]);
  await expect(store.update('owner', { expectedRevision: state.revision, profile: { items: [item({ id: 'profile_new' })] } }, { actor: 'ai' })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
  state = await store.update('owner', { expectedRevision: state.revision, profile: { items: [item({ text: '回答详细。' })] } });
  expect(state.profile.items[0]).toMatchObject({ origin: 'user', confirmed: true });
});

test('parallel revisions cannot overwrite another writer', async () => {
  const initial = await store.get('owner');
  const second = createPersonalizationStore({ root: path.join(root, 'personalization'), now: clock });
  const results = await Promise.allSettled([store.update('owner', { expectedRevision: initial.revision, settings: { useMemory: false } }),
    second.update('owner', { expectedRevision: initial.revision, settings: { useProfile: false } })]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')[0].reason.code).toBe('AI_PERSONALIZATION_CONFLICT');
});

test('manually corrected AI text suppresses the old text and preserves the correction', async () => {
  let state = await store.get('owner');
  state = await store.update('owner', { expectedRevision: state.revision, profile: { items: [item()] } }, { actor: 'ai' });
  state = await store.update('owner', { expectedRevision: state.revision, profile: { items: [item({ text: '技术问题详细解释。' })] } });
  expect(state.suppressedProfile[0]).toMatchObject({ text: '回答简洁。' });
  await expect(store.update('owner', { expectedRevision: state.revision, profile: { items: [state.profile.items[0], item({ id: 'profile_old' })] } }, { actor: 'ai' }))
    .rejects.toMatchObject({ code: 'AI_PERSONALIZATION_INVALID' });
});

test('memory UI writes, AI edits, history, deletion and restoration preserve versions', async () => {
  const created = await management.create('owner', { title: '沟通偏好', type: 'preference', content: '用简洁中文回答。' });
  const updated = await management.update('owner', created.path, { title: created.title, type: created.type,
    content: '详细解释技术问题。', expectedRevision: created.revision });
  await expect(management.remove('owner', created.path, { expectedRevision: created.revision })).rejects.toMatchObject({ code: 'AI_MEMORY_CONFLICT' });
  const deleted = await management.remove('owner', created.path, { expectedRevision: updated.revision });
  expect(deleted.deleted).toBe(true);
  expect((await management.list('owner')).files).toEqual([]);
  await expect(management.writeFromAI('owner', { path: created.path, title: created.title, type: created.type,
    operation: 'create', content: '自动恢复。', sourceText: '自动恢复。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  const history = await management.history('owner', created.path);
  expect(history.entries[0]).toMatchObject({ action: 'delete', actor: 'user', restorable: true });
  const original = history.entries.find(entry => entry.action === 'create');
  const restored = await management.restore('owner', created.path, { historyId: original.id });
  expect(restored.content).toBe(created.content);
  expect((await store.get('owner')).deletedMemories).toEqual([]);
  expect((await management.history('another-owner')).entries).toEqual([]);
  await expect(management.restore('another-owner', created.path, { historyId: original.id })).rejects.toMatchObject({ code: 'AI_MEMORY_HISTORY_NOT_FOUND' });
});

test('disabled memory is excluded before result limit, and disabled writes fail', async () => {
  const first = await management.create('owner', { title: '第一项', type: 'note', content: '偏好：中文。' });
  const second = await management.create('owner', { title: '第二项', type: 'note', content: '偏好：英文。' });
  let state = await store.get('owner');
  state = await store.update('owner', { expectedRevision: state.revision, disabledMemories: [first.path] });
  expect((await management.search('owner', { pattern: '偏好', limit: 1 })).matches[0].path).toBe(second.path);
  await expect(management.writeFromAI('owner', { path: first.path, operation: 'replace', title: first.title, type: first.type,
    content: '新偏好。', sourceText: '新偏好。', expectedRevision: first.revision })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
});

test('tampered owner state is never overwritten with defaults', async () => {
  const state = await store.get('owner'); await store.update('owner', { expectedRevision: state.revision, rules: [] });
  const ownerDir = path.join(root, 'personalization', crypto.createHash('sha256').update('owner').digest('hex'));
  await fs.writeFile(path.join(ownerDir, 'state.json'), '{invalid json', 'utf8');
  await expect(store.get('owner')).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_STORAGE_INVALID' });
  await expect(store.update('owner', { expectedRevision: state.revision, rules: [] })).rejects.toMatchObject({ code: 'AI_PERSONALIZATION_STORAGE_INVALID' });
});

test('cancelled update does not write a state file or change the revision', async () => {
  const state = await store.get('owner'), controller = new AbortController(); controller.abort();
  await expect(store.update('owner', { expectedRevision: state.revision, rules: [] }, { signal: controller.signal }))
    .rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect((await store.get('owner')).revision).toBe(state.revision);
  expect(await fs.readdir(root)).toEqual([]);
});

test('deleted memory tombstones survive more than one hundred past deletions', async () => {
  await store.updateInternal('owner', state => {
    state.deletedMemories = Array.from({ length: 101 }, (_, index) => `memory-note-${index}.md`); return state;
  });
  expect((await store.get('owner')).deletedMemories).toHaveLength(101);
});

test('history failure after a durable AI memory write returns the actual saved state', async () => {
  const failing = createMemoryManagementService({ memoryStore: memory,
    personalizationStore: { get: userId => store.get(userId), updateInternal: async () => { throw new Error('History unavailable'); } } });
  const saved = await failing.writeFromAI('owner', { path: 'test-memory.md', title: '偏好', type: 'preference',
    operation: 'create', content: '回答简洁。', sourceText: '请回答简洁。' });
  expect(saved).toMatchObject({ changed: true, content: '回答简洁。\n', historyWarning: expect.any(String) });
  expect((await memory.read('owner', { path: 'test-memory.md' })).revision).toBe(saved.revision);
});

test('deleted memory cannot be recreated by AI under a different filename or paraphrased source', async () => {
  const saved = await management.writeFromAI('owner', { path: 'preference.md', title: '沟通偏好', type: 'preference',
    operation: 'create', content: '技术问题请详细解释。', sourceText: '技术问题请详细解释。' });
  await management.remove('owner', saved.path, { expectedRevision: saved.revision });
  expect((await store.get('owner')).suppressedMemories).toEqual([{ path: saved.path, content: saved.content, source: saved.source }]);
  await expect(management.writeFromAI('owner', { path: 'different-name.md', title: saved.title, type: saved.type,
    operation: 'create', content: saved.content, sourceText: '请保存偏好。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  await expect(management.writeFromAI('owner', { path: 'new-name.md', title: saved.title, type: saved.type,
    operation: 'create', content: '用户喜欢技术细节。', sourceText: '技术问题请详细解释。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  const history = await management.history('owner', saved.path);
  await management.restore('owner', saved.path, { historyId: history.entries[0].id });
  expect((await store.get('owner')).suppressedMemories).toEqual([]);
});

test('partial deletion blocks AI recreation and unrelated edits preserve the removed record suppression', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  const changed = await management.writeFromAI('owner', { path: first.path, title: first.title, type: first.type,
    operation: 'patch', oldText: '我喜欢蓝色。', content: '', sourceText: '忘掉我喜欢蓝色这件事。', expectedRevision: first.revision });
  expect((await store.get('owner')).suppressedMemories).toEqual([{ path: first.path, content: '我喜欢蓝色。', source: '我喜欢蓝色。' }]);
  await expect(management.writeFromAI('owner', { path: 'recreated.md', title: '偏好', type: 'preference', operation: 'create',
    content: '我喜欢蓝色。', sourceText: '我喜欢蓝色。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  const edited = await management.update('owner', first.path, { title: first.title, type: first.type, content: '回答简洁。\n\n技术问题详细解释。', expectedRevision: changed.revision });
  expect((await store.get('owner')).suppressedMemories.some(entry => entry.content === '我喜欢蓝色。')).toBe(true);
  await expect(management.writeFromAI('owner', { path: first.path, title: first.title, type: first.type, operation: 'append',
    content: '我喜欢蓝色。', sourceText: '我喜欢蓝色。', expectedRevision: edited.revision })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  // A deliberate manual re-add is an explicit correction and lifts only this suppression.
  await management.update('owner', first.path, { title: first.title, type: first.type, content: edited.content + '\n我喜欢蓝色。', expectedRevision: edited.revision });
  expect((await store.get('owner')).suppressedMemories.some(entry => entry.content === '我喜欢蓝色。')).toBe(false);
});

test('manual removal of one complete record adds suppression for only the removed record', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  await management.update('owner', first.path, { title: first.title, type: first.type, content: '回答简洁。', expectedRevision: first.revision });
  const suppressed = (await store.get('owner')).suppressedMemories;
  expect(suppressed).toEqual([{ path: first.path, content: '我喜欢蓝色。', source: '我喜欢蓝色。' }]);
  const kept = await management.writeFromAI('owner', { path: 'retained.md', title: '沟通', type: 'preference', operation: 'create',
    content: '回答简洁。', sourceText: '回答简洁。' });
  expect(kept.changed).toBe(true);
});

test('deleting the remaining file keeps suppression for previously removed records', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  const changed = await management.update('owner', first.path, { title: first.title, type: first.type,
    content: '回答简洁。', expectedRevision: first.revision });
  await management.remove('owner', first.path, { expectedRevision: changed.revision });
  expect((await store.get('owner')).suppressedMemories.some(entry => entry.content === '我喜欢蓝色。')).toBe(true);
  await expect(management.writeFromAI('owner', { path: 'restored-elsewhere.md', title: '偏好', type: 'preference', operation: 'create',
    content: '我喜欢蓝色。', sourceText: '我喜欢蓝色。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
});
test('a manual deletion from consecutive lines does not suppress a retained line', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n我喜欢蓝色。' });
  await management.update('owner', first.path, { title: first.title, type: first.type,
    content: '回答简洁。', expectedRevision: first.revision });
  expect((await store.get('owner')).suppressedMemories).toEqual([{ path: first.path, content: '我喜欢蓝色。', source: '我喜欢蓝色。' }]);
  const retained = await management.writeFromAI('owner', { path: 'kept-preference.md', title: '沟通', type: 'preference',
    operation: 'create', content: '回答简洁。', sourceText: '回答简洁。' });
  expect(retained.changed).toBe(true);
});
test('a deliberate manual re-add in a new file releases matching content without reviving the deleted path', async () => {
  const first = await management.create('owner', { title: '偏好', type: 'preference', content: '我喜欢蓝色。' });
  await management.remove('owner', first.path, { expectedRevision: first.revision });
  const readded = await management.create('owner', { title: '恢复的偏好', type: 'preference', content: '我喜欢蓝色。' });
  expect((await store.get('owner')).suppressedMemories).toEqual([]);
  expect((await store.get('owner')).deletedMemories).toContain(first.path);
  const saved = await management.writeFromAI('owner', { path: readded.path, title: readded.title, type: readded.type,
    operation: 'append', content: '我喜欢蓝色。', sourceText: '我喜欢蓝色。' });
  expect(saved.path).toBe(readded.path);
});

test('failed deletion removes only its own history record and preserves concurrent history', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。' });
  const originalHistory = (await management.history('owner', first.path)).entries;
  const failing = createMemoryManagementService({ personalizationStore: store, memoryStore: { ...memory, remove: async () => {
    await store.updateInternal('owner', state => {
      state.memoryHistory.push({ id: 'history_concurrent', path: 'other.md', action: 'create', actor: 'user', createdAt: clock().toISOString() });
      return state;
    });
    throw Object.assign(new Error('Deletion cancelled'), { code: 'AI_REQUEST_CANCELLED' });
  } } });
  await expect(failing.remove('owner', first.path, { expectedRevision: first.revision })).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect((await memory.read('owner', { path: first.path })).revision).toBe(first.revision);
  expect((await management.history('owner', first.path)).entries).toEqual(originalHistory);
  expect((await management.history('owner')).entries.some(entry => entry.id === 'history_concurrent')).toBe(true);
  expect((await store.get('owner')).deletedMemories).toEqual([]);
});

test('restoring a later snapshot keeps suppression for information absent from that snapshot', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  const later = await management.update('owner', first.path, { title: first.title, type: first.type,
    content: '回答简洁。', expectedRevision: first.revision });
  const laterEntry = (await management.history('owner', first.path)).entries.find(entry => entry.action === 'replace');
  await management.remove('owner', first.path, { expectedRevision: later.revision });
  await management.restore('owner', first.path, { historyId: laterEntry.id });
  expect((await store.get('owner')).deletedMemories).toEqual([]);
  expect((await store.get('owner')).suppressedMemories).toEqual([{ path: first.path, content: '我喜欢蓝色。', source: '我喜欢蓝色。' }]);
  await expect(management.writeFromAI('owner', { path: 'forgotten.md', title: '偏好', type: 'preference', operation: 'create',
    content: '我喜欢蓝色。', sourceText: '我喜欢蓝色。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
});

test('partial deletion fails before body write when forgetting cannot be persisted', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  const write = jest.fn((...args) => memory.write(...args));
  const failing = createMemoryManagementService({ memoryStore: { ...memory, write }, personalizationStore: {
    get: userId => store.get(userId), updateInternal: async () => { throw new Error('State persistence failed'); },
  } });
  await expect(failing.writeFromAI('owner', { path: first.path, title: first.title, type: first.type, operation: 'patch',
    oldText: '我喜欢蓝色。', content: '', sourceText: '忘掉我喜欢蓝色。', expectedRevision: first.revision })).rejects.toThrow('State persistence failed');
  expect(write).not.toHaveBeenCalled();
  expect((await memory.read('owner', { path: first.path })).revision).toBe(first.revision);
});

test('failed partial body write rolls back only newly staged suppression', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  await store.updateInternal('owner', state => {
    state.suppressedMemories.push({ path: 'older.md', content: '我喜欢红色。', source: '我喜欢红色。' }); return state;
  });
  const failing = createMemoryManagementService({ personalizationStore: store, memoryStore: { ...memory, write: async () => {
    expect((await store.get('owner')).suppressedMemories.some(entry => entry.content === '我喜欢蓝色。')).toBe(true);
    await store.updateInternal('owner', state => {
      state.suppressedMemories.push({ path: 'parallel.md', content: '我喜欢绿色。', source: '我喜欢绿色。' }); return state;
    });
    throw new Error('Body write failed');
  } } });
  await expect(failing.writeFromAI('owner', { path: first.path, title: first.title, type: first.type, operation: 'patch',
    oldText: '我喜欢蓝色。', content: '', sourceText: '忘掉我喜欢蓝色。', expectedRevision: first.revision })).rejects.toThrow('Body write failed');
  expect((await store.get('owner')).suppressedMemories).toEqual([
    { path: 'older.md', content: '我喜欢红色。', source: '我喜欢红色。' },
    { path: 'parallel.md', content: '我喜欢绿色。', source: '我喜欢绿色。' },
  ]);
  expect((await memory.read('owner', { path: first.path })).revision).toBe(first.revision);
});

test('post-write history failure retains staged forgetting after partial deletion', async () => {
  const first = await management.create('owner', { title: '个人偏好', type: 'preference', content: '回答简洁。\n\n我喜欢蓝色。' });
  let calls = 0;
  const failing = createMemoryManagementService({ memoryStore: memory, personalizationStore: {
    get: userId => store.get(userId), updateInternal: (userId, work) => {
      if (++calls === 3) throw new Error('Final history failed');
      return store.updateInternal(userId, work);
    },
  } });
  const saved = await failing.writeFromAI('owner', { path: first.path, title: first.title, type: first.type, operation: 'patch',
    oldText: '我喜欢蓝色。', content: '', sourceText: '忘掉我喜欢蓝色。', expectedRevision: first.revision });
  expect(saved.historyWarning).toBeTruthy();
  expect(saved.content).not.toContain('蓝色');
  await expect(management.writeFromAI('owner', { path: 'forgotten-again.md', title: '偏好', type: 'preference', operation: 'create',
    content: '我喜欢蓝色。', sourceText: '我喜欢蓝色。' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
});
