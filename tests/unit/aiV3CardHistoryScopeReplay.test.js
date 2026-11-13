jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden'); }) }));
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const mode = 'production', observations = [];

const scenarios = [
  { datasetId: 'card-bills', message: '查看2026年9月至11月已保存的信用卡账单快照、本期账单和待还金额。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。',
    scope: { startDate: '2026-09-01', endDate: '2026-11-30' }, metric: 'card-bills' },
  { datasetId: 'card-repayments', message: '查看2026年5月1日至8月31日已保存信用卡还款历史。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。',
    scope: { startDate: '2026-05-01', endDate: '2026-08-31' }, metric: 'card-repayments' },
];
const followup = '延续刚才这个查询，日期范围不变，清空文字筛选，改为只展示1条。告诉我范围里共有多少条、这次展示几条。';
function replay(scenario, wrongScope, badFields = {}) {
  const respond = (_, messages, __, options) => {
    const input = JSON.parse(messages.find(turn => turn.role === 'user' && turn.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
    const current = input.userTurns[input.currentTurn], tools = messages.filter(turn => turn.role === 'tool');
    if (!options.json && !tools.length) return calls('query_data', { datasetId: scenario.datasetId, limit: 1,
      ...(current === scenario.message ? scenario.scope : wrongScope), ...(current === scenario.message ? {} : badFields) });
    return final({ answer: '已查询本人保存的卡片历史数据。' });
  };
  const f = fixture(Array.from({ length: 18 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.repository.query.mockImplementation(async (_, args) => {
    const bill = args.datasetId === 'card-bills';
    const rows = bill ? [{ id: 'bill-fixture', name: '已保存信用卡', month: args.scope.startDate.slice(0, 7), billAmount: '80.00', needRepay: '30.00' }]
      : [{ id: 'repay-fixture', name: '已保存信用卡', date: args.scope.startDate + ' 12:00:00', amount: '50.00' }];
    const columns = bill ? [{ key: 'name', label: '卡片', type: 'text' }, { key: 'month', label: '月份', type: 'date' },
      { key: 'billAmount', label: '本期账单', type: 'money' }, { key: 'needRepay', label: '保存待还', type: 'money' }]
      : [{ key: 'name', label: '卡片', type: 'text' }, { key: 'date', label: '还款时间', type: 'text' }, { key: 'amount', label: '保存还款金额', type: 'money' }];
    return { scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [{ datasetId: args.datasetId,
      domain: 'card', title: '卡片历史保存数据', rows, columns, summary: {}, policy: '只读保存历史。', truncated: false, asOf: now().toISOString() }] };
  });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] });
  store.append = jest.fn(async (...args) => { await append(...args); f.state.coverage = structuredClone(args[2].queryCoverage); f.state.tasks = structuredClone(args[2].taskContexts); });
  return f;
}
test.each(scenarios)('confirmed $datasetId scope survives a legal current-month model range', async scenario => {
  const f = replay(scenario, { startDate: '2026-11-01', endDate: '2026-11-08' });
  const first = await f.send(scenario.message); expect(first.datasets[0].queryMeta.effectiveScope).toEqual(scenario.scope);
  const at = f.provider.mock.calls.length, next = await f.send(followup);
  const input = JSON.parse(f.provider.mock.calls[at][1].find(turn => turn.role === 'user' && turn.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
  observations.push({ datasetId: scenario.datasetId, mode, taskScope: input.taskContext.scope,
    effectiveScope: next.datasets[0].queryMeta.effectiveScope, queries: f.repository.query.mock.calls.map(call => call[1].scope) });
  expect(input.taskContext).toMatchObject({ subject: 'cards', metric: scenario.metric, scope: scenario.scope });
  expect(next.datasets[0].queryMeta.effectiveScope).toEqual(scenario.scope);
  expect(f.repository.query.mock.calls.at(-1)[1].scope).toMatchObject(scenario.scope);
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test.each(scenarios)('confirmed $datasetId scope cannot silently shrink to a legal partial range', async scenario => {
  const wrong = scenario.datasetId === 'card-bills' ? { startDate: '2026-09-01', endDate: '2026-09-30' }
    : { startDate: '2026-05-15', endDate: '2026-08-31' };
  const f = replay(scenario, wrong); await f.send(scenario.message); const next = await f.send(followup);
  expect(next.datasets[0].queryMeta.effectiveScope).toEqual(scenario.scope);
});
test.each(scenarios)('a new explicit month legitimately updates $datasetId scope', async scenario => {
  const requested = { startDate: '2026-06-01', endDate: '2026-06-30' }, f = replay(scenario, requested);
  await f.send(scenario.message);
  const next = await f.send(scenario.datasetId === 'card-bills' ? '改为2026年6月已保存信用卡账单。' : '改为2026年6月已保存信用卡还款历史。');
  expect(next.datasets[0].queryMeta.effectiveScope).toEqual(requested);
});
test.each(scenarios)('bad calendars remain rejected before pinning $datasetId scope', async scenario => {
  const f = replay(scenario, { startDate: '2026-02-30', endDate: '2026-03-01' }); await f.send(scenario.message);
  const error = await f.send(followup).catch(value => value);
  observations.push({ variant: 'bad-calendar', datasetId: scenario.datasetId, mode, code: error.code,
    queries: f.repository.query.mock.calls.length, audit: f.audits.filter(row => row.phase === 'tool-recovery') });
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.audits.some(row => row.phase === 'tool-recovery' && row.errorCode === 'AI_SCOPE_INVALID')).toBe(true);
});
test.each(scenarios)('unsupported direction is still rejected for $datasetId', async scenario => {
  const f = replay(scenario, { startDate: '2026-11-01', endDate: '2026-11-08' }, { direction: 'income' }); await f.send(scenario.message);
  const error = await f.send(followup).catch(value => value);
  observations.push({ variant: 'unsupported-direction', datasetId: scenario.datasetId, mode, code: error.code,
    queries: f.repository.query.mock.calls.length, audit: f.audits.filter(row => row.phase === 'tool-recovery') });
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.audits.some(row => row.phase === 'tool-recovery' && row.errorCode === 'AI_TOOL_ARGUMENT_INVALID')).toBe(true);
});
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
