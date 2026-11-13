// 负责人 2026-11-10：余额查询按供应商契约分发对接。核实（docs.bigmodel.cn 官方文档/FAQ）：
// 仅 DeepSeek 官方提供 GET /user/balance；GLM(bigmodel.cn) 未开放余额 API（官方指引控制台
// 「财务总览」查看）；中转站等未知接入商无契约。回归锁：hostname 精确分发（URL 路径伪装
// 不误判）+ 说明文案带实际 host（防多端激活切换时说明挂错接入商名下）。
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getConnection: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const { createAiService } = require('../../src/modules/ai/service');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');

// real-provider 模式下 getConfig 强制校验只读 DB 配置（getBalance 不连库，假凭据仅过校验）
const ENV = { AI_MODE: 'deepseek', AI_DB_HOST: 'not-connected', AI_DB_NAME: 'unit',
  AI_DB_USER: 'readonly', AI_DB_PASSWORD: 'unit' };
const serviceWith = apiUrl => {
  const settingsStore = createSettingsStore();
  settingsStore.save('owner', { apiUrl, apiKey: 'unit-key-123456', model: 'test-model' });
  return createAiService({ env: { ...ENV }, settingsStore, conversationStore: {} });
};

afterEach(() => axios.get.mockReset());

test('deepseek host queries the official /user/balance endpoint', async () => {
  axios.get.mockResolvedValue({ data: { is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '1.00', topped_up_balance: '11.34' }] } });
  const service = serviceWith('https://api.deepseek.com');
  const balance = await service.getBalance('owner');
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(String(axios.get.mock.calls[0][0])).toBe('https://api.deepseek.com/user/balance');
  expect(balance).toEqual({ isAvailable: true, currency: 'CNY',
    totalBalance: '12.34', grantedBalance: '1.00', toppedUpBalance: '11.34' });
});

test('bigmodel host explains that Zhipu has no balance API instead of calling it', async () => {
  const service = serviceWith('https://open.bigmodel.cn/api/paas/v4');
  await expect(service.getBalance('owner')).rejects.toMatchObject({
    code: 'AI_BALANCE_UNSUPPORTED',
    message: expect.stringContaining('open.bigmodel.cn'),
  });
  expect(axios.get).not.toHaveBeenCalled();
});

test('unknown provider host gets a host-branded fallback note', async () => {
  const service = serviceWith('https://relay.example.com/v1');
  await expect(service.getBalance('owner')).rejects.toMatchObject({
    code: 'AI_BALANCE_UNSUPPORTED',
    message: expect.stringContaining('relay.example.com'),
  });
  expect(axios.get).not.toHaveBeenCalled();
});

test('deepseek.com inside the URL path cannot spoof the deepseek dispatch', async () => {
  const service = serviceWith('https://evil.test/deepseek.com');
  await expect(service.getBalance('owner')).rejects.toMatchObject({
    code: 'AI_BALANCE_UNSUPPORTED',
    message: expect.stringContaining('evil.test'),
  });
  expect(axios.get).not.toHaveBeenCalled();
});
test('balance follows the inspected provider when connectionId is given, not the active one', async () => {
  axios.get.mockResolvedValue({ data: { is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '9.99', granted_balance: '0.00', topped_up_balance: '9.99' }] } });
  const settingsStore = createSettingsStore();
  settingsStore.save('owner', { apiUrl: 'https://api.deepseek.com', apiKey: 'unit-key-123456', model: 'deepseek-flash' });
  const deepseek = settingsStore.get('owner');
  settingsStore.save('owner', { apiUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'unit-key-123456', model: 'glm-4.7' });
  const service = createAiService({ env: { ...ENV }, settingsStore, conversationStore: {} });
  const balance = await service.getBalance('owner', deepseek.connectionId);
  expect(axios.get).toHaveBeenCalledTimes(1);
  expect(String(axios.get.mock.calls[0][0])).toBe('https://api.deepseek.com/user/balance');
  expect(balance.totalBalance).toBe('9.99');
  // 不带 connectionId 仍查当前生效接入商（第二次保存的 bigmodel）
  await expect(service.getBalance('owner')).rejects.toMatchObject({
    code: 'AI_BALANCE_UNSUPPORTED',
    message: expect.stringContaining('open.bigmodel.cn'),
  });
});

test('balance query for an unknown connectionId fails with the provider-not-found contract', async () => {
  const service = serviceWith('https://api.deepseek.com');
  await expect(service.getBalance('owner', 'missing-connection')).rejects.toMatchObject({
    status: 404, code: 'AI_PROVIDER_NOT_FOUND' });
  expect(axios.get).not.toHaveBeenCalled();
});

test('malformed connectionId is rejected before any provider lookup', async () => {
  const service = serviceWith('https://api.deepseek.com');
  await expect(service.getBalance('owner', '../escape')).rejects.toMatchObject({
    code: 'AI_REQUEST_INVALID' });
  expect(axios.get).not.toHaveBeenCalled();
});