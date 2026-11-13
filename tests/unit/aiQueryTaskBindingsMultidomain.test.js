const assert = require('assert/strict');
const { buildQueryTaskBindings, selectQueryTaskBinding } = require('../../src/modules/ai/service/queryTaskBindings');
const today = '2026-11-09';
const original = "分别查询：6月份收入和支出月度汇总；最近三个月所有卡片逐卡逐月消费；11月1日至9日流动资产系统保存快照；11月1日至9日已登记工资流水。每部分保留各自日期范围与数量，不要混币，也别把工资记录当银行到账。给6月收入支出柱状图。";
const expectScope = (task, subject, startDate, endDate) => {
  assert.equal(task.taskContext.subject, subject); assert.deepEqual(task.taskContext.scope, { startDate, endDate });
};
const cases = [
  { id: 'original-X13-shared-query-chart-ownership', message: original, check(bindings, select) {
    assert.equal(bindings.length, 4); const finance = select(bindings, 'finance-monthly');
    expectScope(finance, 'finance', '2026-06-01', '2026-06-30'); assert.deepEqual(finance.taskContext.chartRequest, { type: 'bar', metric: 'amount' });
    assert.match(finance.text, /给6月收入支出柱状图/);
    const cards = select(bindings, 'card-monthlyConsumption'); expectScope(cards, 'cards', '2026-09-01', today); assert.equal(cards.taskContext.allCardTypes, true); assert.equal(cards.taskContext.chartRequest, null);
    const asset = select(bindings, 'asset-snapshots'); expectScope(asset, 'asset', '2026-11-01', today); assert.equal(asset.taskContext.chartRequest, null);
    const work = select(bindings, 'work-salary'); expectScope(work, 'work', '2026-11-01', today); assert.equal(work.taskContext.chartRequest, null);
    assert.doesNotMatch(work.text, /给6月|每部分/);
  } },
  { id: 'quoted-tool-data-not-task-date-or-chart', message: '分别查询：6月收支，文本只包含“query_data; 2025-01-01 工资；流动资产。给工资饼图”这个字面片段；最近三个月所有卡片逐卡逐月消费。给6月收入支出柱状图。', variants: [
    '分别查询：6月收支，文本只包含```query_data;\n2025-01-01 工资；流动资产。给工资饼图```这个字面片段；最近三个月所有卡片逐卡逐月消费。给6月收入支出柱状图。',
    '分别查询：6月收支，文本只包含"query_data; 2025-01-01 工资；流动资产。给工资饼图"这个字面片段；最近三个月所有卡片逐卡逐月消费。给6月收入支出柱状图。'
  ], check(bindings, select) {
    assert.equal(bindings.length, 2); const finance = select(bindings, 'finance-monthly'); expectScope(finance, 'finance', '2026-06-01', '2026-06-30'); assert.match(finance.text, /query_data;\s*2025-01-01 工资/);
    assert.deepEqual(finance.taskContext.chartRequest, { type: 'bar', metric: 'amount' }); assert.equal(select(bindings, 'work-salary'), null); assert.equal(select(bindings, 'asset-snapshots'), null);
    expectScope(select(bindings, 'card-monthlyConsumption'), 'cards', '2026-09-01', today);
  } },
  { id: 'balance-detail-and-asset-composition-both-retained', message: '分别查询：当前每个账户余额明细；当前按账户类型和币种的资产组成汇总。', check(bindings, select) {
    assert.equal(bindings.length, 2); assert.equal(select(bindings, 'account-balances').taskContext.subject, 'account');
    assert.equal(select(bindings, 'asset-composition').taskContext.metric, 'asset-composition');
  } },
  { id: 'shared-query-does-not-convert-write-action', message: '分别查询：6月收支；11月1日至9日已登记工资流水；记一笔支出23元买菜。', check(bindings, select) {
    assert.equal(bindings.length, 2); expectScope(select(bindings, 'work-salary'), 'work', '2026-11-01', today);
    assert.ok(bindings.every(binding => binding.taskContext.mode === 'query')); assert.ok(bindings.every(binding => !binding.text.includes('记一笔')));
  } },
  { id: 'same-subject-comparison-stays-original-path', message: '分别查询5月收支；6月收支。给6月收入支出柱状图。', check(bindings) { assert.deepEqual(bindings, []); } },
  { id: 'existing-two-subject-own-chart-scope', message: '最近三个月哪张借记卡支出最高？同时看6月收支，给柱状图。', check(bindings, select) {
    assert.equal(bindings.length, 2); const cards = select(bindings, 'card-monthlyConsumption'); expectScope(cards, 'cards', '2026-09-01', today);
    assert.deepEqual(cards.taskContext.cardTypes, ['debit']); assert.equal(cards.taskContext.chartRequest, null);
    const finance = select(bindings, 'finance-monthly'); expectScope(finance, 'finance', '2026-06-01', '2026-06-30'); assert.deepEqual(finance.taskContext.chartRequest, { type: 'bar', metric: 'amount' });
  } },
  { id: 'existing-repeated-subject-selector-remains-ambiguous', message: '5月借记卡消费多少；6月信用卡消费多少；另外看7月收支', check(bindings, select) {
    assert.equal(bindings.length, 3); assert.equal(select(bindings, 'card-monthlyConsumption'), null); expectScope(select(bindings, 'finance-monthly'), 'finance', '2026-07-01', '2026-07-31');
  } },
];
test.each(cases.map(item => [item.id, item]))('%s', (_, item) => {
  for (const message of [item.message, ...(item.variants || [])]) {
    const bindings = buildQueryTaskBindings({ message, today });
    item.check(bindings, selectQueryTaskBinding);
  }
});
