const crypto = require('node:crypto');
const { AiError } = require('./errors');
const { validateMemoryPath, validateMemoryText, TYPES } = require('./memoryStore');

const invalid = (message, code = 'AI_MEMORY_INPUT_INVALID', status = 400) => new AiError(message, status, code);
const copy = value => JSON.parse(JSON.stringify(value));
const checkCancellation = signal => { if (signal?.aborted) throw invalid('本次请求已取消，记忆未修改', 'AI_REQUEST_CANCELLED', 499); };
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const sourceIsManual = value => /^用户(?:在记忆管理页|从记忆修改记录)/u.test(String(value));
function blockedByDeletedMemory(input, suppressed = []) {
  const content = normalize(input.content), source = normalize(input.sourceText);
  return suppressed.some(entry => {
    const removed = normalize(entry.content), oldSource = sourceIsManual(entry.source) ? '' : normalize(entry.source);
    return removed && (content.includes(removed) || removed.includes(content) && content.length >= 4) ||
      oldSource && source && (source.includes(oldSource) || oldSource.includes(source) && source.length >= 4);
  });
}
const records = content => String(content || '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/)
  .map(record => record.split('\n').map(line => line.replace(/^\s*>\s?/, '')).join('\n').trim()).filter(Boolean);
function removedRecords(before, input) {
  if (!before || input.operation === 'append' || input.operation === 'create') return [];
  if (input.operation === 'patch') {
    const old = String(input.oldText || '').trim();
    return old && !normalize(input.content).includes(normalize(old)) ? [old] : [];
  }
  const next = normalize(input.content);
  return records(before.content).flatMap(record => {
    if (next.includes(normalize(record))) return [];
    const lines = record.split('\n').filter(line => normalize(line));
    // Manual editors may use consecutive lines instead of blank paragraphs.
    // Preserve the lines still present rather than suppressing the whole block.
    if (lines.length > 1 && lines.some(line => next.includes(normalize(line))))
      return lines.filter(line => !next.includes(normalize(line)));
    return [record];
  });
}
const locks = new Map();
const ownerKey = (userId, path) => `${userId}\n${path}`;
async function serialized(key, work) {
  const previous = locks.get(key) || Promise.resolve(), current = previous.catch(() => {}).then(work);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}
function checkedInput(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid('记忆字段无效');
  return value;
}
function checkedBody(input) {
  if (typeof input.title !== 'string' || input.title.length > 80 || !TYPES.includes(input.type) || typeof input.content !== 'string') throw invalid('记忆标题、类型或正文无效');
  validateMemoryText(input.title, { name: '记忆标题', maxBytes: 320 });
  validateMemoryText(input.content, { name: '记忆正文' });
}
function createMemoryManagementService({ memoryStore, personalizationStore, now = () => new Date() } = {}) {
  if (!memoryStore?.write || !memoryStore?.remove || !personalizationStore?.get || !personalizationStore?.updateInternal)
    throw new Error('Memory management requires memory and personalization storage');
  const stamp = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  async function stageRemovedRecords(userId, path, removed, mutationId) {
    await personalizationStore.updateInternal(userId, state => {
      state.suppressedMemories ||= [];
      for (const content of removed) if (!state.suppressedMemories.some(entry => entry.path === path && normalize(entry.content) === normalize(content)))
        state.suppressedMemories.push({ path, content, source: content, pendingMutation: mutationId });
      return state;
    });
  }
  async function rollbackRemovedRecords(userId, mutationId) {
    await personalizationStore.updateInternal(userId, state => {
      state.suppressedMemories = (state.suppressedMemories || []).filter(entry => entry.pendingMutation !== mutationId);
      return state;
    });
  }
  async function appendHistory(userId, path, operation, snapshot, actor, deleted = false, removed = [], historyId = null, mutationId = null) {
    return personalizationStore.updateInternal(userId, state => {
      state.memoryHistory.push({ id: historyId || `history_${crypto.randomBytes(12).toString('hex')}`, path, action: operation,
        actor, createdAt: stamp(), snapshot: copy(snapshot), restorable: true });
      // Keep complete versions in the same owner-bound state; bound retained volume.
      while (state.memoryHistory.length > 100 || Buffer.byteLength(JSON.stringify(state.memoryHistory), 'utf8') > 1400000) state.memoryHistory.shift();
      if (deleted && !state.deletedMemories.includes(path)) state.deletedMemories.push(path);
      if (deleted) {
        state.suppressedMemories ||= [];
        if (!state.suppressedMemories.some(entry => entry.path === path && normalize(entry.content) === normalize(snapshot.content)))
          state.suppressedMemories.push({ path, content: snapshot.content, source: snapshot.source });
      }
      if (!deleted && removed.length) {
        state.suppressedMemories ||= [];
        for (const content of removed) if (!state.suppressedMemories.some(entry => entry.path === path && normalize(entry.content) === normalize(content)))
          state.suppressedMemories.push({ path, content, source: content });
      }
      if (mutationId) state.suppressedMemories = (state.suppressedMemories || []).map(entry => {
        if (entry.pendingMutation !== mutationId) return entry;
        const { pendingMutation, ...committed } = entry; return committed;
      });
      if (state.deletedMemories.length > 10000) throw invalid('记忆删除记录已达到容量上限', 'AI_MEMORY_LIMIT', 413);
      if (!deleted) {
        state.deletedMemories = state.deletedMemories.filter(entry => entry !== path);
        if (actor === 'user' && !operation.startsWith('before-')) state.suppressedMemories = (state.suppressedMemories || []).filter(entry =>
          operation === 'restore' && entry.path !== path || !normalize(snapshot.content).includes(normalize(entry.content)));
      }
      return state;
    });
  }
  async function list(userId) {
    const [index, state] = await Promise.all([memoryStore.list(userId), personalizationStore.get(userId)]);
    const deleted = new Set(state.deletedMemories);
    const files = index.files.filter(item => !deleted.has(item.path));
    return { ...index, files, count: files.length };
  }
  async function read(userId, input) { return memoryStore.read(userId, input); }
  async function readFromAI(userId, input) {
    const state = await personalizationStore.get(userId);
    if (state.settings.useMemory === false || state.disabledMemories.includes(input.path) || state.deletedMemories.includes(input.path))
      throw invalid('用户已停用这条记忆', 'AI_MEMORY_DISABLED', 403);
    return memoryStore.read(userId, input);
  }
  async function search(userId, input) {
    const state = await personalizationStore.get(userId);
    return memoryStore.search(userId, { ...input, excludePaths: [...new Set([
      ...(input.excludePaths || []), ...state.disabledMemories, ...state.deletedMemories])] });
  }
  async function write(userId, input, { actor = 'ai' } = {}) {
    checkCancellation(input.signal);
    const path = validateMemoryPath(input.path);
    return serialized(ownerKey(userId, path), async () => {
      checkCancellation(input.signal);
      const state = await personalizationStore.get(userId);
      if (actor === 'ai' && (state.settings.useMemory === false || state.deletedMemories.includes(path) || state.disabledMemories.includes(path)))
        throw invalid('用户已停用或删除这条记忆，请通过记忆管理页恢复', 'AI_MEMORY_DISABLED', 403);
      if (actor === 'ai' && blockedByDeletedMemory(input, state.suppressedMemories))
        throw invalid('用户已删除相关记忆，不能从旧原话自动恢复', 'AI_MEMORY_DISABLED', 403);
      let before = null;
      try { before = await memoryStore.read(userId, { path }); } catch (error) { if (error.code !== 'AI_MEMORY_NOT_FOUND') throw error; }
      if (input.operation === 'create' && before) throw invalid('同名记忆已存在，请重新读取', 'AI_MEMORY_CONFLICT', 409);
      if (input.operation !== 'create' && !before) throw invalid('记忆文件不存在', 'AI_MEMORY_NOT_FOUND', 404);
      if (['replace', 'patch'].includes(input.operation) && !/^[a-f0-9]{64}$/.test(input.expectedRevision || ''))
        throw invalid('覆盖前须读取当前记忆版本', 'AI_MEMORY_REVISION_REQUIRED', 409);
      if (input.expectedRevision && before?.revision !== input.expectedRevision) throw invalid('记忆已更新，请核对后保存', 'AI_MEMORY_CONFLICT', 409);
      const removed = removedRecords(before, input);
      const removalMutation = removed.length ? crypto.randomBytes(12).toString('hex') : null;
      // Persist forgetting before changing the body. A later history failure
      // must never allow an old deleted record to be reintroduced by AI.
      if (removalMutation) await stageRemovedRecords(userId, path, removed, removalMutation);
      // Save the prior complete version before a write so history failure cannot silently overwrite it.
      let saved;
      try {
        if (before) await appendHistory(userId, path, 'before-update', before, actor);
        saved = await memoryStore.write(userId, input);
      } catch (error) {
        if (removalMutation) await rollbackRemovedRecords(userId, removalMutation);
        throw error;
      }
      if (saved.changed) {
        try { await appendHistory(userId, path, input.operation, saved, actor, false, removed, null, removalMutation); }
        catch (_) { return { ...saved, historyWarning: '记忆正文已保存，本次修改记录暂未保存。' }; }
      }
      return saved;
    });
  }
  async function create(userId, input, { signal = null } = {}) {
    checkedInput(input, ['title', 'type', 'content']); checkedBody(input);
    const filenameId = crypto.randomBytes(12).toString('hex').replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
    return write(userId, { ...input, title: input.title.trim(), path: `memory-${filenameId}.md`,
      operation: 'create', sourceText: '用户在记忆管理页填写', signal }, { actor: 'user' });
  }
  async function update(userId, path, input, { signal = null } = {}) {
    checkedInput(input, ['title', 'type', 'content', 'expectedRevision']); checkedBody(input);
    return write(userId, { ...input, title: input.title.trim(), path: validateMemoryPath(path), operation: 'replace',
      sourceText: '用户在记忆管理页修改', signal }, { actor: 'user' });
  }
  async function remove(userId, path, input = {}, { signal = null } = {}) {
    checkedInput(input, ['expectedRevision']); path = validateMemoryPath(path);
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision || '')) throw invalid('请先读取最新版本再删除', 'AI_MEMORY_REVISION_REQUIRED', 409);
    return serialized(ownerKey(userId, path), async () => {
      checkCancellation(signal);
      const before = await memoryStore.read(userId, { path });
      if (before.revision !== input.expectedRevision) throw invalid('记忆已更新，请核对后删除', 'AI_MEMORY_CONFLICT', 409);
      const oldState = await personalizationStore.get(userId);
      const deleteHistoryId = `history_${crypto.randomBytes(12).toString('hex')}`;
      await appendHistory(userId, path, 'delete', before, 'user', true, [], deleteHistoryId);
      try { return await memoryStore.remove(userId, { path, expectedRevision: input.expectedRevision, signal }); }
      catch (error) {
        await personalizationStore.updateInternal(userId, state => {
          state.memoryHistory = state.memoryHistory.filter(entry => entry.id !== deleteHistoryId);
          state.deletedMemories = state.deletedMemories.filter(entry => entry !== path);
          state.suppressedMemories = (state.suppressedMemories || []).filter(entry => entry.path !== path);
          state.suppressedMemories.push(...(oldState.suppressedMemories || []).filter(entry => entry.path === path));
          return state;
        });
        throw error;
      }
    });
  }
  async function history(userId, path = null) {
    if (path != null) validateMemoryPath(path);
    const state = await personalizationStore.get(userId);
    return { entries: state.memoryHistory.filter(entry => path == null || entry.path === path).slice(-100).reverse() };
  }
  async function restore(userId, path, input = {}, { signal = null } = {}) {
    checkedInput(input, ['historyId', 'expectedRevision']); path = validateMemoryPath(path);
    if (typeof input.historyId !== 'string' || !/^history_[a-f0-9]{24}$/.test(input.historyId)) throw invalid('记忆历史标识无效');
    return serialized(ownerKey(userId, path), async () => {
      checkCancellation(signal);
      const state = await personalizationStore.get(userId), entry = state.memoryHistory.find(item => item.id === input.historyId && item.path === path);
      if (!entry?.snapshot) throw invalid('记忆历史不存在', 'AI_MEMORY_HISTORY_NOT_FOUND', 404);
      let current = null;
      try { current = await memoryStore.read(userId, { path }); } catch (error) { if (error.code !== 'AI_MEMORY_NOT_FOUND') throw error; }
      if (current && current.revision !== input.expectedRevision) throw invalid('记忆已更新，请核对后恢复', 'AI_MEMORY_CONFLICT', 409);
      if (!current && input.expectedRevision != null) throw invalid('记忆已删除，请重新读取列表', 'AI_MEMORY_CONFLICT', 409);
      if (current) await appendHistory(userId, path, 'before-restore', current, 'user');
      const saved = await memoryStore.write(userId, { path, operation: current ? 'replace' : 'create',
        title: entry.snapshot.title, type: entry.snapshot.type, content: entry.snapshot.content,
        sourceText: '用户从记忆修改记录恢复', signal, ...(current ? { expectedRevision: current.revision } : {}) });
      try { await appendHistory(userId, path, 'restore', saved, 'user'); }
      catch (_) {
        // Restored content is already durable; remove the tombstone even if history retention fails.
        await personalizationStore.updateInternal(userId, state => {
          state.deletedMemories = state.deletedMemories.filter(entry => entry !== path);
          state.suppressedMemories = (state.suppressedMemories || []).filter(entry =>
            entry.path !== path || !normalize(saved.content).includes(normalize(entry.content)));
          return state;
        });
        return { ...saved, historyWarning: '记忆已恢复，本次恢复记录暂未保存。' };
      }
      return saved;
    });
  }
  const writeFromAI = (userId, input) => write(userId, input, { actor: 'ai' });
  return { list, read, readFromAI, search, write, writeFromAI, create, update, remove, history, restore };
}

module.exports = { createMemoryManagementService, blockedByDeletedMemory };
