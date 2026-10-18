/**
 * pinSecurityGuard 取 token 双通道回归护栏（2026-10-12 冲突修复①）
 *
 * ## 背景（为什么必须有这个测试）
 * P0-5（2026-10-08）把 web 端从「localStorage JWT + Bearer 头」改造为
 * 「httpOnly Cookie」，请求拦截器不再注入 Authorization。
 * 但 pinSecurityGuard 当时只解析 Bearer 头 ⇒ web 登录用户（Cookie 通道）
 * 在 PIN 风控眼里恒为「未登录」直接放行 —— PIN 二次验证 / 频率风控 /
 * 敏感操作风控对 web 全面失效。这是双通道口径分叉导致的安全回归。
 *
 * ## 修复方式
 * pinSecurityGuard 复用 authGuard 导出的 extractToken（Bearer 优先 → Cookie 回落），
 * 双通道口径单一来源。本测试钉死三条通道的行为，防止再次分叉。
 *
 * ## 断言设计（语义而非实现）
 * - 「进入 PIN 检查」的判据：守卫对已识别 userId 会执行 getUserPin 查库
 *   （db.execute 被调用）；「未登录放行」则完全不触达数据库。
 *   Bearer-only 旧实现下，用例 2 的 db.execute 不会被调用 ⇒ 本测试抓得住回归。
 */

process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-0123456789abcdef0123456789abcdef";

jest.mock("../../src/common/config/db", () => ({
  execute: jest.fn(),
}));
// 隔离路由验证查表与 RSA 解密（与本测试无关，避免加载与分支干扰）
jest.mock("../../src/common/middleware/pinLockGuard", () => ({
  matchProtected: jest.fn(() => null),
}));
jest.mock("../../src/common/utils/rsaKeys", () => ({
  resolvePassword: jest.fn(() => null),
}));

const jwt = require("jsonwebtoken");
const db = require("../../src/common/config/db");
const { pinSecurityGuard } = require("../../src/common/middleware/pinSecurityGuard");
const { extractToken } = require("../../src/common/middleware/authGuard");

/** 构造 req/res 替身；next 用标记记录是否放行 */
function makeReqRes({ bearer, cookie, url = "/api/v1/card/list", method = "GET" } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const req = {
    headers,
    cookies: cookie || {},
    originalUrl: url,
    method,
    body: {},
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return { req, res };
}

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET);
}

describe("authGuard.extractToken 双通道口径", () => {
  afterEach(() => jest.clearAllMocks());

  test("Bearer 优先：同时有 Bearer 与 Cookie 时取 Bearer", () => {
    const token = sign({ userId: "u-bearer" });
    const cookieToken = sign({ userId: "u-cookie" });
    const { req } = makeReqRes({ bearer: token, cookie: { finance_token: cookieToken } });
    expect(extractToken(req)).toBe(token);
  });

  test("无 Bearer 时回落 httpOnly Cookie（web 通道）", () => {
    const token = sign({ userId: "u-cookie" });
    const { req } = makeReqRes({ cookie: { finance_token: token } });
    expect(extractToken(req)).toBe(token);
  });

  test("两通道都无 → null（未登录）", () => {
    const { req } = makeReqRes({});
    expect(extractToken(req)).toBeNull();
  });
});

describe("pinSecurityGuard 取 userId 双通道（风控不再对 web 失效）", () => {
  afterEach(() => jest.clearAllMocks());

  test("无任何凭证 → 不触达数据库直接放行（保持原行为）", async () => {
    const { req, res } = makeReqRes({});
    await pinSecurityGuard(req, res, () => {
      req.__nexted = true;
    });
    expect(req.__nexted).toBe(true);
    expect(db.execute).not.toHaveBeenCalled();
  });

  test("仅 Cookie 通道（web 登录用户）→ userId 被识别并进入 PIN 检查", async () => {
    const token = sign({ userId: "u-web" });
    const { req, res } = makeReqRes({ cookie: { finance_token: token } });
    // getUserPin 返回空行 ⇒ 未设置 PIN ⇒ 放行；但「查库」本身证明 userId 已被识别
    db.execute.mockResolvedValue([[]]);
    await pinSecurityGuard(req, res, () => {
      req.__nexted = true;
    });
    expect(db.execute).toHaveBeenCalled();
    expect(req.__nexted).toBe(true);
  });

  test("Bearer 通道（APP/webview-APP 登录用户）→ 行为不变", async () => {
    const token = sign({ userId: "u-app" });
    const { req, res } = makeReqRes({ bearer: token });
    db.execute.mockResolvedValue([[]]);
    await pinSecurityGuard(req, res, () => {
      req.__nexted = true;
    });
    expect(db.execute).toHaveBeenCalled();
    expect(req.__nexted).toBe(true);
  });

  test("无效 token（Cookie 中是垃圾值）→ 按未登录放行、不查库", async () => {
    const { req, res } = makeReqRes({ cookie: { finance_token: "not-a-jwt" } });
    await pinSecurityGuard(req, res, () => {
      req.__nexted = true;
    });
    expect(req.__nexted).toBe(true);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
