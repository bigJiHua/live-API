const { pinCardBillChartAxis: pin, explicitCardAxis } = require('../../src/modules/ai/service/queryCardBillChartIntent');
const capture = require('../fixtures/aiCardBillChartPaidRegression.json');
const setup = () => ({ chart: structuredClone(capture.chart), dataset: structuredClone(capture.dataset),
  options: { message: capture.message, tasks: [structuredClone(capture.input.taskContext)] } });
test('paid C09 real month axis is corrected to trusted card name without changing query, money or rows', () => {
  const f = setup(), original = structuredClone(f), result = pin(f.chart, [f.dataset], f.options);
  expect(result).toEqual({ ...f.chart, xKey: 'name' }); expect(f).toEqual(original);
  expect(f.dataset.rows).toHaveLength(5); expect(result.yKeys).toEqual(['billAmount', 'needRepay']);
});
test('a missing model query ID binds only the unique approved current bill query', () => {
  const f = setup(); f.chart.queryId = null;
  expect(pin(f.chart, [f.dataset], f.options)).toMatchObject({ xKey: 'name', queryId: f.dataset.queryMeta.queryId });
});
test('an explicitly requested bill and pending amount chart may be grounded when model omitted it', () => {
  const f = setup(); expect(pin(null, [f.dataset], f.options)).toEqual({ ...f.chart, xKey: 'name', title: f.dataset.title });
});
test.each([
  ['no requested chart', f => f.options.tasks[0].chartRequest = null],
  ['wrong chart task', f => f.options.tasks[0].metric = 'card-consumption'],
  ['wrong current subject', f => f.options.tasks[0].subject = 'finance'],
  ['multiple bill chart tasks', f => f.options.tasks.push(structuredClone(f.options.tasks[0]))],
  ['wrong query instance', f => f.chart.queryId = 'q_' + 'b'.repeat(24)],
  ['different approved dataset', f => f.chart.datasetId = 'card-monthlyConsumption'],
  ['invented x column', f => f.chart.xKey = 'nameMonth'],
  ['invented y column', f => f.chart.yKeys = ['inventedDebt']],
  ['model wrong chart type', f => f.chart.type = 'pie'],
  ['wrong dataset provenance', f => f.dataset.queryMeta.datasetId = 'card-cards'],
  ['missing approved columns', f => f.dataset.columns = undefined],
  ['empty current dataset', f => f.dataset.rows = []],
  ['returned count mismatch', f => f.dataset.queryMeta.returnedRowCount = 3],
  ['ambiguous current bill queries', f => f.extra = structuredClone(f.dataset)],
])('unproved input is not silently repaired: %s', (_, change) => {
  const f = setup(); change(f); const original = structuredClone(f.chart);
  expect(pin(f.chart, [f.dataset, ...(f.extra ? [f.extra] : [])], f.options)).toEqual(original);
});
test.each(['不要逐卡画图，改按月份画图。', '不要按卡画柱状图。', '备注包含“逐卡”，按月份画图。', '按月份给本期账单和待还柱状图。',
  '不要给逐卡本期账单柱状图。', '不想看逐卡账单柱状图。', '不想要看逐卡账单柱状图。', '不用再给我看逐卡账单柱状图。', '别给我按卡画柱状图。'])('quoted or negated card-axis words are not authority: %s', message => {
  const f = setup(); f.options.message = message; expect(explicitCardAxis(message)).toBe(false);
  expect(pin(f.chart, [f.dataset], f.options)).toEqual(f.chart);
});
test.each(['给逐卡本期账单和待还柱状图。', '各卡本期账单柱状图。', '每张信用卡的待还金额柱状图。', '不要按月，改按卡画柱状图。', '不想按月，改按卡画柱状图。'])('affirmative user card axis is authority: %s', message => {
  const f = setup(); f.options.message = message; expect(explicitCardAxis(message)).toBe(true);
  expect(pin(f.chart, [f.dataset], f.options).xKey).toBe('name');
});
