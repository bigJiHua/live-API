const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const MAGIC = Buffer.from('AIMEM001');
const MAX_BYTES = 256 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\')
  && !value.includes(':') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
function key(secret, salt) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Set AI_MEMORY_BACKUP_KEY, FIELD_ENCRYPT_KEY or an explicit JWT_SECRET (at least 32 characters)');
  return crypto.scryptSync(secret, salt, 32);
}
function scan(root) {
  const files = []; let bytes = 0;
  function walk(directory, prefix = '') {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Memory backup refuses symbolic links/junctions');
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix + name, target = path.join(directory, name), stat = fs.lstatSync(target);
      if (!safePath(relative) || stat.isSymbolicLink()) throw new Error('Memory backup path is unsafe');
      if (stat.isDirectory()) walk(target, relative + '/');
      else if (stat.isFile()) {
        if (/^(?:\.memory-lock-|\.state-lock$|.*\.tmp$)/.test(name)) throw new Error('Memory writes are active; retry backup after they finish');
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw new Error('Memory backup exceeds 256 MiB');
        const data = fs.readFileSync(target);
        files.push({ path: relative, sha256: hash(data), content: data.toString('base64') });
      } else throw new Error('Memory backup accepts only ordinary files');
    }
  }
  walk(root);
  return files;
}
const inventory = files => files.map(({ path: filename, sha256 }) => ({ path: filename, sha256 }));
function backup(root, archive, secret) {
  root = path.resolve(root); archive = path.resolve(archive);
  const comparedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const comparedArchive = process.platform === 'win32' ? archive.toLowerCase() : archive;
  if (comparedArchive === comparedRoot || comparedArchive.startsWith(comparedRoot + path.sep)) throw new Error('Archive must be outside memory root');
  const files = scan(root), salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(secret, salt), iv);
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files })));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  if (JSON.stringify(inventory(files)) !== JSON.stringify(inventory(scan(root)))) throw new Error('Memory changed during backup; archive was not saved');
  fs.writeFileSync(archive, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
  return { files: files.length, bytes: files.reduce((total, file) => total + Buffer.from(file.content, 'base64').length, 0), digest: hash(JSON.stringify(inventory(files))) };
}
function readArchive(archive, secret) {
  if (fs.lstatSync(archive).size > MAX_BYTES * 2) throw new Error('Archive exceeds limit');
  const data = fs.readFileSync(archive);
  if (data.length < 52 || !data.subarray(0, 8).equals(MAGIC)) throw new Error('Memory archive format invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(secret, data.subarray(8, 24)), data.subarray(24, 36));
  decipher.setAuthTag(data.subarray(36, 52));
  const plain = Buffer.concat([decipher.update(data.subarray(52)), decipher.final()]);
  const payload = JSON.parse(zlib.gunzipSync(plain, { maxOutputLength: MAX_BYTES * 2 }).toString('utf8'));
  if (payload.version !== 1 || !Array.isArray(payload.files)) throw new Error('Memory archive version invalid');
  const names = new Set(); let bytes = 0;
  for (const file of payload.files) {
    const normalized = process.platform === 'win32' ? file.path?.toLowerCase() : file.path;
    if (!safePath(file.path) || names.has(normalized) || typeof file.content !== 'string') throw new Error('Memory archive path invalid');
    const content = Buffer.from(file.content, 'base64'); bytes += content.length;
    if (bytes > MAX_BYTES || hash(content) !== file.sha256) throw new Error('Memory archive integrity invalid');
    names.add(normalized);
  }
  return payload;
}
function restore(archive, destination, secret) {
  const payload = readArchive(archive, secret);
  destination = path.resolve(destination);
  // Never overwrite a live tree. Complete validation precedes any filesystem write.
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const file of payload.files) {
    const target = path.join(destination, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  const digest = hash(JSON.stringify(inventory(scan(destination))));
  if (digest !== hash(JSON.stringify(inventory(payload.files)))) throw new Error('Restored memory verification failed');
  return { files: payload.files.length, digest };
}
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const [action, first, second] = process.argv.slice(2);
  const secret = process.env.AI_MEMORY_BACKUP_KEY || process.env.FIELD_ENCRYPT_KEY || process.env.JWT_SECRET;
  try {
    if (!first || !['backup', 'verify', 'restore'].includes(action) || action !== 'verify' && !second)
      throw new Error('Usage: backup <memoryRoot> <newArchive> | verify <archive> | restore <archive> <newDirectory>');
    const result = action === 'backup' ? backup(first, second, secret) : action === 'restore'
      ? restore(first, second, secret) : { verified: true, files: readArchive(first, secret).files.length };
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { backup, restore, readArchive, scan };
