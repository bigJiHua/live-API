jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public database forbidden'); }), getConnection: jest.fn() }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Public read pool forbidden'); }) }));
const express = require('express');
const { createAiRouter } = require('../../src/modules/ai/api');
const { createRolloutPolicy } = require('../../src/modules/ai/service/rolloutPolicy');
let server, base;
const agent = { chat: jest.fn(async () => ({ contractVersion: 3, answer: '合成答复' })) };
const service = { warmupSettings: jest.fn(), getRequestReceipt: jest.fn(async () => ({ status: 'completed' })) };
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ env: { AI_ROLLOUT_MODE: 'allowlist', AI_ROLLOUT_USER_IDS: 'trial-user' }, service, agent, business: {},
    guard: (req, res, next) => { req.userId = req.headers['x-test-user']; next(); } }));
  server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  base = `http://127.0.0.1:${server.address().port}/ai`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { agent.chat.mockClear(); service.warmupSettings.mockClear(); });
test.each(['/v3/chat', '/v3/chat/stream', '/v3/ocr', '/personalization/profile/generate'])('nontrial generation %s is rejected before warmup or execution', async endpoint => {
  const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'excluded-user' }, body: JSON.stringify({ data: { userId: 'trial-user', message: 'test' } }) });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AI_ROLLOUT_DENIED' });
  expect(agent.chat).not.toHaveBeenCalled(); expect(service.warmupSettings).not.toHaveBeenCalled();
});
test('trial users can generate while excluded users can still read durable receipts', async () => {
  const allowed = await fetch(base + '/v3/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'trial-user' }, body: JSON.stringify({ data: { message: 'test' } }) });
  expect(allowed.status).toBe(200); expect(agent.chat).toHaveBeenCalledTimes(1);
  const receipt = await fetch(base + '/v3/requests/old-request', { headers: { 'x-test-user': 'excluded-user' } });
  expect(receipt.status).toBe(200); expect(service.getRequestReceipt).toHaveBeenCalledWith('excluded-user', 'old-request');
});
test('empty allowlist fails closed and invalid rollout configuration is rejected', () => {
  expect(() => createRolloutPolicy({ AI_ROLLOUT_MODE: 'allowlist' }).assertAllowed('any')).toThrow(expect.objectContaining({ code: 'AI_ROLLOUT_DENIED' }));
  expect(() => createRolloutPolicy({ AI_ROLLOUT_MODE: 'typo' })).toThrow();
  expect(() => createRolloutPolicy({ AI_ROLLOUT_MODE: 'allowlist', AI_ROLLOUT_USER_IDS: '../bad' })).toThrow();
  expect(() => createRolloutPolicy().assertAllowed('any')).not.toThrow();
});
