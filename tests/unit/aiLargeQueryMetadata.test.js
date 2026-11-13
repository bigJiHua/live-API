const { validateQueryMeta } = require('../../src/modules/ai/service/queryMetadata');
const { queryEffectiveArgs } = require('../../src/modules/ai/service/queryEffectiveArgs');
const { sanitizeQueryCoverageResult } = require('../../src/modules/ai/service/queryContext');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const { normalizeQueryPagination, queryCoverageProse } = require('../../src/modules/ai/service/queryCoverageProse');
const { effectiveGoalScope, goalDataset } = require('../../src/modules/ai/service/queryEvidenceGate');
const { planQuery, pageInfo } = require('../../src/modules/ai/service/largeQuery');

const range = { startDate: '2023-11-12', endDate: '2026-11-12' };
const scope = { domains: ['finance'], ...range };
const now = new Date('2026-11-12T06:00:00.000Z');
const queryId = 'q_0123456789abcdef01234567';
const owner = 'synthetic-large-query-owner';
function monthly() {
  const rows = Array.from({ length: 37 }, (_, index) => {
    const month = new Date(Date.UTC(2023, 10 + index, 1)).toISOString().slice(0, 7);
    return { month, income: '100.00', expense: '30.00', count: 100 };
  });
  return { datasetId: 'finance-monthly', domain: 'finance', title: '三年逐月收支', rows,
    columns: [{ key: 'month', label: '月份', type: 'text' }, { key: 'income', label: '收入', type: 'money' },
      { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }],
    summary: { income: '3700.00', expense: '1110.00', count: 3700, incomeCount: 1850, expenseCount: 1850 },
    queryMeta: { version: 1, queryId, datasetId: 'finance-monthly', requestedScope: range, effectiveScope: range,
      filters: { direction: 'both', text: '' }, sort: 'monthAsc', resolution: 'month',
      matchedRowCount: 37, returnedRowCount: 37, sourceRecordCount: 3700, rowsComplete: true,
      summaryComplete: true, rankingComplete: true, returnedDateRange: null, asOf: now.toISOString(),
      page: { offset: 0, limit: 50, hasMore: false, nextCursor: null } },
    asOf: now.toISOString(), truncated: false, policy: '完整范围的服务端统计' };
}
function detailPage() {
  const plan = planQuery({ datasetId: 'finance-transactions', scope, resolution: 'detail', limit: 20,
    direction: 'both', filter: '', sort: 'dateDesc' }, owner, now);
  const dataset = monthly();
  dataset.datasetId = 'finance-transactions';
  dataset.rows = Array.from({ length: 20 }, () => ({ date: '2026-11-12', amountCNY: '1.00' }));
  dataset.columns = [{ key: 'date', label: '日期', type: 'date' }, { key: 'amountCNY', label: '金额', type: 'money' }];
  dataset.queryMeta = { ...dataset.queryMeta, datasetId: dataset.datasetId, sort: 'dateDesc', resolution: 'detail',
    matchedRowCount: 4975, sourceRecordCount: 4975, returnedRowCount: 20, rowsComplete: false,
    page: pageInfo(plan, 4975, 20, now.toISOString()) };
  return dataset;
}

test('complete multi-year aggregate evidence survives strict metadata and history coverage', () => {
  const dataset = monthly();
  expect(validateQueryMeta(dataset.queryMeta, dataset, scope)).toEqual(dataset.queryMeta);
  expect(sanitizeQueryCoverageResult(dataset.queryMeta)).toMatchObject({ requestedScope: range, effectiveScope: range,
    resolution: 'month', page: dataset.queryMeta.page, rowsComplete: true, sourceRecordCount: 3700 });
});

test('a bounded signed next-page cursor survives coverage and does not become free-text pagination advice', () => {
  const dataset = detailPage();
  expect(dataset.queryMeta.page.nextCursor).toMatch(/^lq1\./);
  expect(validateQueryMeta(dataset.queryMeta, dataset, scope)).toEqual(dataset.queryMeta);
  expect(sanitizeQueryCoverageResult(dataset.queryMeta).page).toEqual(dataset.queryMeta.page);
  expect(normalizeQueryPagination('可以继续查询下一页。', [dataset])).toBe('可以继续查询下一页。');
  expect(normalizeQueryPagination('可以继续查询下一页。', [monthly()])).toContain('缩小日期范围');
});

test.each([
  { offset: -1 }, { offset: 100001 }, { limit: 51 }, { limit: 0 },
  { hasMore: false }, { nextCursor: null }, { nextCursor: 'forged-free-text' },
  { nextCursor: 'lq1.' + 'a'.repeat(2048) + '.signature' }, { internalOwner: owner },
])('invalid continuation metadata cannot enter an approved preview: case %#', patch => {
  const dataset = detailPage(); dataset.queryMeta.page = { ...dataset.queryMeta.page, ...patch };
  expect(() => validateQueryMeta(dataset.queryMeta, dataset, scope)).toThrow();
  expect(sanitizeQueryCoverageResult(dataset.queryMeta)).toBeNull();
});

test('the last page remains a partial row window even when it exhausts continuation', () => {
  const dataset = detailPage(); dataset.rows = dataset.rows.slice(0, 10);
  dataset.queryMeta = { ...dataset.queryMeta, matchedRowCount: 30, sourceRecordCount: 30, returnedRowCount: 10,
    page: { offset: 20, limit: 20, hasMore: false, nextCursor: null } };
  expect(validateQueryMeta(dataset.queryMeta, dataset, scope).rowsComplete).toBe(false);
  dataset.queryMeta.rowsComplete = true;
  expect(() => validateQueryMeta(dataset.queryMeta, dataset, scope)).toThrow();
});

test('unknown total count does not invent a complete or continuing page', () => {
  const dataset = detailPage(); dataset.queryMeta = { ...dataset.queryMeta, matchedRowCount: null, sourceRecordCount: null,
    summaryComplete: false, rankingComplete: false, page: { offset: 0, limit: 20, hasMore: false, nextCursor: null } };
  expect(validateQueryMeta(dataset.queryMeta, dataset, scope)).toMatchObject({ matchedRowCount: null, rowsComplete: false });
});

test('coverage wording distinguishes yearly aggregation and an exhausted partial page', () => {
  const yearly = monthly(); yearly.queryMeta.resolution = 'year';
  expect(queryCoverageProse([yearly])).toContain('按年汇总');
  expect(queryCoverageProse([yearly])).not.toContain('按月汇总');
  const page = detailPage(); page.queryMeta = { ...page.queryMeta, matchedRowCount: 40,
    page: { offset: 20, limit: 20, hasMore: false, nextCursor: null } };
  expect(queryCoverageProse([page])).toContain('已到最后一页，本页不代表全部匹配记录');
});

test('effective feedback follows SQL resolution/page size and reveals no decoded cursor fields', () => {
  const dataset = monthly();
  const result = queryEffectiveArgs('query_data', { datasetId: dataset.datasetId, resolution: 'auto' },
    { datasetId: dataset.datasetId, queryId, scope, resolution: 'auto', limit: 20, filter: '' }, { datasets: [dataset] });
  expect(result.effectiveArgs).toMatchObject({ ...range, resolution: 'month', limit: 50 });
  expect(result.argumentAdjustments).toContainEqual({ path: 'resolution', reason: 'normalized', requested: 'auto', effective: 'month' });
  const first = detailPage(), cursor = first.queryMeta.page.nextCursor;
  const last = { ...first, rows: first.rows.slice(0, 10), queryMeta: { ...first.queryMeta, matchedRowCount: 30,
    returnedRowCount: 10, page: { offset: 20, limit: 20, hasMore: false, nextCursor: null } } };
  const resumed = queryEffectiveArgs('query_data', { datasetId: last.datasetId, cursor },
    { datasetId: last.datasetId, queryId, scope, cursor, limit: 20 }, { datasets: [last] });
  expect(resumed.effectiveArgs.cursorApplied).toBe(true);
  expect(JSON.stringify(resumed)).not.toContain(cursor);
  expect(JSON.stringify(resumed)).not.toContain(owner);
});

test('three-year goal completion rejects a recent-year result even if its displayed rows are complete', () => {
  const dataset = monthly();
  const goal = { task: { mode: 'query', subject: 'finance', targetDatasetId: dataset.datasetId, scope, querySort: 'monthAsc' },
    query: { periodSource: 'explicit' }, constraints: {}, text: '查询这三年的收入和支出' };
  const inputs = new Map([[queryId, { datasetId: dataset.datasetId, scope, filter: '', limit: 50 }]]);
  expect(effectiveGoalScope(goal, '2026-11-12')).toEqual(scope);
  expect(goalDataset(goal, [dataset], inputs, '2026-11-12')).toBe(dataset);
  dataset.queryMeta.effectiveScope = { startDate: '2025-11-13', endDate: '2026-11-12' };
  expect(goalDataset(goal, [dataset], inputs, '2026-11-12')).toBeUndefined();
});

test('aggregated preview preserves full dates, signed continuation and four-decimal fund facts', async () => {
  const source = detailPage(), fundScope = { ...scope, domains: ['fund'] };
  const fundPlan = planQuery({ datasetId: 'fund-history', scope: fundScope, resolution: 'month', limit: 20 }, owner, now);
  const dataset = { ...source, datasetId: 'fund-history', domain: 'fund', title: '基金收益',
    columns: [{ key: 'date', label: '月份', type: 'text' }, { key: 'profit', label: '收益', type: 'decimal' },
      { key: 'capitalDelta', label: '增持', type: 'decimal' }, { key: 'count', label: '记录数', type: 'number' }],
    rows: Array.from({ length: 20 }, () => ({ date: '2026-11', profit: '0.9999', capitalDelta: '12.3456', count: 100 })),
    summary: { profit: '19.9980', capitalDelta: '246.9120', count: 4975 },
    queryMeta: { ...source.queryMeta, datasetId: 'fund-history', resolution: 'month', page: pageInfo(fundPlan, 4975, 20, now.toISOString()) } };
  let stored;
  const executor = { execute: jest.fn(async (sql, params) => {
    if (sql.startsWith('INSERT')) {
      const [id, user_id, digest, payload, created_at, expires_at] = params;
      stored = { id, user_id, digest, payload, created_at, expires_at, approved_at: null, request_id: null };
    } else if (sql.startsWith('SELECT')) return [[stored]];
    else if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at = ?')) stored.approved_at = params[0];
    return [{ affectedRows: 1 }];
  }) };
  const store = createPreviewStore({ executor, now: () => now });
  const preview = await store.prepare(owner, { message: '三年基金收益', scope: fundScope,
    snapshot: { scope: fundScope, datasets: [dataset], choices: {}, asOf: now.toISOString() } });
  expect(preview.datasets[0].queryMeta).toEqual(dataset.queryMeta);
  expect(preview.datasets[0].rows[0]).toEqual(dataset.rows[0]);
  expect(preview.datasets[0].summary).toMatchObject({ profit: '19.9980', capitalDelta: '246.9120', count: 4975 });
  await store.approveAndGet(owner, preview.previewId, true);
  const provider = await store.toProvider(owner, preview.previewId);
  expect(provider.datasets).toEqual(preview.datasets);
  expect(provider.datasets[0].queryMeta.page.nextCursor).toBe(dataset.queryMeta.page.nextCursor);
});
