/**
 * 极简 Cookie 解析中间件（安全整改 P0-5，2026-10-08）
 *
 * ## 为什么需要
 * web 端把 JWT 存在 `localStorage` ⇒ 任意 XSS 都能读走令牌。
 * 改用 **httpOnly Cookie** 后，浏览器自动随请求携带、且 JS 读不到。
 *
 * ## 为什么不引 cookie-parser
 * 我们只需要读少量 Cookie，一个 20 行的解析器足够；
 * 而 `cookie-parser` 会成为新的依赖（该项目已因双 lockfile 出现过供应链问题）。
 * 需要更多能力时再换官方库。
 *
 * ## 兼容说明
 * 本中间件**只读不写**，也不设置签名/加密（JWT 本身已签名）。
 * `SameSite` / `HttpOnly` / `Secure` 等属性由**设置 Cookie 的地方**（authController）指定。
 */

/** 把 `a=1; b=2` 解析成 `{ a: '1', b: '2' }`；值里的 %XX 会被解码。 */
function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== "string") return out;

  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    let value = part.slice(idx + 1).trim();
    // 去掉可能存在的引号
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // 解码失败就保留原值（非法编码不应导致 500）
      out[name] = value;
    }
  }
  return out;
}

/** 挂载后 `req.cookies` 可用（已存在则不覆盖，避免重复挂载导致解析丢失）。 */
function cookieParser(req, res, next) {
  if (!req.cookies) {
    req.cookies = parseCookieHeader(req.headers && req.headers.cookie);
  }
  next();
}

module.exports = { cookieParser, parseCookieHeader };