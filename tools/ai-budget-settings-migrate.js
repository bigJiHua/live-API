const fs = require('fs');
const path = require('path');
const FILE = '020_ai_user_budget_settings.sql';
async function applyBudgetSettingsMigration(conn) {
  const statements = fs.readFileSync(path.join(__dirname, '../mysql/migrations', FILE), 'utf8')
    .replace(/\r\n/g, '\n').split(/;\s*(?:\n|$)/)
    .map(part => part.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
  for (const sql of statements) {
    if (!/^(?:CREATE TABLE IF NOT EXISTS ai_config\b|ALTER TABLE (?:ai_config|ai_user_preference)\b|INSERT IGNORE INTO ai_config\b|UPDATE ai_config\b)/.test(sql)) throw new Error('Unexpected migration scope');
    try { await conn.query(sql); }
    catch (error) { if (!['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) throw error; }
  }
  const [rows] = await conn.execute('SELECT daily_provider_calls,max_usage_tokens,max_output_tokens,provider_timeout_ms,turn_timeout_ms FROM ai_config WHERE id=1');
  const [columns] = await conn.execute("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_user_preference'");
  const required = ['daily_provider_calls', 'max_usage_tokens', 'max_output_tokens', 'provider_timeout_ms', 'turn_timeout_ms'];
  if (!rows[0] || required.some(key => rows[0][key] == null || !columns.some(column => column.COLUMN_NAME === key))) throw new Error('Budget migration verification failed');
  await conn.query('CREATE TABLE IF NOT EXISTS _migrations (filename VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
  await conn.execute('INSERT IGNORE INTO _migrations (filename) VALUES (?)', [FILE]);
  return { migration: FILE, defaults: rows[0], userColumns: required };
}
if (require.main === module) {
  const target = process.argv[2];
  if (!target || !/^[a-zA-Z0-9_]+$/.test(target)) {
    console.error('Usage: node tools/ai-budget-settings-migrate.js <explicit_database_name>'); process.exitCode = 1;
  } else {
    require('dotenv').config({ quiet: true });
    (async () => {
      const conn = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: target, connectTimeout: 5000 });
      try { console.log(JSON.stringify({ database: target, ...await applyBudgetSettingsMigration(conn) })); }
      finally { await conn.end(); }
    })().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1; });
  }
}
module.exports = { applyBudgetSettingsMigration };
