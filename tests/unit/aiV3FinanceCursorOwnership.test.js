jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Real provider forbidden'); }) }));
const { fixture, final, calls, now } = require('./fixtures/aiV3DatasetIntentFixture.cjs');
const capture = require('./fixtures/aiV3FinanceCursorOwnershipCases.json');
const originalScope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const originalCursor = { version: 1, activeQuery: { ...originalScope, direction: 0, category: null, metric: 'transaction-max',
  status: 'succeeded', explicit: { period: true, direction: true, category: false, metric: true, subjectReset: true }, allowComparison: false, periodSource: 'inherited' } };
const inputOf = messages => JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
const evidence = [];
const financeFollowup = '回到刚才财务部分，范围不变，支出最大的一笔是哪天多少？只展示这一笔，不要图。';
const newFinance = '重新查询2026年10月1日至31日的支出最大单笔，只展示第一笔，不要图。';
const batch = (...items) => ({ role: 'assistant', content: null, tool_calls: items.flatMap(item => item.tool_calls) });
function replay() {
  const respond = (_, messages, __, options) => {
    const input = inputOf(messages), message = input.userTurns[input.currentTurn];
    if (!options.json && !messages.some(item => item.role === 'tool')) {
      if (/分别查询/.test(message)) return batch(calls('query_data', { datasetId: 'asset-snapshots' }),
        calls('query_data', { datasetId: 'finance-transactions', startDate: '2026-10-01', endDate: '2026-10-31', direction: 'expense', sort: 'amountDesc', limit: 1 }));
      return calls('query_data', /财务|支出最大单笔/.test(message)
        ? { datasetId: 'finance-transactions', ...(message === newFinance ? { startDate: '2026-10-01', endDate: '2026-10-31' } : {}), direction: 'expense', sort: 'amountDesc', limit: 1 }
        : { datasetId: 'asset-snapshots', ...capture.modelArgs });
    }
    return final({ answer: '已核对本轮查询。资产快照币种未确认。', chart: null });
  };
  const f = fixture(Array.from({ length: 24 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = ['finance', 'card', 'asset', 'work'];
  f.state.tasks = structuredClone(capture.taskContexts); f.state.taskContext = structuredClone(f.state.tasks.tasks.at(-1));
  f.state.coverage = { version: 1, results: structuredClone(capture.previousQueryCoverage) };
  f.state.queryContext = structuredClone(originalCursor);
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.tasks); store.loadQueryCoverage = jest.fn(async () => f.state.coverage);
  store.append = jest.fn(async (...args) => {
    await append(...args); f.state.tasks = structuredClone(args[2].taskContexts); f.state.coverage = structuredClone(args[2].queryCoverage);
    if (args[2].queryContext) f.state.queryContext = structuredClone(args[2].queryContext);
  });
  f.repository.query.mockImplementation(async (_, args) => {
    if (args.datasetId === 'asset-snapshots') return { scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [structuredClone(capture.source)] };
    if (args.datasetId !== 'finance-transactions') throw Error('Unexpected cursor replay dataset');
    const source = structuredClone(capture.financeSource), included = source.rows.filter(row => row.date >= args.scope.startDate && row.date <= args.scope.endDate);
    source.rows = included; source.asOf = now().toISOString(); source.queryMeta = { ...source.queryMeta, queryId: args.queryId,
      requestedScope: args.requestedScope, effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate },
      filters: { direction: args.direction, text: args.filter }, matchedRowCount: included.length ? 153 : 0,
      returnedRowCount: included.length, sourceRecordCount: included.length ? 153 : 0, rowsComplete: !included.length, summaryComplete: true,
      rankingComplete: true, returnedDateRange: included.length ? { startDate: included[0].date, endDate: included[0].date } : null, asOf: source.asOf };
    if (!included.length) source.summary = { currency: 'CNY', expense: '0.00', income: '0.00', count: 0, incomeCount: 0, expenseCount: 0, unpricedCount: 0 };
    return { scope: args.scope, choices: {}, asOf: source.asOf, datasets: [source] };
  });
  return f;
}
test('X17 does not externalize or persist the unrelated finance cursor as an asset period', async () => {
  const f = replay(), result = await f.send(capture.message), input = inputOf(f.provider.mock.calls[0][1]);
  expect(input.activeQuery).toBeNull();
  expect(input.taskContexts).toEqual(capture.taskContexts);
  expect(input.previousQueryCoverage.map(row => row.datasetId)).toEqual(capture.previousQueryCoverage.map(row => row.datasetId));
  expect(input.previousQueryCoverage.find(row => row.datasetId === 'asset-snapshots')).toMatchObject({ effectiveScope: capture.expectedScope });
  expect(input.taskContext.scope).toEqual(capture.expectedScope);
  expect(result.datasets[0].queryMeta.effectiveScope).toEqual(capture.expectedScope);
  expect(storePayload(f)).not.toHaveProperty('queryContext'); expect(f.state.queryContext).toEqual(originalCursor);
  expect(f.state.coverage.results.find(row => row.queryId === result.datasets[0].queryMeta.queryId)).toMatchObject({ effectiveScope: capture.expectedScope });
  evidence.push({ name: 'X17-no-cursor-overwrite', input, result, savedCursor: f.state.queryContext, append: storePayload(f) });
});
test('X17 then a finance followup without any month resumes the prior finance scope and maximum', async () => {
  const f = replay(); await f.send(capture.message); const at = f.provider.mock.calls.length;
  const result = await f.send(financeFollowup), input = inputOf(f.provider.mock.calls[at][1]);
  expect(f.repository.query).toHaveBeenCalledTimes(2);
  expect(f.repository.query.mock.calls.at(-1)[1]).toMatchObject({ datasetId: 'finance-transactions', scope: originalScope, direction: 'expense', sort: 'amountDesc', limit: 1 });
  expect(input.activeQuery).toMatchObject({ ...originalScope, periodSource: 'inherited', metric: 'transaction-max' });
  expect(result.datasets[0].rows[0]).toMatchObject({ date: '2026-06-18', amountCNY: '999.00' }); expect(result.answer).toContain('999.00');
  expect(f.state.queryContext.activeQuery).toMatchObject(originalScope); expect(result.chart).toBeNull();
  evidence.push({ name: 'X17-to-finance-no-month', input, result, savedCursor: f.state.queryContext });
});
test('a new explicit finance date still replaces the prior cursor after X17', async () => {
  const f = replay(); await f.send(capture.message); await f.send(newFinance);
  expect(f.repository.query.mock.calls.at(-1)[1].scope).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
  expect(f.state.queryContext.activeQuery).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
});
test('a standalone new non-finance date uses its own scope and leaves finance history untouched', async () => {
  const f = replay(); const result = await f.send('重新查询2026年11月1日至8日流动资产系统快照。');
  expect(result.datasets[0].queryMeta.effectiveScope).toEqual({ startDate: '2026-11-01', endDate: '2026-11-08' });
  expect(storePayload(f)).not.toHaveProperty('queryContext'); expect(f.state.queryContext).toEqual(originalCursor);
});
test('a mixed finance and asset request persists the actual finance clause cursor while preserving both scopes', async () => {
  const f = replay(); const result = await f.send('分别查询：11月1日至9日流动资产系统保存快照；2026年10月1日至31日支出最大的一笔，最多展示1条。');
  expect(result.datasets.map(row => row.datasetId).sort()).toEqual(['asset-snapshots', 'finance-transactions']);
  expect(result.datasets.find(row => row.datasetId === 'asset-snapshots').queryMeta.effectiveScope).toEqual(capture.expectedScope);
  expect(f.state.queryContext.activeQuery).toMatchObject({ startDate: '2026-10-01', endDate: '2026-10-31' });
  expect(storePayload(f).queryContext).toBeDefined();
});
const storePayload = f => f.state.conversationStore.append.mock.calls.at(-1)[2];
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
  if (process.env.AI_X17_CURSOR_EVIDENCE_FILE) require('fs').writeFileSync(process.env.AI_X17_CURSOR_EVIDENCE_FILE, JSON.stringify({ realProviderCalls: 0, realDatabaseCalls: 0, evidence }, null, 2));
});
