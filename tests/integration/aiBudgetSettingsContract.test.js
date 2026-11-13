jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public database forbidden'); }), getConnection: jest.fn() }));
const express = require('express');
const { createAiRouter } = require('../../src/modules/ai/api');
const { createTestService } = require('../helpers/aiFixture');
let server, base;
const service = createTestService();
const values = { dailyProviderCalls: 10000, maxUsageTokens: 1000000, maxOutputTokens: 'max', providerTimeoutMs: 105000, turnTimeoutMs: 300000 };
const call = (method, data, owner = 'owner') => fetch(base, { method, headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-test-owner': owner } : {}) },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ service, business: {}, agent: {}, guard: (req, res, next) => {
    if (!req.headers['x-test-owner']) return res.status(401).json({ status: 401 });
    req.userId = req.headers['x-test-owner']; next();
  } }));
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}/ai/budget-settings`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
test('登录用户读取、提高和恢复本人配置，拒绝匿名请求及篡改身份', async () => {
  expect((await call('GET', undefined, null)).status).toBe(401);
  const saved = await call('PUT', { data: values }); expect(saved.status).toBe(200);
  expect((await saved.json()).data.values).toEqual(values);
  const other = (await (await call('GET', undefined, 'other')).json()).data;
  expect(other.overrides.dailyProviderCalls).toBeNull();
  const forged = await call('PUT', { ...values, userId: 'other' }); expect(forged.status).toBe(400);
  const restored = await call('PUT', Object.fromEntries(Object.keys(values).map(key => [key, null])));
  expect(restored.status).toBe(200); expect((await restored.json()).data.overrides.dailyProviderCalls).toBeNull();
});
