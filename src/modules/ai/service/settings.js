const Joi = require('joi');
const crypto = require('crypto');
const { validate } = require('./validation');
const { AiError } = require('./errors');

// 追加163 扩展（2026-11-06）：多供应商（OpenAI 兼容协议）。
// - apiUrl 放开为任意 https（本机 http 仅限 localhost/127.0.0.1，给 Ollama/LM Studio 类）
//   —— 拒绝凭据内嵌、查询串、锚点；Key 只发给用户自己填写的地址（SSRF 面收敛：无重定向、maxRedirects=0）。
// - 模型不再白名单：自由输入 + 动态获取（POST /ai/models 打厂商 /models）。
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function normalizeApiUrl(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw new AiError('请输入正确的 API 地址', 400, 'AI_ENDPOINT_DENIED'); }
  const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new AiError('API 地址必须是 https（本机调试可用 http://localhost）', 400, 'AI_ENDPOINT_DENIED');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiError('API 地址不能包含凭据、查询参数或锚点', 400, 'AI_ENDPOINT_DENIED');
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

const schema = Joi.object({
  apiUrl: Joi.string().max(200).required(),
  apiKey: Joi.string().min(8).max(256).pattern(/^[A-Za-z0-9_\-\.]+$/),
  model: Joi.string().min(1).max(120).pattern(/^[A-Za-z0-9._\-\/:]+$/).required(),
}).unknown(false);

function createSettingsStore({ now = Date.now, ttl = 60 * 60 * 1000, maxEntries = 500 } = {}) {
  const records = new Map();
  function prune() { for (const [id, value] of records) if (value.expiresAt <= now()) records.delete(id); }
  return {
    get(userId) { prune(); return records.has(userId) ? { ...records.get(userId) } : null; },
    validate(input, current) {
      const fields = validate(schema, input);
      const apiUrl = normalizeApiUrl(fields.apiUrl);
      let apiKey = fields.apiKey;
      // 省略 Key 仅表示复用同一目标的旧 Key，不能把旧供应商凭据带到新地址。
      if (!apiKey && current?.apiKey && typeof current.apiUrl === 'string' &&
          apiUrl === normalizeApiUrl(current.apiUrl)) {
        apiKey = current.apiKey;
      }
      if (!apiKey) {
        throw new AiError(current?.apiKey ? '更换 API 地址时请填写该地址的 API Key' : '请填写 API Key',
          400, 'AI_KEY_REQUIRED');
      }
      return { apiUrl, apiKey, model: fields.model };
    },
    save(userId, fields) {
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      prune();
      if (!records.has(userId) && records.size >= maxEntries) throw new AiError('临时设置容量已满，请稍后重试', 429);
      records.set(userId, { ...fields, connectionId: crypto.randomUUID(), expiresAt: now() + ttl });
    },
    clear(userId) { records.delete(userId); },
    close() { records.clear(); },
  };
}
module.exports = { createSettingsStore, DEEPSEEK_BASE_URL, normalizeApiUrl };
