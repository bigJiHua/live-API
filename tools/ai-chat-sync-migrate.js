// Apply the consolidated AI migration. Never dispatch accounting migrations.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const db = require('../src/common/config/db');
const FILE = '019_consolidated_20261111.sql';
async function main() {
  const statements = fs.readFileSync(path.join(__dirname, '../mysql/migrations', FILE), 'utf8')
    .replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/)
    .map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  assert.ok(statements.every(sql => /^CREATE TABLE IF NOT EXISTS `ai_|^ALTER TABLE `ai_(?:conversation|call_log)`|^INSERT IGNORE INTO `ai_provider_profile`/i.test(sql)), 'Only AI schema DDL is permitted');
  await db.execute(`CREATE TABLE IF NOT EXISTS _migrations (
    filename VARCHAR(255) NOT NULL PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC`);
  for (let pass = 1; pass <= 2; pass++) for (const sql of statements) {
    try { await db.execute(sql); }
    catch (error) { if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) throw error; }
  }
  await db.execute('INSERT IGNORE INTO _migrations (filename) VALUES (?)', [FILE]);
  console.log(JSON.stringify({ migration: FILE, statements: statements.length, registered: true, idempotent: true, accountingWrites: 0 }));
  await db.getPool().end();
}
main().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1; });
