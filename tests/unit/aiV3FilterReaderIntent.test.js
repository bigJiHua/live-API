jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden'); }) }));
const { fixture, calls, final, now } = require('./fixtures/aiV3DatasetIntentFixture.cjs');
const load = name => require('../../src/modules/ai/service/' + name);
const { FILTER_FIELDS, getFilterFields, naturalFilterPermitted } = load('queryFilterSemantics');
const { filterBasisIssue } = load('queryDatasetIntent');
const { DATASETS } = require('../../src/modules/ai/service/datasetCapabilities');
const inputOf = messages => JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:')).content.slice(11));
const toolsOf = messages => messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
const snapshot = { date: '2026-11-06', totalAsset: '14886.64', creditDebt: '5967.50', netAsset: '8919.14', recordedAt: '2026-11-06 12:00:00' };
const columnTypes = { date: 'date', totalAsset: 'money', creditDebt: 'money', netAsset: 'money', balance: 'money', principal: 'money', profit: 'money', marketValue: 'money', income: 'money', daySalary: 'money', positiveAssets: 'money', creditOverflow: 'money', otherDebt: 'money', count: 'number' };
const evidence = [];
// Fixture matching follows the independent reader aliases, so a registry
// declaration that drifts cannot silently make its own expectation pass.
const readerSource = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/modules/ai/service/businessRead.js'), 'utf8');
const readerFields = Object.fromEntries([...readerSource.matchAll(/'([^']+)': \{ text: \[([^\]]*)\], order:/g)]
  .map(([, datasetId, fieldText]) => [datasetId, [...fieldText.matchAll(/'([^']+)'/g)].map(match => match[1])]));
Object.assign(readerFields, { 'finance-monthly': [], 'finance-categories': ['category'],
  'finance-transactions': ['category', 'remark', 'currency'], 'finance-daily': ['category'], 'card-monthlyConsumption': ['name'] });
function replay(datasetId, initialFilter, rows, { correction = '', repeat = false, respondOverride } = {}) {
  const respond = (_, messages, __, options) => {
    if (respondOverride) return respondOverride(_, messages, __, options);
    const tools = toolsOf(messages), previous = tools.at(-1);
    if (!options.json && (!tools.length || previous?.status === 'error')) return calls('query_data', { datasetId,
      filter: previous?.status === 'error' && !repeat ? correction : initialFilter, limit: 10 });
    return final({ answer: '本轮查询已完成，范围和数量见返回结果。', chart: null });
  };
  const f = fixture(Array.from({ length: 30 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = [...new Set(Object.values(DATASETS))];
  f.repository.query.mockImplementation(async (_, args) => {
    const fields = readerFields[args.datasetId], needle = args.filter.toLocaleLowerCase();
    const selected = rows.filter(row => !needle || fields.some(field => String(row[field] ?? '').toLocaleLowerCase().includes(needle)));
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
    return { scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [{ datasetId: args.datasetId, domain: DATASETS[args.datasetId],
      title: args.datasetId, columns: keys.map(key => ({ key, label: key, type: columnTypes[key] || 'text' })), rows: selected,
      summary: { ...(args.datasetId.startsWith('asset-') ? { currency: 'unverified' } : { currency: 'CNY' }) },
      asOf: now().toISOString(), policy: '本人已保存记录；过滤先在全范围完成。', truncated: false,
      fullRangeQuery: { filter: args.filter, matchedRowCount: selected.length,
        ...(args.datasetId === 'asset-composition' ? { sourceRecordCount: selected.reduce((sum, row) => sum + row.count, 0) } : {}) } }] };
  });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] });
  store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => { await append(...args); f.state.tasks = structuredClone(args[2].taskContexts); f.state.coverage = structuredClone(args[2].queryCoverage); });
  return f;
}
function capture(name, f, result) { evidence.push({ name, queryArgs: f.repository.query.mock.calls.map(call => call[1]),
  recoveries: f.audits.filter(entry => entry.phase === 'tool-recovery'), datasets: result.datasets, answer: result.answer, chart: result.chart,
  taskInput: inputOf(f.provider.mock.calls[0][1]) }); }
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
  if (process.env.AI_FILTER_READER_INTENT_EVIDENCE_FILE) require('fs').writeFileSync(process.env.AI_FILTER_READER_INTENT_EVIDENCE_FILE,
    JSON.stringify({ mode: 'actual production createV3Service with reader-field-filter fixtures', realProviderCalls: 0, realDatabaseCalls: 0, evidence }, null, 2));
});

test.each(['流动', '流动资产', '系统', '快照', '资产'])(
  'N16 plain snapshot topic cannot authorize timestamp filter %s before a bounded correction', async filter => {
    const f = replay('asset-snapshots', filter, [snapshot]);
    const result = await f.send('查看2026年11月1日至9日的流动资产系统快照。最多展示10条，并说明范围与数量。');
    capture('N16-topic-' + filter, f, result);
    expect(f.repository.query).toHaveBeenCalledTimes(1);
    expect(f.repository.query.mock.calls[0][1].filter).toBe('');
    expect(result.datasets[0].rows).toHaveLength(1);
    expect(result.datasets[0].queryMeta).toMatchObject({ effectiveScope: { startDate: '2026-11-01', endDate: '2026-11-09' },
      filters: { text: '' }, matchedRowCount: 1, returnedRowCount: 1 });
    expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
    expect(f.audits.find(entry => entry.phase === 'tool-recovery').response.issues)
      .toContainEqual({ path: 'filter', rule: 'dataset.filter.intent', allowedValues: [''] });
  });

test.each([
  ['account-balances', '农业银行', '查看当前农业银行账户余额。', [{ name: '农业银行 7476', balance: '100.00', currency: 'CNY' }, { name: '其他银行', balance: '50.00', currency: 'CNY' }]],
  ['fund-holdings', '天天盈', '查看当前天天盈基金持仓本金。', [{ name: '天天盈', principal: '100.00' }, { name: '别的基金', principal: '50.00' }]],
  ['fund-history', '天天盈', '查看11月份天天盈基金历史收益。', [{ name: '天天盈', date: '2026-11-06', profit: '10.00' }, { name: '别的基金', date: '2026-11-06', profit: '5.00' }]],
  ['fund-holdings', '宝宝理财', '查询当前基金持仓“宝宝理财”的登记本金。', [{ name: '宝宝理财', principal: '100.00' }, { name: '别的基金', principal: '50.00' }]],
  ['fund-holdings', '资产', '查询当前名为“资产”的基金持仓本金。', [{ name: '资产', principal: '100.00' }, { name: '别的基金', principal: '50.00' }]],
  ['work-salary', '示例公司', '查看11月份示例公司已登记工资流水。', [{ company: '示例公司', date: '2026-11-06', income: '100.00' }, { company: '别的公司', date: '2026-11-06', income: '50.00' }]],
  ['todo-events', '开会', '查看11月份开会日程。', [{ content: '开会', date: '2026-11-06' }, { content: '出游', date: '2026-11-07' }]],
  ['account-balances', 'CNY', '查询当前所有CNY账户保存余额。', [{ name: '主账户', balance: '100.00', currency: 'CNY' }, { name: '外币账户', balance: '50.00', currency: 'USD' }]],
])('natural or quoted real entity and supported currency still select %s/%s', async (datasetId, filter, message, rows) => {
  const f = replay(datasetId, filter, rows), result = await f.send(message); capture('named-' + datasetId + '-' + filter, f, result);
  expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.repository.query.mock.calls[0][1].filter).toBe(filter);
  expect(result.datasets[0].rows).toHaveLength(1); expect(result.datasets[0].queryMeta.filters.text).toBe(filter);
  expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(0);
});

test.each([
  ['asset-snapshots', '查看11月流动资产系统快照，保存时间的文字字面包含“流动”。', '流动', 0],
  ['asset-snapshots', '查看流动资产系统快照，保存时间包含2026-11-06。', '2026-11-06', 1],
  ['asset-registers', '查询11月资产登记，文本字面包含“流动”。', '流动', 0],
])('explicit literal/time-text predicate keeps its exact filter for %s', async (datasetId, message, filter, expectedRows) => {
  const rows = datasetId === 'asset-registers' ? [{ date: '2026-11-06', currency: 'CNY', netAsset: '100.00', recordedAt: snapshot.recordedAt }] : [snapshot];
  const f = replay(datasetId, filter, rows), result = await f.send(message); capture('literal-' + datasetId + '-' + filter, f, result);
  expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.repository.query.mock.calls[0][1].filter).toBe(filter);
  expect(result.datasets[0].rows).toHaveLength(expectedRows); expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(0);
});

test('same-target unchanged-filter continuation preserves legitimate named entity and scope', async () => {
  const f = replay('fund-holdings', '天天盈', [{ name: '天天盈', principal: '100.00' }]);
  await f.send('查看当前天天盈基金持仓本金。');
  const first = f.repository.query.mock.calls[0][1], result = await f.send('延续刚才这个查询，日期范围不变，筛选不变，只展示1条。');
  capture('same-target-filter-continuation', f, result);
  expect(f.repository.query.mock.calls.at(-1)[1]).toMatchObject({ datasetId: 'fund-holdings', filter: '天天盈', limit: 1, scope: first.scope });
  expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(0);
});

test.each(['示例为“农业银行”，请查询当前账户余额。', '查询当前账户余额，不查农业银行。', '查询当前账户余额，别看农业银行。'])(
  'examples and explicitly excluded entities do not authorize filter: %s', async message => {
    const f = replay('account-balances', '农业银行', [{ name: '农业银行 7476', balance: '100.00', currency: 'CNY' }, { name: '别的银行', balance: '50.00', currency: 'CNY' }]);
    const result = await f.send(message); capture('unrequested-entity-' + message, f, result);
    expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.repository.query.mock.calls[0][1].filter).toBe('');
    expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
  });

test('timestamp-only dataset cannot authorize even a quoted theme as a named entity', () => {
  expect(filterBasisIssue({ datasetId: 'asset-snapshots', filter: '流动' }, { task: { mode: 'query', subject: 'asset', targetDatasetId: 'asset-snapshots' },
    message: '查询当前流动资产系统快照“流动”。' })).toMatchObject({ path: 'filter', rule: 'dataset.filter.intent' });
});
test('repeated unsupported topic filter fails without SQL and without a second correction', async () => {
  const f = replay('asset-snapshots', '流动', [snapshot], { repeat: true });
  await expect(f.send('查看11月流动资产系统快照。')).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
});
test('reader bridge covers all 23 datasets and mirrors every generic SQL text field', () => {
  expect(Object.keys(FILTER_FIELDS).sort()).toEqual(Object.keys(DATASETS).sort());
  const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/modules/ai/service/businessRead.js'), 'utf8');
  const sqlDefinitions = [...source.matchAll(/'([^']+)': \{ text: \[([^\]]*)\], order:/g)];
  expect(sqlDefinitions).toHaveLength(18);
  for (const [, id, fieldText] of sqlDefinitions) expect(getFilterFields(id)).toEqual([...fieldText.matchAll(/'([^']+)'/g)].map(match => match[1]));
  expect(naturalFilterPermitted('asset-snapshots', '流动', { prefix: '查看流动资产系统快照' })).toBe(false);
  expect(naturalFilterPermitted('account-balances', '农业银行', { prefix: '查看当前' })).toBe(true);
  const { buildModelToolDefinitions } = load('modelToolDefinitions');
  const { definitions } = require('../../src/modules/ai/service/v3Tools');
  const definitionsForModel = buildModelToolDefinitions(definitions), branch = definitionsForModel.find(item => item.function.name === 'query_data').function.parameters.anyOf.find(item => item.properties.datasetId.enum[0] === 'asset-snapshots');
  expect(branch.properties.filter.description).toMatch(/recordedAt/); expect(branch.properties.filter.description).toMatch(/主题词不能当筛选/);
});

test('filter fields are frozen declarations read directly from the single capability registry', () => {
  const { DATASET_CAPABILITIES } = load('datasetCapabilities');
  for (const [id, capability] of Object.entries(DATASET_CAPABILITIES)) {
    expect(getFilterFields(id)).toBe(capability.acceptedArgs.filter.fields);
    expect(Object.isFrozen(capability.acceptedArgs.filter.fields)).toBe(true);
  }
  expect(getFilterFields('finance-categories')).toEqual(['category']);
  expect(getFilterFields('finance-daily')).toEqual(['category']);
  expect(getFilterFields('finance-transactions')).toEqual(['category', 'remark', 'currency']);
  expect(getFilterFields('card-repayments')).toEqual(['name', 'date', 'method']);
  expect(getFilterFields('unknown-dataset')).toEqual([]);
});
test.each([undefined, null, 'recordedAt', [], ['userId'], ['recordedAt', 'recordedAt'], ['recordedAt', 7]])(
  'capability field validation rejects malformed or private fields %j', fields => {
    const { DATASET_CAPABILITIES, assertDatasetCapabilities } = load('datasetCapabilities');
    const registry = structuredClone(DATASET_CAPABILITIES); registry['asset-snapshots'].acceptedArgs.filter.fields = fields;
    expect(() => assertDatasetCapabilities({ registry })).toThrow(/contract inconsistent/);
  });

const scenarios = require('./fixtures/aiV3FilterReaderIntentCases.json');
const literalCases = Object.entries(scenarios).filter(([, spec]) => Object.hasOwn(spec, 'expectFilter')
  && (/包含[^。；;]*[“‘「『"']/.test(spec.message) || /清空文字筛选/.test(spec.message)));
test.each(literalCases)('real scenario %s explicit text/clear filter pins the immutable expected value', (_, spec) => {
  expect(load('explicitQueryConstraints').extractExplicitQueryConstraints(spec.message)?.filter).toBe(spec.expectFilter);
});

test.each(['C05', 'C18'].flatMap(caseId => ['CNY', '', undefined].map(modelFilter => [caseId, modelFilter])))(
  '%s explicit CNY predicate survives first %j and a second empty packet with a fresh bound chart', async (caseId, modelFilter) => {
    const spec = scenarios[caseId], datasetId = spec.datasetId;
    const rows = caseId === 'C05' ? Array.from({ length: 81 }, (_, i) => ({ name: '账户' + (i + 1), balance: '100.00', currency: i < 61 ? 'CNY' : 'USD' }))
      : [{ type: 'credit', currency: '未登记', positiveAssets: '0.00', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 20 },
        { type: 'debit', currency: 'CNY', positiveAssets: '4985.09', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 59 },
        { type: 'virtual_cash', currency: 'CNY', positiveAssets: '335.50', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 1 },
        { type: 'virtual_balance', currency: 'CNY', positiveAssets: '9296.91', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 1 }];
    const respondOverride = (_, messages, __, options) => {
      const input = inputOf(messages), current = input.userTurns[input.currentTurn], tools = toolsOf(messages);
      const args = { datasetId, limit: current === spec.message ? spec.maxRows : 10 };
      if (!options.json && !tools.length) return calls('query_data', { ...args,
        ...(current === spec.message && modelFilter !== undefined ? { filter: modelFilter } : {}) });
      if (!options.json && tools.length === 1 && current === spec.message) return calls('query_data', { ...args, filter: '' });
      const dataset = tools.flatMap(item => item.datasets || []).at(-1);
      return final({ answer: '已返回本轮明确筛选的保存记录，范围与数量见结果。', chart: current === spec.message ? {
        datasetId, queryId: dataset.queryMeta.queryId, ...spec.chartExpected, title: '本轮文本筛选CNY结果' } : null });
    };
    const f = replay(datasetId, '', rows, { respondOverride });
    const previous = await f.send(caseId === 'C05' ? '查看当前账户保存余额，最多展示10条。' : '查看当前账户余额按账户类型及币种的资产组成，最多展示10条。');
    const result = await f.send(spec.message); capture(caseId + '-' + (modelFilter === undefined ? 'omitted' : modelFilter || 'empty'), f, result);
    expect(f.repository.query).toHaveBeenCalledTimes(2);
    expect(f.repository.query.mock.calls.at(-1)[1]).toMatchObject({ datasetId, filter: 'CNY', limit: spec.maxRows });
    expect(result.datasets[0].queryMeta).toMatchObject({ filters: { text: 'CNY' }, matchedRowCount: caseId === 'C05' ? 61 : 3 });
    if (caseId === 'C18') expect(result.datasets[0].queryMeta.sourceRecordCount).toBe(61);
    expect(result.datasets[0].rows).toHaveLength(caseId === 'C05' ? 10 : 3);
    expect(result.datasets[0].rows.every(row => row.currency === 'CNY')).toBe(true);
    expect(result.chart).toMatchObject({ datasetId, queryId: result.datasets[0].queryMeta.queryId, ...spec.chartExpected });
    expect(result.chart.queryId).not.toBe(previous.datasets[0].queryMeta.queryId);
    const persisted = f.state.conversationStore.append.mock.calls.at(-1)[2];
    expect(persisted.business.datasets).toEqual(result.datasets);
    expect(persisted.business.chart).toEqual(result.chart);
    expect(persisted.queryCoverage.results.find(meta => meta.queryId === result.chart.queryId)).toMatchObject({
      datasetId, filters: { text: 'CNY' }, matchedRowCount: caseId === 'C05' ? 61 : 3 });
    if (caseId === 'C18') expect(persisted.queryCoverage.results.find(meta => meta.queryId === result.chart.queryId).sourceRecordCount).toBe(61);
    expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(0);
    const paired = f.provider.mock.calls.flatMap(call => toolsOf(call[1])).filter(item => item.datasets?.[0]?.queryMeta?.queryId === result.chart.queryId);
    expect(paired.length).toBeGreaterThan(0);
    expect(paired.every(item => item.effectiveArgs.filter === 'CNY')).toBe(true);
  });

test.each(['查询当前账户余额，只筛选文本包含“CNY”或“USD”的记录。', '查询当前账户余额，文本包含“CNY”，文本包含“USD”。',
  '查询当前账户余额，文本包含“CNY”和“USD”。', '查询当前账户余额，文本包含“CNY”、"USD"以及‘HKD’。'])(
  'conflicting literal filters cannot be arbitrarily selected or bypassed with empty filter: %s', async message => {
    const f = replay('account-balances', 'CNY', [{ name: '账户', balance: '100.00', currency: 'CNY' }]);
    await expect(f.send(message)).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
    expect(f.repository.query).not.toHaveBeenCalled(); expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
  });

test.each([
  ['查询当前账户余额，例如文本包含“CNY”或“USD”。', undefined],
  ['查询当前账户余额，不要筛选文本包含“CNY”或“USD”。', undefined],
  ['查询当前账户余额，不用筛选文本包含“CNY”或“USD”。', undefined],
  ['查询当前账户余额，文本包含“CNY”。图例叫“USD”。', 'CNY'],
  ['查询当前账户余额，文本包含“CNY”或“CNY”。', 'CNY'],
])('literal connectors preserve exclusions, examples and unrelated quoted values: %s', (message, expected) => {
  const result = load('explicitQueryConstraints').extractExplicitQueryConstraints(message, { evidence: true });
  expect(result.constraints?.filter).toBe(expected); expect(result.ambiguousFilters).toBe(false);
});
