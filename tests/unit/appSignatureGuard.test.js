/**
 * 阶段 10 单元测试：APP 签名自检守卫（P1-28）
 *
 * 运行：cd api && npx jest tests/unit/appSignatureGuard.test.js
 *
 * 行为矩阵：
 *   白名单未配置（默认）      ⇒ 全放行（开源用户零影响）
 *   白名单配置 + loose（默认）⇒ 带头必须匹配；不带头放行（浏览器/curl）
 *   白名单配置 + strict       ⇒ 不带头也拒（纯 APP 部署用）
 */

const guard = require('../../src/common/middleware/appSignatureGuard');

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    say(m, c) { this.statusCode = c; this.body = { status: c, message: m }; return this; },
  };
}

function run(headers, env = {}) {
  Object.assign(process.env, env);
  const req = {
    headers,
    security: { ip: '203.0.113.9' },
    ip: '203.0.113.9',
    originalUrl: '/api/v1/auth/me',
  };
  const res = mockRes();
  const next = jest.fn();
  guard(req, res, next);
  return { res, next };
}

afterEach(() => {
  delete process.env.APP_SIGN_SHA256;
  delete process.env.APP_SIGN_ENFORCE;
});

describe('白名单未配置（默认）⇒ 守卫不启用', () => {
  it('无头放行', () => {
    const { res, next } = run({});
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('带头也放行（没白名单就没得比）', () => {
    const { next } = run({ 'x-app-sign-sha256': FP_A });
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('白名单配置 + loose（默认）', () => {
  const env = { APP_SIGN_SHA256: FP_A };

  it('匹配白名单 ⇒ 放行', () => {
    const { res, next } = run({ 'x-app-sign-sha256': FP_A.toUpperCase() }, env);
    expect(next).toHaveBeenCalledTimes(1);   // 大小写不敏感
    expect(res.statusCode).toBeNull();
  });

  it('不匹配（重打包假 APP）⇒ 403', () => {
    const { res, next } = run({ 'x-app-sign-sha256': FP_B }, env);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('不带头 ⇒ 放行（浏览器 / curl / 旧版 APP）', () => {
    const { res, next } = run({}, env);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('多个指纹（逗号分隔）都能匹配（换签共存场景）', () => {
    const { next } = run(
      { 'x-app-sign-sha256': FP_B },
      { APP_SIGN_SHA256: `${FP_A},${FP_B}` }
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('白名单里的非 64hex 垃圾项被忽略', () => {
    const { next } = run(
      { 'x-app-sign-sha256': FP_A },
      { APP_SIGN_SHA256: `not-a-fp,${FP_A}` }
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(guard.getWhitelist()).toEqual([FP_A]);
  });
});

describe('白名单配置 + strict', () => {
  const env = { APP_SIGN_SHA256: FP_A, APP_SIGN_ENFORCE: 'strict' };

  it('不带头 ⇒ 403（浏览器也会被拒 —— strict 的显式代价）', () => {
    const { res, next } = run({}, env);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('带头且匹配 ⇒ 放行', () => {
    const { next } = run({ 'x-app-sign-sha256': FP_A }, env);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('接线静态检查', () => {
  const fs = require('fs');
  const path = require('path');

  it('app.js 已挂载守卫且在解密之后', () => {
    const app = fs
      .readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(app).toContain('app.use(appSignatureGuard)');
    expect(app.indexOf('app.use(appSignatureGuard)'))
      .toBeGreaterThan(app.indexOf('decryptWithSecurity(req, res, next)'));
  });

  it('CORS allowedHeaders 含 x-app-sign-sha256', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
    expect(app).toContain('"x-app-sign-sha256"');
  });

  it('APP 端 DeviceProfile 每请求上报该头', () => {
    const dp = fs.readFileSync(
      path.resolve(__dirname, '../../../APP/app/src/main/java/com/live/finance/core/net/DeviceProfile.kt'),
      'utf8'
    );
    expect(dp).toContain('x-app-sign-sha256');
    expect(dp).toContain('AppConfig.appSignSha256');
  });
});
