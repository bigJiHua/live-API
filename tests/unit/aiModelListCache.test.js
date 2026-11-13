jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const { createTestService } = require('../helpers/aiFixture');
const { MODEL_LIST_TTL_MS } = require('../../src/modules/ai/service/modelListCache');

const url = 'https://models.test/v1', key = 'synthetic-model-key';
let store, app, clock;
beforeEach(() => {
  clock = Date.parse('2026-11-10T08:00:00Z');
  store = createSettingsStore();
  store.save('owner-a', { apiUrl: url, apiKey: key, model: 'first-model' });
  store.save('owner-b', { apiUrl: url, apiKey: key, model: 'first-model' });
  app = createTestService({ settingsStore: store, now: () => new Date(clock) });
  axios.get.mockReset().mockResolvedValue({ data: { data: [{ id: 'first-model' }, { id: 'second-model' }] } });
});

test('repeated reads use ten-minute cache and cannot mutate the stored model list', async () => {
  const first = await app.fetchProviderModels('owner-a'); first.models.push('injected-model');
  for (let i = 0; i < 8; i++) {
    expect((await app.fetchProviderModels('owner-a')).models).toEqual(['first-model', 'second-model']);
  }
  expect(axios.get).toHaveBeenCalledTimes(1);
  clock += MODEL_LIST_TTL_MS;
  await app.fetchProviderModels('owner-a');
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('concurrent callers share one provider request and separate result arrays', async () => {
  let finish;
  axios.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = Array.from({ length: 8 }, () => app.fetchProviderModels('owner-a'));
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  expect(axios.get).toHaveBeenCalledTimes(1);
  finish({ data: { data: [{ id: 'first-model' }] } });
  const results = await Promise.all(pending);
  results[0].models.push('injected-model');
  expect(results[1].models).toEqual(['first-model']);
});

test('users, normalized target paths and credential changes have independent caches', async () => {
  await app.fetchProviderModels('owner-a');
  await app.fetchProviderModels('owner-b');
  await app.fetchProviderModels('owner-a', { apiUrl: 'HTTPS://MODELS.TEST:443/v1///' });
  await app.fetchProviderModels('owner-a', { apiUrl: 'https://models.test/v2', apiKey: key });
  await app.fetchProviderModels('owner-a', { apiKey: 'synthetic-replacement-key' });
  expect(axios.get).toHaveBeenCalledTimes(4);
});

test('failed requests are not cached and concurrent failures allow a later manual retry', async () => {
  axios.get.mockRejectedValueOnce({ response: { status: 429 } });
  await expect(app.fetchProviderModels('owner-a')).rejects.toMatchObject({ status: 502, code: 'AI_PROVIDER_RATE_LIMIT' });
  await app.fetchProviderModels('owner-a');
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('refresh quota counts misses only, including changed credentials', async () => {
  for (let i = 0; i < 5; i++) await app.fetchProviderModels('owner-a', { apiKey: 'synthetic-key-' + i });
  await expect(app.fetchProviderModels('owner-a', { apiKey: 'synthetic-key-5' }))
    .rejects.toMatchObject({ status: 429, code: 'AI_MODELS_RATE_LIMIT', retryAfterSeconds: 60 });
  await app.fetchProviderModels('owner-a', { apiKey: 'synthetic-key-0' });
  expect(axios.get).toHaveBeenCalledTimes(5);
  clock += 60000;
  await app.fetchProviderModels('owner-a', { apiKey: 'synthetic-key-5' });
  expect(axios.get).toHaveBeenCalledTimes(6);
});

test('deleted connections and invalid keys cannot bypass validation through a cache hit', async () => {
  const connectionId = store.list('owner-a')[0].connectionId;
  await app.fetchProviderModels('owner-a', { connectionId });
  store.remove('owner-a', connectionId);
  await expect(app.fetchProviderModels('owner-a', { connectionId })).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_FOUND' });
  await expect(app.fetchProviderModels('owner-a', { apiKey: 'bad' })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).toHaveBeenCalledTimes(1);
});
