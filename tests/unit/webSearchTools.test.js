const { createWebSearchTools, isWebSearchTool, validateWebSearchTool, webSearchDefinitions } = require('../../src/modules/ai/service/webSearchTools');
const { createEgressPolicy } = require('../../src/modules/ai/service/egressPolicy');
const config = { searchEnabled: true, searchProvider: 'deepseek', searchBaseUrl: 'https://api.deepseek.com',
  searchApiKey: 'site-search-test-key', searchTimeoutMs: 10000, searchDailyLimit: 50 };
const receipt = { results: [{ title: '公开来源', url: 'https://news.example.com/article', snippet: '公开内容 100元', date: '2026-11-12' }] };
const dependencies = () => ({ egress: createEgressPolicy({ userId: 'private-user-id', extraSecrets: [config.searchApiKey] }), reserve: jest.fn().mockResolvedValue(true) });

describe('web search tools', () => {
  test('one definition and strict validation', () => {
    expect(webSearchDefinitions.map(x => x.function.name)).toEqual(['web_search']);
    expect(isWebSearchTool('web_search')).toBe(true);
    expect(isWebSearchTool('query_data')).toBe(false);
    expect(validateWebSearchTool('web_search', { query: '公开信息' })).toEqual({ query: '公开信息' });
    for (const args of [null, [], { query: '' }, { query: ' ' }, { query: 'x'.repeat(121) }, { query: 'a\nb' }, { query: 'ok', other: true }, { query: 'ok', recency: 'year' }]) {
      expect(() => validateWebSearchTool('web_search', args)).toThrow(expect.objectContaining({ code: 'AI_WEB_SEARCH_ARGUMENT_INVALID' }));
    }
  });
  test('unconfigured tools do not call client or reserve', async () => {
    const client = jest.fn(), deps = dependencies();
    expect(await createWebSearchTools({ client }).search({ ...config, searchEnabled: false }, { query: '新闻' }, deps)).toMatchObject({ status: 'error', code: 'AI_TOOL_DENIED' });
    expect(client).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
  });
  test('query must pass egress before HTTP or cache key and response must pass egress', async () => {
    const client = jest.fn().mockResolvedValue({ results: [{ ...receipt.results[0], title: 'private-user-id 的资讯', snippet: '联系电话 13800138000 及 site-search-test-key' }] });
    const deps = dependencies(), scrub = jest.spyOn(deps.egress, 'scrub');
    const result = await createWebSearchTools({ client }).search(config, { query: 'private-user-id 联系 13800138000 site-search-test-key' }, deps);
    expect(client.mock.calls[0][1].query).not.toMatch(/private-user-id|13800138000|site-search-test-key/);
    expect(scrub).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private-user-id|13800138000|site-search-test-key/);
    expect(result).toMatchObject({ status: 'ok', untrusted: true, cached: false });
    expect(result).not.toHaveProperty('datasets'); expect(result).not.toHaveProperty('claims');
  });
  test('privacy or budget dependency missing stops before external calls', async () => {
    const client = jest.fn().mockResolvedValue(receipt), tool = createWebSearchTools({ client });
    expect(await tool.search(config, { query: '新闻' })).toMatchObject({ status: 'error' });
    expect(await tool.search(config, { query: '新闻' }, { egress: dependencies().egress })).toMatchObject({ status: 'error', code: 'AI_WEB_SEARCH_BUDGET_UNAVAILABLE' });
    expect(client).not.toHaveBeenCalled();
  });
  test('daily budget exhausted or failing consumes no client call', async () => {
    const client = jest.fn(), tool = createWebSearchTools({ client }), deps = dependencies();
    deps.reserve.mockResolvedValue(false);
    expect(await tool.search(config, { query: '新闻' }, deps)).toMatchObject({ status: 'error', code: 'AI_WEB_SEARCH_DAILY_LIMIT' });
    deps.reserve.mockRejectedValue(new Error('SQL secret failure'));
    expect(await tool.search(config, { query: '新闻' }, deps)).toEqual({ status: 'error', code: 'AI_WEB_SEARCH_FAILED', message: '联网搜索暂时不可用', untrusted: true });
    expect(client).not.toHaveBeenCalled();
  });
  test('same scrubbed query shares same-day cache, with a fresh caller projection each time', async () => {
    const client = jest.fn().mockResolvedValue(receipt), deps = dependencies(), tool = createWebSearchTools({ client });
    await tool.search(config, { query: '新闻' }, deps);
    const other = dependencies(); other.egress = createEgressPolicy({ knownIds: ['公开来源'] });
    const second = await tool.search(config, { query: '新闻' }, other);
    expect(second.cached).toBe(true); expect(second.results[0].title).toBe('[内部标识]');
    expect(client).toHaveBeenCalledTimes(1); expect(deps.reserve).toHaveBeenCalledTimes(1); expect(other.reserve).not.toHaveBeenCalled();
  });
  test('midnight in Shanghai, source/key and recency changes invalidate cache', async () => {
    let time = Date.parse('2026-11-12T15:59:59Z');
    const client = jest.fn().mockResolvedValue(receipt), deps = dependencies(), tool = createWebSearchTools({ client, now: () => time });
    await tool.search(config, { query: '新闻' }, deps);
    expect(deps.reserve).toHaveBeenLastCalledWith({ day: '2026-11-12', limit: 50 });
    time += 2000;
    await tool.search(config, { query: '新闻' }, deps);
    await tool.search({ ...config, searchApiKey: 'rotated-key' }, { query: '新闻' }, deps);
    const zhipu = { ...config, searchProvider: 'zhipu', searchBaseUrl: 'https://open.bigmodel.cn' };
    await tool.search(zhipu, { query: '新闻', recency: 'week' }, deps);
    await tool.search(zhipu, { query: '新闻', recency: 'month' }, deps);
    expect(client).toHaveBeenCalledTimes(5);
    expect(deps.reserve).toHaveBeenLastCalledWith({ day: '2026-11-13', limit: 50 });
  });
  test('cache size is bounded and evicted queries need another reservation', async () => {
    const client = jest.fn().mockResolvedValue(receipt), deps = dependencies(), tool = createWebSearchTools({ client, maxCacheEntries: 1 });
    for (const query of ['甲新闻', '乙新闻', '甲新闻']) await tool.search(config, { query }, deps);
    expect(client).toHaveBeenCalledTimes(3); expect(deps.reserve).toHaveBeenCalledTimes(3);
  });
  test('concurrent identical queries reserve/pay once', async () => {
    let resolve;
    const client = jest.fn(() => new Promise(r => { resolve = r; })), deps = dependencies(), tool = createWebSearchTools({ client });
    const first = tool.search(config, { query: '新闻' }, deps), second = tool.search(config, { query: '新闻' }, deps);
    await Promise.resolve(); resolve(receipt);
    const results = await Promise.all([first, second]);
    expect(results.map(x => x.cached)).toEqual([false, true]);
    expect(client).toHaveBeenCalledTimes(1); expect(deps.reserve).toHaveBeenCalledTimes(1);
  });
  test('timeouts degrade to safe tool errors, failures are not cached or refunded', async () => {
    const client = jest.fn().mockRejectedValue(new Error('token leaked by remote transport')), deps = dependencies(), tool = createWebSearchTools({ client });
    for (let i = 0; i < 2; i++) expect(await tool.search(config, { query: '新闻' }, deps)).toEqual({ status: 'error', code: 'AI_WEB_SEARCH_FAILED', message: '联网搜索暂时不可用', untrusted: true });
    expect(client).toHaveBeenCalledTimes(2); expect(deps.reserve).toHaveBeenCalledTimes(2);
  });
  test('unsupported capability is rejected before reservation', async () => {
    const client = jest.fn(), deps = dependencies();
    expect(await createWebSearchTools({ client }).search(config, { query: '新闻', recency: 'week' }, deps)).toMatchObject({ code: 'AI_WEB_SEARCH_RECENCY_UNSUPPORTED' });
    expect(client).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
  });
  test('registered chat preview references never leave for a public search engine', async () => {
    const deps = dependencies(), client = jest.fn().mockResolvedValue(receipt), tool = createWebSearchTools({ client });
    const ref = deps.egress.project({ id: 'private-account-id' }, 'card').id;
    const historyRef = 'h_' + 'a'.repeat(32);
    // The real egress explicitly keeps its registered reference in chat previews.
    expect(deps.egress.scrub(ref)).toBe(ref);
    const result = await tool.search(config, { query: `公开 ${ref} ${historyRef}` }, deps);
    expect(result.status).toBe('ok');
    expect(client.mock.calls[0][1].query).not.toMatch(/(?:r|h)_[a-f0-9]{32}/i);
    expect(JSON.stringify(result)).not.toContain(ref);
  });
  test('registered opaque references in source URLs including multilevel encoding are rejected', async () => {
    const deps = dependencies(), ref = deps.egress.project({ id: 'private-account-id' }, 'card').id;
    const encoded = '%72' + ref.slice(1), doubled = '%2572' + ref.slice(1), historyRef = 'h_' + 'b'.repeat(32);
    const client = jest.fn().mockResolvedValue({ results: [ref, encoded, doubled, historyRef].map(value =>
      ({ ...receipt.results[0], url: `https://example.com/${value}` })).concat(receipt.results) });
    const result = await createWebSearchTools({ client }).search(config, { query: '新闻' }, deps);
    expect(result.results).toEqual(receipt.results);
  });
  test('response fields are bounded and URLs containing a caller secret are omitted', async () => {
    const client = jest.fn().mockResolvedValue({ results: [{ title: '标'.repeat(900), url: 'https://example.com/story', snippet: '字'.repeat(2000), date: null },
      { ...receipt.results[0], url: 'https://example.com/private-user-id' }] });
    const result = await createWebSearchTools({ client }).search(config, { query: '新闻' }, dependencies());
    expect(result.results).toHaveLength(1); expect(result.results[0].title.length).toBe(160); expect(result.results[0].snippet.length).toBe(500);
  });
  test('encoded source credentials and invalid date text cannot bypass caller egress', async () => {
    const client = jest.fn().mockResolvedValue({ results: [
      { ...receipt.results[0], url: 'https://example.com/%73ite-search-test-key' },
      { ...receipt.results[0], url: 'https://example.com/%2570rivate-user-id' },
      { ...receipt.results[0], date: 'private-user-id' }] });
    const result = await createWebSearchTools({ client }).search(config, { query: '新闻' }, dependencies());
    expect(result.results).toHaveLength(1); expect(result.results[0].date).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/site-search-test-key|private-user-id/);
  });
  test('private identifiers are redacted before display truncation', async () => {
    const secret = 'private-user-id', prefix = '字'.repeat(495);
    const client = jest.fn().mockResolvedValue({ results: [{ ...receipt.results[0], snippet: prefix + secret + '余文' }] });
    const result = await createWebSearchTools({ client }).search(config, { query: '新闻' }, dependencies());
    expect(result.results[0].snippet.endsWith('[内部标识')).toBe(true);
    expect(result.results[0].snippet).not.toContain('priva');
  });
  test('already aborted requests do not reserve or call source', async () => {
    const client = jest.fn(), deps = dependencies(), controller = new AbortController(); controller.abort();
    expect(await createWebSearchTools({ client }).search(config, { query: '新闻' }, { ...deps, signal: controller.signal })).toMatchObject({ status: 'error' });
    expect(client).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
  });
});
