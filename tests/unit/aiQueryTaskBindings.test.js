const { buildQueryTaskBindings, selectQueryTaskBinding } = require('../../src/modules/ai/service/queryTaskBindings');
const { resolveQueryArgs } = require('../../src/modules/ai/service/queryContext');
jest.mock('../../src/common/config/db', () => ({ execute: () => { throw new Error('Public database forbidden'); } }));
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const today = '2026-11-09';
test('two different subjects retain their own dates and chart requirements', () => {
  const bindings = buildQueryTaskBindings({ message: '最近三个月哪张借记卡支出最高？同时看6月收支，给柱状图。', today });
  expect(bindings).toHaveLength(2);
  const cards = selectQueryTaskBinding(bindings, 'card-monthlyConsumption');
  const finance = selectQueryTaskBinding(bindings, 'finance-monthly');
  expect(cards.taskContext).toMatchObject({ subject: 'cards', cardTypes: ['debit'], chartRequest: null,
    scope: { startDate: '2026-09-01', endDate: '2026-11-09' } });
  expect(finance.taskContext).toMatchObject({ subject: 'finance', chartRequest: { type: 'bar' },
    scope: { startDate: '2026-06-01', endDate: '2026-06-30' } });
  expect(resolveQueryArgs({ datasetId: 'finance-monthly', startDate: '2026-09-01', endDate: today }, finance.queryContext))
    .toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
});
test('same-subject comparisons and ordinary sentences keep existing resolution', () => {
  expect(buildQueryTaskBindings({ message: '对比5月以及6月收支', today })).toEqual([]);
  expect(buildQueryTaskBindings({ message: '信用卡和借记卡消费多少？', today })).toEqual([]);
});
test('ambiguous repeated subjects do not apply one scope to several tools', () => {
  const bindings = buildQueryTaskBindings({ message: '5月借记卡消费多少；6月信用卡消费多少；另外看7月收支', today });
  expect(selectQueryTaskBinding(bindings, 'card-monthlyConsumption')).toBeNull();
  expect(selectQueryTaskBinding(bindings, 'finance-monthly').taskContext.scope.startDate).toBe('2026-07-01');
});
test('a missing subject is described as a gap instead of disappearing from a mixed answer', () => {
  const bindings = buildQueryTaskBindings({ message: '最近三个月哪张借记卡支出最高？同时看6月收支，给柱状图。', today });
  const answer = buildQueryAnswer('', [{ datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
    columns: [], rows: [], summary: { income: '100.00', expense: '60.00', count: 2 } }], null, null, bindings);
  expect(answer).toContain('卡片查询尚无本轮获准数据');
  expect(answer).toContain('100.00'); expect(answer).toContain('60.00');
  expect(answer).not.toMatch(/卡片.*最高/);
});
