/**
 * 阶段 3 单元测试：登录失败锁定（P0-2）
 *
 * 运行：cd api && npx jest tests/unit/loginLock.test.js
 *
 * 不连数据库：User model 被 jest.mock 掉，只测「计数/锁定/归一化」行为。
 */

jest.mock('../../src/modules/auth/model/user', () => ({
  findByEmail: jest.fn(),
  findByUsername: jest.fn(),
  setLockStatus: jest.fn(),
}));

const lockCheck = require('../../src/common/middleware/accountLockCheck');
const { RATE_LIMIT } = lockCheck;

beforeEach(() => {
  lockCheck.__reset();
  jest.clearAllMocks();
});

describe('阈值常量', () => {
  it('5 次失败 / 15 分钟窗口 / 锁 15 分钟', () => {
    expect(RATE_LIMIT.maxFailures).toBe(5);
    expect(RATE_LIMIT.windowMs).toBe(15 * 60 * 1000);
    expect(RATE_LIMIT.lockoutMs).toBe(15 * 60 * 1000);
  });
});

describe('key 归一化（防大小写/空格绕过）', () => {
  it('trim + 小写', () => {
    expect(lockCheck.normalizeKey('  Admin  ')).toBe('admin');
    expect(lockCheck.normalizeKey('ADMIN')).toBe(lockCheck.normalizeKey('admin'));
  });

  it('邮箱同样归一化', () => {
    expect(lockCheck.normalizeKey(' Foo@Bar.COM ')).toBe('foo@bar.com');
  });

  it('空值安全', () => {
    expect(lockCheck.normalizeKey(null)).toBe('');
    expect(lockCheck.normalizeKey(undefined)).toBe('');
  });

  it('大小写变体共享同一额度（否则可绕过锁定）', () => {
    for (let i = 0; i < 4; i++) lockCheck.recordLoginFailure('admin');
    expect(lockCheck.recordLoginFailure('ADMIN').locked).toBe(true);
  });
});

describe('失败驱动（不是请求驱动）', () => {
  it('登录成功清零', () => {
    lockCheck.recordLoginFailure('u1');
    lockCheck.recordLoginFailure('u1');
    expect(lockCheck.currentFailureCount('u1')).toBe(2);
    lockCheck.clearLoginFailures('u1');
    expect(lockCheck.currentFailureCount('u1')).toBe(0);
  });

  it('未达阈值不锁定，返回剩余次数', () => {
    const r = lockCheck.recordLoginFailure('u2');
    expect(r.locked).toBe(false);
    expect(r.remainAttempts).toBe(4);
  });

  it('第 5 次失败触发锁定', () => {
    let last;
    for (let i = 0; i < 5; i++) last = lockCheck.recordLoginFailure('u3');
    expect(last.locked).toBe(true);
    expect(last.remainingMs).toBe(RATE_LIMIT.lockoutMs);
    expect(last.remainAttempts).toBe(0);
  });

  it('锁定期内 lockRemainingMs > 0', () => {
    for (let i = 0; i < 5; i++) lockCheck.recordLoginFailure('u4');
    expect(lockCheck.lockRemainingMs('u4')).toBeGreaterThan(0);
  });

  it('锁定期间继续失败不叠加延长', () => {
    for (let i = 0; i < 5; i++) lockCheck.recordLoginFailure('u5');
    const first = lockCheck.lockRemainingMs('u5');
    lockCheck.recordLoginFailure('u5');
    expect(lockCheck.lockRemainingMs('u5')).toBeLessThanOrEqual(first);
  });

  it('正常路径（查得到用户）不计数 —— 这是失败驱动的核心', () => {
    // 走一次中间件正常路径，计数应保持 0
    const User = require('../../src/modules/auth/model/user');
    User.findByEmail.mockResolvedValue(null);
    User.findByUsername.mockResolvedValue({ id: 7, username: 'ok', status: 1 });
    const res = { status: () => ({ json: () => {} }), say: () => {}, json: () => {} };
    return lockCheck
      .accountLockCheck({ body: { data: { nameOrEmail: 'ok' } } }, res, () => {})
      .then(() => {
        expect(lockCheck.currentFailureCount('ok')).toBe(0);
      });
  });
});

describe('不同账号互不影响', () => {
  it('锁 u1 不影响 u2', () => {
    for (let i = 0; i < 5; i++) lockCheck.recordLoginFailure('u1');
    expect(lockCheck.lockRemainingMs('u1')).toBeGreaterThan(0);
    expect(lockCheck.lockRemainingMs('u2')).toBe(0);
  });
});

describe('窗口过期后额度恢复', () => {
  it('窗口超时 ⇒ 计数归零', () => {
    lockCheck.recordLoginFailure('u6');
    lockCheck.recordLoginFailure('u6');
    expect(lockCheck.currentFailureCount('u6')).toBe(2);
    const realNow = Date.now;
    Date.now = () => realNow() + RATE_LIMIT.windowMs + 1000;
    try {
      expect(lockCheck.currentFailureCount('u6')).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('锁定到期 ⇒ 重新给满额度', () => {
    for (let i = 0; i < 5; i++) lockCheck.recordLoginFailure('u7');
    const realNow = Date.now;
    Date.now = () => realNow() + RATE_LIMIT.lockoutMs + 1000;
    try {
      expect(lockCheck.lockRemainingMs('u7')).toBe(0);
      for (let i = 0; i < 4; i++) {
        expect(lockCheck.recordLoginFailure('u7').locked).toBe(false);
      }
    } finally {
      Date.now = realNow;
    }
  });
});

describe('防枚举（P1-14）', () => {
  const User = require('../../src/modules/auth/model/user');

  function mockRes() {
    return {
      statusCode: null,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.body = p; return this; },
      say(m, c) { this.statusCode = c; this.body = { status: c, message: m }; return this; },
    };
  }

  it('用户不存在 ⇒ 统一文案/状态码 + 计入失败次数', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.findByUsername.mockResolvedValue(null);
    const res = mockRes();
    await lockCheck.accountLockCheck(
      { body: { data: { nameOrEmail: 'ghost' } } }, res, () => {}
    );
    expect(res.statusCode).toBe(lockCheck.GENERIC_AUTH_STATUS);
    expect(res.body.message).toBe(lockCheck.GENERIC_AUTH_ERROR);
    // 关键：账号不存在也要计数，否则撞库探测不受限
    expect(lockCheck.currentFailureCount('ghost')).toBe(1);
  });

  it('统一文案不含"账号不存在"类字样', () => {
    expect(lockCheck.GENERIC_AUTH_ERROR).not.toMatch(/不存在|未注册|无此/);
    expect(lockCheck.GENERIC_AUTH_ERROR).toBe('账号或密码错误');
  });

  it('锁定期内直接 423，不再查库', async () => {
    for (let i = 0; i < 5; i++) lockCheck.recordLoginFailure('locked-user');
    const res = mockRes();
    await lockCheck.accountLockCheck(
      { body: { data: { nameOrEmail: 'locked-user' } } }, res, () => {}
    );
    expect(res.statusCode).toBe(423);
    expect(res.body.locked).toBe(true);
    expect(User.findByEmail).not.toHaveBeenCalled();
  });

  it('查到用户 ⇒ 挂 req.checkedUser 并放行，且不计数', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.findByUsername.mockResolvedValue({ id: 7, username: 'jihua', status: 1 });
    const req = { body: { data: { nameOrEmail: 'jihua' } } };
    const res = mockRes();
    const next = jest.fn();
    await lockCheck.accountLockCheck(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.checkedUser).toMatchObject({ id: 7, username: 'jihua' });
    expect(req.loginKey).toBe('jihua');
    expect(lockCheck.currentFailureCount('jihua')).toBe(0);
  });

  it('管理员锁定（status=0）12 小时未到 ⇒ 423', async () => {
    User.findByEmail.mockResolvedValue({
      id: 9, username: 'boss', status: 0, update_time: Date.now(),
    });
    const res = mockRes();
    await lockCheck.accountLockCheck(
      { body: { data: { nameOrEmail: 'boss' } } }, res, () => {}
    );
    expect(res.statusCode).toBe(423);
    expect(res.body.locked).toBe(true);
  });

  it('管理员锁定超 12 小时 ⇒ 自动解锁并放行', async () => {
    User.findByEmail.mockResolvedValue({
      id: 9, username: 'boss', status: 0,
      update_time: Date.now() - 13 * 60 * 60 * 1000,
    });
    User.setLockStatus.mockResolvedValue({ status: 200 });
    const next = jest.fn();
    await lockCheck.accountLockCheck(
      { body: { data: { nameOrEmail: 'boss' } } }, mockRes(), next
    );
    expect(User.setLockStatus).toHaveBeenCalledWith(9, false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('缺 nameOrEmail ⇒ 401', async () => {
    const res = mockRes();
    await lockCheck.accountLockCheck({ body: { data: {} } }, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('查库抛错 ⇒ next() 放行，不阻断登录', async () => {
    User.findByEmail.mockRejectedValue(new Error('db down'));
    const next = jest.fn();
    await lockCheck.accountLockCheck(
      { body: { data: { nameOrEmail: 'x' } } }, mockRes(), next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('内存不无限增长', () => {
  it('sweep 只清理已过期条目，未过期的必须保留', () => {
    for (let i = 0; i < 1200; i++) lockCheck.recordLoginFailure(`fresh${i}`);
    expect(lockCheck.__size()).toBeGreaterThan(1000);
    lockCheck.__sweep();
    // 关键：刚创建的条目未过期，绝不能被清掉
    expect(lockCheck.currentFailureCount('fresh1')).toBe(1);
    expect(lockCheck.__size()).toBeGreaterThan(1000);
  });

  it('sweep 会回收已过期条目', () => {
    for (let i = 0; i < 1200; i++) lockCheck.recordLoginFailure(`stale${i}`);
    const realNow = Date.now;
    Date.now = () => realNow() + RATE_LIMIT.windowMs + 1000;
    try {
      lockCheck.__sweep();
      expect(lockCheck.__size()).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  it('超过硬上限时整体重置（不让内存无限增长）', () => {
    for (let i = 0; i < 5100; i++) lockCheck.recordLoginFailure(`flood${i}`);
    expect(lockCheck.__size()).toBeGreaterThan(5000);
    lockCheck.__sweep();
    expect(lockCheck.__size()).toBe(0);
  });
});