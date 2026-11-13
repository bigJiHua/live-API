// Real V3 orchestration with in-memory history, scripted tools and receipts.
// These replays must never access the public DB or a paid provider.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const crypto = require('node:crypto');
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { fixture, final, calls, id, now } = require('../fixtures/aiV3MemoryFixture');
const { buildQueryContext, finalizeQueryContext } = require('../../src/modules/ai/service/queryContext');
const { buildTaskContext, finalizeTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildPendingTransactionContext } = require('../../src/modules/ai/service/pendingTransactions');

const today = '2026-11-08';
const oldChartMessage = '2026-09-01 至 2026-11-08，按卡片分别展示月度消费，给我图表';
const chartPreference = '你可以新增记忆么，如果可以，新增一个记忆就是：如果对话内我只让你生成图表，那么就无需回复过多，只需要输出对应的图表数据即可';
const taskInput = messages => JSON.parse(messages.find(message => message.role === 'user' && message.content.startsWith('TASK_INPUT:\n'))
  .content.slice('TASK_INPUT:\n'.length));
const inputAt = (f, index) => taskInput(f.provider.mock.calls[index][1]);
const toolResults = messages => messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
const dataQueries = f => f.repository.query.mock.calls.map(call => call[1]).filter(args => args.datasetId);
const toolNamesAt = (f, index) => f.provider.mock.calls[index][2].map(tool => tool.function.name);
const noBusinessTools = (f, index) => {
  expect(toolNamesAt(f, index)).not.toEqual(expect.arrayContaining(['query_data']));
  expect(toolNamesAt(f, index)).not.toEqual(expect.arrayContaining(['list_choices']));
};
const column = (key, type = 'text') => ({ key, label: key, type });

function memoryFixture() {
  const files = new Map();
  return { list: jest.fn(async () => ({ files: [...files.values()].map(({ content, changed, ...metadata }) => metadata), warnings: [] })),
    write: jest.fn(async (_, args) => {
      const saved = { path: args.path, title: args.title, type: args.type, content: args.content,
        revision: crypto.createHash('sha256').update(args.content).digest('hex'), bytes: Buffer.byteLength(args.content),
        created: now().toISOString(), updated: now().toISOString(), changed: true };
      files.set(args.path, saved); return saved;
    }), read: jest.fn(async (_, args) => files.get(args.path)), search: jest.fn(async () => ({ matches: [], truncated: false })) };
}

function writePreference(input, filename = 'chart-preference.md') {
  const source = input.userTurns[input.currentTurn];
  return calls('memory_write', { path: filename, operation: 'create', title: '图表答复偏好', type: 'preference', content: source,
    expectedRevision: null, evidence: { sourceTurn: input.currentTurn, quote: source }, reason: '用户明确要求保存完整答复偏好原话' });
}

function replay(responder) {
  const memoryStore = memoryFixture();
  const f = fixture(Array.from({ length: 50 }, () => responder), { memoryStore });
  f.memoryStore = memoryStore;
  f.state.businessPolicy.domains = ['finance', 'card', 'account', 'fixedAsset', 'todo'];
  f.state.businessPolicy.actions = ['transaction.create', 'todo.create', 'fixedAsset.metadata'];
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  const stateKeys = ['queryContext', 'taskContext', 'taskContexts', 'queryCoverage', 'contextSummary'];
  store.loadQueryContext = jest.fn(async () => f.state.queryContext || null);
  store.loadTaskContext = jest.fn(async () => f.state.taskContext || null);
  store.loadTaskContexts = jest.fn(async () => f.state.taskContexts || { version: 1, tasks: [] });
  store.loadQueryCoverage = jest.fn(async () => f.state.queryCoverage || { version: 1, results: [] });
  store.loadContextSummary = jest.fn(async () => f.state.contextSummary || null);
  store.append = jest.fn(async (...args) => {
    await append(...args);
    for (const key of stateKeys) if (Object.hasOwn(args[2], key)) {
      f.state[key] = structuredClone(args[2][key]); f.history.at(-1)[key] = structuredClone(args[2][key]);
    }
  });
  f.raw.choices.fixedAssets = [{ id: 'fixture-printer', name: '办公打印机', info: '办公打印机', tag: '家电' }];
  f.repository.query.mockImplementation(async (_, args) => {
    if (!args.datasetId) return { ...f.raw, scope: args.scope };
    const card = args.datasetId === 'card-monthlyConsumption', creditOnly = args.cardTypes?.length === 1 && args.cardTypes[0] === 'credit';
    const dataset = card ? { datasetId: args.datasetId, domain: 'card', title: '按卡消费月度统计（人民币）',
      columns: [column('month', 'date'), column('name'), column('type'), column('currency'), column('amountCNY', 'money'),
        column('count', 'number'), column('unpricedCount', 'number'), column('sourceCurrencies')],
      rows: [{ month: '2026-11', name: creditOnly ? '农业银行 6838' : '农业银行 7476', type: creditOnly ? '信用卡' : '借记卡',
        currency: 'CNY', amountCNY: '203.32', count: 5, unpricedCount: 0, sourceCurrencies: 'CNY',
        card_id: creditOnly ? 'fixture-ag-credit' : 'fixture-ag-debit' }],
      summary: { amountCNY: '203.32', count: 5, unpricedCount: 0, currency: 'CNY' } }
      : { datasetId: args.datasetId, domain: 'finance', title: '收支月度趋势',
        columns: [column('month', 'date'), column('income', 'money'), column('expense', 'money'), column('count', 'number')],
        rows: [{ month: '2026-11', income: '0.00', expense: '203.32', count: 5 }],
        summary: { income: '0.00', expense: '203.32', count: 5, incomeCount: 0, expenseCount: 5, unpricedCount: 0, currency: 'CNY' } };
    const queryMeta = { version: 1, queryId: args.queryId, datasetId: args.datasetId, requestedScope: args.requestedScope,
      effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate },
      filters: { direction: args.direction || 'both', text: args.filter || '', ...(args.cardTypes ? { cardTypes: args.cardTypes } : {}) },
      sort: args.sort || 'dateDesc', ...(args.groupBy ? { groupBy: args.groupBy } : {}), matchedRowCount: 1,
      returnedRowCount: 1, sourceRecordCount: 5, rowsComplete: true, summaryComplete: true, rankingComplete: false,
      returnedDateRange: { startDate: '2026-11-01', endDate: today }, asOf: now().toISOString() };
    return { scope: args.scope, asOf: now().toISOString(), choices: {}, datasets: [{ ...dataset, queryMeta,
      asOf: now().toISOString(), truncated: false, fullRangeQuery: { filter: args.filter || '', matchedRowCount: 1 },
      policy: '本人已保存记录，按当前完整匹配范围读取。' }] };
  });
  return f;
}

function seedTask(f, { message = oldChartMessage, status = 'succeeded', subject = 'cards' } = {}) {
  const turnId = id(), queryContext = finalizeQueryContext(buildQueryContext({ message, today }), { status, turnId,
    ...(status === 'failed' ? { errorCode: 'AI_REQUEST_CANCELLED' } : {}) });
  const taskContext = finalizeTaskContext(buildTaskContext({ message, today, queryContext }), { status, turnId,
    ...(status === 'failed' ? { errorCode: 'AI_REQUEST_CANCELLED' } : {}) });
  expect(taskContext.subject).toBe(subject);
  f.state.queryContext = queryContext; f.state.taskContext = taskContext;
  f.state.taskContexts = { version: 1, tasks: [taskContext] };
  f.state.queryCoverage = { version: 1, results: [] };
  f.history.push({ role: 'user', turnId, content: message, sourceDate: today },
    { role: 'assistant', turnId, content: status === 'failed' ? '本次服务中断。' : '图表已生成。', queryContext, taskContext,
      taskContexts: f.state.taskContexts, ...(status === 'failed' ? { failure: { code: 'AI_REQUEST_CANCELLED', status: 'failed' } } : {}) });
  return { turnId, taskContext, queryContext };
}

afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});

test.each(['succeeded', 'failed'])('a %s old chart cannot turn the conditional memory request into a new chart query', async status => {
  const f = replay((_, messages) => !toolResults(messages).length ? writePreference(taskInput(messages)) : final({ answer: '已保存你的图表答复偏好。' }));
  seedTask(f, { status });
  const result = await f.send(chartPreference), input = inputAt(f, 0);
  expect(input.userTurns[input.currentTurn]).toBe(chartPreference);
  expect(input.taskContext).toMatchObject({ mode: 'chat' });
  expect(input.taskContext.chartRequest).toBeNull();
  expect(result.answer).toContain('保存'); expect(result.answer).not.toMatch(/203\.32|按卡片分别展示|暂无消费记录/);
  expect(result.datasets).toEqual([]); expect(result.chart).toBeNull();
  expect(f.memoryStore.write).toHaveBeenCalledTimes(1);
  expect(f.memoryStore.write.mock.calls[0][1].content).toBe(chartPreference);
  expect(f.repository.query).not.toHaveBeenCalled();
  noBusinessTools(f, 0); noBusinessTools(f, 1);
  expect(toolNamesAt(f, 0)).toContain('memory_write');
});

test.each(['succeeded', 'failed'])('asking which tools produced a %s old chart answers the capability question without rerunning it', async status => {
  const answer = '刚才生成图表使用的是 query_data 读取账本数据，图表由返回的数据集生成。';
  const f = replay(() => final({ answer })); seedTask(f, { status });
  const message = '你这一次不是已经可以正确的生成图表了吗？用的什么能力工具告诉我你看到的';
  const result = await f.send(message);
  expect(inputAt(f, 0).taskContext).toMatchObject({ mode: 'chat', chartRequest: null });
  expect(result.answer).toBe(answer); expect(result.datasets).toEqual([]); expect(result.chart).toBeNull();
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.memoryStore.write).not.toHaveBeenCalled();
  noBusinessTools(f, 0);
});

test('asking which fixed asset fields are editable does not read the user asset snapshot', async () => {
  const answer = '固定资产可以修改品名和品类。购买价、账面价值及折旧字段不通过此修改入口直接调整。';
  const f = replay(() => final({ answer }));
  seedTask(f, { message: '我目前登记的固定资产有哪些', subject: 'fixedAsset' });
  const result = await f.send('你能修改固定资产的什么数据？');
  expect(inputAt(f, 0).taskContext).toMatchObject({ mode: 'chat', chartRequest: null });
  expect(result.answer).toBe(answer); expect(result.answer).not.toContain('办公打印机');
  expect(result.datasets).toEqual([]); expect(f.repository.query).not.toHaveBeenCalled();
  noBusinessTools(f, 0);
});

test.each(['succeeded', 'failed'])('a topic reset clears %s query and chart state before a new explicit query', async status => {
  const f = replay((_, messages, __, options) => {
    const input = taskInput(messages), message = input.userTurns[input.currentTurn];
    if (message.includes('开启新的话题')) return final({ answer: '好的，开启新话题。' });
    if (!options.json && !toolResults(messages).length) return calls('query_data', { datasetId: 'finance-monthly' });
    return final({ answer: '本轮收支已查询。' });
  });
  seedTask(f, { status });
  await f.send('忘记上面的内容，我们开启新的话题');
  expect(f.state.taskContexts.tasks).toEqual([]); expect(f.state.queryCoverage.results).toEqual([]);
  expect(f.state.queryContext).toBeNull();
  const at = f.provider.mock.calls.length, result = await f.send('查询2026年11月1日至8日收支月度汇总');
  expect(inputAt(f, at).taskContext).toMatchObject({ subject: 'finance', targetDatasetId: 'finance-monthly', chartRequest: null });
  expect(dataQueries(f)).toHaveLength(1);
  expect(dataQueries(f)[0].scope).toMatchObject({ startDate: '2026-11-01', endDate: today });
  expect(result.chart).toBeNull(); expect(result.datasets[0].datasetId).toBe('finance-monthly');
});

test('a topic reset and new explicit query in the same utterance use only the new dates and subject', async () => {
  const f = replay((_, messages, __, options) => !options.json && !toolResults(messages).length
    ? calls('query_data', { datasetId: 'finance-monthly' }) : final({ answer: '本轮收支已查询。' }));
  seedTask(f, { status: 'failed' });
  const message = '忘记上面的内容，我们开启新的话题；查询2026年11月1日至8日收支月度汇总。';
  const result = await f.send(message), input = inputAt(f, 0);
  expect(input.userTurns).toEqual([message]);
  expect(input.taskContexts.tasks).toEqual([]); expect(input.previousQueryCoverage).toEqual([]);
  expect(input.taskContext).toMatchObject({ subject: 'finance', targetDatasetId: 'finance-monthly', chartRequest: null,
    scope: { startDate: '2026-11-01', endDate: today } });
  expect(dataQueries(f)).toHaveLength(1);
  expect(dataQueries(f)[0].scope).toMatchObject({ startDate: '2026-11-01', endDate: today });
  expect(result.chart).toBeNull(); expect(result.datasets[0].datasetId).toBe('finance-monthly');
  expect(f.state.taskContexts.tasks.map(task => task.subject)).toEqual(['finance']);
});

test('a legacy reset without SQL boundary metadata cannot resurrect older loader contexts', async () => {
  const f = replay((_, messages, __, options) => {
    const input = taskInput(messages), message = input.userTurns[input.currentTurn];
    if (message === '你好') return final({ answer: '你好。' });
    if (!options.json && !toolResults(messages).length) return calls('query_data', { datasetId: 'finance-monthly' });
    return final({ answer: '已查询新的收支问题。' });
  });
  seedTask(f, { status: 'failed' });
  const resetId = id();
  f.history.push({ role: 'user', content: '忘记上面的内容，我们开启新的话题', turnId: resetId, sourceDate: today },
    { role: 'assistant', content: '好的，开启新话题。', turnId: resetId });
  // Simulate a pre-migration conversation whose separate loaders still find
  // the old task, coverage and summary before the plain-text reset message.
  const store = f.state.conversationStore;
  const stale = { query: structuredClone(f.state.queryContext), task: structuredClone(f.state.taskContext),
    tasks: structuredClone(f.state.taskContexts), coverage: structuredClone(f.state.queryCoverage) };
  store.loadQueryContext.mockImplementation(async () => stale.query);
  store.loadTaskContext.mockImplementation(async () => stale.task);
  store.loadTaskContexts.mockImplementation(async () => stale.tasks);
  store.loadQueryCoverage.mockImplementation(async () => stale.coverage);
  store.loadContextSummary.mockImplementation(async () => ({ version: 1, items: [{ text: oldChartMessage }] }));
  const greeting = await f.send('你好'), greetingInput = inputAt(f, 0);
  expect(greetingInput.userTurns).not.toContain(oldChartMessage);
  expect(greetingInput.taskContext).toMatchObject({ mode: 'chat', chartRequest: null });
  expect(greetingInput.taskContexts.tasks).toEqual([]);
  expect(greetingInput.previousQueryCoverage).toEqual([]); expect(greetingInput.activeQuery).toBeNull();
  expect(greetingInput.contextSummary?.items || []).toEqual([]);
  for (const loader of ['loadQueryContext', 'loadTaskContext', 'loadTaskContexts', 'loadQueryCoverage', 'loadContextSummary', 'loadPendingTransactionContext'])
    expect(store[loader]).not.toHaveBeenCalled();
  expect(greeting.answer).toBe('你好。'); expect(greeting.chart).toBeNull(); expect(greeting.datasets).toEqual([]);
  const at = f.provider.mock.calls.length, result = await f.send('查询2026年11月1日至8日收支月度汇总');
  expect(inputAt(f, at).taskContext).toMatchObject({ subject: 'finance', targetDatasetId: 'finance-monthly', chartRequest: null });
  expect(dataQueries(f)).toHaveLength(1);
  expect(dataQueries(f)[0].scope).toMatchObject({ startDate: '2026-11-01', endDate: today });
  expect(result.chart).toBeNull(); expect(f.state.taskContexts.tasks.map(task => task.subject)).toEqual(['finance']);
});

test.each(['继续刚才图表', '信用卡呢'])('an explicit current continuation still reads fresh card data: %s', async message => {
  const f = replay((_, messages, __, options) => !options.json && !toolResults(messages).length
    ? calls('query_data', { datasetId: 'card-monthlyConsumption' }) : final({ answer: '已按本轮条件生成。' }));
  seedTask(f);
  const result = await f.send(message);
  expect(inputAt(f, 0).taskContext).toMatchObject({ mode: 'query', subject: 'cards', targetDatasetId: 'card-monthlyConsumption',
    chartRequest: { type: 'bar', metric: 'amount' }, scope: { startDate: '2026-09-01', endDate: today } });
  expect(dataQueries(f)).toHaveLength(1); expect(result.chart).toMatchObject({ datasetId: 'card-monthlyConsumption', type: 'bar' });
  if (message === '信用卡呢') expect(dataQueries(f)[0].cardTypes).toEqual(['credit']);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});

test.each(['finance-monthly', 'card-monthlyConsumption'].flatMap(datasetId => ['query-first', 'memory-first'].map(order => [datasetId, order])))
  ('a mixed memory and %s chart query retains both outcomes and keeps tools open: %s', async (datasetId, order) => {
  const business = datasetId === 'finance-monthly' ? '收支月度汇总' : '按卡片分别展示月度消费';
  const message = `请记住：以后只有我要求图表时才简洁回复图表数据；另外查询2026年11月1日至8日${business}，给我图表。`;
  const f = replay((_, messages, __, options) => {
    const results = toolResults(messages), input = taskInput(messages);
    const query = () => calls('query_data', { datasetId });
    if (!results.length) return order === 'query-first' ? query() : writePreference(input);
    if (results.length === 1 && !options.json) return order === 'query-first' ? writePreference(input) : query();
    return final({ answer: '已保存你的图表答复偏好，并已查询本次月度数据。' });
  });
  seedTask(f);
  const result = await f.send(message);
  expect(dataQueries(f)).toHaveLength(1); expect(f.memoryStore.write).toHaveBeenCalledTimes(1);
  expect(f.memoryStore.write.mock.calls[0][1].content).toBe(message);
  expect(f.provider.mock.calls[1][2].length).toBeGreaterThan(0);
  expect(f.provider.mock.calls[1][3]?.json).not.toBe(true);
  expect(result.answer).toMatch(/保存/); expect(result.answer).toMatch(/203\.32|月度数据/);
  expect(result.datasets).toHaveLength(1); expect(result.chart).toMatchObject({ datasetId });
});

test('a model final answer after completed data queries cannot skip the requested pending memory write', async () => {
  const message = '请保存记忆：以后只要我要求图表就简洁输出；另外查询2026年11月1日至8日按卡片分别展示月度消费，给我图表。';
  let prematureFinal = false;
  const f = replay((_, messages) => {
    const results = toolResults(messages);
    if (!results.length) return calls('query_data', { datasetId: 'card-monthlyConsumption' });
    if (results.length === 1 && !prematureFinal) { prematureFinal = true; return final({ answer: '本轮月度消费已经查询完成。' }); }
    if (results.length === 1) return writePreference(taskInput(messages));
    return final({ answer: '已保存你的图表答复偏好，本轮月度消费已经查询完成。' });
  });
  seedTask(f);
  const result = await f.send(message);
  expect(prematureFinal).toBe(true); expect(dataQueries(f)).toHaveLength(1);
  expect(f.memoryStore.write).toHaveBeenCalledTimes(1);
  expect(f.provider.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(f.provider.mock.calls.length).toBeLessThanOrEqual(5);
  for (const index of [1, 2]) { expect(toolNamesAt(f, index)).toContain('memory_write'); expect(f.provider.mock.calls[index][3]?.json).not.toBe(true); }
  expect(f.provider.mock.calls[2][1].some(item => item.role === 'system' && /记忆.*尚未处理/.test(item.content))).toBe(true);
  expect(result.answer).toContain('保存'); expect(result.chart).toMatchObject({ datasetId: 'card-monthlyConsumption' });
  expect(result.datasets).toHaveLength(1);
});

test('a pure memory turn rejects a model business read even after its tools were removed from the prompt', async () => {
  const f = replay(() => calls('query_data', { datasetId: 'card-monthlyConsumption' }));
  seedTask(f);
  await expect(f.send(chartPreference)).rejects.toMatchObject({ code: 'AI_TOOL_DENIED' });
  noBusinessTools(f, 0);
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.memoryStore.write).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

test.each(['succeeded', 'failed'])('after a %s old 20-yuan purchase and topic reset, a new purchase owns only its current amount', async status => {
  const oldMessage = '今天买菜花了20.00元', current = '今天公交花了5.00元，用农业银行借记卡支付';
  const f = replay((_, messages) => {
    const input = taskInput(messages), message = input.userTurns[input.currentTurn];
    if (message.includes('开启新的话题')) return final({ answer: '好的，开启新话题。' });
    if (!toolResults(messages).length) return calls('list_choices', { domain: 'finance' });
    const tool = toolResults(messages).at(-1);
    return final({ answer: '请核对本次公交草稿。', proposal: { kind: 'transaction.create', fields: { direction: 0,
      amount: '5.00', currency: 'CNY', transDate: today, payMethod: '银行卡', remark: '公交',
      accountRef: tool.choices.cards.find(card => card.name === '农业银行 7476').ref,
      categoryRef: tool.choices.categories[0].ref }, evidence: { sourceTurn: input.currentTurn, quote: '5.00' } } });
  });
  const prior = seedTask(f, { message: oldMessage, status, subject: 'finance' });
  if (status === 'failed') f.state.pendingContext = buildPendingTransactionContext({ conversationId: f.conversationId,
    turnId: prior.turnId, now, userTurns: [oldMessage], userTurnDates: [today], userTurnIds: [prior.turnId], transactions: [{
      fields: { direction: 0, amount: '20.00', currency: 'CNY', transDate: today, remark: '买菜' },
      evidence: { sourceTurn: 0, quote: '20.00' }, missingFields: ['账户', '支付方式'] }] });
  await f.send('忘记上面的内容，我们开启新的话题');
  const at = f.provider.mock.calls.length, result = await f.send(current), input = inputAt(f, at);
  expect(input.taskContext).toMatchObject({ mode: 'record', subject: 'finance', chartRequest: null });
  expect(input.pendingTransactions?.items || []).toEqual([]);
  expect(result.draft).toMatchObject({ amount: '5.00', remark: '公交', accountId: 'fixture-ag-debit' });
  expect(f.legacy.prepareTransactionProposal).toHaveBeenCalledTimes(1);
  expect(f.legacy.prepareTransactionProposal.mock.calls[0][2].message).toBe(current);
  expect(f.legacy.prepareTransactionProposal.mock.calls[0][1].amount).toBe('5.00');
});
