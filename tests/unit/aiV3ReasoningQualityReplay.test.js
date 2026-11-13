// Replay approved, sanitized existing outputs through the real service pipeline.
// Both provider transport and the public DB fail closed; every read is a fixture.
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Public DB forbidden in quality replay'); }),
  getConnection: jest.fn(() => { throw new Error('Public DB forbidden in quality replay'); }),
}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden in quality replay'); }),
}));

const crypto = require('crypto');
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const { buildPendingTransactionContext } = require('../../src/modules/ai/service/pendingTransactions');
const recorded = require('../fixtures/aiV3ReasoningQuality.json');
const id = () => crypto.randomUUID();
const date = '2026-11-08';
const now = () => new Date('2026-11-08T13:22:14Z');
const final = output => ({ role: 'assistant', content: JSON.stringify({ answer: '请核对', proposal: null, ...output }) });
const calls = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `call_${id()}`,
  type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const taskInput = messages => JSON.parse(messages.find(message => message.role === 'user' &&
  message.content.startsWith('TASK_INPUT:\n')).content.slice('TASK_INPUT:\n'.length));
let firstQualityResult = null;

function sanitizedQualityResult(result) {
  const queryIds = new Map();
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (key === 'queryId') {
        if (!queryIds.has(item)) queryIds.set(item, `q_${String(queryIds.size + 1).padStart(24, '0')}`);
        return [[key, queryIds.get(item)]];
      }
      if (key !== 'datasetId' && (key === 'id' || /(?:Id|Ref|_id|_ref)$/.test(key))) return [];
      return [[key, clean(item)]];
    }));
  };
  return clean({ contractVersion: result.contractVersion, answer: result.answer, datasets: result.datasets, chart: result.chart });
}

afterAll(async () => {
  const evidenceFile = process.env.AI_QUALITY_REPLAY_EVIDENCE_FILE;
  if (!evidenceFile || !firstQualityResult) return;
  const fs = require('fs/promises'), path = require('path');
  await fs.mkdir(path.dirname(evidenceFile), { recursive: true });
  await fs.writeFile(evidenceFile, JSON.stringify({ mode: 'sanitized recorded-response offline replay',
    realProviderCalls: 0, realDatabaseCalls: 0, result: sanitizedQualityResult(firstQualityResult) }, null, 2) + '\n', 'utf8');
});

function fixture(responses) {
  const scripted = [...responses, responses.at(-1)];
  const history = [], previewsById = new Map(), audits = [];
  const conversationId = id();
  const conn = { beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}), release: jest.fn(), execute: jest.fn(async () => [{ affectedRows: 1 }]) };
  const executor = { getConnection: jest.fn(async () => conn), execute: jest.fn(async (sql, params) => {
    if (sql.startsWith("UPDATE ai_analysis_preview SET payload = 'expired'")) return [{ affectedRows: 0 }];
    if (sql.startsWith('INSERT INTO ai_analysis_preview')) {
      const [previewId, user_id, digest, payload, created_at, expires_at] = params;
      previewsById.set(previewId, { id: previewId, user_id, digest, payload, created_at, expires_at, approved_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, user_id, digest')) {
      const row = previewsById.get(params[0]); return [[...(row && row.user_id === params[1] ? [row] : [])]];
    }
    if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at')) {
      previewsById.get(params[1]).approved_at = params[0]; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_analysis_preview SET request_id')) {
      const row = previewsById.get(params[1]);
      if (row.request_id) return [{ affectedRows: 0 }];
      row.request_id = params[0]; return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected replay SQL: ${sql}`);
  }) };
  const state = { config: { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://fixture.invalid',
    model: 'offline-quality-replay', apiKey: 'fixture-only', dailyProviderLimit: 100 }, connectionId: id(),
    businessPolicy: { enabled: true, domains: ['finance', 'card', 'account', 'todo'], actions: ['transaction.create', 'todo.create'] } };
  state.conversationStore = {
    open: jest.fn(async () => ({ id: conversationId, history, latestDraftId: state.latestDraftId || null })),
    session: jest.fn(async () => ({ id: conversationId })),
    loadQueryContext: jest.fn(async () => state.queryContext || history.findLast(turn => turn.queryContext)?.queryContext || null),
    loadTaskContext: jest.fn(async () => state.taskContext || history.findLast(turn => turn.taskContext)?.taskContext || null),
    loadPendingTransactionContext: jest.fn(async () => state.pendingContext || null),
    append: jest.fn(async (_, __, payload) => {
      if (payload.message) history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: date });
      history.push({ role: 'assistant', content: payload.answer, turnId: payload.requestId,
        ...(payload.queryContext ? { queryContext: payload.queryContext } : {}),
        ...(payload.taskContext ? { taskContext: payload.taskContext } : {}), business: payload.business });
      if (payload.taskContext) state.taskContext = payload.taskContext;
      if (payload.business?.pendingTransactions) state.pendingContext = payload.business.pendingTransactions;
    }),
    appendFailure: jest.fn(async (_, __, payload) => {
      history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: date },
        { role: 'assistant', content: payload.notice, turnId: payload.requestId, failure: { code: payload.errorCode } });
    }),
  };
  state.requestGuard = { run: jest.fn(async (_, request, work) => {
    const budget = { requestId: request.requestId, calls: 0, check: jest.fn(), tool: jest.fn(), invoke: async invoke => {
      if (++budget.calls > request.maxProviderCalls) throw new Error('Replay provider budget exceeded');
      return invoke();
    } };
    return work(budget);
  }), saveV3Recovery: jest.fn() };
  const raw = { scope: { domains: [], startDate: '2026-11-01', endDate: date }, asOf: now().toISOString(),
    choices: { cards: [{ id: 'fixture-ag-debit', name: '农业银行 7476', type: 'debit', bankName: '农业银行', cardType: 'debit', tail: '7476' },
      { id: 'fixture-ag-credit', name: '农业银行 6838', type: 'credit', bankName: '农业银行', cardType: 'credit', tail: '6838' },
      { id: 'fixture-other-debit', name: '示例银行 2222', type: 'debit', bankName: '示例银行', cardType: 'debit', tail: '2222' }],
    categories: [{ id: 'fixture-category', name: '餐饮', type: 'expense' }], todos: [], funds: [], fixedAssets: [], moods: [] },
    datasets: [] };
  const repository = { query: jest.fn(async (_, scope) => ({ ...raw, scope })) };
  const provider = jest.fn(async (...args) => {
    const response = scripted[provider.mock.calls.length - 1];
    if (!response) throw new Error('Unscripted provider round in offline replay');
    return typeof response === 'function' ? response(...args) : structuredClone(response);
  });
  const legacy = { getRuntime: () => state, getDraft: jest.fn(async () => null),
    prepareTransactionProposal: jest.fn(async (_, fields, metadata) => ({ preparedDraft: { ...fields, ...metadata } })),
    persistTransactionBatch: jest.fn(async (_, items, options) => {
      const artifacts = items.map(item => ({ draft: { id: id(), ...item.preparedDraft, status: 'pending', version: 1 } }));
      const built = options.buildResult(artifacts); await options.assertAuthorization(conn);
      await state.conversationStore.append('fixture-owner', conversationId, built.appendPayload, conn);
      await state.requestGuard.saveV3Recovery(conn, 'fixture-owner', options.budget.requestId, built.result);
      return built.result;
    }) };
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor, repository,
    previews: createPreviewStore({ executor, now: () => now().getTime() }), provider,
    proposals: { create: jest.fn(() => { throw new Error('Unexpected business proposal in quality replay'); }) },
    grants: { requireCoverage: jest.fn(async () => {}) }, callLog: { record: entry => audits.push(entry) }, now });
  const send = message => service.chat('fixture-owner', { requestId: id(), message, conversationId, consent: true });
  return { send, service, state, history, repository, provider, raw, legacy, audits, conversationId };
}

function transaction(messages, { amount = '8.50', quote = '8.5', remark = '午餐', accountName = null } = {}) {
  const tool = JSON.parse(messages.findLast(message => message.role === 'tool').content);
  const input = taskInput(messages);
  const sourceTurn = input.userTurns.findIndex(text => text.includes(quote));
  const account = accountName ? tool.choices.cards.find(row => row.name === accountName) : tool.choices.cards[0];
  return final({ answer: '请核对这笔餐饮草稿。', proposal: { kind: 'transaction.create',
    fields: { direction: 0, amount, currency: 'CNY', transDate: date, accountRef: account.ref,
      categoryRef: tool.choices.categories[0].ref, payMethod: '银行卡', remark }, evidence: { sourceTurn, quote } } });
}

afterEach(() => {
  expect(deepseekChat).not.toHaveBeenCalled();
  expect(publicDb.execute).not.toHaveBeenCalled();
  expect(publicDb.getConnection).not.toHaveBeenCalled();
});

test('real card-count correction preserves the requested pie and its complete two-type denominator', async () => {
  const f = fixture([calls('query_data', recorded.initialQuery), (_, messages) => {
    const feedback = JSON.parse(messages.findLast(message => message.role === 'tool').content);
    expect(feedback).toMatchObject({ status: 'error', retryAllowed: true });
    expect(feedback.issues).toContainEqual({ path: 'datasetId', rule: 'dataset.intent.required', allowedValues: ['card-counts'] });
    expect(f.repository.query).not.toHaveBeenCalled();
    return calls('query_data', { datasetId: 'card-counts' });
  }, final(recorded.output)]);
  const priorId = id();
  f.history.push({ role: 'user', content: recorded.priorMessage, turnId: priorId, sourceDate: date },
    { role: 'assistant', content: recorded.priorAnswer, turnId: priorId });
  f.state.taskContext = { version: 1, mode: 'query', subject: 'cards', metric: 'card-consumption',
    cardTypes: ['debit', 'credit'], chartRequest: { type: 'pie', metric: 'amount' }, status: 'succeeded', turnId: priorId };
  f.raw.datasets = [{ datasetId: 'card-counts', domain: 'card', title: '本人卡片数量',
    columns: [{ key: 'type', label: '类型', type: 'text' }, { key: 'count', label: '数量', type: 'number' }],
    rows: structuredClone(recorded.rows), summary: {}, totalCount: 4, truncated: false,
    asOf: now().toISOString(), policy: '按本人未删除卡片类型统计全部数量。' }];

  const result = await f.send(recorded.message);
  firstQualityResult = result;
  expect(taskInput(f.provider.mock.calls[0][1]).taskContext).toMatchObject({ mode: 'query', subject: 'cards',
    metric: 'card-count', cardTypes: expect.arrayContaining(['debit', 'credit']), chartRequest: { type: 'pie', metric: 'count' } });
  expect(result.chart).toMatchObject({ datasetId: 'card-counts', type: 'pie', xKey: 'type', yKeys: ['count'] });
  const chartDataset = result.datasets.find(dataset => dataset.datasetId === result.chart.datasetId);
  expect(chartDataset.rows.map(({ type, count, sharePct }) => ({ type, count, sharePct }))).toEqual([
    { type: '信用卡', count: 20, sharePct: '25.3' }, { type: '借记卡', count: 59, sharePct: '74.7' },
  ]);
  expect(result.answer).toMatch(/79\s*张/);
  expect(result.answer).toMatch(/74\.7\s*%/);
  expect(result.answer).toMatch(/25\.3\s*%/);
  expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
  const facts = JSON.parse(f.provider.mock.calls[2][1].findLast(message => message.role === 'tool').content).datasets[0];
  expect(facts.datasetId).toBe('card-counts');
  expect(facts.summary.totalCount).toBe(79);
  expect(facts.rows.map(row => row.sharePct)).toEqual(['25.3', '74.7']);
  expect(facts.rows).toHaveLength(2);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});

test('an explicit bank and card type uniquely resolves an account among mixed candidates', async () => {
  const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) => transaction(messages)]);
  const result = await f.send('今天午餐花了8.5元，农业银行借记卡付的');
  expect(result.draft).toMatchObject({ amount: '8.50', accountId: 'fixture-ag-debit' });
  expect(f.legacy.prepareTransactionProposal).toHaveBeenCalledTimes(1);
  expect(taskInput(f.provider.mock.calls[0][1]).taskContext).toMatchObject({ mode: 'record' });
});

test('a provider returning one of three pending transactions cannot clear or persist that batch', async () => {
  const original = '午餐8.50元，买菜20.40元，日用品123.60元';
  const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) =>
    transaction(messages, { quote: '午餐8.50元', amount: '8.50' })]);
  const sourceId = id();
  f.history.push({ role: 'user', content: original, turnId: sourceId, sourceDate: date },
    { role: 'assistant', content: '已保留3笔，请补充账户。', turnId: sourceId });
  f.state.pendingContext = buildPendingTransactionContext({ conversationId: f.conversationId, turnId: sourceId,
    now: now().getTime(), userTurns: [original], userTurnDates: [date], userTurnIds: [sourceId],
    transactions: [['8.50', '午餐8.50元'], ['20.40', '买菜20.40元'], ['123.60', '日用品123.60元']].map(([amount, quote]) => ({
      fields: { direction: 0, amount, currency: 'CNY', transDate: date, payMethod: '银行卡', remark: quote },
      evidence: { sourceTurn: 0, quote }, missingFields: ['账户'] })) });
  const result = await f.send('农业银行 7476');
  expect(result.draft).toBeUndefined();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(f.state.pendingContext.status).toBe('awaiting_input');
  expect(f.state.pendingContext.items).toHaveLength(3);
  expect(f.state.pendingContext.items.map(item => item.fields.amount)).toEqual(['8.50', '20.40', '123.60']);
  expect(taskInput(f.provider.mock.calls[0][1]).taskContext).toMatchObject({ mode: 'pending-supplement' });
});

test('a verified committed draft status reaches provider context and prevents duplicate creation', async () => {
  const original = '今天午餐花了8.5元，农业银行 7476付的';
  const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) => transaction(messages)]);
  const sourceId = id();
  f.history.push({ role: 'user', content: original, turnId: sourceId, sourceDate: date },
    { role: 'assistant', content: '草稿已生成，请核对。', turnId: sourceId });
  f.state.latestDraftId = id();
  f.legacy.getDraft.mockResolvedValue({ id: f.state.latestDraftId, conversationId: f.conversationId,
    originalText: original, status: 'committed' });
  const result = await f.send('再核对一下这笔');
  expect(result.answer).toContain('已经有入账回执');
  expect(result.draft).toBeUndefined();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  const actualInput = taskInput(f.provider.mock.calls[0][1]);
  expect(actualInput.actualDrafts).toEqual([{ status: 'committed', sourceText: original }]);
  expect(actualInput.hasPriorDraft).toBe(false);
  expect(JSON.stringify(actualInput)).not.toContain(f.state.latestDraftId);
});

test('proposal:null with a normal missing-account clarification preserves validated original intent', async () => {
  const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) => {
    const output = JSON.parse(transaction(messages).content);
    output.proposal.fields.accountRef = null;
    return final({ answer: '请补充支付账户。', proposal: null, clarification: { items: [output.proposal] } });
  }]);
  const original = '今天午餐花了8.5元';
  const result = await f.send(original);
  expect(result.draft).toBeUndefined();
  expect(result.inputCandidate).toBeUndefined();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(f.state.pendingContext).toMatchObject({ status: 'awaiting_input', sources: [{ text: original, sourceDate: date }],
    items: [{ fields: { amount: '8.50', transDate: date }, missingFields: ['账户'], evidence: { sourceTurn: 0, quote: '8.5' } }] });
});

test('a fabricated amount in a non-executing clarification still fails the original amount evidence gate', async () => {
  const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) => {
    const output = JSON.parse(transaction(messages, { amount: '85.00' }).content);
    output.proposal.fields.accountRef = null;
    return final({ answer: '请补充支付账户。', proposal: null, clarification: { items: [output.proposal] } });
  }]);
  await expect(f.send('今天午餐花了8.5元')).rejects.toMatchObject({ code: 'AI_AMOUNT_NOT_EXPLICIT' });
  expect(f.state.pendingContext).toBeUndefined();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

test.each([['农业银行 7476', false], ['农业银行 6838', true]])
  ('a later debit-to-credit correction controls the selected account: %s', async (accountName, accepted) => {
    const original = '今天午餐花了8.5元，农业银行借记卡付的';
    const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) => transaction(messages, { accountName })]);
    const sourceId = id();
    f.history.push({ role: 'user', content: original, turnId: sourceId, sourceDate: date },
      { role: 'assistant', content: '已保留午餐8.50元，请确认账户。', turnId: sourceId });
    f.state.pendingContext = buildPendingTransactionContext({ conversationId: f.conversationId, turnId: sourceId,
      now: now().getTime(), userTurns: [original], userTurnDates: [date], userTurnIds: [sourceId],
      transactions: [{ fields: { direction: 0, amount: '8.50', currency: 'CNY', transDate: date,
        payMethod: '银行卡', remark: '午餐' }, evidence: { sourceTurn: 0, quote: '8.5' }, missingFields: ['账户'] }] });
    const result = await f.send('不是借记卡，是信用卡');
    const input = taskInput(f.provider.mock.calls[0][1]);
    expect(input.activeQuery).toBeNull();
    expect(input.taskContext).toMatchObject({ mode: 'pending-supplement' });
    expect(input.pendingTransactions.items[0].evidence).toMatchObject({ sourceTurn: 0, quote: '8.5' });
    if (accepted) {
      expect(result.draft).toMatchObject({ amount: '8.50', transDate: date, accountId: 'fixture-ag-credit', status: 'pending' });
      expect(f.legacy.prepareTransactionProposal).toHaveBeenCalledTimes(1);
      expect(f.legacy.persistTransactionBatch).toHaveBeenCalledTimes(1);
      expect(f.state.pendingContext.status).toBe('cleared');
    } else {
      expect(result.draft).toBeUndefined();
      expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
      expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
      expect(f.state.pendingContext).toMatchObject({ status: 'awaiting_input',
        items: [{ fields: { amount: '8.50', transDate: date }, missingFields: ['账户'] }] });
      expect(f.state.pendingContext.items[0].fields.accountId).toBeUndefined();
    }
  });
test('a spoken bank-name correction continues a pending missing-account transaction', async () => {
  const clarify = (_, messages) => {
    const output = JSON.parse(transaction(messages, { amount: '8300', quote: '8300', remark: '收入' }).content);
    output.proposal.fields.direction = 1;
    output.proposal.fields.accountRef = null;
    return final({ answer: '请补充账户，我再给你完整草稿。', proposal: null, clarification: { items: [output.proposal] } });
  };
  const propose = (_, messages) => {
    const output = JSON.parse(transaction(messages, { amount: '8300', quote: '8300', remark: '收入', accountName: '招商银行 8888' }).content);
    output.proposal.fields.direction = 1;
    return final({ answer: '请核对这笔收入草稿。', proposal: output.proposal });
  };
  const f = fixture([calls('list_choices', { domain: 'finance' }), clarify, clarify,
    calls('list_choices', { domain: 'finance' }), propose]);
  f.raw.choices.cards = [{ id: 'fixture-cmb-credit', name: '招商银行 8888', type: 'credit', bankName: '招商银行', cardType: 'credit', tail: '8888' }];
  const first = await f.send('今天收入 8300 元进工商银行卡。');
  expect(first.draft).toBeUndefined();
  expect(f.state.pendingContext).toMatchObject({ status: 'awaiting_input',
    items: [{ fields: { amount: '8300', direction: 1 }, missingFields: ['账户'] }] });
  const second = await f.send('招商银行 说错了');
  expect(taskInput(f.provider.mock.calls[3][1]).taskContext).toMatchObject({ mode: 'pending-supplement', subject: 'finance' });
  expect(second.draft).toMatchObject({ amount: '8300', direction: 1, accountId: 'fixture-cmb-credit', status: 'pending' });
  expect(f.legacy.prepareTransactionProposal).toHaveBeenCalledTimes(1);
  expect(f.legacy.persistTransactionBatch).toHaveBeenCalledTimes(1);
  expect(f.state.pendingContext.status).toBe('cleared');
});

test('a spoken bank-name correction keeps the pending batch awaiting input when the bank alone is ambiguous', async () => {
  const clarify = (_, messages) => {
    const output = JSON.parse(transaction(messages, { amount: '8300', quote: '8300', remark: '收入' }).content);
    output.proposal.fields.direction = 1;
    output.proposal.fields.accountRef = null;
    return final({ answer: '请补充账户，我再给你完整草稿。', proposal: null, clarification: { items: [output.proposal] } });
  };
  const propose = (_, messages) => {
    const output = JSON.parse(transaction(messages, { amount: '8300', quote: '8300', remark: '收入', accountName: '招商银行 8888' }).content);
    output.proposal.fields.direction = 1;
    return final({ answer: '请核对这笔收入草稿。', proposal: output.proposal });
  };
  const f = fixture([calls('list_choices', { domain: 'finance' }), clarify, clarify,
    calls('list_choices', { domain: 'finance' }), propose]);
  f.raw.choices.cards.push({ id: 'fixture-cmb-credit', name: '招商银行 8888', type: 'credit', bankName: '招商银行', cardType: 'credit', tail: '8888' });
  await f.send('今天收入 8300 元进工商银行卡。');
  const second = await f.send('招商银行 说错了');
  expect(second.draft).toBeUndefined();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.state.pendingContext).toMatchObject({ status: 'awaiting_input', supplementSources: [{ text: '招商银行 说错了' }],
    items: [{ fields: { amount: '8300' }, missingFields: ['账户'] }] });
});

test('a global correction without an account word stays outside the pending supplement', async () => {
  const f = fixture([calls('list_choices', { domain: 'finance' }), (_, messages) => transaction(messages)]);
  const sourceId = id();
  f.history.push({ role: 'user', content: '今天午餐花了8.5元', turnId: sourceId, sourceDate: date },
    { role: 'assistant', content: '已保留午餐8.50元，请确认账户。', turnId: sourceId });
  f.state.pendingContext = buildPendingTransactionContext({ conversationId: f.conversationId, turnId: sourceId,
    now: now().getTime(), userTurns: ['今天午餐花了8.5元'], userTurnDates: [date], userTurnIds: [sourceId],
    transactions: [{ fields: { direction: 0, amount: '8.50', currency: 'CNY', transDate: date,
      payMethod: '银行卡', remark: '午餐' }, evidence: { sourceTurn: 0, quote: '8.5' }, missingFields: ['账户'] }] });
  await expect(f.send('这笔记错了')).rejects.toMatchObject({ code: 'AI_ACTION_NOT_ALLOWED' });
  expect(taskInput(f.provider.mock.calls[0][1]).taskContext.mode).not.toBe('pending-supplement');
});
