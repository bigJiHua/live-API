jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden'); }) }));
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const composition = '查看当前已保存账户余额按账户类型及币种的资产组成。最多展示10条，并说明范围和数量。';
const followup = '延续刚才这个查询，日期范围不变，清空文字筛选，改为只展示1条。告诉我范围里共有多少条、这次展示几条。';
const finish = answer => final({ answer: answer || '已查询请求的数据，实际范围与数量见数据集。', proposal: null, proposals: null, clarification: null, chart: null });
const toolResults = messages => messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
const taskInput = messages => JSON.parse(messages.find(message => message.role === 'user' && message.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
const batch = (...items) => ({ role: 'assistant', content: null, tool_calls: items.flatMap(item => item.tool_calls) });
function replay(initial, { correction, repeat = false, answer } = {}) {
  const respond = (_, messages, __, options) => {
    const input = taskInput(messages), current = input.userTurns[input.currentTurn], tools = toolResults(messages);
    if (!options.json && !tools.length) return typeof initial === 'function' ? initial(current) : calls('query_data', initial);
    if (!options.json && tools.at(-1)?.status === 'error' && (repeat || correction)) {
      const retryArgs = repeat ? typeof initial === 'function' ? JSON.parse(initial(current).tool_calls[0].function.arguments) : initial : correction;
      return calls('query_data', retryArgs);
    }
    return finish(answer);
  };
  const f = fixture(Array.from({ length: 20 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = ['finance', 'account', 'card', 'todo', 'asset', 'work', 'fund'];
  f.repository.query.mockImplementation(async (_, args) => {
    const datasetId = args.datasetId, scope = args.scope, asOf = now().toISOString();
    let rows, columns, summary, domain;
    if (datasetId === 'asset-composition') {
      domain = 'asset';
      rows = [{ type: 'credit', currency: '未登记', positiveAssets: '0.00', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 20, missingSnapshots: 20 },
        { type: 'debit', currency: 'CNY', positiveAssets: '4985.09', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 59, missingSnapshots: 0 },
        { type: 'virtual_cash', currency: 'CNY', positiveAssets: '335.50', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 1, missingSnapshots: 0 },
        { type: 'virtual_balance', currency: 'CNY', positiveAssets: '9296.91', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', count: 1, missingSnapshots: 0 }];
      columns = ['type', 'currency'].map(key => ({ key, label: key, type: 'text' })).concat(
        ['positiveAssets', 'creditDebt', 'creditOverflow', 'otherDebt'].map(key => ({ key, label: key, type: 'money' })),
        ['count', 'missingSnapshots'].map(key => ({ key, label: key, type: 'number' })));
      summary = { count: 81 };
    } else if (datasetId === 'work-salary') {
      domain = 'work'; rows = []; summary = { income: '0.00', count: 0, currency: 'CNY' };
      columns = [{ key: 'date', label: '工作日期', type: 'date' }, { key: 'income', label: '登记工资', type: 'money' }];
    } else {
      domain = 'account';
      rows = args.filter ? [{ name: args.filter + '账户', type: 'debit', balance: '10.00', currency: 'CNY' }]
        : Array.from({ length: 10 }, (_, i) => ({ name: '余额明细账户' + (i + 1), type: 'debit', balance: '10.00', currency: 'CNY' }));
      columns = [{ key: 'name', label: '账户', type: 'text' }, { key: 'type', label: '类型', type: 'text' },
        { key: 'balance', label: '保存余额', type: 'money' }, { key: 'currency', label: '币种', type: 'text' }];
      summary = { count: args.filter ? 1 : 81 };
    }
    const matchedRowCount = datasetId === 'account-balances' && !args.filter ? 81 : rows.length;
    return { scope, asOf, choices: {}, datasets: [{ datasetId, domain, title: datasetId, rows, columns, summary,
      policy: '本人已保存数据；按各自数据集粒度提供。', asOf, truncated: false,
      fullRangeQuery: { filter: args.filter || '', matchedRowCount } }] };
  });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] });
  store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => { await append(...args); f.state.tasks = structuredClone(args[2].taskContexts);
    f.state.coverage = structuredClone(args[2].queryCoverage); });
  return f;
}
const recovery = f => f.audits.filter(row => row.phase === 'tool-recovery');
const readIds = f => f.repository.query.mock.calls.map(call => call[1].datasetId);
function noBusinessWrites(f) { expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled(); }
let errors;
beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});

test('composition wrong grain is rejected before SQL and corrected to full source aggregation once', async () => {
  const f = replay({ datasetId: 'account-balances', limit: 10 }, { correction: { datasetId: 'asset-composition', limit: 10 } });
  const result = await f.send(composition);
  expect(readIds(f)).toEqual(['asset-composition']);
  expect(result.datasets.map(dataset => dataset.datasetId)).toEqual(['asset-composition']);
  expect(result.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 4, returnedRowCount: 4, sourceRecordCount: 81, rowsComplete: true });
  expect(result.datasets[0].rows.find(row => row.type === 'debit')).toMatchObject({ count: 59, positiveAssets: '4985.09' });
  expect(recovery(f)).toHaveLength(1);
  expect(recovery(f)[0].response.issues).toContainEqual({ path: 'datasetId', rule: 'dataset.intent.required', allowedValues: ['asset-composition'] });
  const branch = f.provider.mock.calls[0][2].find(tool => tool.function.name === 'query_data').function.parameters.anyOf
    .find(branch => branch.properties.datasetId.enum[0] === 'asset-composition');
  expect(branch.description).toMatch(/全量.*账户类型.*币种.*聚合/);
  noBusinessWrites(f);
});
test('a keyword-free composition followup preserves grain and scope instead of reading balance detail', async () => {
  const f = replay(current => calls('query_data', { datasetId: current === composition ? 'asset-composition' : 'account-balances', limit: current === composition ? 10 : 1 }),
    { correction: { datasetId: 'asset-composition', limit: 1 } });
  const first = await f.send(composition), at = f.provider.mock.calls.length, next = await f.send(followup);
  const input = taskInput(f.provider.mock.calls[at][1]);
  expect(input.taskContext).toMatchObject({ subject: 'asset', metric: 'asset-composition' });
  expect(next.datasets[0].queryMeta.effectiveScope).toEqual(first.datasets[0].queryMeta.effectiveScope);
  expect(next.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 4, returnedRowCount: 1, sourceRecordCount: 81, rowsComplete: false });
  expect(readIds(f)).toEqual(['asset-composition', 'asset-composition']);
  expect(f.state.tasks.tasks.find(task => task.subject === 'asset').metric).toBe('asset-composition');
  noBusinessWrites(f);
});
test('explicit balance detail and composition retain their legitimate two reads', async () => {
  const f = replay(() => batch(calls('query_data', { datasetId: 'account-balances', limit: 10 }), calls('query_data', { datasetId: 'asset-composition', limit: 10 })));
  const result = await f.send('查看当前账户余额明细和按账户类型及币种的资产组成。');
  expect(readIds(f)).toEqual(['account-balances', 'asset-composition']);
  expect(result.datasets.map(dataset => dataset.datasetId).sort()).toEqual(['account-balances', 'asset-composition']);
  expect(recovery(f)).toHaveLength(0); noBusinessWrites(f);
});
test('a composition correction in a multi-subject query preserves the other subject and its scope', async () => {
  const f = replay(() => batch(calls('query_data', { datasetId: 'work-salary', startDate: '2026-06-01', endDate: '2026-06-30' }),
    calls('query_data', { datasetId: 'account-balances', limit: 10 })), { correction: { datasetId: 'asset-composition', limit: 10 } });
  const result = await f.send('分别查询：6月份已登记工资流水；当前已保存账户余额按账户类型及币种的资产组成。');
  expect(readIds(f)).toEqual(['work-salary', 'asset-composition']);
  expect(f.repository.query.mock.calls[0][1].scope).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
  expect(result.datasets.find(dataset => dataset.datasetId === 'asset-composition').queryMeta.effectiveScope)
    .toEqual({ startDate: '2026-11-01', endDate: '2026-11-08' });
  expect(taskInput(f.provider.mock.calls[0][1]).currentTasks).toEqual(expect.arrayContaining([
    expect.objectContaining({ subject: 'work' }), expect.objectContaining({ subject: 'asset', metric: 'asset-composition' })]));
  noBusinessWrites(f);
});
test('quoted composition words are literal account filter data, not a forced aggregation task', async () => {
  const filter = '账户类型及币种的资产组成', f = replay({ datasetId: 'account-balances', filter, limit: 10 });
  const result = await f.send('查询当前账户余额明细，名称字面包含“账户类型及币种的资产组成”的记录。');
  expect(readIds(f)).toEqual(['account-balances']); expect(recovery(f)).toHaveLength(0);
  expect(result.datasets[0].queryMeta.filters.text).toBe(filter); noBusinessWrites(f);
});
test.each(['改为查询当前全部资产。', '改为查询当前基金资产组成。'])('a new broad/fund topic does not force account composition: %s', async message => {
  const f = replay(current => calls('query_data', { datasetId: current === composition ? 'asset-composition' : 'account-balances', limit: 10 }));
  await f.send(composition); const at = f.provider.mock.calls.length; await f.send(message);
  expect(readIds(f)).toEqual(['asset-composition', 'account-balances']);
  const active = taskInput(f.provider.mock.calls[at][1]).taskContext;
  expect(active.mode !== 'query' || active.metric !== 'asset-composition').toBe(true);
  expect(recovery(f)).toHaveLength(0); noBusinessWrites(f);
});
test('bad original model calendars keep their existing calendar error before grain recovery', async () => {
  const f = replay({ datasetId: 'account-balances', startDate: '2026-02-30', endDate: '2026-03-01' }, { answer: '工具日期无效，请确认日期。' });
  await f.send(composition);
  expect(readIds(f)).toEqual([]);
  expect(recovery(f)[0]).toMatchObject({ errorCode: 'AI_SCOPE_INVALID' });
  expect(recovery(f)[0].response.issues.some(issue => issue.rule === 'dataset.assetComposition.required')).toBe(false);
  noBusinessWrites(f);
});
test('closed asset permission stays a hard error instead of a recoverable grain hint', async () => {
  const f = replay({ datasetId: 'account-balances', limit: 10 }, { correction: { datasetId: 'asset-composition', limit: 10 } });
  f.state.businessPolicy.domains = ['account'];
  await expect(f.send(composition)).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  expect(readIds(f)).toEqual([]); expect(recovery(f)).toHaveLength(0); expect(f.provider).toHaveBeenCalledTimes(1); noBusinessWrites(f);
});
test('repeating the rejected detail packet cannot add SQL or a second recovery', async () => {
  const f = replay({ datasetId: 'account-balances', limit: 10 }, { repeat: true });
  await expect(f.send(composition)).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
  expect(readIds(f)).toEqual([]); expect(recovery(f)).toHaveLength(1); expect(f.provider).toHaveBeenCalledTimes(2); noBusinessWrites(f);
});
