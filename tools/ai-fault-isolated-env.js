// Real-fault acceptance environment: isolated MySQL schema + independent API process.
// setup   : create an isolated schema, fixtures, grants, and evidence env.json
// server  : start the real Express app bound ONLY to the isolated schema
// snapshot: emit per-fixture ledger/draft/receipt facts for assertion
// cleanup : revoke the temporary grant and drop the isolated schema (explicit only)
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '..', 'temp', 'api-logs-archive', 'ai-business-evidence', 'fault-2026-11-06');
const ENV_FILE = path.join(EVIDENCE_DIR, 'env.json');
const uid = () => crypto.randomUUID();
const ident = value => { assert.match(value, /^[A-Za-z0-9_]{1,64}$/); return '`' + value + '`'; };
const safeTarget = (target, source) => {
  assert.match(target, /^ai_fault_verify_\d{8}_[a-f0-9]{8}$/);
  assert.notEqual(target, source);
  return ident(target);
};

// Six full-UI cases (priority 1) + three network-fault cases (priority 2).
const CASES = [
  { id: 'F1', label: '0.01 元最小金额', balance: '0.01', amount: '0.01', expect: 'committed' },
  { id: 'F2', label: '39.91 元精度', balance: '100.00', amount: '39.91', expect: 'committed' },
  { id: 'F3', label: '余额恰好够', balance: '100.00', amount: '100.00', expect: 'committed' },
  { id: 'F4', label: '余额不足早停', balance: '50.00', amount: '1000.00', expect: 'blocked' },
  { id: 'F5', label: '大额二次确认', balance: '20000.00', amount: '10000.00', expect: 'committed' },
  { id: 'F6', label: '修改后重新核对', balance: '100.00', amount: '39.91', editedAmount: '12.34', expect: 'committed' },
  { id: 'N1', label: '提交前断网', balance: '500.00', amount: '39.91', expect: 'offline-before' },
  { id: 'N2', label: '提交过程中断网', balance: '500.00', amount: '39.91', expect: 'offline-during' },
  { id: 'N3', label: '提交成功但响应丢失', balance: '500.00', amount: '39.91', expect: 'ack-lost' },
];

function baseConfig() {
  return { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
    connectTimeout: 5000, multipleStatements: false, dateStrings: true, decimalNumbers: false };
}
async function formalSnapshot(conn, database) {
  const [tables] = await conn.execute('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME', [database]);
  const out = {};
  await conn.query('SET TRANSACTION READ ONLY');
  await conn.beginTransaction();
  try {
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
      const [rows] = await conn.query(`SELECT * FROM ${ident(name)}`);
      const hashes = rows.map(row => crypto.createHash('sha256').update(JSON.stringify(
        Object.keys(row).sort().map(key => [key, row[key]]))).digest('hex')).sort();
      out[name] = { rows: rows.length, digest: crypto.createHash('sha256').update(hashes.join('\n')).digest('hex') };
    }
  } finally { await conn.rollback(); }
  return out;
}
async function grantReadOnly(admin, target) {
  const user = process.env.AI_DB_USER;
  assert.ok(user && user.toLowerCase() !== 'root', 'AI_DB_USER must be a non-root read-only account');
  const [accounts] = await admin.execute('SELECT user,host FROM mysql.user WHERE user=?', [user]);
  assert.ok(accounts.length, 'AI_DB_USER account is missing');
  const granted = [];
  for (const account of accounts) {
    await admin.query(`GRANT SELECT ON ${ident(target)}.* TO ?@?`, [account.user, account.host]);
    granted.push(`${account.user}@${account.host}`);
  }
  return granted;
}
async function revokeReadOnly(admin, target, accounts) {
  for (const entry of accounts || []) {
    const at = entry.lastIndexOf('@');
    await admin.query(`REVOKE SELECT ON ${ident(target)}.* FROM ?@?`, [entry.slice(0, at), entry.slice(at + 1)]).catch(() => {});
  }
}

async function setup() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const base = baseConfig();
  const source = process.env.DB_NAME || 'live_dev';
  ident(source);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const target = `ai_fault_verify_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
  safeTarget(target, source);
  const sourceConn = await mysql.createConnection({ ...base, database: source });
  const admin = await mysql.createConnection(base);
  let pool;
  const env = { createdAt: new Date().toISOString(), sourceDatabase: source, targetDatabase: target,
    apiPort: 7790, webPort: 5175, providerCallsExpected: 0, fixtures: [],
    formalBefore: null, readOnlyGrants: [], retainedTemporaryDatabase: true, phase: 'init' };
  try {
    env.phase = 'formal-before-snapshot';
    env.formalBefore = await formalSnapshot(sourceConn, source);

    env.phase = 'create-isolated-schema';
    await admin.query(`CREATE DATABASE ${safeTarget(target, source)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ ...base, database: target, connectionLimit: 8 });
    const [resolved] = await pool.query('SELECT DATABASE() AS name');
    assert.equal(resolved[0].name, target);
    const schema = fs.readFileSync(path.join(ROOT, 'mysql/live.sql'), 'utf8');
    const creates = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+`([A-Za-z0-9_]+)`\s*\([\s\S]*?\)\s*ENGINE=[^;]+;/g)];
    assert.ok(creates.length >= 35, 'live.sql must contain the integrated schema');
    assert.ok(creates.some(match => match[1] === 'ai_transaction_candidate'), '020 candidate table must be in live.sql');
    for (const match of creates) if (match[1] !== 'ai_transaction_candidate') await pool.query(match[0]);
    await pool.query('CREATE TABLE _migrations (filename VARCHAR(255) NOT NULL,applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(filename)) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC');
    const migrationConn = await pool.getConnection();
    try {
      const report = await require('./ai-financial-migrate').applyCandidateMigration(migrationConn);
      assert.equal(report.financialDataInserted, 0);
    } finally { migrationConn.release(); }
    env.schemaTables = creates.map(match => match[1]);

    env.phase = 'read-only-grant';
    env.readOnlyGrants = await grantReadOnly(admin, target);

    env.phase = 'fixtures';
    const today = require('../src/modules/ai/service/validation').todayShanghai();
    for (let index = 0; index < CASES.length; index++) {
      const spec = CASES[index];
      const owner = uid(), category = uid(), incomeCategory = uid(), account = uid();
      const time = String(Date.now());
      await pool.execute('INSERT INTO user_info (id,username,email,login_pwd,create_time) VALUES (?,?,?,?,?)',
        [owner, `fault_${spec.id}_${index}`, `fault-${spec.id}@example.invalid`, 'isolated-no-login', time]);
      await pool.execute('INSERT INTO bus_category (id,user_id,name,type) VALUES (?,?,?,?),(?,?,?,?)',
        [category, owner, '餐饮', 'expense', incomeCategory, owner, '工资', 'income']);
      await pool.execute(`INSERT INTO card_base
        (id,user_id,bank_id,card_type,last4_no,card_bin,open_date,expire_date,credit_limit,temp_limit,bill_day,repay_day,currency,status,alias,create_time,update_time)
        VALUES (?,?,?,?,?,?,?,?,?,0,5,25,'CNY','正常',?,?,?)`,
        [account, owner, '隔离验收银行', 'debit', '0000', '000000', today, '2030-01-01', '0.00', '隔离验收卡000', time, time]);
      const initialLedgerId = uid();
      await pool.execute(`INSERT INTO account
        (id,user_id,direction,category_id,pay_type,pay_method,account_type,amount,currency,exchange_rate,trans_date,remark,card_id,create_time,is_deleted,reversed_id)
        VALUES (?,?,?,?,?,'银行卡','',?,?,1,?,'隔离验收初始资金',?,?,0,NULL)`,
        [initialLedgerId, owner, 1, incomeCategory, '工资', spec.balance, 'CNY', today, account, time]);
      env.fixtures.push({ ...spec, userId: owner, accountId: account, categoryId: category,
        incomeCategoryId: incomeCategory, initialLedgerId, today });
    }

    env.phase = 'formal-after-snapshot';
    env.formalAfter = await formalSnapshot(sourceConn, source);
    env.formalSummaryUnchanged = JSON.stringify(env.formalBefore) === JSON.stringify(env.formalAfter);
    assert.equal(env.formalSummaryUnchanged, true, 'formal database changed during isolated setup');
    env.result = 'ready';
    env.phase = 'done';
  } catch (error) {
    env.result = 'failed';
    env.error = { code: error.code || error.name, phase: env.phase };
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.end().catch(() => {});
    await sourceConn.end().catch(() => {});
    fs.writeFileSync(ENV_FILE, JSON.stringify(env, null, 2) + '\n');
    console.log(JSON.stringify({ result: env.result, targetDatabase: target, fixtures: env.fixtures.length,
      formalTables: Object.keys(env.formalBefore || {}).length, formalSummaryUnchanged: env.formalSummaryUnchanged,
      readOnlyGrants: env.readOnlyGrants.length, error: env.error, envFile: ENV_FILE }));
  }
}

function loadEnv() {
  const env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'));
  assert.equal(env.result, 'ready');
  assert.notEqual(env.targetDatabase, process.env.DB_NAME);
  return env;
}
async function server() {
  const env = loadEnv();
  const base = baseConfig();
  Object.assign(process.env, {
    DB_NAME: env.targetDatabase,
    AI_DB_NAME: env.targetDatabase,
    AI_DB_HOST: base.host, AI_DB_PORT: String(base.port),
    AI_DB_USER: process.env.AI_DB_USER, AI_DB_PASSWORD: process.env.AI_DB_PASSWORD,
    AI_MODE: 'deepseek', AI_SYNTHETIC_DATA: 'false', INIT_SKIP: 'true',
    AI_BUSINESS_ENABLED: 'true', AI_BUSINESS_DOMAINS: 'finance', AI_BUSINESS_ACTIONS: 'transaction.create',
    AI_ALLOW_SESSION_SETTINGS: 'false', PORT: String(env.apiPort),
  });
  const { getConfig } = require('../src/modules/ai/service/config');
  const config = getConfig();
  assert.equal(config.mode, 'deepseek');
  assert.equal(config.dataSource, 'user-readonly');
  assert.equal(config.db.database, env.targetDatabase);
  const app = require('../app');
  const listener = app.listen(env.apiPort, '127.0.0.1', () => {
    console.log(JSON.stringify({ isolatedServer: true, port: env.apiPort, database: env.targetDatabase,
      aiReadOnlyDatabase: config.db.database, providerMode: config.mode }));
  });
  listener.on('error', error => { console.error(JSON.stringify({ isolatedServer: false, code: error.code })); process.exitCode = 1; });
}

async function snapshot() {
  const env = loadEnv();
  const base = baseConfig();
  const pool = mysql.createPool({ ...base, database: env.targetDatabase, connectionLimit: 4 });
  const sourceConn = await mysql.createConnection({ ...base, database: env.sourceDatabase });
  const out = { capturedAt: new Date().toISOString(), targetDatabase: env.targetDatabase, fixtures: [], totals: {} };
  try {
    for (const f of env.fixtures) {
      const [expenses] = await pool.execute('SELECT id,amount,direction,is_deleted,remark,create_time FROM account WHERE user_id=? AND direction=0 ORDER BY create_time', [f.userId]);
      const [drafts] = await pool.execute('SELECT id,status,version,amount,committed_record_id,source FROM bus_ai_draft WHERE user_id=? ORDER BY created_at', [f.userId]);
      const [requests] = await pool.execute('SELECT COUNT(*) AS count,COALESCE(SUM(provider_calls),0) AS providerCalls FROM ai_request_run WHERE user_id=?', [f.userId]);
      const [incomes] = await pool.execute('SELECT COUNT(*) AS count FROM account WHERE user_id=? AND direction=1 AND is_deleted=0', [f.userId]);
      out.fixtures.push({ id: f.id, label: f.label, userId: f.userId,
        expenseRows: expenses.length, expenses: expenses.map(row => ({ amount: row.amount, isDeleted: row.is_deleted, id: row.id })),
        incomeRows: Number(incomes[0].count),
        drafts: drafts.map(row => ({ status: row.status, version: row.version, amount: row.amount, committedRecordId: row.committed_record_id, source: row.source })),
        requestRows: Number(requests[0].count), providerCalls: Number(requests[0].providerCalls) });
    }
    out.totals = out.fixtures.reduce((acc, f) => ({ expenseRows: acc.expenseRows + f.expenseRows,
      providerCalls: acc.providerCalls + f.providerCalls, committedDrafts: acc.committedDrafts + f.drafts.filter(d => d.status === 'committed').length }),
      { expenseRows: 0, providerCalls: 0, committedDrafts: 0 });
    const after = await formalSnapshot(sourceConn, env.sourceDatabase);
    out.formalSummaryUnchanged = JSON.stringify(env.formalBefore) === JSON.stringify(after);
  } finally {
    await pool.end().catch(() => {});
    await sourceConn.end().catch(() => {});
  }
  const file = path.join(EVIDENCE_DIR, process.argv[3] ? `snapshot-${process.argv[3]}.json` : 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ ...out.totals, formalSummaryUnchanged: out.formalSummaryUnchanged, snapshotFile: file }));
  return out;
}

async function cleanup() {
  const env = loadEnv();
  const base = baseConfig();
  const admin = await mysql.createConnection(base);
  try {
    await revokeReadOnly(admin, env.targetDatabase, env.readOnlyGrants);
    await admin.query(`DROP DATABASE ${safeTarget(env.targetDatabase, env.sourceDatabase)}`);
    env.retainedTemporaryDatabase = false;
    env.cleanedAt = new Date().toISOString();
    fs.writeFileSync(ENV_FILE, JSON.stringify(env, null, 2) + '\n');
    console.log(JSON.stringify({ cleaned: true, targetDatabase: env.targetDatabase }));
  } finally { await admin.end().catch(() => {}); }
}

const command = process.argv[2];
const commands = { setup, server, snapshot, cleanup };
if (!commands[command]) { console.error(JSON.stringify({ error: 'UNKNOWN_COMMAND', usage: Object.keys(commands) })); process.exitCode = 1; }
else Promise.resolve(commands[command]()).catch(error => {
  console.error(JSON.stringify({ failed: true, code: error.code || error.name }));
  process.exitCode = 1;
});
