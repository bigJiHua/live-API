jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('axios', () => ({ post: jest.fn(() => { throw new Error('Paid search forbidden'); }) }));
const { createEvalFixture } = require('../eval/offlineHarness');
const { createWebSearchTools } = require('../../src/modules/ai/service/webSearchTools');
const { getConfig } = require('../../src/modules/ai/service/config');
const { createResponseValidation } = require('../../src/modules/ai/service/responseValidation');
const env = { NODE_ENV: 'test', AI_MODE: 'deepseek', AI_BASE_URL: 'https://model.example.com', AI_API_KEY: 'fixture-model-key',
  AI_DB_HOST: 'localhost', AI_DB_NAME: 'isolated', AI_DB_USER: 'fixture-readonly', AI_DB_PASSWORD: 'fixture-password' };
const searchEnv = { ...env, AI_WEB_SEARCH_ENABLED: 'true', AI_SEARCH_BASE_URL: 'https://api.deepseek.com', AI_SEARCH_PROVIDER: 'deepseek', AI_SEARCH_API_KEY: 'fixture-site-secret' };
const searchConfig = () => getConfig(searchEnv);
const source = { title: '公开发布', url: 'https://example.com/news', snippet: '公开消息已发布。', date: '2026-11-07' };
const caseDef = (overrides = {}) => ({ message: '搜索公开发布的资讯', mode: 'chat', datasets: [],
  toolScript: [['web_search', { query: '公开发布' }]], final: { answer: '公开消息已发布，来源 https://example.com/news 日期2026-11-07。' }, ...overrides });
const receipts = f => f.provider.mock.calls.flatMap(call => call[1].filter(item => item.role === 'tool').map(item => JSON.parse(item.content)));
function searchFixture(def = caseDef(), config = searchConfig()) {
  const client = jest.fn(async () => ({ results: [source] })), reserve = jest.fn(async () => true);
  const f = createEvalFixture(def, { config, webSearchTools: createWebSearchTools({ client }), searchBudget: { reserve } });
  return { ...f, client, reserve };
}

afterEach(() => expect(require('axios').post).not.toHaveBeenCalled());
test('getConfig→V3→search runner preserves source config and daily reservation field', async () => {
  const f = searchFixture(); const result = await f.send();
  expect(f.reserve).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  expect(f.client).toHaveBeenCalledTimes(1);
  expect(result.datasets).toEqual([]);
  expect(result.answer).toContain(source.url);
  expect(receipts(f)[0]).toMatchObject({ status: 'ok', untrusted: true });
  expect(f.provider.mock.calls[0][2].some(item => item.function.name === 'web_search')).toBe(true);
});
test.each([undefined, 'operate'])('mode %s denies forced search before external calls', async mode => {
  const f = searchFixture(caseDef({ mode }));
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_TOOL_DENIED' });
  expect(f.client).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  expect(f.provider.mock.calls[0][2].some(item => item.function.name === 'web_search')).toBe(false);
});
test('without configured search source a forced search fails closed', async () => {
  const f = searchFixture(caseDef(), getConfig(env));
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_TOOL_DENIED' });
  expect(f.client).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});
test('unconfigured and partially configured search preserve serialized provider messages, tools and options', async () => {
  const def = caseDef({ toolScript: [], final: { answer: '可以聊公开资料。' } });
  const first = searchFixture(def, getConfig(env));
  const second = searchFixture(def, getConfig({ ...env, AI_SEARCH_PROVIDER: 'deepseek' }));
  await first.send(); await second.send();
  const requestBytes = f => JSON.stringify(f.provider.mock.calls.map(call => call.slice(1)));
  expect(requestBytes(second)).toBe(requestBytes(first));
  expect(requestBytes(first)).not.toContain('web_search');
});
test('third search is a native tool error and never takes a paid allowance', async () => {
  const f = searchFixture(caseDef({ toolScript: ['first', 'second', 'third'].map(query => ['web_search', { query }]) }));
  await f.send();
  expect(f.client).toHaveBeenCalledTimes(2); expect(f.reserve).toHaveBeenCalledTimes(2);
  expect(receipts(f)).toContainEqual(expect.objectContaining({ code: 'AI_WEB_SEARCH_TURN_LIMIT' }));
});
test('identical searches reuse the daily cache while retaining per-turn accounting', async () => {
  const f = searchFixture(caseDef({ toolScript: [['web_search', { query: 'same' }], ['web_search', { query: 'same' }]] }));
  await f.send(); expect(f.client).toHaveBeenCalledTimes(1); expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(receipts(f)).toContainEqual(expect.objectContaining({ cached: true }));
});
test('external failures are error receipts and leave chat available', async () => {
  const f = searchFixture(caseDef({ final: { answer: '搜索暂时不可用。' } }));
  f.client.mockRejectedValue(new Error('Authorization: fixture-site-secret'));
  expect((await f.send()).answer).toContain('搜索暂时不可用');
  expect(JSON.stringify(receipts(f))).not.toContain('fixture-site-secret');
});
test('daily exhaustion returns tool error without searching', async () => {
  const f = searchFixture(caseDef({ final: { answer: '今天搜索额度已用尽。' } }));
  f.reserve.mockResolvedValue(false); await f.send();
  expect(f.client).not.toHaveBeenCalled();
  expect(receipts(f)[0]).toMatchObject({ code: 'AI_WEB_SEARCH_DAILY_LIMIT' });
});
test('private owner, phone and site search credential are removed before HTTP client', async () => {
  const f = searchFixture(caseDef({ toolScript: [['web_search', { query: 'news owner 13800138000 fixture-site-secret' }]] }));
  await f.send(); const sentQuery = f.client.mock.calls[0][1].query;
  expect(sentQuery).not.toContain('owner'); expect(sentQuery).not.toContain('13800138000'); expect(sentQuery).not.toContain('fixture-site-secret');
});
test('external search cannot set private claims scope or become a dataset', () => {
  const validation = createResponseValidation('chat'); validation.recordTool('web_search');
  expect(validation.forResult({ datasets: [] })).toMatchObject({ claimsScope: 'prose', privateSources: false });
  validation.recordTool('query_data');
  expect(validation.forResult({ datasets: [] })).toMatchObject({ claimsScope: 'business', privateSources: true });
});

test('external numbers cannot validate a ledger claim or construct a chart dataset', async () => {
  const { scrubModelProse } = require('../../src/modules/ai/service/v3AnswerPresentation');
  const { DATASETS } = require('../eval/offlineHarness');
  const f = searchFixture(); f.client.mockResolvedValue({ results: [{ ...source, snippet: '外部数字999999.99元' }] });
  const result = await f.send();
  expect(result.datasets).toEqual([]);
  expect(result.chart).toBeNull();
  expect(scrubModelProse('本月账本支出999999.99元。', [DATASETS['finance-monthly']])).not.toContain('999999.99');
});

test('mixed private reads retain verified web citations and hide unverified URLs', async () => {
  const f = searchFixture(caseDef({ datasets: ['finance-monthly'], toolScript: [['web_search', { query: 'public' }],
    ['query_data', { datasetId: 'finance-monthly', startDate: '2026-10-01', endDate: '2026-10-31' }]],
  final: { answer: '外部来源 https://example.com/news ，其他链接 https://unverified.example.com/page 。' } }));
  const result = await f.send();
  expect(result.datasets.map(item => item.datasetId)).toEqual(['finance-monthly']);
  expect(result.answer).toContain(source.url);
  expect(result.answer).not.toContain('https://unverified.example.com/page');
});
test.each([{ AI_SEARCH_BASE_URL: 'http://example.com' }, { AI_SEARCH_PROVIDER: 'other' }, { AI_WEB_SEARCH_DAILY_CALLS: '1001' },
  { AI_SEARCH_BASE_URL: 'https://example.com/?key=secret' }, { AI_SEARCH_TIMEOUT_MS: '999' }])('invalid complete site search config is rejected: %j', overrides => {
  expect(() => getConfig({ ...searchEnv, ...overrides })).toThrow();
});

test('分析模式同样可用联网（搜新闻正是分析场景）', async () => {
  const f = searchFixture(caseDef({ mode: 'analysis' }));
  const result = await f.send();
  expect(result.toolTrace.filter(t => t.tool === 'web_search')).toHaveLength(1);
  expect(f.client).toHaveBeenCalledTimes(1);
});
