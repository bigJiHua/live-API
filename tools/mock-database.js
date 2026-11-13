'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { createContext, digest } = require('./mock/context');
const { validate } = require('./mock/validate');
const API_ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.resolve(API_ROOT, '../temp/mock-databases');
const TRACK_SQL = 'CREATE TABLE `_migrations` (`filename` VARCHAR(255) NOT NULL, `applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (`filename`)) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC;';
const PLACEHOLDER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1cAAAAASUVORK5CYII=', 'base64');

function identifier(name) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('无效数据库标识符');
  return '`' + name + '`';
}
function assertTarget(database, source = process.env.DB_NAME || 'live') {
  assertMockName(database);
  if (database.toLowerCase() === source.toLowerCase())
    throw new Error('仅允许创建新的 live_mock_* 数据库，禁止写入当前业务库');
  return database;
}
function assertMockName(database) {
  identifier(database);
  if (!/^live_mock_[A-Za-z0-9_]+$/.test(database)) throw new Error('仅允许使用合法的 live_mock_* 数据库名');
  return database;
}
function generate(options = {}) {
  const ctx = createContext(options);
  ctx.aiHistory = options.aiHistory === true;
  const assetDir = 'mock/' + digest(ctx.seed).slice(0, 12);
  ctx.meta.attachment = { url: '/api/public/uploads/' + assetDir + '/placeholder.png',
    filePath: '/uploads/' + assetDir + '/placeholder.png', fileSize: PLACEHOLDER.length,
    fileHash: cryptoHash(PLACEHOLDER), relativePath: assetDir + '/placeholder.png' };
  require('./mock/identity')(ctx);
  require('./mock/finance')(ctx);
  require('./mock/lifestyle')(ctx);
  if (ctx.aiHistory) require('./mock/ai')(ctx);
  return { ctx, report: validate(ctx) };
}
function cryptoHash(buffer) { return require('crypto').createHash('sha256').update(buffer).digest('hex'); }
function migrationFiles() {
  return fs.readdirSync(path.join(API_ROOT, 'mysql/migrations')).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
}
function sqlValue(value) {
  return mysql.escape(value != null && typeof value === 'object' ? JSON.stringify(value) : value ?? null);
}
function insertStatements(table, records, schema) {
  if (!records.length) return [];
  const keys = schema.columns.map(column => column.name).filter(key => records.some(row => Object.hasOwn(row, key)));
  const sql = [];
  for (let offset = 0; offset < records.length; offset += 150) {
    const values = records.slice(offset, offset + 150).map(row => '(' + keys.map(key => sqlValue(row[key])).join(',') + ')');
    sql.push(`INSERT INTO ${identifier(table)} (${keys.map(identifier).join(',')}) VALUES\n${values.join(',\n')};`);
  }
  return sql;
}
function makeExport(ctx, database) {
  assertTarget(database);
  const parts = [
    '-- Entirely synthetic single-user database. CREATE DATABASE intentionally fails if the name exists.',
    `-- Dates: ${ctx.start} through ${ctx.end}; seed: ${JSON.stringify(ctx.seed).replace(/[\r\n]/g, '')}`,
    "SET NAMES utf8mb4;", "SET time_zone = '+08:00';", "SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';",
    `CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `USE ${identifier(database)};`, ...Object.values(ctx.schema).map(definition => definition.createSql), TRACK_SQL,
    'START TRANSACTION;',
  ];
  for (const [table, records] of Object.entries(ctx.rows)) parts.push(...insertStatements(table, records, ctx.schema[table]));
  parts.push('INSERT INTO `_migrations` (`filename`,`applied_at`) VALUES ' + migrationFiles().map(filename => '(' + sqlValue(filename) + ',' + sqlValue(ctx.datetime(ctx.end)) + ')').join(',') + ';');
  parts.push('COMMIT;');
  return parts.join('\n\n') + '\n';
}
function writeArtifacts(ctx, report, database, output) {
  const directory = path.resolve(output || path.join(OUTPUT_ROOT, database));
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('输出目录已有内容，需指定全新目录：' + directory);
  fs.mkdirSync(directory, { recursive: true });
  const sql = makeExport(ctx, database);
  fs.writeFileSync(path.join(directory, 'database.sql'), sql, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'dataset.json'), JSON.stringify({ start: ctx.start, end: ctx.end, seed: ctx.seed, userId: ctx.userId, aiHistory: ctx.aiHistory, rows: ctx.rows }), { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'placeholder.png'), PLACEHOLDER, { flag: 'wx' });
  const secrets = { FIELD_ENCRYPT_KEY: ctx.fieldKey, JWT_SECRET: digest(ctx.seed + ':mock-jwt'), SHARE_TOKEN_SECRET: digest(ctx.seed + ':mock-share') };
  const env = { DB_NAME: database, AI_DB_NAME: database, AI_MODE: 'disabled', AI_SYNTHETIC_DATA: 'false',
    AI_API_KEY: '', DEEPSEEK_API_KEY: '', AI_DB_HOST: process.env.DB_HOST || '127.0.0.1',
    AI_DB_USER: '', AI_DB_PASSWORD: '', AI_BASE_URL: 'https://mock-provider.example.invalid/v1',
    AI_ALLOW_SESSION_SETTINGS: 'false', INIT_ENABLE: 'false', INIT_SKIP: 'true', PORT: '7792',
    ...secrets };
  fs.writeFileSync(path.join(directory, '.env.mock'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx' });
  const manifest = { ...report, database, userId: ctx.userId, seed: ctx.seed, timezone: 'Asia/Shanghai',
    username: 'mock_life', loginPassword: ctx.password, pin: ctx.pin, synthetic: true, aiHistory: ctx.aiHistory,
    sqlSha256: digest(sql), datasetSha256: digest(JSON.stringify(ctx.rows)),
    migrations: migrationFiles(), state: 'exported', attachment: ctx.meta.attachment,
    scopes: { automaticAssetSnapshot: ctx.meta.lifecycle.automaticSnapshotScope, manualAssetRegister: ctx.meta.lifecycle.manualRegisterScope } };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const aiDescription = ctx.aiHistory ? '本次显式启用了 AI 合成历史，后台备份均未执行，锁释放、授权撤销。' : '默认保留 AI 表结构，不生成 AI 会话、消息、草稿、任务或供应商配置。现有 API/Key 配置需另行从原库迁移。';
  const readme = `# 三年单用户 Mock 数据库\n\n范围：${ctx.start}—${ctx.end}（上海时间，含首尾 ${report.coveredDays} 天）。\n\n数据库：\`${database}\`；42 张表 ${report.totalRows} 条合成记录，另有迁移记录表。\n\n账号：\`mock_life\`，密码：\`${ctx.password}\`，PIN：\`${ctx.pin}\`。\n\n- database.sql：全新库的建表和数据；目标库已存在时立即失败。\n- dataset.json：完整可校验数据；manifest.json：各表数量、日期、校验和与建库状态。\n- .env.mock：独立库和模拟加密配置，覆盖原 .env，AI 调用默认禁用。\n- placeholder.png：合成附件；创建数据库时安装到 API public/uploads。\n\n从 D:/Code/live/api 运行：\n\n\`\`\`powershell\nnode tools/mock-database.js verify --database ${database}\nnode tools/mock-database.js serve --output "${directory.replace(/\\/g, '/')}"\n\`\`\`\n\nserve 使用独立端口 7792、独立 AI 文件目录及 mock 库；不修改原 .env。现有前端仍需把 API 指向该端口才能登录该库。\n\n重复生成：\n\n\`\`\`powershell\nnode tools/mock-database.js generate --create --database live_mock_new --seed ${ctx.seed} --start ${ctx.start} --end ${ctx.end} --output "NEW_EMPTY_DIRECTORY"${ctx.aiHistory ? ' --ai-history' : ''}\n\`\`\`\n\n同日期、同 seed 可重复产生相同数据。默认截至运行当天，起始为三年前同日。\n\n现金余额、信用债、账单还款、外币、工资和基金均按当前业务代码计算。基金历史 net_value 是每日收益、market_val 是增持本金；自动资产快照使用现金类资产口径，手动登记包含基金和固定资产。工资采用按工作日等额税后日薪简化，并在月末发放。期初基金与固定资产记为已有资产。${aiDescription}\n`;
  fs.writeFileSync(path.join(directory, 'README.md'), readme, { flag: 'wx' });
  return { directory, manifest };
}
function connectionConfig() {
  require('dotenv').config({ path: path.join(API_ROOT, '.env') });
  return { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', connectTimeout: 10000,
    timezone: '+08:00', dateStrings: true, multipleStatements: false };
}
async function readDatabase(connection, ctx) {
  const rows = {};
  for (const table of Object.keys(ctx.schema)) [rows[table]] = await connection.query('SELECT * FROM ' + identifier(table));
  return { ...ctx, rows };
}
async function createDatabase(ctx, database, { resumeEmpty = false } = {}) {
  const config = connectionConfig();
  assertTarget(database);
  const connection = await mysql.createConnection(config);
  try {
    if (!resumeEmpty) await connection.query('CREATE DATABASE ' + identifier(database) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await connection.query('USE ' + identifier(database));
    const [[selected]] = await connection.query('SELECT DATABASE() AS name');
    if (selected.name !== database) throw new Error('数据库选择验证失败');
    if (resumeEmpty) {
      const [tables] = await connection.query('SHOW TABLES');
      for (const table of tables.map(row => Object.values(row)[0])) {
        if (table === '_migrations') continue;
        if (!ctx.schema[table]) throw new Error('拒绝恢复含未知表的数据库');
        const [[count]] = await connection.query('SELECT COUNT(*) AS n FROM ' + identifier(table));
        if (Number(count.n) !== 0) throw new Error('拒绝恢复含已有业务数据的数据库');
      }
    }
    await connection.query("SET time_zone = '+08:00'");
    await connection.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
    for (const definition of Object.values(ctx.schema)) await connection.query(definition.createSql);
    await require('../src/init/migrationRunner').runMigrations(connection);
    // Historical 005 narrows this JSON-bearing field to 50, while current DDL
    // reserves 1000 for installment card data. Restore current DDL in this NEW
    // mock database after applying migration history, before inserting rows.
    await connection.query("ALTER TABLE `bus_recurring` MODIFY `account_id` VARCHAR(1000) DEFAULT NULL COMMENT '关联卡片/分期信息JSON'");
    await connection.beginTransaction();
    try {
      for (const [table, records] of Object.entries(ctx.rows)) for (const statement of insertStatements(table, records, ctx.schema[table])) {
        try { await connection.query(statement); }
        catch (error) { error.mockTable = table; throw error; }
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    const actual = await readDatabase(connection, ctx);
    const report = validate(actual);
    const { CreditCore } = require('../src/modules/card/core/CreditCore');
    const core = CreditCore || require('../src/modules/card/core/CreditCore');
    const aggregate = await core.aggregate(ctx.userId, connection);
    const snapshot = actual.rows.asset_snapshot.find(row => row.record_date === ctx.end);
    if (Math.round(Number(aggregate.totalDebt) * 100) !== Math.round(Number(snapshot.credit_debt) * 100))
      throw new Error('真实 CreditCore 计算与 mock 信用债不一致');
    report.creditCore = aggregate;
    const installed = path.join(API_ROOT, 'public/uploads', ctx.meta.attachment.relativePath);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    if (fs.existsSync(installed)) {
      if (cryptoHash(fs.readFileSync(installed)) !== ctx.meta.attachment.fileHash) throw new Error('已有 mock 附件内容不同');
    } else fs.writeFileSync(installed, PLACEHOLDER, { flag: 'wx' });
    return report;
  } finally { await connection.end(); }
}
async function verifyDatabase(database, options = {}) {
  const manifestPath = path.join(path.resolve(options.output || path.join(OUTPUT_ROOT, database)), 'manifest.json');
  const stored = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  if (stored && stored.database !== database) throw new Error('校验清单与目标库不一致');
  if (!stored && !(options.start && options.end && options.seed)) throw new Error('缺少原生成清单，请提供 --output 或原始 --start --end --seed');
  const { ctx } = generate({ ...(stored ? { start: stored.start, end: stored.end, seed: stored.seed, aiHistory: stored.aiHistory === true } : {}), ...options });
  const config = connectionConfig(); assertMockName(database);
  const connection = await mysql.createConnection({ ...config, database });
  try { return validate(await readDatabase(connection, ctx)); }
  finally { await connection.end(); }
}
function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'generate';
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--create') options.create = true;
    else if (key === '--ai-history') options.aiHistory = true;
    else if (['--start', '--end', '--seed', '--database', '--output', '--password', '--pin'].includes(key) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[key.slice(2)] = argv[++index];
    else throw new Error('未知或缺少值的参数：' + key);
  }
  return { command, options };
}
async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'serve') {
    if (!options.output) throw new Error('serve 需要 --output 指向已有 mock 包');
    const directory = path.resolve(options.output);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest.state !== 'created-and-verified') throw new Error('只允许启动已经创建并通过校验的 mock 库');
    require('dotenv').config({ path: path.join(API_ROOT, '.env') });
    require('dotenv').config({ path: path.join(directory, '.env.mock'), override: true });
    assertTarget(process.env.DB_NAME, 'live'); process.chdir(API_ROOT);
    const memoryModule = require('../src/modules/ai/service/memoryStore');
    const createMemoryStore = memoryModule.createMemoryStore;
    memoryModule.createMemoryStore = (config = {}) => createMemoryStore({ ...config, root: path.join(directory, 'runtime-ai/memory') });
    require('../app'); return;
  }
  if (command === 'verify') {
    if (!options.database) throw new Error('verify 需要 --database');
    console.log(JSON.stringify(await verifyDatabase(options.database, options), null, 2)); return;
  }
  if (command !== 'generate') throw new Error('命令必须为 generate、verify 或 serve');
  const { ctx, report } = generate(options);
  const database = options.database || 'live_mock_' + ctx.end.replace(/-/g, ''); assertTarget(database);
  const result = writeArtifacts(ctx, report, database, options.output);
  if (options.create) {
    const actualReport = await createDatabase(ctx, database);
    result.manifest.state = 'created-and-verified'; result.manifest.databaseValidation = actualReport;
    fs.writeFileSync(path.join(result.directory, 'manifest.json'), JSON.stringify(result.manifest, null, 2));
  }
  console.log(JSON.stringify({ database, state: result.manifest.state, output: result.directory, coveredDays: report.coveredDays,
    tableCount: report.tableCount, totalRows: report.totalRows, validationChecks: report.checks }, null, 2));
}
if (require.main === module) main().catch(error => {
  // SQL errors can echo complete INSERT data; print only the driver code.
  console.error(error.code ? 'Mock 操作失败：' + error.code + (error.mockTable ? ' (' + error.mockTable + ')' : '') : error.message); process.exitCode = 1;
});
module.exports = { generate, makeExport, assertTarget, assertMockName, parseArgs, createDatabase, verifyDatabase, writeArtifacts };
