// Read-only configuration checks. Never print configuration values or run migrations.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { isWeakSecret } = require('../src/common/utils/secretGuard');
const { getConfig } = require('../src/modules/ai/service/config');
const ROOT = path.resolve(__dirname, '..');
const LEGACY = ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL'];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.js') ? [file] : [];
  });
}

function templateIssues(root = ROOT) {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const documented = new Set([...template.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(match => match[1]));
  const used = new Set();
  for (const file of [path.join(root, 'app.js'), ...sourceFiles(path.join(root, 'src'))]) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g)) used.add(match[1]);
  }
  return [...used].filter(key => !documented.has(key)).sort().map(key => `${key} 尚未写入 .env.example（可选项也须注释说明）`);
}

function inspectEnvironment(env, { example = false } = {}) {
  const errors = [], warnings = [];
  const present = key => typeof env[key] === 'string' && env[key].trim() !== '';
  const integer = (key, min, max, optional = false) => {
    if (optional && !present(key)) return;
    const value = Number(env[key]);
    if (!present(key) || !Number.isInteger(value) || value < min || value > max) errors.push(`${key} 必须为 ${min}～${max} 的整数`);
  };
  const origin = key => {
    let url;
    try { url = new URL(env[key]); } catch (_) {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      errors.push(`${key} 必须为 http(s) 来源地址，仅含协议、主机和可选端口`);
    }
  };
  for (const key of ['NODE_ENV', 'PORT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME', 'FRONTEND_URL', 'JWT_SECRET']) {
    if (!present(key)) errors.push(`${key} 未配置；请从 .env.example 复制后填写`);
  }
  if (!['development', 'production', 'test'].includes(env.NODE_ENV)) errors.push('NODE_ENV 仅支持 development / production / test');
  integer('PORT', 1, 65535);
  integer('DB_PORT', 1, 65535);
  origin('FRONTEND_URL');
  for (const entry of String(env.CORS_EXTRA_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    let url;
    try { url = new URL(entry); } catch (_) {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      errors.push('CORS_EXTRA_ORIGINS 必须为逗号分隔的 http(s) 来源地址');
      break;
    }
  }
  for (const key of ['JWT_SECRET', 'SHARE_TOKEN_SECRET']) {
    const value = env[key] || (key === 'SHARE_TOKEN_SECRET' ? env.JWT_SECRET : undefined);
    if (isWeakSecret(value)) {
      (env.NODE_ENV === 'production' && !example ? errors : warnings).push(`${key} 缺失或使用占位密钥；请生成至少 32 位随机串`);
    }
  }
  if (!Object.hasOwn(env, 'DB_PASSWORD') || !env.DB_PASSWORD) warnings.push('DB_PASSWORD 为空；请确认数据库允许该账号使用空密码');
  for (const key of ['INIT_SKIP', 'INIT_ENABLE', 'INIT_STRICT', 'AI_BUSINESS_ENABLED', 'AI_FINANCIAL_ENABLED', 'AI_ALLOW_SESSION_SETTINGS', 'AI_SYNTHETIC_DATA', 'REQUIRE_CLIENT_NONCE', 'INSTALLMENT_SCAN_ENABLED', 'INSTALLMENT_SCAN_DRY_RUN', 'AI_WEB_SEARCH_ENABLED']) {
    if (present(key) && !['true', 'false'].includes(env[key])) errors.push(`${key} 仅支持 true / false`);
  }
  if (env.INIT_ENABLE === 'true') {
    if (env.INIT_SKIP === 'true') errors.push('INIT_ENABLE=true 时必须设 INIT_SKIP=false');
    if (!present('INIT_ADMIN_USER') || !present('INIT_ADMIN_EMAIL')) errors.push('首次初始化请填写 INIT_ADMIN_USER / INIT_ADMIN_EMAIL');
    if (!present('INIT_ADMIN_PASS') || /your_secure_password|^admin123$/i.test(env.INIT_ADMIN_PASS)) errors.push('首次初始化必须填写自己的 INIT_ADMIN_PASS，不能使用模板占位密码');
  }
  if (env.INIT_SKIP === 'true') warnings.push('INIT_SKIP=true 会跳过增量迁移；更新代码后请设为 false 再启动');
  if (env.INIT_STRICT === 'false') warnings.push('INIT_STRICT=false 会放行迁移失败，不能用于正常接手启动');
  for (const key of ['PIN_RISK_MODE', 'PIN_NONCE_MODE']) {
    if (present(key) && !['enforce', 'observe', 'off'].includes(env[key])) errors.push(`${key} 仅支持 enforce / observe / off`);
  }
  for (const key of ['BCRYPT_SALT_ROUNDS', 'TOKEN_MAX_SESSION_DAYS', 'AI_LOG_RETENTION_DAYS', 'INSTALLMENT_GRACE_DAYS', 'INSTALLMENT_SCAN_INTERVAL_MS', 'INSTALLMENT_SCAN_FIRST_DELAY']) {
    integer(key, 1, key === 'BCRYPT_SALT_ROUNDS' ? 31 : 2147483647, true);
  }
  for (const key of LEGACY) if (present(key)) warnings.push(`${key} 为历史槽位，用户聊天不会读取；请在界面配置 AI 接入商`);
  if ((env.AI_MODE || 'disabled') === 'deepseek') {
    for (const key of ['AI_DB_HOST', 'AI_DB_NAME', 'AI_DB_USER', 'AI_DB_PASSWORD']) if (!present(key)) errors.push(`启用 AI 时必须填写 ${key}（独立只读数据库账号）`);
    integer('AI_DB_PORT', 1, 65535, true);
    if (String(env.AI_DB_USER || '').toLowerCase() === 'root' || (env.AI_DB_USER && env.AI_DB_USER === env.DB_USER)) errors.push('AI_DB_USER 必须为独立只读账号，不能使用 root 或 DB_USER');
    if (env.AI_DB_NAME !== env.DB_NAME) errors.push('AI_DB_NAME 必须与 DB_NAME 指向同一账本数据库');
  }
  const searchSlots = ['AI_SEARCH_BASE_URL', 'AI_SEARCH_API_KEY', 'AI_SEARCH_PROVIDER'];
  const configuredSearchSlots = searchSlots.filter(present);
  if (configuredSearchSlots.length && configuredSearchSlots.length !== searchSlots.length) errors.push('AI_SEARCH_BASE_URL / AI_SEARCH_API_KEY / AI_SEARCH_PROVIDER 必须同时配置或全部留空');
  // Validate format/ranges using the application's parser, with an isolated test credential.
  // Real provider credentials are stored per user in SQL; this check never calls a provider.
  const configEnv = { ...env, AI_BASE_URL: 'https://api.deepseek.com', AI_API_KEY: 'configuration-check-only',
    DEEPSEEK_API_KEY: undefined, AI_MODEL: 'deepseek-flash', DEEPSEEK_MODEL: undefined };
  try { getConfig(configEnv); } catch (error) { errors.push(error.message); }
  integer('AI_V3_TURN_TIMEOUT_MS', 30000, 300000, true);
  return { errors, warnings };
}

async function probeDatabases(env) {
  const mysql = require('mysql2/promise');
  const errors = [];
  for (const prefix of env.AI_MODE === 'deepseek' ? ['DB', 'AI_DB'] : ['DB']) {
    let connection;
    try {
      connection = await mysql.createConnection({ host: env[`${prefix}_HOST`], port: Number(env[`${prefix}_PORT`] || 3306),
        user: env[`${prefix}_USER`], password: env[`${prefix}_PASSWORD`], database: env[`${prefix}_NAME`], connectTimeout: 5000 });
      await connection.query({ sql: 'SELECT 1', timeout: 5000 });
      console.log(`[env] ${prefix} 连接与 SELECT 1 通过（未执行迁移或写入）`);
    } catch (error) {
      const code = /^[A-Z0-9_]+$/.test(String(error.code)) ? error.code : 'CONNECTION_FAILED';
      errors.push(`${prefix} 数据库连接失败（${code}），检查该组连接配置、数据库是否存在及服务状态`);
    } finally { if (connection) await connection.end(); }
  }
  return errors;
}

async function main(args = process.argv.slice(2)) {
  const example = args.includes('--example');
  if (args.some(arg => !['--example', '--db'].includes(arg)) || (example && args.includes('--db'))) {
    console.error('[env] 用法：npm run env:check [-- --db] 或 npm run env:check:example');
    return 1;
  }
  const file = path.join(ROOT, example ? '.env.example' : '.env');
  const parsed = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
  const env = example ? parsed : { ...parsed, ...process.env };
  const { errors, warnings } = inspectEnvironment(env, { example });
  errors.push(...templateIssues());
  for (const warning of warnings) console.warn(`[env] 提示：${warning}`);
  if (!errors.length && args.includes('--db')) errors.push(...await probeDatabases(env));
  for (const error of errors) console.error(`[env] 错误：${error}`);
  if (errors.length) { console.error('[env] 请按 ENV_SETUP.md 修正；检查不会输出任何配置值。'); return 1; }
  console.log(`[env] ${example ? '.env.example 模板' : 'API 配置'}检查通过${args.includes('--db') ? '' : '（未检查数据库连通性）'}`);
  return 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  console.error('[env] 配置文件读取或检查失败，请检查 .env / .env.example 和 ENV_SETUP.md'); process.exitCode = 1;
});
module.exports = { inspectEnvironment, templateIssues, probeDatabases, main };
