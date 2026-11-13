jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { AiError } = require('../../src/modules/ai/service/errors');
const { sanitizeProviderDetail } = require('../../src/modules/ai/service/providerDetail');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const config = { baseUrl: 'https://provider.invalid/v1', apiKey: 'private-fixture-key', model: 'fixture-model', providerTimeoutMs: 60000 };

let errorLog;
beforeEach(() => {
  jest.clearAllMocks();
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

test('provider HTTP errors expose a redacted, truncated summary alongside the fixed message', async () => {
  axios.post.mockRejectedValue(Object.assign(new Error('Request failed'), {
    code: 'ERR_BAD_RESPONSE',
    response: { status: 429, data: { error: { code: 'rate_limit_exceeded', type: 'rate_limit',
      message: 'Too many requests for private-fixture-key; retry later' } } },
  }));
  const error = await deepseekChat(config, []).catch(value => value);
  expect(error).toMatchObject({ code: 'AI_PROVIDER_RATE_LIMIT', status: 502,
    providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests for [redacted]; retry later' } });
  expect(JSON.stringify(error.providerDetail)).not.toContain(config.apiKey);
});

test('provider messages are bounded so a verbose upstream body cannot reach the chat bubble whole', async () => {
  axios.post.mockRejectedValue(Object.assign(new Error('Request failed'), {
    code: 'ERR_BAD_RESPONSE',
    response: { status: 400, data: { error: { code: 'invalid_request', message: 'x'.repeat(2000) } } },
  }));
  const error = await deepseekChat(config, []).catch(value => value);
  expect(error.providerDetail.message).toHaveLength(240);
});

test('transport failures retain only the safe socket error code', async () => {
  axios.post.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }));
  const error = await deepseekChat(config, []).catch(value => value);
  expect(error.providerDetail).toEqual({ cause: 'ECONNREFUSED' });
});

test('sanitizeProviderDetail drops invalid shapes and disallowed fields', () => {
  expect(sanitizeProviderDetail(null)).toBeNull();
  expect(sanitizeProviderDetail('HTTP 500')).toBeNull();
  expect(sanitizeProviderDetail({ body: 'request payload', apiKey: 'secret' })).toBeNull();
  expect(sanitizeProviderDetail({ status: 502, code: 'upstream_error', request: 'private' }))
    .toEqual({ status: 502, code: 'upstream_error' });
});

test('a failed run keeps the provider summary in its encrypted receipt', async () => {
  const guard = createMemoryRequestGuard();
  const requestId = 'provider-detail-receipt';
  const failure = new AiError('AI 供应商限制了本次请求，请稍后手动重试。', 502, 'AI_PROVIDER_RATE_LIMIT');
  failure.providerDetail = { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' };
  await expect(guard.run('owner', { requestId, lane: 'business-chat', input: { consent: true }, maxProviderCalls: 1 },
    async () => { throw failure; })).rejects.toMatchObject({ code: 'AI_PROVIDER_RATE_LIMIT',
    providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' } });
  await expect(guard.get('owner', requestId)).resolves.toMatchObject({ status: 'failed',
    error: { code: 'AI_PROVIDER_RATE_LIMIT' },
    providerDetail: { status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' } });
});
