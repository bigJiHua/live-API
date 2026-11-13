/** Independent review: all evidence is explicit in-memory infrastructure; never opens MySQL or a provider. */
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('MySQL forbidden'); }) }));
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const { AiError } = require('../../src/modules/ai/service/errors');
const { createAiRouter } = require('../../src/modules/ai/api');
const { createFinancialWorkflow } = require('../../src/modules/ai/service/financialWorkflow');
const { createTestService, testEnv, createMemoryDraftStore, createMemoryRequestGuard,
  createMemoryConversationStore, createMemoryWriteDb, createMemoryCandidateStore,
  createMemoryFinancialRepository } = require('../helpers/aiFixture');
const fields = { amount: '39.91', direction: 0, currency: 'CNY', transDate: '2026-11-05', accountId: 'fixture_balance',
  categoryId: 'fixture_food', payMethod: '微信', remark: '午饭' };
const local = (service, extra = {}) => service.createLocalTransactionDraft('owner', { requestId: crypto.randomUUID(), fields, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(extraEnv = {}) {
  const env = testEnv({ AI_BUSINESS_ENABLED: 'true', AI_BUSINESS_DOMAINS: 'finance', AI_BUSINESS_ACTIONS: 'transaction.create', ...extraEnv });
  const draftStore = createMemoryDraftStore(); draftStore.save = jest.fn(draftStore.save.bind(draftStore));
  const conversationStore = createMemoryConversationStore();
  const provider = jest.fn(() => { throw new Error('Local review must not call a provider'); });
  const candidateStore = createMemoryCandidateStore({ now: () => new Date('2026-11-05T08:00:00Z') });
  const service = createTestService({ env, draftStore, conversationStore, candidateStore, chat: provider });
  const saveCandidate = createFinancialWorkflow({ candidateStore }).candidate;
  return { env, service, draftStore, conversationStore, provider, saveCandidate };
}
afterEach(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
});

test.each([{ AI_MODE: 'disabled' }, { AI_BUSINESS_ENABLED: 'false' }, { AI_BUSINESS_DOMAINS: 'todo' }, { AI_BUSINESS_ACTIONS: 'todo.create' }])(
  'closed mode/domain/action cannot create a new local transaction draft: %j', async env => {
    const f = fixture(env);
    await expect(local(f.service)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(f.draftStore.save).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });

test.each(['记账还款39.91元', '记账美元支出39.91元'])('an originally rejected special/currency source cannot be laundered through a candidate: %s', async message => {
  const f = fixture(), checked = await f.service.financialPreflight('owner', { message });
  expect(checked.financialCheck.status).toBe('block');
  const conversation = await f.conversationStore.open('owner');
  const candidate = await f.saveCandidate('owner', checked, { source: 'user-readonly', message, conversationId: conversation.id });
  await expect(local(f.service, { sourceCandidateId: candidate.id })).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED' });
  expect(f.draftStore.save).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
});

test.each(['记账还款39.91元','记账美元支出39.91元'])('new local structured fields cannot hide a forbidden accompanying message: %s',async message=>{
  const f=fixture();
  const checked=await f.service.financialPreflight('owner',{message,fields});
  expect(checked.financialCheck.status).toBe('block');
  await expect(local(f.service,{message})).rejects.toMatchObject({code:'AI_FINANCIAL_CHECK_BLOCKED'});
  expect(f.draftStore.save).not.toHaveBeenCalled();expect(f.provider).not.toHaveBeenCalled();
});

test('consumed candidate ignores new request fields and returns the same existing draft without writing a second one', async () => {
  const f = fixture(), checked = await f.service.financialPreflight('owner', { fields: { ...fields, accountId: null } });
  const conversation = await f.conversationStore.open('owner');
  const candidate = await f.saveCandidate('owner', checked, { source: 'user-readonly', message: '支出39.91元', conversationId: conversation.id });
  const first = await local(f.service, { sourceCandidateId: candidate.id });
  const replay = await local(f.service, { sourceCandidateId: candidate.id, fields: { ...fields, amount: '99999', direction: 1,
    accountId: 'fixture_cash', categoryId: 'fixture_salary', remark: '尝试改动已消费候选' } });
  expect(replay.draft).toMatchObject({ id: first.draft.id, amount: '39.91', direction: 0, accountId: 'fixture_balance' });
  expect(f.draftStore.save).toHaveBeenCalledTimes(1); expect(replay.request.providerCalls).toBe(0);
});
test.each(['借款', '贷款', '证券买卖', '正式折旧', '精密重算', 'withdrawal'])('structured local remark %s cannot bypass the central special-accounting rule', async remark => {
  const f = fixture();
  await expect(local(f.service, { fields: { ...fields, remark } })).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED' });
  expect(f.draftStore.save).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
});

test.each(['business-chat', 'ocr'])('paid lane %s rejects an accidental multi-call budget at the guard boundary', async lane => {
  const guard = createMemoryRequestGuard(), work = jest.fn(async budget => budget.invoke(async () => ({ ok: true })));
  await expect(guard.run('owner', { requestId: crypto.randomUUID(), lane, input: {}, maxProviderCalls: 4 }, work))
    .rejects.toMatchObject({ code: 'AI_REQUEST_INVALID' });
  expect(work).not.toHaveBeenCalled();
});

test('turning off the business switch blocks new local HTTP drafts while keeping an existing receipt readable', async () => {
  const f = fixture(), requestId = crypto.randomUUID();
  const first = await local(f.service, { requestId });
  f.env.AI_BUSINESS_ENABLED = 'false';
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ service: f.service, env: f.env, guard: (req, _res, next) => { req.userId = 'owner'; next(); } }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/ai`;
    const blocked = await fetch(base + '/v3/transaction/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { fields, requestId: crypto.randomUUID() } }) });
    expect(blocked.status).toBe(503);
    const receipt = await fetch(base + '/v3/requests/' + requestId);
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).data.result.draft.id).toBe(first.draft.id);
    expect(f.draftStore.save).toHaveBeenCalledTimes(1);
  } finally { await new Promise(resolve => server.close(resolve)); await f.service.close(); }
});

test('a local draft committed before history failure is recovered by the same request without another draft or provider call', async () => {
  const conversationStore = createMemoryConversationStore();
  conversationStore.append = jest.fn(async () => { throw new Error('History connection lost after local commit'); });
  const draftStore = createMemoryDraftStore(); draftStore.save = jest.fn(draftStore.save.bind(draftStore));
  const provider = jest.fn(() => { throw new Error('Local recovery must not use provider'); });
  const service = createTestService({ draftStore, conversationStore, chat: provider }), requestId = crypto.randomUUID();
  await expect(local(service, { requestId })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
  const saved = await draftStore.save.mock.results[0].value;
  const receipt = await service.getRequestReceipt('owner', requestId);
  expect(receipt).toMatchObject({ status: 'completed', guardStatus: 'failed', recoveredFromLocalTransaction: true,
    providerCalls: 0, maxProviderCalls: 0, result: { draft: { id: saved.id } } });
  const replay = await local(service, { requestId });
  expect(replay.draft.id).toBe(saved.id); expect(draftStore.save).toHaveBeenCalledTimes(1);
  expect(conversationStore.append).toHaveBeenCalledTimes(1); expect(provider).not.toHaveBeenCalled();
});

test('rolled-back local recovery payload cannot turn a failed zero-budget request into a successful receipt', async () => {
  const guard = createMemoryRequestGuard(), requestId = crypto.randomUUID();
  const writeDb = createMemoryWriteDb({ execute: async () => { throw new Error('Financial SQL forbidden'); } }, guard.fixtureExecutor);
  const request = { requestId, lane: 'local-draft', maxProviderCalls: 0, input: { fields } };
  await expect(guard.run('owner', request, async () => {
    const conn = await writeDb.getConnection();
    try {
      await conn.beginTransaction();
      await guard.saveLocalRecovery(conn, 'owner', requestId, { contractVersion: 2, draft: { id: 'uncommitted-draft' },
        request: { requestId, providerCalls: 0, maxProviderCalls: 0 } });
      await conn.rollback();
      throw new Error('Transaction rolled back');
    } finally { conn.release(); }
  })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
  const receipt = await guard.get('owner', requestId);
  expect(receipt).toMatchObject({ status: 'failed', providerCalls: 0, maxProviderCalls: 0 });
  expect(receipt.result).toBeUndefined(); expect(receipt.recoveredFromLocalTransaction).toBeUndefined();
  const replay = jest.fn(); await expect(guard.run('owner', request, replay)).rejects.toMatchObject({ status: 409 });
  expect(replay).not.toHaveBeenCalled();
});

test.each(['discarded', 'committed', 'expired'])('replayed local POST returns the current %s state instead of its original pending receipt', async terminal => {
  const f = fixture(), requestId = crypto.randomUUID(), first = await local(f.service, { requestId });
  if (terminal === 'discarded') await f.service.actOnDraft('owner', first.draft.id, { version: first.draft.version, action: 'discard' });
  else {
    const get = f.draftStore.get.bind(f.draftStore);
    f.draftStore.get = async (...args) => {
      const draft = await get(...args);
      if (terminal === 'expired') throw new AiError('草稿不存在或已过期', 404);
      return { ...draft, status: 'committed', version: draft.version + 2, committedRecordId: 'existing-record', expiresAt: 0 };
    };
  }
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ service: f.service, env: f.env, guard: (req, _res, next) => { req.userId = 'owner'; next(); } }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/ai/v3/transaction/draft`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { fields, requestId } }) });
    const body = await response.json();
    if (terminal === 'expired') { expect(response.status).toBe(404); expect(body.data).toBeUndefined(); }
    else {
      expect(response.status).toBe(200); expect(body.data.draft).toMatchObject({ id: first.draft.id, status: terminal });
      expect(body.data.draft.version).toBeGreaterThan(first.draft.version);
      if (terminal === 'committed') expect(body.data.draft.committedRecordId).toBe('existing-record');
    }
    expect(f.draftStore.save).toHaveBeenCalledTimes(1); expect(f.provider).not.toHaveBeenCalled();
  } finally { await new Promise(resolve => server.close(resolve)); await f.service.close(); }
});

test.each(['source-read', 'candidate-lock'])('disabling finance while local draft awaits %s stops draft persistence', async stage => {
  const env = testEnv({ AI_BUSINESS_ENABLED: 'true' }), funds = createMemoryFinancialRepository(), candidates = createMemoryCandidateStore();
  const draftStore = createMemoryDraftStore(); draftStore.save = jest.fn(draftStore.save.bind(draftStore));
  const started = deferred(), release = deferred();
  if (stage === 'source-read') {
    const check = funds.check; funds.check = async (...args) => { const result = await check(...args); started.resolve(); await release.promise; return result; };
  } else {
    const get = candidates.get.bind(candidates);
    candidates.get = async (...args) => { const result = await get(...args); if (args[3]?.lock) { started.resolve(); await release.promise; } return result; };
  }
  const provider = jest.fn(() => { throw new Error('Local action must not call provider'); });
  const service = createTestService({ env, financialRepository: funds, candidateStore: candidates, draftStore, chat: provider });
  const pending = local(service);
  await started.promise; env.AI_BUSINESS_ENABLED = 'false'; release.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' });
  expect(draftStore.save).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
});

test('disabling finance while review awaits source data cannot mark the draft reviewed', async () => {
  const env = testEnv({ AI_BUSINESS_ENABLED: 'true' }), funds = createMemoryFinancialRepository(), draftStore = createMemoryDraftStore();
  draftStore.act = jest.fn(draftStore.act.bind(draftStore));
  const service = createTestService({ env, financialRepository: funds, draftStore }), first = await local(service);
  const started = deferred(), release = deferred(), check = funds.check;
  funds.check = async (...args) => { const result = await check(...args); started.resolve(); await release.promise; return result; };
  const pending = service.actOnDraft('owner', first.draft.id, { version: first.draft.version, action: 'review' });
  await started.promise; env.AI_BUSINESS_ENABLED = 'false'; release.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' });
  expect(draftStore.act).not.toHaveBeenCalled(); expect(await draftStore.get('owner', first.draft.id)).toMatchObject({ status: 'pending', version: first.draft.version });
});

test('disabling finance before an OCR model response arrives rejects the late candidate with exactly one recognition', async () => {
  const env = testEnv({ AI_BUSINESS_ENABLED: 'true' }), started = deferred(), release = deferred(), candidates = createMemoryCandidateStore();
  candidates.save = jest.fn(candidates.save.bind(candidates));
  const draftStore = createMemoryDraftStore(); draftStore.save = jest.fn(draftStore.save.bind(draftStore));
  const recognizeImage = jest.fn(async () => { started.resolve(); await release.promise; return { documentType: 'payment', truncated: false, warnings: [],
    items: [{ direction: 0, amount: '10.00', currency: 'CNY', transDate: '2026-11-05', merchant: '停车场', payMethod: '微信', accountHint: null,
      remark: '停车费', categoryHint: '餐饮', confidence: 'high', transactionStatus: 'completed', transactionKind: 'ordinary',
      evidence: { dateText: '2026-11-05', amountText: '10.00元', statusText: '支付成功', kindText: '消费支出' } }] }; });
  const service = createTestService({ env, recognizeImage, candidateStore: candidates, draftStore });
  const image = { dataUrl: 'data:image/png;base64,' + (await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64') };
  const requestId = crypto.randomUUID(), pending = service.runOcr('owner', { image, consent: true, requestId });
  await started.promise; env.AI_BUSINESS_ENABLED = 'false'; release.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED', providerCalls: 1 });
  expect(recognizeImage).toHaveBeenCalledTimes(1); expect(candidates.save).not.toHaveBeenCalled(); expect(draftStore.save).not.toHaveBeenCalled();
  expect(await service.getRequestReceipt('owner', requestId)).toMatchObject({ status: 'failed', providerCalls: 1 });
});
