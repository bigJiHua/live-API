jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Real DB forbidden'); }), getConnection: jest.fn(() => { throw Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Paid provider forbidden'); }) }));
const { fixture, calls, final } = require('../fixtures/aiV3MemoryFixture');
const capture = require('../fixtures/aiFinanceSavedStateFixture.json');
function setup(answer, { omitSummary = false } = {}) {
  const f = fixture([calls('query_data', { datasetId: 'finance-daily', startDate: '2026-06-01', endDate: '2026-06-30', direction: 'both', sort: 'dateDesc', limit: 1 }), final({ ...capture.output, answer })],
    { clock: () => new Date(capture.dataset.asOf), memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.queryContext = { version: 1, activeQuery: { startDate: '2026-06-01', endDate: '2026-06-30', direction: null, category: null, metric: 'summary', status: 'succeeded', periodSource: 'explicit' },
    lastResults: [{ ...capture.dataset.queryMeta, source: 'previous-turn', status: 'succeeded', returnedRowCount: 10 }] };
  f.state.taskContext = { version: 1, mode: 'query', subject: 'finance', targetDatasetId: 'finance-daily', metric: 'summary', querySort: 'dateDesc', requireFreshQuery: true,
    scope: { startDate: '2026-06-01', endDate: '2026-06-30' }, status: 'succeeded', cardTypes: [], comparisonScopes: [], chartRequest: null };
  f.history.push({ role: 'user', content: '查看6月份逐日收入与支出的每日汇总。最多展示10条。', sourceDate: '2026-11-09' },
    { role: 'assistant', content: '6月范围为2026-06-01至2026-06-30，匹配30天，展示10天，来源268笔流水，收入115笔、支出153笔。', queryContext: f.state.queryContext, taskContext: f.state.taskContext });
  f.repository.query.mockImplementation(async (_, input) => {
    const d = structuredClone(capture.dataset); d.queryMeta.queryId = input.queryId;
    if (omitSummary) d.queryMeta.summaryComplete = false;
    return { scope: input.scope, datasets: [d], choices: {}, asOf: d.asOf };
  });
  return f;
}
test('actual V3 service retains paid F04 range, counts, summary, row and same saved/recovery result', async () => {
  const f = setup(capture.output.answer), result = await f.send(capture.message);
  expect(result.answer).toContain('这些是已保存的收支汇总值');
  expect(result.answer).toContain('收入115笔、支出153笔');
  expect(result.answer).toContain('2026-06-30：收入1.49，支出25.77，3笔');
  expect(result.datasets).toHaveLength(1);
  expect(result.datasets[0].rows).toEqual(capture.dataset.rows);
  expect(result.datasets[0].summary).toEqual(capture.dataset.summary);
  expect(result.datasets[0].queryMeta).toMatchObject({ effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, matchedRowCount: 30, returnedRowCount: 1, sourceRecordCount: 268 });
  const saved = f.state.conversationStore.append.mock.calls[0][2];
  expect(saved.answer).toBe(result.answer); expect(saved.business.datasets).toEqual(result.datasets);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
  expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.provider).toHaveBeenCalledTimes(2);
  const approved = f.provider.mock.calls[1][1].filter(item => item.role === 'tool').map(item => JSON.parse(item.content)).find(item => item.datasets?.length);
  expect(approved.datasets[0].rows).toEqual(result.datasets[0].rows); expect(approved.datasets[0].summary).toEqual(result.datasets[0].summary);
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled(); expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});
test.each(['我已经完成入账。', '已为你完成入账。'])('actual V3 service still rejects current/agent execution without receipt: %s', async claim => {
  const f = setup(capture.output.answer + '\n' + claim);
  await expect(f.send(capture.message)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled(); expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test('actual service keeps an unproved historical predicate subject to the execution guard', async () => {
  const f = setup(capture.output.answer, { omitSummary: true });
  await expect(f.send(capture.message)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled(); expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
});
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
