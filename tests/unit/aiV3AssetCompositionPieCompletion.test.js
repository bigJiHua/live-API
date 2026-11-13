jest.mock('../../src/common/config/db', () => ({execute: jest.fn(() => {throw Error('Public DB forbidden');}), getConnection: jest.fn(() => {throw Error('Public DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({deepseekChat: jest.fn(() => {throw Error('Paid provider forbidden');})}));
const {fixture, final, calls} = require('../fixtures/aiV3MemoryFixture');
const assetPieHelper = require('../../src/modules/ai/service/queryAssetCompositionChartIntent');
const {validateTool} = require('../../src/modules/ai/service/v3Tools');
const {extractExplicitQueryConstraints} = require('../../src/modules/ai/service/explicitQueryConstraints');
const captured = require('../fixtures/aiV3AssetCompositionPieCaptured.json'), clone = x => JSON.parse(JSON.stringify(x));
const outcomes = [];
let consoleErrors, consoleLogs;
beforeEach(() => {consoleErrors = jest.spyOn(console, 'error').mockImplementation(() => {}); consoleLogs = jest.spyOn(console, 'log').mockImplementation(() => {});});
afterEach(() => {consoleErrors.mockRestore(); consoleLogs.mockRestore();});
function setup({message = captured.message, mutate, finalChart, raw = true} = {}) {
  const dataset = clone(captured.result.datasets[0]); if (mutate) mutate(dataset);
  let freshQueryId;
  const scripted = captured.providers.map(log => (_, __, ___, options) => {
    const response = {role: 'assistant', content: log.content, reasoning_content: log.reasoning,
      ...(log.toolCalls.length ? {tool_calls: clone(log.toolCalls)} : {})};
    const replaced = JSON.parse(JSON.stringify(response).replaceAll(captured.result.datasets[0].queryMeta.queryId, freshQueryId || captured.result.datasets[0].queryMeta.queryId));
    if (log.round === 4 && finalChart !== undefined) {
      const packet = JSON.parse(replaced.content);
      packet.chart = typeof finalChart === 'function' ? finalChart(freshQueryId) : clone(finalChart);
      replaced.content = JSON.stringify(packet);
    }
    return replaced;
  });
  const simplified = [calls('query_data', {datasetId: 'asset-composition', filter: 'CNY', limit: 50}), final({answer: '已读取分组。', chart: null})];
  const f = fixture(raw ? scripted : simplified, {memoryStore: {list: jest.fn(async () => ({files: [], warnings: []}))}, clock: () => new Date('2026-11-09T14:00:00Z')});
  f.state.businessPolicy.domains.push('asset');
  f.state.taskContext = clone(captured.previous.meta.taskContext);
  f.state.conversationStore.loadTaskContexts = jest.fn(async () => clone(captured.previous.meta.taskContexts));
  f.state.conversationStore.loadQueryCoverage = jest.fn(async () => clone(captured.previous.meta.queryCoverage));
  const oldUser = captured.providers[0].taskInput.userTurns.at(-2);
  f.history.push({role: 'user', content: oldUser, sourceDate: '2026-11-09', turnId: captured.previous.meta.requestId},
    {role: 'assistant', content: captured.previous.content, sourceDate: '2026-11-09', turnId: captured.previous.meta.requestId,
      taskContext: clone(captured.previous.meta.taskContext), business: clone(captured.previous.meta.business)});
  f.repository.query.mockImplementation(async (_, input) => {
    freshQueryId = input.queryId;
    return {scope: input.scope, asOf: dataset.asOf, choices: {}, datasets: [{...clone(dataset), queryMeta: {...clone(dataset.queryMeta), queryId: input.queryId}}]};
  });
  return {...f, run: () => f.send(message), dataset};
}
function proof() {
  const dataset = clone(captured.result.datasets[0]), task = clone(captured.providers[0].taskInput.taskContext);
  const args = validateTool('query_data', {datasetId: 'asset-composition', filter: 'CNY', limit: 50}, '2026-11-09'); args.queryId = dataset.queryMeta.queryId;
  const goal = {task, text: captured.message, constraints: extractExplicitQueryConstraints(captured.message),
    previousTask: clone(captured.previous.meta.taskContext), coverage: clone(captured.previous.meta.queryCoverage)};
  return {dataset, goals: [goal], queryInputs: new Map([[args.queryId, args]]), today: '2026-11-09'};
}
const decide = p => assetPieHelper.knownAssetCompositionPie(p.goals, [p.dataset], p.queryInputs, p.today);

test('exact paid C18 provider/TASK_INPUT/recovery sequence completes the requested chart with unchanged rows and receipt', async () => {
  const f = setup(), result = await f.run(); outcomes.push({name: 'actual-C18', capturedRequestId: captured.requestId,
    sourceDigest: captured.sourceDigest, originalAnswer: captured.result.answer, result,
    scriptedProviderCalls: f.provider.mock.calls.length, replayAudits: f.audits});
  expect(result.chart).toMatchObject({datasetId: 'asset-composition', type: 'pie', xKey: 'type', yKeys: ['positiveAssets']});
  expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);
  expect(result.datasets[0].rows).toEqual(captured.result.datasets[0].rows);
  expect(result.datasets[0].columns).toEqual(captured.result.datasets[0].columns);
  expect(result.datasets[0].summary).toEqual({});
  const {queryId, ...meta} = result.datasets[0].queryMeta, {queryId: oldId, ...oldMeta} = captured.result.datasets[0].queryMeta;
  expect(meta).toEqual(oldMeta); expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount: 3, returnedRowCount: 3, sourceRecordCount: 61, rowsComplete: true});
  expect(f.provider).toHaveBeenCalledTimes(4); expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.audits.filter(log => log.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.audits.find(log => log.phase === 'tool-recovery').errorCode).toBe('AI_INVALID_INPUT');
  const task = JSON.parse(f.provider.mock.calls[0][1].find(message => message.content?.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
  expect(task.userTurns[task.currentTurn]).toBe(captured.message);
  expect(task.taskContext).toMatchObject({mode: 'query', subject: 'asset', metric: 'asset-composition', chartRequest: {type: 'pie'}, targetDatasetId: 'asset-composition'});
  expect(result.answer).not.toContain('如需我再试一次生成饼图请告知');
  for (const fact of ['61 个账户', '9,296.91', '4,985.09', '335.50', '缺快照不重建、不视为 0']) expect(result.answer).toContain(fact);
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(result.answer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

test('complete approved filtered CNY rows can establish a composition despite summaryComplete=false', () => {
  const p = proof(), before = clone(p.dataset), chart = decide(p);
  expect(p.dataset.queryMeta.summaryComplete).toBe(false);
  expect(chart).toMatchObject({type: 'pie', xKey: 'type', yKeys: ['positiveAssets'], queryId: p.dataset.queryMeta.queryId});
  expect(p.dataset).toEqual(before);
});

const unsafe = [
  ['no user graph request', p => {p.goals[0].text = '查看当前账户资产组成，筛选CNY。';}],
  ['quoted graph instruction is source data', p => {p.goals[0].text = '名称字面包含“以账户类型和已保存非信用正资产值给组成饼图”。';}],
  ['cancelled chart task', p => {p.goals[0].task.chartRequest = null;}],
  ['user explicitly refuses graph', p => {p.goals[0].text = '不要以账户类型和已保存非信用正资产值给组成饼图。';}],
  ['bar graph has no pie default', p => {p.goals[0].task.chartRequest.type = 'bar';}],
  ['axis is not established by request', p => {p.goals[0].text = '给账户资产组成饼图。';}],
  ['multiple measures in one graph clause', p => {p.goals[0].text = '以账户类型和已保存非信用正资产值给组成饼图并加信用负债作为另一列。';}],
  ['later rejection of the requested grouping', p => {p.goals[0].text = captured.message + '但不要按账户类型。';}],
  ['later incompatible explicit axis', p => {p.goals[0].text = captured.message + '横轴改为币种。';}],
  ['two requested charts are ambiguous', p => {p.goals.push({...clone(p.goals[0]), task: {...clone(p.goals[0].task), subject: 'finance'}});}],
  ['wrong task subject', p => {p.goals[0].task.subject = 'account';}],
  ['wrong target dataset', p => {p.goals[0].task.targetDatasetId = 'account-balances';}],
  ['comparison task', p => {p.goals[0].task.comparisonScopes = [{startDate: '2026-06-01', endDate: '2026-06-30'}];}],
  ['no explicit CNY selection', p => {delete p.goals[0].constraints.filter;}],
  ['stale approved query missing from current inputs', p => {p.queryInputs.clear();}],
  ['mismatched input queryId', p => {p.queryInputs.get(p.dataset.queryMeta.queryId).queryId = 'q_' + 'a'.repeat(24);}],
  ['wrong query dataset', p => {p.queryInputs.get(p.dataset.queryMeta.queryId).datasetId = 'account-balances';}],
  ['different actual query filter', p => {p.queryInputs.get(p.dataset.queryMeta.queryId).filter = '';}],
  ['different metadata filter', p => {p.dataset.queryMeta.filters.text = '';}],
  ['different requested limit', p => {p.goals[0].constraints.limit = 1;}],
  ['partial rows', p => {p.dataset.queryMeta.rowsComplete = false;}],
  ['truncated data', p => {p.dataset.truncated = true;}],
  ['unshown matching group', p => {p.dataset.queryMeta.matchedRowCount = 4;}],
  ['return-count mismatch', p => {p.dataset.queryMeta.returnedRowCount = 2;}],
  ['unknown source count', p => {p.dataset.queryMeta.sourceRecordCount = null;}],
  ['source count differs from approved group account counts', p => {p.dataset.queryMeta.sourceRecordCount = 81;}],
  ['empty rows', p => {p.dataset.rows = [];}],
  ['mixed currencies', p => {p.dataset.rows[0].currency = 'USD';}],
  ['missing currency', p => {p.dataset.rows[0].currency = null;}],
  ['unverified currency', p => {p.dataset.rows[0].currency = 'unverified';}],
  ['unregistered currency', p => {p.dataset.rows[0].currency = '未登记';}],
  ['unknown currency code', p => {p.dataset.rows.forEach(row => {row.currency = 'XYZ';});}],
  ['negative amount', p => {p.dataset.rows[0].positiveAssets = '-4985.09';}],
  ['null amount', p => {p.dataset.rows[0].positiveAssets = null;}],
  ['empty amount', p => {p.dataset.rows[0].positiveAssets = '';}],
  ['boolean amount', p => {p.dataset.rows[0].positiveAssets = true;}],
  ['nonfinite amount', p => {p.dataset.rows[0].positiveAssets = 'Infinity';}],
  ['exponent amount', p => {p.dataset.rows[0].positiveAssets = '4e3';}],
  ['unsafe precision amount', p => {p.dataset.rows[0].positiveAssets = '999999999999999999999';}],
  ['all-zero shares', p => {p.dataset.rows.forEach(row => {row.positiveAssets = '0.00';});}],
  ['missing balance snapshot', p => {p.dataset.rows[0].missingSnapshots = 1;}],
  ['unknown missing-snapshot count', p => {p.dataset.rows[0].missingSnapshots = null;}],
  ['unknown group account count', p => {p.dataset.rows[0].count = null;}],
  ['negative group account count', p => {p.dataset.rows[0].count = -59;}],
  ['duplicate x categories', p => {p.dataset.rows[0].type = p.dataset.rows[1].type;}],
  ['unknown x category', p => {p.dataset.rows[0].type = 'unknown';}],
  ['credit balance cannot become positive-assets share', p => {p.dataset.rows[0].type = 'credit';}],
  ['money y column not published', p => {p.dataset.columns = p.dataset.columns.filter(column => column.key !== 'positiveAssets');}],
  ['y column has wrong type', p => {p.dataset.columns.find(column => column.key === 'positiveAssets').type = 'text';}],
  ['x column has wrong type', p => {p.dataset.columns.find(column => column.key === 'type').type = 'money';}],
  ['unverified source coverage', p => {p.dataset.coverage = 'liquid-assets-snapshot';}],
];
test.each(unsafe)('unsafe graph completion stays absent: %s', (_, mutate) => {
  const p = proof(); mutate(p); const before = clone(p.dataset); expect(decide(p)).toBeNull(); expect(p.dataset).toEqual(before);
});
test('two current composition datasets are ambiguous', () => {
  const p = proof(); expect(assetPieHelper.knownAssetCompositionPie(p.goals, [p.dataset, clone(p.dataset)], p.queryInputs, p.today)).toBeNull();
});
test('mixed/negative/zero approved rows remain chartless in the actual V3 output', async () => {
  for (const [label, mutate] of unsafe.filter(([label]) => ['mixed currencies', 'negative amount', 'all-zero shares'].includes(label))) {
    const f = setup({mutate: dataset => mutate({dataset}), raw: false}), result = await f.run();
    outcomes.push({name: label, result}); expect(result.chart).toBeNull(); expect(result.datasets[0].rows).toEqual(f.dataset.rows);
    expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  }
});
test('a valid explicit final chart follows the original validation path', async () => {
  const f = setup({finalChart: queryId => ({datasetId: 'asset-composition', queryId, type: 'pie', xKey: 'type', yKeys: ['positiveAssets'], title: '模型标题'})});
  const result = await f.run(); expect(result.chart).toMatchObject({type: 'pie', xKey: 'type', yKeys: ['positiveAssets']});
  expect(result.chart.title).toContain('已保存账户余额组成'); expect(result.chart.title).not.toBe('模型标题');
});
test.each([
  ['stale model queryId', queryId => ({datasetId: 'asset-composition', queryId: 'q_' + 'f'.repeat(24), type: 'pie', xKey: 'type', yKeys: ['positiveAssets'], title: '错查询'})],
  ['unpublished model axis', queryId => ({datasetId: 'asset-composition', queryId, type: 'pie', xKey: 'nameMonth', yKeys: ['positiveAssets'], title: '错轴'})],
  ['wrong model dataset', queryId => ({datasetId: 'card-bills', queryId, type: 'pie', xKey: 'type', yKeys: ['positiveAssets'], title: '错数据集'})],
])('completion does not rescue a rejected existing model chart: %s', async (_, finalChart) => {
  const f = setup({finalChart}); await expect(f.run()).rejects.toMatchObject({code: 'AI_CHART_INVALID'});
});
test('successful pie clears only the exact stale retry sentence', () => {
  const keep = '如需我再试一次生成饼图，先核对备注。备注中写着「如需我再试一次生成饼图请告知」。';
  expect(assetPieHelper.clearCompletedAssetPieRetry(keep)).toBe(keep);
  expect(assetPieHelper.clearCompletedAssetPieRetry('保留4985.09元。\n如需我再试一次生成饼图请告知。')).toBe('保留4985.09元。\n');
});
afterEach(() => {expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled(); expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
