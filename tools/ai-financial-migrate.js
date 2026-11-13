// Explicitly apply the consolidated AI migration. No app startup, old migrations, financial repairs, or fixtures.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../src/common/config/db');
const FILE = '019_consolidated_20261111.sql';

async function applyCandidateMigration(conn) {
  const statements = fs.readFileSync(path.join(__dirname, '../mysql/migrations', FILE), 'utf8')
    .replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/)
    .map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  assert.ok(statements.every(sql => /^CREATE TABLE IF NOT EXISTS `ai_|^ALTER TABLE `ai_(?:conversation|call_log)`|^INSERT IGNORE INTO `ai_provider_profile`/i.test(sql)), 'Only AI schema DDL is permitted');
  assert.ok(statements.every(sql => !/^(?:DROP|UPDATE|DELETE|REPLACE|TRUNCATE|CALL|GRANT)\b/i.test(sql)), 'Financial or unrelated mutations are forbidden');
  const [existing] = await conn.execute('SELECT filename FROM _migrations');
  const [tables] = await conn.query('SHOW TABLES');
  const formal = tables.map(row => Object.values(row)[0]).filter(name => !/^ai_|^bus_ai_draft$|^_migrations$/.test(name));
  async function snapshot() {
    const result = {};
    for (const table of formal) {
      assert.match(table, /^[A-Za-z_0-9]+$/);
      const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
      const hashes = rows.map(row => crypto.createHash('sha256').update(JSON.stringify(
        Object.keys(row).sort().map(key => [key, row[key]]))).digest('hex')).sort();
      result[table] = { count: rows.length, digest: crypto.createHash('sha256').update(hashes.join('\n')).digest('hex') };
    }
    return result;
  }
  const before = await snapshot();
  // Verify repeatability without changing any existing AI rows.
  for (let pass = 1; pass <= 2; pass++) for (const sql of statements) {
    try { await conn.query(sql); }
    catch (error) { if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) throw error; }
  }
  if (!existing.some(row => row.filename === FILE)) await conn.execute('INSERT INTO _migrations (filename) VALUES (?)', [FILE]);
  assert.deepEqual(await snapshot(), before, 'Formal table summaries changed during AI schema migration');
  return { migration: FILE, statements: statements.length,
    createdAiTables: statements.filter(sql => /^CREATE TABLE IF NOT EXISTS `ai_/i.test(sql)).length,
    formalTablesUnchanged: formal.length, idempotent: true,
    historicalMigrationsExecuted: 0, financialDataInserted: 0 };
}

async function main() {
  const conn = await db.getConnection();
  try { const report = await applyCandidateMigration(conn); console.log(JSON.stringify(report)); return report; }
  finally { conn.release(); await db.getPool().end(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1; });
module.exports = { main, applyCandidateMigration, FILE };
