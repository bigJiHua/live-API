const Joi = require('joi');
const crypto = require('crypto');
const { validate } = require('./validation');
const { AiError } = require('./errors');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
const schema = Joi.object({ apiUrl: Joi.string().max(200).required(),
  apiKey: Joi.string().min(8).max(256).pattern(/^[A-Za-z0-9_-]+$/),
  model: Joi.string().valid(...MODELS).required() }).unknown(false);
function normalizeApiUrl(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw new AiError('请输入 DeepSeek 官方 API 地址'); }
  if (url.origin !== DEEPSEEK_BASE_URL || url.username || url.password || url.search || url.hash ||
      !['', '/', '/v1', '/v1/', '/chat/completions', '/v1/chat/completions'].includes(url.pathname)) {
    throw new AiError('当前仅支持 https://api.deepseek.com 的官方接口', 400, 'AI_ENDPOINT_DENIED');
  }
  return DEEPSEEK_BASE_URL;
}
function createSettingsStore({ now = Date.now, ttl = 60 * 60 * 1000, maxEntries = 500 } = {}) {
  const records = new Map();
  function prune() { for (const [id, value] of records) if (value.expiresAt <= now()) records.delete(id); }
  return {
    get(userId) { prune(); return records.has(userId) ? { ...records.get(userId) } : null; },
    validate(input, current) {
      const fields = validate(schema, input);
      const apiKey = fields.apiKey || current?.apiKey;
      if (!apiKey) throw new AiError('请填写 API Key');
      return { apiUrl: normalizeApiUrl(fields.apiUrl), apiKey, model: fields.model };
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
module.exports = { createSettingsStore, DEEPSEEK_BASE_URL, MODELS, normalizeApiUrl };
