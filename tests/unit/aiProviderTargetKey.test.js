jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Provider target test must not open DB'); }),
  getConnection: jest.fn(() => { throw new Error('Provider target test must not open DB'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Provider target test must not open DB'); }) }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const { createTestService, testEnv } = require('../helpers/aiFixture');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');

const GLOBAL_URL = 'https://global-provider.test/v1';
const SESSION_URL = 'https://session-provider.test/compatible';
const GLOBAL_KEY = 'synthetic-environment-key';
const SESSION_KEY = 'synthetic-session-key';
const EXPLICIT_KEY = 'synthetic-explicit-key';
const env = testEnv({ AI_ALLOW_SESSION_SETTINGS: 'true', AI_BASE_URL: GLOBAL_URL, DEEPSEEK_API_KEY: GLOBAL_KEY });

function service({ session = false, clock = () => 1000, ttl = 100, selectedEnv = env } = {}) {
  const settingsStore = createSettingsStore({ now: clock, ttl });
  if (session) settingsStore.save('owner-a', { apiUrl: SESSION_URL, apiKey: SESSION_KEY, model: 'compatible-model' });
  return createTestService({ env: selectedEnv, settingsStore });
}

beforeEach(() => {
  axios.get.mockReset();
  axios.get.mockResolvedValue({ data: { data: [{ id: 'compatible-model' }] } });
});

test('the configured environment Key is reused only for its bound base', async () => {
  await service().fetchProviderModels('owner-a');
  expect(axios.get).toHaveBeenCalledWith(`${GLOBAL_URL}/models`, expect.objectContaining({
    headers: { Authorization: `Bearer ${GLOBAL_KEY}` }, maxRedirects: 0,
  }));
});

test.each(['https://other-provider.test/v1', 'https://global-provider.test/v2', 'https://global-provider.test:444/v1'])(
  'an omitted Key cannot be sent to a new target %s', async apiUrl => {
    await expect(service().fetchProviderModels('owner-a', { apiUrl })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
    expect(axios.get).not.toHaveBeenCalled();
  }
);

test('equivalent normalized base addresses permit same-target reuse', async () => {
  await service().fetchProviderModels('owner-a', { apiUrl: 'HTTPS://GLOBAL-PROVIDER.TEST:443/v1///' });
  expect(axios.get.mock.calls[0][0]).toBe(`${GLOBAL_URL}/models`);
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${GLOBAL_KEY}`);
});

test('omitting target and Key uses the owner session target and its own Key', async () => {
  await service({ session: true }).fetchProviderModels('owner-a');
  expect(axios.get.mock.calls[0][0]).toBe(`${SESSION_URL}/models`);
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${SESSION_KEY}`);
});

test('changing away from the session never leaks its saved Key', async () => {
  await expect(service({ session: true }).fetchProviderModels('owner-a', { apiUrl: 'https://new-provider.test/v1' }))
    .rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('an existing global target uses its bound global Key rather than a different session Key', async () => {
  await service({ session: true }).fetchProviderModels('owner-a', { apiUrl: GLOBAL_URL });
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${GLOBAL_KEY}`);
});

test('an explicitly supplied valid Key retains multi-provider support', async () => {
  await service({ session: true }).fetchProviderModels('owner-a', { apiUrl: 'https://new-provider.test/v1', apiKey: EXPLICIT_KEY });
  expect(axios.get.mock.calls[0][0]).toBe('https://new-provider.test/v1/models');
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${EXPLICIT_KEY}`);
});

test('a different owner cannot reuse the first owner session Key', async () => {
  await expect(service({ session: true }).fetchProviderModels('owner-b', { apiUrl: SESSION_URL }))
    .rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('an expired session Key cannot be reused for its former target', async () => {
  let clock = 1000;
  const s = service({ session: true, clock: () => clock });
  clock = 1100;
  await expect(s.fetchProviderModels('owner-a', { apiUrl: SESSION_URL })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test.each(['short', 'synthetic\r\nAuthorization', {}, false, 42])('invalid explicit credentials are rejected before requesting models', async apiKey => {
  await expect(service().fetchProviderModels('owner-a', { apiUrl: GLOBAL_URL, apiKey })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('no configured credentials means no provider request', async () => {
  await expect(service({ selectedEnv: { ...env, DEEPSEEK_API_KEY: undefined } }).fetchProviderModels('owner-a'))
    .rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});
