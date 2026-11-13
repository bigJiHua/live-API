jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public database forbidden'); }), getConnection: jest.fn() }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Public read pool forbidden'); }) }));
const express = require('express');
const { randomUUID } = require('crypto');
const { createAiRouter } = require('../../src/modules/ai/api');
const { AiError } = require('../../src/modules/ai/service/errors');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
let server, base;
const conversationId = randomUUID();
const agent = { chat: jest.fn(), session: jest.fn(), getProposal: jest.fn(), editProposal: jest.fn(), actOnProposal: jest.fn(), executeProposal: jest.fn() };
const service = { getRequestReceipt: jest.fn(), getCapabilities: () => ({ contractVersion: 3, agentVersion: 3, businessVersion: 3, requestPolicy: { dailyProviderCalls: 100 } }) };
const call = (path, method = 'GET', input, user = 'synthetic-owner') => fetch(base + path, { method,
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-unit-owner': user } : {}) },
  ...(input === undefined ? {} : { body: JSON.stringify({ data: input }) }) });
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ service, business: {}, agent, guard: (req, res, next) => {
    if (!req.headers['x-unit-owner']) return res.status(401).json({ status: 401 });
    req.userId = req.headers['x-unit-owner']; next();
  } }));
  server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  base = `http://127.0.0.1:${server.address().port}/ai`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { Object.values(agent).forEach(fn => fn.mockReset()); service.getRequestReceipt.mockReset(); });

test('every old chat and preview endpoint is retired without executing either orchestration', async () => {
  for (const path of ['/chat', '/ocr', '/v2/chat', '/v2/chat/stream', '/v2/preview', '/v2/transaction/draft']) {
    const response = await call(path, 'POST', { message: '合成验收' });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'AI_VERSION_RETIRED', traceId: expect.any(String) });
  }
  expect(agent.chat).not.toHaveBeenCalled();
});
test('V3 receives one raw message and authenticated identity, with no server prefetch', async () => {
  const input = { message: '今天去赵一鸣买了8.5的零食', requestId: randomUUID(), conversationId, consent: true };
  agent.chat.mockResolvedValue({ contractVersion: 3, answer: '用哪个账户支付？', conversationId,
    datasets: [], request: { requestId: input.requestId, providerCalls: 2, maxProviderCalls: 5 } });
  const response = await call('/v3/chat', 'POST', input);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(agent.chat.mock.calls[0].slice(0, 2)).toEqual(['synthetic-owner', input]);
  expect(agent.chat.mock.calls[0][3].signal).toBeInstanceOf(AbortSignal);
  expect((await response.json()).data.contractVersion).toBe(3);
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
});

test('capability authorization requests reach both JSON and SSE clients without exposing a data range', async () => {
  const authorizationRequest = { version: 1, conversationId, providerHost: 'provider.test', access: 'read',
    reason: '比较两个时段的脱敏收支', expiresAt: Date.now() + 600000 };
  const error = Object.assign(new AiError('需要授权', 403, 'AI_GRANT_REQUIRED'), { authorizationRequest });
  agent.chat.mockRejectedValue(error);
  const input = { requestId: randomUUID(), message: '分析收支', conversationId, mode: 'analysis', consent: true };
  const response = await call('/v3/chat', 'POST', input);
  expect(response.status).toBe(403); expect((await response.json()).authorizationRequest).toEqual(authorizationRequest);
  agent.chat.mockImplementation(async (_, __, emit) => { emit('status', { stage: 'selecting' }); throw error; });
  const stream = await call('/v3/chat/stream', 'POST', { ...input, requestId: randomUUID() });
  const events = await stream.text();
  expect(events).toContain('event: error'); expect(events).toContain(JSON.stringify(authorizationRequest));
  expect(authorizationRequest).not.toHaveProperty('domains'); expect(authorizationRequest).not.toHaveProperty('scope');
});

test('grant routes forward the authenticated owner and conversation instead of a client data range', async () => {
  service.getGrant = jest.fn(async () => ({ contractVersion: 2, granted: false, conversationId }));
  service.putGrant = jest.fn(async (_, input) => ({ contractVersion: 2, granted: true, ...input }));
  service.deleteGrant = jest.fn(async () => ({ contractVersion: 2, granted: false, conversationId }));
  await call('/grant?conversationId=' + conversationId);
  expect(service.getGrant).toHaveBeenCalledWith('synthetic-owner', conversationId);
  const input = { conversationId, providerHost: 'provider.test', access: 'read', lifetime: '1h' };
  await call('/grant', 'PUT', input);
  expect(service.putGrant).toHaveBeenCalledWith('synthetic-owner', input);
  await call('/grant?conversationId=' + conversationId, 'DELETE', {});
  expect(service.deleteGrant).toHaveBeenCalledWith('synthetic-owner', conversationId);
});

test('receipt GET bypasses unavailable settings warmup after restart', async () => {
  service.warmupSettings = jest.fn(async () => { throw Error('warming up'); });
  service.getRequestReceipt.mockResolvedValue({ contractVersion: 3, requestId: randomUUID(),
    status: 'failed', error: { code: 'AI_TURN_INTERRUPTED', message: '服务中断' } });
  try {
    const response = await call('/v3/requests/' + randomUUID());
    expect(response.status).toBe(200);
    expect(service.warmupSettings).not.toHaveBeenCalled();
    expect((await call('/capabilities')).status).toBe(503);
  } finally { delete service.warmupSettings; }
});
test('V3 identity is required and manual sessions cannot carry extra client state', async () => {
  expect((await call('/v3/chat', 'POST', {}, null)).status).toBe(401);
  expect((await call('/v3/session', 'POST', { kind: 'manual', userId: 'other' })).status).toBe(400);
  expect(agent.session).not.toHaveBeenCalled();
  agent.session.mockResolvedValue({ contractVersion: 3, conversationId, sessionKind: 'manual', messages: [] });
  expect((await call('/v3/session', 'POST', { kind: 'manual' })).status).toBe(200);
  expect(agent.session).toHaveBeenCalledWith('synthetic-owner', 'manual');
});
test('SSE exposes controlled tool steps and only the validated terminal result', async () => {
  const input = { message: '合成待办', requestId: randomUUID(), conversationId, consent: true };
  agent.chat.mockImplementation(async (_user, _input, emit) => {
    emit('status', { stage: 'selecting' });
    emit('tool', { tool: 'list_choices', domain: 'finance', bytes: 600, records: 3 });
    return { contractVersion: 3, answer: '请核对草稿', conversationId, request: { requestId: input.requestId, providerCalls: 2, maxProviderCalls: 5 } };
  });
  const response = await call('/v3/chat/stream', 'POST', input);
  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
  const body = await response.text();
  expect(body).toContain('event: status'); expect(body).toContain('event: tool'); expect(body).toContain('event: done');
  expect(body).toContain('"contractVersion":3');
});
test('provider and authorization errors retain a trace and never retry', async () => {
  const error = Object.assign(new AiError('需要授权', 403, 'AI_DOMAIN_NOT_GRANTED'), { missingDomains: ['account'], requestId: randomUUID(), providerCalls: 1 });
  agent.chat.mockRejectedValue(error);
  const response = await call('/v3/chat', 'POST', { message: '查余额' });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: error.code, missingDomains: ['account'], traceId: expect.any(String), providerCalls: 1 });
  expect(agent.chat).toHaveBeenCalledTimes(1);
});

test('a result-claim mismatch returns a friendly failure and receipt lookup cannot request another model call', async () => {
  let error;
  try { assertResultClaims('已整理8.50元草稿，请确认。', { artifacts: [], currentReceipts: [] }); } catch (value) { error = value; }
  Object.assign(error, { requestId: randomUUID(), providerCalls: 2 }); agent.chat.mockRejectedValue(error);
  const response = await call('/v3/chat', 'POST', { message: '合成验收' });
  expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH',
    message: expect.stringContaining('没有对应'), requestId: error.requestId, providerCalls: 2, traceId: expect.any(String) });
  service.getRequestReceipt.mockResolvedValue({ contractVersion: 3, status: 'failed', requestId: error.requestId, providerCalls: 2,
    error: { code: error.code, message: error.message } });
  const receipt = await call('/v3/requests/' + error.requestId);
  expect((await receipt.json()).data).toMatchObject({ status: 'failed', providerCalls: 2, error: { code: 'AI_RESULT_CLAIM_MISMATCH' } });
  expect(agent.chat).toHaveBeenCalledTimes(1);
});
test.each([[429, 'AI_RATE_LIMIT', 42], [503, 'AI_REQUEST_BUSY', 1]])('admission %s returns a retry delay without retrying the agent', async (status, code, retryAfterSeconds) => {
  agent.chat.mockRejectedValue(Object.assign(new AiError('稍后再试', status, code), { retryAfterSeconds, providerCalls: 0 }));
  const response = await call('/v3/chat/stream', 'POST', { message: '合成验收' });
  expect(response.status).toBe(status); expect(response.headers.get('retry-after')).toBe(String(retryAfterSeconds));
  expect(await response.json()).toMatchObject({ code, retryAfterSeconds, providerCalls: 0 });
  expect(agent.chat).toHaveBeenCalledTimes(1);
});

test('SSE reports waiting then a bounded busy failure after headers have already been sent', async () => {
  agent.chat.mockImplementation(async (_owner, _input, emit) => {
    emit('status', { stage: 'queued' });
    throw Object.assign(new AiError('等待已达上限', 503, 'AI_REQUEST_BUSY'), { retryAfterSeconds: 1, providerCalls: 0 });
  });
  const response = await call('/v3/chat/stream', 'POST', { message: '合成验收' });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('"stage":"queued"'); expect(body).toContain('event: error');
  expect(body).toContain('"code":"AI_REQUEST_BUSY"'); expect(body).toContain('"retryAfterSeconds":1');
  expect(body).not.toContain('event: done'); expect(agent.chat).toHaveBeenCalledTimes(1);
});

test('read-only receipt retrieval keeps the owner and never dispatches a new chat', async () => {
  const id = randomUUID();
  service.getRequestReceipt.mockResolvedValue({ contractVersion: 3, requestId: id, status: 'completed', providerCalls: 2 });
  expect((await call('/v3/requests/' + id)).status).toBe(200);
  expect(service.getRequestReceipt).toHaveBeenCalledWith('synthetic-owner', id);
  expect((await call('/v3/requests/' + id, 'POST', {})).status).toBe(404);
  expect(agent.chat).not.toHaveBeenCalled();
});
