const crypto = require("crypto");
const { resolveSecret } = require("./secretGuard");

/**
 * 字段级加密（安全整改 P1-9，2026-10-08）
 *
 * ## 背景
 * 握手接口把设备级 AES 密钥（64 hex）**明文**写进 `device_crypto.aes_key`。
 * 任何拿到数据库 dump 的人（备份泄露 / SQL 注入 / 内部人员）都能拿这些密钥
 * 离线解密对应设备的**全部请求体**（流水、账单等财务数据）。
 *
 * ## 方案（Q2 允许字段加密 / Q9 确认只加密这一个字段）
 * AES-256-GCM 加密后落库，格式：
 *   `enc.v1:<ivB64url>.<ciphertextB64url>.<tagB64url>`
 *
 * ## ⚠ 适用范围：仅「握手行」—— 不要把邮件验证码行也加密！
 * `device_crypto.aes_key` 是**双用途字段**：
 *   - 握手行（fingerprint=真实设备指纹）：存密钥 → 本模块加密
 *   - 邮件行（fingerprint=`email_verify_*`）：存的是 **userId**（auth/controller
 *     `sendEmailCode`：`const aes_key = userId`），且被 `WHERE aes_key = ?`
 *     精确匹配（emailCodeRateLimit / verifyEmailCode 等 6+ 处查询）。
 *     GCM 是随机 IV 加密，同一明文两次加密结果不同 ⇒ 加密后 WHERE 匹配必然失败。
 *     userId 本身不是秘密，保持明文是**正确**行为，不是遗漏。
 */

/** 密文前缀（带版本号，将来换算法/密钥可平滑迁移） */
const PREFIX = "enc.v1:";

/**
 * 字段加密密钥。
 * - 显式配置 `FIELD_ENCRYPT_KEY`（建议 32 字节 hex，openssl rand -hex 32）
 * - 未配置时从 SHARE_TOKEN_SECRET（回退 JWT_SECRET）派生 —— 与 shareToken.js
 *   同一取钥路径，**不新增强制 env**，现有部署零迁移成本。
 *   （教训对齐 SYNC-009：把新密钥塞进 auditSecrets 会造成生产误杀拒启。）
 */
const KEY = (() => {
  const explicit = process.env.FIELD_ENCRYPT_KEY;
  const source =
    explicit && explicit.length >= 32
      ? explicit
      : resolveSecret("SHARE_TOKEN_SECRET", { fallbackTo: "JWT_SECRET" });
  return crypto.createHash("sha256").update(String(source)).digest();
})();

/** 值是否已加密 */
function isEncrypted(stored) {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

/**
 * 加密一个字段值
 * @param {string} plaintext
 * @returns {string} enc.v1:iv.ct.tag
 */
function encryptField(plaintext) {
  if (plaintext == null) throw new Error("FIELD_ENCRYPT_EMPTY");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const b64 = (b) => b.toString("base64url");
  return `${PREFIX}${b64(iv)}.${b64(ct)}.${b64(tag)}`;
}

/**
 * 解密一个字段值。
 * 未加密（存量明文 / 邮件行的 userId）⇒ 原样返回，绝不抛错 ——
 * 这样存量数据在迁移完成前也能正常工作。
 * @param {string} stored
 * @returns {string} 明文
 * @throws 篡改 / 密钥不符（GCM tag 校验失败）
 */
function decryptField(stored) {
  if (!isEncrypted(stored)) return String(stored ?? "");

  const raw = stored.slice(PREFIX.length);
  const parts = raw.split(".");
  if (parts.length !== 3) throw new Error("FIELD_MALFORMED");

  const [ivB64, ctB64, tagB64] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    KEY,
    Buffer.from(ivB64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

/**
 * 待迁移判定：值存在且未加密（存量明文握手行）
 */
function needsReencrypt(stored) {
  return typeof stored === "string" && stored.length > 0 && !isEncrypted(stored);
}

module.exports = { PREFIX, isEncrypted, encryptField, decryptField, needsReencrypt };
