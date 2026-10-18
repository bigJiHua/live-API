const net = require("net");

/* ================== 一次性随机数（防重放） ==================
 * 时间戳窗口（±2 分钟）只挡「过期重放」：窗口期内同一份请求仍可被无限次原样重放。
 * 这里用客户端一次性 nonce 补上真正的「同一请求只能用一次」。
 *
 * 兼容策略（重要）：
 *  - 只有在请求**携带**该头时才校验其唯一性 ⇒ 尚未实现该头的客户端（APP / webview-APP）不受影响；
 *  - 待三端全部同步完成后，把环境变量 REQUIRE_CLIENT_NONCE 设为 "true" 即改为强制要求，
 *    届时缺失该头的请求会被直接拒绝。
 *
 * 注意：客户端在「PIN 验证后重发原请求」时必须重新生成 nonce 与时间戳，
 * 否则复用会被判定为重放（web 端已在 utils/securityHeaders.js 的
 * refreshVolatileSecurityHeaders 中处理）。
 */
const NONCE_TTL_MS = 3 * 60 * 1000; // 略大于时间戳窗口（2 分钟）
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const REQUIRE_NONCE = process.env.REQUIRE_CLIENT_NONCE === "true";
const NONCE_STORE_MAX = 5000;

/**
 * nonce 复用的业务码（**独立码，不要与其它 400 混用**）
 * 前端据此识别"可自动重发一次"，见 web/src/utils/request/nonceRetry.js
 */
const CODE_NONCE_REPLAY = 8401;

/**
 * nonce 校验模式（`PIN_NONCE_MODE`）
 * - `enforce`（默认）：复用直接拒绝，返回 400 + `code:8401` + `retryable:true`
 * - `observe`：复用只告警不拒绝（等价于修复前），用于灰度
 * - `off`    ：整段校验关闭
 */
const NONCE_MODE = String(process.env.PIN_NONCE_MODE || "enforce").toLowerCase();

if (NONCE_MODE !== "enforce") {
  console.warn(
    `[securityCheck] ⚠ PIN_NONCE_MODE=${NONCE_MODE} —— 非严格模式，nonce 复用的请求不会被拒绝。` +
      `生产环境请确保为 enforce。`
  );
}
if (REQUIRE_NONCE && NONCE_MODE === "off") {
  console.warn(
    "[securityCheck] ⚠ REQUIRE_CLIENT_NONCE=true 但 PIN_NONCE_MODE=off，强制校验不会生效。"
  );
}
/** nonce -> 过期时间戳（毫秒） */
const nonceStore = new Map();

/** 该 nonce 是否已在窗口期内被使用过 */
function isNonceUsed(nonce) {
  const exp = nonceStore.get(nonce);
  if (!exp) return false;
  if (Date.now() > exp) {
    nonceStore.delete(nonce);
    return false;
  }
  return true;
}

/** 记录 nonce（超过容量时清理过期项） */
function markNonceUsed(nonce) {
  if (nonceStore.size >= NONCE_STORE_MAX) sweepNonces();
  nonceStore.set(nonce, Date.now() + NONCE_TTL_MS);
}

function sweepNonces() {
  const now = Date.now();
  for (const [key, exp] of nonceStore.entries()) {
    if (now > exp) nonceStore.delete(key);
  }
  // 清理后仍超限（极端高频）→ 整体重置，宁可短暂放宽也不无限增长内存
  if (nonceStore.size >= NONCE_STORE_MAX) nonceStore.clear();
}

const securityCheck = (req, res, next) => {
  try {
    // 跳过静态文件请求（图片、字体等）+ 公开分享接口
    if (
      req.path.includes("/uploads/") ||
      req.path.includes("/temp/") ||
      req.path.includes("/share/")
    ) {
      return next();
    }

    const h = req.headers;
    /* ================== 1. 严格头校验 ================== */
    if (h["x-requested-with"] !== "XMLHttpRequest") {
      console.warn('拦截api直接请求')
      return res.say("非法请求！", 400);
    }

    /* ================== 2. 时间戳与重放攻击校验 ================== */
    const ts = Number(h["x-client-timestamp"]);
    const now = Date.now();
    if (!ts || Math.abs(now - ts) > 2 * 60 * 1000) {
      console.warn('请求失效，请检查系统时间')
      return res.say("非法请求！", 400);
    }

    /* ================== 2.5 一次性随机数（防重放） ================== */
    if (NONCE_MODE !== "off") {
      const nonce = h["x-client-nonce"];

      if (!nonce) {
        if (REQUIRE_NONCE) {
          console.warn("缺少客户端随机数（REQUIRE_CLIENT_NONCE=true）");
          return res.say("非法请求！", 400);
        }
      } else if (!NONCE_RE.test(nonce)) {
        console.warn("客户端随机数格式非法");
        return res.say("非法请求！", 400);
      } else if (isNonceUsed(nonce)) {
        // 复用已有随机数 ⇒ 重放。返回**独立业务码**，让前端能识别并自动重发一次
        // （见 web/src/utils/request/nonceRetry.js），而不是抛一个无法自愈的笼统 400。
        if (NONCE_MODE === "enforce") {
          console.warn("检测到重放请求（nonce 复用）");
          return res.status(400).json({
            status: 400,
            code: CODE_NONCE_REPLAY,
            message: "请求重复提交，请稍后重试",
            retryable: true,
          });
        }
        console.warn(
          `[securityCheck][observe] nonce 复用本应被拒: ${req.method} ${req.originalUrl}`
        );
      }

      // 无论是否拦截都要登记（observe 模式也要能持续检测复用）
      if (nonce && NONCE_RE.test(nonce)) markNonceUsed(nonce);
    }

    /* ================== 3. IP 格式规整化 ================== */
    const clientIp = req.ip;
    if (clientIp && net.isIP(clientIp) === 0) {
      console.warn('客户端IP异常')
      return res.say("非法请求！", 400);
    }

    /* ================== 4. 指纹与设备一致性 ================== */
    const fp = h["x-fingerprint-hash"];
    const ua = h["user-agent"] || "";
    const customUa = h["x-user-agent-custom"] || "";
    
    if (fp && customUa && ua !== customUa) {
      console.warn('设备环境异常')
      return res.say("非法请求！", 400);
    }

    /* ================== 5. 挂载安全上下文 ================== */
    req.security = {
      ip: clientIp,
      fingerprint: fp,
      deviceDesc: `${h["x-device-model"] || "Unknown"} (${h["x-os-name"] || "Unknown"})`,
      timestamp: ts,
      isMobile: h["x-device-type"] === "mobile",
    };

    next();
  } catch (err) {
    console.error("Security Middleware Error:", err);
    return res.status(500).json({ status: 500, message: "Server Security Error" });
  }
};

module.exports = { securityCheck };
