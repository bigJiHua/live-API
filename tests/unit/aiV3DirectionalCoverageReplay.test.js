// Real V3/preview orchestration; every provider and database response is offline.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const taskInput = messages => JSON.parse(messages.find(message => message.role === 'user' && message.content.startsWith('TASK_INPUT:\n'))
  .content.slice('TASK_INPUT:\n'.length));
const column = (key, type = 'text') => ({ key, label: key, type });

function replay(summaryCounts) {
  const respond = (_, messages, __, options) => {
    const input = taskInput(messages);
    if (!options.json && !messages.some(message => message.role === 'tool') && input.taskContext?.mode === 'query')
      return calls('query_data', { datasetId: 'finance-monthly' });
    return final({ answer: input.taskContext?.mode === 'chat' ? '我们可以继续聊天。' : '查询完成。' });
  };
  const f = fixture(Array.from({ length: 30 }, () => respond), { memoryStore: {
    list: jest.fn(async () => ({ files: [], count: 0, warnings: [] })),
    read: jest.fn(() => { throw new Error('Unexpected memory read'); }),
    write: jest.fn(() => { throw new Error('Unexpected memory write'); }),
  } });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadQueryCoverage = jest.fn(async () => f.state.queryCoverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => {
    await append(...args);
    if (args[2].queryCoverage) f.state.queryCoverage = structuredClone(args[2].queryCoverage);
  });
  f.raw.datasets = [{ datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
    columns: [column('month'), column('income', 'money'), column('expense', 'money'), column('count', 'number')],
    rows: [{ month: '2026-06', income: '3911.24', expense: '5784.61', count: 268 }],
    summary: { income: '3911.24', expense: '5784.61', count: 268, currency: 'CNY', ...summaryCounts },
    truncated: false, asOf: now().toISOString(), policy: '全范围汇总。' }];
  return f;
}

afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});

test.each([
  ['known', { incomeCount: 34, expenseCount: 234 }, { incomeCount: 34, expenseCount: 234 }],
  ['unknown', {}, { incomeCount: null, expenseCount: null }],
])('a real next-turn TASK_INPUT carries June directional counts as %s without returning old evidence', async (_, counts, expected) => {
  const f = replay(counts);
  const queried = await f.send('查6月收入和支出');
  expect(queried.datasets[0].queryMeta).not.toHaveProperty('incomeCount');
  expect(queried.datasets[0].queryMeta).not.toHaveProperty('expenseCount');
  const at = f.provider.mock.calls.length;
  const chat = await f.send('讲个笑话');
  const prior = taskInput(f.provider.mock.calls[at][1]).previousQueryCoverage;
  expect(prior).toEqual([expect.objectContaining({ requestedScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, matchedRowCount: 1,
    returnedRowCount: 1, sourceRecordCount: 268, ...expected,
    source: 'previous-turn', status: 'succeeded', asOf: now().toISOString() })]);
  expect(JSON.stringify(prior)).not.toMatch(/3911\.24|5784\.61|"rows"|"income"|"expense"|"ref"/);
  expect(chat.datasets).toEqual([]);
  const followupAt = f.provider.mock.calls.length;
  await f.send('继续看6月收支');
  const followup = taskInput(f.provider.mock.calls[followupAt][1]);
  expect(followup.activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
  expect(followup.previousQueryCoverage[0]).toMatchObject({ sourceRecordCount: 268, ...expected });
  expect(f.repository.query).toHaveBeenCalledTimes(2);
});
