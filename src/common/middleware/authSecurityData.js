const CryptoJS = require("crypto-js");
const db = require("../config/db");
// 安全整改 P1-9：握手行 aes_key 加密存储（GCM）—— 读取时解密 + 惰性迁移
const fieldCrypto = require("../utils/fieldCrypto");

/**
 * 安全解密中间件
 * 处理逻辑：验证指纹 -> 检查有效期 -> 执行 AES 解密 -> 挂载上下文
 */
const decryptWithSecurity = async (req, res, next) => {
  // 小程序跳过设备验证
  // if (req.xcxBypass) {
  //   console.log('小程序路过');
  //    return next();
  // }

  const fp = req.headers["x-fp-id"];
  const scene = req.headers["x-scene"] || "login";
  const payload = req.body?._p;

  // 非加密请求直接放行
  if (!fp || !payload) return next();

  try {
    // 1. 获取设备加密元数据
    const [rows] = await db.execute(
      "SELECT * FROM device_crypto WHERE fingerprint = ? AND scene = ? LIMIT 1",
      [fp, scene]
    );

    if (rows.length === 0) {
      return res.say("安全隧道未建立", 401);
    }
    const device = rows[0];

    // 2. 检查锁定状态
    if (
      device.locked_until &&
      Date.now() < new Date(device.locked_until).getTime()
    ) {
      return res.say("设备环境异常，请稍后再试", 423);
    }

    // 3. 执行 AES 解密 (CBC 模式，Key 使用 Hex.parse)
    //    🔒 P1-9：库里存的是 GCM 密文（enc.v1:...），先解密出真 key；
    //    存量明文行（升级前落库的）由 decryptField 原样透传，并在下方惰性迁移。
    const keyHex = CryptoJS.enc.Hex.parse(fieldCrypto.decryptField(device.aes_key));
    const ivHex = CryptoJS.enc.Hex.parse(payload.substring(0, 32));
    const cipherText = payload.substring(32);

    const decrypted = CryptoJS.AES.decrypt(cipherText, keyHex, {
      iv: ivHex,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });

    const decryptedStr = decrypted.toString(CryptoJS.enc.Utf8);

    if (!decryptedStr) {
      throw new Error("MALFORMED_UTF8");
    }

    // 4. 挂载数据
    try {
      req.body = JSON.parse(decryptedStr);      
    } catch (e) {
      throw new Error("INVALID_JSON");
    }

    req.device = device;

    // 🔒 P1-9 惰性迁移：存量明文握手行 ⇒ 顺手加密回写（一次请求最多一次）。
    //    失败不影响本次请求（下次再试）；邮件行（fingerprint=email_verify_*，
    //    aes_key 存 userId 且被 WHERE 精确匹配）绝不迁移。
    if (
      fieldCrypto.needsReencrypt(device.aes_key) &&
      !String(device.fingerprint || "").startsWith("email_verify")
    ) {
      db.execute(
        "UPDATE device_crypto SET aes_key = ? WHERE fingerprint = ? AND scene = ?",
        [fieldCrypto.encryptField(device.aes_key), device.fingerprint, device.scene]
      ).catch((e) =>
        console.warn("[fieldCrypto] 惰性迁移失败（不阻断）:", e && e.message)
      );
    }
    next();
  } catch (error) {
    console.error(`[Security Decrypt Error]: ${error.message}`);

    // 🔄 复审修复（2026-10-08）：失败计数写入自身也要兜底 —— 原先无 try，
    //   DB 故障时这条 UPDATE 再抛错，async rejection 在 Express 4 里无兜底 ⇒ 请求悬挂。
    try {
      await db.execute(
        "UPDATE device_crypto SET fail_count = fail_count + 1 WHERE fingerprint = ?",
        [fp]
      );
    } catch (dbErr) {
      console.error("[Security Decrypt] fail_count 写入失败:", dbErr && dbErr.message);
    }

    const errorMsg =
      error.message === "MALFORMED_UTF8"
        ? "安全校验未通过(KEY_ERR)"
        : "请求数据非法";
    return res.say(errorMsg, 400);
  }
};

module.exports = decryptWithSecurity;
