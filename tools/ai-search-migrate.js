// Explicit executor only; importing this module never opens a database.
const COLUMNS = Object.freeze([
  ['search_daily_calls', 'INT UNSIGNED DEFAULT NULL'],
  ['search_usage_day', 'CHAR(10) DEFAULT NULL'],
  ['search_calls_used', 'INT UNSIGNED NOT NULL DEFAULT 0'],
]);
async function applySearchMigration(executor) {
  if (!executor?.execute) throw new Error('Search migration requires an explicit executor');
  for (const [column, ddl] of COLUMNS) {
    try { await executor.execute(`ALTER TABLE ai_config ADD COLUMN ${column} ${ddl}`); }
    catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
  }
  const [columns] = await executor.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_config'");
  if (!COLUMNS.every(([name]) => columns.some(row => row.COLUMN_NAME === name))) throw new Error('Search schema verification failed');
  return { columns: COLUMNS.map(([name]) => name), idempotent: true, businessWrites: 0 };
}
if (require.main === module) {
  const target = process.argv[2];
  if (!target || !/^[a-zA-Z0-9_]+$/.test(target)) {
    console.error('Usage: node tools/ai-search-migrate.js <explicit_database_name>');
    process.exitCode = 1;
  } else {
    // Do not silently follow DB_NAME: the database must be named in the command.
    require('dotenv').config({ quiet: true });
    const mysql = require('mysql2/promise');
    (async () => {
      const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: target });
      try { console.log(JSON.stringify({ database: target, ...await applySearchMigration(connection) })); }
      finally { await connection.end(); }
    })().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1; });
  }
}
module.exports = { applySearchMigration, COLUMNS };
