/**
 * 认证 Cookie 策略（安全整改 P0-5，2026-10-08）
 *
 * ## 背景
 * web 端原先把 JWT 存在 `localStorage` ⇒ 任意 XSS 都能 `localStorage.getItem('finance_token')`
 * 把令牌读走并外传。httpOnly Cookie 能让浏览器自动携带、而 JS **读不到**。
 *
 * ## 为什么不能让 web 独占 Bearer 通道
 * `APP`（原生 Kotlin，`ApiClient.kt:86`）与 `webview-APP` 目前**只发 Authorization 头**，
 * 不带 Cookie。若 `authGuard` 只认 Cookie，这两端会直接 401。
 * 所以服务端是「Cookie + Bearer 双通道」，Cookie 只给 web 用。
 *
 * ## 属性怎么选
 * | 属性 | 值 | 理由 |
 * |---|---|---|
 * | `httpOnly` | `true` | ★核心：JS 读不到 ⇒ XSS 窃取无效 |
 * | `sameSite` | `lax` | `strict` 会导致从外部链接跳转过来时不带 Cookie（分享链接场景会失效）；`lax` 已能挡住绝大多数 CSRF（跨站 POST 不带） |
 * | `secure` | 生产为 `true` | HTTP 下不传Cookie，保证令牌不被明文窃取；开发态（http://localhost）为 `false`，否则本地根本带不上|
 * | `path` | `/` | 全站可用（`/api/public` 的分享链接虽不需要，但统一更省事） |
 * | `maxAge` | 与JWT 有效期一致 | 令牌过期后 Cookie 自动消失，不需要服务端再判断 |
 *
 * ⚠ CSRF 说明：`sameSite=lax` 已阻断跨站 **POST/PUT/DELETE** 的 Cookie 携带，
 *而本项目的写操作都是 POST/PUT/PATCH/DELETE ⇒ 常规 CSRF 路径已被覆盖。
 * 若将来新增 GET 形式的写操作，需重新评估。
 */

/** Cookie 名（与前端约定；不要随意改，改了等于让所有人重新登录） */
const TOKEN_COOKIE_NAME = "finance_token";

/** JWT 默认有效期（秒），与 `.env` 的 `JWT_EXPIRES_IN=7d` 对齐 */
const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * 组装 Set-Cookie 所需的选项。
 * @param {number} [maxAgeSec] 有效期秒数；缺省用JWT 默认
 */
function buildCookieOptions(maxAgeSec = DEFAULT_TOKEN_TTL_SEC) {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    // 生产走 HTTPS 时才加 secure；开发态是 http://localhost，加了浏览器就不带 Cookie 了
    secure: isProd,
    path: "/",
    maxAge: maxAgeSec,
  };
}

/**
 * 设置认证 Cookie。
 * @param {import('express').Response} res
 * @param {string} token
 * @param {number} [maxAgeSec]
 */
function setAuthCookie(res, token, maxAgeSec = DEFAULT_TOKEN_TTL_SEC) {
  res.cookie(TOKEN_COOKIE_NAME, token, buildCookieOptions(maxAgeSec));
}

/**
 * 清除认证 Cookie。
 * ⚠ 属性必须与设置时**一致**（浏览器才认这是同一个 Cookie），否则清不掉。
 */
function clearAuthCookie(res) {
  // maxAge=0 ⇒ 立即过期
  res.clearCookie(TOKEN_COOKIE_NAME, buildCookieOptions(0));
}

/** 从 Cookie 字符串里取出令牌（不依赖 cookie-parser，供 authGuard 使用） */
function readTokenFromCookies(cookies) {
  return (cookies && cookies[TOKEN_COOKIE_NAME]) || null;
}

/**
 * 把 `JWT_EXPIRES_IN`（`"7d"` / `"12h"` / `"30m"` / `"3600"`）解析成秒。
 * 无法解析时返回 undefined，交给 cookie 库用默认 maxAge。
 * @returns {number|undefined}
 */
function resolveTokenTtlSec(raw) {
  const s = String(raw ?? process.env.JWT_EXPIRES_IN ?? "7d").trim();
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] || "s").toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return Math.floor(n * mult);
}

module.exports = {
  TOKEN_COOKIE_NAME,
  DEFAULT_TOKEN_TTL_SEC,
  buildCookieOptions,
  setAuthCookie,
  clearAuthCookie,
  readTokenFromCookies,
  resolveTokenTtlSec,
};