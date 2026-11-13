jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Real provider forbidden'); }) }));
const { fixture, final, calls, now } = require('./fixtures/aiV3DatasetIntentFixture.cjs');
const load = name => require('../../src/modules/ai/service/' + name);
const { explicitPeriod, buildQueryContext } = load('queryContext');
const { buildTaskContext } = load('taskContext');
const capture = require('./fixtures/aiV3ScopeMonthReferenceCases.json');
const today = '2026-11-09', previous = capture.taskContexts.tasks.find(task => task.subject === 'asset');
const unchanged = capture.expectedScope;
const inputOf = messages => JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
const evidence = [];
test.each([
  capture.message,
  '回到刚才11月份流动资产系统快照部分，日期范围不变，重新查询。',
  '沿用刚才2026年11月资产系统快照，时间范围不变，查询前1条。',
  '延续刚才十一月资产系统快照，范围不变，重新查询。',
])('same month names an unchanged prior subtask: %s', message => {
  expect(explicitPeriod(message, today, unchanged)).toBeNull();
  expect(buildTaskContext({ message, today, previous })).toMatchObject({ targetDatasetId: 'asset-snapshots', scope: unchanged });
  const query = buildQueryContext({ message, today, previous: { version: 1, activeQuery: { ...unchanged, metric: 'summary' } } });
  expect(query.activeQuery).toMatchObject({ ...unchanged, periodSource: 'inherited', explicit: { period: false } });
});
test.each([
  ['查询11月流动资产系统快照。', { startDate: '2026-11-01', endDate: '2026-11-30' }],
  ['回到刚才11月资产系统快照部分，重新查询。', { startDate: '2026-11-01', endDate: '2026-11-30' }],
  ['回到刚才11月资产系统快照部分，不要范围不变，重新查询。', { startDate: '2026-11-01', endDate: '2026-11-30' }],
  ['回到刚才11月资产系统快照部分，范围不变，但改查全月。', { startDate: '2026-11-01', endDate: '2026-11-30' }],
  ['回到刚才10月资产系统快照部分，范围不变，重新查询。', { startDate: '2026-10-01', endDate: '2026-10-31' }],
  ['回到刚才2025年11月资产系统快照部分，范围不变，重新查询。', { startDate: '2025-11-01', endDate: '2025-11-30' }],
  ['回到刚才11月资产系统快照部分，范围不变，改成11月2日至8日。', { startDate: '2026-11-02', endDate: '2026-11-08' }],
  ['回到刚才11月资产系统快照部分，范围不变，改成2026-11-02至2026-11-08。', { startDate: '2026-11-02', endDate: '2026-11-08' }],
])('fresh or explicitly corrected periods retain precedence: %s', (message, expected) => {
  expect(explicitPeriod(message, today, unchanged)).toEqual(expected);
  expect(buildTaskContext({ message, today, previous }).scope).toEqual(expected);
});
test('an unchanged marker without a valid matching prior scope cannot establish inheritance', () => {
  expect(explicitPeriod(capture.message, today, null)).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
  expect(explicitPeriod(capture.message, today, { startDate: '2026-11-01', endDate: '2026-12-09' })).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
  expect(explicitPeriod(capture.message, today, { startDate: 'invalid', endDate: '2026-11-09' })).toEqual({ startDate: '2026-11-01', endDate: '2026-11-30' });
});
test('a current invalid explicit date cannot be laundered by an unchanged month reference', () => {
  expect(() => explicitPeriod('回到刚才11月资产系统快照部分，范围不变，改成2026-11-31。', today, unchanged))
    .toThrow(expect.objectContaining({ code: 'AI_SCOPE_INVALID' }));
});
test.each([capture.modelArgs, { datasetId: 'asset-snapshots', limit: 1 }, { datasetId: 'asset-snapshots', startDate: '2026-11-01', endDate: '2026-11-30', limit: 1 }])(
  'X17 actual service resumes the asset task after other subjects with model args %j', async modelArgs => {
    const respond = (_, messages, __, options) => {
      if (!options.json && !messages.some(item => item.role === 'tool')) return calls('query_data', modelArgs);
      return final({ answer: '该范围保存快照币种未确认，不能确认为人民币。', chart: null });
    };
    const f = fixture(Array.from({ length: 12 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
    f.state.businessPolicy.domains = ['finance', 'card', 'asset', 'work'];
    f.state.tasks = structuredClone(capture.taskContexts); f.state.taskContext = structuredClone(f.state.tasks.tasks.at(-1));
    f.state.coverage = { version: 1, results: structuredClone(capture.previousQueryCoverage) };
    f.state.queryContext = { version: 1, activeQuery: { startDate: '2026-06-01', endDate: '2026-06-30', direction: 0, metric: 'transaction-max', status: 'succeeded' } };
    const store = f.state.conversationStore, append = store.append.getMockImplementation();
    store.loadTaskContexts = jest.fn(async () => f.state.tasks); store.loadQueryCoverage = jest.fn(async () => f.state.coverage);
    store.append = jest.fn(async (...args) => { await append(...args); f.state.tasks = structuredClone(args[2].taskContexts); f.state.coverage = structuredClone(args[2].queryCoverage); });
    f.repository.query.mockImplementation(async (_, args) => ({ scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [structuredClone(capture.source)] }));
    const result = await f.send(capture.message), input = inputOf(f.provider.mock.calls[0][1]);
    evidence.push({ name: 'X17', modelArgs, inputTask: input.taskContext, queryArgs: f.repository.query.mock.calls[0][1],
      result, persisted: f.state.conversationStore.append.mock.calls.at(-1)[2] });
    expect(input.taskContext).toMatchObject({ subject: 'asset', targetDatasetId: 'asset-snapshots', chartRequest: null, scope: unchanged });
    expect(f.repository.query).toHaveBeenCalledTimes(1);
    expect(f.repository.query.mock.calls[0][1]).toMatchObject({ datasetId: 'asset-snapshots', ...unchanged, limit: 1, scope: unchanged });
    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0].queryMeta).toMatchObject({ requestedScope: unchanged, effectiveScope: unchanged, matchedRowCount: 1, returnedRowCount: 1 });
    expect(result.datasets[0].rows[0].netAsset).toBe('8919.14'); expect(result.chart).toBeNull();
    expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(0);
    const persisted = store.append.mock.calls.at(-1)[2];
    expect(persisted.business.datasets).toEqual(result.datasets); expect(persisted.business.chart).toBeNull();
    expect(persisted.taskContexts.tasks.find(task => task.subject === 'asset')).toMatchObject({ scope: unchanged });
    for (const subject of ['finance', 'cards', 'work']) expect(persisted.taskContexts.tasks.find(task => task.subject === subject))
      .toEqual(capture.taskContexts.tasks.find(task => task.subject === subject));
    expect(persisted.queryCoverage.results.find(meta => meta.queryId === result.datasets[0].queryMeta.queryId)).toMatchObject({ effectiveScope: unchanged });
    expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  });
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
  if (process.env.AI_X17_SCOPE_EVIDENCE_FILE) require('fs').writeFileSync(process.env.AI_X17_SCOPE_EVIDENCE_FILE, JSON.stringify({ realProviderCalls: 0, realDatabaseCalls: 0, evidence }, null, 2));
});
