jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Contract test must not access DB'); }),
  getConnection: jest.fn(() => { throw new Error('Contract test must not access DB'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Contract test must not access DB'); }) }));
jest.mock('axios', () => ({ get: jest.fn(() => { throw new Error('Unexpected provider call'); }),
  post: jest.fn(() => { throw new Error('Unexpected provider call'); }) }));
const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createAiRouter } = require('../../src/modules/ai/api');
const { createLegacyTestService: createTestService, testEnv } = require('../helpers/aiFixture');

describe('AI HTTP contract and authority boundary', () => {
  let server, base, service;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const guard = (req, res, next) => {
      if (!req.headers['x-test-user']) return res.status(401).json({ status: 401 });
      req.userId = req.headers['x-test-user']; next();
    };
    service = createTestService();
    // The archived service fixture exercises shared draft/middleware safety.
    // Actual V3 reasoning and old-route retirement have separate tests.
    app.use('/api/v1/ai', createAiRouter({ guard, env: testEnv(), service,
      agent: { chat: (user, input, _emit, control) => service.run(user, input, control) } }));
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    base = `http://127.0.0.1:${server.address().port}/api/v1/ai`;
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    const db = require('../../src/common/config/db');
    expect(db.execute).not.toHaveBeenCalled(); expect(db.getConnection).not.toHaveBeenCalled();
    expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
    expect(require('axios').post).not.toHaveBeenCalled();
  });
  async function post(data, user = 'a') {
    return fetch(`${base}/v3/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user },
      body: JSON.stringify({ data }) });
  }
  test('authentication required and capabilities declare no formal write', async () => {
    expect((await fetch(`${base}/capabilities`)).status).toBe(401);
    const response = await fetch(`${base}/capabilities`, { headers: { 'x-test-user': 'a' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).data).toMatchObject({ contractVersion: 3, mode: 'deepseek',
      dataSource: 'user-readonly', requiresConsent: true, formalWriteEnabled: false });
  });
  test('query through HTTP returns server evidence; request contains no client identity', async () => {
    const response = await post({ message: '本月收支情况', scene: 'query', consent: true }, 'query_user');
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.trace[0]).toMatchObject({ tool: 'query_finance_summary', readOnly: true, result: { expense: '51.20' } });
    expect(result.source).toBe('user-readonly');
    expect(result.draft).toBeNull();
  });
  test('proposal belongs to its owner; pending drafts cannot commit and legacy confirm remains 404', async () => {
    const response = await post({ message: '昨天余额账户午饭32元，支付宝付款', scene: 'draft', consent: true }, 'draft_user');
    expect(response.status).toBe(200);
    const draft = (await response.json()).data.draft;
    expect((await fetch(`${base}/drafts/${draft.id}`, { headers: { 'x-test-user': 'other_user' } })).status).toBe(404);
    expect((await fetch(`${base}/drafts/${draft.id}`, { headers: { 'x-test-user': 'draft_user' } })).status).toBe(200);
    expect((await fetch(`${base}/drafts/${draft.id}/confirm`, { method: 'POST', headers: { 'x-test-user': 'draft_user' } })).status).toBe(404);
    expect((await fetch(`${base}/drafts/${draft.id}/commit`, { method: 'POST',
      headers: { 'x-test-user': 'draft_user', 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { version: draft.version } }) })).status).toBe(409);
  });
  test('client-supplied user or tool messages rejected via HTTP', async () => {
    const response = await post({ message: '查询', scene: 'query', consent: true, userId: 'victim' }, 'bad_user');
    expect(response.status).toBe(400);
  });
  test('an actual HTTP OCR disconnect reaches the provider and keeps a readable nonreplayable failed receipt', async () => {
    let begin, release, cancelled;
    const started = new Promise(resolve => { begin = resolve; });
    const stopped = new Promise(resolve => { cancelled = resolve; });
    let calls = 0;
    const localService = createTestService({ recognizeImage: async (_config, _image, _today, _message, control) => {
      calls++; control.signal.addEventListener('abort', cancelled, { once: true }); begin();
      return new Promise(resolve => { release = resolve; });
    } });
    const app = express(); app.use(express.json());
    app.use('/ai', createAiRouter({ guard: (req, _res, next) => { req.userId = 'ocr_departure'; next(); }, service: localService, env: testEnv() }));
    const instance = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const localBase = `http://127.0.0.1:${instance.address().port}/ai`, requestId = crypto.randomUUID();
    const dataUrl = 'data:image/png;base64,' + (await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64');
    const data = { requestId, image: { dataUrl }, consent: true };
    try {
      const departing = http.request(localBase + '/v3/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      departing.on('error', () => {}); departing.end(JSON.stringify({ data }));
      await started; departing.destroy(); await stopped;
      let receipt;
      for (let attempt = 0; attempt < 10; attempt++) {
        receipt = await localService.getRequestReceipt('ocr_departure', requestId);
        if (receipt.status === 'failed') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(receipt).toMatchObject({ status: 'failed', providerCalls: 1, error: { code: 'AI_REQUEST_CANCELLED' } });
      release({ documentType: 'unknown', items: [], warnings: [], truncated: false });
      await new Promise(resolve => setImmediate(resolve));
      const repeat = await fetch(localBase + '/v3/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      expect(repeat.status).toBe(409);
      expect(await repeat.json()).toMatchObject({ code: 'AI_REQUEST_CANCELLED', requestId, traceId: expect.any(String) });
      expect(calls).toBe(1);
      expect((await localService.listConversations('ocr_departure'))[0].messageCount).toBe(0);
    } finally { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); await localService.close(); }
  });
  test('temporary draft read failure remains retryable instead of being reported as an expired proposal', async () => {
    const original = service.getDraft;
    service.getDraft = async () => { throw new Error('synthetic storage failure'); };
    try {
      const response = await fetch(`${base}/drafts/test`, { headers: { 'x-test-user': 'read_failure' } });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'AI_DRAFT_READ_FAILED' });
    } finally { service.getDraft = original; }
  });
  test('rate guard admits normal bursts and blocks beyond thirty requests per user', async () => {
    for (let i = 0; i < 30; i++) expect((await post({ message: '本月收支', scene: 'query', consent: true }, 'limited')).status).toBe(200);
    expect((await post({ message: '本月收支', scene: 'query', consent: true }, 'limited')).status).toBe(429);
  });
});
