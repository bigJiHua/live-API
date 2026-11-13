const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const { normalizeSavedStateClaims, queryCoverageProse } = require('../../src/modules/ai/service/queryCoverageProse');
const datasets = [{ datasetId: 'installment-plans', title: '分期计划',
  columns: [{ key: 'pending', type: 'number' }, { key: 'entered', type: 'number' }], rows: [{ name: '示例分期', pending: 1, entered: 0 }],
  queryMeta: { queryId: 'q_123456789012345678901234', effectiveScope: { startDate: '2026-11-01', endDate: '2026-11-09' }, filters: {},
    matchedRowCount: 3, returnedRowCount: 1, sourceRecordCount: null } }];
test('a proved saved installment state uses state wording without weakening execution claims', () => {
  const value = normalizeSavedStateClaims('示例分期：待入账1期，已入账0期。', datasets);
  expect(value).toContain('已入账状态：0期');
  expect(() => assertResultClaims(value)).not.toThrow();
  for (const text of ['本轮已入账0期。', '已入账999期。', '已为你完成入账。'])
    expect(() => assertResultClaims(normalizeSavedStateClaims(text, datasets))).toThrow();
  expect(() => assertResultClaims(normalizeSavedStateClaims('已入账0期。', []))).toThrow();
});
test('source coverage is rendered from approved metadata while saved plans stay distinct from historical state', () => {
  const text = queryCoverageProse(datasets);
  expect(text).toContain('目前保存计划');
  expect(text).toContain('2026-11-01 至 2026-11-09');
  expect(text).toContain('匹配 3 行，本次展示 1 行');
});
