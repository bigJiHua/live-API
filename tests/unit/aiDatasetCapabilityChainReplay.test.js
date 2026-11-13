// Exercise the actual reader, preview, egress, V3 answer and next-turn context.
// SQL results and supplier messages are fixed independent business fixtures.
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Public database forbidden in capability replay'); }),
  getConnection: jest.fn(() => { throw new Error('Public database forbidden in capability replay'); }),
}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Paid supplier forbidden in offline capability replay'); }),
}));
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { createBusinessReadRepository } = require('../../src/modules/ai/service/businessRead');
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const taskInput = messages => JSON.parse(messages.find(message => message.role === 'user'
  && message.content.startsWith('TASK_INPUT:\n')).content.slice('TASK_INPUT:\n'.length));
const transaction = (date, amountCNY) => ({ id: `private-flow-${date}`, cardId: 'private-card', categoryId: 'private-category',
  date, direction: 0, amount: amountCNY, currency: 'CNY', amountCNY, category: '购汇', remark: '月初换汇' });
const baseTotals = { income: '3911.24', expense: '5784.61', count: 268, incomeCount: 100, expenseCount: 168, unpricedCount: 0 };
const noMemory = () => ({ list: jest.fn(async () => ({ files: [], count: 0, warnings: [] })),
  read: jest.fn(() => { throw new Error('Unexpected memory read'); }),
  write: jest.fn(() => { throw new Error('Unexpected memory write'); }) });

function chain({ empty = false, unpriced = false } = {}) {
  const respond = (_, messages, __, options) => {
    const input = taskInput(messages);
    if (!options.json && !messages.some(message => message.role === 'tool')) {
      const metric = input.activeQuery?.metric;
      return calls('query_data', metric === 'daily-max'
        ? { datasetId: 'finance-daily', direction: 'expense', sort: 'expenseDesc', limit: 1 }
        : metric === 'transaction-max'
          ? { datasetId: 'finance-transactions', direction: 'expense', sort: 'amountDesc', limit: 1 }
          : { datasetId: 'finance-monthly' });
    }
    return final({ answer: '未返回的更早记录中可能存在更大的支出。' });
  };
  const f = fixture(Array.from({ length: 40 }, () => respond), { memoryStore: noMemory() });
  const sqlCalls = [];
  const conn = { query: jest.fn(async () => {}), beginTransaction: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}), release: jest.fn(), execute: jest.fn(async ({ sql }, params) => {
      sqlCalls.push({ sql, params });
      if (sql.includes('AS incomeCount')) return [[empty
        ? { income: '0', expense: '0', count: 0, incomeCount: 0, expenseCount: 0, unpricedCount: 0 }
        : { ...baseTotals, ...(unpriced ? { unpricedCount: 1 } : {}) }]];
      if (sql.includes('AS matchedRowCount')) return [[{ matchedRowCount: empty ? 0 : sql.includes('LEFT(a.trans_date, 10)') ? 30 : 1 }]];
      if (empty) return [[]];
      if (sql.includes('a.card_id AS cardId')) return [[transaction('2026-06-01', '4000.00'), transaction('2026-06-30', '200.00')]];
      if (sql.includes('AS date')) return [[{ date: '2026-06-03', income: '0', expense: '4300.00', count: 2, unpricedCount: 0 },
        { date: '2026-06-30', income: '0', expense: '200.00', count: 1, unpricedCount: 0 }]];
      return [[{ month: '2026-06', ...baseTotals }]];
    }) };
  const read = createBusinessReadRepository({ executor: conn, now });
  f.repository.queryDataset = jest.fn((...args) => read.queryDataset(...args));
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadQueryCoverage = jest.fn(async () => f.state.queryCoverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => {
    await append(...args);
    if (args[2].queryCoverage) f.state.queryCoverage = structuredClone(args[2].queryCoverage);
  });
  return { ...f, conn, sqlCalls };
}
afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});

test('June summary then maximum transaction and maximum day carry true scope/counts through the complete chain', async () => {
  const f = chain();
  const summary = await f.send('查6月收入和支出');
  expect(summary.datasets[0]).toMatchObject({ datasetId: 'finance-monthly', summary: baseTotals,
    queryMeta: { sort: 'monthAsc', sourceRecordCount: 268, matchedRowCount: 1, returnedRowCount: 1 } });
  const maxAt = f.provider.mock.calls.length;
  const maximum = await f.send('支出最大的一笔是？');
  const carried = taskInput(f.provider.mock.calls[maxAt][1]);
  expect(carried.activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30', metric: 'transaction-max' });
  expect(carried.previousQueryCoverage).toEqual(expect.arrayContaining([expect.objectContaining({
    effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, matchedRowCount: 1,
    returnedRowCount: 1, sourceRecordCount: 268, incomeCount: 100, expenseCount: 168 })]));
  expect(maximum.answer).toMatch(/最大的一笔发生在 2026-06-01.*4000\.00/);
  expect(maximum.answer).not.toMatch(/可能存在更大|无法确定|无法确认/);
  expect(maximum.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 268, returnedRowCount: 1,
    sourceRecordCount: 268, rowsComplete: false, summaryComplete: true, rankingComplete: true });
  const dayAt = f.provider.mock.calls.length;
  const day = await f.send('花的最多是哪一天？');
  expect(taskInput(f.provider.mock.calls[dayAt][1]).activeQuery)
    .toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30', metric: 'daily-max' });
  expect(day.answer).toMatch(/支出最多的一天是 2026-06-03.*4300\.00/);
  expect(day.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 30, returnedRowCount: 1,
    sourceRecordCount: 268, rowsComplete: false, summaryComplete: true, rankingComplete: true });
  expect(f.repository.queryDataset).toHaveBeenCalledTimes(3);
  expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.conn.beginTransaction).toHaveBeenCalledTimes(3);
  expect(f.conn.rollback).toHaveBeenCalledTimes(3);
  expect(f.conn.release).toHaveBeenCalledTimes(3);
  // Approved tool evidence remains audited even when a complete extremum is
  // rendered directly without another supplier disclosure.
  const payloads = f.audits.filter(entry => entry.phase === 'tool').map(entry => entry.response.result);
  expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({ datasets: [expect.objectContaining({
    datasetId: 'finance-transactions', queryMeta: expect.objectContaining({ sort: 'amountDesc', sourceRecordCount: 268,
      returnedRowCount: 1, rankingComplete: true }), rows: [expect.objectContaining({ date: '2026-06-01', amountCNY: '4000.00' })] })] })]));
  expect(JSON.stringify(payloads)).not.toMatch(/private-flow|private-card|private-category/);
  expect(maximum.request.providerCalls).toBe(1); expect(day.request.providerCalls).toBe(1);
  expect(f.audits.filter(entry => entry.phase === 'grounded-done')).toHaveLength(2);
  for (const call of f.sqlCalls) {
    expect(call.sql).toMatch(/^SELECT\b/);
    expect(call.params.slice(0, 3)).toEqual(['offline-memory-owner', '2026-06-01', '2026-06-30']);
  }
  expect(f.sqlCalls.some(call => /ORDER BY amountCNY IS NULL, amountCNY DESC/.test(call.sql))).toBe(true);
  expect(f.sqlCalls.some(call => /GROUP BY LEFT\(a.trans_date, 10\) ORDER BY expense DESC/.test(call.sql))).toBe(true);
});
test('an actual zero-row read remains zero through approved preview and final answer', async () => {
  const f = chain({ empty: true });
  const result = await f.send('6月份支出最大的一笔是？');
  expect(result.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 0, returnedRowCount: 0,
    sourceRecordCount: 0, rowsComplete: true });
  expect(result.answer).toContain('没有可比较的已定价支出');
  expect(result.answer).not.toContain('4000');
});
test('an unpriced record blocks a full-range maximum claim even though a priced winner is returned', async () => {
  const f = chain({ unpriced: true });
  const result = await f.send('6月份支出最大的一笔是？');
  expect(result.datasets[0].queryMeta).toMatchObject({ rankingComplete: false, rowsComplete: false, sourceRecordCount: 268 });
  expect(result.answer).toMatch(/已定价记录中，支出最大的一笔发生在 2026-06-01/);
  expect(result.datasets[0].policy).toContain('不能确认完整范围的最大值');
});
test('actual card reader aggregation survives preview and answers card totals before month-level followup', async () => {
  const respond = (_, messages, __, options) => {
    const input = taskInput(messages);
    if (!options.json && !messages.some(message => message.role === 'tool')) return calls('query_data', {
      datasetId: 'card-monthlyConsumption', cardTypes: ['debit'], direction: 'expense',
      groupBy: /每月|走势|趋势/.test(input.userTurns[input.currentTurn]) ? 'cardMonth' : 'card', sort: 'amountDesc', limit: 1,
    });
    return final({ answer: '' });
  };
  const f = fixture(Array.from({ length: 25 }, () => respond), { memoryStore: noMemory() });
  const periods = [
    { cardId: 'private-debit-a', name: '生活卡 A', cardType: 'debit', currency: 'CNY', amountCNY: '180.00', count: 3,
      unpricedCount: 0, sourceCurrencies: 'CNY' },
    { cardId: 'private-debit-b', name: '生活卡 B', cardType: 'debit', currency: 'CNY', amountCNY: '100.00', count: 1,
      unpricedCount: 0, sourceCurrencies: 'CNY' },
  ];
  const months = [{ ...periods[1], month: '2026-09' }, ...['2026-11', '2026-10', '2026-09']
    .map(month => ({ ...periods[0], amountCNY: '60.00', count: 1, month }))];
  const conn = { query: jest.fn(async () => {}), beginTransaction: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}), release: jest.fn(), execute: jest.fn(async ({ sql }) => {
      if (sql.includes('AS matchedRowCount')) return [[{ expense: '280.00', count: 4, unpricedCount: 0,
        matchedRowCount: sql.includes('COUNT(DISTINCT a.card_id, LEFT') ? 4 : 2 }]];
      if (sql.includes('GROUP_CONCAT')) return [sql.includes('GROUP BY a.card_id, LEFT') ? months : periods];
      return [[]];
    }) };
  const read = createBusinessReadRepository({ executor: conn, now });
  f.repository.query.mockImplementation((...args) => read.query(...args));
  const ranked = await f.send('最近三个月哪张借记卡支出最高？');
  expect(ranked.datasets[0].queryMeta).toMatchObject({ groupBy: 'card', matchedRowCount: 2,
    returnedRowCount: 1, sourceRecordCount: 4, rowsComplete: false, rankingComplete: true });
  expect(ranked.datasets[0].rows).toEqual([expect.objectContaining({ name: '生活卡 A', amountCNY: '180.00' })]);
  expect(ranked.answer).toMatch(/生活卡 A 的累计支出最高.*180\.00/);
  expect(ranked.answer).not.toMatch(/生活卡 B.*最高/);
  const monthly = await f.send('最近三个月借记卡每月消费趋势');
  expect(monthly.datasets[0].queryMeta).toMatchObject({ groupBy: 'cardMonth', matchedRowCount: 4,
    returnedRowCount: 1, sourceRecordCount: 4 });
  expect(monthly.datasets[0].rows[0]).toMatchObject({ name: '生活卡 B', amountCNY: '100.00', month: '2026-09' });
  expect(monthly.datasets[0].columns.map(column => column.key)).toContain('month');
  expect(f.repository.query).toHaveBeenCalledTimes(2);
  const disclosure = f.provider.mock.calls.flatMap(call => call[1].filter(message => message.role === 'tool'));
  expect(JSON.stringify(disclosure)).not.toMatch(/private-debit-a|private-debit-b/);
  expect(conn.execute.mock.calls.some(([{ sql }]) => sql.includes('GROUP BY a.card_id, c.alias'))).toBe(true);
  expect(conn.execute.mock.calls.some(([{ sql }]) => sql.includes('GROUP BY a.card_id, LEFT(a.trans_date, 7)'))).toBe(true);
});

test.each([
 ['6月份支出最多是哪一天？','finance-daily','expenseDesc','expense','支出'],
 ['6月份收入最大的一笔是？','finance-transactions','amountDesc','income','收入'],
 ['6月份收入最多是哪一天？','finance-daily','incomeDesc','income','收入'],
])('actual zero-row extrema retain their server-authored presentation: %s',async(message,id,sort,direction,label)=>{
 const f=chain({empty:true}),result=await f.send(message);
 expect(result.datasets[0]).toMatchObject({datasetId:id,queryMeta:{sort,filters:{direction},matchedRowCount:0,returnedRowCount:0,rowsComplete:true}});
 expect(result.answer).toContain('没有可比较的已定价'+label);expect(result.answer).not.toContain('4000');
 expect(result.answer).not.toMatch(/标识.*(?:无效|非法)/);
});
