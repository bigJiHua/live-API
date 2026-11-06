const axios = require('axios');
const { AiError } = require('./errors');
function providerError(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) return new AiError('DeepSeek Key 无效或无访问权限，请检查设置', 502, 'AI_KEY_INVALID');
  if (status === 402) return new AiError('DeepSeek 账户余额不足', 502, 'AI_BALANCE_REQUIRED');
  if (status === 429) return new AiError('DeepSeek 请求过于频繁，请稍后重试', 502, 'AI_PROVIDER_RATE_LIMIT');
  return new AiError('DeepSeek 暂时不可用或返回不完整，请稍后重试', 502, 'AI_PROVIDER_FAILED');
}
const options = config => ({ headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
  timeout: 20000, maxRedirects: 0, maxContentLength: 256 * 1024, maxBodyLength: 128 * 1024 });
async function checkDeepseekConnection(config) {
  // 多供应商：200 且返回列表即视为连通（模型自由输入，不强校验在列）
  try {
    const response = await axios.get(`${config.baseUrl}/models`, options(config));
    if (!Array.isArray(response.data?.data)) throw new Error('Invalid models response');
  } catch (error) { throw error instanceof AiError ? error : providerError(error); }
}
async function deepseekChat(config, messages, tools) {
  try {
    // 多供应商（追加163 扩展）：任意 OpenAI 兼容 /chat/completions；
    // thinking 仅 DeepSeek 支持（缺省=开，显式关），别家带上会 400。
    const isDeepseek = /deepseek\.com/i.test(config.baseUrl || '');
    const response = await axios.post(`${config.baseUrl}/chat/completions`, {
      model: config.model, messages, tools, tool_choice: 'auto', stream: false, max_tokens: 1800,
      ...(isDeepseek ? { thinking: { type: 'disabled' } } : {}),
    }, options(config));
    const choice = response.data?.choices?.[0];
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason) || choice.message?.role !== 'assistant') throw new Error('Invalid response');
    return choice.message;
  } catch (error) {
    // Never log provider payloads, raw responses, or errors containing credentials/user data.
    throw providerError(error);
  }
}

// 追加163：DeepSeek 官方账户余额查询（GET /user/balance，负责人指定——查的是 DeepSeek 额度不是系统余额）
async function fetchDeepseekBalance(config) {
  try {
    const response = await axios.get(`${config.baseUrl}/user/balance`, { ...options(config), timeout: 10000 });
    const infos = response.data?.balance_infos;
    const info = Array.isArray(infos) ? (infos.find(item => item.currency === 'CNY') || infos[0]) : null;
    if (!info || typeof info.total_balance !== 'string') throw new Error('NO_BALANCE_INFO');
    return { isAvailable: response.data.is_available === true, currency: info.currency,
      totalBalance: info.total_balance, grantedBalance: info.granted_balance, toppedUpBalance: info.topped_up_balance };
  } catch (error) {
    throw error instanceof AiError ? error : providerError(error);
  }
}

// 多供应商：拉取厂商模型列表（OpenAI 兼容 GET /models）
async function fetchProviderModelList({ baseUrl, apiKey }) {
  try {
    const response = await axios.get(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000, maxRedirects: 0,
      maxContentLength: 256 * 1024,
    });
    const list = response.data?.data;
    if (!Array.isArray(list)) throw new Error('NO_MODELS');
    const ids = [...new Set(list.map(item => item?.id).filter(id => typeof id === 'string' && id.length <= 120))].sort();
    if (!ids.length) throw new Error('NO_MODELS');
    return { models: ids.slice(0, 200) };
  } catch (error) {
    throw error instanceof AiError ? error : providerError(error);
  }
}
module.exports = { deepseekChat, checkDeepseekConnection, fetchDeepseekBalance, fetchProviderModelList };
