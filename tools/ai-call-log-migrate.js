// 追加164（2026-11-07）：应用 021 迁移（ai_call_log + ai_user_preference）。
// 沿用 ai-business-migrate.js 安全模式：只允许 AI 表 DDL、正式表快照前后一致、幂等可重复执行。
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const db = require('../src/common/config/db');
const FILE = '019_consolidated_20261111.sql';
async function main() {
  const conn = await db.getConnection();
  try {
    const [existing] = await conn.execute('SELECT filename FROM _migrations');
    const statements = fs.readFileSync(path.join(__dirname, '../mysql/migrations', FILE), 'utf8')
      .replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/).map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
    assert.ok(statements.every(sql => /^CREATE TABLE IF NOT EXISTS `ai_|^ALTER TABLE `ai_(?:conversation|call_log)`|^INSERT IGNORE INTO `ai_provider_profile`/i.test(sql)), 'Only AI DDL is permitted');
    const [tables] = await conn.query('SHOW TABLES');
    const formal = tables.map(row => Object.values(row)[0]).filter(table => !/^ai_|^bus_ai_draft$|^_migrations$/.test(table));
    async function snapshot() {
      const values = {};
      for (const table of formal) {
        assert.match(table, /^[a-z_]+$/);
        const [cols] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
        const names = cols.map(col => { assert.match(col.Field, /^[a-zA-Z_0-9]+$/); return `\`${col.Field}\``; });
        const [rows] = await conn.query(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',${names.join(',')}))) AS digest FROM \`${table}\``);
        values[table] = rows[0];
      }
      return values;
    }
    const before = await snapshot();
    for (const sql of statements) {
      try { await conn.query(sql); }
      catch (error) { if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) throw error; }
    }
    if (!existing.some(row => row.filename === FILE)) await conn.execute('INSERT INTO _migrations (filename) VALUES (?)', [FILE]);
    assert.deepEqual(await snapshot(), before, 'Formal tables changed during the AI schema-only migration');
    console.log(JSON.stringify({ migration: FILE, statements: statements.length,
      aiTables: statements.filter(sql => /^CREATE TABLE IF NOT EXISTS `ai_/i.test(sql)).length,
      formalTablesUnchanged: formal.length, idempotent: true }));
  } finally { conn.release(); await db.getPool().end(); }
}
main().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1; });
