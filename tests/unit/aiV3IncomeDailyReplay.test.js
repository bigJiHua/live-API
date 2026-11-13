jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden'); }) }));
const { fixture, calls, final, now } = require('../fixtures/aiV3MemoryFixture');
const { queryDataDefinition } = require('../../src/modules/ai/service/modelToolDefinitions');
const { validateTool } = require('../../src/modules/ai/service/v3Tools');
const scope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const input = messages => JSON.parse(messages.find(item => item.content?.startsWith('TASK_INPUT:\n')).content.slice(12));

function setup({ unpricedCount = 0 } = {}) {
  const f = fixture([
    calls('query_data', { datasetId: 'finance-daily', ...scope, direction: 'income', sort: 'dateDesc', limit: 1 }),
    final({ answer: '已返回日期窗口不足以确认收入最高的一天。' }),
    final({ answer: '已返回日期窗口不足以确认收入最高的一天。' }),
  ]);
  f.repository.query.mockImplementation(async (_, args) => {
    const ranked = args.sort === 'incomeDesc';
    const row = ranked ? { date: '2026-06-03', income: '9000.00', expense: '0.00', count: 4, unpricedCount: 0 }
      : { date: '2026-06-30', income: '20.00', expense: '0.00', count: 1, unpricedCount: 0 };
    return { scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [{
      datasetId: 'finance-daily', domain: 'finance', title: '收支每日汇总', rows: [row],
      columns: [{ key: 'date', label: '日期', type: 'date' }, { key: 'income', label: '收入', type: 'money' },
        { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' },
        { key: 'unpricedCount', label: '未定价笔数', type: 'number' }],
      summary: { currency: 'CNY', income: '9020.00', expense: '0.00', count: 115,
        incomeCount: 115, expenseCount: 0, unpricedCount }, policy: '独立固定源：收入冠军在月初，月末有较小收入。',
      asOf: now().toISOString(), truncated: true,
      queryMeta: { version: 1, queryId: args.queryId, datasetId: 'finance-daily', requestedScope: scope, effectiveScope: scope,
        filters: { direction: 'income', text: '' }, sort: args.sort, matchedRowCount: 30, returnedRowCount: 1, sourceRecordCount: 115,
        rowsComplete: false, summaryComplete: true, rankingComplete: ranked && unpricedCount === 0,
        returnedDateRange: { startDate: row.date, endDate: row.date }, asOf: now().toISOString() },
    }] };
  });
  return f;
}

test('income-day query selects income ordering and answers from full-range evidence even at limit one', async () => {
  const f = setup();
  const result = await f.send('2026年6月收入最多的是哪一天？');
  expect(f.repository.query.mock.calls[0][1]).toMatchObject({ datasetId: 'finance-daily', sort: 'incomeDesc', direction: 'income' });
  expect(result.answer).toMatch(/收入最多.*2026-06-03.*收入 CNY 9000\.00/);
  expect(result.answer).not.toMatch(/支出最多的一天是|一天是 2026-06-30|收入 CNY 20\.00/);
  expect(result.datasets[0].queryMeta).toMatchObject({ sort: 'incomeDesc', rowsComplete: false, rankingComplete: true });
  expect(result.request.providerCalls).toBe(1);
  expect(input(f.provider.mock.calls[0][1]).activeQuery.direction).toBe(1);
  expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});

test('income ordering is published only for daily aggregates and passes its exact tool contract', () => {
  const branches = queryDataDefinition().function.parameters.anyOf;
  expect(branches.find(branch => branch.properties.datasetId.enum[0] === 'finance-daily').properties.sort.enum)
    .toContain('incomeDesc');
  expect(branches.find(branch => branch.properties.datasetId.enum[0] === 'finance-transactions').properties.sort.enum)
    .not.toContain('incomeDesc');
  expect(validateTool('query_data', { datasetId: 'finance-daily', sort: 'incomeDesc', direction: 'income', ...scope }, '2026-11-08').sort)
    .toBe('incomeDesc');
});

test('unpriced income cannot finalize as the full-range income champion', async () => {
  const f = setup({ unpricedCount: 1 });
  const result = await f.send('2026年6月收入最多的是哪一天？');
  expect(result.request.providerCalls).toBe(3);
  expect(result.datasets[0].queryMeta.rankingComplete).toBe(false);
  expect(result.answer).toMatch(/已定价记录中，收入最多的一天是/);
  expect(result.answer).not.toMatch(/至 2026-06-30，收入最多的一天是/);
});
