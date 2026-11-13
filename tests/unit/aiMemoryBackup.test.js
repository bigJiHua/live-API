const fs = require('fs');
const os = require('os');
const path = require('path');
const { backup, restore, readArchive } = require('../../tools/ai-memory-backup');
const secret = 'isolated-memory-archive-key-0123456789';
let root, memory, archive;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-archive-'));
  memory = path.join(root, 'memory'); archive = path.join(root, 'memory.aibak');
  fs.mkdirSync(path.join(memory, 'user'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'user', 'preferences.md'), '# 合成记忆\n喜欢安静\n');
  fs.writeFileSync(path.join(memory, 'user', 'state.json'), JSON.stringify({ revision: 'keep-exact', disabledMemories: ['preferences.md'] }));
});
afterEach(() => {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('ai-memory-archive-')) throw new Error('Unsafe cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
});
test('encrypted archive restores exact memory bytes and personalization state; original is unchanged', () => {
  const result = backup(memory, archive, secret);
  expect(fs.readFileSync(archive).includes(Buffer.from('喜欢安静'))).toBe(false);
  expect(readArchive(archive, secret).files).toHaveLength(2);
  const destination = path.join(root, 'restored');
  expect(restore(archive, destination, secret)).toEqual({ files: 2, digest: result.digest });
  for (const name of ['preferences.md', 'state.json']) expect(fs.readFileSync(path.join(destination, 'user', name))).toEqual(fs.readFileSync(path.join(memory, 'user', name)));
});
test('wrong key and tampering are rejected before creating destination', () => {
  backup(memory, archive, secret);
  const destination = path.join(root, 'restored');
  expect(() => restore(archive, destination, secret + '-wrong')).toThrow();
  const bytes = fs.readFileSync(archive); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(archive, bytes);
  expect(() => restore(archive, destination, secret)).toThrow();
  expect(fs.existsSync(destination)).toBe(false);
});
test('neither a prior archive nor a live destination can be overwritten', () => {
  backup(memory, archive, secret);
  const bytes = fs.readFileSync(archive);
  expect(() => backup(memory, archive, secret)).toThrow();
  expect(() => restore(archive, memory, secret)).toThrow();
  expect(fs.readFileSync(archive)).toEqual(bytes);
});
test.each(['.state-lock', '.memory-lock-test', 'write.tmp'])('active write marker %s prevents a misleading backup', marker => {
  fs.writeFileSync(path.join(memory, 'user', marker), 'locked');
  expect(() => backup(memory, archive, secret)).toThrow(/writes are active/);
  expect(fs.existsSync(archive)).toBe(false);
});
test('archive cannot be placed inside the source tree', () => {
  expect(() => backup(memory, path.join(memory, 'archive.aibak'), secret)).toThrow(/outside/);
});
