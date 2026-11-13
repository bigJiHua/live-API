jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden'); }),
}));
const publicDb = require('../../src/common/config/db');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { buildTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryContext } = require('../../src/modules/ai/service/queryContext');
const { selectTaskContext } = require('../../src/modules/ai/service/contextState');
const { assembleTurnResult } = require('../../src/modules/ai/service/v3ResultAssembly');
const { randomUUID } = require('node:crypto');

const owner = 'offline-mixed-task-owner', conversationId = 'offline-mixed-task-conversation';
const today = '2026-11-09', stamp = Date.parse('2026-11-09T01:00:00Z');
const cardScope = { startDate: '2026-09-01', endDate: today };
const juneScope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const cards = (overrides = {}) => ({ version: 1, mode: 'query', subject: 'cards', metric: 'card-consumption',
  cardTypes: ['debit'], chartRequest: null, comparisonScopes: [], scope: cardScope,
  status: 'succeeded', turnId: 'mixed-turn-one', ...overrides });
const finance = () => ({ version: 1, mode: 'query', subject: 'finance', metric: 'summary', cardTypes: [],
  chartRequest: { type: 'bar', metric: 'amount' }, comparisonScopes: [], scope: juneScope,
  status: 'succeeded', turnId: 'mixed-turn-one' });
const registry = () => ({ version: 1, tasks: [cards(), finance()] });
const legacyMixed = () => cards({ chartRequest: { type: 'bar', metric: 'amount' }, scope: juneScope });

// Only the AI conversation/message infrastructure is emulated. Both append
// serialization and all context/history restoration are production code.
function fixture() {
  const rows = [], conversation = { id: conversationId, user_id: owner, latest_draft_id: null };
  let nextId = 1, checkpoint;
  const execute = jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT id FROM ai_conversation') || sql.startsWith('SELECT id, latest_draft_id FROM ai_conversation')) {
      return [[...(params[0] === conversationId && params[1] === owner ? [{ ...conversation }] : [])]];
    }
    if (sql.startsWith('INSERT INTO ai_message')) {
      const assistant = sql.includes("'assistant'");
      const [conversation_id, user_id, content] = params;
      rows.push({ id: nextId++, conversation_id, user_id, role: assistant ? 'assistant' : 'user', content,
        draft_id: assistant ? params[3] : null, meta: JSON.parse(params[assistant ? 4 : 3]), created_at: new Date(stamp).toISOString() });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_conversation SET latest_draft_id')) {
      if (params[1] !== conversationId || params[2] !== owner) return [{ affectedRows: 0 }];
      conversation.latest_draft_id = params[0] || conversation.latest_draft_id; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, meta FROM ai_message')) {
      const matches = rows.filter(row => row.conversation_id === params[0] && row.user_id === params[1]
        && row.role === 'assistant' && !row.meta?.standalone).filter(row => {
        if (sql.includes('$.taskContexts')) return row.meta?.taskContexts || row.meta?.taskContext
          || row.meta?.business?.taskContexts || row.meta?.business?.taskContext;
        if (sql.includes('$.taskContext')) return row.meta?.taskContext || row.meta?.business?.taskContext;
        if (sql.includes('$.queryContext.activeQuery')) return row.meta?.queryContext || row.meta?.business?.queryContext;
        throw new Error('Unexpected AI context read');
      });
      return [structuredClone(matches.sort((left, right) => right.id - left.id).slice(0, 20))];
    }
    if (sql.startsWith('SELECT id, role, content, meta, created_at, draft_id, ') && sql.includes('AS turn_sent_at')) {
      expect(sql).toContain('recent_user.sent_at');
      expect(sql).toContain('ORDER BY sent_at DESC, id DESC LIMIT ?');
      expect(params.slice(2, 4)).toEqual(params.slice(0, 2));
      const matches = rows.filter(row => row.conversation_id === params[0] && row.user_id === params[1] && !row.meta?.standalone);
      const sentAt = row => Number(row.meta?.sentAt) || Date.parse(row.created_at) || 0;
      const compare = (left, right) => sentAt(left) - sentAt(right) || left.id - right.id;
      const users = matches.filter(row => row.role === 'user').sort(compare).slice(-params[4]);
      const floor = users[0];
      return [structuredClone(matches.filter(row => floor && compare(row, floor) >= 0)
        .sort((left, right) => compare(right, left)).map(row => ({ ...row, turn_sent_at: sentAt(row) })))];
    }
    if (sql.startsWith('SELECT id, role, content, draft_id, created_at, meta FROM ai_message')) {
      return [structuredClone(rows.filter(row => row.conversation_id === params[0] && row.user_id === params[1]).slice(0, params[2]))];
    }
    throw new Error('Unexpected conversation infrastructure SQL');
  });
  const connection = { execute,
    beginTransaction: jest.fn(async () => { checkpoint = structuredClone({ rows, nextId, conversation }); }),
    commit: jest.fn(async () => { checkpoint = null; }),
    rollback: jest.fn(async () => { if (!checkpoint) return;
      rows.splice(0, rows.length, ...checkpoint.rows); nextId = checkpoint.nextId;
      Object.assign(conversation, checkpoint.conversation); checkpoint = null;
    }), release: jest.fn() };
  const executor = { execute, getConnection: jest.fn(async () => connection) };
  const store = () => createConversationStore({ executor, now: () => stamp });
  const seed = (meta, overrides = {}) => rows.push({ id: nextId++, conversation_id: conversationId, user_id: owner,
    role: 'assistant', content: '已查询。', draft_id: null, created_at: new Date(stamp).toISOString(), meta: structuredClone(meta), ...overrides });
  return { store, rows, seed, connection, execute };
}
const taskFor = (restored, subject) => restored.tasks.find(task => task.subject === subject);

afterAll(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
});

test.each(['top-level', 'business'])('append and reload preserve the complete %s registry against same-turn mixed legacy context', async placement => {
  const f = fixture(), contexts = { taskContexts: registry(), taskContext: legacyMixed() };
  await f.store().append(owner, conversationId, { message: '最近三个月哪张借记卡支出最高？同时看6月收支，给柱状图。',
    answer: '已查询卡片消费和六月收支。', requestId: 'mixed-turn-one',
    queryContext: buildQueryContext({ message: '看6月收支', today }),
    ...(placement === 'business' ? { business: contexts } : contexts) });
  const saved = f.rows.find(row => row.role === 'assistant');
  expect(taskFor(saved.meta.taskContexts, 'cards')).toMatchObject({ cardTypes: ['debit'], chartRequest: null, scope: cardScope });
  expect(taskFor(saved.meta.taskContexts, 'finance')).toMatchObject({ chartRequest: { type: 'bar', metric: 'amount' }, scope: juneScope });
  const restarted = f.store(), restored = await restarted.loadTaskContexts(owner, conversationId);
  expect(taskFor(restored, 'cards')).toMatchObject({ turnId: 'mixed-turn-one', cardTypes: ['debit'], chartRequest: null, scope: cardScope });
  expect(taskFor(restored, 'finance')).toMatchObject({ turnId: 'mixed-turn-one', scope: juneScope });
  const history = (await restarted.open(owner, conversationId)).history;
  expect(taskFor(history.find(row => row.role === 'assistant').taskContexts, 'cards'))
    .toMatchObject({ chartRequest: null, scope: cardScope });
  const message = '信用卡呢？';
  const previous = selectTaskContext(restored, { message, previous: await restarted.loadTaskContext(owner, conversationId) });
  const next = buildTaskContext({ message, today, previous, queryContext: await restarted.loadQueryContext(owner, conversationId) });
  expect(next).toMatchObject({ mode: 'query', subject: 'cards', metric: 'card-consumption', cardTypes: ['credit'],
    chartRequest: null, scope: cardScope });
  expect(f.connection.commit).toHaveBeenCalledTimes(1); expect(f.connection.rollback).not.toHaveBeenCalled();
});

test.each(['top-level', 'business'])('old %s messages with only a single taskContext remain restorable', async placement => {
  const f = fixture(), old = cards({ turnId: 'legacy-cards-turn', chartRequest: { type: 'line', metric: 'amount' } });
  f.seed(placement === 'business' ? { business: { taskContext: old } } : { taskContext: old });
  expect(f.rows[0].meta.taskContexts).toBeUndefined(); expect(f.rows[0].meta.business?.taskContexts).toBeUndefined();
  const restored = await f.store().loadTaskContexts(owner, conversationId);
  expect(restored.tasks).toEqual([old]);
  expect(await f.store().loadTaskContext(owner, conversationId)).toEqual(old);
});

test('a new single task with a newer turnId replaces its stale registry member while retaining the other subject', async () => {
  const f = fixture(), oldRegistry = registry();
  f.seed({ taskContexts: oldRegistry, taskContext: cards(), turnId: 'mixed-turn-one' });
  const october = { startDate: '2026-10-01', endDate: '2026-10-31' };
  const next = cards({ cardTypes: ['credit'], scope: october, turnId: 'credit-turn-two' });
  await f.store().append(owner, conversationId, { message: '看10月信用卡消费', answer: '已查询十月信用卡。',
    requestId: 'credit-turn-two', taskContext: next, taskContexts: oldRegistry });
  const saved = f.rows.findLast(row => row.role === 'assistant');
  expect(taskFor(saved.meta.taskContexts, 'cards')).toMatchObject({ turnId: 'credit-turn-two', cardTypes: ['credit'],
    scope: october, chartRequest: null });
  const restored = await f.store().loadTaskContexts(owner, conversationId);
  expect(taskFor(restored, 'cards')).toMatchObject({ turnId: 'credit-turn-two', scope: october, cardTypes: ['credit'] });
  expect(taskFor(restored, 'finance')).toMatchObject({ turnId: 'mixed-turn-one', scope: juneScope });
});

test('restoration applies a newer legacy-only row to the older complete registry without losing finance', async () => {
  const f = fixture();
  f.seed({ taskContexts: registry(), taskContext: legacyMixed(), turnId: 'mixed-turn-one' });
  const next = cards({ cardTypes: ['credit'], turnId: 'credit-turn-two', scope: cardScope, chartRequest: null });
  f.seed({ taskContext: next, turnId: 'credit-turn-two' });
  const restored = await f.store().loadTaskContexts(owner, conversationId);
  expect(taskFor(restored, 'cards')).toMatchObject({ turnId: 'credit-turn-two', cardTypes: ['credit'], chartRequest: null, scope: cardScope });
  expect(taskFor(restored, 'finance')).toMatchObject({ turnId: 'mixed-turn-one', scope: juneScope });
  expect(restored.tasks).toHaveLength(2);
});
test('an unread finance subtask retains pending query status through actual append and reload', async () => {
  const f = fixture();
  const queryContext = buildQueryContext({ message: '看6月收支，给柱状图。', today });
  expect(queryContext.activeQuery.status).toBe('pending');
  const tasks = { version: 1, tasks: [cards(), { ...finance(), status: 'pending' }] };
  await f.store().append(owner, conversationId, { message: '最近三个月借记卡排名，同时看6月收支',
    answer: '卡片已查询；收支查询尚无本轮获准数据。', requestId: 'mixed-turn-one', queryContext,
    taskContext: cards(), taskContexts: tasks });
  const saved = f.rows.findLast(row => row.role === 'assistant');
  expect(saved.meta.queryContext.activeQuery.status).toBe('pending');
  const restored = await f.store().loadQueryContext(owner, conversationId);
  expect(restored.activeQuery).toMatchObject({ status: 'pending', startDate: '2026-06-01', endDate: '2026-06-30' });
  expect(taskFor(await f.store().loadTaskContexts(owner, conversationId), 'finance').status).toBe('pending');
});

test.each([[1, 1], [2, 1], [1, 2]])('mixed %i draft/%i candidate identities survive production assembly, append and message restoration', async (draftCount, candidateCount) => {
  const f = fixture(), savedDrafts = new Map(), savedCandidates = new Map();
  // These are fixture server stores: they assign the IDs before assembly.
  // Neither the model answer nor operationOutcome supplies a restoration ID.
  for (let index = 0; index < draftCount; index++) {
    const draft = { id: randomUUID(), status: 'pending', version: 1, missingFields: [] };
    savedDrafts.set(draft.id, draft);
  }
  for (let index = 0; index < candidateCount; index++) {
    const candidate = { id: randomUUID(), status: 'pending', fields: { amount: '8.50' } };
    savedCandidates.set(candidate.id, candidate);
  }
  const artifacts = [...savedDrafts.values()].map(draft => ({ draft }))
    .concat([...savedCandidates.values()].map(inputCandidate => ({ inputCandidate, financialCheck: { status: 'needs_input' } })));
  const facts = { modelAnswer: '请核对草稿并补充另一笔信息。', chart: null, chartNote: '', relaxedMode: false,
    openMode: false, request: { requestId: randomUUID(), message: '两笔一起核对' }, responseLanguage: 'zh', scopeText: null,
    conversationId, promptVersion: 'offline-mixed-recovery', promptDigest: 'a'.repeat(64), contractDigest: 'b'.repeat(64),
    disclosureBytes: 0, usage: {}, budget: { calls: 2 }, maxProviderCalls: 5, toolTrace: [], readDatasets: [],
    transactionIntents: [], businessInputs: [], proposedList: [], priorDraftMessage: '', missingTransactionFields: [],
    incompleteBatch: false, cancelledPending: false, clarificationOnly: false, asksDraftStatus: false, actualDrafts: [],
    nextPendingContext: null, pendingTransactions: null, queryContext: null, taskContext: null, queryTaskBindings: [],
    storedTaskContexts: { version: 1, tasks: [] }, storedCoverage: { version: 1, results: [] }, contextSummary: null,
    currentQueryGoals: [], queryInputs: new Map(), financeBindings: [], missingFresh: [], memoryReceipts: [],
    memoryReadReceipts: [], memorySearchReceipts: [], memoryErrors: [], failedTools: new Map(),
    egress: { scrub: value => value }, now: () => new Date(stamp),
    operationOutcome: { version: 1, formalWriteExecuted: true, artifacts: [{ id: 'model-forged-id' }] } };
  const { result, appendPayload } = assembleTurnResult(facts, artifacts);
  expect(result).not.toHaveProperty('draft');
  expect(result).not.toHaveProperty('inputCandidate');
  expect(appendPayload.business.draftIds).toEqual([...savedDrafts.keys()]);
  expect(appendPayload.business.candidateIds).toEqual([...savedCandidates.keys()]);
  expect(result.operationOutcome).toMatchObject({ version: 1, state: 'needs_input', formalWriteExecuted: false });
  await f.store().append(owner, conversationId, appendPayload);
  const restored = (await f.store().messages(owner, conversationId)).find(message => message.role === 'assistant');
  expect(restored.draftId).toBe([...savedDrafts.keys()][0]);
  expect(restored.draftIds).toEqual([...savedDrafts.keys()]);
  expect(restored.candidateIds).toEqual([...savedCandidates.keys()]);
  expect(restored.operationOutcome).toEqual(result.operationOutcome);
  expect(restored.operationOutcome.artifacts.filter(item => item.type === 'draft').map(item => item.id)).toEqual(restored.draftIds);
  expect(restored.operationOutcome.artifacts.filter(item => item.type === 'candidate').map(item => item.id)).toEqual(restored.candidateIds);
  for (const id of restored.draftIds) expect(savedDrafts.has(id)).toBe(true);
  for (const id of restored.candidateIds) expect(savedCandidates.has(id)).toBe(true);
  expect(JSON.stringify(restored.operationOutcome)).not.toContain('model-forged-id');
});

test('mixed query and draft answers keep a server-authored draft confirmation', () => {
  const dataset = { datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
    columns: [{ key: 'month', label: '月份', type: 'text' }, { key: 'income', label: '收入', type: 'money' },
      { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }],
    rows: [{ month: '2026-06', income: '100.00', expense: '60.00', count: 2 }],
    summary: { income: '100.00', expense: '60.00', count: 2, currency: 'CNY' },
    queryMeta: { effectiveScope: juneScope, rowsComplete: true, matchedRowCount: 1, returnedRowCount: 1 }, truncated: false };
  const facts = { modelAnswer: '已按 25.00 元生成草稿，请核对。', chart: null, chartNote: '', relaxedMode: false,
    openMode: false, request: { requestId: randomUUID(), message: '看6月收支，并把午饭25元记一下' }, responseLanguage: 'zh',
    scopeText: null, conversationId, promptVersion: 'mixed-artifact-notice', promptDigest: 'a'.repeat(64), contractDigest: 'b'.repeat(64),
    disclosureBytes: 0, usage: {}, budget: { calls: 2 }, maxProviderCalls: 5,
    toolTrace: [{ tool: 'query_data', domain: 'finance', result: {} }], readDatasets: [dataset], transactionIntents: [],
    businessInputs: [], proposedList: [], priorDraftMessage: '', missingTransactionFields: [], incompleteBatch: false,
    cancelledPending: false, clarificationOnly: false, asksDraftStatus: false, actualDrafts: [], nextPendingContext: null,
    pendingTransactions: null, queryContext: null, taskContext: null, queryTaskBindings: [],
    storedTaskContexts: { version: 1, tasks: [] }, storedCoverage: { version: 1, results: [] }, contextSummary: null,
    currentQueryGoals: [], queryInputs: new Map(), financeBindings: [], missingFresh: [], memoryReceipts: [],
    memoryReadReceipts: [], memorySearchReceipts: [], memoryErrors: [], failedTools: new Map(),
    egress: { scrub: value => value }, now: () => new Date(stamp) };
  const draft = { id: randomUUID(), status: 'pending', version: 1, direction: 0, amount: '25.00',
    categoryName: '餐饮', accountName: '余额', missingFields: [] };
  const { result } = assembleTurnResult(facts, [{ draft }]);
  expect(result.answer).toContain('已生成 1 张草稿');
  expect(result.answer).toContain('支出 25.00 元');
  expect(result.answer).toContain('核对后确认入账');
});
