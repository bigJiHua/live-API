const { AiError } = require('./errors');

function getConfig(env = process.env) {
  const config = { mode: env.AI_MODE || 'disabled', model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    apiKey: env.DEEPSEEK_API_KEY, db: { host: env.AI_DB_HOST, port: Number(env.AI_DB_PORT || 3306),
      database: env.AI_DB_NAME, user: env.AI_DB_USER, password: env.AI_DB_PASSWORD } };
  config.dataSource = config.mode === 'mock' || (env.AI_SYNTHETIC_DATA === 'true' && env.NODE_ENV !== 'production')
    ? 'synthetic' : 'user-readonly';
  if (!['disabled', 'mock', 'deepseek'].includes(config.mode) ||
      (config.mode === 'mock' && env.NODE_ENV === 'production')) {
    throw new AiError('AI 模式配置无效；生产环境禁止模拟模式', 503, 'AI_CONFIG_REQUIRED');
  }
  if (config.mode === 'deepseek' && (!config.apiKey || (config.dataSource !== 'synthetic' && (!config.db.host || !config.db.database ||
      !config.db.user || !config.db.password || config.db.user.toLowerCase() === 'root' ||
      !Number.isInteger(config.db.port) || config.db.port < 1 || config.db.port > 65535)))) {
    throw new AiError('请先配置 DeepSeek 密钥和独立只读数据库账户', 503, 'AI_CONFIG_REQUIRED');
  }
  return config;
}

function capabilities(env = process.env) {
  const base = { contractVersion: 1, provider: 'deepseek', formalWriteEnabled: false,
    chatEnabled: true, draftEditingEnabled: true };
  try {
    const { mode } = getConfig(env);
    return { ...base, enabled: mode !== 'disabled', mode, requiresConsent: mode === 'deepseek',
      scenes: ['query', 'draft', 'chat'], message: mode === 'disabled' ? '站点尚未启用 AI 测试' : '' };
  } catch (error) {
    return { ...base, enabled: false, mode: 'disabled', requiresConsent: false, scenes: [], message: error.message };
  }
}
module.exports = { getConfig, capabilities };
