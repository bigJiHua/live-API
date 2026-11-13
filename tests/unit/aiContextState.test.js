jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));
const { buildTaskContext, finalizeTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryContext } = require('../../src/modules/ai/service/queryContext');
const { sanitizeTaskContexts, upsertTaskContext, selectTaskContext, sanitizeQueryCoverage, attachQueryCoverage,
  sanitizeContextSummary } = require('../../src/modules/ai/service/contextState');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const today = '2026-11-08';
const build = (message, previous) => buildTaskContext({ message, today, previous });
const pie = () => finalizeTaskContext(build('借记卡和信用卡数量比例给我饼图'), { status: 'succeeded', turnId: 'cards_pie' });

test.each(['你叫什么名字？', '你叫什么名字呢？', '你会讲笑话吗？', '明天天气怎么样呢？', '哪个电影好看？', '今天聊聊电影吧', '晚安'])
  ('ordinary question or chat preserves the preceding business intent: %s', message => {
    const previous = pie(), result = build(message, previous);
    expect(result).toMatchObject({ mode: 'chat', subject: 'cards', metric: 'card-count',
      cardTypes: ['debit', 'credit'], chartRequest: { type: 'pie', metric: 'count' } });
    expect(upsertTaskContext(upsertTaskContext(null, previous), result).tasks).toEqual([previous]);
  });
test('a chat question cannot inherit a finance query merely because it contains a discourse particle', () => {
  const oldQuery = buildQueryContext({ message: '6月支出最大的一笔是？', today });
  const queryContext = buildQueryContext({ message: '你叫什么名字呢？', today, previous: oldQuery });
  expect(queryContext).toBeNull();
  expect(buildTaskContext({ message: '你叫什么名字呢？', today, previous: pie(), queryContext }))
    .toMatchObject({ mode: 'chat', subject: 'cards', chartRequest: { type: 'pie', metric: 'count' } });
});

test('finance and card tasks independently resume after six intervening turns and a different business task', () => {
  const cards = pie();
  const financeQuery = buildQueryContext({ message: '6月支出最大的一笔是？', today });
  const finance = buildTaskContext({ message: '6月支出最大的一笔是？', today, queryContext: financeQuery });
  let registry = upsertTaskContext(upsertTaskContext(null, cards), finance), current = finance;
  for (const message of ['查待办', '你叫什么名字？', '讲个笑话好吗？', '今天聊电影', '你会翻译吗？', '谢谢']) {
    current = build(message, selectTaskContext(registry, { message, previous: current }));
    registry = upsertTaskContext(registry, current);
  }
  const cardPrevious = selectTaskContext(registry, { message: '还是借记卡和信用卡数量，继续', previous: current });
  expect(build('还是借记卡和信用卡数量，继续', cardPrevious)).toMatchObject({ subject: 'cards', metric: 'card-count', chartRequest: { type: 'pie', metric: 'count' } });
  expect(selectTaskContext(registry, { message: '刚才那个饼图', previous: current })).toMatchObject({ subject: 'cards', chartRequest: { type: 'pie' } });
  const financePrevious = selectTaskContext(registry, { message: '支出最大的一笔呢？', previous: current });
  expect(financePrevious).toMatchObject({ subject: 'finance', metric: 'transaction-max', scope: { startDate: '2026-06-01', endDate: '2026-06-30' } });
  expect(registry.tasks.map(task => task.subject)).toEqual(['cards', 'finance', 'todo']);
});
test('a generic trend request defaults to finance and resumes an existing chart task when available', () => {
  expect(build('看趋势')).toMatchObject({ mode: 'query', subject: 'finance', chartRequest: { type: 'line', metric: 'amount' } });
  const cards = pie(), registry = upsertTaskContext(null, cards);
  expect(selectTaskContext(registry, { message: '看趋势', previous: { version: 1, mode: 'query', subject: 'todo' } }))
    .toMatchObject({ subject: 'cards', chartRequest: { type: 'pie', metric: 'count' } });
});

test('task registry stores at most six distinct subjects and replacing one preserves all others', () => {
  const subjects = ['finance', 'cards', 'todo', 'diary', 'budget', 'fund', 'fixedAsset'];
  let registry = null;
  for (const subject of subjects) registry = upsertTaskContext(registry, { version: 1, mode: 'query', subject, metric: 'summary', status: 'succeeded' });
  expect(registry.tasks.map(task => task.subject)).toEqual(subjects.slice(1));
  registry = upsertTaskContext(registry, { ...pie(), amount: '999.00', ref: 'old-ref', rows: [{ value: 9 }] });
  expect(registry.tasks.map(task => task.subject)).toEqual(['todo', 'diary', 'budget', 'fund', 'fixedAsset', 'cards']);
  expect(JSON.stringify(sanitizeTaskContexts(registry))).not.toMatch(/999\.00|old-ref|"rows"/);
});

const meta = (queryId = `q_${'a'.repeat(24)}`, overrides = {}) => ({ version: 1, queryId, datasetId: 'card-counts',
  requestedScope: { startDate: '2026-11-01', endDate: today }, effectiveScope: { startDate: '2026-11-01', endDate: today },
  filters: { direction: 'both', text: '' }, sort: 'dateDesc', matchedRowCount: 2, returnedRowCount: 2,
  sourceRecordCount: 79, rowsComplete: true, summaryComplete: true, rankingComplete: false, returnedDateRange: null,
  asOf: '2026-11-08T04:00:00.000Z', ...overrides });
const countDataset = () => ({ datasetId: 'card-counts', rows: [{ type: 'credit', count: 20, ref: 'old-ref' },
  { type: 'debit', count: 59, amount: '999.00' }], queryMeta: meta() });

test('card count coverage persists independently of a finance query and distinguishes rows from actual card quantities', () => {
  expect(buildQueryContext({ message: '借记卡和信用卡数量比例饼图', today })).toBeNull();
  const coverage = attachQueryCoverage(null, [countDataset()], { turnId: 'card_count_turn',
    queryInputs: new Map([[meta().queryId, { cardTypes: ['credit', 'debit'] }]]) });
  expect(coverage.results[0]).toMatchObject({ queryId: meta().queryId, datasetId: 'card-counts', turnId: 'card_count_turn',
    cardTypes: ['credit', 'debit'], matchedRowCount: 2, returnedRowCount: 2, sourceRecordCount: 79,
    source: 'previous-turn', status: 'succeeded', returnedDateRange: null, asOf: '2026-11-08T04:00:00.000Z' });
  expect(JSON.stringify(coverage)).not.toMatch(/old-ref|999\.00|"rows"|"amount"|"count":20/);
});

const financeDataset = (overrides = {}) => ({ datasetId: 'finance-monthly',
  rows: [{ month: '2026-06', count: 268, income: '3911.24', expense: '5784.61', ref: 'old-finance-ref' }],
  summary: { count: 268, incomeCount: 34, expenseCount: 234, income: '3911.24', expense: '5784.61' },
  queryMeta: meta(`q_${'c'.repeat(24)}`, { datasetId: 'finance-monthly',
    requestedScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 268, sort: 'monthAsc', rankingComplete: true }),
  ...overrides });

test('finance coverage carries full-range directional counts separately from one monthly result row', () => {
  const dataset = financeDataset(), original = structuredClone(dataset);
  const coverage = attachQueryCoverage(null, [dataset], { turnId: 'june_totals' });
  expect(coverage.results[0]).toMatchObject({ matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 268,
    incomeCount: 34, expenseCount: 234, effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    source: 'previous-turn', status: 'succeeded', asOf: '2026-11-08T04:00:00.000Z', turnId: 'june_totals' });
  expect(dataset).toEqual(original);
  expect(dataset.queryMeta).not.toHaveProperty('incomeCount');
  expect(dataset.queryMeta).not.toHaveProperty('expenseCount');
  expect(JSON.stringify(coverage)).not.toMatch(/3911\.24|5784\.61|old-finance-ref|"rows"|"income"|"expense"/);
});

test('a 50-row transaction window retains full-range directional counts without recounting returned rows', () => {
  const dataset = financeDataset({ datasetId: 'finance-transactions',
    rows: Array.from({ length: 50 }, () => ({ direction: 0 })),
    queryMeta: meta(`q_${'d'.repeat(24)}`, { datasetId: 'finance-transactions', matchedRowCount: 268,
      returnedRowCount: 50, sourceRecordCount: 268, rowsComplete: false }) });
  expect(attachQueryCoverage(null, [dataset]).results[0]).toMatchObject({ matchedRowCount: 268,
    returnedRowCount: 50, sourceRecordCount: 268, rowsComplete: false, incomeCount: 34, expenseCount: 234 });
});

test('absent directional counts remain null even when result rows or old metadata contain numbers', () => {
  const dataset = financeDataset({ summary: { count: 268 }, queryMeta: { ...financeDataset().queryMeta,
    incomeCount: 80, expenseCount: 188 } });
  expect(attachQueryCoverage(null, [dataset]).results[0]).toMatchObject({ sourceRecordCount: 268,
    incomeCount: null, expenseCount: null });
  expect(sanitizeQueryCoverage([financeDataset().queryMeta]).results[0])
    .toMatchObject({ incomeCount: null, expenseCount: null });
  expect(attachQueryCoverage(null, [financeDataset({ summary: { incomeCount: null, expenseCount: 0 } })]).results[0])
    .toMatchObject({ incomeCount: null, expenseCount: 0 });
});

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '234', NaN, Infinity])
  ('invalid directional count rejects the coverage record instead of coercing it: %s', value => {
    for (const key of ['incomeCount', 'expenseCount']) {
      const dataset = financeDataset({ summary: { ...financeDataset().summary, [key]: value } });
      expect(attachQueryCoverage(null, [dataset]).results).toEqual([]);
      expect(sanitizeQueryCoverage([{ ...financeDataset().queryMeta, [key]: value }]).results).toEqual([]);
    }
  });

test('coverage is bounded to eight queries, preserves returned date ranges and rejects inconsistent records', () => {
  let coverage = null;
  for (let index = 0; index < 10; index++) {
    const queryId = `q_${index.toString(16).padStart(24, '0')}`;
    coverage = attachQueryCoverage(coverage, [{ ...countDataset(), queryMeta: meta(queryId) }]);
  }
  expect(coverage.results).toHaveLength(8);
  expect(coverage.results[0].queryId).toBe(`q_${'2'.padStart(24, '0')}`);
  const detailMeta = meta(`q_${'b'.repeat(24)}`, { datasetId: 'finance-transactions', returnedRowCount: 1,
    matchedRowCount: 268, sourceRecordCount: 268, rowsComplete: false, rankingComplete: true, sort: 'amountDesc',
    returnedDateRange: { startDate: '2026-11-03', endDate: '2026-11-03' } });
  expect(attachQueryCoverage(null, [{ datasetId: detailMeta.datasetId, rows: [{}], queryMeta: detailMeta }]).results[0])
    .toMatchObject({ returnedRowCount: 1, sourceRecordCount: 268, rowsComplete: false, rankingComplete: true,
      returnedDateRange: { startDate: '2026-11-03', endDate: '2026-11-03' } });
  expect(attachQueryCoverage(null, [{ ...countDataset(), queryMeta: meta(undefined, { returnedRowCount: 3 }) }]).results).toEqual([]);
  expect(sanitizeQueryCoverage([{ ...detailMeta, returnedDateRange: { startDate: '2025-01-01', endDate: '2025-01-01' } }]).results).toEqual([]);
});

function persistenceFixture() {
  const messages = [];
  const executor = { execute: jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT id, latest_draft_id') || sql.startsWith('SELECT id FROM ai_conversation'))
      return [params[1] === 'owner' ? [{ id: 'conversation', latest_draft_id: null }] : []];
    if (sql.startsWith('INSERT INTO ai_message')) {
      const assistant = sql.includes("'assistant'"), hasDraft = sql.includes('draft_id');
      messages.push({ id: messages.length + 1, conversation_id: params[0], user_id: params[1], role: assistant ? 'assistant' : 'user',
        content: params[2], meta: JSON.parse(params[assistant && hasDraft ? 4 : 3]), created_at: '2026-11-08T04:00:00.000Z' });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
    if (sql.startsWith('SELECT id FROM ai_message')) return [[]];
    if (sql.startsWith('SELECT id, role')) {
      const rows = messages.filter(row => row.conversation_id === params[0] && row.user_id === params[1] && !row.meta?.standalone);
      const cutoff = rows.filter(row => row.role === 'user').slice(-params[4])[0]?.id;
      return [rows.filter(row => cutoff != null && row.id >= cutoff).reverse().map(row => structuredClone(row))];
    }
    if (sql.startsWith('SELECT id, meta')) {
      expect(params).toEqual(['conversation', 'owner']);
      let rows = messages.filter(row => row.role === 'assistant' && !row.meta?.standalone);
      if (sql.includes("'$.contextSummary'")) rows = rows.filter(row => row.meta.contextSummary);
      else if (sql.includes("'$.queryCoverage'")) rows = rows.filter(row => row.meta.queryCoverage || row.meta.queryContext?.lastResults);
      else if (sql.includes("'$.taskContexts'")) rows = rows.filter(row => row.meta.taskContexts || row.meta.taskContext);
      else rows = rows.filter(row => row.meta.taskContext);
      return [rows.slice().reverse().slice(0, 20).map(row => structuredClone(row))];
    }
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  }) };
  return { messages, executor, store: createConversationStore({ executor }) };
}

test('stored finance directional counts survive chat and failed-query metadata with their original provenance', async () => {
  const f = persistenceFixture();
  const queryCoverage = attachQueryCoverage(null, [financeDataset()], { turnId: 'june_totals' });
  await f.store.append('owner', 'conversation', { message: '6月收入和支出', answer: '查询完成',
    requestId: 'june_totals', queryCoverage });
  await f.store.append('owner', 'conversation', { message: '讲个笑话', answer: '答复', requestId: 'chat', queryCoverage });
  await f.store.appendFailure('owner', 'conversation', { message: '支出最大的一笔？', notice: '本次失败',
    requestId: 'failed_followup', errorCode: 'AI_PROVIDER_TIMEOUT', queryCoverage });
  expect((await f.store.loadQueryCoverage('owner', 'conversation')).results[0])
    .toMatchObject({ sourceRecordCount: 268, returnedRowCount: 1, incomeCount: 34, expenseCount: 234,
      source: 'previous-turn', status: 'succeeded', turnId: 'june_totals', asOf: '2026-11-08T04:00:00.000Z' });
});

test('metadata restores independent tasks and card count coverage beyond six intervening user turns', async () => {
  const f = persistenceFixture();
  let current = pie(), registry = upsertTaskContext(null, current);
  const coverage = attachQueryCoverage(null, [countDataset()], { turnId: 'count_turn', cardTypes: ['credit', 'debit'] });
  await f.store.append('owner', 'conversation', { message: '借记卡和信用卡数量饼图', answer: '79张', requestId: 'count_turn',
    taskContext: current, taskContexts: registry, queryCoverage: coverage });
  for (let index = 0; index < 6; index++) {
    current = build(index === 0 ? '查待办' : '你会讲笑话吗？', current);
    registry = upsertTaskContext(registry, current);
    await f.store.append('owner', 'conversation', { message: index === 0 ? '查待办' : '你会讲笑话吗？', answer: '答复', requestId: `chat_${index}`,
      taskContext: current, taskContexts: registry, queryCoverage: coverage });
  }
  expect((await f.store.open('owner', 'conversation')).history.filter(turn => turn.role === 'user')).toHaveLength(4);
  expect((await f.store.open('owner', 'conversation', { historyLimit: 12 })).history.filter(turn => turn.role === 'user')).toHaveLength(7);
  const restored = await f.store.loadTaskContexts('owner', 'conversation');
  expect(selectTaskContext(restored, { message: '刚才那个饼图' })).toMatchObject({ subject: 'cards', metric: 'card-count', chartRequest: { type: 'pie' } });
  expect((await f.store.loadQueryCoverage('owner', 'conversation')).results[0])
    .toMatchObject({ datasetId: 'card-counts', sourceRecordCount: 79, returnedRowCount: 2, cardTypes: ['credit', 'debit'] });
  expect(f.executor.execute.mock.calls.filter(([sql]) => sql.startsWith('SELECT id, meta')).every(([sql]) => sql.includes('user_id = ?'))).toBe(true);
});

test('context summary persists only bounded user summary fields and is independently owner scoped', async () => {
  const f = persistenceFixture();
  const contextSummary = { version: 1, items: [{ text: '用户原话摘要', sourceDate: today, status: 'completed', ref: 'old-ref' }],
    truncated: false, amount: '999.00' };
  await f.store.append('owner', 'conversation', { message: '查询', answer: '完成', contextSummary });
  expect(await f.store.loadContextSummary('owner', 'conversation')).toEqual({ version: 1,
    items: [{ text: '用户原话摘要', sourceDate: today, status: 'completed' }], truncated: false });
  expect(JSON.stringify(f.messages[1].meta.contextSummary)).not.toMatch(/old-ref|999\.00/);
  expect(sanitizeContextSummary({ ...contextSummary, items: Array.from({ length: 9 }, () => ({ text: '字'.repeat(400), sourceDate: today, status: 'failed' })) }))
    .toMatchObject({ truncated: true, items: expect.arrayContaining([expect.objectContaining({ text: '字'.repeat(320) })]) });
  expect(sanitizeContextSummary({ version: 1, items: [], truncated: false }).items).toEqual([]);
});

test('a failed card query preserves other business tasks, previous coverage, and the user summary', async () => {
  const f = persistenceFixture();
  const finance = { version: 1, mode: 'query', subject: 'finance', metric: 'summary', status: 'succeeded',
    scope: { startDate: '2026-06-01', endDate: '2026-06-30' } };
  const taskContexts = upsertTaskContext(upsertTaskContext(null, finance), pie());
  const queryCoverage = attachQueryCoverage(null, [countDataset()], { turnId: 'earlier_success', cardTypes: ['credit', 'debit'] });
  const contextSummary = { version: 1, items: [{ text: '之前要求统计卡片数量', sourceDate: today, status: 'completed' }], truncated: false };
  await f.store.appendFailure('owner', 'conversation', { message: '再给饼图', notice: '本次失败', requestId: 'failed_turn',
    errorCode: 'AI_PROVIDER_TIMEOUT', taskContext: pie(), taskContexts, queryCoverage, contextSummary });
  const restored = await f.store.loadTaskContexts('owner', 'conversation');
  expect(restored.tasks.find(task => task.subject === 'finance')).toMatchObject(finance);
  expect(restored.tasks.find(task => task.subject === 'cards')).toMatchObject({ status: 'failed', turnId: 'failed_turn', chartRequest: { type: 'pie' } });
  expect((await f.store.loadQueryCoverage('owner', 'conversation')).results[0])
    .toMatchObject({ status: 'succeeded', turnId: 'earlier_success', sourceRecordCount: 79 });
  expect(await f.store.loadContextSummary('owner', 'conversation')).toEqual(contextSummary);
});
