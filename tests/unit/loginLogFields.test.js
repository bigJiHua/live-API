/**
 * 阶段 3 单元测试：登录日志字段服务端采集（P1-15）
 *
 * 运行：cd api && npx jest tests/unit/loginLogFields.test.js
 *
 * 背景
 * ----
 * 旧代码是 `UserLog.append({ user_id, type, ...clientData })` —— 把客户端传来的
 * **整个 body** 展开进日志。虽然 INSERT 是参数化的（**无 SQL 注入**），但
 * `UserLog.append` 会优先读取这些键名：
 *   login_ip / login_location / login_isp / user_agent / os_info /
 *   browser_info / device_model / fingerprint / viewport / pixel_ratio / path / login_lang
 * 客户端只要在登录请求里塞进这些同名键，就能**伪造审计日志**。
 * 审计日志一旦可被当事人篡改，就失去取证价值。
 *
 * 本测试验证
 *   1. 正常场景：日志字段来自请求头 / 服务端路由
 *   2. 攻击场景：客户端 body 里的伪造字段**全部被忽略**
 *   3. 源码静态检查：`...clientData` 展开已从 login 中移除
 */

const path = require('path');
const fs = require('fs');

const { buildServerSideLogFields } = require('../../src/common/utils/logFields');

/** 构造一个最小可用的 req */
function makeReq(overrides = {}) {
  return {
    headers: {},
    security: {},
    path: '/api/v1/auth/login',
    body: { data: { nameOrEmail: 'jihua', password: 'x' } },
    ...overrides,
  };
}

describe('P1-15 正常采集', () => {
  it('IP 取 securityCheck 校验过的 req.security.ip', () => {
    const f = buildServerSideLogFields(makeReq({ security: { ip: '203.0.113.9' } }), 1);
    expect(f.login_ip).toBe('203.0.113.9');
  });

  it('无 req.security 时回退 req.ip', () => {
    const f = buildServerSideLogFields(makeReq({ ip: '198.51.100.7' }), 1);
    expect(f.login_ip).toBe('198.51.100.7');
  });

  it('path 取服务端路由，而非客户端字段', () => {
    const f = buildServerSideLogFields(makeReq({ path: '/api/v1/auth/login' }), 1);
    expect(f.path).toBe('/api/v1/auth/login');
  });

  it('设备信息取自请求头', () => {
    const req = makeReq({
      headers: {
        'user-agent': 'Mozilla/5.0 (Test)',
        'x-os-name': 'Android',
        'x-device-model': 'Pixel 8',
        viewportwidth: '390',
        viewportheight: '844',
        pixelratio: '3',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    const f = buildServerSideLogFields(req, 1);
    expect(f.user_agent).toBe('Mozilla/5.0 (Test)');
    expect(f.os_info).toContain('Android');
    expect(f.device_model).toBe('Pixel 8');
    expect(f.pixel_ratio).toBe('3');
    expect(f.viewport).toBe('390x844');
    expect(f.login_lang).toContain('zh-CN');
  });

  it('不可信来源（location/isp/browser）固定为占位', () => {
    const f = buildServerSideLogFields(makeReq(), 1);
    expect(f.login_location).toBe('未知');
    expect(f.login_isp).toBe('未知');
    expect(f.browser_info).toBe('');
  });

  it('user_id 正确透传', () => {
    expect(buildServerSideLogFields(makeReq(), 77).user_id).toBe(77);
  });
});

describe('P1-15 防日志伪造：除地点/运营商外，客户端 body 字段被忽略', () => {
  // 攻击者构造的 body：把所有可被伪造成审计证据的字段都塞满
  const forged = {
    nameOrEmail: 'jihua',
    password: 'x',
    login_ip: '1.2.3.4',
    login_location: 'Mars',
    login_isp: 'EvilISP',
    user_agent: 'FakeUA/1.0',
    os_info: 'FakeOS',
    browser_info: 'FakeBrowser',
    device_model: 'FakeDevice',
    fingerprint: 'VICTIM-FP-0000',
    viewport: '9999x9999',
    pixel_ratio: '99',
    path: '/admin',
    login_lang: 'xx-YY',
    token: 'FORGED-TOKEN-AAA',
    status: 1,
    type: 'login',
    user_id: 999,
  };

  it('body 里的伪造 IP / 路径 / 指纹都不进日志', () => {
    const req = makeReq({
      headers: { 'user-agent': 'RealUA/2.0', 'x-device-model': 'RealPhone' },
      security: { ip: '203.0.113.9', fingerprint: 'fp-real' },
      body: { data: forged },
    });
    const f = buildServerSideLogFields(req, 1);

    // 服务端可信来源胜出
    expect(f.login_ip).toBe('203.0.113.9');
    expect(f.path).toBe('/api/v1/auth/login');
    expect(f.fingerprint).toBe('fp-real');
    expect(f.user_agent).toBe('RealUA/2.0');
    expect(f.device_model).toBe('RealPhone');
    expect(f.login_location).toBe('未知');

    // 伪造值一律不出现
    expect(f.login_ip).not.toBe('1.2.3.4');
    expect(f.path).not.toBe('/admin');
    expect(f.fingerprint).not.toBe('VICTIM-FP-0000');
  });

  it('即使请求头缺失，也不回退到 body 里的伪造值', () => {
    const req = makeReq({
      headers: {},          // 无 user-agent
      security: {},         // 无 ip
      ip: '127.0.0.1',
      body: { data: forged },
    });
    const f = buildServerSideLogFields(req, 1);
    expect(f.user_agent).toBe('');        // 不是 forged 里的 'FakeUA/1.0'
    expect(f.device_model).toBe('');
    expect(f.fingerprint).toBe('');
  });

  it('user_id 用服务端传入值，而非客户端指定的 999', () => {
    const req = makeReq({ body: { data: forged } });
    const f = buildServerSideLogFields(req, 42);
    expect(f.user_id).toBe(42);
    expect(f.user_id).not.toBe(999);
  });

  it('顶层 loginLocation/loginIsp 采信并落日志（2026-10-20 例外）', () => {
    const req = makeReq({
      body: { loginLocation: 'China-Zhejiang-Hangzhou', loginIsp: 'CMCC' },
    });
    const f = buildServerSideLogFields(req, 1);
    expect(f.login_location).toBe('China-Zhejiang-Hangzhou');
    expect(f.login_isp).toBe('CMCC');
  });

  it('snake_case 上报同样兼容，空占位落未知', () => {
    const f = buildServerSideLogFields(makeReq({
      body: { login_location: 'China-Guangdong-Shenzhen', login_isp: '--' },
    }), 1);
    expect(f.login_location).toBe('China-Guangdong-Shenzhen');
    expect(f.login_isp).toBe('未知');
  });
});

describe('P1-15 健壮性', () => {
  it('req 缺 headers 时不崩', () => {
    expect(() => buildServerSideLogFields({ ip: '1.1.1.1' }, 1)).not.toThrow();
  });

  it('req 完全为空时给出安全默认值', () => {
    const f = buildServerSideLogFields({}, 1);
    expect(f.login_ip).toBe('0.0.0.0');
    expect(f.path).toBe('/');
    expect(f.user_id).toBe(1);
  });

  it('req 为 undefined 时不崩', () => {
    expect(() => buildServerSideLogFields(undefined, 1)).not.toThrow();
  });

  it('login_lang 超长会被截断（防日志字段超长）', () => {
    const req = makeReq({ headers: { 'accept-language': 'a'.repeat(500) } });
    const f = buildServerSideLogFields(req, 1);
    expect(f.login_lang.length).toBeLessThanOrEqual(16);
  });
});

describe('源码静态检查（防回退）', () => {
  const CTRL = path.resolve(__dirname, '../../src/modules/auth/controller/index.js');
  const src = fs.readFileSync(CTRL, 'utf8');
  // 去掉注释后再匹配，避免「修复说明写在注释里」造成假失败
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('login 中不再出现 `...clientData` 展开', () => {
    const loginStart = code.indexOf('async login(');
    const loginEnd = code.indexOf('async ', loginStart + 10);
    const loginBody = code.slice(loginStart, loginEnd > 0 ? loginEnd : undefined);
    expect(loginBody).not.toMatch(/\.\.\.clientData/);
  });

  it('controller 引用了公共实现 buildServerSideLogFields', () => {
    expect(src).toContain('buildServerSideLogFields');
    expect(src).toMatch(/require\(["'][^"']*logFields["']\)/);
  });

  it('user model 的改用户名日志也已改走公共采集（P1-15 补漏）', () => {
    const USER = path.resolve(__dirname, '../../src/modules/auth/model/user.js');
    const userSrc = fs.readFileSync(USER, 'utf8');
    expect(userSrc).toContain('buildServerSideLogFields');
    // 剥注释后再查：注释里描述旧代码时写了 `token: req.headers.authorization`，
    // 不剥会误判成「还在用」
    const userCode = userSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(userCode).not.toMatch(/token:\s*req\.headers\.authorization/);
  });
});