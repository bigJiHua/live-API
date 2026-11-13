jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');
const { PassThrough } = require('stream');
const { resolveProviderCapabilities, adaptChatRequest, thinkingPreferences } = require('../../src/modules/ai/service/providerCapabilities');
const { getConfig } = require('../../src/modules/ai/service/config');
const { deepseekChat, deepseekChatStream } = require('../../src/modules/ai/service/deepseek');
const ds = 'https://api.deepseek.com';
const glm = 'https://open.bigmodel.cn/api/paas/v4';
const sense = 'https://token.sensenova.cn/v1';
const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const messages = [{ role: 'user', content: 'Return JSON.' }];
const config = (baseUrl, model, thinking = false) => ({ baseUrl, model, thinking, apiKey: 'fixture-provider-key' });

beforeEach(() => { axios.post.mockClear(); });

test.each([
  [ds, 'deepseek-flash', 393216], [ds, 'deepseek-v4-flash', 393216], [ds, 'deepseek-v4-pro', 393216],
  [glm, 'glm-5.3-flash', 131072], [glm, 'glm-4.7', 131072], [glm, 'glm-4.7-flash', 131072],
  [glm, 'glm-4.5-flash', 98304], [glm, 'glm-4.6v-flash', 32768], [glm, 'glm-4v-flash', 1024],
  [sense, 'sensenova-6.8-flash', 131072], [sense, 'sensenova-6.8-flash-lite', 65536],
  [sense, 'deepseek-flash', 384000], [sense, 'glm-5.3', 131072],
])('max mode uses the documented model output limit for %s / %s', (baseUrl, model, limit) => {
  const result = getConfig({ AI_BASE_URL: baseUrl, AI_MODEL: model, AI_V3_MAX_OUTPUT_TOKENS: 'max' });
  expect(result.maxOutputTokens).toBe(limit);
  expect(result.modelCapabilities).toMatchObject({ knownModel: true, maxOutputTokens: limit });
  expect(adaptChatRequest(result, messages, [], { maxTokens: 393216 }).max_tokens).toBe(limit);
});

test('an unverified model or lookalike domain cannot inherit another provider contract', () => {
  for (const baseUrl of ['https://open.bigmodel.cn.attacker.example', 'https://notdeepseek.com', 'https://custom.example/v1']) {
    const result = getConfig({ AI_BASE_URL: baseUrl, AI_MODEL: 'glm-5.3-flash', AI_V3_MAX_OUTPUT_TOKENS: 'max' });
    expect(result.maxOutputTokens).toBe(4096);
    expect(result.modelCapabilities).toMatchObject({ provider: 'unknown', knownModel: false, maxOutputTokens: null });
  }
  expect(resolveProviderCapabilities(config(glm, 'glm-future-model')).knownModel).toBe(false);
});

test('the verified gateway DeepSeek alias transmits non-thinking requests without inheriting official limits', async () => {
  const state = config('https://maas.qianwenaiapi.com/v1', 'deepseek-v4-flash-0731', false);
  axios.post.mockResolvedValue({ data: { choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: '{"items":[]}' } }] } });
  await expect(deepseekChat(state, messages, [], { json: true, maxTokens: 8192 }))
    .resolves.toMatchObject({ message: { content: '{"items":[]}' } });
  expect(axios.post.mock.calls[0][1]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 4096 });
  expect(resolveProviderCapabilities(state)).toMatchObject({ provider: 'unknown', knownModel: false, maxOutputTokens: null });
  expect(adaptChatRequest(state, messages, [], { json: true, maxTokens: 8192 }, true))
    .toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 4096, stream: true });
});

test('gateway non-thinking compatibility is restricted to the exact HTTPS endpoint, alias and explicit preference', () => {
  for (const state of [
    config('https://maas.qianwenaiapi.com.attacker.example/v1', 'deepseek-v4-flash-0731'),
    config('https://custom.example/v1', 'deepseek-v4-flash-0731'),
    config('http://maas.qianwenaiapi.com/v1', 'deepseek-v4-flash-0731'),
    config('https://maas.qianwenaiapi.com:8443/v1', 'deepseek-v4-flash-0731'),
    config('https://maas.qianwenaiapi.com/v1', 'qwen3.8-flash'),
    config('https://maas.qianwenaiapi.com/v1', 'deepseek-v4-flash-0731', true),
  ]) expect(adaptChatRequest(state, messages, [])).not.toHaveProperty('thinking');
  expect(adaptChatRequest(config('https://maas.qianwenaiapi.com/v1', 'deepseek-v4-flash-0731', true), messages, []))
    .toMatchObject({ reasoning_effort: 'high' });
});

test.each([[glm, 'glm-5.3-flash'], [sense, 'glm-5.3'], [sense, 'sensenova-6.8-flash']])(
  'mandatory thinking cannot be disabled or sent an unsupported effort for %s / %s', (baseUrl, model) => {
    const state = config(baseUrl, model, false);
    const body = adaptChatRequest(state, messages, [], { reasoningEffort: 'none' });
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
    expect(thinkingPreferences(state)).toMatchObject({ thinkingRequired: true, thinkingSupported: false, thinkingEnabled: true });
  });

test.each([[ds, 'deepseek-flash'], [glm, 'glm-4.7'], [sense, 'sensenova-6.8-flash-lite'], [sense, 'deepseek-flash']])(
  'optional thinking sends an explicit disabled setting for %s / %s', (baseUrl, model) => {
    const body = adaptChatRequest(config(baseUrl, model), messages, []);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(thinkingPreferences(config(baseUrl, model))).toMatchObject({ thinkingRequired: false, thinkingSupported: true });
  });

test('official DeepSeek thinking and official GLM narrow named tools without unsupported forced selection', () => {
  for (const state of [config(ds, 'deepseek-flash', true), config(glm, 'glm-5.3-flash')]) {
    const body = adaptChatRequest(state, messages, [tool('query_data'), tool('history_read')],
      { toolChoice: { type: 'function', function: { name: 'query_data' } } });
    expect(body.tools.map(item => item.function.name)).toEqual(['query_data']);
    expect(body.tool_choice).toBe('auto');
    expect(body.thinking.type).toBe('enabled');
  }
  const body = adaptChatRequest(config(ds, 'deepseek-flash'), messages, [tool('query_data')],
    { toolChoice: { type: 'function', function: { name: 'query_data' } } });
  expect(body.tool_choice.function.name).toBe('query_data');
});

test('SenseNova DeepSeek keeps its documented support for required tools in thinking mode', () => {
  const body = adaptChatRequest(config(sense, 'deepseek-flash', true), messages, [tool('query_data')], { toolChoice: 'required' });
  expect(body.tool_choice).toBe('required');
});

test('tool-free finalization removes tools and selects supported structured output formats', () => {
  for (const state of [config(ds, 'deepseek-flash'), config(glm, 'glm-5.3-flash'), config(sense, 'sensenova-6.8-flash'), config(sense, 'glm-5.3')]) {
    const body = adaptChatRequest(state, messages, [tool('query_data')], { toolChoice: 'none', responseSchema: { type: 'object' } });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
  }
  expect(adaptChatRequest(config(sense, 'deepseek-flash'), messages, [],
    { responseSchema: { type: 'object' } }).response_format.type).toBe('json_schema');
});

test('native SenseNova historical reasoning is omitted without mutating caller messages', () => {
  const prior = { role: 'assistant', content: 'hello', reasoning: 'native', reasoning_content: 'normalized' };
  const input = [prior, ...messages];
  const body = adaptChatRequest(config(sense, 'sensenova-6.8-flash'), input, []);
  expect(body.messages[0]).toEqual({ role: 'assistant', content: 'hello' });
  expect(prior.reasoning_content).toBe('normalized');
  expect(adaptChatRequest(config(ds, 'deepseek-flash'), input, []).messages[0]).toBe(prior);
});

test('both transport paths use the same provider payload and parse native SenseNova reasoning deltas', async () => {
  const state = config(sense, 'sensenova-6.8-flash-lite');
  axios.post.mockResolvedValueOnce({ data: { choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: 'done', reasoning: 'native thought' } }] } });
  await expect(deepseekChat(state, messages, [], { maxTokens: 131072 })).resolves.toMatchObject({ message: { reasoning: 'native thought' } });
  const nonStreamBody = axios.post.mock.calls[0][1];
  const stream = new PassThrough();
  axios.post.mockResolvedValueOnce({ data: stream });
  const onDelta = jest.fn();
  const pending = deepseekChatStream(state, messages, [], { maxTokens: 131072 }, onDelta);
  await Promise.resolve();
  stream.end('data: {"choices":[{"delta":{"reasoning":"native thought","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  await expect(pending).resolves.toMatchObject({ message: { content: 'done', reasoning: 'native thought' } });
  expect(axios.post.mock.calls[1][1]).toEqual({ ...nonStreamBody, stream: true });
  expect(nonStreamBody.max_tokens).toBe(65536);
  expect(onDelta).toHaveBeenCalledWith({ type: 'reasoning', text: 'native thought' });
});
