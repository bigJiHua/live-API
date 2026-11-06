// Opt-in verification against the configured database. Never load app.js or run migrations.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

async function inspect() {
  const env = { ...dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env'))), ...process.env };
  const { getConfig } = require('../src/modules/ai/service/config');
  const config = getConfig(env);
  if (config.mode !== 'deepseek' || config.dataSource !== 'user-readonly') {
    throw Object.assign(new Error('Real-data configuration required'), { code: 'AI_REAL_CONFIG_REQUIRED' });
  }
  const read = await mysql.createConnection({ ...config.db, connectTimeout: 5000,
    multipleStatements: false, dateStrings: true });
  let write;
  try {
    const [grants] = await read.query('SHOW GRANTS');
    const privileges = grants.map(row => String(Object.values(row)[0]).split(' ON ')[0].replace(/^GRANT /, ''));
    const readOnly = privileges.every(value => value === 'USAGE' || value.split(', ').every(p => p === 'SELECT'));
    if (!readOnly) throw Object.assign(new Error('AI account has write privileges'), { code: 'AI_READ_GRANTS_UNSAFE' });
    await read.query('SET TRANSACTION READ ONLY');
    await read.beginTransaction();
    const [owners] = await read.execute('SELECT DISTINCT user_id FROM account WHERE is_deleted = 0 LIMIT 2');
    const userId = process.env.AI_TEST_USER_ID || (owners.length === 1 ? owners[0].user_id : null);
    if (!userId) throw Object.assign(new Error('Select a test owner explicitly'), { code: 'AI_TEST_USER_REQUIRED' });
    const [base] = await read.execute('SELECT COUNT(*) AS count FROM account WHERE user_id = ? AND is_deleted = 0', [userId]);
    await read.rollback();

    write = await mysql.createConnection({ host: env.DB_HOST || 'localhost', port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || 'root', password: env.DB_PASSWORD || '', database: env.DB_NAME || 'live',
      multipleStatements: false, connectTimeout: 5000, dateStrings: true });
    const [schema] = await write.execute(`SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
      ('account','account_balance','card_base','card_bill','bus_ai_draft','ai_conversation','ai_message')`);
    const [columns] = await write.execute(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='bus_ai_draft' AND COLUMN_NAME IN ('amount','trans_date','status')`);
    const { createReadRepository } = require('../src/modules/ai/service/readRepository');
    const repo = createReadRepository(config.db);
    try {
      const today = require('../src/modules/ai/service/validation').todayShanghai();
      const range = { startDate: today.slice(0, 7) + '-01', endDate: today };
      const summary = await repo.summary(userId, range);
      const detail = await repo.transactions(userId, { ...range, limit: 20, offset: 0 });
      const choices = await repo.choices(userId);
      const other = await repo.summary('ai_verify_no_such_user', range);
      const sameCount = Number(summary.count) === Number(detail.total);
      if (!sameCount || Number(other.count) !== 0 || detail.rows.length > 20) {
        throw Object.assign(new Error('Read boundary verification failed'), { code: 'AI_REAL_READ_MISMATCH' });
      }
      // Output only schema and aggregate verification metadata, never keys/IDs/remarks.
      console.log(JSON.stringify({ mode: config.mode, source: config.dataSource, readOnlyPrivileges: readOnly,
        ownerSelection: process.env.AI_TEST_USER_ID ? 'explicit' : 'sole-ledger-owner',
        ledgerRows: Number(base[0].count), range, summaryCount: Number(summary.count),
        returnedRows: detail.rows.length, hasMore: detail.hasMore,
        candidates: { categories: choices.categories.length, accounts: choices.accounts.length },
        countMatches: sameCount, absentUserHasNoData: Number(other.count) === 0, schema, draftColumns: columns }));
    } finally { await repo.close(); }
  } finally {
    await read.end();
    if (write) await write.end();
  }
}

if (require.main === module) inspect().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'AI_REAL_VERIFY_FAILED', status: error.status || null }));
  process.exitCode = 1;
});
module.exports = { inspect };
