const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc"); // 必须引入 UTC 插件
const timezone = require("dayjs/plugin/timezone"); // 必须引入时区插件
const User = require("../model/user");
const UserLog = require("../model/log");
const CryptoJS = require("crypto-js");
const { sendVerificationEmail } = require("../../../common/utils/mailer");
const db = require("../../../common/config/db");
// 安全整改 P1-9：握手行 aes_key 字段加密（GCM）
const fieldCrypto = require("../../../common/utils/fieldCrypto");
const {
  clearVerifiedSession,
} = require("../../../common/middleware/pinSecurityGuard");
// 安全整改 P0-2/P1-14：登录失败锁定（失败驱动）+ 防用户枚举
const accountLockCheck = require("../../../common/middleware/accountLockCheck");
// 安全整改 P1-15/P1-10：日志字段服务端采集 + 错误详情生产脱敏（公共实现）
const {
  buildServerSideLogFields,
  buildErrorBody,
  maskEmail,
} = require("../../../common/utils/logFields");
// 安全整改 P0-5：认证 Cookie（httpOnly，web 端不再依赖 localStorage）
const {
  setAuthCookie,
  clearAuthCookie,
  resolveTokenTtlSec,
} = require("../../../common/utils/authCookie");
// 核心步骤：注册插件
dayjs.extend(utc);
dayjs.extend(timezone);

// 注：日志字段采集与错误详情脱敏的公共实现见 `src/common/utils/logFields.js`
//     （buildServerSideLogFields / buildErrorBody）。
//     本文件只引用、不再各自维护一份，避免多处实现漂移。
//
//   背景（P1-15）：旧写法 `{ user_id, type, ...clientData }` 把客户端整个 body
//   展开进 UserLog.append。INSERT虽参数化（无注入），但 append 会按固定键名读
//   login_ip / path / fingerprint 等 ⇒ 客户端塞同名键即可**伪造审计日志**。
//   背景（P1-10）：旧写法 `res.json({ message, error: error.message })` 把内部
//   报错细节回给客户端，且因handler 自行 res.json 而永远绕过了 errorHandler。

class AuthController {
  // 用户注册
  async register(req, res) {
    try {
      const { username, email, password } = req.body;

      // 检查用户是否已存在 (通过用户名和邮箱)
      const existingUser = await User.findByUsername(username);
      if (existingUser) {
        return res.status(400).json({ message: "该用户名已被注册" });
      }

      const existingEmail = await User.findByEmail(email);
      if (existingEmail) {
        return res.status(400).json({ message: "该邮箱已被注册" });
      }

      // 加密密码 (使用环境变量配置的 salt rounds)
      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10;
      const password_hash = await bcrypt.hash(password, saltRounds);

      // 创建用户
      const user = await User.create({
        username,
        email,
        password_hash,
        is_locked: 0, // 新注册用户默认解锁
      });

      res.status(200).json({
        message: "注册成功",
        userId: user.id,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      });
    } catch (error) {
      console.error("注册错误:", error);
      res.status(500).json({ ...buildErrorBody("注册失败", error) });
    }
  }

  // 【已启用】
  // 用户登录：增加了对解密后数据的兼容处理
  async login(req, res) {
    // ⚠ 安全整改 P1-15：这里**不再**把 `req.body`（客户端可控）整体当作日志字段，
    //    登录日志一律走 buildServerSideLogFields() 从服务端可信来源采集。

    const { nameOrEmail, password: rawPassword } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）：authSecurityData 对明文请求直接放行，须双路径
    // 安全键盘字符级 RSA 加密：password 为密文字符数组时解密为明文再校验；
    // 兼容旧版：普通字符串直接使用
    const password = require("../../../common/utils/rsaKeys").resolvePassword(
      rawPassword
    );
    try {
      // 1. 基本校验
      if (!nameOrEmail || !password) {
        return res.status(400).json({ message: "请输入账号和密码" });
      }

      // 2. 查找用户
      //    ⚠ `req.checkedUser` 由 accountLockCheck 前置中间件查好并挂上，复用它避免重复查库。
      //    兜底再查一次，以防中间件被摘除或抛错走了 catch 分支。
      const user =
        req.checkedUser ||
        (await User.findByEmail(nameOrEmail)) ||
        (await User.findByUsername(nameOrEmail));

      //    安全整改 P1-14：防用户枚举。
      //    正常路径下中间件已拦截「用户不存在」，这里是对齐用的兜底分支 ——
      //    必须与中间件返回**完全相同**的状态码与文案，且同样计入失败次数。
      if (!user) {
        accountLockCheck.recordLoginFailure(nameOrEmail);
        return res.say(
          accountLockCheck.GENERIC_AUTH_ERROR,
          accountLockCheck.GENERIC_AUTH_STATUS
        );
      }

      // 3. 检查设备锁定状态 (利用中间件挂载的 req.device)
      if (
        req.device &&
        req.device.locked_until &&
        Date.now() < req.device.locked_until
      ) {
        return res
          .status(423)
          .json({ message: "由于尝试次数过多，设备已锁定，请稍后再试" });
      }

      // 4. 验证密码
      const isValid = await User.verifyPassword(password, user.login_pwd);

      if (!isValid) {
        // 🔴 登录失败统计（安全整改 P0-2：失败驱动 + 锁定）
        //    计数发生在「确认密码错误」之后 —— 旧实现在中间件里每收一次请求就 +1，
        //    导致正常用户连点 10 次登录也会被锁 60s，而真正暴破反而不受额外惩罚。
        const failure = accountLockCheck.recordLoginFailure(nameOrEmail);

        //    ✅ P1-15：日志字段全部由服务端采集，客户端 body 不再参与（防日志伪造）
        await UserLog.append({
          ...buildServerSideLogFields(req, user.id),
          type: "failed",
          status: 0,
          error_message: "密码错误",
        });

        // 达到阈值 ⇒ 明确告知锁定时长；
        // 未达阈值时**不提示"还剩几次"（会让攻击者精确定位阈值）
        if (failure.locked) {
          return res.status(423).json({
            status: 423,
            message: `登录失败次数过多，账号已临时锁定 ${Math.ceil(
              failure.remainingMs / 60000
            )} 分钟`,
            locked: true,
          });
        }
        // ⚠ 文案与状态码必须和「用户不存在」分支逐字一致（防枚举 P1-14）
        return res.say(
          accountLockCheck.GENERIC_AUTH_ERROR,
          accountLockCheck.GENERIC_AUTH_STATUS
        );
      }

      // 5. 生成 Token
      const now = Math.floor(Date.now() / 1000); // JWT iat 用秒
      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.identity,
          avatar: user.avatar,
          email: user.email,
          iat: now,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      // 6. 🟢 登录成功统计
      //    ✅ P0-2：登录成功 ⇒ 清零该账号的失败计数
      //       （否则用户输对了密码，额度仍被占用，下次输错一次就又被锁）
      accountLockCheck.clearLoginFailures(nameOrEmail);

      //    ✅ P1-15：改用服务端采集的日志字段，不再展开客户端 body
      await UserLog.append({
        ...buildServerSideLogFields(req, user.id),
        type: "login",
        status: 1,
        token, // UserLog.append 内部只存前 50 字符
      });

      // 🔒 安全整改 P0-5：登录成功同时下发 httpOnly Cookie。
      //    web端凭此不再需要把 token 放进 localStorage ⇒ XSS 窃取无效。
      //    APP / webview-APP 仍走 Authorization 头，不受影响（authGuard 是双通道）。
      //    失败**不能**让登录失败 —— 客户端可退回 Bearer 方式。
      try {
        setAuthCookie(res, token, resolveTokenTtlSec());
      } catch (cookieErr) {
        console.warn(
          "[登录] 下发认证 Cookie 失败（客户端将退回 Bearer 通道）:",
          cookieErr && cookieErr.message
        );
      }

      return res.status(200).json({
        message: "登录成功!",
        token,
        status: 200,
      });
    } catch (error) {
      console.error("登录异常:", error);
      return res.status(500).json({ message: "服务器内部错误" });
    }
  }

  // 【已启用】
  // 获取当前用户信息
  async getCurrentUser(req, res) {
    try {
      const user = await User.findById(req.userId);
      if (!user) return res.say("用户不存在", 404);

      // 邮箱脱敏：前2位 + **** + 后2位 @域名
      const email = user.email || "";
      const atIdx = email.indexOf("@");
      let maskedEmail = email;
      if (atIdx > 3) {
        const local = email.slice(0, atIdx);
        const domain = email.slice(atIdx);
        maskedEmail = local.slice(0, 2) + "***" + local.slice(-2) + domain;
      }

      res.status(200).send({
        status: 200,
        message: "获取用户信息成功",
        data: {
          username: user.username,
          email: maskedEmail,
          avatar: user.avatar,
          identity: user.identity,
        },
      });
    } catch (error) {
      console.error("获取用户信息错误:", error);
      res
        .status(500)
        .json({ ...buildErrorBody("获取用户信息失败", error) });
    }
  }

  // 锁定系统（强制下次登录需要验证PIN）
  async lockSystem(req, res) {
    try {
      const userId = req.userId;
      const db = require("../../../common/config/db");

      // 检查是否已有未解锁的锁定记录（仅匹配 action_type='lock' 且 pin_status=0 的记录）
      const [existing] = await db.execute(
        `SELECT id FROM security_verify_log WHERE user_id = ? AND action_type = 'lock' AND pin_status = 0 LIMIT 1`,
        [userId]
      );

      if (existing && existing.length > 0) {
        return res.status(200).json({
          status: 200,
          message: "系统已经是锁定状态",
        });
      }

      // 插入待验证记录（pin_status=0 表示待验证）
      await db.execute(
        `INSERT INTO security_verify_log (user_id, request_url, action_type, pin_status, error_count, remark, create_time)
         VALUES (?, ?, ?, 0, 0, ?, NOW())`,
        [userId, '/lock-system', 'lock', '系统锁定']
      );

      // 关键：清掉内存里的 30 秒放行会话，否则锁定后仍会命中放行窗口直接返回真实数据
      clearVerifiedSession(userId);

      res.status(200).json({
        code: 8303,
        status: 200,
        message: "系统已锁定，下次登录需验证PIN",
        locked: true,
      });
    } catch (error) {
      console.error("锁定系统错误:", error);
      res.status(500).json({ ...buildErrorBody("锁定失败", error) });
    }
  }

  // 获取当前用户登录日志（最近30条）
  async getLoginLogs(req, res) {
    try {
      const userId = req.userId;
      const db = require("../../../common/config/db");

      const [rows] = await db.execute(
        `SELECT id, type, login_ip, login_location, login_isp, user_agent, os_info, browser_info, device_model, status, error_message, login_time, create_time
         FROM user_log
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 30`,
        [userId]
      );

      res.status(200).json({
        status: 200,
        data: rows,
      });
    } catch (error) {
      console.error("获取登录日志错误:", error);
      res.status(500).json({ ...buildErrorBody("获取登录日志失败", error) });
    }
  }

  // 刷新 Token（支持吊销 + 同设备续期）
  async refreshToken(req, res) {
    try {
      // 🔄 2026-10-13 修复（api.md F-A）：双路径兼容。
      //    加密客户端（APP/webview-APP）解密后业务体在 req.body.data.token，
      //    明文客户端（web 修复后走 skipEncryptionUrls）在 req.body.token。
      //    原实现只读 req.body.token ⇒ 加密端恒 400「Token 不能为空」。
      const { token } = req.body.data || req.body;

      if (!token) {
        return res.status(400).json({ message: "Token 不能为空" });
      }

      // 1. 验证旧 Token 签名 + 有效期
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          // Token 已过期，但允许在过期后 7 天内刷新（宽限期）
          try {
            decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
            const expiredAt = decoded.exp * 1000;
            const gracePeriod = 7 * 24 * 60 * 60 * 1000; // 7 天宽限
            if (Date.now() - expiredAt > gracePeriod) {
              return res.status(401).json({ message: "令牌已失效，请重新登录" });
            }
          } catch {
            return res.status(401).json({ message: "无效的认证令牌" });
          }
        } else {
          return res.status(401).json({ message: "无效的认证令牌" });
        }
      }

      // 2. 查询用户（带密码变更时间）
      let user;
      try {
        const [users] = await db.execute(
          'SELECT id, username, email, avatar, identity, status, password_changed_at FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1',
          [decoded.userId]
        );
        user = users[0];
      } catch {
        // password_changed_at 字段可能尚未迁移，回退到基础查询
        const [users] = await db.execute(
          'SELECT id, username, email, avatar, identity, status FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1',
          [decoded.userId]
        );
        user = users[0];
      }
      if (!user) {
        return res.status(404).json({ message: "用户不存在" });
      }

      // 3. 账户锁定检查
      if (Number(user.status) === 0) {
        return res.status(403).json({ message: "账户已被锁定" });
      }

      // 4. 密码变更吊销：token.iat 早于密码变更时间 → 拒绝刷新
      const pwdChangedAt = user?.password_changed_at;
      if (pwdChangedAt && decoded.iat) {
        const iatMs = decoded.iat * 1000; // iat 是秒，转为毫秒
        if (iatMs < pwdChangedAt) {
          return res.status(401).json({ message: "密码已变更，请重新登录" });
        }
      }

      // 5. N 月强制重登：从 token.iat 算起，超过 N 个月必须重新登录
      const maxSessionDays = parseInt(process.env.TOKEN_MAX_SESSION_DAYS) || 90; // 默认 90 天
      if (decoded.iat) {
        const iatMs = decoded.iat * 1000;
        const maxSessionMs = maxSessionDays * 24 * 60 * 60 * 1000;
        if (Date.now() - iatMs > maxSessionMs) {
          return res.status(401).json({
            message: `会话已超过 ${maxSessionDays} 天，请重新登录`,
            code: 'SESSION_EXPIRED',
          });
        }
      }

      // 6. 生成新 Token（保留原始 iat 用于会话期限计算）
      const originalIat = decoded.iat || Math.floor(Date.now() / 1000);
      const newToken = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.identity,
          avatar: user.avatar,
          email: user.email,
          iat: originalIat,
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      // 🔒 P0-5：续期成功同样刷新 Cookie（否则 Cookie 会按旧 maxAge 提前过期）
      try {
        setAuthCookie(res, newToken, resolveTokenTtlSec());
      } catch (cookieErr) {
        console.warn(
          "[刷新Token] 刷新认证 Cookie 失败（客户端将退回 Bearer 通道）:",
          cookieErr && cookieErr.message
        );
      }

      res.json({
        message: "Token 刷新成功",
        token: newToken,
      });
    } catch (error) {
      console.error("刷新 Token 错误:", error);
      res.status(401).json({ ...buildErrorBody("Token 无效或已过期", error) });
    }
  }

  /**
   * 【已启用】登出（安全整改 P1-17，2026-10-08）
   *
   * ## 作用
   * 1. **清除认证 Cookie** —— 这是主要效果：浏览器不再携带 ⇒ 令牌立即不可用。
   * 2. 记一条登出日志，便于审计「谁在什么时候登出」。
   *
   * ## 关于「服务端吊销」（P1-8 剩余部分）
   * 本阶段**不引入 jti 吊销表**：那需要新建表 + 数据迁移，与「不过度设计」冲突，
   * 且在 httpOnly Cookie 方案下，清Cookie 已能让令牌**立即失效**（浏览器不再发送）。
   * 残留风险：令牌若在登出前已被窃取，攻击者仍可用到过期 —— 登记为 R-10。
   *
   * ⚠ 接口**不需要** authGuard：即便令牌已失效也要能登出（幂等）。
   */
  async logout(req, res) {
    try {
      // 尽力解析用户（可能因令牌过期/缺失而拿不到，属正常）
      let userId = req.userId;
      if (!userId) {
        const raw =
          (req.headers.authorization || "").startsWith("Bearer ") &&
          req.headers.authorization.slice(7).trim();
        const cookieToken =
          (req.cookies && req.cookies[require("../../../common/utils/authCookie").TOKEN_COOKIE_NAME]) || raw;
        if (cookieToken) {
          try {
            userId = jwt.verify(cookieToken, process.env.JWT_SECRET).userId;
          } catch {
            /* 令牌本就无效，忽略 */
          }
        }
      }

      clearAuthCookie(res);

      if (userId) {
        await UserLog.append({
          ...buildServerSideLogFields(req, userId),
          type: "logout",
          status: 1,
        });
      }

      return res.json({ status: 200, message: "已退出登录" });
    } catch (error) {
      // 登出失败也要清 Cookie，别把用户卡在登录态
      try {
        clearAuthCookie(res);
      } catch {
        /* ignore */
      }
      console.error("登出处理异常:", error);
      return res.json({ status: 200, message: "已退出登录" });
    }
  }

  // 【已启用】
  // 更新用户资料
  async updateProfile(req, res) {
    // 1. 安全地获取业务数据
    // 使用可选链 ?. 或解构并给默认值，防止 undefined 报错
    const { username, avatar } = req.body.data || {};
    // 构造一个只包含“用户传了的内容”的对象
    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (Object.keys(updateData).length === 0) {
      return res.say("没有提供要更新的内容", 400); // 🟢 记得 return
    }
    // 2. 调用 Model，传入 req 用于记录日志
    const updatedUser = await User.update(req.userId, updateData, req);
    if (updatedUser.status === 200) {
      // 3. 成功返回
      return res.status(200).json({
        status: 200,
        message: "资料更新成功",
        data: {
          user: {
            username: updatedUser.user.username,
            email: updatedUser.user.email,
            avatar: updatedUser.user.avatar,
          },
        },
      });
    } else return res.say(updatedUser.message, 400);
  }

  // 【已启用】
  // 检查是否已有管理员
  async checkAdmin(req, res) {
    try {
      const count = await User.count();
      const hasAdmin = count > 0;
      res.status(200).send({
        status: 200,
        message: hasAdmin ? "系统已初始化" : "系统未初始化",
        data: {
          hasAdmin,
          count,
        },
      });
    } catch (error) {
      console.error("检查管理员状态错误:", error);
      res.status(500).json({
        ...buildErrorBody("检查管理员状态失败", error),
      });
    }
  }

  // 【已启用】
  // 管理员首次注册
  async adminRegister(req, res) {
    try {
      const { username, email, password } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      // 检查是否已有用户
      const count = await User.count();
      if (count > 0) {
        return res.status(403).json({
          message: "系统已存在用户,无法注册管理员",
        });
      }
      // 检查用户名是否已存在
      const existingUser = await User.findByUsername(username);
      if (existingUser) {
        return res.status(400).json({ message: "该用户名已被注册" });
      }
      // 检查邮箱是否已存在
      const existingEmail = await User.findByEmail(email);
      if (existingEmail) {
        return res.status(400).json({ message: "该邮箱已被注册" });
      }
      // 密码强度统一校验（与前端/登录规则一致：6-30位 + 大小写数字特殊字符）
      const PWD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>])[^]{6,30}$/;
      if (!PWD_PATTERN.test(password || "")) {
        return res.status(400).json({ message: "密码必须包含大小写字母、数字和特殊字符，且长度为6-30位" });
      }
      // 加密密码 (使用环境变量配置的 salt rounds)
      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10;
      const password_hash = await bcrypt.hash(password, saltRounds);

      // 创建管理员用户
      const user = await User.create({
        username,
        email,
        login_pwd: password_hash,
        identity: count <= 1 ? "admin" : "user",
      });

      res.status(200).send({
        message: "注册成功！",
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      });
    } catch (error) {
      console.log(error);
      res.status(500).send({
        ...buildErrorBody("管理员注册失败", error),
        status: 500,
      });
    }
  }

  // 【已启用】
  // 获取加密密钥 (已修正 ERR_HTTP_HEADERS_SENT 问题)
  async getHandshake(req, res) {
    try {
      const { fp, scene = "login" } = req.query;
      if (!fp) return res.say("非法设备标识", 400);

      const tempKey = CryptoJS.lib.WordArray.random(32).toString();
      // 有效期2小时
      const aesExpires = Date.now() + 2 * 60 * 60 * 1000;
      const now = Date.now();

      // 🔒 安全整改 P1-9（2026-10-08）：aes_key **加密后落库**（AES-256-GCM）。
      //    原来明文存 device_crypto ⇒ 数据库 dump 可离线解密对应设备的全部请求体。
      //    返回给客户端的仍是明文 tempKey（传输层保护 = R-1 已接受的风险）。
      //    ⚠ 只加密「握手行」；邮件验证码行（fingerprint=email_verify_*）的
      //      aes_key 存的是 userId 且被 WHERE 精确匹配，保持明文 —— 见 fieldCrypto.js 头注释。
      const storedKey = fieldCrypto.encryptField(tempKey);

      const sql = `
        INSERT INTO device_crypto (
          fingerprint, scene, aes_key, aes_expires_at,
          client_ip, user_agent, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          aes_key = VALUES(aes_key),
          aes_expires_at = VALUES(aes_expires_at),
          client_ip = VALUES(client_ip),
          updated_at = VALUES(updated_at),
          captcha_verified = 0,
          fail_count = 0
      `;

      await db.execute(sql, [
        fp,
        scene,
        storedKey,
        aesExpires,
        req.ip,
        req.headers["user-agent"],
        now,
        now,
      ]);

      // 这里必须 return，确保响应只发送一次
      const rsaPublicKey = require("../../../common/utils/rsaKeys").getPublicKey();
      return res.json({ status: 200, key: tempKey, scene, rsaPublicKey });
    } catch (error) {
      console.error("安全握手异常:", error);
      // 增加防御性判断
      if (!res.headersSent) {
        return res.say("初始化失败", 500);
      }
    }
  }

  // 【已启用】
  // 发送邮箱验证码
  async sendEmailCode(req, res) {
    try {
      const { email: newEmail, type = "email" } = req.body.data || {};
      // 🔒 2026-10-12 修复（api.md P1-1）：userId 一律取服务端鉴权身份。
      //    原实现 `req.body.userId || req.userId` 允许客户端在 body 塞 userId
      //    覆盖身份（可向任意用户写验证码记录，配合 changeEmail 越权改绑）。
      const userId = req.userId;

      if (!userId) return res.say("用户ID不能为空", 400);

      // 确定发送目标邮箱
      let email;
      if (type === "pwd") {
        // 修改密码场景：从 DB 查用户绑定的邮箱，不信任前端传入
        const [rows] = await db.execute(
          "SELECT email FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1",
          [userId]
        );
        email = rows[0]?.email;
        if (!email) return res.say("您的账号未绑定邮箱，无法发送验证码", 400);
      } else {
        // 修改邮箱场景：使用前端传入的新邮箱
        email = newEmail;
        if (!email) return res.say("邮箱不能为空", 400);
        // 基本格式校验
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return res.say("邮箱格式不正确", 400);
        }
      }

      const now = Date.now();
      // type: "email" → fingerprint = "email_verify_email"
      // type: "pwd" → fingerprint = "email_verify_pwd"
      const fingerprint = `email_verify_${type}`;
      const scene = email; // scene 存储用户邮箱
      const aes_key = userId; // aes_key 存储用户ID，用于身份识别

      // 生成6位验证码
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = now + 10 * 60 * 1000; // 10分钟有效期

      // 计算今天0点的时间戳
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartTimestamp = todayStart.getTime();

      // 查询现有记录（通过 fingerprint + scene + aes_key 三个条件查询）
      const selectSql = `
        SELECT * FROM device_crypto
        WHERE fingerprint = ? AND scene = ? AND aes_key = ?
      `;
      const [rows] = await db.execute(selectSql, [fingerprint, scene, aes_key]);

      let insertOrUpdateSql;
      let params;
      // 如果有就校验有效时间
      if (rows && rows.length > 0) {
        const record = rows[0];
        const recordDate = new Date(record.created_at);
        const todayDate = new Date(todayStartTimestamp);

        // 检查记录的创建日期是否是今天
        const isToday =
          recordDate.getFullYear() === todayDate.getFullYear() &&
          recordDate.getMonth() === todayDate.getMonth() &&
          recordDate.getDate() === todayDate.getDate();
        // 超过 N 次不让发了（与 emailCodeRateLimit 中间件的 >=5 口径统一）
        if (isToday && Number(record.captcha_attempts) >= 5) {
          console.log("发送次数上限！");
          return res.say("今日获取验证码次数上限，次日再试！", 400);
        }
        // 增加发送次数
        const newAttempts = isToday ? (record.captcha_attempts || 0) + 1 : 1;
        // 如果不是今天，同步创建时间为今日；如果是今天，保持原创建时间
        const created_at = isToday ? record.created_at : now;
        // 更新现有记录
        // 🔒 2026-10-12 修复（api.md P1-2）：UPDATE 补 `AND scene = ?`。
        //    原实现只按 (fingerprint, aes_key) 更新 ⇒ 同一用户改过多个邮箱时
        //    一次发送把该用户全部历史验证码记录覆盖（新旧邮箱验证码串扰）。
        insertOrUpdateSql = `
          UPDATE device_crypto
          SET captcha_code = ?, captcha_expires_at = ?, captcha_verified = 0,
              captcha_attempts = ?, updated_at = ?, created_at = ?
          WHERE fingerprint = ? AND scene = ? AND aes_key = ?
        `;
        params = [
          code,
          expiresAt,
          newAttempts,
          now,
          created_at,
          fingerprint,
          scene,
          aes_key,
        ];
        console.log(
          `存在字段 -- 发送次数: ${newAttempts}, 是否今日: ${isToday}`
        );
      } else {
        // 第一次发送验证码
        // 插入新记录
        insertOrUpdateSql = `
          INSERT INTO device_crypto (
            fingerprint, scene, aes_key, captcha_code, captcha_expires_at,
            captcha_attempts, captcha_verified, client_ip, user_agent, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
        `;
        params = [
          fingerprint,
          scene,
          aes_key,
          code,
          expiresAt,
          req.ip,
          req.headers["user-agent"],
          now,
          now,
        ];
      }
      const dat = await db.execute(insertOrUpdateSql, params);
      if (dat[0].affectedRows === 0) return res.say("验证码发送错误", 500);

      // 发送邮件
      try {
        await sendVerificationEmail(email, code);
        // 🔒 安全整改 P1-10：**不打印验证码明文**。
        //    日志（含容器 stdout、logrotate 归档、CI 输出）常被运维与第三方接触，
        //    一旦明文出现，邮箱验证码即可被直接用来改绑/改密。
        //    需要排查发送失败时用 userId + type + 过期时间定位即可。
        console.log(
          `[发送验证码] 用户ID: ${userId}, 邮箱: ${maskEmail(email)}, 类型: ${type}, 过期时间: ${new Date(expiresAt)}`
        );
      } catch (emailError) {
        console.error(`[发送验证码] 邮件发送失败: ${emailError.message}, 但验证码已保存到数据库`);
      }

      return res.status(200).send({
        status: 200,
        message: "验证码已发送",
        data: {
          code: process.env.NODE_ENV === "development" ? code : undefined,
        },
      });
    } catch (error) {
      console.error("发送验证码错误:", error);
      return res.say("发送验证码失败，请稍后再试", 400);
    }
  }

  // 修改邮箱（需要验证码）
  async changeEmail(req, res) {
    try {
      const { email, code } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      // 🔒 2026-10-12 修复（api.md P1-1）：userId 取服务端鉴权身份。
      const userId = req.userId; // 对应你数据库里的 aes_key 字段

      // 1. 严格纠正拼写和对应关系
      const fingerprint = `email_verify_email`;
      const scene = email;
      const id = userId; // 对应你数据库里的 aes_key 字段

      // 🔒 安全整改 P1-10：scene 是邮箱，属PII，日志里做脱敏
      console.log(
        `[准备查询] fingerprint: ${fingerprint}, scene: ${maskEmail(
          scene
        )}, aes_key: ${id}`
      );

      // 🔒 2026-10-12 修复（api.md P1-2）：SELECT 补 `AND scene = ?`。
      //    原实现只按 (fingerprint, aes_key) 查 ⇒ 用户有多个邮箱的验证码记录时
      //    rows[0] 无序取到旧邮箱记录，新邮箱的验证码永远「验证码错误」
      //    （2026-10-12 修前基线实测复现：S5 changeEmail 报「验证码错误」）。
      const sql = `
        SELECT * FROM device_crypto 
        WHERE fingerprint = ? AND scene = ? AND aes_key = ?`;

      // 这里的参数顺序必须和 SQL 里的 ? 一一对应
      const [rows] = await db.execute(sql, [fingerprint, scene, id]);
      console.log(`[数据库查询结果] 找到 ${rows ? rows.length : 0} 条记录`);
      if (!rows || rows.length === 0) {
        console.log(`[验证码校验失败] 验证码不存在`);
        return res.say("验证码不存在或已过期", 400);
      }
      const record = rows[0];
      const now = Date.now();
      const expiresAt = record.captcha_expires_at;
      // 🔒 安全整改 P1-10：不打印验证码明文（存储值/输入值都不打）
      console.log(
        `[验证码信息] 过期时间: ${new Date(expiresAt)}, 当前时间: ${new Date(
          now
        )}, 剩余时间: ${Math.floor((expiresAt - now) / 1000)}秒`
      );

      // 验证验证码
      if (record.captcha_code !== code) {
        console.log(`[验证码校验失败] 验证码不匹配（输入与存储值均不打印）`);
        // 增加失败次数（不增加 captcha_attempts，因为那是发送次数）
        await db.execute(
          `UPDATE device_crypto
           SET fail_count = fail_count + 1, updated_at = ?
           WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
          [now, fingerprint, scene, id]
        );
        return res.say("验证码错误", 400);
      }

      // 检查验证码是否过期
      if (now > expiresAt) {
        console.log(`[验证码校验失败] 验证码已过期`);
        return res.say("验证码已过期", 400);
      }

      if (record.captcha_verified && Number(record.captcha_verified) === 1) {
        console.log("已验证过");
        return res.say("验证码已验证过，请重试！", 400);
      }

      // 验证成功，增加使用次数（captcha_attempts 既用于统计发送次数，也用于统计使用次数）
      const newAttempts = (record.captcha_attempts || 0) + 1;

      // 检查邮箱是否已被使用
      const existingEmail = await User.findByEmail(email);
      if (existingEmail && existingEmail.id !== userId) {
        console.log(`[邮箱检查失败] 邮箱已被使用`);
        return res.say("该邮箱已被使用", 400);
      }

      // 更新邮箱
      const user = await User.update(userId, { email });

      // 更新使用次数并标记已验证
      await db.execute(
        `UPDATE device_crypto
         SET captcha_attempts = ?, captcha_verified = 1, updated_at = ?
         WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
        [newAttempts, now, fingerprint, scene, id]
      );

      console.log(
        // 🔒 P1-10（复审补漏）：邮箱是 PII，日志打码
        `[修改邮箱成功] 用户 ${userId} 邮箱已修改为 ${maskEmail(email)}, 验证码使用次数: ${newAttempts}`
      );

      res.status(200).send({
        message: "邮箱修改成功",
        status: 200,
        data: {
          user: {
            username: user.user.username,
            email: user.user.email,
            avatar: user.user.avatar,
          },
        },
      });
    } catch (error) {
      console.error("修改邮箱错误:", error);
      return res.say("修改邮箱失败", 500);
    }
  }

  // 【已启用】
  // 修改密码（校验：旧密码 + 新密码 + 验证码）
  async changePasswordWithCode(req, res) {
    try {
      const { oldPassword, newPassword, code } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      const userId = req.userId;
      const id = userId;

      // 内部专用：带密码查询
      const findForAuth = async (targetId) => {
        const [rows] = await db.execute(
          `SELECT id, username, email, avatar, login_pwd FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1`,
          [targetId]
        );
        return rows[0];
      };

      // 1. 获取用户信息
      const userRecord = await findForAuth(userId);
      if (!userRecord) return res.say("用户不存在", 404);

      // 2. 校验：新旧密码不能一样
      if (oldPassword === newPassword) {
        return res.say("新密码不能与原密码相同", 400);
      }

      // 3. 校验：原密码是否正确
      const isOldPasswordCorrect = await bcrypt.compare(
        oldPassword,
        userRecord.login_pwd || "" // 防止数据库字段为 NULL 导致报错
      );

      if (!isOldPasswordCorrect) {
        return res.say("原密码输入错误", 400);
      }

      // 4. 校验：验证码
      const fingerprint = `email_verify_pwd`;
      const scene = userRecord.email;
      const [vRows] = await db.execute(
        `SELECT * FROM device_crypto WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
        [fingerprint, scene, id]
      );

      if (!vRows || vRows.length === 0)
        return res.say("验证码不存在或已过期", 400);

      const record = vRows[0];
      const now = Date.now();

      if (now > record.captcha_expires_at) return res.say("验证码已过期", 400);
      if (record.captcha_verified === 1) return res.say("验证码已被使用", 400);
      if (record.captcha_code !== code) {
        await db.execute(
          `UPDATE device_crypto SET fail_count = fail_count + 1, updated_at = ? 
           WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
          [now, fingerprint, scene, id]
        );
        return res.say("验证码错误", 400);
      }

      // 5. 【关键重写】执行更新：直接用原生 SQL 更新 login_pwd
      const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10;
      const hashedPwd = await bcrypt.hash(newPassword, saltRounds);

      const updateTime = new Date()
        .toISOString()
        .replace("T", " ")
        .substring(0, 19); // 格式化为 2026-04-01 21:12:41

      // 🔴 不再使用 User.update，直接操作数据库
      const passwordChangedAt = Date.now(); // 毫秒时间戳
      let updateResult;
      try {
        [updateResult] = await db.execute(
          `UPDATE user_info SET login_pwd = ?, update_time = ?, password_changed_at = ? WHERE id = ? AND is_deleted = 0`,
          [hashedPwd, updateTime, passwordChangedAt, userId]
        );
      } catch {
        // password_changed_at 字段可能尚未迁移，回退不含该字段
        [updateResult] = await db.execute(
          `UPDATE user_info SET login_pwd = ?, update_time = ? WHERE id = ? AND is_deleted = 0`,
          [hashedPwd, updateTime, userId]
        );
      }

      if (updateResult.affectedRows === 0) {
        throw new Error("数据库更新失败，受影响行数为 0");
      }

      // 6. 核销验证码
      await db.execute(
        `UPDATE device_crypto SET captcha_verified = 1, updated_at = ?
         WHERE fingerprint = ? AND scene = ? AND aes_key = ?`,
        [now, fingerprint, scene, id]
      );

      // 注：原文是「密码已硬写入数据库」，容易让人误以为日志里应出现密码 ——
      // 实际这行只是操作完成提示（不含任何密码/验证码内容），保留但去掉误导性措辞。
      console.log(`[成功] 用户 ${userId} 密码重置流程已执行完毕`);

      return res.status(200).send({
        status: 200,
        message: "密码修改成功，请重新登录",
      });
    } catch (error) {
      console.error("修改密码错误:", error);
      return res.say("服务器错误，修改失败", 500);
    }
  }
}

module.exports = new AuthController();
