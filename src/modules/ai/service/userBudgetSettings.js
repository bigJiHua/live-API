const Joi = require('joi');
const { AiError } = require('./errors');
const { turnTimeoutMs, AI_BUDGET_LIMITS } = require('./config');

// 用户预算优先于站点默认值，所有写入仅按登录 user_id 定位。
const FIELDS = [
  { key: 'dailyProviderCalls', column: 'daily_provider_calls', env: 'AI_V3_DAILY_PROVIDER_CALLS', ...AI_BUDGET_LIMITS.dailyProviderCalls },
  { key: 'maxUsageTokens', column: 'max_usage_tokens', env: 'AI_V3_MAX_USAGE_TOKENS', ...AI_BUDGET_LIMITS.maxUsageTokens },
  { key: 'maxOutputTokens', column: 'max_output_tokens', env: 'AI_V3_MAX_OUTPUT_TOKENS', min: 1, max: 393216 },
  { key: 'providerTimeoutMs', column: 'provider_timeout_ms', env: 'AI_PROVIDER_TIMEOUT_MS', min: 1000, max: 105000 },
  { key: 'turnTimeoutMs', column: 'turn_timeout_ms', env: 'AI_V3_TURN_TIMEOUT_MS', min: 30000, max: 300000 },
];
const schema = Joi.object(Object.fromEntries(FIELDS.map(field => [field.key,
  (field.key === 'maxOutputTokens' ? Joi.alternatives().try(Joi.valid('max'), Joi.number().integer().min(field.min).max(field.max))
    : Joi.number().integer().min(field.min).max(field.max)).allow(null).required()]))).unknown(false);

function validateBudgetSettings(input) {
  const { value, error } = schema.validate(input, { convert: false });
  if (error) throw new AiError('额度与超时参数超出允许范围或格式不正确', 400, 'AI_REQUEST_INVALID');
  return value;
}
function budgetValues(env) {
  return { dailyProviderCalls: Number(env.AI_V3_DAILY_PROVIDER_CALLS || 100),
    maxUsageTokens: Number(env.AI_V3_MAX_USAGE_TOKENS || 30000),
    maxOutputTokens: env.AI_V3_MAX_OUTPUT_TOKENS === 'max' ? 'max'
      : env.AI_V3_MAX_OUTPUT_TOKENS ? Number(env.AI_V3_MAX_OUTPUT_TOKENS) : null,
    providerTimeoutMs: Number(env.AI_PROVIDER_TIMEOUT_MS || 60000), turnTimeoutMs: turnTimeoutMs(env) };
}
function budgetEnv(values = {}) {
  return Object.fromEntries(FIELDS.filter(field => values[field.key] != null).map(field => [field.env, String(values[field.key])]));
}

function createUserBudgetStore({ executor = null, refreshMs = 60000, clock = Date.now } = {}) {
  let records = new Map(), ready = !executor, loadedAt = 0, refreshing = null;
  const revisions = new Map();
  const empty = () => Object.fromEntries(FIELDS.map(field => [field.key, null]));
  async function load() {
    if (!executor) { ready = true; return; }
    const before = new Map(revisions);
    const [rows] = await executor.execute(`SELECT user_id, ${FIELDS.map(field => field.column).join(', ')} FROM ai_user_preference`);
    const next = new Map(rows.map(row => [row.user_id, Object.fromEntries(FIELDS.map(field => [field.key,
      row[field.column] == null ? null : field.key === 'maxOutputTokens' && row[field.column] === 'max' ? 'max' : Number(row[field.column])]))]));
    for (const [userId, revision] of revisions) if (revision !== before.get(userId)) next.set(userId, records.get(userId));
    records = next; loadedAt = clock(); ready = true;
  }
  function warmup() {
    if (ready) return Promise.resolve();
    if (!refreshing) refreshing = load().catch(() => {
      throw new AiError('额度与超时设置尚未恢复，请稍后重试', 503, 'AI_BUDGET_SETTINGS_UNAVAILABLE');
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  return { warmup, isReady: () => ready,
    get(userId) {
      if (executor && ready && !refreshing && clock() - loadedAt >= refreshMs) {
        refreshing = load().catch(() => {}).finally(() => { refreshing = null; });
      }
      return { ...(records.get(userId) || empty()) };
    },
    async set(userId, input) {
      const values = validateBudgetSettings(input);
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      await warmup();
      if (executor) {
        try {
          await executor.execute(`INSERT INTO ai_user_preference (user_id, ${FIELDS.map(field => field.column).join(', ')})
            VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ${FIELDS.map(field => `${field.column} = VALUES(${field.column})`).join(', ')}`,
          [userId, ...FIELDS.map(field => values[field.key])]);
        } catch (_) { throw new AiError('额度与超时设置未保存，请稍后重试', 503, 'AI_BUDGET_SETTINGS_UNAVAILABLE'); }
      }
      revisions.set(userId, (revisions.get(userId) || 0) + 1);
      records.set(userId, { ...values });
    }
  };
}
module.exports = { createUserBudgetStore, validateBudgetSettings, budgetValues, budgetEnv, BUDGET_FIELDS: FIELDS };
