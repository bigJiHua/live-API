jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden'); }) }));
const { fixture, calls, final, now } = require('../fixtures/aiV3MemoryFixture');
const scope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const input = messages => JSON.parse(messages.find(item => item.content?.startsWith('TASK_INPUT:\n')).content.slice(12));
function setup({ rankingComplete = true } = {}) {
  const select = (_, messages, __, options) => {
    if (options.json) return final({ answer: '' });
    const task = input(messages).taskContext;
    if (messages.some(item => item.role === 'tool')) return final({ answer: '' });
    return calls('query_data', { datasetId: task.metric === 'transaction-max' ? 'finance-transactions' : 'finance-monthly',
      ...scope, direction: task.metric === 'transaction-max' ? 'expense' : 'both', sort: task.metric === 'transaction-max' ? 'amountDesc' : 'dateDesc' });
  };
  const f = fixture(Array.from({ length: 12 }, () => select));
  f.repository.query.mockImplementation(async (_, args) => {
    const detail = args.datasetId === 'finance-transactions';
    const summary = { currency: 'CNY', income: detail ? '0.00' : '3911.24', expense: '5784.61', count: detail ? 153 : 268,
      incomeCount: detail ? 0 : 115, expenseCount: 153, unpricedCount: rankingComplete ? 0 : 1 };
    const rows = detail ? [{ date: '2026-06-18', category: '其他支出', amountCNY: '999.00', remark: '尾号定制预付' }]
      : [{ month: '2026-06', income: '3911.24', expense: '5784.61', count: 268, unpricedCount: 0 }];
    return { scope: args.scope, choices: {}, asOf: now().toISOString(), datasets: [{
      datasetId: args.datasetId, domain: 'finance', title: detail ? '收支明细' : '收支月度趋势', summary, rows,
      columns: detail ? [{ key: 'date', label: '日期', type: 'date' }, { key: 'category', label: '分类', type: 'text' },
        { key: 'amountCNY', label: '金额', type: 'money' }, { key: 'remark', label: '备注', type: 'text' }]
        : [{ key: 'month', label: '月份', type: 'date' }, { key: 'income', label: '收入', type: 'money' },
          { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }, { key: 'unpricedCount', label: '未定价笔数', type: 'number' }],
      policy: '固定独立财务事实', asOf: now().toISOString(), truncated: detail,
      queryMeta: { version: 1, queryId: args.queryId, datasetId: args.datasetId, requestedScope: scope, effectiveScope: scope,
        filters: { direction: detail ? 'expense' : 'both', text: '' }, sort: detail ? 'amountDesc' : 'monthAsc',
        matchedRowCount: detail ? 153 : 1, returnedRowCount: 1, sourceRecordCount: summary.count,
        rowsComplete: !detail, summaryComplete: true, rankingComplete, returnedDateRange: null, asOf: now().toISOString() },
    }] };
  });
  return f;
}
test('complete June cashflow chart and follow-up maximum use one model selection each and common receipt persistence', async () => {
  const f = setup();
  const chart = await f.send('看一下6月份的支出和收入，给图表给我。');
  const largest = await f.send('支出最大的一笔是？');
  expect(chart.request.providerCalls).toBe(1); expect(largest.request.providerCalls).toBe(1);
  expect(chart.chart).toMatchObject({ datasetId: 'finance-monthly', xKey: 'month', yKeys: ['income', 'expense'] });
  expect(chart.answer).toContain('3911.24');
  expect(chart.answer).toContain('5784.61');
  expect(chart.datasets[0].summary.count).toBe(268);
  expect(largest.answer).toMatch(/2026-06-18.*999\.00/s);
  expect(largest.datasets[0].queryMeta).toMatchObject({ rowsComplete: false, rankingComplete: true, effectiveScope: scope });
  expect(input(f.provider.mock.calls[1][1]).taskContext.scope).toEqual(scope);
  expect(f.state.conversationStore.append).toHaveBeenCalledTimes(2);
  expect(f.state.requestGuard.saveV3Recovery).toHaveBeenCalledTimes(2);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});
test('an unproven extreme continues the ordinary model workflow instead of declaring complete evidence', async () => {
  const f = setup({ rankingComplete: false });
  const result = await f.send('6月份支出最大的一笔是？');
  expect(result.request.providerCalls).toBe(3);
  expect(result.datasets[0].queryMeta.rankingComplete).toBe(false);
  expect(f.provider.mock.calls[2][2]).toEqual([]);
});
