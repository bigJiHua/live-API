const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { TextDecoder } = require('node:util');
const { Worker } = require('node:worker_threads');
const { AiError } = require('./errors');
const { CHARACTER_UNIT, memoryLineSnippet } = require('./memoryTextEvidence');

const DEFAULT_ROOT = path.resolve(__dirname, '../../../../data/memory');
const TYPES = Object.freeze(['preference', 'profile', 'workflow', 'note']);
const LIMITS = Object.freeze({ files: 50, fileBytes: 64 * 1024, totalBytes: 1024 * 1024,
  results: 50, patternChars: 200, regexMs: 500, snippetChars: 240 });
const queues = new Map();
const invalid = (message, code = 'AI_MEMORY_INVALID', status = 400) => new AiError(message, status, code);
const revision = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function validateMemoryText(value, { name = '记忆内容', maxBytes = LIMITS.fileBytes, empty = false } = {}) {
  if (typeof value !== 'string' || !empty && !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes)
    throw invalid(`${name}为空或超过长度限制`);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw invalid(`${name}含无效 Unicode`, 'AI_MEMORY_ENCODING_INVALID');
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) throw invalid(`${name}含无效 Unicode`, 'AI_MEMORY_ENCODING_INVALID');
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/u.test(value) ||
    /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â[€\u0080-\u00BF]|ðŸ|ï»¿|ä¸|æ–|锟斤拷|烫{3,}|屯{3,})/u.test(value))
    throw invalid(`${name}含隐藏字符、替换字符或常见乱码，请使用正常 UTF-8 中文或 English`, 'AI_MEMORY_ENCODING_INVALID');
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:r_[0-9a-f]{32}|h_[0-9a-f]{32}|q_[0-9a-f]{24})\b/iu.test(value) ||
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{10,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
    /(?:api[ _-]?key|access[ _-]?token|secret[ _-]?key|password|密码|密钥)\s*(?:[:=：]|为|是)\s*["']?[^\s"']{4,}/iu.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|(?<!\d)\d{12,19}(?!\d)|(?:\d{4}[ -]){2,4}\d{2,4}/u.test(value))
    throw invalid(`${name}含密钥、完整号码或内部历史标识，不能写入长期记忆`, 'AI_MEMORY_SENSITIVE_DATA');
  return value;
}

function validateMemoryPath(value) {
  if (typeof value !== 'string' || value.length > 80 || value !== value.normalize('NFC') ||
    !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*\.md$/u.test(value) || value.includes('..') || /[ .]\.md$/.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value))
    throw invalid('记忆路径必须是安全的相对 .md 文件名，不能包含目录、绝对路径或设备名', 'AI_MEMORY_PATH_INVALID');
  validateMemoryText(value, { name: '记忆文件名', maxBytes: 240 });
  return value;
}

async function serialized(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

// 跨进程原子边界：同一文件的最后 revision 复核与 rename 必须在同一把文件锁内完成。
// 进程内 Map 队列只覆盖单进程；两个 PID 同时通过复核会导致后写覆盖前写。
const LOCK_STALE_MS = 15000, LOCK_WAIT_MS = 8000;
async function withFileLock(directory, filename, work) {
  const name = `.memory-lock-${crypto.createHash('sha256').update(filename).digest('hex').slice(0, 32)}`;
  const lock = path.join(directory, name);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle = null;
  for (;;) {
    try {
      handle = await fs.open(lock, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
      await handle.sync();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stat;
      try { stat = await fs.lstat(lock); } catch (statError) { if (statError.code === 'ENOENT') continue; throw statError; }
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) { await fs.unlink(lock).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw invalid('记忆文件正在被其他进程修改，请稍后重试', 'AI_MEMORY_CONFLICT', 409);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await work(); }
  finally {
    await handle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}

const normalizedPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function assertDirectory(absolute, { missing = false } = {}) {
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT' && missing) return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalid('记忆目录不能是符号链接或 junction', 'AI_MEMORY_PATH_INVALID');
  }
  if (normalizedPath(await fs.realpath(absolute)) !== normalizedPath(absolute))
    throw invalid('记忆目录解析到了其他位置', 'AI_MEMORY_PATH_INVALID');
  return true;
}

function validMetadataTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalizes nonexistent days and 24:00 into another date.
  return new Date(value).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z'));
}

function parseDocument(buffer, filename) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch (_) { throw invalid('记忆文件不是有效 UTF-8', 'AI_MEMORY_ENCODING_INVALID'); }
  validateMemoryText(text);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw invalid('记忆文件缺少 title/type/created/updated/source 元信息');
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(title|type|created|updated|source):[ \t]*(.+)$/.exec(line);
    if (!field || Object.hasOwn(metadata, field[1])) throw invalid('记忆文件元信息格式无效');
    let value = field[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch (_) { throw invalid('记忆文件元信息必须是文本'); }
    }
    validateMemoryText(value, { name: '记忆元信息', maxBytes: field[1] === 'source' ? 4096 : 320 });
    metadata[field[1]] = value;
  }
  if (Object.keys(metadata).length !== 5 || !TYPES.includes(metadata.type) || metadata.title.length > 80 ||
    !validMetadataTimestamp(metadata.created) || !validMetadataTimestamp(metadata.updated) ||
    Date.parse(metadata.updated) < Date.parse(metadata.created)) throw invalid('记忆文件元信息无效');
  validateMemoryText(match[2]);
  return { path: filename, ...metadata, revision: revision(buffer), bytes: buffer.length,
    content: match[2], untrusted: true };
}

function formatDocument(metadata, content) {
  return `---\n${['title', 'type', 'created', 'updated', 'source'].map(key => `${key}: ${JSON.stringify(metadata[key])}`).join('\n')}\n---\n${content.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;
}

function regexSearch(documents, pattern, limit) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'memoryRegexWorker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } });
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      await worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(invalid('正则搜索超时，请简化表达式', 'AI_MEMORY_REGEX_TIMEOUT')), LIMITS.regexMs);
    worker.once('message', result => result.error
      ? finish(invalid('正则表达式无效', 'AI_MEMORY_REGEX_INVALID')) : finish(null, result));
    worker.once('error', () => finish(invalid('正则搜索未完成，请简化表达式', 'AI_MEMORY_REGEX_INVALID')));
    worker.once('exit', code => { if (!settled) finish(invalid('正则搜索提前终止', 'AI_MEMORY_REGEX_INVALID')); });
    worker.postMessage({ documents, pattern, limit, snippetChars: LIMITS.snippetChars });
  });
}

function createMemoryStore({ root = DEFAULT_ROOT, now = () => Date.now() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw invalid('记忆根目录必须是绝对路径', 'AI_MEMORY_PATH_INVALID');
  const rootPath = path.resolve(root);
  function ownerDirectory(userId) {
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 128 || /[\u0000-\u001F\u007F]/u.test(userId))
      throw invalid('记忆用户范围无效');
    return path.join(rootPath, crypto.createHash('sha256').update(userId).digest('hex'));
  }
  async function ensureDirectory(directory, create = false) {
    if (!await assertDirectory(rootPath, { missing: true })) {
      if (!create) return false;
      await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
    }
    await assertDirectory(rootPath);
    if (!await assertDirectory(directory, { missing: true })) {
      if (!create) return false;
      await fs.mkdir(directory, { mode: 0o700 });
    }
    await assertDirectory(directory);
    return true;
  }
  async function readFile(directory, filename) {
    const absolute = path.join(directory, filename);
    await assertDirectory(directory);
    let before;
    try { before = await fs.lstat(absolute); }
    catch (error) { if (error.code === 'ENOENT') throw invalid('记忆文件不存在', 'AI_MEMORY_NOT_FOUND', 404); throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw invalid('记忆文件不能是链接', 'AI_MEMORY_PATH_INVALID');
    if (before.size > LIMITS.fileBytes) throw invalid('记忆文件超过64KiB', 'AI_MEMORY_LIMIT', 413);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino)
        throw invalid('记忆文件已变化，请重新读取', 'AI_MEMORY_CONFLICT', 409);
      const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > LIMITS.fileBytes) throw invalid('记忆文件超过64KiB', 'AI_MEMORY_LIMIT', 413);
      await assertDirectory(directory);
      const after = await fs.lstat(absolute);
      if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.nlink !== 1)
        throw invalid('记忆文件已变化，请重新读取', 'AI_MEMORY_CONFLICT', 409);
      return parseDocument(buffer.subarray(0, offset), filename);
    } finally { await handle.close(); }
  }
  async function documents(directory) {
    if (!await ensureDirectory(directory)) return { files: [], warnings: [], totalBytes: 0, recordCount: 0, truncated: false };
    const result = [], warnings = [];
    let totalBytes = 0, readableBytes = 0, recordCount = 0, entries = 0, truncated = false;
    const listing = await fs.opendir(directory);
    for await (const entry of listing) {
      if (++entries > LIMITS.files * 2) { truncated = true; break; }
      if (/^\.memory-tmp-[0-9a-f]+\.md$/.test(entry.name) || !entry.name.endsWith('.md')) continue;
      recordCount++;
      try {
        const stat = await fs.lstat(path.join(directory, entry.name));
        totalBytes += stat.size;
        validateMemoryPath(entry.name);
        if (result.length >= LIMITS.files) throw invalid('记忆文件数量超过50', 'AI_MEMORY_LIMIT', 413);
        const document = await readFile(directory, entry.name);
        if (readableBytes + document.bytes > LIMITS.totalBytes) throw invalid('可读取的记忆总量超过1MiB', 'AI_MEMORY_LIMIT', 413);
        readableBytes += document.bytes;
        result.push(document);
      } catch (error) {
        warnings.push({ path: entry.name, code: error instanceof AiError ? error.code : 'AI_MEMORY_READ_FAILED',
          message: error instanceof AiError ? error.message : '记忆文件不可读取，请人工检查文件状态' });
      }
    }
    return { files: result.sort((left, right) => left.path.localeCompare(right.path)), warnings, totalBytes, recordCount, truncated };
  }
  async function list(userId) {
    const directory = ownerDirectory(userId);
    return serialized(directory, async () => {
      const scanned = await documents(directory);
      const files = scanned.files.map(({ content, ...metadata }) => metadata);
      return { files, count: files.length, totalBytes: scanned.totalBytes, warnings: scanned.warnings,
        truncated: scanned.truncated, untrusted: true };
    });
  }
  async function read(userId, args = {}) {
    const directory = ownerDirectory(userId), filename = validateMemoryPath(args.path);
    return serialized(directory, async () => {
      if (!await ensureDirectory(directory)) throw invalid('记忆文件不存在', 'AI_MEMORY_NOT_FOUND', 404);
      return readFile(directory, filename);
    });
  }
  async function search(userId, { pattern, mode = 'literal', limit = 20, excludePaths = [] } = {}) {
    const directory = ownerDirectory(userId);
    validateMemoryText(pattern, { name: '搜索条件', maxBytes: LIMITS.patternChars * 4 });
    if (pattern.length > LIMITS.patternChars || !['literal', 'regex'].includes(mode) || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.results ||
      !Array.isArray(excludePaths) || excludePaths.length > 10100)
      throw invalid('记忆搜索条件无效');
    const excluded = new Set(excludePaths.map(validateMemoryPath));
    return serialized(directory, async () => {
      const scanned = await documents(directory);
      const source = scanned.files.filter(document => !excluded.has(document.path))
        .map(document => ({ path: document.path, revision: document.revision, content: document.content }));
      let result;
      if (mode === 'regex') result = await regexSearch(source, pattern, limit);
      else {
        const matches = [], needle = pattern.toLocaleLowerCase();
        outer: for (const document of source) {
          const lines = document.content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            if (lines[index].toLocaleLowerCase().includes(needle)) {
              matches.push({ path: document.path, revision: document.revision, line: index + 1,
                ...memoryLineSnippet(lines[index], LIMITS.snippetChars) });
              if (matches.length > limit) break outer;
            }
          }
        }
        result = { matches: matches.slice(0, limit), truncated: matches.length > limit };
      }
      return { ...result, truncated: result.truncated || scanned.truncated, warnings: scanned.warnings,
        count: result.matches.length, characterUnit: CHARACTER_UNIT, untrusted: true };
    });
  }
  async function write(userId, args = {}) {
    const { signal } = args;
    // V3 validates complete user-turn body provenance in memoryEvidence.
    // This storage boundary checks UTF-8, safe paths and revision conflicts;
    // a stored source quote alone cannot prove arbitrary paraphrase facts.
    const directory = ownerDirectory(userId), filename = validateMemoryPath(args.path);
    if (!['create', 'replace', 'append', 'patch'].includes(args.operation)) throw invalid('记忆写入操作无效');
    validateMemoryText(args.content, { empty: args.operation === 'patch' });
    validateMemoryText(args.sourceText, { name: '记忆来源原话', maxBytes: 4096 });
    if (args.title != null) { validateMemoryText(args.title, { name: '记忆标题', maxBytes: 320 }); if (args.title.length > 80) throw invalid('记忆标题超过80字'); }
    if (args.type != null && !TYPES.includes(args.type)) throw invalid('记忆类型无效');
    if (args.expectedRevision != null && !/^[0-9a-f]{64}$/.test(args.expectedRevision)) throw invalid('记忆版本无效');
    if (['replace', 'patch'].includes(args.operation) && !args.expectedRevision)
      throw invalid('覆盖或局部替换前须读取当前记忆版本', 'AI_MEMORY_REVISION_REQUIRED', 409);
    if (args.operation === 'patch') validateMemoryText(args.oldText, { name: '待替换原文' });
    return serialized(directory, async () => {
      await ensureDirectory(directory, true);
      const scanned = await documents(directory), existing = scanned.files, before = existing.find(document => document.path === filename);
      const badTarget = scanned.warnings.find(warning => warning.path === filename);
      if (badTarget) throw invalid('目标记忆不可读取，请先人工修复后再更新', badTarget.code);
      if (scanned.truncated || scanned.recordCount > LIMITS.files || scanned.totalBytes > LIMITS.totalBytes)
        throw invalid('记忆超出文件数量或容量限制，请人工整理', 'AI_MEMORY_LIMIT', 413);
      if (args.operation === 'create' && before) throw invalid('同名记忆已存在，请先读取后更新', 'AI_MEMORY_CONFLICT', 409);
      if (args.operation !== 'create' && !before) throw invalid('记忆文件不存在', 'AI_MEMORY_NOT_FOUND', 404);
      if (args.expectedRevision && before?.revision !== args.expectedRevision) throw invalid('记忆已被其他操作修改，请重新读取', 'AI_MEMORY_CONFLICT', 409);
      if (!before && (!args.title || !args.type)) throw invalid('新记忆必须提供 title 和 type');
      let content = args.content;
      if (args.operation === 'append') {
        if (before.content.includes(content.replace(/\r\n/g, '\n').trimEnd())) return { ...before, changed: false };
        content = `${before.content.replace(/\n*$/, '\n')}${content}`;
      } else if (args.operation === 'patch') {
        const start = before.content.indexOf(args.oldText);
        if (start < 0 || before.content.indexOf(args.oldText, start + 1) >= 0)
          throw invalid('局部替换原文不存在或不唯一，请重新读取', 'AI_MEMORY_CONFLICT', 409);
        content = before.content.slice(0, start) + args.content + before.content.slice(start + args.oldText.length);
      }
      validateMemoryText(content);
      const updated = new Date(typeof now === 'function' ? now() : now).toISOString();
      const metadata = { title: args.title ?? before?.title, type: args.type ?? before?.type,
        created: before?.created || updated, updated, source: args.sourceText };
      const buffer = Buffer.from(formatDocument(metadata, content), 'utf8');
      const result = parseDocument(buffer, filename);
      if (buffer.length > LIMITS.fileBytes || scanned.totalBytes - (before?.bytes || 0) + buffer.length > LIMITS.totalBytes ||
        !before && scanned.recordCount >= LIMITS.files) throw invalid('记忆超出文件数量或容量限制', 'AI_MEMORY_LIMIT', 413);
      const temporary = path.join(directory, `.memory-tmp-${crypto.randomBytes(16).toString('hex')}.md`);
      const target = path.join(directory, filename);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(buffer);
        await handle.sync();
        const staged = await handle.stat();
        await handle.close(); handle = null;
        await assertDirectory(directory);
        return await withFileLock(directory, filename, async () => {
          // 取消/超时后不得在终态失败之后再提交文件写入。
          if (signal?.aborted) throw invalid('本次请求已取消，记忆未提交', 'AI_REQUEST_CANCELLED', 499);
          // Recheck external/manual edits immediately before the atomic replace.
          if (before) {
            if ((await readFile(directory, filename)).revision !== before.revision) throw invalid('记忆已被人工修改，请重新读取', 'AI_MEMORY_CONFLICT', 409);
          } else {
            const occupied = await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
            if (occupied) throw invalid('同名记忆刚被创建，请重新读取', 'AI_MEMORY_CONFLICT', 409);
          }
          const tempStat = await fs.lstat(temporary);
          if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1 || tempStat.ino !== staged.ino)
            throw invalid('临时记忆文件已变化', 'AI_MEMORY_PATH_INVALID');
          await fs.rename(temporary, target);
          await assertDirectory(directory);
          return { ...result, changed: true };
        });
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }
  async function remove(userId, args = {}) {
    const directory = ownerDirectory(userId), filename = validateMemoryPath(args.path);
    if (!/^[0-9a-f]{64}$/.test(args.expectedRevision || ''))
      throw invalid('删除前须读取当前记忆版本', 'AI_MEMORY_REVISION_REQUIRED', 409);
    return serialized(directory, async () => {
      if (!await ensureDirectory(directory)) throw invalid('记忆文件不存在', 'AI_MEMORY_NOT_FOUND', 404);
      return withFileLock(directory, filename, async () => {
        if (args.signal?.aborted) throw invalid('本次请求已取消，记忆未删除', 'AI_REQUEST_CANCELLED', 499);
        const before = await readFile(directory, filename);
        if (before.revision !== args.expectedRevision) throw invalid('记忆已更新，请核对后删除', 'AI_MEMORY_CONFLICT', 409);
        await assertDirectory(directory);
        await fs.unlink(path.join(directory, filename));
        return { deleted: true, path: filename, revision: before.revision };
      });
    });
  }
  return { list, read, search, write, remove };
}

module.exports = { createMemoryStore, validateMemoryText, validateMemoryPath, DEFAULT_ROOT, ROOT: DEFAULT_ROOT, TYPES, LIMITS };
