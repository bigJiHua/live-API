const { AiError } = require('./errors');
const { MAX_OUTPUT_TOKENS, resolveProviderCapabilities, outputTokenLimit, effectiveThinking, providerFor } = require('./providerCapabilities');
const AI_BUDGET_LIMITS = { dailyProviderCalls: { min: 1, max: 100000 }, maxUsageTokens: { min: 1000, max: 10000000 },
  maxOutputTokens: { min: 1, max: MAX_OUTPUT_TOKENS }, providerTimeoutMs: { min: 1000, max: 105000 }, turnTimeoutMs: { min: 30000, max: 300000 } };

function getConfig(env = process.env) {
  // 多供应商（追加163 扩展）：任意 OpenAI 兼容 base，缺省 DeepSeek；仅允许 https 或本机 http
  const baseUrl = env.AI_BASE_URL || 'https://api.deepseek.com';
  const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
  if (!/^https:\/\//.test(baseUrl) && !isLocalHttp) {
    throw new AiError('AI_BASE_URL 必须是 https 或本机 http 地址', 503, 'AI_CONFIG_REQUIRED');
  }
  // 2026-11-06 商汤切换：密钥/模型槽位泛化，AI_API_KEY/AI_MODEL 优先，DEEPSEEK_* 为兼容旧名保留
  // 2026-11-08：用户 AI 调用的 Key/地址/模型由 effectiveEnv 从数据库 ai_provider_profile 注入，
  // 并在那里剔除 .env 凭据；getConfig 自身保留 env 读取只服务显式传入配置的组合根与单元测试。
  // 追加164：思考能力 env 槽位（缺省 disabled=历史行为）；会话偏好（ai_user_preference）优先于 env
  const config = { baseUrl, mode: env.AI_MODE || 'disabled', model: env.AI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash',
    thinking: env.AI_THINKING === 'enabled',
    providerTimeoutMs: Number(env.AI_PROVIDER_TIMEOUT_MS || 60000),
    structuredOutput: env.AI_RESPONSE_FORMAT || 'json_object',
    dailyProviderLimit: Number(env.AI_V3_DAILY_PROVIDER_CALLS || 100),
    maxUsageTokens: Number(env.AI_V3_MAX_USAGE_TOKENS || 30000),
    maxOutputTokens: env.AI_V3_MAX_OUTPUT_TOKENS === 'max' ? 'max'
      : env.AI_V3_MAX_OUTPUT_TOKENS ? Number(env.AI_V3_MAX_OUTPUT_TOKENS) : null,
    // §10：历史上下文 token 预算。可由 ai_config.history_tokens 覆盖（经 providerEnv 注入本槽位）；
    // 非法值不在此处硬拒——modelContext.historyTokenBudget 对无效值静默回落（沿用既有容忍语义）。
    historyTokens: env.AI_CONTEXT_HISTORY_TOKENS ? Number(env.AI_CONTEXT_HISTORY_TOKENS) : null,
    apiKey: env.AI_API_KEY || env.DEEPSEEK_API_KEY, db: { host: env.AI_DB_HOST, port: Number(env.AI_DB_PORT || 3306),
      database: env.AI_DB_NAME, user: env.AI_DB_USER, password: env.AI_DB_PASSWORD } };
  if (!Number.isInteger(config.providerTimeoutMs) || config.providerTimeoutMs < 1000 || config.providerTimeoutMs > 105000) {
    throw new AiError('AI_PROVIDER_TIMEOUT_MS 必须为 1000～105000 毫秒', 503, 'AI_CONFIG_REQUIRED');
  }
  if (config.maxOutputTokens !== null && config.maxOutputTokens !== 'max' && (!Number.isInteger(config.maxOutputTokens)
      || config.maxOutputTokens < 1 || config.maxOutputTokens > MAX_OUTPUT_TOKENS)) {
    throw new AiError('AI_V3_MAX_OUTPUT_TOKENS 必须为 max 或 1～393216，将按接入商和模型上限收窄', 503, 'AI_CONFIG_REQUIRED');
  }
  config.modelCapabilities = resolveProviderCapabilities(config);
  config.thinking = effectiveThinking(config.modelCapabilities, config.thinking);
  if (config.maxOutputTokens !== null) config.maxOutputTokens = outputTokenLimit(config.modelCapabilities, config.maxOutputTokens);
  if (!['json_object', 'json_schema'].includes(config.structuredOutput) ||
      !Number.isInteger(config.dailyProviderLimit) || config.dailyProviderLimit < AI_BUDGET_LIMITS.dailyProviderCalls.min || config.dailyProviderLimit > AI_BUDGET_LIMITS.dailyProviderCalls.max
      || !Number.isInteger(config.maxUsageTokens) || config.maxUsageTokens < AI_BUDGET_LIMITS.maxUsageTokens.min || config.maxUsageTokens > AI_BUDGET_LIMITS.maxUsageTokens.max) {
    throw new AiError('AI 输出格式或每日调用预算配置无效', 503, 'AI_CONFIG_REQUIRED');
  }
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
    throw new AiError('请先配置 AI 提供方密钥和独立只读数据库账户', 503, 'AI_CONFIG_REQUIRED');
  }
  // §3b（2026-11-12）：联网搜索三重门之站点/用户门。
  // key 派生优先——DS/智谱均为统一 key：聊天供应商为 deepseek/glm 时直接复用聊天连接
  // key+baseUrl（费用天然落用户自己账户）；商汤等无搜索能力的聊天源才要求显式
  // AI_SEARCH_* 槽位（站点代配）。用户门 = env.AI_WEB_SEARCH_ENABLED（由用户偏好注入）：
  // 默认关——收费能力须显式开启；关闭时完全不改变原 config/工具/请求体。
  const userSearchEnabled = env.AI_WEB_SEARCH_ENABLED === 'true';
  const chatProvider = providerFor(config.baseUrl);
  const slotsAvailable = Boolean(env.AI_SEARCH_BASE_URL && env.AI_SEARCH_API_KEY && env.AI_SEARCH_PROVIDER);
  const chatSupportsSearch = chatProvider === 'deepseek' || chatProvider === 'glm';
  // 站点具备搜索能力（显式槽位或聊天源自带），与用户开关分离——供 capabilities 显隐前端开关。
  config.searchCapabilityReady = slotsAvailable || chatSupportsSearch;
  // 站点槽位/引擎校验独立于用户门：运维配错必须启动即响（不能等用户开开关才静默失效）。
  const timeout = Number(env.AI_SEARCH_TIMEOUT_MS || 10000);
  const limit = Number(env.AI_WEB_SEARCH_DAILY_CALLS || 50);
  const engine = env.AI_SEARCH_ENGINE || 'search_std';
  if (slotsAvailable) {
    let searchUrl;
    try { searchUrl = new URL(env.AI_SEARCH_BASE_URL); } catch (_) {}
    if (!searchUrl || searchUrl.protocol !== 'https:' || searchUrl.username || searchUrl.password || searchUrl.search || searchUrl.hash
      || !['deepseek', 'zhipu'].includes(env.AI_SEARCH_PROVIDER)
      || !Number.isInteger(timeout) || timeout < 1000 || timeout > 30000
      || !Number.isInteger(limit) || limit < 1 || limit > 1000
      || (env.AI_SEARCH_PROVIDER === 'zhipu' && !['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'].includes(engine))) {
      throw new AiError('AI 搜索地址、供应商、引擎、超时或每日预算配置无效', 503, 'AI_CONFIG_REQUIRED');
    }
  }
  let search = null;
  if (userSearchEnabled) {
    if (slotsAvailable) {
      search = { searchBaseUrl: new URL(env.AI_SEARCH_BASE_URL).href.replace(/\/$/, ''), searchApiKey: env.AI_SEARCH_API_KEY,
        searchProvider: env.AI_SEARCH_PROVIDER };
    } else if (chatSupportsSearch) {
      // 统一 key：复用聊天连接凭据；智谱搜索路径 /api/paas/v4/web_search 由 client 归一。
      search = { searchBaseUrl: config.baseUrl, searchApiKey: config.apiKey,
        searchProvider: chatProvider === 'glm' ? 'zhipu' : 'deepseek' };
    }
  }
  if (search) {
    Object.assign(config, { searchEnabled: true, searchBaseUrl: search.searchBaseUrl,
      searchApiKey: search.searchApiKey, searchProvider: search.searchProvider,
      ...(search.searchProvider === 'zhipu' ? { searchEngine: engine } : {}),
      searchTimeoutMs: timeout, searchDailyLimit: limit });
  }
  return config;
}

// Share the V3 turn deadline with the advertised frontend request policy.
function turnTimeoutMs(env = process.env) {
  const value = Number(env.AI_V3_TURN_TIMEOUT_MS);
  if (Number.isInteger(value) && value >= 30000 && value <= 300000) return value;
  return String(env.NODE_ENV || '').toLowerCase() === 'development' ? 240000 : 120000;
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
module.exports = { getConfig, capabilities, turnTimeoutMs, AI_BUDGET_LIMITS };
