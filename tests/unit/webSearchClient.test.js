const { createWebSearchClient, buildSearchRequest, mapSearchResponse, safeSourceUrl } = require('../../src/modules/ai/service/webSearchClient');
const fixture = require('./fixtures/webSearchResponses.json');
const config = (provider = 'deepseek') => ({ searchProvider: provider,
  searchBaseUrl: provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://open.bigmodel.cn/api/paas/v4',
  searchApiKey: 'site-search-test-key', searchTimeoutMs: 10000 });

describe('independent web search client', () => {
  test('DeepSeek official schema maps only citation fields', () => {
    expect(mapSearchResponse('deepseek', fixture.deepseek)).toEqual({ results: [{ title: 'DeepSeek V4 model released',
      url: 'https://example.com/deepseek-v4', snippet: fixture.deepseek.results[0].snippet, date: '2026-06-01T00:00:00+00:00' }] });
  });
  test('Zhipu official schema maps link/content/publish_date', () => {
    const row = fixture.zhipu.search_result[0];
    expect(mapSearchResponse('zhipu', fixture.zhipu)).toEqual({ results: [{ title: row.title, url: row.link, snippet: row.content, date: row.publish_date }] });
  });
  test('single paid request uses documented DeepSeek body, no localization or original user question', async () => {
    const http = { post: jest.fn().mockResolvedValue({ status: 200, data: fixture.deepseek }) }, signal = new AbortController().signal;
    await createWebSearchClient({ http })(config(), { query: '公开信息' }, { signal });
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post).toHaveBeenCalledWith('https://api.deepseek.com/v1/tools/search',
      { query: '公开信息', count: 5, need_content: false }, expect.objectContaining({ timeout: 10000, signal, maxRedirects: 0,
        headers: { Authorization: 'Bearer site-search-test-key', 'Content-Type': 'application/json' } }));
  });
  test.each([['week', 'oneWeek'], ['month', 'oneMonth'], [undefined, 'noLimit']])('Zhipu %s recency stays on search_std', (recency, expected) => {
    const request = buildSearchRequest(config('zhipu'), { query: '公开新闻', recency });
    expect(request.endpoint).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
    expect(request.body).toEqual({ search_query: '公开新闻', search_engine: 'search_std', search_intent: false,
      count: 5, content_size: 'medium', search_recency_filter: expected });
  });
  test('DeepSeek rejects unsupported recency without silently widening scope', () => {
    expect(() => buildSearchRequest(config(), { query: '新闻', recency: 'week' })).toThrow(expect.objectContaining({ code: 'AI_WEB_SEARCH_RECENCY_UNSUPPORTED' }));
  });
  test('Zhipu rejects over 70 characters instead of truncating intent', () => {
    expect(() => buildSearchRequest(config('zhipu'), { query: '新'.repeat(71) })).toThrow(expect.objectContaining({ code: 'AI_WEB_SEARCH_ARGUMENT_INVALID' }));
  });
  test.each(['http://api.deepseek.com', 'https://key:secret@api.deepseek.com', 'https://api.deepseek.com?key=x', 'https://api.deepseek.com/wrong'])('bad endpoint %s never sends a request', async base => {
    const http = { post: jest.fn() };
    await expect(createWebSearchClient({ http })({ ...config(), searchBaseUrl: base }, { query: '公开信息' })).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });
  test.each([429, 500, 302])('HTTP %s fails without retry or switching provider', async status => {
    const http = { post: jest.fn().mockResolvedValue({ status, data: fixture.deepseek }) };
    await expect(createWebSearchClient({ http })(config(), { query: '公开信息' })).rejects.toThrow(expect.objectContaining({ code: 'AI_WEB_SEARCH_FAILED' }));
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  test('transport timeout propagates once for the tool to turn into an error receipt', async () => {
    const http = { post: jest.fn().mockRejectedValue(new Error('secret upstream error')) };
    await expect(createWebSearchClient({ http })(config(), { query: '公开信息' })).rejects.toThrow('secret upstream error');
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  test('HTML responses cannot masquerade as protocol data', async () => {
    const http = { post: jest.fn().mockResolvedValue({ status: 200, data: fixture.deepseek, headers: { 'content-type': 'text/html' } }) };
    await expect(createWebSearchClient({ http })(config(), { query: '新闻' })).rejects.toThrow(expect.objectContaining({ code: 'AI_WEB_SEARCH_FAILED' }));
    expect(http.post).toHaveBeenCalledTimes(1);
  });
  test.each([null, {}, { results: 'wrong' }, { results: [], error: { message: 'bad' } }])('malformed/error response fails closed', data => {
    expect(() => mapSearchResponse('deepseek', data)).toThrow(expect.objectContaining({ code: 'AI_WEB_SEARCH_FAILED' }));
  });
  test('empty valid results remain an honest empty receipt', () => {
    expect(mapSearchResponse('deepseek', { results: [] })).toEqual({ results: [] });
  });
  test('unsafe sources are excluded and citations drop query secrets', () => {
    expect(safeSourceUrl('https://news.example.com/story?token=private#fragment')).toBe('https://news.example.com/story');
    for (const url of ['javascript:alert(1)', 'http://example.com', 'https://key:secret@example.com', 'https://127.0.0.1/admin', 'https://localhost/admin']) expect(safeSourceUrl(url)).toBeNull();
  });
  test('bad publication dates are not presented as facts and results are bounded', () => {
    const row = { ...fixture.deepseek.results[0], date: 'unknown date with instructions' };
    const output = mapSearchResponse('deepseek', { results: Array(20).fill(row) });
    expect(output.results).toHaveLength(5);
    expect(output.results.every(x => x.date === null)).toBe(true);
  });
});
