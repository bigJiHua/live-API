// 2026-11-08：环境凭据模式已停用，接入商 Key/地址/模型只能来自 ai_provider_profile。
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
const PROFILE_URL = 'https://profile-provider.test/compatible';
const SECOND_URL = 'https://second-provider.test/v1';
const GLOBAL_KEY = 'synthetic-environment-key';
const PROFILE_KEY = 'synthetic-profile-key';
const SECOND_KEY = 'synthetic-second-key';
const EXPLICIT_KEY = 'synthetic-explicit-key';
// 环境里的 Key 必须被完全忽略；接入商 Config 只能来自 ai_provider_profile。
const env = testEnv({ AI_ALLOW_SESSION_SETTINGS: 'true', AI_BASE_URL: GLOBAL_URL, DEEPSEEK_API_KEY: GLOBAL_KEY,
  AI_API_KEY: GLOBAL_KEY });

function service({ profiles = [], selectedEnv = env } = {}) {
  const settingsStore = createSettingsStore();
  for (const profile of profiles) settingsStore.save('owner-a', profile);
  return createTestService({ env: selectedEnv, settingsStore });
}

beforeEach(() => {
  axios.get.mockReset();
  axios.get.mockResolvedValue({ data: { data: [{ id: 'compatible-model' }] } });
});

test('environment credentials can no longer list models without a saved provider', async () => {
  await expect(service().fetchProviderModels('owner-a')).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('the saved provider supplies both target and Key when both are omitted', async () => {
  await service({ profiles: [{ apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' }] })
    .fetchProviderModels('owner-a');
  expect(axios.get.mock.calls[0][0]).toBe(`${PROFILE_URL}/models`);
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${PROFILE_KEY}`);
});

test('a connectionId selects its own provider even when several are saved', async () => {
  const store = createSettingsStore();
  store.save('owner-a', { apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' });
  store.save('owner-a', { apiUrl: SECOND_URL, apiKey: SECOND_KEY, model: 'second-model' });
  const target = store.list('owner-a').find(item => item.apiUrl === SECOND_URL);
  const app = createTestService({ env, settingsStore: store });
  await app.fetchProviderModels('owner-a', { connectionId: target.connectionId });
  expect(axios.get.mock.calls[0][0]).toBe(`${SECOND_URL}/models`);
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${SECOND_KEY}`);
});

test.each([SECOND_URL, 'https://profile-provider.test/v2', 'https://profile-provider.test:444/compatible'])
('an omitted Key cannot be sent to an unbound target %s', async apiUrl => {
  await expect(service({ profiles: [{ apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' }] })
    .fetchProviderModels('owner-a', { apiUrl })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('equivalent normalized base addresses permit same-target reuse without environment help', async () => {
  await service({ profiles: [{ apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' }] })
    .fetchProviderModels('owner-a', { apiUrl: 'HTTPS://PROFILE-PROVIDER.TEST:443/compatible///' });
  expect(axios.get.mock.calls[0][0]).toBe(`${PROFILE_URL}/models`);
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${PROFILE_KEY}`);
});

test('a different owner cannot reuse the first owner profile Key', async () => {
  const store = createSettingsStore();
  store.save('owner-a', { apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' });
  const app = createTestService({ env, settingsStore: store });
  await expect(app.fetchProviderModels('owner-b', { apiUrl: PROFILE_URL })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('an explicitly supplied valid Key retains multi-provider support', async () => {
  await service({ profiles: [{ apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' }] })
    .fetchProviderModels('owner-a', { apiUrl: 'https://new-provider.test/v1', apiKey: EXPLICIT_KEY });
  expect(axios.get.mock.calls[0][0]).toBe('https://new-provider.test/v1/models');
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${EXPLICIT_KEY}`);
});

test('a saved provider Key persists past any clock time and stays bound to its target (D-028)', async () => {
  let clock = 1000;
  const store = createSettingsStore({ now: () => clock });
  store.save('owner-a', { apiUrl: PROFILE_URL, apiKey: PROFILE_KEY, model: 'profile-model' });
  const app = createTestService({ env, settingsStore: store });
  clock = 999999; // 远超旧 60 分钟 TTL：接入商 Key 现在持久化，重启/多端共享
  await app.fetchProviderModels('owner-a', { apiUrl: PROFILE_URL });
  expect(axios.get.mock.calls[0][0]).toBe(`${PROFILE_URL}/models`);
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${PROFILE_KEY}`);
  await expect(app.fetchProviderModels('owner-a', { apiUrl: 'https://other-provider.test/v1' }))
    .rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test.each(['short', 'synthetic\r\nAuthorization', {}, false, 42])('invalid explicit credentials are rejected before requesting models', async apiKey => {
  await expect(service().fetchProviderModels('owner-a', { apiUrl: GLOBAL_URL, apiKey })).rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('no saved provider and no explicit credentials means no provider request', async () => {
  await expect(service().fetchProviderModels('owner-a'))
    .rejects.toMatchObject({ code: 'AI_KEY_REQUIRED' });
  expect(axios.get).not.toHaveBeenCalled();
});
