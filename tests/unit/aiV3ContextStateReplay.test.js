// Real V3 orchestration and preview validation with scripted model messages.
// Public DB, transport and long-term memory reads fail closed.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { fixture, final, calls, id, now } = require('../fixtures/aiV3MemoryFixture');
const { buildPendingTransactionContext, pinPendingTransactionSupplement } = require('../../src/modules/ai/service/pendingTransactions');
const recorded = require('../fixtures/aiV3ReasoningQuality.json');
const date = '2026-11-08';
const taskInput = messages => JSON.parse(messages.find(message => message.role === 'user' && message.content.startsWith('TASK_INPUT:\n'))
  .content.slice('TASK_INPUT:\n'.length));
const inputAt = (f, index) => taskInput(f.provider.mock.calls[index][1]);
const memoryStore = () => ({ list: jest.fn(async () => ({ files: [], count: 0, warnings: [] })),
  read: jest.fn(() => { throw new Error('Unexpected memory read'); }), write: jest.fn(() => { throw new Error('Unexpected memory write'); }) });
const column = (key, type = 'text') => ({ key, label: key, type });

function defaultResponse(_, messages, __, options) {
  const input = taskInput(messages), task = input.taskContext;
  if (!options.json && !messages.some(message => message.role === 'tool') && task?.mode === 'query') {
    if (task.subject === 'cards') return calls('query_data', { datasetId: 'card-counts' });
    if (task.subject === 'finance') return calls('query_data', { datasetId: 'finance-monthly' });
    if (task.subject === 'todo') return calls('query_data', { datasetId: 'todo-events' });
  }
  return final({ answer: task?.mode === 'chat' ? '我们可以继续聊天。' : '查询完成。' });
}

function contextFixture(responder = defaultResponse) {
  const f = fixture(Array.from({ length: 100 }, () => responder), { memoryStore: memoryStore() });
  const store = f.state.conversationStore, originalAppend = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.taskContexts || { version: 1, tasks: [] });
  store.loadQueryCoverage = jest.fn(async () => f.state.queryCoverage || { version: 1, results: [] });
  store.loadContextSummary = jest.fn(async () => f.state.contextSummary || null);
  store.append = jest.fn(async (...args) => {
    await originalAppend(...args);
    const payload = args[2], reply = f.history.at(-1);
    for (const key of ['taskContexts', 'queryCoverage', 'contextSummary']) if (payload[key]) {
      f.state[key] = structuredClone(payload[key]); reply[key] = structuredClone(payload[key]);
    }
  });
  store.open = jest.fn(async (_, __, { historyLimit = 4 } = {}) => {
    const first = f.history.filter(turn => turn.role === 'user').slice(-historyLimit)[0];
    return { id: f.conversationId, history: first ? f.history.slice(f.history.indexOf(first)) : [], latestDraftId: null };
  });
  f.raw.datasets = [
    { datasetId: 'todo-events', domain: 'todo', title: '日程', columns: [column('content'), column('date', 'date')],
      rows: [], summary: {}, totalCount: 0, truncated: false, asOf: now().toISOString(), policy: '本人已保存待办。' },
    { datasetId: 'card-counts', domain: 'card', title: '本人卡片数量', columns: [column('type'), column('count', 'number')],
      rows: structuredClone(recorded.rows), summary: {}, totalCount: 4, truncated: false, asOf: now().toISOString(),
      policy: '按本人未删除卡片类型统计全部数量。' },
    { datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势', columns: [column('month'), column('income', 'money'),
      column('expense', 'money'), column('count', 'number')], rows: [{ month: '2026-06', income: '3911.24', expense: '5784.61', count: 268 }],
      summary: { income: '3911.24', expense: '5784.61', count: 268, currency: 'CNY' }, truncated: false,
      totalCount: 1, asOf: now().toISOString(), policy: '收支汇总以全量计数为准。' },
  ];
  return f;
}

afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});

test('six ordinary intervening turns preserve the real card count pie and its selected denominator', async () => {
  const f = contextFixture();
  const first = await f.send('借记卡和信用卡数量比例给我饼图');
  expect(first.chart).toMatchObject({ datasetId: 'card-counts', type: 'pie' });
  for (const message of ['你叫什么名字呢？', '你会讲笑话吗？', '明天天气怎么样呢？', '哪个电影好看？', '今天聊聊电影吧', '晚安']) {
    const at = f.provider.mock.calls.length;
    const result = await f.send(message);
    expect(inputAt(f, at).taskContext).toMatchObject({ mode: 'chat', subject: 'cards', metric: 'card-count' });
    expect(result.chart).toBeNull();
  }
  const at = f.provider.mock.calls.length;
  const resumed = await f.send('还是借记卡和信用卡数量，继续');
  expect(inputAt(f, at).taskContext).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-count',
    cardTypes: ['debit', 'credit'], chartRequest: { type: 'pie', metric: 'count' } });
  expect(resumed.chart).toMatchObject({ datasetId: 'card-counts', type: 'pie', yKeys: ['count'] });
  expect(resumed.datasets[0].rows.map(row => [row.type, row.count, row.sharePct]))
    .toEqual([['信用卡', 20, '25.3'], ['借记卡', 59, '74.7']]);
  expect(resumed.datasets[0].summary.totalCount).toBe(79);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});

test('finance and card tasks restore independently after a different business query', async () => {
  const f = contextFixture();
  await f.send('查6月支出和收入，给我图表');
  await f.send('借记卡和信用卡数量比例给我饼图');
  await f.send('查待办');
  expect(f.state.taskContexts.tasks.map(task => task.subject)).toEqual(['finance', 'cards', 'todo']);
  const at = f.provider.mock.calls.length;
  const finance = await f.send('继续查6月收支');
  expect(inputAt(f, at).taskContext).toMatchObject({ subject: 'finance', metric: 'summary',
    scope: { startDate: '2026-06-01', endDate: '2026-06-30' }, chartRequest: { type: 'bar' } });
  expect(inputAt(f, at).activeQuery).toMatchObject({ startDate: '2026-06-01', endDate: '2026-06-30' });
  expect(finance.chart).toMatchObject({ datasetId: 'finance-monthly', type: 'bar' });
  const cardAt = f.provider.mock.calls.length;
  const cards = await f.send('继续看借记卡和信用卡数量');
  expect(inputAt(f, cardAt).taskContext).toMatchObject({ subject: 'cards', metric: 'card-count', chartRequest: { type: 'pie' } });
  expect(cards.chart).toMatchObject({ datasetId: 'card-counts', type: 'pie' });
});

test('a generic chart follow-up keeps the last card denominator instead of inheriting an older finance query', async () => {
  const f = contextFixture();
  await f.send('查6月支出和收入，给我图表');
  await f.send('借记卡和信用卡数量比例给我饼图');
  await f.send('晚安');
  const at = f.provider.mock.calls.length;
  const result = await f.send('给我柱状图');
  expect(inputAt(f, at).taskContext).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-count',
    cardTypes: ['debit', 'credit'], chartRequest: { type: 'bar', metric: 'count' } });
  expect(result.chart).toMatchObject({ datasetId: 'card-counts', type: 'bar', yKeys: ['count'] });
  expect(result.datasets[0].summary.totalCount).toBe(79);
});

test('a card quantity query carries prior coverage without treating old data rows as this turn evidence', async () => {
  const f = contextFixture();
  const counted = await f.send('借记卡和信用卡数量比例给我饼图');
  const at = f.provider.mock.calls.length;
  const chat = await f.send('你叫什么名字？');
  const prior = inputAt(f, at).previousQueryCoverage;
  expect(prior).toEqual([expect.objectContaining({ source: 'previous-turn', status: 'succeeded', datasetId: 'card-counts',
    queryId: counted.datasets[0].queryMeta.queryId, matchedRowCount: 2, returnedRowCount: 2, sourceRecordCount: 79,
    cardTypes: ['debit', 'credit'], returnedDateRange: null, asOf: now().toISOString() })]);
  expect(JSON.stringify(prior)).not.toMatch(/"rows"|"amount"|"ref"|fixture-ag|"count":20/);
  expect(chat.datasets).toEqual([]);
  expect(f.repository.query).toHaveBeenCalledTimes(1);
});

test.each([['农业银行 7476', false], ['农业银行 6838', true]])
  ('a budget-omitted account correction survives six later turns in the real V3 validation path: %s', async (accountName, accepted) => {
    const previousBudget = process.env.AI_CONTEXT_HISTORY_TOKENS;
    process.env.AI_CONTEXT_HISTORY_TOKENS = '500';
    try {
      const responder = (_, messages, __, options) => {
        if (!options.json && !messages.some(message => message.role === 'tool')) return calls('list_choices', { domain: 'finance' });
        const input = taskInput(messages), tool = JSON.parse(messages.findLast(message => message.role === 'tool').content);
        const sourceTurn = input.userTurns.findIndex(text => text.includes('8.50'));
        return final({ answer: '请核对这笔草稿。', proposal: { kind: 'transaction.create', fields: { direction: 0, amount: '8.50',
          currency: 'CNY', transDate: date, accountRef: tool.choices.cards.find(row => row.name === accountName).ref,
          categoryRef: tool.choices.categories[0].ref, payMethod: '银行卡', remark: '午餐' }, evidence: { sourceTurn, quote: '8.50' } } });
      };
      const f = contextFixture(responder), sourceId = id(), oldAccountId = id(), correctionId = id();
      const original = '今天午餐花了8.50元，农业银行借记卡付的';
      const oldAccount = '用农业银行借记卡';
      const correction = '不是借记卡，是信用卡' + '。'.repeat(900);
      const add = (turnId, content, answer = '已保留。') => f.history.push({ role: 'user', turnId, content, sourceDate: date },
        { role: 'assistant', turnId, content: answer });
      add(sourceId, original); add(oldAccountId, oldAccount); add(correctionId, correction, '长'.repeat(1200));
      for (let index = 0; index < 6; index++) add(id(), `闲聊${index}`, '收到。');
      const start = now().getTime() - 10000;
      let pending = buildPendingTransactionContext({ conversationId: f.conversationId, turnId: sourceId, now: start,
        userTurns: [original], userTurnDates: [date], userTurnIds: [sourceId], transactions: [{
          fields: { direction: 0, amount: '8.50', currency: 'CNY', transDate: date, payMethod: '银行卡', remark: '午餐' },
          evidence: { sourceTurn: 0, quote: '8.50' }, missingFields: ['账户'] }] });
      pending = pinPendingTransactionSupplement(pending, { message: oldAccount, sourceDate: date, turnId: oldAccountId,
        conversationId: f.conversationId, now: start + 1000 });
      pending = pinPendingTransactionSupplement(pending, { message: correction, sourceDate: date, turnId: correctionId,
        conversationId: f.conversationId, now: start + 2000 });
      f.state.pendingContext = pending;
      const result = await f.send('农业银行卡付的');
      const input = inputAt(f, 0), amountTurn = input.pendingTransactions.items[0].evidence.sourceTurn;
      expect(input.historyBudget).toMatchObject({ budget: 500, truncated: true });
      expect(input.historyBudget.estimatedTokens).toBeLessThanOrEqual(500);
      expect(input.contextSummary.items.some(item => item.text.includes('不是借记卡，是信用卡'))).toBe(true);
      expect(input.userTurns[amountTurn]).toBe(original);
      expect(input.userTurns.indexOf(correction)).toBeGreaterThan(amountTurn);
      expect(input.userTurns.indexOf(correction)).toBeGreaterThan(input.userTurns.indexOf(oldAccount));
      expect(input.userTurns).toHaveLength(10);
      if (accepted) {
        expect(result.draft).toMatchObject({ amount: '8.50', transDate: date, accountId: 'fixture-ag-credit', status: 'pending' });
        expect(f.legacy.prepareTransactionProposal).toHaveBeenCalledTimes(1);
      } else {
        expect(result.draft).toBeUndefined();
        expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
        expect(f.state.pendingContext).toMatchObject({ status: 'awaiting_input', expiresAt: pending.expiresAt });
      }
    } finally {
      if (previousBudget === undefined) delete process.env.AI_CONTEXT_HISTORY_TOKENS;
      else process.env.AI_CONTEXT_HISTORY_TOKENS = previousBudget;
    }
  });
