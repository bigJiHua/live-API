jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Paid provider forbidden'); }) }));
const { fixture, final, calls } = require('../fixtures/aiV3MemoryFixture');
const capture = require('../fixtures/aiV3ChartToolRoleReplay.json');
const raw = capture.records.find(record => record.phase === 'tool' && record.tool === 'query_data').result;
const dataset = raw.datasets[0];
const message = '查看2026年6月份收支流水，只展示前10笔，以每笔日期作横轴、人民币金额作纵轴给柱状图，说明图仅代表这10笔明细。';
const sourceProse = dataset.rows.map((row, index) => `${index + 1}. ${row.date} ${row.direction === 0 ? '支出' : '收入'} ${row.amountCNY} ${row.category}`).join('\n');

function setup({ wrongQueryId = false, writtenRows = false } = {}) {
  const scripted = [calls('query_data', { datasetId: 'finance-transactions', startDate: '2026-06-01', endDate: '2026-06-30',
    direction: 'both', sort: 'dateDesc', limit: 10 }), (_, messages) => {
    const approved = messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content)).find(item => item.datasets?.length);
    return final({ answer: sourceProse + '\n同一日期出现多根柱子表示当天有多笔交易。',
      chart: { datasetId: 'finance-transactions', queryId: wrongQueryId ? 'q_' + 'f'.repeat(24) : approved.datasets[0].queryMeta.queryId,
        type: 'bar', xKey: 'date', yKeys: ['amountCNY'], title: '六月前10笔明细' } });
  }];
  const f = fixture(scripted, { clock: () => new Date(dataset.queryMeta.asOf), memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.repository.query.mockImplementation(async (_, args) => { const copy = structuredClone(raw); copy.scope = args.scope;
    copy.datasets[0].queryMeta.queryId = args.queryId; return copy; });
  return { f, message: message + (writtenRows ? '同时列出这些明细原文。' : '') };
}

test('actual captured C03 rows gain explicit chart-only coverage and retain their exact chart/data recovery', async () => {
  const { f, message } = setup(), result = await f.send(message);
  expect(result.answer).toContain('仅展示本次返回的 10 笔收支明细'); expect(result.answer).toContain('全范围匹配 268 笔');
  expect(result.answer).not.toMatch(/^\s*\d+[.．]\s*2026-06-/m);
  expect(result.answer).toContain('同一日期出现多根柱子');
  expect(result.datasets[0].rows).toEqual(dataset.rows);
  expect(result.chart).toMatchObject({ datasetId: 'finance-transactions', queryId: result.datasets[0].queryMeta.queryId,
    type: 'bar', xKey: 'date', yKeys: ['amountCNY'] });
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(result.answer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

test('an actual chart response preserves an explicitly requested written row list', async () => {
  const { f, message } = setup({ writtenRows: true }), result = await f.send(message);
  expect(result.answer).toContain('仅展示本次返回的 10 笔收支明细');
  expect(result.answer).toMatch(/^\s*\d+[.．]\s*2026-06-/m);
});

test('an incorrect chart query identity remains terminal before any presentation can be persisted', async () => {
  const { f, message } = setup({ wrongQueryId: true });
  await expect(f.send(message)).rejects.toMatchObject({ code: 'AI_CHART_INVALID' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
