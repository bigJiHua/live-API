const { getConfig, turnTimeoutMs } = require('../../src/modules/ai/service/config');
test('turn deadline is shared and bounded, with environment-specific defaults', () => {
  expect(turnTimeoutMs({ NODE_ENV: 'development' })).toBe(240000);
  expect(turnTimeoutMs({ NODE_ENV: 'production' })).toBe(120000);
  expect(turnTimeoutMs({ AI_V3_TURN_TIMEOUT_MS: '300000' })).toBe(300000);
  for (const value of ['29999', '300001', 'bad', '3.5'])
    expect(turnTimeoutMs({ AI_V3_TURN_TIMEOUT_MS: value })).toBe(120000);
});
test('turn usage budget stays configurable and bounded while the default remains 30000', () => {
  expect(getConfig({}).maxUsageTokens).toBe(30000);
  expect(getConfig({ AI_V3_MAX_USAGE_TOKENS: '100000' }).maxUsageTokens).toBe(100000);
  expect(getConfig({ AI_V3_MAX_USAGE_TOKENS: '10000000' }).maxUsageTokens).toBe(10000000);
  for (const value of ['999', '10000001', '3.5', 'bad', '-1'])
    expect(() => getConfig({ AI_V3_MAX_USAGE_TOKENS: value })).toThrow();
});

test('per-call output budget accepts the GLM maximum and rejects invalid limits', () => {
  expect(getConfig({}).maxOutputTokens).toBeNull();
  expect(getConfig({ AI_V3_MAX_OUTPUT_TOKENS: '131072' }).maxOutputTokens).toBe(131072);
  expect(getConfig({ AI_V3_MAX_OUTPUT_TOKENS: 'max' }).maxOutputTokens).toBe(393216);
  expect(getConfig({ AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4', AI_MODEL: 'glm-4v-flash',
    AI_V3_MAX_OUTPUT_TOKENS: '131072' }).maxOutputTokens).toBe(1024);
  for (const value of ['0', '393217', '3.5', 'bad', '-1'])
    expect(() => getConfig({ AI_V3_MAX_OUTPUT_TOKENS: value })).toThrow();
});
