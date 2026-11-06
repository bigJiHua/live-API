jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Key target test must not access DB'); }),
  getConnection: jest.fn(() => { throw new Error('Key target test must not access DB'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Key target test must not access DB'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const { createTestService, testEnv } = require('../helpers/aiFixture');
const original = { apiUrl: 'https://provider-one.test/v1', apiKey: 'synthetic-original-key', model: 'model-one' };
const newKey = 'synthetic-new-target-key';
const update = apiUrl => ({ apiUrl, model: 'model-two' });

test.each([
  'https://provider-one.test/v1', 'https://provider-one.test/v1/',
  'https://PROVIDER-ONE.TEST:443/v1', 'https://provider-one.test/a/../v1',
])('omitting a Key only reuses it for the same normalized target %s', apiUrl => {
  const store = createSettingsStore();
  expect(store.validate(update(apiUrl), original)).toEqual({
    apiUrl: original.apiUrl, apiKey: original.apiKey, model: 'model-two',
  });
});

test('legacy saved target trailing slashes normalize before comparing Key ownership', () => {
  const store = createSettingsStore();
  expect(store.validate(update(original.apiUrl), { ...original, apiUrl: original.apiUrl + '/' }).apiKey).toBe(original.apiKey);
});

test.each([
  'https://provider-two.test/v1', 'https://provider-one.test.evil.test/v1',
  'https://provider-one.test:444/v1', 'https://provider-one.test/v2',
  'https://provider-one.test/v1/compatible', 'http://127.0.0.1:1234/v1',
])('a new normalized target %s cannot inherit the previous Key', apiUrl => {
  const store = createSettingsStore();
  expect(() => store.validate(update(apiUrl), original)).toThrow();
  try {
    store.validate(update(apiUrl), original);
  } catch (error) {
    expect(error.code).toBe('AI_KEY_REQUIRED');
    expect(error.message).not.toContain(original.apiKey);
  }
});

test.each(['https://provider-two.test/v1', 'https://provider-one.test/v2', 'http://127.0.0.1:1234/v1'])
('an explicitly supplied Key permits the chosen compatible target %s', apiUrl => {
  const store = createSettingsStore();
  expect(store.validate({ ...update(apiUrl), apiKey: newKey }, original)).toMatchObject({ apiUrl, apiKey: newKey });
});

test.each(['', '   ', null, 'short'])('an explicitly empty or invalid Key %p is never silently replaced', apiKey => {
  const store = createSettingsStore();
  expect(() => store.validate({ ...update('https://provider-two.test/v1'), apiKey }, original)).toThrow();
});

test('initial settings and an expired or missing current record require an explicit Key', () => {
  const store = createSettingsStore();
  expect(() => store.validate(update(original.apiUrl), null)).toThrow();
  expect(() => store.validate(update(original.apiUrl), { apiUrl: original.apiUrl })).toThrow();
});

test('a rejected target change cannot make a connection request or replace the existing session', async () => {
  const store = createSettingsStore();
  const checkConnection = jest.fn().mockResolvedValue();
  const service = createTestService({ env: testEnv({ AI_ALLOW_SESSION_SETTINGS: 'true' }), settingsStore: store, checkConnection });
  const first = await service.configure('owner', original);
  checkConnection.mockClear();
  await expect(service.configure('owner', update('https://provider-two.test/v1'))).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(checkConnection).not.toHaveBeenCalled();
  expect(store.get('owner')).toMatchObject({ ...original, connectionId: first.connectionId });
  expect(service.getSettings('owner').connectionId).toBe(first.connectionId);
  expect(require('axios').get).not.toHaveBeenCalled();
  expect(require('axios').post).not.toHaveBeenCalled();
});

test('same-target model changes check the existing Key while explicit new-target settings check the new Key', async () => {
  const store = createSettingsStore();
  const checkConnection = jest.fn().mockResolvedValue();
  const service = createTestService({ env: testEnv({ AI_ALLOW_SESSION_SETTINGS: 'true' }), settingsStore: store, checkConnection });
  await service.configure('owner', original);
  checkConnection.mockClear();
  await service.configure('owner', update(original.apiUrl + '/'));
  expect(checkConnection).toHaveBeenLastCalledWith(expect.objectContaining({ apiUrl: original.apiUrl, apiKey: original.apiKey }));
  await service.configure('owner', { ...update('https://provider-two.test/v1'), apiKey: newKey });
  expect(checkConnection).toHaveBeenLastCalledWith(expect.objectContaining({ apiUrl: 'https://provider-two.test/v1', apiKey: newKey }));
  expect(store.get('owner').apiKey).toBe(newKey);
});

afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
});
