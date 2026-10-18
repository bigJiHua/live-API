/**
 * APP 签名自检守卫（安全整改 P1-28，2026-10-08）
 *
 * ## 威胁模型（D-3 收敛后的口径）
 * 目标是「重打包的假 APP」：第三方反编译官方 APK、改代码、**换自己的密钥重签**
 * （APK 必须签名才能安装，指纹必变）。本守卫让这类假 APP 的请求被 API 拒绝。
 *
 * **防不住**（与 APP-接入站点安全设计.md §8 结论一致）：
 *  - 官方签名密钥本身泄露；
 *  - root 设备上 hook 运行时内存绕过上报。
 * 它是抬高门槛，不是绝对防护。
 *
 * ## 协议
 * APP 端（`App.kt` 启动时）用 PackageManager 读取自身签名证书 → SHA-256 →
 * 每个请求带 `x-app-sign-sha256` 头。API 与部署者在 `.env` 配置的白名单比对。
 *
 * ## 两种模式（由 `APP_SIGN_SHA256` 是否配置决定，另可用 `APP_SIGN_ENFORCE`）
 * | 配置 | 行为 |
 * |---|---|
 * | 未配置（**默认**，开源用户拿到包直接跑） | 守卫**完全不启用** —— 零影响 |
 * | 配置了 + loose（默认） | 带 `x-app-sign-sha256` 头的请求必须匹配；不带头的（浏览器 / curl）放行 |
 * | 配置了 + strict | 所有请求（含握手）必须带头且匹配 —— 浏览器也会被拒，仅「纯 APP、无 web」的部署用 |
 *
 * loose 模式下不带头的绕过是**接受的残余**：假 APP 的重打包产物大概率仍带这个头
 * （上报代码还在，只是签名变了）⇒ 主威胁（重打包）仍被拦截。
 */

/** 读白名单：逗号分隔多个指纹（部署者换签名时可平滑共存新旧两版 APP） */
function getWhitelist() {
  return String(process.env.APP_SIGN_SHA256 || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

const isStrict = () =>
  String(process.env.APP_SIGN_ENFORCE || "loose").toLowerCase() === "strict";

function appSignatureGuard(req, res, next) {
  const whitelist = getWhitelist();

  // 未配置白名单 ⇒ 守卫不启用（开源用户 / 开发环境零影响）
  if (whitelist.length === 0) return next();

  // 🔄 复审修复（2026-10-08）：公开静态资源豁免 —— /api/public 下的图片/文件
  //   是浏览器 <img> 直接加载的（不带自定义头），strict 模式下若不豁免会全部 403。
  //   这些资源本身是公开的（分享页也要展示），不构成"客户端身份"语义。
  if (String(req.path || "").startsWith("/api/public")) return next();

  const reported = String(req.headers["x-app-sign-sha256"] || "").toLowerCase();

  if (!reported) {
    if (isStrict()) {
      return res.say("客户端身份校验失败", 403);
    }
    return next(); // loose：浏览器 / curl / 未升级的旧版 APP 放行
  }

  if (!whitelist.includes(reported)) {
    console.warn(
      `[app-signature] 签名不匹配 ip=${req.security?.ip || req.ip} ` +
        `reported=${reported.slice(0, 16)}… path=${req.originalUrl}`
    );
    return res.say("客户端身份校验失败", 403);
  }

  next();
}

module.exports = appSignatureGuard;
module.exports.getWhitelist = getWhitelist;
module.exports.isStrict = isStrict;
