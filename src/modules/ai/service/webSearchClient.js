const axios = require('axios');
const { AiError } = require('./errors');

// Official independent search APIs, checked 2026-11-12:
// https://api-docs.deepseek.com/api/search.md
// https://docs.bigmodel.cn/api-reference/%E5%B7%A5%E5%85%B7-api/%E7%BD%91%E7%BB%9C%E6%90%9C%E7%B4%A2.md
// No provider retry or failover: an uncertain request still consumes its reservation.
const MAX_RESULTS = 5;
const invalid = (message, code = 'AI_WEB_SEARCH_ARGUMENT_INVALID') => {
  throw new AiError(message, 400, code);
};

function searchEndpoint(config) {
  let url;
  try { url = new URL(config.searchBaseUrl); } catch (_) { invalid('搜索源配置无效', 'AI_WEB_SEARCH_CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    invalid('搜索源须使用不含凭据的 HTTPS 地址', 'AI_WEB_SEARCH_CONFIG_INVALID');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (config.searchProvider === 'deepseek') {
    if (!['', '/v1', '/v1/tools/search'].includes(path)) invalid('DeepSeek 搜索地址路径无效', 'AI_WEB_SEARCH_CONFIG_INVALID');
    url.pathname = '/v1/tools/search';
  } else if (config.searchProvider === 'zhipu') {
    if (!['', '/api', '/api/paas/v4', '/api/paas/v4/web_search'].includes(path)) invalid('智谱搜索地址路径无效', 'AI_WEB_SEARCH_CONFIG_INVALID');
    url.pathname = '/api/paas/v4/web_search';
  } else invalid('未开放此搜索源', 'AI_WEB_SEARCH_CONFIG_INVALID');
  return url.href;
}

function buildSearchRequest(config, args) {
  const endpoint = searchEndpoint(config);
  if (typeof config.searchApiKey !== 'string' || !config.searchApiKey.trim()
      || /[\r\n]/.test(config.searchApiKey)) invalid('搜索源凭据无效', 'AI_WEB_SEARCH_CONFIG_INVALID');
  if (!Number.isInteger(config.searchTimeoutMs) || config.searchTimeoutMs < 1000 || config.searchTimeoutMs > 30000) {
    invalid('搜索超时配置无效', 'AI_WEB_SEARCH_CONFIG_INVALID');
  }
  if (typeof args.query !== 'string' || !args.query.trim() || [...args.query].length > 120) invalid('搜索词长度无效');
  if (args.recency != null && !['week', 'month'].includes(args.recency)) invalid('搜索时间范围无效');
  if (config.searchProvider === 'deepseek') {
    // The published schema has no recency parameter. Do not silently broaden a requested time range.
    if (args.recency) invalid('当前搜索源不支持时间范围，请去掉 recency', 'AI_WEB_SEARCH_RECENCY_UNSUPPORTED');
    return { endpoint, body: { query: args.query, count: MAX_RESULTS, need_content: false } };
  }
  if ([...args.query].length > 70) invalid('智谱搜索词最多70字符');
  return { endpoint, body: { search_query: args.query, search_engine: config.searchEngine || 'search_std', search_intent: false,
    count: MAX_RESULTS, content_size: 'medium', search_recency_filter: args.recency === 'week' ? 'oneWeek'
      : args.recency === 'month' ? 'oneMonth' : 'noLimit' } };
}

function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (/(?:r|h)_[a-f0-9]{32}/i.test(value)) return null;
  try {
    let decoded = value;
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (/(?:r|h)_[a-f0-9]{32}/i.test(next)) return null;
      if (next === decoded) break;
      decoded = next;
    }
    // Deeper encoding is ambiguous; it cannot be used to conceal a reference beyond the decode budget.
    if (/%[a-f0-9]{2}/i.test(decoded)) return null;
  } catch (_) { return null; }
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.')
      || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  // Tracking/credential/identity query strings are unnecessary for a source citation.
  url.search = ''; url.hash = '';
  return url.href;
}

function safeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function mapSearchResponse(provider, data) {
  const rows = provider === 'deepseek' ? data?.results : provider === 'zhipu' ? data?.search_result : null;
  if (data?.error || !Array.isArray(rows)) throw new AiError('搜索源返回格式无效', 502, 'AI_WEB_SEARCH_FAILED');
  const results = [];
  for (const row of rows.slice(0, 50)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const title = row.title, snippet = provider === 'deepseek' ? row.snippet : row.content;
    const url = safeSourceUrl(provider === 'deepseek' ? row.url : row.link);
    if (!url || typeof title !== 'string' || typeof snippet !== 'string') continue;
    // Do not truncate a private identifier before the per-user egress can redact it.
    if (title.length > 32000 || snippet.length > 32000) throw new AiError('搜索源内容超出限制', 502, 'AI_WEB_SEARCH_FAILED');
    results.push({ title, url, snippet,
      date: safeDate(provider === 'deepseek' ? row.date : row.publish_date) });
    if (results.length >= MAX_RESULTS) break;
  }
  if (rows.length && !results.length) throw new AiError('搜索源没有有效的公开来源', 502, 'AI_WEB_SEARCH_FAILED');
  return { results };
}

function createWebSearchClient({ http = axios } = {}) {
  return async function search(config, args, { signal } = {}) {
    const { endpoint, body } = buildSearchRequest(config, args);
    const response = await http.post(endpoint, body, { headers: { Authorization: `Bearer ${config.searchApiKey}`,
      'Content-Type': 'application/json' }, timeout: config.searchTimeoutMs, signal,
      maxRedirects: 0, maxContentLength: 256 * 1024, maxBodyLength: 16 * 1024,
      validateStatus: status => status === 200 });
    if (response?.status !== 200) throw new AiError('搜索源调用失败', 502, 'AI_WEB_SEARCH_FAILED');
    const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
      throw new AiError('搜索源未返回 JSON', 502, 'AI_WEB_SEARCH_FAILED');
    }
    return mapSearchResponse(config.searchProvider, response.data);
  };
}

module.exports = { createWebSearchClient, buildSearchRequest, searchEndpoint, mapSearchResponse, safeSourceUrl, safeDate, MAX_RESULTS };
