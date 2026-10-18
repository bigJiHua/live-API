/**
 * RSA 密钥管理（安全键盘字符级加密专用）
 *
 * - 优先从磁盘加载持久化密钥（默认 api/data/rsa-keys.json，可用 RSA_KEY_FILE 覆盖）
 * - 没有/损坏时才生成 2048 位密钥对，并写回磁盘（权限 0600）
 * - 私钥仅存服务端，公钥通过握手接口下发给客户端
 *
 * ## 为什么必须持久化（2026-10-17）
 * 历史实现是「进程内存级」密钥对：API 每重启一次，公钥就变。
 * 而客户端（尤其 APP 的 HandshakeManager）会在 AES key 有效期内缓存
 * rsaPublicKey（最长 2h），重启后仍用旧公钥加密密码 ⇒ 服务端解不出 ⇒ 登录失败。
 * 持久化后重启不再换钥，客户端缓存自然一直有效。
 *
 * ## 多实例部署
 * 多个进程必须指向同一个 RSA_KEY_FILE（共享卷 / 同一文件），
 * 否则各自生成不同密钥，请求负载均衡到不同实例会随机失败。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let privateKey = null;
let publicKey = null;
let initialized = false;

/** 默认 api/data/rsa-keys.json；可用环境变量覆盖（多实例共享同一路径） */
const KEY_FILE =
  process.env.RSA_KEY_FILE ||
  path.resolve(__dirname, "../../../data/rsa-keys.json");

/** 读取并校验磁盘上的密钥对；文件不存在/损坏返回 null。 */
function loadKeysFromDisk() {
  try {
    if (!fs.existsSync(KEY_FILE)) return null;
    const raw = fs.readFileSync(KEY_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || !obj.privateKey || !obj.publicKey) return null;
    // 校验密钥格式（非法会抛错）
    crypto.createPrivateKey(obj.privateKey);
    crypto.createPublicKey(obj.publicKey);
    return { privateKey: obj.privateKey, publicKey: obj.publicKey };
  } catch (e) {
    console.warn("[rsaKeys] 读取持久化密钥失败，将重新生成:", e && e.message);
    return null;
  }
}

/**
 * 写入磁盘。
 * - 文件不存在：用 wx（并发时只有一个能成功，另一个回读）
 * - 文件存在但内容损坏：用 w 覆盖修复
 * @returns {null|{privateKey:string,publicKey:string}} null=已写入或失败；非 null=并发时读到的赢家
 */
function saveKeysToDisk(priv, pub) {
  const data = JSON.stringify(
    { privateKey: priv, publicKey: pub, createdAt: new Date().toISOString() },
    null,
    2
  );
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    const exists = fs.existsSync(KEY_FILE);
    fs.writeFileSync(KEY_FILE, data, {
      mode: 0o600,
      flag: exists ? "w" : "wx",
    });
    console.log(`[rsaKeys] 已持久化 RSA 密钥对: ${KEY_FILE}`);
    return null;
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // 并发启动：另一个进程先写了，改为加载它的
      return loadKeysFromDisk();
    }
    console.warn(
      `[rsaKeys] 持久化失败（本次仍使用内存密钥，重启会变化）: ${e && e.message}`
    );
    return null;
  }
}

/** 生成（或复用）密钥对，返回 publicKey */
function ensureKeys() {
  if (initialized) return publicKey;

  // 1) 优先加载磁盘持久化密钥
  const saved = loadKeysFromDisk();
  if (saved) {
    privateKey = saved.privateKey;
    publicKey = saved.publicKey;
    initialized = true;
    return publicKey;
  }

  // 2) 生成新密钥对并尝试落盘
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync(
    "rsa",
    {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }
  );

  const raced = saveKeysToDisk(priv, pub);
  if (raced) {
    privateKey = raced.privateKey;
    publicKey = raced.publicKey;
  } else {
    privateKey = priv;
    publicKey = pub;
  }
  initialized = true;
  return publicKey;
}

/** 获取 PEM 公钥（供握手接口下发） */
function getPublicKey() {
  return ensureKeys();
}

/**
 * 解密 RSA 字符数组，拼接为明文
 * @param {Array<string>} chars - JSEncrypt 逐字符加密后的密文数组
 * @returns {string} 拼接明文
 */
function decryptChars(chars) {
  if (!Array.isArray(chars) || chars.length === 0) return "";
  ensureKeys();
  const dec = crypto.privateDecrypt;
  const joined = chars
    .map((c) => {
      try {
        return dec(
          { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(c, "base64")
        ).toString("utf8");
      } catch {
        return "";
      }
    })
    .join("");
  return joined;
}

/**
 * 智能解析密码字段：
 * - 若为数组 → 视为 RSA 逐字符密文，解密拼接
 * - 若为字符串 → 原样返回（兼容旧版明文/AES 整包）
 */
function resolvePassword(raw) {
  if (Array.isArray(raw)) return decryptChars(raw);
  return typeof raw === "string" ? raw : "";
}

module.exports = { getPublicKey, decryptChars, resolvePassword };
