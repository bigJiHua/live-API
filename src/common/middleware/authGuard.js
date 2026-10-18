const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { readTokenFromCookies } = require("../utils/authCookie");

/**
 * 取出请求携带的 JWT（安全整改 P0-5，2026-10-08）
 *
 * ## 为什么要双通道
 * - **Cookie**：web 端。token 存在 httpOnly Cookie 里，JS 读不到 ⇒ XSS 无法窃取。
 * - **Bearer 头**：`APP`（原生 Kotlin）与 `webview-APP` 目前**只发 Authorization 头**，
 *   不会自动带 Cookie。若只认 Cookie，这两端会直接登不上（401）。
 *   因此保留 Bearer 作为兼容通道。
 *
 * 优先级：Bearer 优先（显式 ⇒ 便于排查是哪一端的问题），其次 Cookie。
 * 将来若三端都改用 Cookie，可把Bearer 分支标记为@deprecated。
 */
function extractToken(req) {
  const authHeader = req.headers && req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  // httpOnly Cookie（web 端）
  return readTokenFromCookies(req.cookies);
}

/**
 * JWT 认证守卫
 * 验证请求头中的 Bearer Token，或 Cookie 中的 httpOnly token
 */
const authGuard = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.json({ status: 401, message: "未提供认证令牌" });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = decoded.userId;

      // 验证用户是否存在 + 密码变更吊销检查
      let user;
      try {
        const [users] = await db.execute(
          "SELECT id, password_changed_at FROM user_info WHERE id = ? AND is_deleted = 0",
          [req.userId]
        );
        user = users[0];
      } catch {
        // password_changed_at 字段可能尚未迁移，回退到基础查询
        const [users] = await db.execute(
          "SELECT id FROM user_info WHERE id = ? AND is_deleted = 0",
          [req.userId]
        );
        user = users[0];
      }

      if (!user) {
        return res.json({ status: 401, message: "用户不存在" });
      }

      // 密码变更吊销：token.iat 早于密码变更时间 → 令牌已失效
      // 字段不存在时 password_changed_at 为 undefined，安全跳过
      const pwdChangedAt = user?.password_changed_at;
      if (pwdChangedAt && decoded.iat) {
        const iatMs = decoded.iat * 1000; // iat 是秒，转为毫秒
        if (iatMs < pwdChangedAt) {
          return res.json({ status: 401, message: "密码已变更，请重新登录" });
        }
      }

      next();
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.json({ status: 401, message: "令牌已过期" });
      }
      return res.json({ status: 401, message: "无效的认证令牌" });
    }
  } catch (error) {
    console.error("Auth Guard Error:", error);
    return res.json({ status: 500, message: "认证检查失败" });
  }
};

module.exports = authGuard;
// 🔄 2026-10-12：导出双通道取 token 的口径函数，供 pinSecurityGuard 等中间件复用，
// 避免「Bearer 优先 → Cookie 回落」在多处各写一份后再分叉
module.exports.extractToken = extractToken;