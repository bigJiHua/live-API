const { AiError } = require('./errors');

function createRolloutPolicy(env = {}) {
  const mode = env.AI_ROLLOUT_MODE || 'open';
  if (!['open', 'allowlist'].includes(mode)) throw new AiError('AI_ROLLOUT_MODE 必须为 open 或 allowlist', 503, 'AI_CONFIG_REQUIRED');
  const users = new Set(String(env.AI_ROLLOUT_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
  if ([...users].some(value => !/^[A-Za-z0-9_-]{1,64}$/.test(value)))
    throw new AiError('AI 灰度名单用户标识无效', 503, 'AI_CONFIG_REQUIRED');
  return Object.freeze({ mode, assertAllowed(userId) {
    if (mode === 'allowlist' && !users.has(userId))
      throw new AiError('AI 正在小范围试行，当前账号尚未开放', 403, 'AI_ROLLOUT_DENIED');
  } });
}

module.exports = { createRolloutPolicy };
