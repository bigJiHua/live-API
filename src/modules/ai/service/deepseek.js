const axios = require('axios');
const { AiError } = require('./errors');
const { collectProviderStream } = require('./providerStream');
const { startProviderTrace } = require('./diagnostics');
const { providerDetailFromDiagnostics } = require('./providerDetail');
const { adaptChatRequest } = require('./providerCapabilities');
function providerError(error, trace) {
  const diagnostics = trace?.fail(error);
  const status = error?.response?.status || diagnostics?.providerStatus;
  const mapped = (message, httpStatus, code) => {
    const result = new AiError(message, httpStatus, code);
    result.causeCode = error?.code || error?.name || null;
    result.providerStatus = status || null;
    if (diagnostics) result.diagnostics = diagnostics;
    // 固定文案之外附上供应商真实错误摘要（已脱敏截断），供前端在固定提示下展示。
    const detail = providerDetailFromDiagnostics(diagnostics);
    if (detail) result.providerDetail = detail;
    return result;
  };
  // 2026-11-06 商汤切换：错误文案不再点名 DeepSeek（多供应商通用）
  if (status === 401 || status === 403) return mapped('AI 提供方 Key 无效或无访问权限，请检查设置', 502, 'AI_KEY_INVALID');
  if (status === 402) return mapped('AI 提供方账户余额不足', 502, 'AI_BALANCE_REQUIRED');
  if (status === 429) return mapped('AI 提供方请求过于频繁，请稍后重试', 502, 'AI_PROVIDER_RATE_LIMIT');
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) return mapped('AI 提供方响应超时，本次已停止；可查看请求日志后手动重试', 504, 'AI_PROVIDER_TIMEOUT');
  if (error?.code === 'ERR_PROVIDER_RESPONSE_LIMIT' || error?.code === 'ERR_BAD_RESPONSE' && /maxContentLength.*exceeded/.test(error.message || ''))
    return mapped('AI 响应超出安全大小限制，本次已停止；请缩小查询范围后手动重试', 502, 'AI_PROVIDER_RESPONSE_LIMIT');
  if (error?.code === 'ERR_PROVIDER_FINISH')
    return mapped(diagnostics?.finishReason === 'length' ? 'AI 输出达到本次长度上限，未完成答复；请缩小问题后手动重试'
      : 'AI 响应未正常结束，本次没有完整结果；请查看处理记录后手动重试', 502, 'AI_PROVIDER_INCOMPLETE');
  if (['ERR_PROVIDER_STREAM_ABORTED', 'ECONNRESET', 'EPIPE'].includes(error?.code) || error?.code === 'ERR_BAD_RESPONSE' && /stream.*aborted/.test(error.message || ''))
    return mapped('AI 响应流意外中断，本次没有完整结果；请读取回执后手动重试', 502, 'AI_PROVIDER_STREAM_INTERRUPTED');
  if (error?.code === 'ERR_PROVIDER_STREAM')
    return mapped('AI 响应流格式不完整，本次已停止；请查看处理记录后手动重试', 502, 'AI_PROVIDER_INVALID_RESPONSE');
  if (error instanceof AiError) {
    if (diagnostics) error.diagnostics = diagnostics;
    if (!error.providerDetail) {
      const detail = providerDetailFromDiagnostics(diagnostics);
      if (detail) error.providerDetail = detail;
    }
    return error;
  }
  return mapped('AI 提供方暂时不可用或返回不完整，请稍后重试', 502, 'AI_PROVIDER_FAILED');
}
const options = config => ({ headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
  // 追加164：chat 超时 20s→40s——商汤首 token 波动实测 2/2 + 流式 1/1 超 20s（守卫预算 45s 内）；
  // balance/models 等元信息调用仍走各自的 10s 超时
  timeout: config.providerTimeoutMs || 60000, maxRedirects: 0, maxContentLength: 256 * 1024, maxBodyLength: 128 * 1024 });
// Decoded output and SSE framing are different budgets. One token per packet
// repeats the JSON envelope; counting that against decoded text cuts valid replies.
const decodedResponseLimit = control => Math.max(256 * 1024,
  Math.min(8 * 1024 * 1024, (control.maxTokens || 1800) * 32));
const chatOptions = (config, control, stream = false) => ({ ...options(config),
  maxContentLength: stream ? Math.min(64 * 1024 * 1024,
    decodedResponseLimit(control) + (control.maxTokens || 1800) * 512) : decodedResponseLimit(control),
  ...(control.signal ? { signal: control.signal } : {}) });
// Axios socket timeouts reset while SSE keeps sending data. Keep an independent
// deadline until the entire completion has been consumed, including streaming.
function chatDeadline(config, control) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(control.signal.reason);
  if (control.signal?.aborted) onAbort();
  else control.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.providerTimeoutMs || 60000);
  timer.unref?.();
  return { control: { ...control, signal: controller.signal },
    failure: error => timedOut ? Object.assign(new Error('AI provider completion deadline exceeded'), { code: 'ETIMEDOUT' }) : error,
    dispose() { clearTimeout(timer); control.signal?.removeEventListener('abort', onAbort); } };
}
async function checkDeepseekConnection(config) {
  // 多供应商：200 且返回列表即视为连通（模型自由输入，不强校验在列）
  const trace = startProviderTrace(config, '/models', 10000);
  try {
    const response = await axios.get(`${config.baseUrl}/models`, { ...options(config), timeout: 10000 });
    if (!Array.isArray(response.data?.data)) throw new Error('Invalid models response');
    trace.finish();
  } catch (error) { throw providerError(error, trace); }
}
async function deepseekChat(config, messages, tools, control = {}) {
  const trace = startProviderTrace(config, '/chat/completions', config.providerTimeoutMs || 60000);
  const deadline = chatDeadline(config, control);
  try {
    const body = adaptChatRequest(config, messages, tools, control, false);
    const response = await axios.post(`${config.baseUrl}/chat/completions`, body,
      chatOptions(config, { ...deadline.control, maxTokens: body.max_tokens }));
    const choice = response.data?.choices?.[0];
    if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason) || choice.message?.role !== 'assistant') {
      // Keep envelope metadata so truncation can be distinguished from provider outages.
      throw Object.assign(new Error('Invalid response'), { diagnostics: {
        providerStatus: response.status || null,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 80) : null,
        maxTokens: body.max_tokens,
        hasChoice: !!choice, hasAssistantRole: choice?.message?.role === 'assistant',
        usage: Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
          .filter(key => Number.isFinite(response.data?.usage?.[key]))
          .map(key => [key, response.data.usage[key]])),
      } });
    }
    // 追加164：usage 随消息返回（审计日志 + 前端 token 用量展示），不再丢弃
    trace.finish(response.data?.usage);
    return { message: choice.message, usage: response.data?.usage || null };
  } catch (error) {
    // Never log provider payloads, raw responses, or errors containing credentials/user data.
    throw providerError(deadline.failure(error), trace);
  } finally { deadline.dispose(); }
}

// 追加164 流式：OpenAI 兼容 SSE 增量解析（reasoning_content/content/tool_calls/usage）。
// 聚合结果与非流式完全一致（{message, usage}）；onDelta({type:'reasoning'|'content', text}) 逐段回调。
// 参数映射与 deepseekChat 逐字一致；任何异常统一走 providerError，绝不向外泄露原始 payload。
async function deepseekChatStream(config, messages, tools, control = {}, onDelta = null) {
  const trace = startProviderTrace(config, '/chat/completions:stream', config.providerTimeoutMs || 60000);
  const deadline = chatDeadline(config, control);
  try {
    const body = adaptChatRequest(config, messages, tools, control, true);
    const response = await axios.post(`${config.baseUrl}/chat/completions`, body,
      { ...chatOptions(config, { ...deadline.control, maxTokens: body.max_tokens }, true), responseType: 'stream' });
    const { message, usage } = await collectProviderStream(response.data, {
      maxBytes: chatOptions(config, { ...control, maxTokens: body.max_tokens }, true).maxContentLength,
      maxTextBytes: decodedResponseLimit({ ...control, maxTokens: body.max_tokens }),
      maxFrames: body.max_tokens * 8 + 256,
      signal: deadline.control.signal, contentType: response.headers?.['content-type'] || '',
      providerStatus: response.status || null, onFirstByte: () => trace.firstByte(), onDelta,
    });
    trace.finish(usage);
    return { message, usage };
  } catch (error) {
    throw providerError(deadline.failure(error), trace);
  } finally { deadline.dispose(); }
}

// 追加163：DeepSeek 官方账户余额查询（GET /user/balance，负责人指定——查的是 DeepSeek 额度不是系统余额）
async function fetchDeepseekBalance(config) {
  const trace = startProviderTrace(config, '/user/balance', 10000);
  try {
    const response = await axios.get(`${config.baseUrl}/user/balance`, { ...options(config), timeout: 10000 });
    const infos = response.data?.balance_infos;
    const info = Array.isArray(infos) ? (infos.find(item => item.currency === 'CNY') || infos[0]) : null;
    if (!info || typeof info.total_balance !== 'string') throw new Error('NO_BALANCE_INFO');
    trace.finish();
    return { isAvailable: response.data.is_available === true, currency: info.currency,
      totalBalance: info.total_balance, grantedBalance: info.granted_balance, toppedUpBalance: info.topped_up_balance };
  } catch (error) {
    throw providerError(error, trace);
  }
}

// 多供应商：拉取厂商模型列表（OpenAI 兼容 GET /models）
async function fetchProviderModelList({ baseUrl, apiKey }) {
  const trace = startProviderTrace({ baseUrl, apiKey }, '/models', 10000);
  try {
    const response = await axios.get(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000, maxRedirects: 0,
      maxContentLength: 256 * 1024,
    });
    const list = response.data?.data;
    if (!Array.isArray(list)) throw new Error('NO_MODELS');
    const ids = [...new Set(list.map(item => item?.id).filter(id => typeof id === 'string' && id.length <= 120))].sort();
    if (!ids.length) throw new Error('NO_MODELS');
    trace.finish();
    return { models: ids.slice(0, 200) };
  } catch (error) {
    throw providerError(error, trace);
  }
}
module.exports = { deepseekChat, deepseekChatStream, checkDeepseekConnection, fetchDeepseekBalance, fetchProviderModelList };
