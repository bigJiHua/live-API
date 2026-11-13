const { queryChartPresentation } = require('../../src/modules/ai/service/queryChartCoverage');
const id = 'q_' + 'a'.repeat(24);
const scope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const make = (count = 10) => ({ datasetId: 'finance-transactions', title: '收支明细', domain: 'finance',
  columns: [{ key: 'date', type: 'date', label: '日期' }, { key: 'direction', type: 'number', label: '收支方向' },
    { key: 'amountCNY', type: 'money', label: '金额（人民币）' }, { key: 'category', type: 'text', label: '分类' }],
  rows: Array.from({ length: count }, (_, index) => ({ date: '2026-06-30', direction: 0, amountCNY: (index + 20).toFixed(2), category: '测试分类' })),
  summary: { expense: '5784.61', income: '3911.24', count: 268 },
  queryMeta: { queryId: id, effectiveScope: scope, filters: { direction: 'both' }, returnedRowCount: count,
    matchedRowCount: 268, rowsComplete: false, summaryComplete: true } });
const chart = { datasetId: 'finance-transactions', queryId: id, type: 'bar', xKey: 'date', yKeys: ['amountCNY'] };
const numbered = dataset => dataset.rows.map((row, index) => `${index + 1}. ${row.date} 支出 ${row.amountCNY} ${row.category}`).join('\n');

test('chart coverage uses returned rows and matching count, without a diagnostic request keyword', () => {
  const dataset = make(), before = structuredClone(dataset);
  const result = queryChartPresentation({ prose: numbered(dataset) + '\n同一日期出现多根柱子表示当天有多笔交易。', chart,
    datasets: [dataset], message: '以每笔日期和人民币金额给柱状图，说明图仅代表这10笔明细。' });
  expect(result.notice).toContain('仅展示本次返回的 10 笔收支明细');
  expect(result.notice).toContain('2026-06-01 至 2026-06-30'); expect(result.notice).toContain('全范围匹配 268 笔');
  expect(result.notice).toContain('未展示其余'); expect(result.notice).toContain('全范围汇总金额');
  expect(result.prose).not.toContain('20.00'); expect(result.prose).toContain('同一日期出现多根柱子');
  expect(dataset).toEqual(before);
});

test('the count comes from actual return metadata, rather than the requested ten', () => {
  const result = queryChartPresentation({ chart, datasets: [make(3)], message: '展示10笔，给图。', language: 'en' });
  expect(result.notice).toContain('only the 3 returned transactions'); expect(result.notice).not.toContain('10');
});

test.each([null, { ...chart, queryId: 'q_' + 'b'.repeat(24) }, { ...chart, xKey: 'category' },
  { ...chart, datasetId: 'finance-daily' }, { ...chart, yKeys: ['expense'] }, { ...chart, type: 'pie' }])
('non-target or absent chart keeps ordinary numbered prose: %j', selected => {
  const dataset = make(), prose = numbered(dataset);
  expect(queryChartPresentation({ prose, chart: selected, datasets: [dataset] })).toEqual({ prose, notice: '' });
});

test('only pure copies of returned rows are removed; numbered analysis retains its evidence', () => {
  const dataset = make();
  const analysis = '1. 2026-06-30 的支出 20.00 值得核对分类。\n2. 建议以后单独关注这类消费。';
  const result = queryChartPresentation({ prose: numbered(dataset) + '\n' + analysis, chart, datasets: [dataset] });
  expect(result.prose).toBe(analysis);
});

test.each(['同时列出这些明细原文。', 'Please list the returned transactions as well.'])
('an explicit written-detail request keeps the approved row list: %s', message => {
  const dataset = make(), prose = numbered(dataset);
  const result = queryChartPresentation({ prose, chart, datasets: [dataset], message });
  expect(result.prose).toBe(prose); expect(result.notice).toContain('10');
});

test('a request not to repeat the written rows still removes only pure copies', () => {
  const dataset = make();
  expect(queryChartPresentation({ prose: numbered(dataset), chart, datasets: [dataset], message: '不要列出重复明细，给图即可。' }).prose).toBe('');
});

test('unknown matching count does not become a full-range total or complete coverage', () => {
  const dataset = make(); dataset.queryMeta.matchedRowCount = null;
  const result = queryChartPresentation({ chart, datasets: [dataset] });
  expect(result.notice).toContain('匹配笔数尚未确定'); expect(result.notice).not.toContain('268');
  expect(result.notice).not.toContain('已全部返回');
});

test('complete data is not described as missing matching transactions', () => {
  const dataset = make(3); Object.assign(dataset.queryMeta, { matchedRowCount: 3, rowsComplete: true });
  const result = queryChartPresentation({ chart, datasets: [dataset] });
  expect(result.notice).toContain('已全部返回'); expect(result.notice).not.toContain('未展示其余');
  expect(result.notice).not.toContain('全范围汇总金额');
});

test.each(['empty', 'wrong-returned-count', 'contradictory-completeness', 'ambiguous'])
('unproven %s metadata cannot create chart facts or remove prose', mode => {
  const dataset = make(); let datasets = [dataset];
  if (mode === 'empty') { dataset.rows = []; dataset.queryMeta.returnedRowCount = 0; }
  if (mode === 'wrong-returned-count') dataset.queryMeta.returnedRowCount = 3;
  if (mode === 'contradictory-completeness') dataset.queryMeta.rowsComplete = true;
  if (mode === 'ambiguous') datasets.push(structuredClone(dataset));
  expect(queryChartPresentation({ prose: '已有分析。', chart, datasets })).toEqual({ prose: '已有分析。', notice: '' });
});

test('a sibling query cannot donate its count or cause a row from another subject to disappear', () => {
  const dataset = make(3), prose = numbered(dataset);
  const sibling = { ...make(), datasetId: 'finance-daily', queryMeta: { ...make().queryMeta, queryId: 'q_' + 'b'.repeat(24), matchedRowCount: 900 } };
  const result = queryChartPresentation({ prose, chart, datasets: [dataset, sibling] });
  expect(result.notice).toContain('3 笔'); expect(result.notice).toContain('268'); expect(result.notice).not.toContain('900');
  expect(result.prose).toBe(prose);
});
