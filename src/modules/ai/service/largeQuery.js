'use strict';

const crypto = require('crypto');
const { AiError } = require('./errors');
const { resolveSecret } = require('../../../common/utils/secretGuard');

const MAX_RANGE_DAYS = 3653;
const MAX_CURSOR_OFFSET = 100000;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const RESOLUTIONS = Object.freeze(['auto', 'detail', 'month', 'year']);
const TEMPORAL_DATASETS = Object.freeze(['finance-monthly', 'finance-daily', 'card-monthlyConsumption',
  'card-repayments', 'budget-plans', 'todo-events', 'work-salary', 'asset-snapshots', 'asset-registers', 'fund-history']);
let signingKey;
const key = () => signingKey || (signingKey = crypto.createHash('sha256').update(resolveSecret('SHARE_TOKEN_SECRET', { fallbackTo: 'JWT_SECRET' })).digest());
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => new AiError('查询续查凭据无效、已过期或范围已改变，请重新查询第一页', 400, 'AI_QUERY_CURSOR_INVALID');
const stamp = now => new Date(now == null ? Date.now() : now).getTime();
const isNextPageRequest = text => /^(?:请|继续|接着)?\s*(?:查看|看|读取)?\s*(?:下一页|next\s+page)[\s?？。!！]*$/i.test(String(text || '').trim());

function resolveResolution(input) {
  const wanted = input.resolution == null ? 'auto' : input.resolution;
  if (!RESOLUTIONS.includes(wanted)) throw new AiError('查询粒度必须是auto/detail/month/year', 400, 'AI_TOOL_ARGUMENT_INVALID');
  const temporal = TEMPORAL_DATASETS.includes(input.datasetId);
  if (!temporal && ['month', 'year'].includes(wanted)) throw new AiError('此数据集不支持时间聚合，请使用明细查询', 400, 'AI_TOOL_ARGUMENT_INVALID');
  if (input.datasetId === 'finance-monthly' && wanted === 'detail') return 'month';
  if (wanted !== 'auto') return wanted;
  if (input.datasetId === 'finance-monthly') return monthCount(input.scope) > 50 ? 'year' : 'month';
  const large = rangeDays(input.scope) >= 366;
  const rankedDays = input.datasetId === 'finance-daily' && ['incomeDesc', 'expenseDesc'].includes(input.sort);
  if (temporal && large && !rankedDays && !(input.datasetId === 'card-monthlyConsumption' && input.groupBy === 'card'))
    return monthCount(input.scope) > 50 ? 'year' : 'month';
  return 'detail';
}
function rangeDays(scope) {
  return (Date.parse(scope?.endDate) - Date.parse(scope?.startDate)) / 86400000;
}
function monthCount(scope) {
  if (!scope) return 0;
  const [sy, sm] = scope.startDate.split('-').map(Number);
  const [ey, em] = scope.endDate.split('-').map(Number);
  return (ey - sy) * 12 + em - sm + 1;
}
function planQuery(input, userId, now = new Date()) {
  const validDate = text => typeof text === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(text)
    && Number.isFinite(Date.parse(text)) && new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) === text;
  if (!userId || !input?.scope || !validDate(input.scope.startDate) || !validDate(input.scope.endDate)
    || !Number.isFinite(rangeDays(input.scope)) || rangeDays(input.scope) < 0 || rangeDays(input.scope) > MAX_RANGE_DAYS)
    throw new AiError('查询日期须真实有效，单次完整范围最多十年', 400, 'AI_SCOPE_INVALID');
  const resolution = resolveResolution(input);
  const explicitLimit = input.limitExplicit == null ? Object.hasOwn(input, 'limit') && input.limit != null : input.limitExplicit;
  const limit = explicitLimit ? input.limit : resolution !== 'detail' ? 50 : input.limit || 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AiError('查询展示条数须为1至50', 400, 'AI_TOOL_ARGUMENT_INVALID');
  // A cursor authorizes no new scope. It only resumes the exact owner-bound
  // dataset/filter/order/resolution; changing the limit is safe between pages.
  const binding = digest({ datasetId: input.datasetId, scope: input.scope,
    requestedScope: input.requestedScope || null, resolution, direction: input.direction || 'both',
    filter: input.filter || '', sort: input.sort || 'dateDesc', groupBy: input.groupBy || null,
    cardTypes: [...(input.cardTypes || [])].sort() });
  const owner = crypto.createHmac('sha256', key()).update(String(userId)).digest('hex');
  const timestamp = stamp(now);
  let offset = 0, expiresAt = timestamp + CURSOR_TTL_MS;
  if (input.cursor != null) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 2048) throw invalid();
    const parts = input.cursor.split('.');
    if (parts.length !== 3 || parts[0] !== 'lq1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw invalid();
    const expected = crypto.createHmac('sha256', key()).update(parts[0] + '.' + parts[1]).digest();
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.length !== expected.length || signature.toString('base64url') !== parts[2] || !crypto.timingSafeEqual(signature, expected)) throw invalid();
    let data;
    try { data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { throw invalid(); }
    if (!data || Object.keys(data).sort().join(',') !== 'binding,expiresAt,offset,owner,v'
      || data.v !== 1 || data.owner !== owner || data.binding !== binding
      || !Number.isSafeInteger(data.offset) || data.offset < 1 || data.offset > MAX_CURSOR_OFFSET
      || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= timestamp || data.expiresAt > timestamp + CURSOR_TTL_MS) throw invalid();
    offset = data.offset; expiresAt = data.expiresAt;
  }
  return { resolution, offset, limit, binding, owner, expiresAt, isLargeRange: rangeDays(input.scope) >= 366 };
}
function pageInfo(plan, matchedRowCount, returnedRowCount, asOf) {
  if (matchedRowCount === null && Number.isSafeInteger(returnedRowCount) && returnedRowCount >= 0 && returnedRowCount <= plan.limit)
    return { offset: plan.offset, limit: plan.limit, hasMore: false, nextCursor: null };
  if (!Number.isSafeInteger(matchedRowCount) || matchedRowCount < 0 || !Number.isSafeInteger(returnedRowCount)
    || returnedRowCount < 0 || returnedRowCount > plan.limit || plan.offset > matchedRowCount)
    throw new AiError('查询分页数量无效，请重新查询', 503, 'AI_READ_INVALID_COUNT');
  const nextOffset = plan.offset + returnedRowCount;
  const hasMore = nextOffset < matchedRowCount;
  let nextCursor = null;
  if (hasMore) {
    if (!returnedRowCount || nextOffset > MAX_CURSOR_OFFSET) throw new AiError('明细续查超过受控容量，请使用时间聚合或进一步筛选', 400, 'AI_QUERY_PAGE_LIMIT');
    const content = Buffer.from(JSON.stringify({ v: 1, owner: plan.owner, binding: plan.binding,
      offset: nextOffset, expiresAt: plan.expiresAt })).toString('base64url');
    const signature = crypto.createHmac('sha256', key()).update('lq1.' + content).digest('base64url');
    nextCursor = 'lq1.' + content + '.' + signature;
  }
  return { offset: plan.offset, limit: plan.limit, hasMore, nextCursor };
}

module.exports = { MAX_RANGE_DAYS, MAX_CURSOR_OFFSET, CURSOR_TTL_MS, RESOLUTIONS, TEMPORAL_DATASETS,
  rangeDays, monthCount, resolveResolution, planQuery, pageInfo, isNextPageRequest };
