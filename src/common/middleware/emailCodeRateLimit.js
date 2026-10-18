const db = require("../config/db");

/**
 * 邮箱验证码发送频率限制中间件
 *
 * 🔄 2026-10-12 修复（api.md P1-1/P1-3）：
 * 1. userId 一律取 `req.userId`（服务端鉴权身份），不再读 `req.body.userId`
 *    —— 原实现允许客户端在 body 里塞 userId 覆盖身份（越权写他人验证码记录）。
 * 2. 限流键去掉 scene（目标邮箱），改为按 userId+type 维度聚合：
 *    原实现 `WHERE fingerprint=? AND scene=? AND aes_key=?` 把「换邮箱」
 *    当成新配额（每用户每邮箱 5 次），可对任意邮箱无限轰炸；
 *    现按该用户今日全部 email_verify 记录聚合 attempts，语义 = 每用户每天 5 次。
 */
const emailCodeRateLimit = (req, res, next) => {
  (async () => {
    try {
      const { email: newEmail, type } = req.body.data || req.body;
      const userId = req.userId;

      if (!userId) {
        return next();
      }

      // 确定目标邮箱（与 controller 逻辑保持一致）
      let email;
      if (type === "pwd") {
        const [rows] = await db.execute(
          "SELECT email FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1",
          [userId]
        );
        email = rows[0]?.email;
      } else {
        email = newEmail;
      }

      if (!email) {
        return next();
      }

      const fingerprint = `email_verify_${type}`;
      const now = Date.now();

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartTimestamp = todayStart.getTime();

      // 该用户今日全部同类型验证码记录（跨邮箱聚合，换邮箱不重置配额）
      // ⚠ device_crypto 主键是 (fingerprint, scene)，没有 id 列 —— 排序用 created_at
      const [rows] = await db.execute(
        `SELECT captcha_attempts, captcha_expires_at, captcha_verified
         FROM device_crypto
         WHERE fingerprint = ? AND aes_key = ? AND created_at >= ?
         ORDER BY created_at DESC`,
        [fingerprint, String(userId), todayStartTimestamp]
      );

      // 今日已发送总量（Σ attempts，与 controller 的计数口径一致）
      const todayTotal = rows.reduce(
        (sum, r) => sum + (Number(r.captcha_attempts) || 0),
        0
      );
      if (todayTotal >= 5) {
        return res.say("今日发送次数已达上限，请明天再试", 429);
      }

      // 冷却：任一邮箱存在未验证且未过期的验证码 → 60s 内不让重发
      const cooling = rows.find(
        (r) => Number(r.captcha_verified) === 0 && now < Number(r.captcha_expires_at)
      );
      if (cooling) {
        const remainingSeconds = Math.floor(
          (Number(cooling.captcha_expires_at) - now) / 1000
        );
        return res.say(`【验证码】已发送，请检查你的邮箱（${remainingSeconds}秒后可重发）`, 429);
      }

      next();
    } catch (error) {
      console.error("验证码频率限制中间件错误:", error);
      next();
    }
  })();
};

module.exports = emailCodeRateLimit;
