const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStore, validateMemoryText, LIMITS } = require('../../src/modules/ai/service/memoryStore');

const now = () => new Date('2026-11-08T14:00:00.000Z');
const ownerName = userId => crypto.createHash('sha256').update(userId).digest('hex');
const input = (extra = {}) => ({ path: '偏好-preferences.md', operation: 'create', title: '图表偏好 / Chart preference',
  type: 'preference', content: '收支比较用柱状图。Use a bar chart for income and expenses.\n银行：农业银行；安全尾号 7476。\n',
  sourceText: '以后收支比较用柱状图 / Use a bar chart.', ...extra });
let directory, store;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-memory-test-')); store = createMemoryStore({ root: directory, now }); });
afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('ai-memory-test-')) throw new Error('Unsafe cleanup path');
  await fs.rm(directory, { recursive: true, force: true });
});

test('normal Chinese, English, Markdown, numbers and dates round-trip as human-editable UTF-8', async () => {
  const created = await store.write('owner-a', input({ content: '# 中文 English\n```js\nconst count = 3; // 2026-11-08\n```\n农业银行尾号7476。\n' }));
  expect(created).toMatchObject({ path: input().path, type: 'preference', changed: true, untrusted: true });
  expect(created.revision).toMatch(/^[a-f0-9]{64}$/);
  const file = path.join(directory, ownerName('owner-a'), input().path);
  const raw = await fs.readFile(file, 'utf8');
  expect(raw).toContain('title: "图表偏好 / Chart preference"');
  expect(raw).toContain('source: "以后收支比较用柱状图 / Use a bar chart."');
  expect(raw).not.toContain('owner-a');
  expect(await store.read('owner-a', { path: input().path })).toEqual(expect.objectContaining({ content: created.content, revision: created.revision, untrusted: true }));
  const listing = await store.list('owner-a');
  expect(listing).toMatchObject({ count: 1, totalBytes: created.bytes, untrusted: true });
  expect(listing.files[0].content).toBeUndefined();
  expect((await fs.readdir(directory))).toEqual([ownerName('owner-a')]);
});

test('different users cannot read, search or overwrite another user memory', async () => {
  const first = await store.write('owner-a', input());
  expect(await store.list('owner-b')).toMatchObject({ files: [], count: 0 });
  await expect(store.read('owner-b', { path: input().path })).rejects.toMatchObject({ code: 'AI_MEMORY_NOT_FOUND', status: 404 });
  expect(await store.search('owner-b', { pattern: '柱状图' })).toMatchObject({ matches: [], count: 0 });
  await store.write('owner-b', input({ content: 'Prefer a table.' }));
  expect((await store.read('owner-a', { path: input().path })).revision).toBe(first.revision);
});

test.each(['../other.md', '..\\other.md', 'C:\\secret.md', '/secret.md', '\\\\server\\secret.md',
  'note.md:secret', 'nested/note.md', 'con.md', 'CON.extra.md', 'COM1.md', 'LPT¹.md', 'note..md', 'note .md', '.hidden.md', 'note.txt'])
  ('unsafe path is rejected: %s', async filename => {
    await expect(store.write('owner', input({ path: filename }))).rejects.toMatchObject({ code: 'AI_MEMORY_PATH_INVALID' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

test.each(['\uFFFD', '\uFEFF中文', 'English\u0000', '中文\u200B', '\uD800', '\uDC00', '锟斤拷', 'ä¸­æ–‡', 'ï»¿English'])
  ('encoding and common mojibake are rejected without a file: %s', async value => {
    await expect(store.write('owner', input({ content: value }))).rejects.toMatchObject({ code: 'AI_MEMORY_ENCODING_INVALID' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

test.each(['sk-proj-1234567890abcdef', 'API key: abcdef123456', 'password=secret123', 'Bearer abcdefgh1234',
  '052af9f1-7519-446a-9130-6669c2b685ce', `r_${'a'.repeat(32)}`, `h_${'a'.repeat(32)}`, `q_${'b'.repeat(24)}`, '6228480402564890018', '6228 4804 0256 4890'])
  ('secrets, full card numbers and internal references cannot be persisted: %s', async content => {
    await expect(store.write('owner', input({ content }))).rejects.toMatchObject({ code: 'AI_MEMORY_SENSITIVE_DATA' });
    await expect(store.write('owner', input({ sourceText: content }))).rejects.toMatchObject({ code: 'AI_MEMORY_SENSITIVE_DATA' });
  });

test('legitimate dates, safe tails, Unicode emoji and English words do not trigger sensitive-data rejection', () => {
  expect(validateMemoryText('农业银行尾号7476。2026-11-08 → 2026-11-09. English CNY 1234.56 😀')).toBeTruthy();
});

test('malformed UTF-8 or a UTF-8 BOM in a manually edited file is refused rather than replaced', async () => {
  await store.write('owner', input());
  const absolute = path.join(directory, ownerName('owner'), input().path);
  await fs.writeFile(absolute, Buffer.from([0xC3, 0x28]));
  await expect(store.read('owner', { path: input().path })).rejects.toMatchObject({ code: 'AI_MEMORY_ENCODING_INVALID' });
  await fs.writeFile(absolute, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('---\n')]));
  expect(await store.list('owner')).toMatchObject({ count: 0, warnings: [{ path: input().path, code: 'AI_MEMORY_ENCODING_INVALID' }] });
});

test('valid human edits change the revision and stale updates cannot overwrite them', async () => {
  const initial = await store.write('owner', input());
  const absolute = path.join(directory, ownerName('owner'), input().path);
  const raw = await fs.readFile(absolute, 'utf8');
  await fs.writeFile(absolute, raw.replace('收支比较用柱状图。', '人工改成表格。'), 'utf8');
  await expect(store.write('owner', input({ operation: 'replace', expectedRevision: initial.revision, content: 'New content' })))
    .rejects.toMatchObject({ code: 'AI_MEMORY_CONFLICT', status: 409 });
  expect((await store.read('owner', { path: input().path })).content).toContain('人工改成表格。');
});

test('replace and patch require the latest revision, while patch must identify one exact passage', async () => {
  const initial = await store.write('owner', input());
  for (const operation of ['replace', 'patch'])
    await expect(store.write('owner', input({ operation, oldText: '柱状图' }))).rejects.toMatchObject({ code: 'AI_MEMORY_REVISION_REQUIRED' });
  const patched = await store.write('owner', input({ operation: 'patch', expectedRevision: initial.revision, oldText: '柱状图', content: '表格' }));
  expect(patched.content).toContain('收支比较用表格。');
  expect(patched.content).toContain('Use a bar chart');
  expect(patched.revision).not.toBe(initial.revision);
  await expect(store.write('owner', input({ operation: 'patch', expectedRevision: patched.revision, oldText: 'not present' })))
    .rejects.toMatchObject({ code: 'AI_MEMORY_CONFLICT' });
});

test('an empty patch can delete one exact fragment but cannot delete the entire memory body', async () => {
  const created = await store.write('owner', input({ content: 'Keep this. Remove this.\n' }));
  const patched = await store.write('owner', input({ operation: 'patch', oldText: ' Remove this.', content: '', expectedRevision: created.revision }));
  expect(patched.content).toBe('Keep this.\n');
  await expect(store.write('owner', input({ operation: 'patch', oldText: patched.content, content: '', expectedRevision: patched.revision })))
    .rejects.toMatchObject({ code: 'AI_MEMORY_INVALID' });
  expect((await store.read('owner', { path: input().path })).revision).toBe(patched.revision);
});

test('two concurrent stale replacements across store instances cannot both overwrite the same revision', async () => {
  const initial = await store.write('owner', input());
  const other = createMemoryStore({ root: directory, now });
  const results = await Promise.allSettled([
    store.write('owner', input({ operation: 'replace', expectedRevision: initial.revision, content: 'First replacement' })),
    other.write('owner', input({ operation: 'replace', expectedRevision: initial.revision, content: 'Second replacement' }))
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.code).toBe('AI_MEMORY_CONFLICT');
});

test('concurrent appends preserve both additions and duplicate appends do not change the revision', async () => {
  await store.write('owner', input());
  await Promise.all([
    store.write('owner', input({ operation: 'append', content: 'Prefer monthly summaries.' })),
    store.write('owner', input({ operation: 'append', content: '分类优先买菜。' }))
  ]);
  const before = await store.read('owner', { path: input().path });
  expect(before.content).toContain('Prefer monthly summaries.');
  expect(before.content).toContain('分类优先买菜。');
  const duplicate = await store.write('owner', input({ operation: 'append', content: '分类优先买菜。' }));
  expect(duplicate).toMatchObject({ changed: false, revision: before.revision });
  expect((await fs.readdir(path.join(directory, ownerName('owner'))))).toEqual([input().path]);
});

test('literal and regex search support Chinese and English with bounded line results', async () => {
  await store.write('owner', input({ content: '图表 chart\n图表 CHART\n英文 english\n图表 chart\n' }));
  expect(await store.search('owner', { pattern: 'chart', limit: 2 })).toMatchObject({ count: 2, truncated: true, untrusted: true });
  const regex = await store.search('owner', { pattern: '图表|english', mode: 'regex', limit: 10 });
  expect(regex.count).toBe(4);
  expect(regex.matches.map(match => match.line)).toEqual([1, 2, 3, 4]);
  await expect(store.search('owner', { pattern: '[', mode: 'regex' })).rejects.toMatchObject({ code: 'AI_MEMORY_REGEX_INVALID' });
});

test('catastrophic regex backtracking is terminated in a worker without blocking subsequent reads', async () => {
  await store.write('owner', input({ content: `${'a'.repeat(18000)}!` }));
  const started = Date.now();
  await expect(store.search('owner', { pattern: '^(a+)+$', mode: 'regex' })).rejects.toMatchObject({ code: 'AI_MEMORY_REGEX_TIMEOUT' });
  expect(Date.now() - started).toBeLessThan(4000);
  expect((await store.list('owner')).count).toBe(1);
});

test('bounded search snippets do not split Unicode surrogate pairs', async () => {
  const saved = await store.write('owner', input({ content: `${'a'.repeat(239)}😀 trailing` }));
  for (const mode of ['literal', 'regex']) {
    const result = await store.search('owner', { pattern: 'a', mode });
    expect(result.matches[0].text).toBe(`${'a'.repeat(239)}😀`);
    expect(result.matches[0].textTruncated).toBe(true);
    expect(result.matches[0]).toMatchObject({ revision: saved.revision, lineCharLength: 249,
      returnedCharCount: 240, returnedRange: { start: 1, endExclusive: 241 } });
    expect(validateMemoryText(result.matches[0].text)).toBeTruthy();
  }
});

test.each(['literal', 'regex'])('%s search distinguishes a complete 240-character Unicode line from a longer match', async mode => {
  const exact = `English${'😀'.repeat(233)}`;
  const saved = await store.write('owner', input({ content: exact }));
  const complete = await store.search('owner', { pattern: 'English', mode });
  expect(complete).toMatchObject({ count: 1, truncated: false });
  expect(complete.matches[0]).toEqual({ path: input().path, revision: saved.revision, line: 1, text: exact,
    lineCharLength: 240, returnedCharCount: 240, returnedRange: { start: 1, endExclusive: 241 }, textTruncated: false });
  await store.write('owner', input({ operation: 'append', content: `${'中'.repeat(240)}English` }));
  const longer = await store.search('owner', { pattern: 'English', mode });
  expect(longer).toMatchObject({ count: 2, truncated: false });
  expect(longer.matches[1]).toMatchObject({ text: '中'.repeat(240), lineCharLength: 247, returnedCharCount: 240,
    returnedRange: { start: 1, endExclusive: 241 }, textTruncated: true });
  expect(longer.matches[1].text).not.toContain('English');
});

test.each(['literal', 'regex'])('%s ME03 search reports the actual 307-character line and revision', async mode => {
  const line = '超长验收关键字' + '汉'.repeat(300);
  const saved = await store.write('owner', input({ path: 'acceptance.md', content: `${line}\n超长验收关键字 第1行` }));
  const result = await store.search('owner', { pattern: '超长验收关键字', mode });
  expect(result).toMatchObject({ count: 2, truncated: false, characterUnit: 'unicode-code-point' });
  expect(result.matches[0]).toMatchObject({ path: 'acceptance.md', revision: saved.revision, line: 1,
    lineCharLength: 307, returnedCharCount: 240, returnedRange: { start: 1, endExclusive: 241 }, textTruncated: true });
  expect((await store.read('owner', { path: 'acceptance.md' })).revision).toBe(result.matches[0].revision);
});

test('a root junction and user-directory junction are rejected without following external directories', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-memory-test-'));
  try {
    const link = path.join(directory, 'linked-root');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createMemoryStore({ root: link, now }).list('owner')).rejects.toMatchObject({ code: 'AI_MEMORY_PATH_INVALID' });
    const userLink = path.join(directory, ownerName('owner'));
    await fs.symlink(outside, userLink, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.write('owner', input())).rejects.toMatchObject({ code: 'AI_MEMORY_PATH_INVALID' });
    expect(await fs.readdir(outside)).toEqual([]);
  } finally {
    if (path.dirname(path.resolve(outside)) !== path.resolve(os.tmpdir()) || !path.basename(outside).startsWith('ai-memory-test-')) throw new Error('Unsafe cleanup path');
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a hard-linked memory file is not read or overwritten', async () => {
  await store.write('owner', input());
  const own = path.join(directory, ownerName('owner'), input().path), linked = path.join(directory, 'outside.md');
  await fs.link(own, linked);
  await expect(store.read('owner', { path: input().path })).rejects.toMatchObject({ code: 'AI_MEMORY_PATH_INVALID' });
  await expect(store.write('owner', input({ operation: 'append', content: 'extra' }))).rejects.toMatchObject({ code: 'AI_MEMORY_PATH_INVALID' });
});

test('invalid memory structure, duplicate metadata and oversized content are rejected', async () => {
  await expect(store.write('owner', input({ content: 'x'.repeat(LIMITS.fileBytes + 1) }))).rejects.toMatchObject({ code: 'AI_MEMORY_INVALID' });
  await store.write('owner', input());
  const absolute = path.join(directory, ownerName('owner'), input().path);
  const raw = await fs.readFile(absolute, 'utf8');
  await fs.writeFile(absolute, raw.replace('type: "preference"', 'type: "preference"\ntype: "profile"'), 'utf8');
  expect(await store.list('owner')).toMatchObject({ count: 0, warnings: [{ path: input().path, code: 'AI_MEMORY_INVALID' }] });
});

test('one dirty file is isolated from healthy memories, searches and new writes, while its target stays protected', async () => {
  const healthy = await store.write('owner', input({ path: 'healthy.md', content: '正常中文，prefer a chart.' }));
  await store.write('owner', input({ path: 'broken.md' }));
  const broken = path.join(directory, ownerName('owner'), 'broken.md');
  await fs.writeFile(broken, Buffer.from([0xC3, 0x28]));
  const listing = await store.list('owner');
  expect(listing).toMatchObject({ count: 1, warnings: [{ path: 'broken.md', code: 'AI_MEMORY_ENCODING_INVALID' }] });
  expect(listing.files[0].path).toBe('healthy.md');
  expect(listing.totalBytes).toBe(healthy.bytes + 2);
  expect(await store.search('owner', { pattern: 'chart' })).toMatchObject({ count: 1, warnings: [{ path: 'broken.md' }] });
  expect(await store.search('owner', { pattern: '正常|chart', mode: 'regex' })).toMatchObject({ count: 1, warnings: [{ path: 'broken.md' }] });
  await expect(store.read('owner', { path: 'broken.md' })).rejects.toMatchObject({ code: 'AI_MEMORY_ENCODING_INVALID' });
  await expect(store.write('owner', input({ path: 'broken.md', operation: 'append', content: 'replacement' })))
    .rejects.toMatchObject({ code: 'AI_MEMORY_ENCODING_INVALID' });
  await store.write('owner', input({ path: 'new.md', content: '新记忆 New memory' }));
  expect((await store.list('owner')).count).toBe(2);
  expect(await fs.readFile(broken)).toEqual(Buffer.from([0xC3, 0x28]));
});

test('a missing root and user directory stay absent after ordinary list/read/search calls', async () => {
  const missingRoot = path.join(directory, 'not-created');
  const missingStore = createMemoryStore({ root: missingRoot, now });
  expect(await missingStore.list('owner')).toMatchObject({ files: [], warnings: [] });
  expect(await missingStore.search('owner', { pattern: 'chart' })).toMatchObject({ count: 0, warnings: [] });
  await expect(missingStore.read('owner', { path: 'note.md' })).rejects.toMatchObject({ code: 'AI_MEMORY_NOT_FOUND' });
  expect(await fs.stat(missingRoot).catch(error => error.code)).toBe('ENOENT');
  expect(await store.list('owner')).toMatchObject({ count: 0 });
  expect(await fs.readdir(directory)).toEqual([]);
});

test('file count and total-byte quotas are enforced before mutation', async () => {
  const seed = await store.write('owner', input({ path: 'seed.md', content: 'x'.repeat(62000) }));
  const ownerPath = path.join(directory, ownerName('owner')), raw = await fs.readFile(path.join(ownerPath, 'seed.md'));
  for (let index = 0; index < 15; index++) await fs.writeFile(path.join(ownerPath, `copy-${index}.md`), raw);
  expect(seed.bytes * 16).toBeLessThan(LIMITS.totalBytes);
  await expect(store.write('owner', input({ path: 'overflow.md', content: 'y'.repeat(62000) }))).rejects.toMatchObject({ code: 'AI_MEMORY_LIMIT' });
  expect(await fs.stat(path.join(ownerPath, 'overflow.md')).catch(error => error.code)).toBe('ENOENT');
  for (let index = 0; index < 15; index++) await fs.unlink(path.join(ownerPath, `copy-${index}.md`));
  const small = raw.toString('utf8').replace('x'.repeat(62000), 'short');
  await fs.writeFile(path.join(ownerPath, 'seed.md'), small);
  for (let index = 0; index < 49; index++) await fs.writeFile(path.join(ownerPath, `copy-${index}.md`), small);
  await expect(store.write('owner', input({ path: 'count-overflow.md' }))).rejects.toMatchObject({ code: 'AI_MEMORY_LIMIT' });
});
