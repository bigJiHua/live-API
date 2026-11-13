const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { inspectEnvironment, templateIssues } = require('../../tools/env-check');

const basic = () => ({ NODE_ENV: 'development', PORT: '7788', DB_HOST: '127.0.0.1', DB_PORT: '3306',
  DB_USER: 'app_writer', DB_PASSWORD: '', DB_NAME: 'live', JWT_SECRET: 'a'.repeat(64), FRONTEND_URL: 'http://localhost:5173', AI_MODE: 'disabled' });
const ai = () => ({ ...basic(), AI_MODE: 'deepseek', AI_DB_HOST: '127.0.0.1', AI_DB_PORT: '3306',
  AI_DB_NAME: 'live', AI_DB_USER: 'ai_reader', AI_DB_PASSWORD: 'fixture-password' });

describe('handover environment checks', () => {
  test('base service starts without optional AI and SMTP credentials', () => {
    expect(inspectEnvironment(basic()).errors).toEqual([]);
    expect(templateIssues()).toEqual([]);
  });
  test('reports missing connection configuration and invalid ports without values', () => {
    const env = { ...basic(), DB_HOST: '', PORT: 'your_Port', DB_PORT: '70000' };
    const errors = inspectEnvironment(env).errors.join('\n');
    expect(errors).toMatch(/DB_HOST/);
    expect(errors).toMatch(/PORT/);
    expect(errors).toMatch(/DB_PORT/);
    expect(errors).not.toContain('your_Port');
  });
  test('direct app entry exits on invalid configuration before database initialization', () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../app.js')], {
      cwd: os.tmpdir(), env: { ...process.env, ...basic(), PORT: '70000' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/配置检查失败/);
    expect(result.stderr).toMatch(/PORT/);
    expect(result.stdout).not.toMatch(/服务已启动|初始化程序启动/);
  });
  test('production refuses placeholder secrets while development warns', () => {
    const env = { ...basic(), JWT_SECRET: 'your-super-secret-jwt-key-change-this-in-production' };
    expect(inspectEnvironment(env).warnings.join('\n')).toMatch(/JWT_SECRET/);
    expect(inspectEnvironment({ ...env, NODE_ENV: 'production' }).errors.join('\n')).toMatch(/JWT_SECRET/);
  });
  test('initial administrator password is only required when initialization is enabled', () => {
    expect(inspectEnvironment({ ...basic(), INIT_ENABLE: 'false' }).errors).toEqual([]);
    const errors = inspectEnvironment({ ...basic(), INIT_ENABLE: 'true', INIT_SKIP: 'true',
      INIT_ADMIN_USER: 'admin', INIT_ADMIN_EMAIL: 'admin@example.com', INIT_ADMIN_PASS: 'your_secure_password' }).errors.join('\n');
    expect(errors).toMatch(/INIT_SKIP/);
    expect(errors).toMatch(/INIT_ADMIN_PASS/);
  });
  test('requires independent AI reader and matching database without env provider credentials', () => {
    expect(inspectEnvironment(ai()).errors).toEqual([]);
    expect(inspectEnvironment({ ...ai(), AI_DB_USER: 'root' }).errors.join('\n')).toMatch(/AI_DB_USER/);
    expect(inspectEnvironment({ ...ai(), AI_DB_USER: 'app_writer' }).errors.join('\n')).toMatch(/AI_DB_USER/);
    expect(inspectEnvironment({ ...ai(), AI_DB_NAME: 'another_ledger' }).errors.join('\n')).toMatch(/AI_DB_NAME/);
    expect(inspectEnvironment({ ...basic(), AI_MODE: 'deepseek' }).errors.join('\n')).toMatch(/AI_DB_PASSWORD/);
  });
  test('legacy provider values do not enable or alter user connection validation', () => {
    const env = { ...ai(), AI_BASE_URL: 'invalid-legacy-address', AI_API_KEY: 'never-print-this-value', AI_MODEL: 'old-model' };
    const result = inspectEnvironment(env);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/AI_API_KEY/);
    expect(JSON.stringify(result)).not.toContain('never-print-this-value');
  });
  test('rejects partial search slots, invalid engine and unsafe origin', () => {
    expect(inspectEnvironment({ ...basic(), AI_SEARCH_API_KEY: 'private-value' }).errors.join('\n')).toMatch(/同时配置/);
    const result = inspectEnvironment({ ...basic(), AI_SEARCH_BASE_URL: 'http://private.example',
      AI_SEARCH_API_KEY: 'private-value', AI_SEARCH_PROVIDER: 'zhipu', AI_SEARCH_ENGINE: 'unsupported' });
    expect(result.errors.join('\n')).toMatch(/搜索/);
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
  test('rejects service mock mode and out of range timeouts', () => {
    expect(inspectEnvironment({ ...basic(), AI_MODE: 'mock' }).errors.join('\n')).toMatch(/单元测试/);
    expect(inspectEnvironment({ ...basic(), AI_PROVIDER_TIMEOUT_MS: '200000' }).errors.join('\n')).toMatch(/AI_PROVIDER_TIMEOUT_MS/);
    expect(inspectEnvironment({ ...basic(), AI_V3_TURN_TIMEOUT_MS: '1' }).errors.join('\n')).toMatch(/AI_V3_TURN_TIMEOUT_MS/);
  });
  test('accepts comma separated CORS origins but refuses URL credentials and paths', () => {
    expect(inspectEnvironment({ ...basic(), CORS_EXTRA_ORIGINS: 'https://one.example, https://two.example' }).errors).toEqual([]);
    expect(inspectEnvironment({ ...basic(), FRONTEND_URL: 'https://user:never-print@example.com' }).errors.join('\n')).toMatch(/FRONTEND_URL/);
    expect(inspectEnvironment({ ...basic(), CORS_EXTRA_ORIGINS: 'https://example.com/path' }).errors.join('\n')).toMatch(/CORS_EXTRA_ORIGINS/);
  });
  test('warns about skipped migrations and rejects misspelled boolean values', () => {
    expect(inspectEnvironment({ ...basic(), INIT_SKIP: 'true' }).warnings.join('\n')).toMatch(/跳过增量迁移/);
    expect(inspectEnvironment({ ...basic(), INIT_ENABLE: 'treu' }).errors.join('\n')).toMatch(/INIT_ENABLE/);
  });
  test('new environment reads fail template coverage until documented', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-env-coverage-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'app.js'), 'const value = process.env.NEW_REQUIRED_SLOT;');
      fs.writeFileSync(path.join(root, '.env.example'), 'NODE_ENV=development\n');
      expect(templateIssues(root).join('\n')).toMatch(/NEW_REQUIRED_SLOT/);
      fs.appendFileSync(path.join(root, '.env.example'), '# NEW_REQUIRED_SLOT=optional\n');
      expect(templateIssues(root)).toEqual([]);
    } finally {
      expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
      expect(path.basename(root).startsWith('live-env-coverage-')).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
