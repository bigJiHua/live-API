const User = require("../../modules/auth/model/user");

/**
 * 登录失败锁定（安全整改 P0-2，2026-10-08）
 *
 * ## 改造前的缺点（本次修复的核心）
 * 旧实现是**请求驱动**：每收到一次 `/login` 请求就 `count++`，
 * **在密码校验之前**（`tracker.count++` 位于查用户之前）。
 * ⇒ 正常用户只要一分钟内点了 10 次「登录」（哪怕密码全对、其中含误触重试），
 * 就会被锁 60 秒；而真正的暴力破解（一直用错密码）反倒不受额外惩罚。
 *
 * ## 现在的行为
 * - **失败驱动**：只有「用户不存在」或「密码错误」才计数，密码正确一律不计数。
 * - **按账号归一化**：`trim()` + 小写，避免 `Admin` / `admin` / ` admin ` 被当成三个账号
 *   各自拿到独立的失败额度（否则大小写变体即可绕过锁定）。
 * - 阈值：15 分钟内失败 5 次 ⇒ 锁定 15 分钟；登录成功即清零。
 * - 用户不存在**同样计数**：否则可以用不存在的账号无限试探而不触发锁定（撞库探测）。
 *
 * ## 为什么不落库（对齐 D-5 / Q6「不引 Redis、不过度设计」）
 * 失败计数保存在**进程内存**，因此：进程重启 ⇒ 计数清空；无法多实例共享。
 * 这与已登记的 **R-3（单实例部署约束）** 是同一取舍，不再单独引入 DB 写放大。
 * 真需要跨重启锁定时，再往 `user` 表加字段（届时也应一并解决分布式计数）。
 *
 * ## 防用户枚举（P1-14）
 * 「用户不存在」与「密码错误」返回**完全相同**的状态码与文案，
 * 且都走同一条失败计数，杜绝通过响应差异探测账号是否存在。
 */

/** 失败驱动参数 */
const RATE_LIMIT = {
  maxFailures: 5,               // 允许的连续失败次数
  windowMs: 15 * 60 * 1000,     // 统计窗口 15 分钟
  lockoutMs: 15 * 60 * 1000,    // 锁定时长 15 分钟
};

/** 防枚举：账号不存在与密码错误必须完全同构（状态码 + 文案） */
const GENERIC_AUTH_ERROR = "账号或密码错误";
const GENERIC_AUTH_STATUS = 404;

/** key(normalized 账号) -> { count, windowStart, lockedUntil } */
const failureTracker = new Map();

/**
 * 账号归一化，作为失败计数的 key。
 * 大小写变体与首尾空格必须归到同一条，否则锁定可被绕过。
 */
function normalizeKey(nameOrEmail) {
  return String(nameOrEmail ?? "").trim().toLowerCase();
}

/**
 * 取（并按需惰性重置）某账号的失败记录。
 * 重置条件：① 窗口已过期 ② 锁定已到期
 */
function getEntry(key) {
  if (!key) return null;
  const now = Date.now();
  let entry = failureTracker.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT.windowMs) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
    failureTracker.set(key, entry);
    return entry;
  }

  // 锁定已到期 ⇒ 计数归零，重新给满额度
  if (entry.lockedUntil && now >= entry.lockedUntil) {
    entry.lockedUntil = 0;
    entry.count = 0;
    entry.windowStart = now;
  }
  return entry;
}

/**
 * 当前是否锁定期。
 * @returns {number} 剩余毫秒数；未锁定返回 0
 */
function lockRemainingMs(nameOrEmail) {
  const entry = getEntry(normalizeKey(nameOrEmail));
  if (!entry || !entry.lockedUntil) return 0;
  const remain = entry.lockedUntil - Date.now();
  return remain > 0 ? remain : 0;
}

/**
 * 记录一次登录失败（**由 controller 在确认密码错误后调用**）。
 * @returns {{ locked: boolean, remainingMs: number, remainAttempts: number }}
 */
function recordLoginFailure(nameOrEmail) {
  const key = normalizeKey(nameOrEmail);
  const entry = getEntry(key);
  if (!entry) return { locked: false, remainingMs: 0, remainAttempts: RATE_LIMIT.maxFailures };

  entry.count += 1;

  if (entry.count >= RATE_LIMIT.maxFailures) {
    entry.lockedUntil = Date.now() + RATE_LIMIT.lockoutMs;
    return {
      locked: true,
      remainingMs: RATE_LIMIT.lockoutMs,
      remainAttempts: 0,
    };
  }

  return {
    locked: false,
    remainingMs: 0,
    remainAttempts: RATE_LIMIT.maxFailures - entry.count,
  };
}

/** 登录成功 ⇒ 清零该账号的失败计数 */
function clearLoginFailures(nameOrEmail) {
  failureTracker.delete(normalizeKey(nameOrEmail));
}

/** 当前失败次数（供 controller 生成提示文案 / 测试用） */
function currentFailureCount(nameOrEmail) {
  const entry = getEntry(normalizeKey(nameOrEmail));
  return entry ? entry.count : 0;
}

/** 记录过多时的自清理：条目数超阈值时剔除已过期的，防止内存无限增长 */
function sweepIfNeeded() {
  if (failureTracker.size <= 1000) return;
  const now = Date.now();
  for (const [key, entry] of failureTracker.entries()) {
    const expiredWindow = now - entry.windowStart > RATE_LIMIT.windowMs;
    const expiredLock = !entry.lockedUntil || now >= entry.lockedUntil;
    if (expiredWindow && expiredLock) failureTracker.delete(key);
  }
  // 极端情况下仍然超量（大量账号同时失败且都在锁定期）⇒ 整体重置，
  // 宁可短暂放宽计数，也不让内存无限增长。
  if (failureTracker.size > 5000) failureTracker.clear();
}

/**
 * `/login` 前置中间件：**只负责检查**，不再计数。
 *
 * 1. 归一化 key，锁定期内直接 423（不再查库，省一次查询）
 * 2. 查用户 —— 不存在时**记录一次失败**并返回与「密码错误」完全相同的响应（防枚举）
 * 3. 保留原有的「账号被管理员锁定（status=0）⇒ 12 小时后自动解锁」逻辑
 */
async function accountLockCheck(req, res, next) {
  try {
    const { nameOrEmail } = req.body.data || {};
    if (!nameOrEmail) {
      return res.say("非法未知参数请求！", 401);
    }

    // 1) 失败锁定检查（内存计数）
    const remaining = lockRemainingMs(nameOrEmail);
    if (remaining > 0) {
      return res.status(423).json({
        status: 423,
        message: `登录失败次数过多，请 ${Math.ceil(remaining / 1000)} 秒后重试`,
        locked: true,
      });
    }

    // 2) 查用户
    const user =
      (await User.findByEmail(nameOrEmail)) ||
      (await User.findByUsername(nameOrEmail));

    if (!user) {
      // 账号不存在同样计数（撞库探测也应被限住），
      // 但响应与「密码错误」逐字相同 —— 不泄露账号是否存在。
      recordLoginFailure(nameOrEmail);
      sweepIfNeeded();
      return res.say(GENERIC_AUTH_ERROR, GENERIC_AUTH_STATUS);
    }

    // 3) 管理员锁定状态（12 小时自动解锁）—— 保持原有行为
    if (Number(user.status) === 0) {
      const lockTime = new Date(user.update_time).getTime();
      const unlockTime = lockTime + 12 * 60 * 60 * 1000;
      const currentTime = Date.now();

      if (currentTime < unlockTime) {
        const remainingHours = Math.ceil((unlockTime - currentTime) / (60 * 60 * 1000));
        return res.status(423).json({
          status: 423,
          message: `账户已被锁定，请在 ${remainingHours} 小时后重试`,
          locked: true,
        });
      }
      await User.setLockStatus(user.id, false);
      console.log(`[账户解锁] 用户 ${user.id} 锁定超过12小时，已自动解锁`);
    }

    req.checkedUser = user;
    req.loginKey = normalizeKey(nameOrEmail);
    next();
  } catch (error) {
    console.error("账户锁定检查异常:", error);
    next();
  }
}

// 保持默认导出为中间件函数（`api/index.js:24` 直接调用），附加导出供 controller / 测试使用
module.exports = accountLockCheck;
module.exports.accountLockCheck = accountLockCheck;
module.exports.recordLoginFailure = recordLoginFailure;
module.exports.clearLoginFailures = clearLoginFailures;
module.exports.lockRemainingMs = lockRemainingMs;
module.exports.currentFailureCount = currentFailureCount;
module.exports.normalizeKey = normalizeKey;
module.exports.RATE_LIMIT = RATE_LIMIT;
module.exports.GENERIC_AUTH_ERROR = GENERIC_AUTH_ERROR;
module.exports.GENERIC_AUTH_STATUS = GENERIC_AUTH_STATUS;
/** 仅供测试：清空全部失败计数 */
module.exports.__reset = () => failureTracker.clear();
/** 仅供测试：当前失败计数的条目数（用于验证 sweep 是否生效） */
module.exports.__size = () => failureTracker.size;
/** 仅供测试：直接触发一次内存回收（不依赖中间件分支，便于稳定验证） */
module.exports.__sweep = () => sweepIfNeeded();