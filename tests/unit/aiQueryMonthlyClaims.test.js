const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const data = {
  datasetId: 'card-monthlyConsumption', domain: 'card', title: '卡月消费',
  queryMeta: { groupBy: 'cardMonth', rowsComplete: true, effectiveScope: { startDate: '2026-09-01', endDate: '2026-11-09' } },
  columns: [{ key: 'month', type: 'date' }, { key: 'name', type: 'text' }, { key: 'amountCNY', type: 'money' }, { key: 'count', type: 'number' }],
  summary: { expense: '942.67', count: 6 }, rows: [
    { cardRef: 'card-a', name: '花呗', month: '2026-09', amountCNY: '666.00', count: 1 },
    { cardRef: 'card-a', name: '花呗', month: '2026-10', amountCNY: '200.00', count: 1 },
    { cardRef: 'card-b', name: '浦发新贵卡', month: '2026-09', amountCNY: '19.38', count: 2 },
    { cardRef: 'card-b', name: '浦发新贵卡', month: '2026-10', amountCNY: '17.38', count: 1 },
    { cardRef: 'card-c', name: '超惠真金', month: '2026-11', amountCNY: '39.91', count: 1 },
  ],
};
const task = { metric: 'card-consumption', comparisonScopes: [] };
test('monthly answer is authored from exact card/month cells despite false model interpretation', () => {
  const answer = buildQueryAnswer('浦发新贵卡三个月每月均有小额消费。整体递减后趋稳：花呗连续两月回落。', [data], null, task);
  expect(answer).toContain('花呗：2026-09 已定价支出 CNY 666.00（1 笔）；2026-10 已定价支出 CNY 200.00（1 笔）；2026-11 暂无消费记录');
  expect(answer).toContain('浦发新贵卡：2026-09 已定价支出 CNY 19.38（2 笔）；2026-10 已定价支出 CNY 17.38（1 笔）；2026-11 暂无消费记录');
  expect(answer).toContain('超惠真金：2026-09 暂无消费记录；2026-10 暂无消费记录；2026-11 已定价支出 CNY 39.91（1 笔）');
  expect(answer).toContain('2026-11 仅统计到 2026-11-09');
  expect(answer).not.toMatch(/每月均有|连续两月回落|趋稳/);
});
test('partial windows state missing returned rows rather than inventing zero consumption', () => {
  const partial = { ...data, rows: [data.rows[0]], queryMeta: { ...data.queryMeta, rowsComplete: false } };
  const answer = buildQueryAnswer('每个月都下降。', [partial], null, task);
  expect(answer).toContain('2026-10 暂无返回记录'); expect(answer).toContain('仅返回部分');
  expect(answer).not.toContain('暂无消费记录'); expect(answer).not.toContain('每个月都下降');
});
test('unpriced row cells do not become zero or complete totals', () => {
  const unpriced = { ...data, rows: [{ ...data.rows[0], amountCNY: null, unpricedCount: 1 }] };
  const answer = buildQueryAnswer('花呗消费0元。', [unpriced], null, task);
  expect(answer).toContain('金额未定价（1 笔），含 1 笔未定价'); expect(answer).not.toContain('消费0元');
});
test('YYYY-MM is a month label, actual amounts survive and invented amounts still fail', () => {
  const answer = buildQueryAnswer('花呗2026-09消费666.00元，2026-10消费200.00元。\n未经核对的777.77元。', [data]);
  expect(answer).toContain('花呗2026-09消费666.00元，2026-10消费200.00元。');
  expect(answer).not.toContain('777.77');
});
test('a large returned card window keeps answer length bounded without changing exact dataset values', () => {
  const large = { ...data, rows: Array.from({ length: 50 }, (_, index) => ({ ...data.rows[0],
    cardRef: `card-${index}`, name: `卡片${index}${'长名'.repeat(400)}` })),
    queryMeta: { ...data.queryMeta, rowsComplete: false,
      effectiveScope: { startDate: '2025-11-10', endDate: '2026-11-09' } } };
  const before = structuredClone(large);
  const answer = buildQueryAnswer('持续回落', [large], null, task);
  expect(answer.length).toBeLessThan(12000); expect(answer).toContain('正文展示部分卡片');
  expect(large).toEqual(before);
});
