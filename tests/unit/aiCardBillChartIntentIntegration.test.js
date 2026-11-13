jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Real DB forbidden'); }), getConnection: jest.fn(() => { throw Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Paid provider forbidden'); }) }));
const { fixture, calls, final } = require('../fixtures/aiV3MemoryFixture');
const capture = require('../fixtures/aiCardBillChartPaidRegression.json');
function setup({ wrongId = false, inventedAxis = false, noChart = false, message = capture.message } = {}) {
  const f = fixture([calls('query_data', { datasetId: 'card-bills', startDate: '2026-09-01', endDate: '2026-11-30', limit: 50 }), (_, messages) => {
    const approved = messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content)).find(item => item.datasets?.length);
    const queryId = approved.datasets[0].queryMeta.queryId;
    return final({ answer: '以上是逐卡、逐账单月的已保存本期账单和待还金额。跨月待还不相加解释为总欠款。', chart: noChart ? null
      : { ...capture.chart, queryId: wrongId ? 'q_' + 'f'.repeat(24) : queryId, xKey: inventedAxis ? 'nameMonth' : 'month' } });
  }], { clock: () => new Date(capture.dataset.asOf), memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.taskContext = structuredClone(capture.input.taskContext); f.state.taskContext.chartRequest = null;
  f.repository.query.mockImplementation(async (_, input) => { const dataset = structuredClone(capture.dataset); dataset.queryMeta.queryId = input.queryId;
    return { scope: input.scope, datasets: [dataset], choices: {}, asOf: dataset.asOf }; });
  return { f, message };
}
test('actual V3 pipeline corrects captured C09 axis and keeps returned/persisted/recovery dataset identical', async () => {
  const { f, message } = setup(), result = await f.send(message);
  expect(result.chart).toMatchObject({ datasetId: 'card-bills', type: 'bar', xKey: 'name', yKeys: ['billAmount', 'needRepay'] });
  // The isolated preview has no reference map for the synthetic cardRef values;
  // compare every actual approved source field after that existing egress step.
  expect(result.datasets[0].rows).toEqual(capture.dataset.rows.map(({ cardRef, ...row }) => row)); expect(result.datasets[0].queryMeta.returnedRowCount).toBe(5);
  const approved = f.provider.mock.calls[1][1].filter(item => item.role === 'tool').map(item => JSON.parse(item.content)).find(item => item.datasets?.length);
  expect(approved.datasets[0].rows).toEqual(result.datasets[0].rows); expect(approved.datasets[0].queryMeta).toEqual(result.datasets[0].queryMeta);
  expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);
  const saved = f.state.conversationStore.append.mock.calls[0][2]; expect(saved.business.chart).toEqual(result.chart);
  expect(saved.business.datasets).toEqual(result.datasets); expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
  expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test('actual service grounds a missing card bill chart from approved five rows only', async () => {
  const { f, message } = setup({ noChart: true }), result = await f.send(message);
  expect(result.chart).toMatchObject({ xKey: 'name', yKeys: ['billAmount', 'needRepay'] }); expect(result.datasets[0].rows).toHaveLength(5);
});
test.each([{ wrongId: true }, { inventedAxis: true }])('actual service does not rescue unauthorized graph input: %j', async options => {
  const { f, message } = setup(options); await expect(f.send(message)).rejects.toMatchObject({ code: 'AI_CHART_INVALID' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test('month axis stays a month axis when user explicitly asks for monthly presentation', async () => {
  const { f, message } = setup({ message: '查看2026年9月至11月信用卡账单快照，按月份展示本期账单和保存待还金额柱状图。' });
  const result = await f.send(message); expect(result.chart.xKey).toBe('month');
});
test.each(['不想看逐卡信用卡账单柱状图。', '不想要看逐卡信用卡账单柱状图。'])('real service card-axis pin does not act on negated wording: %s', async message => {
  const { f } = setup({ message }); const result = await f.send(message);
  expect(result.chart.xKey).toBe('month'); expect(result.datasets[0].rows).toHaveLength(5);
});
afterAll(() => { expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled(); });
