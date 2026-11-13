const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStore } = require('../../src/modules/ai/service/memoryStore');

let directory, store;
const owner = 'timestamp-test-owner', filename = '时间偏好.md';
const ownerHash = crypto.createHash('sha256').update(owner).digest('hex');
const content = '中文 English：时间只是笔记内容。\n';
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-memory-timestamp-test-'));
  store = createMemoryStore({ root: directory, now: () => new Date('2026-11-10T01:00:00.000Z') });
});
afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('ai-memory-timestamp-test-')) throw Error('Unsafe timestamp test cleanup');
  await fs.rm(directory, { recursive: true, force: true });
});
async function manualMetadata(created, updated, body = content) {
  await store.write(owner, { path: filename, operation: 'create', title: '时间偏好', type: 'note', content: body, sourceText: '请逐字保存时间笔记。' });
  const file = path.join(directory, ownerHash, filename), raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace(/^created: .*$/m, 'created: ' + JSON.stringify(created)).replace(/^updated: .*$/m, 'updated: ' + JSON.stringify(updated)), 'utf8');
  return file;
}
test.each([
  ['invalid created day', '2026-02-31T00:48:07.498Z', '2026-03-03T00:48:07.498Z'],
  ['invalid updated day', '2026-02-28T00:48:07.498Z', '2026-02-31T00:48:07.498Z'],
  ['non-leap February 29', '2026-02-29T00:48:07Z', '2026-03-01T00:48:07Z'],
  ['valid timestamps in reversed order', '2028-03-01T00:48:07.498Z', '2028-02-29T00:48:07.498Z'],
])('%s is rejected by read and omitted with a warning by list', async (_, created, updated) => {
  const file = await manualMetadata(created, updated), original = await fs.readFile(file);
  await expect(store.read(owner, { path: filename })).rejects.toMatchObject({ code: 'AI_MEMORY_INVALID' });
  const index = await store.list(owner);
  expect(index.files).toEqual([]); expect(index.count).toBe(0);
  expect(index.warnings).toContainEqual({ path: filename, code: 'AI_MEMORY_INVALID', message: '记忆文件元信息无效' });
  expect(await fs.readFile(file)).toEqual(original);
});
test.each([
  ['whole-second UTC leap day', '2028-02-29T00:48:07Z', '2028-02-29T00:48:07Z'],
  ['millisecond UTC leap day', '2028-02-29T00:48:07.498Z', '2028-02-29T00:48:07.499Z'],
  ['actual later UTC day', '2028-02-29T00:48:07Z', '2028-03-01T00:48:07Z'],
])('%s preserves valid metadata and the original body', async (_, created, updated) => {
  await manualMetadata(created, updated);
  const entry = await store.read(owner, { path: filename });
  expect(entry).toMatchObject({ created, updated, content });
  const index = await store.list(owner);
  expect(index.files).toHaveLength(1); expect(index.warnings).toEqual([]);
});
test('timestamp validation applies only to metadata and leaves body examples opaque', async () => {
  const body = '原文日期示例：2026-02-31T00:48:07Z。\nEnglish example: 2026-04-31T00:00:00Z.\n';
  await manualMetadata('2028-02-29T00:48:07Z', '2028-03-01T00:48:07Z', body);
  expect((await store.read(owner, { path: filename })).content).toBe(body);
});
