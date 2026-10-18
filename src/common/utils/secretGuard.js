/**
 * 密钥解析与启动期强度自检
 *
 * ## 背景
 * 历史上多个密钥都写了「硬编码回退值」，例如：
 *   - `shareToken.js`  ："... || 'live-share-fallback'"
 *   - `config/jwt.js`  ："... || 'your-secret-key-change-this-in-production'"
 * 生产 `.env` 一旦漏配，服务会**静默**退化到攻击者已知的常量 —— 任何人都能离线
 * 复现签名，伪造任意分享 token / JWT。这类「静默降级」比直接启动失败危险得多。
 *
 * ## 策略
 * | 环境 | 密钥缺失 | 密钥为占位值/过短 |
 * |------|----------|-------------------|
 * | production | 抛错，拒绝启动 | 抛错，拒绝启动 |
 * | 其他（dev/test） | 生成一次性随机值 + 告警 | 沿用配置值 + 告警（不打断本地开发） |
 *
 * 注意：dev 下沿用弱值是为了不破坏本地既有数据（如已发出的分享链接），
 * 但会打印告警；生产环境一律 fail-fast。
 */

const crypto = require("crypto");

/** 最小可接受长度（字符数） */
const MIN_LENGTH = 32;

/** 已知占位值 / 历史回退值，命中即视为「未配置」 */
const PLACEHOLDERS = [
  "your-super-secret-session-key-change-this-in-production",
  "your-super-secret-jwt-key-change-this-in-production",
  "your-secret-key-change-this-in-production",
  "change-this-in-production",
  "your-secret-key",
  "dev-secret-key",
  "prod-secret-key",
  "live-share-fallback",
  "jihau_standard_salt",
];

/** 非生产环境下、变量完全缺失时的临时随机值缓存（同一进程内保持稳定） */
const ephemeralCache = new Map();

/** 是否生产环境 */
function isProduction() {
  return process.env.NODE_ENV === "production";
}

/**
 * 判断一个密钥是否为「弱值」（缺失 / 过短 / 命中占位表）
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isWeakSecret(value) {
  if (!value || typeof value !== "string") return true;
  const v = value.trim();
  if (v.length < MIN_LENGTH) return true;
  const lower = v.toLowerCase();
  return PLACEHOLDERS.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * 解析一个必需密钥。
 * @param {string} name 环境变量名
 * @param {{ fallbackTo?: string }} [opts] 可选的回退变量名（如 SHARE_TOKEN_SECRET 回退到 JWT_SECRET）
 * @returns {string} 可用的密钥
 * @throws {Error} 生产环境下密钥缺失或为弱值时抛出，使服务拒绝启动
 */
function resolveSecret(name, opts = {}) {
  const { fallbackTo } = opts;
  const raw = process.env[name] || (fallbackTo ? process.env[fallbackTo] : undefined);
  const source = process.env[name] ? name : fallbackTo;

  if (!isWeakSecret(raw)) return raw.trim();

  if (isProduction()) {
    throw new Error(
      `[secretGuard] 生产环境密钥 ${name} 未配置或强度不足（要求 ≥ ${MIN_LENGTH} 位随机字符串，` +
        `且不能是占位值）${source && source !== name ? `（已尝试回退 ${source}）` : ""}。` +
        `请执行 openssl rand -hex 32 生成后写入 api/.env，服务拒绝以弱密钥启动。`
    );
  }

  // 非生产：有值就沿用（只告警），完全没有才给一次性随机值
  if (raw) {
    console.warn(
      `[secretGuard] ⚠ ${name} 使用了弱值/占位值，仅限本地开发使用，生产环境将拒绝启动。` +
        `建议改为 openssl rand -hex 32 生成的值。`
    );
    return raw.trim();
  }

  if (!ephemeralCache.has(name)) {
    ephemeralCache.set(name, crypto.randomBytes(32).toString("hex"));
    console.warn(
      `[secretGuard] ⚠ ${name} 未配置，已生成本次进程专用的随机密钥（重启即失效，相关签发物会全部失效）。`
    );
  }
  return ephemeralCache.get(name);
}

/**
 * 是否处于「不安全但可运行」的降级状态（供启动横幅等展示）
 * @returns {string[]} 问题清单
 */
function auditSecrets(specs = []) {
  const issues = [];
  for (const spec of specs) {
    const name = typeof spec === "string" ? spec : spec.name;
    const fallbackTo = typeof spec === "string" ? undefined : spec.fallbackTo;
    const raw = process.env[name] || (fallbackTo ? process.env[fallbackTo] : undefined);
    if (isWeakSecret(raw)) {
      const via = process.env[name] ? name : fallbackTo;
      issues.push(via && via !== name ? `${name}（或回退 ${via}）` : name);
    }
  }
  return issues;
}

module.exports = { isWeakSecret, resolveSecret, auditSecrets, isProduction, MIN_LENGTH };
