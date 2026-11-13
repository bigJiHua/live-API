// Explicit deployment step: extend the configured AI account's SELECT grants
// only to the fixed business-read table registry. No wildcard or write grant.
const assert = require('assert/strict');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname,'../.env') });
const { getConfig } = require('../src/modules/ai/service/config');
const TABLES = Object.freeze(['account','account_balance','card_base','card_bill','card_repay','card_credit_pool','card_foreign_register','bus_category',
  'budget','todo','work_salary','work_job','asset_snapshot','asset_register','fixed_asset','fund','bus_fund_history','bus_recurring']);
const forbidden = ['user_info','user_log','device_crypto','security_verify_log','sys_attachment'];
async function main() {
  const config = getConfig();
  assert.equal(config.dataSource,'user-readonly'); assert.equal(config.db.database,process.env.DB_NAME || 'live');
  assert.match(config.db.database,/^[A-Za-z_0-9]+$/);
  assert.ok(TABLES.every(table => /^[A-Za-z_0-9]+$/.test(table) && !forbidden.includes(table)));
  const read = await mysql.createConnection({ ...config.db,multipleStatements: false,connectTimeout: 5000 });
  const admin = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost',port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',password: process.env.DB_PASSWORD || '',database: process.env.DB_NAME || 'live',multipleStatements: false,connectTimeout: 5000 });
  try {
    const [current] = await read.query('SELECT CURRENT_USER() AS account');
    const account = current[0].account, at = account.lastIndexOf('@'), user = account.slice(0,at), host = account.slice(at+1);
    assert.equal(user,config.db.user); assert.ok(host && at > 0);
    const principal = admin.escape(user) + '@' + admin.escape(host);
    for (const table of TABLES) await admin.query(`GRANT SELECT ON \`${config.db.database}\`.\`${table}\` TO ${principal}`);
    const [grants] = await read.query('SHOW GRANTS');
    const prefixes = grants.map(row => String(Object.values(row)[0]).split(' ON ')[0].replace(/^GRANT /,''));
    assert.ok(prefixes.every(value => value === 'USAGE' || value.split(', ').every(privilege => privilege === 'SELECT')),'AI account must have no write or grant privilege');
    // Validate every allowed table using the actual read-only principal.
    for (const table of TABLES) await read.query(`SELECT 1 FROM \`${table}\` LIMIT 0`);
    for (const table of forbidden) await assert.rejects(read.query(`SELECT 1 FROM \`${table}\` LIMIT 0`),cause => cause.code === 'ER_TABLEACCESS_DENIED_ERROR');
    const report = { grantedBusinessTables: TABLES.length,readOnly: true,wildcardGrantAdded: false,sensitiveTablesDenied: forbidden.length };
    console.log(JSON.stringify(report)); return report;
  } finally { await read.end(); await admin.end(); }
}
if (require.main === module) main().catch(cause => { console.error(JSON.stringify({ failed: true,code: cause.code || cause.name })); process.exitCode = 1; });
module.exports = { main,TABLES };
