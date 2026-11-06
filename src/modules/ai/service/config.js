const { AiError } = require('./errors');

function getConfig(env = process.env) {
  // 多供应商（追加163 扩展）：任意 OpenAI 兼容 base，缺省 DeepSeek；仅允许 https 或本机 http
  const baseUrl = env.AI_BASE_URL || 'https://api.deepseek.com';
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
  if (!/^https:\/\//.test(baseUrl) && !isLocalHttp) {
    throw new AiError('AI_BASE_URL 必须是 https 或本机 http 地址', 503, 'AI_CONFIG_REQUIRED');
  }
  const config = { baseUrl, mode: env.AI_MODE || 'disabled', model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    apiKey: env.DEEPSEEK_API_KEY, db: { host: env.AI_DB_HOST, port: Number(env.AI_DB_PORT || 3306),
      database: env.AI_DB_NAME, user: env.AI_DB_USER, password: env.AI_DB_PASSWORD } };
  // Synthetic data is a unit-test fixture only, never a running development/production fallback.
  if ((config.mode === 'mock' || env.AI_SYNTHETIC_DATA === 'true') && env.NODE_ENV !== 'test') {
    throw new AiError('模拟账本仅允许显式单元测试，运行服务必须连接真实只读数据库', 503, 'AI_CONFIG_REQUIRED');
  }
  config.dataSource = config.mode === 'mock' || (env.AI_SYNTHETIC_DATA === 'true' && env.NODE_ENV === 'test')
    ? 'synthetic' : 'user-readonly';
  if (!['disabled', 'mock', 'deepseek'].includes(config.mode) ||
      (config.mode === 'mock' && env.NODE_ENV !== 'test')) {
    throw new AiError('AI 模式配置无效', 503, 'AI_CONFIG_REQUIRED');
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
    const { mode, baseUrl } = getConfig(env);
    let provider = 'unknown';
    try { provider = new URL(baseUrl).host; } catch (_) {}
    return { ...base, enabled: mode !== 'disabled', mode, provider, requiresConsent: mode === 'deepseek',
      scenes: ['query', 'draft', 'chat'], message: mode === 'disabled' ? '站点尚未启用 AI 测试' : '' };
  } catch (error) {
    return { ...base, enabled: false, mode: 'disabled', requiresConsent: false, scenes: [], message: error.message };
  }
}
module.exports = { getConfig, capabilities };
