'use strict';

const { planQuery, pageInfo, isNextPageRequest } = require('./largeQuery');
const { AiError } = require('./errors');
const { getDatasetCapability } = require('./datasetCapabilities');

function resumePageInput(message, input, coverage, context) {
  if (!isNextPageRequest(message)) return input;
  const latest = [...(context?.lastResults || []), ...(coverage?.results || [])]
    .findLast(result => result.datasetId === input.datasetId);
  if (!latest?.page?.hasMore || !latest.page.nextCursor)
    throw new AiError('当前查询没有可用的下一页，请重新选择查询范围', 400, 'AI_QUERY_NO_NEXT_PAGE');
  const cap = getDatasetCapability(input.datasetId);
  return { ...input, ...latest.requestedScope, filter: latest.filters.text, sort: latest.sort,
    resolution: latest.resolution || 'detail', cursor: latest.page.nextCursor,
    limit: input.limit || latest.page.limit,
    ...(cap?.acceptedArgs.directions.length ? { direction: latest.filters.direction } : {}),
    ...(latest.groupBy ? { groupBy: latest.groupBy } : {}),
    ...(latest.filters.cardTypes?.length ? { cardTypes: latest.filters.cardTypes } : {}) };
}

// Fit display rows before authorization packaging. Full-range SQL totals stay
// intact; the cursor resumes after the last row actually disclosed.
function fitQueryWindow(snapshot, args, userId, maxBytes = 12 * 1024, now = new Date()) {
  const size = () => Buffer.byteLength(JSON.stringify(snapshot));
  if (size() <= maxBytes) return snapshot;
  if (!Array.isArray(snapshot.datasets) || snapshot.datasets.length !== 1) return snapshot;
  const dataset = snapshot.datasets[0], meta = dataset.queryMeta;
  if (!meta || !Array.isArray(dataset.rows)) return snapshot;
  const initialLength = dataset.rows.length;
  while (size() > maxBytes && dataset.rows.length > 1) dataset.rows.pop();
  if (size() > maxBytes) throw new AiError('单条记录或必要摘要超过展示容量，请进一步筛选', 400, 'AI_DISCLOSURE_LIMIT');
  if (dataset.rows.length === initialLength) return snapshot;
  const resolution = meta.resolution || 'detail';
  const plan = planQuery({ ...args, scope: snapshot.scope || args.scope, resolution, sort: meta.sort,
    direction: meta.filters.direction, filter: meta.filters.text,
    limit: dataset.rows.length, limitExplicit: true }, userId, now);
  meta.returnedRowCount = dataset.rows.length;
  meta.rowsComplete = plan.offset === 0 && meta.matchedRowCount !== null && meta.matchedRowCount === dataset.rows.length;
  meta.rankingComplete = meta.rankingComplete && (meta.rowsComplete
    || getDatasetCapability(dataset.datasetId)?.effectiveMeta.rankingSorts.includes(meta.sort));
  meta.resolution = resolution;
  meta.page = pageInfo(plan, meta.matchedRowCount, dataset.rows.length, meta.asOf);
  meta.returnedDateRange = null;
  dataset.truncated = !meta.rowsComplete;
  dataset.policy += ' 本次根据展示容量调整返回行数；'
    + (meta.summaryComplete ? '完整汇总仍来自全范围查询；' : '仅保留已经核验的摘要，不代表完整金额汇总；')
    + '后续明细使用返回的续查凭据。';
  if (size() > maxBytes + 1024) throw new AiError('必要查询证据超过展示容量，请进一步筛选', 400, 'AI_DISCLOSURE_LIMIT');
  return snapshot;
}

module.exports = { fitQueryWindow, resumePageInput };
