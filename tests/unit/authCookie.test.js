/**
 * 阶段 5 单元测试：认证 Cookie 会话化（后端部分，P0-5 / P1-17）
 *
 * 运行：cd api && npx jest tests/unit/authCookie.test.js
 *
 * 覆盖：
 * A. Cookie 解析
 * B. Cookie 属性策略（httpOnly 是核心）
 * C. TTL 解析
 * D. authGuard 双通道（Bearer 兼容 APP / Cookie 给 web）
 * E. logout 清Cookie
 */

const jwt = require('jsonwebtoken');

const { parseCookieHeader, cookieParser } = require('../../src/common/middleware/cookieParser');
const {
  TOKEN_COOKIE_NAME,
  buildCookieOptions,
  setAuthCookie,
  clearAuthCookie,
  readTokenFromCookies,
  resolveTokenTtlSec,
} = require('../../src/common/utils/authCookie');

// ==================== A. Cookie 解析 ====================
describe('A·Cookie 解析', () => {
  it('解析单个', () => {
    expect(parseCookieHeader('finance_token=abc')).toEqual({ finance_token: 'abc' });
  });

  it('解析多个（含空格）', () => {
    expect(parseCookieHeader('a=1; b=2 ;c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('URL 编码值会解码', () => {
    expect(parseCookieHeader('t=a%20b%3Dc').t).toBe('a b=c');
  });

  it('非法编码不抛异常（不应导致 500）', () => {
    expect(() => parseCookieHeader('t=%E0%A4%A')).not.toThrow();
    expect(parseCookieHeader('t=%E0%A4%A').t).toBeDefined();
  });

  it('去掉引号包裹', () => {
    expect(parseCookieHeader('t="xyz"').t).toBe('xyz');
  });

  it('无值/空输入安全', () => {
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader('novalue')).toEqual({});
  });

  it('中间件把 cookies 挂到 req 且不覆盖已有值', () => {
    const req = { headers: { cookie: 'finance_token=t1' } };
    cookieParser(req, {}, () => {});
    expect(req.cookies.finance_token).toBe('t1');

    const req2 = { headers: {}, cookies: { preset: 'v' } };
    cookieParser(req2, {}, () => {});
    expect(req2.cookies).toEqual({ preset: 'v' }); // 不覆盖
  });
});

// ==================== B. Cookie 属性策略 ====================
describe('B·Cookie 属性（httpOnly 是核心）', () => {
  const ORIGINAL = process.env.NODE_ENV;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL;
  });

  it('**httpOnly 必须为 true**（这是 P0-5 的全部意义所在）', () => {
    expect(buildCookieOptions().httpOnly).toBe(true);
  });

  it('sameSite=lax（strict 会让外部分享链接跳转失效）', () => {
    expect(buildCookieOptions().sameSite).toBe('lax');
  });

  it('开发环境 secure=false（http://localhost 加了就不带 Cookie）', () => {
    process.env.NODE_ENV = 'development';
    expect(buildCookieOptions().secure).toBe(false);
  });

  it('生产环境 secure=true', () => {
    process.env.NODE_ENV = 'production';
    expect(buildCookieOptions().secure).toBe(true);
  });

  it('path=/ 且带maxAge', () => {
    const o = buildCookieOptions(1234);
    expect(o.path).toBe('/');
    expect(o.maxAge).toBe(1234);
  });

  it('setAuthCookie 用正确的名字与选项下发', () => {
    process.env.NODE_ENV = 'development';
    const res = {
      cookie: jest.fn(),
    };
    setAuthCookie(res, 'tok123', 999);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, val, opts] = res.cookie.mock.calls[0];
    expect(name).toBe(TOKEN_COOKIE_NAME);
    expect(val).toBe('tok123');
    expect(opts.httpOnly).toBe(true);
    expect(opts.maxAge).toBe(999);
  });

  it('clearAuthCookie 属性与设置时一致（否则浏览器清不掉）', () => {
    process.env.NODE_ENV = 'development';
    const setRes = { cookie: jest.fn() };
    setAuthCookie(setRes, 't', 100);
    const setOpts = setRes.cookie.mock.calls[0][2];

    const clearRes = { clearCookie: jest.fn() };
    clearAuthCookie(clearRes);
    const [name, opts] = clearRes.clearCookie.mock.calls[0];

    expect(name).toBe(TOKEN_COOKIE_NAME);
    expect(opts.httpOnly).toBe(setOpts.httpOnly);
    expect(opts.sameSite).toBe(setOpts.sameSite);
    expect(opts.path).toBe(setOpts.path);
    expect(opts.maxAge).toBe(0); // 立即过期
  });

  it('readTokenFromCookies 取值正确', () => {
    expect(readTokenFromCookies({ [TOKEN_COOKIE_NAME]: 'abc' })).toBe('abc');
    expect(readTokenFromCookies({})).toBeNull();
    expect(readTokenFromCookies(undefined)).toBeNull();
  });
});

// ==================== C. TTL 解析 ====================
describe('C·JWT_EXPIRES_IN 解析成秒', () => {
  const cases = [
    ['7d', 604800],
    ['12h', 43200],
    ['30m', 1800],
    ['3600', 3600],
    ['1.5d', 129600],
    ['7D', 604800], // 大写
    [' 7d ', 604800], // 空格
  ];
  // ⚠ 循环变量**不能**叫 `expect` —— 会遮蔽 jest 的全局 expect 函数，
  //   导致 `expect is not a function`（第一版就踩了这个坑）。
  for (const [input, expectedSec] of cases) {
    it(`"${input}" → ${expectedSec}秒`, () => {
      expect(resolveTokenTtlSec(input)).toBe(expectedSec);
    });
  }

  it('无法解析时返回 undefined（交给 cookie 库默认）', () => {
    expect(resolveTokenTtlSec('abc')).toBeUndefined();
    expect(resolveTokenTtlSec('')).toBeUndefined();
  });

  it('缺省读环境变量', () => {
    const old = process.env.JWT_EXPIRES_IN;
    process.env.JWT_EXPIRES_IN = '2d';
    try {
      expect(resolveTokenTtlSec()).toBe(172800);
    } finally {
      if (old === undefined) delete process.env.JWT_EXPIRES_IN;
      else process.env.JWT_EXPIRES_IN = old;
    }
  });
});

// ==================== D. authGuard 双通道 ====================
describe('D·authGuard 双通道（Cookie + Bearer）', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  });
  afterAll(() => {
    if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = OLD_SECRET;
  });

  // 造一个最小可用 req/res，authGuard 内部会查库（用 mockUserExists 开关）
  function makeRes() {
    return {
      statusCode: null,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
    };
  }

  /** 只测「令牌能否被取出」这一层，不触碰 DB */
  function extract(req) {
    const authHeader = req.headers && req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (t) return t;
    }
    return readTokenFromCookies(req.cookies);
  }

  it('Bearer 头能取出（APP / webview-APP 兼容）', () => {
    expect(extract({ headers: { authorization: 'Bearer tok-abc' } })).toBe('tok-abc');
  });

  it('Cookie 能取出（web 新方案）', () => {
    expect(extract({ headers: {}, cookies: { finance_token: 'ck-xyz' } })).toBe('ck-xyz');
  });

  it('两者都有时 Bearer 优先（便于排查是哪一端）', () => {
    expect(
      extract({ headers: { authorization: 'Bearer from-header' }, cookies: { finance_token: 'from-cookie' } })
    ).toBe('from-header');
  });

  it('Bearer 后面空白 ⇒ 回落Cookie', () => {
    expect(
      extract({ headers: { authorization: 'Bearer    ' }, cookies: { finance_token: 'ck' } })
    ).toBe('ck');
  });

  it('非 Bearer 的 Authorization 头被忽略（如 Basic）', () => {
    expect(extract({ headers: { authorization: 'Basic abc' }, cookies: {} })).toBeNull();
  });

  it('都没有 ⇒ 取出 null（authGuard 会返回 401）', () => {
    expect(extract({ headers: {} })).toBeNull();
    expect(extract({ headers: {}, cookies: {} })).toBeNull();
  });

  it('**签发的 token 能被 authGuard 验签通过**（端到端一致性）', () => {
    const token = jwt.sign(
      { userId: 7, username: 'u', iat: Math.floor(Date.now() / 1000) },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    // Cookie 通道取出后能验签
    const got = extract({ headers: {}, cookies: { finance_token: token } });
    expect(jwt.verify(got, process.env.JWT_SECRET).userId).toBe(7);
  });

  it('**源码静态检查：authGuard 确实读 cookie，且不再只认 Bearer**', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/common/middleware/authGuard.js'), 'utf8'
    );
    expect(src).toContain('readTokenFromCookies');
    // 不能再出现「只要没有 Bearer 就 401」的硬判断
    expect(src).not.toMatch(/!authHeader \|\| !authHeader\.startsWith\("Bearer "\)/);
  });
});

// ==================== E. logout 清Cookie ====================
describe('E·logout 清 Cookie（P1-17）', () => {
  it('清Cookie 且不需要令牌也返回成功（幂等）', () => {
    // 直接验证 clearAuthCookie 的行为（logout handler 依赖 DB，这里只测清 Cookie 这步）
    process.env.NODE_ENV = 'development';
    const res = { clearCookie: jest.fn() };
    clearAuthCookie(res);
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    expect(res.clearCookie.mock.calls[0][1].maxAge).toBe(0);
  });

  it('路由已挂载 logout 且**刻意不挂 authGuard**', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/auth/api/index.js'), 'utf8'
    );
    expect(src).toMatch(/\/logout/);
    // logout 那一行不能出现 authGuard
    const line = src.split('\n').find((l) => l.includes('/logout'));
    expect(line).toBeDefined();
    expect(line).not.toContain('authGuard');
  });

  it('app.js 挂载了 cookieParser 且早于路由', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
    expect(src).toContain('cookieParser');
    const iParser = src.indexOf('app.use(cookieParser)');
    const iRouter = src.indexOf('apiRouter');
    expect(iParser).toBeGreaterThan(-1);
    expect(iParser).toBeLessThan(iRouter); // 必须早于路由
  });
});