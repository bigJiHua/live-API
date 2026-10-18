const UserPin = require("../../auth/model/pin");
const UserLog = require("../../auth/model/log");
const User = require("../../auth/model/user");
const db = require("../../../common/config/db");
const pinLockGuard = require("../../../common/middleware/pinLockGuard");
const {
  clearVerifiedSession,
  markVerified,
} = require("../../../common/middleware/pinSecurityGuard");
const { resolvePassword } = require("../../../common/utils/rsaKeys");
// ✅ P1-15（复审补漏）：日志字段一律服务端采集
const {
  buildServerSideLogFields,
} = require("../../../common/utils/logFields");

/** 解密 PIN（支持 RSA 密文数组，安全键盘 secureOnly 输入） */
const resolvePin = (raw) => resolvePassword(raw);

/**
 * 安全控制器 - PIN 码管理
 * 使用 UserPin 模型进行数据操作
 */
class SecurityController {
  /**
   * 0. 查看 PIN 状态
   * 检查用户是否已设置 PIN 码
   */
  async PinStatus(req, res) {
    try {
      const hasPin = await UserPin.hasPin(req.userId);
      if (!hasPin) {
        return res
          .status(400)
          .json({ status: 400, message: "请先设置 PIN 码", ismessage: true });
      }
      return res.say("状态正常！", 200);
    } catch (error) {
      console.error("检查 PIN 状态失败:", error);
      return res.say("检查失败", 500);
    }
  }

  /**
   * 1. 验证 PIN
   * @param {string} pin - 6位数字 PIN 码
   */
  async verifyPin(req, res) {
    try {
      const { pin: rawPin } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）：authSecurityData 对明文请求直接放行，须双路径
      const pin = resolvePin(rawPin); // 支持 RSA 密文数组解密

      // 校验 PIN 格式
      if (!pin || pin.length !== 6 || !/^\d+$/.test(pin)) {
        return res
          .status(400)
          .json({ status: 400, message: "PIN 码必须是6位纯数字" });
      }

      // 获取用户 PIN 信息
      const user = await UserPin.findById(req.userId);
      if (!user?.pin_code) {
        return res
          .status(400)
          .json({ status: 400, message: "请先设置 PIN 码" });
      }

      // ── 锁定态前置检查：pin_status=3（含系统硬锁）→ 直接拒绝，不再走验证 ──
      const [lockRows] = await db.execute(
        `SELECT id, error_count, create_time
         FROM security_verify_log
         WHERE user_id = ? AND pin_status = 3 AND action_type <> 'route_verify'
         ORDER BY id DESC LIMIT 1`,
        [req.userId]
      );
      const lockRecord = lockRows[0];
      if (lockRecord) {
        const lockMinutes =
          (Number(lockRecord.error_count) || 3) * pinLockGuard.CONFIG.LOCK_MULTIPLIER;
        const expire =
          new Date(lockRecord.create_time).getTime() + lockMinutes * 60000;
        if (Date.now() < expire) {
          const remainMinutes = Math.ceil((expire - Date.now()) / 60000);
          return res.status(200).json({
            code: 8304,
            status: 200,
            message: `PIN 已锁定，剩余 ${remainMinutes} 分钟`,
            data: { locked: true, remainMinutes },
          });
        }
        // 锁定期已过 → 清除锁定状态与错误计数，允许重新验证
        await db.execute(
          `UPDATE security_verify_log
           SET pin_status = 0, error_count = 0, remark = '锁定到期，重新验证'
           WHERE id = ?`,
          [lockRecord.id]
        );
      }

      // 验证 PIN
      const isValid = await UserPin.verify(pin, user.pin_code);
      if (!isValid) {
        // 错误计数：无记录则插入新失败记录，有则对最新一条记录累加（无论 pin_status 是 0/1/2），
        // 否则"验证成功过"或"无历史"时 error_count 永远为 0，剩余次数恒为 3。
        const [latestRecord] = await db.execute(
          `SELECT id, error_count FROM security_verify_log
           WHERE user_id = ? AND action_type <> 'route_verify'
           ORDER BY id DESC LIMIT 1`,
          [req.userId]
        );
        if (latestRecord[0]) {
          await db.execute(
            `UPDATE security_verify_log
             SET pin_status = 2, error_count = error_count + 1, remark = '验证失败'
             WHERE id = ?`,
            [latestRecord[0].id]
          );
        } else {
          await db.execute(
            `INSERT INTO security_verify_log
             (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
             VALUES (?, ?, 'verify', 2, 1, '验证失败', NOW())`,
            [req.userId, req.originalUrl || '/security/pin/verify']
          );
        }

        // 检查 security_verify_log 的错误次数是否达阈值
        const secErrorCount = latestRecord[0]
          ? latestRecord[0].error_count + 1
          : 1;

        // 🔄 2026-10-13（api.md P3-6）：补写 user_log 失败记录。
        //    原实现 verifyPin 失败路径只更新 security_verify_log、不写 user_log，
        //    导致下方 `logErrorCount >= 5` 锁账户的兜底在此路径永不触发（死逻辑）。
        //    口径与 changePin 的错误路径一致（type:'pin', status:0）。
        await UserLog.append({
          ...buildServerSideLogFields(req, req.userId),
          type: "pin",
          status: 0,
          error_message: "PIN验证失败",
        });

        // 检查 user_log 的错误次数
        const logErrorCount = await UserLog.getPinErrorCount(req.userId);
        if (secErrorCount >= 3) {
          // security_verify_log 达到3次 → 硬锁定
          await db.execute(
            `UPDATE security_verify_log
             SET pin_status = 3, remark = '锁定90分钟'
             WHERE user_id = ? AND pin_status = 2 AND action_type <> 'route_verify'
             ORDER BY id DESC LIMIT 1`,
            [req.userId]
          );
          return res.status(200).json({
            code: 8304, status: 200, message: "PIN 错误次数过多，已锁定90分钟"
          });
        }
        if (logErrorCount >= 5) {
          await User.lockUser(req.userId);
          return res.status(401).json({
            status: 401, message: "连续输入错误超过5次，账户已被锁定", forceLogout: true, locked: true
          });
        }
        return res.status(200).json({
          code: 8302, status: 200, message: `PIN 错误（剩余 ${3 - secErrorCount} 次）`
        });
      }

      // ✅ PIN 正确 → 同步更新 security_verify_log，解除所有待验证/锁定状态
      // 1. 标记最近一条待验证/失败记录为成功，并重置错误计数（防止历史错误累积误锁）
      await db.execute(
        `UPDATE security_verify_log
         SET pin_status = 1, error_count = 0, remark = '验证成功'
         WHERE user_id = ? AND pin_status IN (0,2) AND action_type <> 'route_verify'
         ORDER BY id DESC LIMIT 1`,
        [req.userId]
      );
      // 2. 清除系统软锁定记录
      await db.execute(
        `UPDATE security_verify_log
         SET pin_status = 1, remark = '系统已解锁'
         WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0`,
        [req.userId]
      );

      // 3. 开启 30 秒放行窗口并重置频率/敏感操作计数。
      // 前端 PIN 弹窗走的是本接口（不经过 pinSecurityGuard 的分支 1/2），
      // 若不在此重置，风控窗口内的计数会保持超限，重发的请求会被再次拦成 8303 —— 
      // 形成「输对 PIN 也过不去」的死循环。
      markVerified(req.userId);

      return res.json({ code: 8301, status: 200, message: "验证成功", verified: true });
    } catch (error) {
      console.error("验证 PIN 失败:", error);
      return res.status(500).json({ status: 500, message: "验证失败" });
    }
  }

  /**
   * 风险路由 PIN 验证
   * 验证通过后生成短时一次性 token，供原始风险请求重发时携带。
   */
  async verifyRoutePin(req, res) {
    try {
      const { pin: rawPin, challengeId, requestUrl, method } = req.body.data || {};
      const pin = resolvePin(rawPin); // 支持 RSA 密文数组解密
      const normalizedMethod = String(method || "").toUpperCase();

      if (!pin || pin.length !== 6 || !/^\d+$/.test(pin)) {
        return res.status(400).json({
          code: pinLockGuard.CODE.ERROR,
          status: 400,
          message: "PIN 码格式错误",
        });
      }

      if (!challengeId || !requestUrl || !normalizedMethod) {
        return res.status(400).json({
          status: 400,
          message: "风险验证参数不完整",
        });
      }

      const [rows] = await db.execute(
        `SELECT *
         FROM security_verify_log
         WHERE id = ?
           AND user_id = ?
           AND request_url = ?
           AND action_type = ?
           AND pin_status IN (0, 2)
           AND verify_expire_time > NOW()
         LIMIT 1`,
        [challengeId, req.userId, requestUrl, pinLockGuard.ACTION_TYPE]
      );

      const challenge = rows[0];
      if (!challenge || !String(challenge.remark || "").includes(`method:${normalizedMethod}`)) {
        return res.status(200).json({
          code: pinLockGuard.CODE.NEED_VERIFY,
          status: 200,
          message: "风险验证已过期，请重新操作",
          data: {
            action_type: pinLockGuard.ACTION_TYPE,
            expired: true,
          },
        });
      }

      const bodyHash = String(challenge.remark || "").match(/body:([a-f0-9]{64})/)?.[1];
      if (!bodyHash) {
        return res.status(200).json({
          code: pinLockGuard.CODE.NEED_VERIFY,
          status: 200,
          message: "风险验证已更新，请重新操作",
          data: {
            action_type: pinLockGuard.ACTION_TYPE,
            expired: true,
          },
        });
      }

      const user = await UserPin.findById(req.userId);
      if (!user?.pin_code) {
        return res.status(400).json({ status: 400, message: "请先设置 PIN 码" });
      }

      const isValid = await UserPin.verify(pin, user.pin_code);
      if (!isValid) {
        const errorCount = Number(challenge.error_count || 0) + 1;

        if (errorCount >= pinLockGuard.CONFIG.MAX_ERROR_COUNT) {
          await db.execute(
            `UPDATE security_verify_log
             SET pin_status = 2, error_count = ?, remark = ?
             WHERE id = ? AND user_id = ?`,
            [
              errorCount,
              `${challenge.remark.split(";验证失败第")[0]};触发系统锁定`,
              challenge.id,
              req.userId,
            ]
          );

          // 防止短时间内重复插入软锁记录
          const [existingLock] = await db.execute(
            `SELECT id FROM security_verify_log
             WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0
             LIMIT 1`,
            [req.userId]
          );

          if (existingLock.length === 0) {
            await db.execute(
              `INSERT INTO security_verify_log
               (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
               VALUES (?, ?, ?, 0, 0, ?, NOW())`,
              [
                req.userId,
                "/lock-system",
                "lock",
                "风险操作 PIN 错误次数过多，临时锁定",
              ]
            );

            // 与 lock-system 一致：清掉内存放行会话，避免软锁被 30 秒放行窗口绕过
            clearVerifiedSession(req.userId);
          }

          return res.status(200).json({
            code: pinLockGuard.CODE.ERROR,
            status: 200,
            message: "PIN 错误次数过多，操作受限，请验证系统 PIN",
            data: {
              action_type: pinLockGuard.ACTION_TYPE,
            },
          });
        }

        await db.execute(
          `UPDATE security_verify_log
           SET pin_status = 2, error_count = ?, remark = ?
           WHERE id = ? AND user_id = ?`,
          [
            errorCount,
            `${challenge.remark.split(";验证失败第")[0]};验证失败第${errorCount}次`,
            challenge.id,
            req.userId,
          ]
        );

        return res.status(200).json({
          code: pinLockGuard.CODE.ERROR,
          status: 200,
          message: "PIN 错误",
          data: {
            action_type: pinLockGuard.ACTION_TYPE,
            challengeId: challenge.id,
            requestUrl,
            method: normalizedMethod,
            remainingAttempts: pinLockGuard.CONFIG.MAX_ERROR_COUNT - errorCount,
          },
        });
      }

      const token = pinLockGuard.createToken();
      const tokenHash = pinLockGuard.hashToken(token);

      await db.execute(
        `UPDATE security_verify_log
         SET pin_status = 1,
             error_count = 0,
             verify_expire_time = DATE_ADD(NOW(), INTERVAL ? MINUTE),
             remark = ?
         WHERE id = ? AND user_id = ?`,
        [
          pinLockGuard.CONFIG.EXPIRE_MINUTES,
          pinLockGuard.tokenRemark(tokenHash, normalizedMethod, bodyHash),
          challenge.id,
          req.userId,
        ]
      );

      // 风险路由验证成功时，同步解除系统软锁定（避免后续普通请求被分支1.5 死循环拦截）
      await db.execute(
        `UPDATE security_verify_log
         SET pin_status = 1, remark = '系统已解锁'
         WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0`,
        [req.userId]
      );

      return res.status(200).json({
        code: 8301,
        status: 200,
        message: "验证成功",
        data: {
          action_type: pinLockGuard.ACTION_TYPE,
          token,
          headerName: pinLockGuard.HEADER_TOKEN,
          expiresIn: pinLockGuard.CONFIG.EXPIRE_MINUTES * 60,
        },
      });
    } catch (error) {
      console.error("风险路由 PIN 验证失败:", error);
      return res.status(500).json({ status: 500, message: "验证失败" });
    }
  }

  /**
   * 2. 设置 PIN
   * @param {string} pin - 6位数字 PIN 码
   */
  async setPin(req, res) {
    try {
      const { pin: rawPin } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      const pin = resolvePin(rawPin); // 支持 RSA 密文数组解密

      // 校验 PIN 格式
      if (!pin || pin.length !== 6 || !/^\d+$/.test(pin)) {
        return res.say("PIN码必须是6位纯数字", 400);
      }

      // 使用 UserPin.create 设置 PIN
      const result = await UserPin.create(req.userId, pin);

      if (result.status !== 200) {
        return res
          .status(result.status)
          .json({ status: result.status, message: result.message });
      }

      return res.say("设置成功", 200);
    } catch (error) {
      console.error("设置 PIN 失败:", error);
      return res.say("设置失败", 500);
    }
  }

  /**
   * 3. 修改 / 关闭 PIN 码
   * @param {string} oldPin - 原 PIN 码
   * @param {string} newPin - 新 PIN 码 / 000000 = 关闭PIN
   */
  async changePin(req, res) {
    try {
      const { oldPin: rawOldPin, newPin: rawNewPin } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      const oldPin = resolvePin(rawOldPin); // 支持 RSA 密文数组解密
      const newPin = resolvePin(rawNewPin);

      // 格式校验（6 位纯数字强制校验）
      if (!oldPin || oldPin.length !== 6 || !/^\d+$/.test(oldPin)) {
        return res
          .status(400)
          .json({ status: 400, message: "原 PIN 码必须是6位纯数字" });
      }
      if (!newPin || newPin.length !== 6 || !/^\d+$/.test(newPin)) {
        return res
          .status(400)
          .json({ status: 400, message: "新 PIN 码必须是6位纯数字" });
      }

      // 关闭 PIN 的固定标记（6位纯数字，符合校验）
      const CLOSE_PIN_FLAG = "000000";

      // 1. 获取用户 PIN 信息
      const user = await UserPin.findById(req.userId);
      if (!user?.pin_code) {
        return res
          .status(400)
          .json({ status: 400, message: "请先设置 PIN 码" });
      }

      // 2. 校验旧 PIN
      const isValid = await UserPin.verify(oldPin, user.pin_code);
      if (!isValid) {
        // 错误计数：有记录则对最新一条累加，无记录则插入（与 verifyPin 的 3 次锁定语义一致）
        const [pinLogRows] = await db.execute(
          `SELECT id, error_count FROM security_verify_log
           WHERE user_id = ? AND action_type <> 'route_verify'
           ORDER BY id DESC LIMIT 1`,
          [req.userId]
        );
        if (pinLogRows[0]) {
          await db.execute(
            `UPDATE security_verify_log
             SET pin_status = 2, error_count = error_count + 1, remark = '验证失败'
             WHERE id = ?`,
            [pinLogRows[0].id]
          );
        } else {
          await db.execute(
            `INSERT INTO security_verify_log
             (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
             VALUES (?, ?, 'verify', 2, 1, '验证失败', NOW())`,
            [req.userId, req.originalUrl || '/security/pin/change']
          );
        }
        const pinErrCount = pinLogRows[0]
          ? pinLogRows[0].error_count + 1
          : 1;

        if (pinErrCount >= 3) {
          // 连续 3 次 PIN 错误 → 锁定 PIN 验证（90 分钟，与 verifyPin 一致）
          await db.execute(
            `UPDATE security_verify_log
             SET pin_status = 3, remark = '锁定90分钟'
             WHERE user_id = ? AND pin_status = 2 AND action_type <> 'route_verify'
             ORDER BY id DESC LIMIT 1`,
            [req.userId]
          );
          return res.status(200).json({
            code: 8304,
            status: 200,
            message: "PIN 错误次数过多，已锁定90分钟",
            data: { locked: true },
          });
        }

        // 错误次数未达阈值：同步 user_log 做账户级统计（保持原 5 次锁账户兜底）
        const errorCount = await UserLog.getPinErrorCount(user.id);
        if (errorCount >= 5) {
          // 超过5次，锁定账户并强制退出登录
          await User.lockUser(user.id);
          return res.status(401).json({
            status: 401,
            message: "连续输入错误超过5次，账户已被锁定",
            forceLogout: true,
            locked: true
          });
        }

        // 🔴 登录失败统计
        //    ✅ 复审修复（P1-15 漏改，2026-10-08）：旧写法 `...clientData`（req.body 整体展开）
        //    让客户端可伪造 login_ip/fingerprint/path 等审计字段 —— 与 auth 模块同批整改时
        //    漏掉了 security 模块这一处。改走服务端采集。
        await UserLog.append({
          ...buildServerSideLogFields(req, user.id),
          type: "pin",
          status: 0,
          error_message: "尝试修改PIN码PIN码输入错误",
        });
        return res.status(400).json({
          status: 400,
          message: "原 PIN 码错误",
          errorCount: pinErrCount,
          remainingAttempts: Math.max(3 - pinErrCount, 0),
        });
      }

      // 3. 逻辑分支：关闭 PIN 或修改 PIN
      let result;
      if (newPin === CLOSE_PIN_FLAG) {
        // 关闭 PIN
        result = await UserPin.close(req.userId);
      } else {
        // 修改 PIN
        result = await UserPin.update(req.userId, oldPin, newPin);
      }

      return res.status(result.status).json({
        status: result.status,
        message: result.message,
      });
    } catch (error) {
      console.error("修改 PIN 失败:", error);
      return res.status(500).json({ status: 500, message: "操作失败" });
    }
  }

  /**
   * 4. 重置 PIN
   * @param {string} verificationCode - 邮箱验证码
   * @param {string} newPin - 新 PIN 码
   */
  async resetPin(req, res) {
    try {
      const { verificationCode, newPin: rawNewPin } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      const newPin = resolvePin(rawNewPin); // 支持 RSA 密文数组解密

      // 新 PIN 格式校验
      if (!newPin || newPin.length !== 6 || !/^\d+$/.test(newPin)) {
        return res
          .status(400)
          .json({ status: 400, message: "PIN 码必须是6位纯数字" });
      }

      // 🔒 2026-10-13 修复（api.md P1-3）：恢复邮箱验证码校验。
      //    原实现整段被注释 ⇒ 任何已登录用户无需验证码/原 PIN 即可重设 PIN，
      //    PIN 二次防护被完整绕过。校验口径与 changePasswordWithCode 一致：
      //    查 device_crypto 的 email_verify_pwd 记录（scene=用户当前邮箱），
      //    比对验证码 + 有效期 + 未使用，通过后核销。
      if (!verificationCode) {
        return res.say("验证码不能为空", 400);
      }

      const [userRows] = await db.execute(
        "SELECT email FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1",
        [req.userId]
      );
      const userEmail = userRows[0]?.email;
      if (!userEmail) {
        return res.say("您的账号未绑定邮箱，无法重置 PIN", 400);
      }

      const fingerprint = "email_verify_pwd";
      const [vRows] = await db.execute(
        `SELECT * FROM device_crypto
         WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
        [fingerprint, userEmail, req.userId]
      );
      if (!vRows || vRows.length === 0) {
        return res.say("验证码不存在或已过期", 400);
      }
      const record = vRows[0];
      const now = Date.now();
      if (now > Number(record.captcha_expires_at)) {
        return res.say("验证码已过期", 400);
      }
      if (Number(record.captcha_verified) === 1) {
        return res.say("验证码已被使用", 400);
      }
      if (record.captcha_code !== verificationCode) {
        await db.execute(
          `UPDATE device_crypto SET fail_count = fail_count + 1, updated_at = ?
           WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
          [now, fingerprint, userEmail, req.userId]
        );
        return res.say("验证码错误", 400);
      }

      // 使用 UserPin.reset 重置 PIN
      const result = await UserPin.reset(req.userId, newPin);

      // 核销验证码（仅重置成功后）
      if (result.status === 200) {
        await db.execute(
          `UPDATE device_crypto SET captcha_verified = 1, updated_at = ?
           WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
          [now, fingerprint, userEmail, req.userId]
        );
      }

      return res.status(result.status).json({
        status: result.status,
        message: result.message,
      });
    } catch (error) {
      console.error("重置 PIN 失败:", error);
      return res.status(500).json({ status: 500, message: "重置失败" });
    }
  }

  /**
   * 设备风险信号上报（安全整改 P2-14，2026-10-08）
   *
   * ## 语义：**纯信号，不拒服务**
   * APP 端在登录后把本地检测到的环境风险（root / 调试器 / 模拟器 / Xposed / Frida）
   * 上报到这里，仅落一条 `security_verify_log`（action_type='risk_signal'）供审计，
   * **不做任何拦截** —— 是否处置由部署者看日志自行决定。
   *
   * ## 防伪造（对齐 P1-15 的教训）
   * 客户端上报的任何字段都可能伪造。本端点因此：
   *  - 只接受**白名单信号名**（见 SIGNAL_NAME_RE），自由文本一概不收；
   *  - 信号数量与每项长度设上限（防灌库）；
   *  - IP 一律服务端采集（req.security.ip → req.ip），不采信 body；
   *  - pin_status 固定写 1 —— 该表 pin_status=0 会被 pinLockGuard 当成
   *    「待验证/锁定」记录参与 PIN 拦截，风险信号绝不能影响那个流程。
   *
   * ## 幂等/降级
   * 失败只告警不阻断（返回 200），上报失败不该影响 APP 正常使用。
   */
  async riskReport(req, res) {
    // 信号名白名单：APP 端 DeviceRiskInspector 的输出全集。
    // 新增检测项时两端同步维护（P2-14：APP/.../security/DeviceRiskInspector.kt）。
    const SIGNAL_NAME_RE = /^[a-z0-9_:-]{1,40}$/;
    const MAX_SIGNALS = 20;

    try {
      const raw = req.body?.data?.signals;

      if (Array.isArray(raw) && raw.length > 0) {
        const signals = raw
          .filter((s) => typeof s === "string" && SIGNAL_NAME_RE.test(s))
          .slice(0, MAX_SIGNALS);

        if (signals.length > 0) {
          const ip =
            req.security?.ip || req.ip || "0.0.0.0";
          const remark = JSON.stringify({
            signals,
            // 与 UserLog 的字段口径一致，便于登录日志关联分析
            ua: String(req.headers["x-user-agent-custom"] || "").slice(0, 160),
            device_model: String(req.headers["x-device-model"] || "").slice(0, 60),
          });

          await db.execute(
            `INSERT INTO security_verify_log
             (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
             VALUES (?, ?, 'risk_signal', 1, 0, ?, NOW())`,
            [req.userId, "/security/risk-report", remark]
          );
          console.log(
            `[risk-signal] user=${req.userId} ip=${ip} signals=[${signals.join(",")}]`
          );
        }
      }

      // 无论内容是否有效都返回成功：这是"尽力而为"的上报，不值得让客户端重试
      return res.say("已接收", 200);
    } catch (error) {
      console.error("风险信号上报异常（不阻断）:", error);
      return res.say("已接收", 200);
    }
  }
}

module.exports = new SecurityController();
