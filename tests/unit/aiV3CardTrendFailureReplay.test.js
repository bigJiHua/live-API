// Real failures recorded on 2026-11-09: credit correction lost its inherited
// range, then a monthly chart escalated amountDesc to unsupported monthAsc.
// These messages replay against the real V3/preview pipeline offline.
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live DB forbidden in recorded trend replay'); }),
  getConnection: jest.fn(() => { throw new Error('Live DB forbidden in recorded trend replay'); }),
}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden in recorded trend replay'); }),
}));
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const readInput = messages => JSON.parse(messages.find(message => message.role === 'user'
  && message.content.startsWith('TASK_INPUT:\n')).content.slice('TASK_INPUT:\n'.length));
const cardColumns = [
  { key: 'name', label: '卡片', type: 'text' }, { key: 'type', label: '类型', type: 'text' },
  { key: 'currency', label: '统计币种', type: 'text' }, { key: 'amountCNY', label: '消费金额', type: 'money' },
  { key: 'count', label: '消费笔数', type: 'number' }, { key: 'unpricedCount', label: '未定价笔数', type: 'number' },
];
function replay({ overrideTrend } = {}) {
  const respond = (_, messages, __, options) => {
    const input = readInput(messages), text = input.userTurns[input.currentTurn];
    const toolMessages = messages.filter(message => message.role === 'tool');
    const monthly = /每月|趋势|走势|按月份/.test(text);
    if (!options.json && !toolMessages.length) return calls('query_data', {
      datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: '2026-11-08',
      cardTypes: text.includes('信用卡') ? ['credit'] : ['debit'], direction: 'expense',
      groupBy: monthly ? 'cardMonth' : 'card', sort: 'amountDesc', limit: 1,
      ...(monthly ? overrideTrend : {}),
    });
    if (!options.json && monthly && JSON.parse(toolMessages.at(-1)?.content || '{}').status === 'error') return calls('query_data', {
      datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: '2026-11-08',
      cardTypes: ['debit'], groupBy: 'cardMonth',
      sort: overrideTrend?.direction || overrideTrend?.groupBy ? 'monthAsc' : 'dateDesc', filter: '', limit: overrideTrend?.limit || 1,
    });
    if (!options.json && monthly && toolMessages.length === 1) return calls('query_data', {
      datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: '2026-11-08',
      cardTypes: ['debit'], groupBy: 'cardMonth', sort: 'monthAsc', limit: 1,
    });
    if (monthly) {
      const dataset = JSON.parse(toolMessages.at(-1).content).datasets[0];
      return final({ answer: '按月数据已返回。', chart: { datasetId: dataset.datasetId,
        queryId: dataset.queryMeta.queryId, type: 'line', xKey: 'month', yKeys: ['amountCNY'], title: '信用卡每月消费趋势' } });
    }
    return final({ answer: '' });
  };
  const f = fixture(Array.from({ length: 35 }, () => respond), { memoryStore: {
    list: jest.fn(async () => ({ files: [], count: 0, warnings: [] })),
    write: jest.fn(() => { throw new Error('Unexpected memory write'); }),
  } });
  f.repository.query.mockImplementation(async (_, args) => {
    const credit = args.cardTypes?.includes('credit'), cardMonth = args.groupBy === 'cardMonth';
    const rows = cardMonth ? [
      { month: '2026-11', name: '信用卡 C', type: '信用卡', currency: 'CNY', amountCNY: '120.00', count: 2, unpricedCount: 0 },
      { month: '2026-10', name: '信用卡 C', type: '信用卡', currency: 'CNY', amountCNY: '200.00', count: 3, unpricedCount: 0 },
      { month: '2026-09', name: '信用卡 C', type: '信用卡', currency: 'CNY', amountCNY: '100.00', count: 2, unpricedCount: 0 },
      { month: '2026-09', name: '信用卡 D', type: '信用卡', currency: 'CNY', amountCNY: '100.00', count: 2, unpricedCount: 0 },
    ] : [{ name: credit ? '信用卡 C' : '借记卡 A', type: credit ? '信用卡' : '借记卡',
      currency: 'CNY', amountCNY: credit ? '420.00' : '180.00', count: credit ? 7 : 3, unpricedCount: 0 },
      { name: credit ? '信用卡 D' : '借记卡 B', type: credit ? '信用卡' : '借记卡',
        currency: 'CNY', amountCNY: '100.00', count: credit ? 2 : 1, unpricedCount: 0 }];
    const summary = { expense: credit ? '520.00' : '280.00', count: credit ? 9 : 4,
      expenseCount: credit ? 9 : 4, incomeCount: 0, unpricedCount: 0, currency: 'CNY', incomplete: false };
    return { scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [{
      datasetId: 'card-monthlyConsumption', domain: 'card', title: '卡片消费',
      columns: [...(cardMonth ? [{ key: 'month', label: '月份', type: 'date' }] : []), ...cardColumns],
      rows, summary, policy: '只读卡片消费。', truncated: false, asOf: now().toISOString(),
      cardMonthlyQuery: { summary, matchedRowCount: rows.length, sort: args.sort || 'dateDesc',
        groupBy: args.groupBy, cardTypes: args.cardTypes, direction: 'expense', filter: '' },
    }] };
  });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] });
  store.append = jest.fn(async (...args) => {
    await append(...args);
    f.state.coverage = structuredClone(args[2].queryCoverage);
    f.state.tasks = structuredClone(args[2].taskContexts);
  });
  return f;
}
afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});

test.each([undefined, { cardTypes: ['debit'], sort: 'monthAsc' }, { cardTypes: ['debit'], filter: '借记', sort: 'monthAsc' }])(
  'debit ranking → credit correction → monthly trend preserves scope, types and fresh quantities for %j', async overrideTrend => {
  const f = replay({ overrideTrend });
  const debit = await f.send('最近三个月哪张借记卡支出最高？');
  const credit = await f.send('那信用卡呢？');
  expect(debit.answer).toMatch(/借记卡 A.*180\.00/);
  expect(credit.answer).toMatch(/信用卡 C.*420\.00/);
  expect(credit.datasets[0].queryMeta).toMatchObject({ effectiveScope: { startDate: '2026-09-01', endDate: '2026-11-08' },
    filters: { direction: 'expense', cardTypes: ['credit'] }, matchedRowCount: 2, returnedRowCount: 1, sourceRecordCount: 9 });
  const savedCredit = f.state.coverage.results.find(item => item.queryId === credit.datasets[0].queryMeta.queryId);
  expect(savedCredit).toMatchObject({ sourceRecordCount: 9, matchedRowCount: 2, returnedRowCount: 1,
    filters: { cardTypes: ['credit'] }, asOf: credit.datasets[0].asOf });
  const trendAt = f.provider.mock.calls.length;
  const trend = await f.send('按月份给我看走势。');
  const input = readInput(f.provider.mock.calls[trendAt][1]);
  expect(input.taskContext).toMatchObject({ subject: 'cards', cardTypes: ['credit'], metric: 'card-consumption',
    scope: { startDate: '2026-09-01', endDate: '2026-11-08' } });
  expect(input.previousQueryCoverage).toEqual(expect.arrayContaining([expect.objectContaining({
    queryId: credit.datasets[0].queryMeta.queryId, sourceRecordCount: 9, filters: { direction: 'expense', text: '', cardTypes: ['credit'] } })]));
  expect(trend.datasets[0].queryMeta).toMatchObject({ groupBy: 'cardMonth', sort: 'dateDesc',
    filters: { direction: 'expense', cardTypes: ['credit'] } });
  expect(trend.chart).toMatchObject({ datasetId: 'card-monthlyConsumption', type: 'line', xKey: 'month', yKeys: ['amountCNY'] });
  expect(f.repository.query).toHaveBeenCalledTimes(3);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  // Unsupported original monthAsc never reaches SQL. One explicit
  // correction uses dateDesc; stale card types still follow the user's credit scope.
  const trendCalls = f.provider.mock.calls.slice(trendAt);
  expect(trendCalls).toHaveLength(4);
  expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
  expect(trendCalls.at(-1)[2]).toEqual([]);
  const finalPayload = JSON.parse(trendCalls.at(-1)[1].findLast(item => item.role === 'tool').content);
  expect(finalPayload.datasets[0].queryMeta.filters.cardTypes).toEqual(['credit']);
  expect(finalPayload.effectiveArgs).toMatchObject({ datasetId: 'card-monthlyConsumption',
    startDate: '2026-09-01', endDate: '2026-11-08', cardTypes: ['credit'], direction: 'expense',
    groupBy: 'cardMonth', sort: 'dateDesc', limit: overrideTrend?.limit || 1 });
  if (overrideTrend?.filter) expect(finalPayload.effectiveArgs.filter).toBe('');
  expect(finalPayload.argumentAdjustments).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'sort', requested: 'monthAsc' }),
  ]));
  expect(finalPayload.argumentAdjustments).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'cardTypes', reason: 'normalized', requested: ['debit'], effective: ['credit'] }),
  ]));
});
test.each([{ direction: 'income' }, { groupBy: 'unsupported-group' }])(
  'the monthly override still rejects an income or unknown grouping request: %j', async overrideTrend => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const f = replay({ overrideTrend });
      await f.send('最近三个月哪张借记卡支出最高？');
      await f.send('那信用卡呢？');
      const result = await f.send('按每月给消费趋势图。').catch(error => error);
      expect(result).toMatchObject({ status: 400, code: 'AI_TOOL_ARGUMENT_INVALID' });
      // The first rejection retains the original code. C1 grants one correction;
      // the scripted second monthAsc request is still unsupported and terminal.
      expect(f.audits.findLast(entry => entry.phase === 'tool-recovery')).toMatchObject({
        errorCode: overrideTrend.direction ? 'AI_TOOL_ARGUMENT_INVALID' : 'AI_INVALID_INPUT' });
      expect(f.repository.query).toHaveBeenCalledTimes(2);
      expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
    } finally { quiet.mockRestore(); }
  });
test('a complete scoped monthly chart finishes from approved facts after one model selection without a second disclosure', async () => {
  const f = replay({ overrideTrend: { cardTypes: ['debit'], sort: 'dateDesc', limit: 20 } });
  await f.send('最近三个月哪张借记卡支出最高？'); await f.send('那信用卡呢？');
  const before = f.provider.mock.calls.length;
  const trend = await f.send('按月份给我看走势。');
  expect(f.provider.mock.calls.slice(before)).toHaveLength(1);
  expect(trend.request.providerCalls).toBe(1);
  expect(trend.chart).toMatchObject({ datasetId: 'card-monthlyConsumption', type: 'line', xKey: 'month', yKeys: ['amountCNY'] });
  expect(trend.datasets[0].queryMeta).toMatchObject({ rowsComplete: true, summaryComplete: true,
    filters: { cardTypes: ['credit'] }, effectiveScope: { startDate: '2026-09-01', endDate: '2026-11-08' } });
  expect(trend.answer).toContain('信用卡 C：2026-09 已定价支出 CNY 100.00');
  expect(trend.draft).toBeUndefined(); expect(trend.proposal).toBeUndefined();
  expect(f.repository.query).toHaveBeenCalledTimes(3);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
});
