jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('MySQL forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));

const crypto = require('crypto');
const db = require('../../src/common/config/db');
const provider = require('../../src/modules/ai/service/deepseek');
const { createTestService, createTestRepository, createMemoryCandidateStore, createMemoryConversationStore,
  createMemoryDraftStore, createMemoryFinancialRepository, createMemoryWriteDb, createMemoryRequestGuard } = require('../helpers/aiFixture');
const { buildPendingTransactionContext, readPendingTransactionTask, TTL_MS } = require('../../src/modules/ai/service/pendingTransactions');

test('expired income task resumes through real service preflight, creates one local draft and closes its task', async () => {
  const owner = 'pending-integration-owner', taskId = crypto.randomUUID();
  const createdAt = Date.parse('2026-11-11T05:00:00Z');
  const now = () => new Date(createdAt + TTL_MS + 3600000);
  const original = '今天收入8300元进工商银行卡';
  const conversations = createMemoryConversationStore(), conversation = await conversations.open(owner);
  let marker = buildPendingTransactionContext({ conversationId: conversation.id, turnId: taskId, now: createdAt,
    userTurns: [original], userTurnDates: ['2026-11-11'], userTurnIds: [taskId],
    transactions: [{ fields: { direction: 1, amount: '8300', currency: 'CNY', transDate: '2026-11-11',
      remark: '工资收入', payMethod: '银行卡' }, evidence: { sourceTurn: 0, quote: original }, missingFields: ['账户', '分类'] }] });
  conversations.loadPendingTransactionTask = jest.fn(async (userId, id) => {
    await conversations.open(userId, id);
    return readPendingTransactionTask(marker, { conversationId: id, now });
  });
  const append = conversations.append.bind(conversations);
  conversations.append = jest.fn(async (userId, id, input) => {
    await append(userId, id, input);
    if (input.business?.pendingTransactions) marker = structuredClone(input.business.pendingTransactions);
  });
  const candidates = createMemoryCandidateStore({ now });
  candidates.save = jest.fn(candidates.save.bind(candidates));
  // The shared memory fixture predates explicit recovery; only adapt its new store entry point here.
  candidates.restorePending = async (userId, input) => {
    const prior = await candidates.findByFingerprint(userId, input.sourceFingerprint);
    return prior || candidates.save(userId, input);
  };
  const drafts = createMemoryDraftStore({ now });
  drafts.save = jest.fn(drafts.save.bind(drafts));
  const repository = createTestRepository();
  const account = { id: 'salary_debit', name: '招商工资储蓄卡 1234', type: 'debit' };
  repository.choices = async () => ({ accounts: [account], categories: [{ id: 'salary', name: '工资', type: 'income' }] });
  const funds = createMemoryFinancialRepository({ now, accounts: [{ id: account.id, card_type: 'debit', currency: 'CNY', status: '正常' }], ledger: [] });
  const requestGuard = createMemoryRequestGuard({ clock: () => now().getTime() });
  const evidenceExecutor = { execute: async (input, params) => {
    if (typeof input === 'string' && input.startsWith('SELECT id FROM ai_conversation')) {
      expect(params).toEqual([conversation.id, owner]);
      return [[{ id: conversation.id }]];
    }
    return funds.executor.execute(input, params);
  } };
  const service = createTestService({ now, repository, conversationStore: conversations, candidateStore: candidates,
    draftStore: drafts, financialRepository: funds, requestGuard,
    writeDb: createMemoryWriteDb(evidenceExecutor, requestGuard.fixtureExecutor), callLog: { record: jest.fn() } });

  const displayed = await service.readPendingTransaction(owner, { conversationId: conversation.id });
  expect(displayed.pendingTask).toMatchObject({ taskId, status: 'expired', items: [{ fields: { amount: '8300', transDate: '2026-11-11' } }] });
  const selection = { conversationId: conversation.id, taskId, revision: displayed.pendingTask.revision, itemIndex: 0 };
  const resumed = await service.resumePendingTransaction(owner, selection);
  expect(resumed.choices.accounts).toEqual([account]);
  const sourceCandidateId = resumed.inputCandidate.id;
  const fields = { ...resumed.fields, accountId: account.id, categoryId: 'salary', payMethod: '银行卡' };
  const checked = await service.financialPreflight(owner, { conversationId: conversation.id, sourceCandidateId, fields });
  expect(checked.financialCheck.status).toMatch(/^(?:pass|warn)$/);
  expect(checked.fields).toMatchObject({ amount: '8300', direction: 1, currency: 'CNY', transDate: '2026-11-11', accountId: account.id });
  await expect(service.financialPreflight(owner, { sourceCandidateId, fields: { ...fields, amount: '8301' } }))
    .rejects.toMatchObject({ code: 'AI_CONTINUATION_INPUT_INVALID' });
  const request = { requestId: crypto.randomUUID(), conversationId: conversation.id, sourceCandidateId, fields: checked.fields };
  const receipt = await service.createLocalTransactionDraft(owner, request);
  expect(receipt.request.providerCalls).toBe(0);
  expect(receipt.draft).toMatchObject({ amount: '8300', direction: 1, transDate: '2026-11-11', accountId: account.id,
    originalText: original, sourceCandidateId, status: 'pending' });
  expect(marker).toMatchObject({ taskId, status: 'cleared' });
  expect((await service.readPendingTransaction(owner, { conversationId: conversation.id })).pendingTask).toBeNull();
  await expect(service.resumePendingTransaction(owner, selection)).rejects.toMatchObject({ code: 'AI_PENDING_ENDED' });
  const restored = await service.getTransactionCandidate(owner, sourceCandidateId);
  expect(restored.draft.id).toBe(receipt.draft.id);
  const replay = await service.createLocalTransactionDraft(owner, { ...request, requestId: crypto.randomUUID() });
  expect(replay.draft.id).toBe(receipt.draft.id);
  expect(drafts.save).toHaveBeenCalledTimes(1);
  expect(candidates.save).toHaveBeenCalledTimes(1);
  expect(provider.deepseekChat).not.toHaveBeenCalled();
  expect(db.execute).not.toHaveBeenCalled();
});
