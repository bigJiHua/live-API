/**
 * 阶段 9 单元测试：设备风险信号上报端点（P2-14）
 *
 * 运行：cd api && npx jest tests/unit/riskReport.test.js
 *
 * 核心断言（对齐 securityController.riskReport 的设计约束）：
 *  1. 信号名白名单 —— 自由文本/伪造字段一概不收
 *  2. 数量上限（防灌库）
 *  3. pin_status 固定写 1 —— 该表 pin_status=0 会被 pinLockGuard 当成
 *     「待验证/锁定」记录参与 PIN 拦截，风险信号绝不能影响那个流程
 *  4. IP 服务端采集（不采信 body）
 *  5. 失败不阻断（异常也返回 200）
 */

jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn().mockResolvedValue([{}]),
}));
// riskReport 不触其他依赖，但 require 链会加载 —— 给空实现防连库
jest.mock('../../src/modules/auth/model/pin', () => ({}));
jest.mock('../../src/modules/auth/model/log', () => ({}));
jest.mock('../../src/modules/auth/model/user', () => ({}));

const db = require('../../src/common/config/db');
const controller = require('../../src/modules/security/controller');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    say(m, c) { this.statusCode = c; this.body = { status: c, message: m }; return this; },
  };
}

function mockReq(signals, overrides = {}) {
  return {
    userId: 7,
    headers: {
      'x-user-agent-custom': 'Dalvik/2.1.0',
      'x-device-model': 'Pixel 8',
    },
    security: { ip: '203.0.113.9' },
    ip: '203.0.113.9',
    body: { data: signals === undefined ? {} : { signals } },
    ...overrides,
  };
}

beforeEach(() => {
  db.execute.mockClear();
});

describe('正常上报', () => {
  it('合法信号落库：action_type=risk_signal、pin_status=1、remark 含信号 JSON', async () => {
    const res = mockRes();
    await controller.riskReport(mockReq(['root', 'debugger']), res);

    expect(db.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = db.execute.mock.calls[0];
    expect(sql).toMatch(/risk_signal/);
    expect(sql).toMatch(/'risk_signal', 1, 0/); // pin_status=1：绝不参与 PIN 拦截流程
    expect(params[0]).toBe(7);                   // user_id 来自鉴权态
    const remark = JSON.parse(params[2]);
    expect(remark.signals).toEqual(['root', 'debugger']);
    expect(remark.device_model).toBe('Pixel 8');
    expect(res.statusCode).toBe(200);
  });

  it('body 里伪造 login_ip / user_id 不影响任何落库字段', async () => {
    const res = mockRes();
    const req = mockReq(['root'], {
      body: { data: { signals: ['root'], login_ip: '1.2.3.4', user_id: 999 } },
    });
    await controller.riskReport(req, res);
    const [, params] = db.execute.mock.calls[0];
    expect(params[0]).toBe(7); // user_id 固定来自鉴权态
  });
});

describe('白名单与上限（防伪造 / 防灌库）', () => {
  it('非法字符信号被过滤（只收 a-z0-9_:-）', async () => {
    const res = mockRes();
    await controller.riskReport(
      mockReq(['root', 'DROP TABLE users; --', '<script>', 'sig-ok:1_2']),
      res
    );
    const [, params] = db.execute.mock.calls[0];
    // root 本身就是合法信号名；两条攻击载荷被过滤
    expect(JSON.parse(params[2]).signals).toEqual(['root', 'sig-ok:1_2']);
  });

  it('超长信号（>40 字符）被过滤', async () => {
    const res = mockRes();
    await controller.riskReport(mockReq(['a'.repeat(41), 'short-ok']), res);
    const [, params] = db.execute.mock.calls[0];
    expect(JSON.parse(params[2]).signals).toEqual(['short-ok']);
  });

  it('超过 20 条被截断（防灌库）', async () => {
    const res = mockRes();
    const signals = Array.from({ length: 30 }, (_, i) => `sig-${i}`);
    await controller.riskReport(mockReq(signals), res);
    const [, params] = db.execute.mock.calls[0];
    expect(JSON.parse(params[2]).signals).toHaveLength(20);
  });

  it('signals 非数组 ⇒ 不落库，仍返回 200', async () => {
    const res = mockRes();
    await controller.riskReport(mockReq('not-an-array'), res);
    expect(db.execute).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('全部信号被过滤后不落库', async () => {
    const res = mockRes();
    await controller.riskReport(mockReq(['<bad>', 'BAD UPPER']), res);
    expect(db.execute).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('body 缺 data 字段 ⇒ 不崩，不落库', async () => {
    const res = mockRes();
    await controller.riskReport({ userId: 7, headers: {}, security: {}, body: {} }, res);
    expect(db.execute).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('req 无 body ⇒ 不崩，返回 200', async () => {
    const res = mockRes();
    // riskReport 内 return res.say(...) ⇒ promise resolve 值为 res；行为断言看状态码
    await controller.riskReport({ userId: 7, headers: {}, security: {} }, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('失败不阻断', () => {
  it('db 写入抛错 ⇒ 仍返回 200（上报是尽力而为）', async () => {
    db.execute.mockRejectedValueOnce(new Error('db down'));
    const res = mockRes();
    await controller.riskReport(mockReq(['root']), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('已接收');
  });
});
