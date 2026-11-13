const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { TextDecoder } = require('node:util');
const { AiError } = require('./errors');
const { validateMemoryText, validateMemoryPath } = require('./memoryStore');

const DEFAULT_ROOT = path.resolve(__dirname, '../../../../data/personalization');
const CATEGORIES = ['background', 'likes', 'dislikes', 'goals', 'communication', 'workflow'];
const MAX_BYTES = 2 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message, code = 'AI_PERSONALIZATION_INVALID', status = 400) => new AiError(message, status, code);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const profileKey = item => `${item.category}:${normalize(item.text)}`;
const locked = item => item.origin === 'user' || item.confirmed === true;
const suppressedMatch = (item, removed) => item.category === removed.category &&
  (normalize(item.text).includes(normalize(removed.text)) || normalize(removed.text).includes(normalize(item.text)));
const defaults = () => ({ contractVersion: 1, settings: { useMemory: true, useProfile: true, autoProfile: true },
  rules: [], profile: { items: [], updatedAt: null, historyCursor: 0 }, disabledMemories: [], deletedMemories: [],
  suppressedProfile: [], suppressedMemories: [], memoryHistory: [], updatedAt: null });
const revisionValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const publicRecord = value => ({ ...clone(value), revision: digest(value) });

function text(value, name, maxChars, empty = false) {
  if (typeof value !== 'string' || Array.from(value).length > maxChars) throw invalid(`${name}格式或长度无效`);
  validateMemoryText(value, { name, maxBytes: maxChars * 4, empty });
  return value;
}
function id(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw invalid('条目标识无效');
  return value;
}
function paths(value, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid('记忆状态超出范围');
  return [...new Set(value.map(validateMemoryPath))];
}
function evidence(value) {
  if (!Array.isArray(value) || value.length > 3) throw invalid('画像依据无效');
  return value.map(source => {
    if (!object(source) || Object.keys(source).some(key => !['quote', 'sourceLabel', 'sourceTime'].includes(key))) throw invalid('画像依据无效');
    const result = { quote: text(source.quote, '画像来源原话', 6000) };
    if (source.sourceLabel != null) result.sourceLabel = text(source.sourceLabel, '画像来源', 200);
    if (source.sourceTime != null) {
      if (typeof source.sourceTime !== 'string' || !Number.isFinite(Date.parse(source.sourceTime))) throw invalid('画像来源时间无效');
      result.sourceTime = new Date(source.sourceTime).toISOString();
    }
    return result;
  });
}
function checkedProfile(value, previous, actor, stamp, allowHistoryRewind = false) {
  if (!object(value) || Object.keys(value).some(key => !['items', 'updatedAt', 'historyCursor'].includes(key)) ||
    !Array.isArray(value.items) || value.items.length > 100) throw invalid('画像格式或条目数量无效');
  const seen = new Set();
  const items = value.items.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'category', 'text', 'origin', 'confirmed', 'evidence', 'updatedAt'].includes(key)) ||
      !CATEGORIES.includes(item.category) || !['ai', 'user'].includes(item.origin) || typeof item.confirmed !== 'boolean') throw invalid('画像条目无效');
    id(item.id); if (seen.has(item.id)) throw invalid('画像条目标识重复'); seen.add(item.id);
    const itemText = text(item.text, '画像内容', 2000).trim();
    const old = previous.items.find(entry => entry.id === item.id);
    const same = old && old.category === item.category && old.text === itemText;
    if (actor === 'ai') {
      if (old && locked(old)) {
        if (!same || item.origin !== old.origin || item.confirmed !== old.confirmed) throw invalid('AI 不能覆盖用户维护的画像');
        return clone(old);
      }
      if (item.origin !== 'ai' || item.confirmed) throw invalid('AI 生成的画像须标为待核对');
      if (!item.evidence?.length) throw invalid('AI 画像须有用户原话依据');
    }
    const changedByUser = actor === 'user' && (!same || item.origin === 'user');
    return { id: item.id, category: item.category, text: itemText,
      origin: changedByUser ? 'user' : item.origin, confirmed: changedByUser ? true : item.confirmed,
      evidence: evidence(item.evidence || []), updatedAt: same && old?.updatedAt ? old.updatedAt : stamp };
  });
  if (actor === 'ai' && previous.items.some(item => locked(item) && !items.some(next => next.id === item.id)))
    throw invalid('AI 不能删除用户维护的画像');
  const cursor = value.historyCursor == null ? previous.historyCursor : value.historyCursor;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw invalid('画像历史位置无效');
  return { items, updatedAt: stamp, historyCursor: actor === 'ai'
    ? allowHistoryRewind === true ? cursor : Math.max(cursor, previous.historyCursor)
    : previous.historyCursor };
}

const normalizedPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function assertDirectory(absolute, missing = false) {
  const parsed = path.parse(absolute); let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid('个性化目录不能是链接', 'AI_PERSONALIZATION_PATH_INVALID');
  }
  if (normalizedPath(await fs.realpath(absolute)) !== normalizedPath(absolute)) throw invalid('个性化目录解析异常', 'AI_PERSONALIZATION_PATH_INVALID');
  return true;
}

function createPersonalizationStore({ root = DEFAULT_ROOT, now = () => new Date() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw invalid('个性化根目录须为绝对路径');
  const rootPath = path.resolve(root);
  function owner(userId) {
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 128 || /[\u0000-\u001f\u007f]/u.test(userId)) throw invalid('个性化用户范围无效');
    return path.join(rootPath, crypto.createHash('sha256').update(userId).digest('hex'));
  }
  async function read(directory) {
    if (!await assertDirectory(directory, true)) return defaults();
    const target = path.join(directory, 'state.json'); let before;
    try { before = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return defaults(); throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw invalid('个性化存储文件无效', 'AI_PERSONALIZATION_STORAGE_INVALID', 503);
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.nlink !== 1) throw invalid('个性化文件已变化', 'AI_PERSONALIZATION_CONFLICT', 409);
      const buffer = await handle.readFile(); if (buffer.length > MAX_BYTES) throw invalid('个性化存储超过容量限制');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      if (object(value) && value.suppressedMemories == null) value.suppressedMemories = [];
      if (!object(value) || value.contractVersion !== 1 || !object(value.settings) || !object(value.profile) ||
        !Array.isArray(value.profile.items) || !Array.isArray(value.rules) || !Array.isArray(value.disabledMemories) ||
        !Array.isArray(value.deletedMemories) || !Array.isArray(value.suppressedProfile) || !Array.isArray(value.suppressedMemories) || !Array.isArray(value.memoryHistory))
        throw invalid('个性化存储格式无效', 'AI_PERSONALIZATION_STORAGE_INVALID', 503);
      const after = await fs.lstat(target);
      if (after.isSymbolicLink() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino)
        throw invalid('个性化文件已变化，请重新读取', 'AI_PERSONALIZATION_CONFLICT', 409);
      if (['useMemory', 'useProfile', 'autoProfile'].some(key => typeof value.settings[key] !== 'boolean') ||
        value.rules.length > 30 || value.profile.items.length > 100 || value.memoryHistory.length > 100 ||
        !Number.isSafeInteger(value.profile.historyCursor) || value.profile.historyCursor < 0)
        throw invalid('个性化存储结构无效', 'AI_PERSONALIZATION_STORAGE_INVALID', 503);
      paths(value.disabledMemories); paths(value.deletedMemories, 10000);
      await assertDirectory(directory); return value;
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw invalid('个性化存储暂时无法读取', 'AI_PERSONALIZATION_STORAGE_INVALID', 503);
    } finally { await handle.close(); }
  }
  async function mutate(userId, work, signal = null) {
    const checkCancellation = () => { if (signal?.aborted) throw invalid('本次请求已取消，个性化内容未保存', 'AI_REQUEST_CANCELLED', 499); };
    checkCancellation();
    const directory = owner(userId);
    if (!await assertDirectory(rootPath, true)) await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
    await assertDirectory(rootPath);
    if (!await assertDirectory(directory, true)) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await assertDirectory(directory);
    const lockPath = path.join(directory, '.state-lock'), deadline = Date.now() + 8000; let lock;
    for (;;) {
      checkCancellation();
      try { lock = await fs.open(lockPath, 'wx', 0o600); await lock.writeFile(`${process.pid}\n`); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(lockPath).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
        if (stat && Date.now() - stat.mtimeMs > 15000) { await fs.unlink(lockPath).catch(() => {}); continue; }
        if (Date.now() >= deadline) throw invalid('个性化内容正在修改，请稍后重试', 'AI_PERSONALIZATION_CONFLICT', 409);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const temporary = path.join(directory, `.state-tmp-${crypto.randomBytes(12).toString('hex')}`);
    try {
      checkCancellation();
      const before = await read(directory), next = await work(clone(before));
      const buffer = Buffer.from(JSON.stringify(next), 'utf8'); if (buffer.length > MAX_BYTES) throw invalid('个性化内容超过容量限制');
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(buffer); await file.sync(); } finally { await file.close(); }
      await assertDirectory(directory);
      if (digest(await read(directory)) !== digest(before)) throw invalid('个性化内容已在其他地方修改', 'AI_PERSONALIZATION_CONFLICT', 409);
      checkCancellation();
      await fs.rename(temporary, path.join(directory, 'state.json'));
      return publicRecord(next);
    } finally { await fs.unlink(temporary).catch(() => {}); await lock.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); }
  }
  async function get(userId) { return publicRecord(await read(owner(userId))); }
  async function update(userId, input, { actor = 'user', signal = null, allowHistoryRewind = false } = {}) {
    if (!object(input) || !['user', 'ai'].includes(actor) || Object.keys(input).some(key =>
      !['expectedRevision', 'settings', 'rules', 'profile', 'disabledMemories'].includes(key))) throw invalid('个性化更新字段无效');
    if (!revisionValid(input.expectedRevision)) throw invalid('请先读取最新内容再保存', 'AI_PERSONALIZATION_REVISION_REQUIRED', 409);
    if (actor === 'ai' && Object.keys(input).some(key => !['expectedRevision', 'profile'].includes(key))) throw invalid('AI 只能更新画像');
    return mutate(userId, before => {
      if (digest(before) !== input.expectedRevision) throw invalid('个性化内容已更新，请核对后保存', 'AI_PERSONALIZATION_CONFLICT', 409);
      const stamp = new Date(typeof now === 'function' ? now() : now).toISOString();
      if (input.settings != null) {
        if (!object(input.settings) || Object.keys(input.settings).some(key => !['useMemory', 'useProfile', 'autoProfile'].includes(key)) ||
          Object.values(input.settings).some(value => typeof value !== 'boolean')) throw invalid('个性化开关无效');
        before.settings = { ...before.settings, ...input.settings };
      }
      if (input.rules != null) {
        if (!Array.isArray(input.rules) || input.rules.length > 30) throw invalid('最多保存 30 条规则');
        const seen = new Set(); before.rules = input.rules.map(rule => {
          if (!object(rule) || Object.keys(rule).some(key => !['id', 'text', 'enabled'].includes(key)) || typeof rule.enabled !== 'boolean') throw invalid('规则格式无效');
          id(rule.id); if (seen.has(rule.id)) throw invalid('规则标识重复'); seen.add(rule.id);
          return { id: rule.id, text: text(rule.text, '用户规则', 500).trim(), enabled: rule.enabled };
        });
      }
      if (input.disabledMemories != null) before.disabledMemories = paths(input.disabledMemories);
      if (input.profile != null) {
        // Only a trusted generation caller can rewind a bounded rebuild. This
        // option is never read from the public update input or model output.
        const previous = before.profile, next = checkedProfile(input.profile, previous, actor, stamp, allowHistoryRewind);
        if (actor === 'user') {
          const removed = previous.items.filter(item => !next.items.some(entry => profileKey(entry) === profileKey(item)));
          const suppressed = new Map(before.suppressedProfile.map(item => [profileKey(item), item]));
          removed.forEach(item => suppressed.set(profileKey(item), { category: item.category, text: item.text, evidence: clone(item.evidence || []) }));
          next.items.forEach(item => { if (item.origin === 'user' || item.confirmed) suppressed.delete(profileKey(item)); });
          before.suppressedProfile = [...suppressed.values()].slice(-500);
        } else if (next.items.some(item => before.suppressedProfile.some(entry => suppressedMatch(item, entry)))) throw invalid('AI 不能恢复用户已删除的画像');
        before.profile = next;
      }
      before.updatedAt = stamp; return before;
    }, signal);
  }
  // Internal changes still share the same atomic revision boundary with UI and AI updates.
  const updateInternal = (userId, work) => mutate(userId, async state => {
    const next = await work(state); next.updatedAt = new Date(typeof now === 'function' ? now() : now).toISOString(); return next;
  });
  return { get, update, updateInternal };
}

module.exports = { createPersonalizationStore, DEFAULT_ROOT, CATEGORIES, profileKey };
