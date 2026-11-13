const { AiError } = require('./errors');
const DOMAINS = ['finance', 'account', 'card', 'budget', 'todo', 'work', 'asset', 'fixedAsset', 'fund', 'installment'];
const ACTIONS = ['transaction.create', 'budget.create', 'todo.create', 'todo.update', 'todo.complete', 'todo.delete', 'diary.create',
  'card.metadata', 'fixedAsset.create', 'fixedAsset.update', 'fixedAsset.delete', 'fixedAsset.restore', 'fixedAsset.permanentDelete', 'fund.returnBatch', 'system.backup'];
function list(value, allowed, fallback) {
  if (value == null) return fallback;
  if (value === '*') return [...allowed];
  const selected = value.split(',').map(item => item.trim()).filter(Boolean);
  if (selected.some(item => !allowed.includes(item))) throw new AiError('业务助手开放配置包含未知能力', 503, 'AI_CONFIG_REQUIRED');
  return [...new Set(selected)];
}
function businessPolicy(env = process.env) {
  const production = env.NODE_ENV === 'production';
  return { enabled: env.AI_BUSINESS_ENABLED === 'true' || (!production && env.AI_BUSINESS_ENABLED !== 'false'),
    domains: list(env.AI_BUSINESS_DOMAINS, DOMAINS, DOMAINS),
    actions: list(env.AI_BUSINESS_ACTIONS, ACTIONS, production ? [] : ACTIONS) };
}
module.exports = { businessPolicy, DOMAINS, ACTIONS };
