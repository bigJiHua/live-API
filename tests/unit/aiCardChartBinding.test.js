const { validateChart } = require('../../src/modules/ai/service/v3Service');
const scope = { startDate: '2026-09-01', endDate: '2026-11-09' };
const dataset = {
  datasetId: 'card-monthlyConsumption', title: '按卡消费月度统计（人民币）',
  queryMeta: { queryId: `q_${'a'.repeat(24)}`, groupBy: 'cardMonth', effectiveScope: scope },
  columns: [{ key: 'month', type: 'date' }, { key: 'amountCNY', type: 'money' }],
  rows: [
    { month: '2026-09', cardRef: 'r_aa', name: '同名卡', amountCNY: '666.00' },
    { month: '2026-09', cardRef: 'r_bb', name: '同名卡', amountCNY: '19.38' },
    { month: '2026-10', cardRef: 'r_aa', name: '同名卡', amountCNY: '200.00' },
  ],
};
const chart = { datasetId: dataset.datasetId, queryId: dataset.queryMeta.queryId,
  type: 'line', xKey: 'month', yKeys: ['amountCNY'], title: '模型标题' };
test('card month chart keeps distinct cards with repeated months and uses approved partial-month scope', () => {
  const original = structuredClone(dataset);
  expect(validateChart(chart, [dataset], null, true)).toEqual({
    chart: { ...chart, title: '按卡消费月度统计（人民币）（2026-09-01 至 2026-11-09）' }, note: '',
  });
  expect(dataset).toEqual(original);
});
test('duplicate same-card same-month cells drop the chart without inventing totals', () => {
  const duplicate = { ...dataset, rows: [...dataset.rows, { ...dataset.rows[0], amountCNY: '1.00' }] };
  expect(validateChart(chart, [duplicate], null, true)).toMatchObject({ chart: null, note: expect.stringContaining('重复') });
});
test('monthly pie is dropped without losing the query answer, while normal card comparison remains allowed', () => {
  expect(validateChart({ ...chart, type: 'pie' }, [dataset], null, true)).toMatchObject({ chart: null, note: expect.stringContaining('折线图') });
  const byCard = { ...dataset, queryMeta: { ...dataset.queryMeta, groupBy: 'card' } };
  expect(validateChart({ ...chart, type: 'pie' }, [byCard], null, true).chart.type).toBe('pie');
});
test('a chart cannot bind to a different query instance or unauthorized field', () => {
  expect(() => validateChart({ ...chart, queryId: `q_${'b'.repeat(24)}` }, [dataset], null, true)).toThrow('有效数据列');
  expect(() => validateChart({ ...chart, yKeys: ['inventedTotal'] }, [dataset], null, true)).toThrow('有效数据列');
});
