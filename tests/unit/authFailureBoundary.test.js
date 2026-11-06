/**
 * 鉴权错误分类回归：有效 JWT + 数据库故障不得返回 401。
 * 所有数据库、邮件及模型依赖均为替身，不启动 app.js。
 */
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn() }));
jest.mock('../../src/modules/auth/model/user', () => ({}));
jest.mock('../../src/modules/auth/model/log', () => ({}));
jest.mock('../../src/common/utils/mailer', () => ({ sendVerificationEmail: jest.fn() }));
jest.mock('../../src/common/utils/fieldCrypto', () => ({}));
jest.mock('../../src/common/middleware/pinSecurityGuard', () => ({ clearVerifiedSession: jest.fn() }));
jest.mock('../../src/common/middleware/accountLockCheck', () => ({}));

const jwt = require('jsonwebtoken');
const db = require('../../src/common/config/db');
const authGuard = require('../../src/common/middleware/authGuard');
const controller = require('../../src/modules/auth/controller');

const TEST_SECRET = 'isolated-auth-regression-secret';
const oldSecret = process.env.JWT_SECRET;
const oldTtl = process.env.JWT_EXPIRES_IN;
const oldMaxSession = process.env.TOKEN_MAX_SESSION_DAYS;
const user = { id: 7, username: 'test', identity: 'user', status: 1 };

beforeEach(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.JWT_EXPIRES_IN = '7d';
  process.env.TOKEN_MAX_SESSION_DAYS = '90';
  db.execute.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  for (const [key, value] of [
    ['JWT_SECRET', oldSecret], ['JWT_EXPIRES_IN', oldTtl],
    ['TOKEN_MAX_SESSION_DAYS', oldMaxSession],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sign(payload = {}, secret = TEST_SECRET) {
  return jwt.sign({ userId: 7, ...payload }, secret, { expiresIn: '1h' });
}

function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json: jest.fn(),
    cookie: jest.fn(),
  };
}

async function callBoundary(kind, token = sign()) {
  const res = makeRes();
  const next = jest.fn();
  if (kind === 'guard') {
    await authGuard({
      method: 'GET', originalUrl: '/api/v1/ai/settings', headers: {},
      cookies: token ? { finance_token: token } : {},
    }, res, next);
  } else {
    await controller.refreshToken({ body: { data: { token } } }, res);
  }
  return { res, next, body: res.json.mock.calls[0]?.[0] };
}

function dbError(code, sqlMessage = 'synthetic-db-detail') {
  return Object.assign(new Error(sqlMessage), { code, sqlMessage });
}

describe.each(['guard', 'refresh'])('%s 的数据库/认证错误边界', (kind) => {
  it.each(['ETIMEDOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST'])(
    '有效令牌遇到 %s：503、不重复查库、不放行、不设置 Cookie',
    async (code) => {
      db.execute.mockRejectedValue(dbError(code));
      const { res, next, body } = await callBoundary(kind);
      expect(res.statusCode).toBe(503);
      expect(body.status).toBe(503);
      expect(JSON.stringify(body)).not.toContain('synthetic-db-detail');
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    }
  );

  it('仅 password_changed_at 缺列时允许兼容查询', async () => {
    db.execute.mockRejectedValueOnce(dbError(
      'ER_BAD_FIELD_ERROR', "Unknown column 'password_changed_at' in 'field list'"
    )).mockResolvedValueOnce([[user]]);
    const { res, next, body } = await callBoundary(kind);
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    if (kind === 'guard') expect(next).toHaveBeenCalledTimes(1);
    else expect(jwt.verify(body.token, TEST_SECRET).userId).toBe(7);
  });

  it('其他缺列不能因查询 SQL 含 password_changed_at 而放宽检查', async () => {
    const error = dbError('ER_BAD_FIELD_ERROR', "Unknown column 'is_deleted' in 'where clause'");
    error.sql = 'SELECT id, password_changed_at FROM user_info WHERE is_deleted = 0';
    db.execute.mockRejectedValue(error);
    const { res, next, body } = await callBoundary(kind);
    expect(res.statusCode).toBe(503);
    expect(body.status).toBe(503);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('缺列兼容查询再次失败：503，不误报令牌失效', async () => {
    db.execute.mockRejectedValueOnce(dbError(
      'ER_BAD_FIELD_ERROR', "Unknown column 'password_changed_at' in 'field list'"
    )).mockRejectedValueOnce(dbError('ETIMEDOUT'));
    const { res, body } = await callBoundary(kind);
    expect(res.statusCode).toBe(503);
    expect(body.status).toBe(503);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('有效令牌与正常数据库保持原成功行为', async () => {
    db.execute.mockResolvedValueOnce([[user]]);
    const { res, next, body } = await callBoundary(kind);
    expect(db.execute).toHaveBeenCalledWith(expect.any(String), [7]);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    if (kind === 'guard') {
      expect(next).toHaveBeenCalledTimes(1);
      expect(body).toBeUndefined();
    } else {
      expect(jwt.verify(body.token, TEST_SECRET).userId).toBe(7);
      expect(res.cookie).toHaveBeenCalledTimes(1);
      expect(res.cookie.mock.calls[0][2].maxAge).toBe(604800000);
    }
  });

  it('伪造签名仍为 401，且不访问数据库', async () => {
    const { res, next, body } = await callBoundary(kind, sign({}, 'wrong-test-secret'));
    expect(body.message).toBe('无效的认证令牌');
    if (kind === 'guard') expect(body.status).toBe(401);
    else expect(res.statusCode).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('超出刷新宽限期的过期令牌仍为 401，不访问数据库', async () => {
    const token = sign({ iat: Math.floor(Date.now() / 1000) - 8 * 86400 });
    const { res, body } = await callBoundary(kind, token);
    if (kind === 'guard') expect(body.status).toBe(401);
    else expect(res.statusCode).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('密码变更撤销仍返回 401，不能通过暂时不可用逻辑放行', async () => {
    db.execute.mockResolvedValueOnce([[{ ...user, password_changed_at: Date.now() + 1000 }]]);
    const { res, next, body } = await callBoundary(kind);
    expect(body.message).toBe('密码已变更，请重新登录');
    if (kind === 'guard') expect(body.status).toBe(401);
    else expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('用户已删除仍保持原拒绝行为', async () => {
    db.execute.mockResolvedValueOnce([[]]);
    const { res, next, body } = await callBoundary(kind);
    expect(body.message).toBe('用户不存在');
    if (kind === 'guard') expect(body.status).toBe(401);
    else expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});

it('settings GET 未携带 Cookie 仍返回业务 401，保留临时探针', async () => {
  const { body, next } = await callBoundary('guard', null);
  expect(body).toEqual({ status: 401, message: '未提供认证令牌' });
  expect(db.execute).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalled();
});

it('刷新签发发生运行时异常：500，不误报 401 或泄漏错误详情', async () => {
  const token = sign();
  db.execute.mockResolvedValueOnce([[user]]);
  jest.spyOn(jwt, 'sign').mockImplementationOnce(() => {
    throw new Error('synthetic-signing-detail');
  });
  const { res, body } = await callBoundary('refresh', token);
  expect(res.statusCode).toBe(500);
  expect(body.status).toBe(500);
  expect(JSON.stringify(body)).not.toContain('synthetic-signing-detail');
  expect(res.cookie).not.toHaveBeenCalled();
});
