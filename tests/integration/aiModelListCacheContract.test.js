jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const express = require('express');
const axios = require('axios');
const { createAiRouter } = require('../../src/modules/ai/api');
const { createTestService } = require('../helpers/aiFixture');
let instance, base, service;
beforeEach(async () => {
  axios.get.mockReset().mockResolvedValue({ data: { data: [{ id: 'first-model' }] } });
  service = createTestService(); service.configure = jest.fn(async () => ({ configured: true }));
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ service, business: {}, agent: {},
    guard: (req, _res, next) => { req.userId = 'owner-a'; next(); } }));
  instance = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  base = `http://127.0.0.1:${instance.address().port}/ai`;
});
afterEach(async () => { await new Promise(resolve => instance.close(resolve)); });
const request = (path, data = {}, method = 'POST') => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });

test('settings quota and cached model reads do not block each other', async () => {
  for (let i = 0; i < 5; i++) expect((await request('/settings', {}, 'PUT')).status).toBe(200);
  for (let i = 0; i < 8; i++) expect((await request('/models')).status).toBe(200);
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect((await request('/settings', {}, 'PUT')).status).toBe(429);
});

test('overlapping model reads share success instead of returning an active-request 429', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => request('/models')));
  expect(results.map(result => result.status)).toEqual(Array(8).fill(200));
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('real refresh throttling reports its own code and retry time; hits still succeed', async () => {
  for (let i = 0; i < 5; i++) expect((await request('/models', { apiKey: 'synthetic-key-' + i })).status).toBe(200);
  const limited = await request('/models', { apiKey: 'synthetic-key-5' });
  expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
  expect((await limited.json()).code).toBe('AI_MODELS_RATE_LIMIT');
  expect((await request('/models', { apiKey: 'synthetic-key-0' })).status).toBe(200);
  expect(axios.get).toHaveBeenCalledTimes(5);
});
