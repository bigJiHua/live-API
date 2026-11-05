const axios = require('axios');
const { AiError } = require('./errors');
const { DEEPSEEK_BASE_URL } = require('./settings');
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
  try {
    const response = await axios.get(`${DEEPSEEK_BASE_URL}/models`, options(config));
    if (!Array.isArray(response.data?.data) || !response.data.data.some(item => item.id === config.model)) {
      throw new AiError('当前 Key 无法使用所选模型，请检查模型设置', 502, 'AI_MODEL_UNAVAILABLE');
    }
  } catch (error) { throw error instanceof AiError ? error : providerError(error); }
}
async function deepseekChat(config, messages, tools) {
  try {
    const response = await axios.post(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      model: config.model, messages, tools, tool_choice: 'auto', stream: false, max_tokens: 1800,
      thinking: { type: 'disabled' },
    }, options(config));
    const choice = response.data?.choices?.[0];
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason) || choice.message?.role !== 'assistant') throw new Error('Invalid response');
    return choice.message;
  } catch (error) {
    // Never log provider payloads, raw responses, or errors containing credentials/user data.
    throw providerError(error);
  }
}
module.exports = { deepseekChat, checkDeepseekConnection };
