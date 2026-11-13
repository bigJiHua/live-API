const crypto = require('crypto');
const { AiError } = require('./errors');

const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;
const REFRESH_WINDOW_MS = 60 * 1000;
const MAX_REFRESHES = 5;

function createModelListCache({ clock = Date.now } = {}) {
  const entries = new Map(), refreshes = new Map();
  const copy = value => ({ models: [...value.models] });
  async function get({ userId, baseUrl, apiKey }, load) {
    const now = clock();
    for (const [key, entry] of entries) if (!entry.pending && entry.until <= now) entries.delete(key);
    for (const [owner, entry] of refreshes) if (entry.until <= now) refreshes.delete(owner);
    // Scope by owner, exact normalized target and credential fingerprint.
    // Cache keys and values never contain the plaintext credential.
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const key = crypto.createHash('sha256').update(JSON.stringify([userId, baseUrl, keyHash])).digest('hex');
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key); entries.set(key, cached);
      return copy(cached.pending ? await cached.pending : cached.value);
    }
    const rate = refreshes.get(userId) || { until: now + REFRESH_WINDOW_MS, count: 0 };
    if (rate.count >= MAX_REFRESHES || (!refreshes.has(userId) && refreshes.size >= MAX_ENTRIES)) {
      const error = new AiError('模型列表刷新过于频繁，请稍后重试', 429, 'AI_MODELS_RATE_LIMIT');
      error.retryAfterSeconds = Math.max(1, Math.ceil((rate.until - now) / 1000));
      throw error;
    }
    if (entries.size >= MAX_ENTRIES) {
      const oldest = [...entries].find(([, entry]) => !entry.pending);
      if (oldest) entries.delete(oldest[0]);
      else throw new AiError('模型列表正在获取，请稍后重试', 429, 'AI_MODELS_RATE_LIMIT');
    }
    rate.count++; refreshes.set(userId, rate);
    const entry = { pending: null, value: null, until: 0 };
    entry.pending = Promise.resolve().then(load).then(value => {
      entry.value = copy(value); entry.until = clock() + MODEL_LIST_TTL_MS;
      entry.pending = null;
      return entry.value;
    }).catch(error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key, entry);
    return copy(await entry.pending);
  }
  return { get, clear() { entries.clear(); refreshes.clear(); } };
}
module.exports = { createModelListCache, MODEL_LIST_TTL_MS };
