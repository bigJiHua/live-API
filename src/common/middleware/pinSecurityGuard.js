/**
 * PIN 安全验证中间件
 *
 * 功能：
 * 1. 全局拦截所有带 PIN 码的用户请求
 * 2. 支持 30 秒放行窗口（验证一次后短期内免验证）
 * 3. 滑动窗口频率限制（60 秒内请求超限强制 PIN 验证）
 * 4. 敏感操作（POST/PUT/PATCH/DELETE）额外风控
 * 5. 连续 3 次 PIN 错误触发临时锁定（30 分钟后自动解锁）
 *
 * 响应码（code 字段）：
 * - 8301：验证成功
 * - 8302：PIN 错误
 * - 8303：需要验证（弹出 PIN 输入框）
 * - 8304：已锁定
 *
 * 验证状态（pin_status 字段）：
 * - 0：待验证（发起验证请求，等待用户输入）
 * - 1：验证通过
 * - 2：验证失败（PIN 错误）
 * - 3：已锁定（连续错误达到阈值）
 */

const jwt = require("jsonwebtoken");
const db = require("../../common/config/db");
const bcrypt = require("bcryptjs");
const pinLockGuard = require("./pinLockGuard");
const { resolvePassword } = require("../../common/utils/rsaKeys");
// 🔄 2026-10-12：复用 authGuard 的双通道取 token（Bearer 优先 → httpOnly Cookie 回落）
const { extractToken: extractAuthToken } = require("./authGuard");

/** 读取并解密请求体中的 PIN（支持 RSA 密文数组） */
const readPin = (req) => resolvePassword(req.body?.data?.pin);

const ROUTE_VERIFY_ACTION = "route_verify";
const ROUTE_VERIFY_API = "/security/pin/route-verify";

/**
 * 配置项
 * @property MAX_ERROR_COUNT    连续错误达到此值则触发锁定（默认 3 次）
 * @property LOCK_MULTIPLIER     锁定时长乘数（错误次数 × 此值 = 锁定分钟数，默认 3×30=90 分钟）
 * @property FREQ_WINDOW        频率检查时间窗口（秒，默认 60 秒）
 * @property FREQ_LIMIT         时间窗口内最大请求数（默认 60 次），超限触发 PIN 验证
 * @property SENSITIVE_WINDOW   敏感操作检查时间窗口（秒，默认 60 秒）
 * @property SENSITIVE_LIMIT    敏感操作次数上限（默认 10 次），超限触发 PIN 验证
 */
/** 从环境变量读正整数，非法/缺失时回落到默认值 */
function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 风控模式
 * - `enforce`（默认，严格）：超限返回 8303，弹 PIN 输入框
 * - `observe`：照常计数，超限**只告警不拦截**（用户体感等价于修复前），用于灰度观测阈值是否合理
 * - `off`    ：完全不计数、不拦截（最终逃生阀）
 *
 * 三种模式都可用 `.env` 的 PIN_RISK_MODE 切换并重启生效，无需改代码或回滚版本。
 */
const RISK_MODE = String(process.env.PIN_RISK_MODE || "enforce").toLowerCase();

// 非严格模式在启动时显式告警：避免「以为是 enforce、实际跑在 observe」的静默风险
if (RISK_MODE !== "enforce") {
  console.warn(
    `[pinSecurityGuard] ⚠ PIN_RISK_MODE=${RISK_MODE} —— 非严格模式，风控超限不会拦截（仅告警）。` +
      `生产环境请确保为 enforce。`
  );
}

const CONFIG = {
  MAX_ERROR_COUNT: 3,
  LOCK_MULTIPLIER: 30,
  /**
   * 以下四个阈值默认值与历史实现完全一致（60/60s、10/60s），
   * 外置只为「现场可调、不用发版」，不改变默认行为。
   */
  FREQ_WINDOW: envInt("PIN_RISK_FREQ_WINDOW", 60),
  FREQ_LIMIT: envInt("PIN_RISK_FREQ_LIMIT", 60),
  SENSITIVE_WINDOW: envInt("PIN_RISK_SENSITIVE_WINDOW", 60),
  SENSITIVE_LIMIT: envInt("PIN_RISK_SENSITIVE_LIMIT", 10),
  /**
   * 放行窗口（秒）：PIN 验证成功后，在此期间内的并发请求不再重复验证。
   * ⚠ 窗口只对「刚验证完的这 N 秒」有效，过期即恢复风控检查，
   * 不得在过期时把 verifiedAt 续期为当前时间（会导致风控永久失效）。
   */
  PASS_WINDOW: envInt("PIN_PASS_WINDOW", 30),
};

/** 放行窗口毫秒数 */
const PASS_WINDOW_MS = CONFIG.PASS_WINDOW * 1000;

/* 🔄 2026-10-13（api.md P3-3）：内存 Map 定期回收。
 *    freqMap/sensitiveMap/verifiedMap 原实现只写不删（滑动窗口 filter 只清数组内时间戳，
 *    key 永驻）⇒ 长期运行随用户量线性增长。每 10 分钟清理一次过期 key；
 *    条目数超 5000 时整体重置（宁可短暂放宽，不无限增长）。
 */
const MEMORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MEMORY_MAP_MAX = 5000;
function sweepRiskMaps() {
  const now = Date.now();
  for (const map of [freqMap, sensitiveMap]) {
    for (const [key, arr] of map.entries()) {
      if (!arr.length || now - arr[arr.length - 1] > CONFIG.FREQ_WINDOW * 1000) map.delete(key);
    }
  }
  for (const [key, session] of verifiedMap.entries()) {
    if (now - session.verifiedAt > PASS_WINDOW_MS) verifiedMap.delete(key);
  }
  if (freqMap.size + sensitiveMap.size + verifiedMap.size > MEMORY_MAP_MAX) {
    freqMap.clear();
    sensitiveMap.clear();
    verifiedMap.clear();
  }
}
const riskSweepTimer = setInterval(sweepRiskMaps, MEMORY_SWEEP_INTERVAL_MS);
if (typeof riskSweepTimer.unref === "function") riskSweepTimer.unref();

/**
 * PIN 响应码
 * @property NEED_VERIFY 8303 需要验证（前端弹出 PIN 输入框）
 * @property SUCCESS     8301 验证成功
 * @property ERROR       8302 PIN 错误
 * @property LOCKED      8304 已锁定
 */
const CODE = {
  NEED_VERIFY: 8303,
  SUCCESS: 8301,
  ERROR: 8302,
  LOCKED: 8304,
};

/** 需要额外风控的 HTTP 方法（增删改操作） */
const SENSITIVE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * 统一响应格式
 * @param {Object} res Express 响应对象
 * @param {number} code 响应码（8301-8304）
 * @param {string} message 提示信息
 * @param {Object} data 额外数据
 */
function respond(res, code, message, data = {}) {
  return res.status(200).json({ code, status: 401, message, data });
}

// ================= 内存滑动窗口（防暴力请求） =================

/** 频率限制滑动窗口：userId -> [时间戳数组] */
const freqMap = new Map();

/** 敏感操作滑动窗口：userId -> [时间戳数组] */
const sensitiveMap = new Map();

/**
 * 验证放行窗口
 * 用户验证 PIN 成功后，在此期间内的请求不再重复验证
 * userId -> { verifiedAt: 时间戳, count: 放行期内累计请求数 }
 */
const verifiedMap = new Map();

/**
 * 待验证记录插入锁
 * 防止同一用户并发请求时重复插入多条待验证记录
 * userId -> Promise（该用户的插入操作）
 */
const insertLocks = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 通用滑动窗口检查
 * @param {Map} map 存储窗口数据的 Map
 * @param {string} key 标识键（如 userId）
 * @param {number} windowSec 窗口时长（秒）
 * @param {number} limit 窗口内允许的最大事件数
 * @returns {boolean} 是否超限
 */
function slidingWindowCheck(map, key, windowSec, limit) {
  const now = Date.now();
  const windowMs = windowSec * 1000;

  let arr = map.get(key) || [];

  // 清除超出窗口的时间戳
  arr = arr.filter((t) => now - t < windowMs);
  arr.push(now);

  map.set(key, arr);

  return arr.length >= limit;
}

/**
 * 检查用户请求频率是否超限
 * 60 秒内超过 60 次请求则触发 PIN 验证
 */
function checkFrequency(userId) {
  return slidingWindowCheck(freqMap, userId, CONFIG.FREQ_WINDOW, CONFIG.FREQ_LIMIT);
}

/**
 * 检查用户敏感操作频率是否超限
 * 60 秒内超过 10 次敏感操作（POST/PUT/PATCH/DELETE）则触发 PIN 验证
 */
function checkSensitive(userId) {
  return slidingWindowCheck(
    sensitiveMap,
    userId,
    CONFIG.SENSITIVE_WINDOW,
    CONFIG.SENSITIVE_LIMIT
  );
}

/**
 * 清除用户的内存放行会话（系统锁定 / 风险锁定时必须调用）
 *
 * 目的：分支 1.5 与分支 3 都会读 verifiedMap 的 30 秒放行窗口。
 * 如果锁定时不清除，用户在「上一次 PIN 验证成功后 30 秒内」锁定系统，
 * 之后的所有请求会命中放行窗口直接 next()，锁形同虚设。
 */
function clearVerifiedSession(userId) {
  verifiedMap.delete(userId);
  freqMap.delete(userId);
  sensitiveMap.delete(userId);
}

/**
 * 用户「成功通过 PIN 验证」后调用：开启放行窗口 + 重置风控计数。
 *
 * 为什么必须重置 freqMap / sensitiveMap：
 * 放行窗口过期后风控恢复计数，一旦某窗口内累计到阈值（如 60 秒内 10 次写操作），
 * 后续每次请求都会命中阈值 —— 用户即使输对了 PIN，重发的请求仍会再触发一次 8303，
 * 形成「输 PIN 也过不去」的死循环。验证通过即代表身份已确认，计数理应归零。
 *
 * 由守卫内部的验证成功分支与 `SecurityController.verifyPin` 共同调用
 * （后者是前端 PIN 弹窗的正常路径，不经过守卫的分支 1/2）。
 */
function markVerified(userId) {
  verifiedMap.set(userId, { verifiedAt: Date.now(), count: 0 });
  freqMap.delete(userId);
  sensitiveMap.delete(userId);
}

/**
 * 确保该用户存在一条待验证记录（并发时避免重复插入）。
 * 风控超限与「请求过多」两处原本各自复制了一份相同逻辑，此处收敛为一处。
 */
async function ensurePendingRecord(userId, url, method) {
  const [pending] = await db.execute(
    `SELECT id FROM security_verify_log
     WHERE user_id = ? AND pin_status = 0 AND action_type <> 'route_verify' LIMIT 1`,
    [userId]
  );
  if (pending.length === 0) {
    await insertRecord(userId, url, method);
  }
}

/**
 * observe 模式下记录「本应拦截」的事件（不拦截，只留痕供灰度分析）
 * 统计方式：在日志中检索 `[pinSecurityGuard][observe]`
 */
function logRiskSuppressed(reason, userId, method, url, detail = "") {
  console.warn(
    `[pinSecurityGuard][observe] 风控超限但未拦截（${reason}）: ` +
      `user=${userId} ${method} ${url}${detail ? ` ${detail}` : ""}`
  );
}

// ================= 数据库操作 =================

/**
 * 获取用户 PIN 码哈希
 * @param {string} userId 用户 ID
 * @returns {Promise<string|null>} bcrypt 哈希或 null（未设置 PIN）
 */
async function getUserPin(userId) {
  const [rows] = await db.execute(
    `SELECT pin_code FROM user_info WHERE id = ? LIMIT 1`,
    [userId]
  );
  return rows[0]?.pin_code || null;
}

/**
 * 获取用户最新一条 PIN 验证记录
 * @param {string} userId 用户 ID
 * @returns {Promise<Object|null>}
 */
async function getLatestRecord(userId) {
  const [rows] = await db.execute(
    `SELECT *
     FROM security_verify_log
     WHERE user_id = ? AND action_type <> ?
     ORDER BY id DESC LIMIT 1`,
    [userId, ROUTE_VERIFY_ACTION]
  );
  return rows[0] || null;
}

/**


 * 插入一条待验证记录（pin_status = 0）
 * 同一用户的并发请求会等待前一次插入完成后再插入，避免重复
 *
 * @param {string} userId  用户 ID
 * @param {string} url     触发验证的请求路径
 * @param {string} action  操作类型（通常为 HTTP 方法）
 * @param {string} remark  备注信息
 */
async function insertRecord(userId, url, action, remark = "待验证") {
  // 如果已有同用户的插入在执行中，等待完成后直接返回（避免重复插入）
  if (insertLocks.has(userId)) {
    await insertLocks.get(userId);
    return;
  }

  const lockPromise = (async () => {
    try {
      await db.execute(
        `INSERT INTO security_verify_log
         (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
         VALUES (?, ?, ?, 0, 0, ?, NOW())`,
        [userId, url, action || "verify", remark]
      );
    } finally {
      insertLocks.delete(userId);
    }
  })();

  insertLocks.set(userId, lockPromise);
  await lockPromise;
}

/**
 * 将最新的待验证/失败记录标记为验证成功
 * 只更新状态为 0（待验证）或 2（失败）的记录
 * 同时把 action_type='lock' 的系统锁定记录也标记为已解锁，避免后续请求死循环
 */
async function markSuccess(userId) {
  // 1. 标记最近一条普通待验证/失败记录为成功
  await db.execute(
    `UPDATE security_verify_log
     SET pin_status = 1, remark = '验证成功'
     WHERE user_id = ? AND pin_status IN (0,2) AND action_type <> 'lock'
     ORDER BY id DESC LIMIT 1`,
    [userId]
  );

  // 2. 同时清除系统软锁定记录（lock-system 产生的），让用户进入解锁状态
  await db.execute(
    `UPDATE security_verify_log
     SET pin_status = 1, remark = '系统已解锁'
     WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0`,
    [userId]
  );
}

/**
 * 将最新的待验证记录标记为验证失败
 * @param {number} count 当前累计错误次数
 */
async function markFailed(userId, count) {
  await db.execute(
    `UPDATE security_verify_log
     SET pin_status = 2, error_count = ?, remark = ?
     WHERE user_id = ? AND pin_status IN (0,2)
     ORDER BY id DESC LIMIT 1`,
    [count, `验证失败第${count}次`, userId]
  );
}

/**
 * 将最新的待验证记录标记为已锁定
 * @param {number} count 当前累计错误次数（决定锁定时长：count × LOCK_MULTIPLIER 分钟）
 */
async function markLocked(userId, count) {
  await db.execute(
    `UPDATE security_verify_log
     SET pin_status = 3, error_count = ?, remark = ?
     WHERE user_id = ? AND pin_status IN (0,2)
     ORDER BY id DESC LIMIT 1`,
    [count, `锁定${count * CONFIG.LOCK_MULTIPLIER}分钟`, userId]
  );
}

/**
 * 检查锁定记录是否仍然有效（未到期）
 * @param {Object} record security_verify_log 表的最新记录
 * @returns {{ locked: boolean, remainMinutes?: number }}
 *          locked=true 表示仍在锁定中，remainMinutes 为剩余分钟数
 */
async function checkLock(record) {
  if (!record || record.pin_status !== 3) return { locked: false };

  // 锁定时长 = error_count × LOCK_MULTIPLIER 分钟
  const lockMinutes = (record.error_count || 1) * CONFIG.LOCK_MULTIPLIER;
  const expire = new Date(record.create_time).getTime() + lockMinutes * 60000;

  if (Date.now() < expire) {
    return {
      locked: true,
      remainMinutes: Math.ceil((expire - Date.now()) / 60000),
    };
  }

  return { locked: false };
}

/**
 * 验证用户输入的 PIN 码
 * @param {string} userId 用户 ID
 * @param {string} pin     用户输入的 6 位 PIN
 * @returns {Promise<boolean>} PIN 是否正确
 */
async function verifyPin(userId, pin) {
  const hash = await getUserPin(userId);
  if (!hash) return false;
  return bcrypt.compare(pin, hash);
}

// ================= 中间件 =================

/**
 * PIN 安全验证中间件
 *
 * 流程概览：
 * 1. 从 Authorization Header 解析 userId，未登录则跳过
 * 2. 检查用户是否设置了 PIN，未设置则跳过
 * 3. 检查是否处于锁定状态，锁定中则返回 8304
 * 4. 根据 security_verify_log 最新记录的状态分支处理：
 *    - pin_status = 0/2（待验证/失败）：请求带 PIN 参数？验证 or 弹窗
 *    - pin_status = 1（已验证）：检查 30 秒放行窗口 and 请求频率
 *    - 无记录：插入待验证记录，返回 8303
 */
const pinSecurityGuard = async (req, res, next) => {
  // 小程序端暂时跳过设备验证
  // if (req.xcxBypass) return next();

  /**
   * 是否已确认「该请求所属用户设置了 PIN」。
   * 用于 catch 块做 fail-closed 判定：只有在守卫确实对本次请求有约束力时才拒绝。
   * 未登录 / 未设置 PIN 的用户守卫本就放行，出错时不应连带拒绝（否则一个 DB 抖动会锁死整个应用）。
   */
  let pinProtected = false;

  try {
    const url = req.originalUrl || req.path;
    const method = req.method;
    const routeVerifyTarget = pinLockGuard.matchProtected(method, url);

    // 握手接口跳过验证（用于前端检测服务器状态）
    if (url.includes("/handshake")) return next();
    // lock-system 接口跳过 PIN 验证（锁定操作本身无需 PIN，见 lockSystem 控制器）
    if (url.includes("/lock-system")) return next();
    // PIN 管理接口（check/verify/set/change/route-verify）跳过全局拦截：
    // 这些接口自身含完整的验证、错误计数与 3 次锁定逻辑，
    // 且请求体是 oldPin/newPin 而非 pin，避免被全局中间件误判为"待验证"而返回 8303/8304 阻断。
    // 注意：pinSecurityGuard 挂载在 /api/v1 路由之前，req.originalUrl 带 /api/v1 前缀，
    // 必须用 includes（不能 startsWith），否则 changePin/verifyPin 仍会被拦截导致退登。
    if (url.includes("/security/pin/")) return next();
    // 静态资源显式跳过：/api/public 下的图片等不应计入频率窗口。
    // 现状靠「<img> 带不了 Authorization ⇒ userId 为空」隐式跳过；一旦哪天改成
    // axios blob 带 token 取图，每张图都会算进 freqMap（60 上限），
    // /card/debit 一次加载 30 张卡即可误触发「请求过多，请重新验证」。
    if (url.includes("/api/public/")) return next();

    // 从 JWT Token 中提取 userId（🔄 2026-10-12 双通道修复）
    // P0-5 改造后 web 端只带 httpOnly Cookie、不再发 Bearer 头 ——
    // 原实现只认 Bearer ⇒ web 登录用户在这里恒被判「未登录」直接放行，
    // PIN 二次验证 / 频率风控 / 敏感操作风控对 web 全面失效。
    // 现复用 authGuard 的 extractToken（Bearer 优先 → Cookie 回落），口径单一来源。
    let userId = null;
    const authToken = extractAuthToken(req);
    if (authToken) {
      try {
        const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
        userId = decoded.userId;
      } catch {}
    }

    // 未登录用户直接放行
    if (!userId) return next();

    // 未设置 PIN 的用户直接放行（放在锁定检查之前：
    // 关闭 PIN 后 pin_code 为空，即使 security_verify_log 残留锁定记录也不再拦截）
    const userPin = await getUserPin(userId);
    if (!userPin) return next();

    // 走到这里说明：已登录 + 已设置 PIN ⇒ 守卫对本次请求有约束力，后续异常必须 fail-closed
    pinProtected = true;

    // 查询用户最新一条 PIN 验证记录
    let latest = await getLatestRecord(userId);

    // ── 分支 1：系统 PIN 硬锁 ──
    if (latest?.pin_status === 3) {
      const lock = await checkLock(latest);
      if (lock.locked) {
        return respond(res, CODE.LOCKED, `锁定中 ${lock.remainMinutes} 分钟`);
      }
      // 锁已过期 → 必须验证 PIN，错误则重新锁定 90 分钟
      const pin = readPin(req);
      if (!pin) {
        return respond(res, CODE.NEED_VERIFY, "系统已锁定，请验证 PIN");
      }
      const valid = await verifyPin(userId, pin);
      if (!valid) {
        await db.execute(`UPDATE security_verify_log SET remark = CONCAT(remark, ';已重新锁定') WHERE id = ?`, [latest.id]);
        await db.execute(
          `INSERT INTO security_verify_log
           (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
           VALUES (?, '/lock-system', 'verify', 3, 3, ?, NOW())`,
          [userId, `锁定${CONFIG.LOCK_MULTIPLIER * 3}分钟`]
        );
        return respond(res, CODE.LOCKED, "PIN 错误，已重新锁定");
      }
      // 正确 → 解锁
      await db.execute(`UPDATE security_verify_log SET pin_status = 1, remark = '系统已解锁' WHERE id = ?`, [latest.id]);
      markVerified(userId);
      return next();
    }

    // ── 分支 1.5：检查路由验证触发的软锁定（无时间限制，验证 PIN 后自动解除）──
    if (latest?.action_type === 'lock' && latest?.pin_status === 0) {
      // ⚠ 此处原本有一段「内存 verifiedMap 30 秒放行窗口命中就 next()」的短路，
      // 它让「锁定后 30 秒内」的所有请求绕过软锁直接取到真实数据（锁形同虚设）。
      // 已移除：软锁未解除时一律不放行。并发竞态由 lockSystem 侧 clearVerifiedSession 兜底。
      // 风险路由验证目标交给 pinLockGuard 处理，避免通用 8303 覆盖 route_verify 的 challengeId
      if (routeVerifyTarget) {
        return next();
      }
      const pin = readPin(req);
      if (!pin) {
        return respond(res, CODE.NEED_VERIFY, "操作受限，请验证 PIN");
      }
      // 携带了 PIN → 继续到下面的 PIN 验证流程，成功后 markSuccess 会自动清除软锁
    }

    // 携带路由验证 token → 系统锁已过 → 放行给 pinLockGuard 校验 token
    const routeToken = req.headers['x-route-verify-token'];
    if (routeToken) return next();

    // 风险路由 PIN 校验入口交给 pinLockGuard 自己处理，避免全局 PIN 抢先消费。
    if (url.includes(ROUTE_VERIFY_API)) return next();

    // 已挂 pinLockGuard 的风险路由（首次请求无 token）由路由级 challenge 流程负责
    if (routeVerifyTarget && (!latest || latest.pin_status === 1 || latest.pin_status === 3)) {
      return next();
    }

    // 获取请求体中的 PIN 参数（用于待验证态尝试验证）
    const pin = readPin(req);

    // ── 分支 2：待验证 / 验证失败 / 无记录 ──
    if (!latest || latest.pin_status === 0 || latest.pin_status === 2) {

      // ⚠ 风险路由（全部 DELETE 及 import/sql、batch-delete）不在这里返回"通用 8303"：
      // 通用 8303 不带 challengeId，前端会走普通验证流程 → verifyPin 把状态刷成 1（等于先"解锁系统"）→
      // 重发删除请求才轮到 pinLockGuard 出 challenge ⇒ 用户被迫连输两次 PIN。
      // 与分支 1.5 保持一致：直接放行给 pinLockGuard，由它出带 challengeId 的 8303，
      // 保证"删一次只验一次、零容差"（token 是一次性的，下次删除必须重新验证）。
      if (routeVerifyTarget) {
        return next();
      }

      // 并发竞态保护：如果内存中已有验证通过记录，直接放行
      const existingSession2 = verifiedMap.get(userId);
      if (existingSession2 && Date.now() - existingSession2.verifiedAt < PASS_WINDOW_MS) {
        return next();
      }

      // 无记录时，先插入一条待验证记录
      if (!latest) {
        await insertRecord(userId, url, method);
      }

      // 请求中带了 PIN 参数 → 尝试验证
      if (pin) {
        const valid = await verifyPin(userId, pin);

        if (valid) {
          // PIN 正确 → 标记验证成功，设置 30 秒放行窗口并重置风控计数
          await markSuccess(userId);
          markVerified(userId);
          return next();
        }

        // PIN 错误 → 累计错误次数，达到 3 次则锁定
        const count = (latest?.error_count || 0) + 1;

        if (count >= CONFIG.MAX_ERROR_COUNT) {
          await markLocked(userId, count);
          return respond(res, CODE.LOCKED, "已锁定");
        }

        await markFailed(userId, count);
        return respond(res, CODE.ERROR, "PIN 错误");
      }

      // 请求中无 PIN 参数 → 弹出 PIN 输入框
      return respond(res, CODE.NEED_VERIFY, "请输入 PIN");
    }

    // ── 分支 3：最近一次验证已通过（pin_status = 1）──
    if (latest.pin_status === 1) {

      // PIN 状态检查接口本身跳过验证，避免死循环
      if (url.includes("/security/pin/check")) return next();

      const now = Date.now();
      const session = verifiedMap.get(userId);
      const inWindow = !!session && now - session.verifiedAt < PASS_WINDOW_MS;

      // 🟢 30 秒放行窗口内：累计请求次数，超限则重新验证
      if (inWindow) {
        session.count++;

        // 放行窗口内请求超过 FREQ_LIMIT，强制重新验证
        if (session.count >= CONFIG.FREQ_LIMIT) {
          if (RISK_MODE === "enforce") {
            await ensurePendingRecord(userId, url, method);
            verifiedMap.delete(userId);
            return respond(res, CODE.NEED_VERIFY, "请求过多，请重新验证");
          }
          // observe：只留痕，保留放行会话继续计数（不删，便于持续观测）
          logRiskSuppressed(
            "freq-window",
            userId,
            method,
            url,
            `count=${session.count}/${CONFIG.FREQ_LIMIT}`
          );
        }

        return next();
      }

      // 🔴 放行窗口已过（或本就没有放行会话）：清除会话，回归风控检查
      //
      // ⚠ 历史缺陷（本次修复）：此处原本是「session.count = 0; session.verifiedAt = now;」
      // 的续期写法 —— 续期后 diff 恒为 0，下面的 checkFrequency / checkSensitive
      // 永远执行不到（等同死代码）；且请求间隔略大于 30 秒时 count 每次归零，
      // 一次 PIN 验证后近乎无限期免验。
      // 正确语义：放行窗口只对「刚验证完的这 30 秒」有效，窗口一过立即恢复风控。
      if (session) verifiedMap.delete(userId);

      // RISK_MODE=off 时完全不计数（连滑动窗口都不写入）
      const riskOff = RISK_MODE === "off";
      const freq = riskOff ? false : checkFrequency(userId);                // 全局频率检查
      const sensitive = riskOff
        ? false
        : SENSITIVE_METHODS.includes(method) && checkSensitive(userId);      // 敏感操作频率检查

      if (freq || sensitive) {
        if (RISK_MODE === "enforce") {
          // 频率超限，插入待验证记录，弹出 PIN 验证
          await ensurePendingRecord(userId, url, method);
          return respond(res, CODE.NEED_VERIFY, "触发安全验证");
        }
        // observe：只留痕，放行
        logRiskSuppressed(
          freq ? "freq" : "sensitive",
          userId,
          method,
          url,
          freq
            ? `窗口 ${CONFIG.FREQ_WINDOW}s / 上限 ${CONFIG.FREQ_LIMIT}`
            : `窗口 ${CONFIG.SENSITIVE_WINDOW}s / 上限 ${CONFIG.SENSITIVE_LIMIT}`
        );
      }

      return next();
    }

    // 兜底放行（理论上不会走到这里）
    next();
  } catch (err) {
    console.error("[pinSecurityGuard] 守卫异常:", err);

    // ── fail-closed ──
    // 历史实现是「出错直接 next()」。攻击者只要能诱发守卫内部异常（畸形 JWT、
    // 异常路径、DB 抖动等），即可让所有 PIN 保护的接口免二次验证 —— 二次验证形同虚设。
    // 现在：仅当守卫确实对本次请求有约束力（已登录 + 已设置 PIN）时拒绝。
    // 未登录 / 未设置 PIN 的用户守卫本就放行，出错时继续放行，
    // 避免一次异常把整个应用对全部用户锁死。
    if (pinProtected) {
      return res.status(503).json({
        status: 503,
        message: "安全校验异常，请稍后重试",
      });
    }
    next();
  }
};

module.exports = {
  pinSecurityGuard,
  CODE,
  CONFIG,
  RISK_MODE,
  clearVerifiedSession,
  markVerified,
};
