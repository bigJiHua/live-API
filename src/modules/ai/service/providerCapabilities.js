// Official provider contracts reviewed on 2026-11-10. Limits are output tokens,
// not context windows or the application's cumulative token budget.
const SOURCES = {
  deepseek: 'https://api-docs.deepseek.com/api/create-chat-completion',
  glm: 'https://docs.bigmodel.cn/cn/guide/start/concept-param',
  sensenova: 'https://platform.sensenova.cn/docs',
};
const MAX_OUTPUT_TOKENS = 393216;
const UNKNOWN_OUTPUT_TOKENS = 4096;
const GLM_OUTPUT_LIMITS = {};
for (const model of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-flashx-legal',
  'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'glm-5', 'glm-5-turbo',
  'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.6']) GLM_OUTPUT_LIMITS[model] = 131072;
for (const model of ['glm-4.5', 'glm-4.5-air', 'glm-4.5-x', 'glm-4.5-flash']) GLM_OUTPUT_LIMITS[model] = 98304;
for (const model of ['glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx', 'glm-4.1v-thinking-flash',
  'glm-4-flash-250414']) GLM_OUTPUT_LIMITS[model] = 32768;
for (const model of ['glm-4.5v', 'glm-4.1v-thinking-flashx', 'glm-4-air-250414']) GLM_OUTPUT_LIMITS[model] = 16384;
for (const model of ['glm-4-plus', 'glm-4-air', 'glm-4-airx', 'glm-4-flash', 'glm-4-flashx']) GLM_OUTPUT_LIMITS[model] = 4095;
GLM_OUTPUT_LIMITS['glm-4v-plus-0111'] = 8192;
GLM_OUTPUT_LIMITS['glm-4v-flash'] = 1024;
const DEEPSEEK_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']);
function providerFor(baseUrl) {
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch (_) { return 'unknown'; }
  const domain = name => host === name || host.endsWith('.' + name);
  return domain('deepseek.com') ? 'deepseek' : domain('bigmodel.cn') ? 'glm'
    : domain('sensenova.cn') ? 'sensenova' : 'unknown';
}
function resolveProviderCapabilities({ baseUrl, model } = {}) {
  const provider = providerFor(baseUrl), name = String(model || '').toLowerCase();
  const cap = { provider, model: name, knownModel: false, contextWindowTokens: null, maxOutputTokens: null,
    thinkingMode: 'unknown', reasoningEfforts: [], defaultReasoningEffort: 'high',
    toolChoiceMode: 'full', jsonSchemaSupported: null, reasoningField: 'reasoning_content', source: SOURCES[provider] || null };
  if (provider === 'deepseek' && DEEPSEEK_MODELS.has(name)
      || provider === 'sensenova' && ['deepseek-flash', 'deepseek-v4-flash'].includes(name)) {
    Object.assign(cap, { knownModel: true, contextWindowTokens: 1048576,
      // SenseNova's current gateway rejects >384000 although its docs say 393216 (verified 2026-11-10).
      maxOutputTokens: provider === 'sensenova' ? 384000 : 393216, documentedMaxOutputTokens: 393216,
      thinkingMode: 'optional', reasoningEfforts: ['low', 'high', 'max'],
      toolChoiceMode: provider === 'deepseek' ? 'auto-when-thinking' : 'full', jsonSchemaSupported: provider === 'sensenova' });
  } else if (provider === 'glm' && Object.hasOwn(GLM_OUTPUT_LIMITS, name)
      || provider === 'sensenova' && name === 'glm-5.3') {
    const v53 = /^glm-5\.3(?:-|$)/.test(name);
    Object.assign(cap, { knownModel: true, maxOutputTokens: GLM_OUTPUT_LIMITS[name],
      contextWindowTokens: v53 ? 1048576 : /^glm-4\.7(?:-|$)/.test(name) ? 204800 : null,
      thinkingMode: v53 ? 'required' : /^glm-(?:5(?:\.|-|$)|4\.[567])/.test(name) ? 'optional'
        : /thinking/.test(name) ? 'required' : 'unsupported',
      reasoningEfforts: v53 ? ['low', 'high', 'max'] : name === 'glm-5.2'
        ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : [],
      toolChoiceMode: provider === 'glm' ? 'auto-only' : 'strings-only', jsonSchemaSupported: false });
  } else if (provider === 'sensenova' && ['sensenova-6.8-flash', 'sensenova-6.8-flash-lite'].includes(name)) {
    const lite = name.endsWith('-lite');
    Object.assign(cap, { knownModel: true, contextWindowTokens: lite ? null : 1048576,
      maxOutputTokens: lite ? 65536 : 131072, thinkingMode: lite ? 'optional' : 'required',
      reasoningEfforts: lite ? ['low', 'medium', 'high', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      jsonSchemaSupported: false, reasoningField: 'reasoning' });
  }
  return cap;
}
function effectiveThinking(cap, requested) { return cap.thinkingMode === 'required' || cap.thinkingMode !== 'unsupported' && !!requested; }
function outputTokenLimit(cap, requested, fallback = 1800) {
  const ceiling = cap.maxOutputTokens || UNKNOWN_OUTPUT_TOKENS;
  if (requested === 'max') return ceiling;
  const value = requested ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS) throw new TypeError('Invalid output token budget');
  return Math.min(value, ceiling);
}
function reasoningEffort(cap, requested) {
  if (cap.reasoningEfforts.includes(requested)) return requested;
  if (cap.reasoningEfforts.includes('low') && ['none', 'minimal'].includes(requested)) return 'low';
  if (cap.reasoningEfforts.includes('max') && ['xhigh', 'ultra'].includes(requested)) return 'max';
  return cap.defaultReasoningEffort;
}
function gatewayThinkingDisabled(config) {
  // Verified 2026-11-13 with a synthetic 72-message history: this gateway's
  // DeepSeek alias defaults to reasoning when the field is absent; explicit
  // thinking.disabled returned complete JSON with no reasoning tokens.
  // Keep its unverified output/context limits; this only transmits an explicit
  // non-thinking request for the exact endpoint/model compatibility contract.
  let origin;
  try { origin = new URL(config.baseUrl).origin; } catch (_) { return false; }
  return origin === 'https://maas.qianwenaiapi.com'
    && config.model === 'deepseek-v4-flash-0731' && config.thinking === false;
}
function adaptChatRequest(config, messages, tools, control = {}, stream = false) {
  const cap = resolveProviderCapabilities(config), thinking = effectiveThinking(cap, config.thinking);
  let selectedTools = tools?.length ? tools : [], toolChoice = control.toolChoice || 'auto';
  const restricted = cap.toolChoiceMode === 'auto-only' || cap.toolChoiceMode === 'auto-when-thinking' && thinking;
  if (toolChoice === 'none') selectedTools = [];
  else if (restricted || cap.toolChoiceMode === 'strings-only' && typeof toolChoice === 'object') {
    if (typeof toolChoice === 'object') {
      const name = toolChoice.function?.name;
      selectedTools = selectedTools.filter(tool => tool.function?.name === name);
      if (!selectedTools.length) throw new TypeError('Requested tool is not present');
    }
    toolChoice = 'auto';
  }
  let responseFormat = {};
  if (control.responseSchema && cap.jsonSchemaSupported !== false) responseFormat = { response_format: {
    type: 'json_schema', json_schema: { name: control.schemaName || 'assistant_result', strict: true, schema: control.responseSchema } } };
  else if (control.json || control.responseSchema) responseFormat = { response_format: { type: 'json_object' } };
  let thinkingParams = {};
  if (cap.knownModel && ['optional', 'required'].includes(cap.thinkingMode)) {
    thinkingParams = { thinking: { type: thinking ? 'enabled' : 'disabled' } };
    if (thinking && cap.reasoningEfforts.length) thinkingParams.reasoning_effort = reasoningEffort(cap, control.reasoningEffort);
    else if (!thinking && cap.provider === 'sensenova') thinkingParams.reasoning_effort = 'none';
  } else if (cap.provider === 'deepseek') thinkingParams = { thinking: { type: config.thinking ? 'enabled' : 'disabled' } };
  else if (gatewayThinkingDisabled(config)) thinkingParams = { thinking: { type: 'disabled' } };
  else if (cap.provider === 'unknown' && config.thinking) thinkingParams = { reasoning_effort: control.reasoningEffort || 'high' };
  // SenseNova's native models expose `reasoning`, but their docs recommend only echoing content.
  const requestMessages = cap.reasoningField === 'reasoning' ? messages.map(message => {
    if (message.role !== 'assistant') return message;
    const { reasoning, reasoning_content, ...rest } = message;
    return rest;
  }) : messages;
  return { model: config.model, messages: requestMessages, stream,
    max_tokens: outputTokenLimit(cap, control.maxTokens ?? config.maxOutputTokens, 1800),
    ...(selectedTools.length ? { tools: selectedTools, tool_choice: toolChoice } : {}), ...responseFormat, ...thinkingParams };
}
function thinkingPreferences(config) {
  const cap = resolveProviderCapabilities(config || {});
  return { thinkingEnabled: effectiveThinking(cap, config?.thinking), thinkingSupported: cap.thinkingMode === 'optional',
    thinkingRequired: cap.thinkingMode === 'required', modelCapabilities: cap };
}
module.exports = { MAX_OUTPUT_TOKENS, UNKNOWN_OUTPUT_TOKENS, resolveProviderCapabilities, outputTokenLimit,
  effectiveThinking, adaptChatRequest, thinkingPreferences, providerFor };
