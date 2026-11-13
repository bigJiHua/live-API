const crypto = require('crypto');

// A replay must never fall back to a paid provider or a real database connection.
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden in recorded-response replay'); }),
}));
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live database forbidden in recorded-response replay'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden in recorded-response replay'); }),
}));

const recorded = require('../helpers/aiAmountFailureRecorded.json');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const liveDb = require('../../src/common/config/db');

const id = () => crypto.randomUUID();
const now = () => new Date('2026-11-08T12:54:06.173Z');
const json = value => ({ role: 'assistant', content: JSON.stringify(value) });
const choicesCall = () => structuredClone(recorded.packets[0]);
const replayEvidence = [];
function captureReplay(label, result) {
  replayEvidence.push({ label, answer: result.answer, drafts: (result.drafts || (result.draft ? [result.draft] : [])).map(draft => ({
    amount: draft.amount, currency: draft.currency, transDate: draft.transDate, accountId: draft.accountId,
    categoryId: draft.categoryId, remark: draft.remark, status: draft.status,
  })) });
}

function replaceRecordedRefs(packet, messages) {
  const choiceResult = messages.findLast(message => message.role === 'tool');
  const choices = choiceResult ? JSON.parse(choiceResult.content).choices : {};
  const map = {
    'fixture-category-grocery': choices.categories?.find(row => row.name === '买菜')?.ref,
    'fixture-category-household': choices.categories?.find(row => row.name === '生活类支出')?.ref,
    'fixture-category-dining': choices.categories?.find(row => row.name === '餐饮')?.ref,
    'fixture-category-shopping': choices.categories?.find(row => row.name === '购物')?.ref,
    'fixture-card-7476': choices.cards?.find(row => row.name === '农业银行 7476')?.ref,
  };
  const value = structuredClone(packet);
  if (value.content) for (const [placeholder, ref] of Object.entries(map)) {
    if (ref) value.content = value.content.split(placeholder).join(ref);
  }
  return value;
}

function fixture(packets = recorded.packets) {
  const history = recorded.userTurns.slice(0, -1).flatMap((content, index) => [
    { role: 'user', content, turnId: `prior-${index}`, sourceDate: recorded.sourceDate },
    { role: 'assistant', content: index ? '现在是2026年11月，今天是11月8日。' : '晚上好。', turnId: `prior-${index}` },
  ]);
  const previewsById = new Map();
  const conversationId = id();
  const conn = { beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}),
    release: jest.fn(), execute: jest.fn(async () => [{ affectedRows: 1 }]) };
  const executor = { getConnection: jest.fn(async () => conn), execute: jest.fn(async (sql, params) => {
    if (sql.startsWith("UPDATE ai_analysis_preview SET payload = 'expired'")) return [{ affectedRows: 0 }];
    if (sql.startsWith('INSERT INTO ai_analysis_preview')) {
      const [previewId, user_id, digest, payload, created_at, expires_at] = params;
      previewsById.set(previewId, { id: previewId, user_id, digest, payload, created_at, expires_at, approved_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, user_id, digest')) {
      const row = previewsById.get(params[0]);
      return [[...(row && row.user_id === params[1] ? [row] : [])]];
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
  const state = { config: { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://offline.invalid',
    model: 'recorded-response', apiKey: 'offline-unused', dailyProviderLimit: 100 }, connectionId: id(),
    businessPolicy: { enabled: true, domains: ['finance'], actions: ['transaction.create'] },
    conversationStore: {
      open: jest.fn(async () => ({ id: conversationId, history, latestDraftId: null })),
      session: jest.fn(async () => ({ id: conversationId })),
      loadQueryContext: jest.fn(async () => null),
      loadPendingTransactionContext: jest.fn(async () => history.findLast(turn => turn.business?.pendingTransactions)?.business.pendingTransactions || null),
      append: jest.fn(async (_, __, payload) => {
        history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: recorded.sourceDate });
        history.push({ role: 'assistant', content: payload.answer, turnId: payload.requestId, business: payload.business,
          ...(payload.queryContext ? { queryContext: payload.queryContext } : {}),
          ...(payload.transactionContext ? { transactionContext: payload.transactionContext } : {}) });
      }),
      appendFailure: jest.fn(async (_, __, payload) => {
        history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: recorded.sourceDate },
          { role: 'assistant', content: payload.notice, turnId: payload.requestId, failure: { code: payload.errorCode } });
      }),
    },
    requestGuard: { run: jest.fn(async (_, request, work) => {
      const budget = { requestId: request.requestId, calls: 0, check: jest.fn(), tool: jest.fn(),
        invoke: async fn => { if (budget.calls++ >= request.maxProviderCalls) throw new Error('Replay budget exhausted'); return fn(); } };
      return work(budget);
    }), saveV3Recovery: jest.fn() },
  };
  const repository = { query: jest.fn(async (_, scope) => ({ scope, datasets: [], asOf: now().toISOString(),
    choices: { cards: recorded.cards, categories: recorded.categories, todos: [], funds: [], fixedAssets: [], moods: [] } })) };
  const previews = createPreviewStore({ executor, now: () => now().getTime() });
  let queue = [...packets];
  const provider = jest.fn(async (_, messages) => {
    if (!queue.length) throw new Error('Recorded provider response queue exhausted');
    const packet = queue.shift();
    return typeof packet === 'function' ? packet(messages) : replaceRecordedRefs(packet, messages);
  });
  const legacy = { getRuntime: () => state,
    prepareTransactionProposal: jest.fn(async (_, fields, metadata) => ({ preparedDraft: { ...fields, ...metadata } })),
    persistTransactionBatch: jest.fn(async (_, items, options) => {
      const artifacts = items.map(item => ({ draft: { id: id(), ...item.preparedDraft, status: 'pending', version: 1 } }));
      const built = options.buildResult(artifacts);
      await options.assertAuthorization(conn);
      await state.conversationStore.append('offline-owner', conversationId, built.appendPayload, conn);
      await state.requestGuard.saveV3Recovery(conn, 'offline-owner', options.budget.requestId, built.result);
      return built.result;
    }),
    commitDraft: jest.fn(() => { throw new Error('Commit forbidden during replay'); }),
  };
  const proposals = { create: jest.fn(() => { throw new Error('Business proposal forbidden during transaction replay'); }) };
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor, repository, previews, proposals,
    provider, grants: { requireCoverage: jest.fn() }, callLog: { record: jest.fn() }, now });
  const send = (message = recorded.userTurns.at(-1)) => service.chat('offline-owner', { requestId: id(), message, conversationId, consent: true });
  return { send, state, history, provider, repository, legacy, proposals, conn,
    setPackets: packetsToReplay => { queue = [...packetsToReplay]; } };
}

afterEach(() => {
  expect(deepseekChat).not.toHaveBeenCalled();
  expect(liveDb.execute).not.toHaveBeenCalled();
  expect(liveDb.getConnection).not.toHaveBeenCalled();
});
afterAll(() => {
  // Optional local acceptance evidence; normal test runs perform no file writes.
  if (process.env.AI_AMOUNT_REPLAY_EVIDENCE_FILE) require('fs').writeFileSync(process.env.AI_AMOUNT_REPLAY_EVIDENCE_FILE,
    JSON.stringify({ realProviderCalls: 0, realDatabaseCalls: 0, mode: 'recorded-response offline replay', results: replayEvidence }, null, 2) + '\n');
});

test('the recorded final packet really omits evidence while the intermediate packet included it', () => {
  const final = JSON.parse(recorded.packets[2].content);
  expect(final.proposals.map(item => item.fields.amount)).toEqual(['30.82', '20.40', '123.60']);
  expect(final.proposals.every(item => !Object.hasOwn(item, 'evidence'))).toBe(true);
  expect(final.proposals.every(item => item.fields.accountRef === null)).toBe(true);
  expect(recorded.packets[1].content).toContain('"evidence":{"sourceTurn":2');
});

test('the actual failed three-round response becomes one account question without fabricated drafts', async () => {
  const f = fixture();
  const result = await f.send();
  captureReplay('Original recorded three-transaction final response', result);
  expect(result.answer).toContain('账户');
  expect(result.answer).not.toMatch(/都记好了草稿|确认入库|已记录/);
  expect(result.draft).toBeUndefined();
  expect(result.drafts).toBeUndefined();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(f.legacy.commitDraft).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.history.at(-1).business.pendingTransactions).toMatchObject({ status: 'awaiting_input',
    sources: [{ text: recorded.userTurns.at(-1), sourceDate: recorded.sourceDate }] });
  expect(f.history.at(-1).business.pendingTransactions.items).toHaveLength(3);
  expect(f.history.at(-1).business.pendingTransactions.items.map(item => item.fields.amount)).toEqual(['30.82', '20.40', '123.60']);
  const finalMessages = f.provider.mock.calls[2][1];
  expect(finalMessages.some(message => message.content?.includes('您说的是储蓄卡付款'))).toBe(false);
  expect(f.history.at(-2).content).toBe(recorded.userTurns.at(-1));
});

test.each(['都是农业银行 7476 那张借记卡付的', '7476', '7476那张'])(
  'the account reply "%s" continues all three original amounts and dates into pending review cards', async accountReply => {
  const f = fixture();
  await f.send();
  const reply = messages => {
    const task = JSON.parse(messages.find(message => message.content?.startsWith('TASK_INPUT:\n')).content.slice('TASK_INPUT:\n'.length));
    const sourceTurn = task.userTurns.indexOf(recorded.userTurns.at(-1));
    expect(sourceTurn).toBeGreaterThanOrEqual(0);
    expect(task.pendingTransactions).toMatchObject({ status: 'awaiting_input', transactionCount: 3 });
    expect(task.pendingTransactions.items).toHaveLength(3);
    expect(task.pendingTransactions.items.map(item => item.amount)).toEqual(['30.82', '20.40', '123.60']);
    expect(task.pendingTransactions.items.every(item => item.evidence.sourceTurn === sourceTurn)).toBe(true);
    const choices = JSON.parse(messages.findLast(message => message.role === 'tool').content).choices;
    const accountRef = choices.cards.find(row => row.name === '农业银行 7476').ref;
    const proposals = JSON.parse(recorded.packets[2].content).proposals.map((item, index) => ({ ...item,
      fields: { ...item.fields, accountRef,
        categoryRef: choices.categories.find(row => row.name === (index === 2 ? '生活类支出' : '买菜')).ref },
      evidence: { sourceTurn, quote: [
        '今晚买菜花了 30 块 8 毛 2', '买鸭肉花了 20 块 4 毛', '去了趟超市 买了点生活物品 花了 123 块 6',
      ][index] },
    }));
    return json({ answer: '三笔支出已整理为草稿，请核对卡片。', proposals, chart: null });
  };
  f.setPackets([choicesCall(), reply, reply]);
  const result = await f.send(accountReply);
  captureReplay(`Offline account clarification: ${accountReply}`, result);
  expect(result.drafts).toHaveLength(3);
  expect(result.drafts.map(draft => draft.amount)).toEqual(['30.82', '20.40', '123.60']);
  expect(result.drafts.every(draft => draft.transDate === '2026-11-08' && draft.accountId === 'offline-card-7476' && draft.status === 'pending')).toBe(true);
  expect(f.legacy.prepareTransactionProposal).toHaveBeenCalledTimes(3);
  expect(f.legacy.persistTransactionBatch).toHaveBeenCalledTimes(1);
  expect(f.legacy.commitDraft).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.history.at(-1).business.pendingTransactions.status).toBe('cleared');
});

test('missing evidence cannot recover a made-up amount from untrusted intermediate assistant text', async () => {
  const packets = structuredClone(recorded.packets);
  packets[1].content = '买菜支出999.99元；这个中间assistant句子不能充当用户原话。';
  const output = JSON.parse(packets[2].content);
  output.proposals[0].fields.amount = '999.99';
  packets[2] = json(output);
  const f = fixture(packets);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_AMOUNT_NOT_EXPLICIT' });
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
