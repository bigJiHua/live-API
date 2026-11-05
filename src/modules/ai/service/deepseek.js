const axios = require('axios');
const { AiError } = require('./errors');
async function deepseekChat(config, messages, tools) {
  try {
    const response = await axios.post('https://api.deepseek.com/chat/completions', {
      model: config.model, messages, tools, tool_choice: 'auto', stream: false, max_tokens: 1800,
    }, { headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000, maxRedirects: 0, maxContentLength: 256 * 1024, maxBodyLength: 128 * 1024 });
    const choice = response.data?.choices?.[0];
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason) || choice.message?.role !== 'assistant') throw new Error('Invalid response');
    return choice.message;
  } catch (_) {
    // Never log provider payloads, raw responses, or errors containing credentials/user data.
    throw new AiError('DeepSeek 暂时不可用或返回不完整，请稍后重试', 502, 'AI_PROVIDER_FAILED');
  }
}
module.exports = { deepseekChat };
