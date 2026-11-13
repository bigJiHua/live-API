jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('MySQL forbidden'); }) }));
const crypto = require('node:crypto');
const { createLegacyBusinessService: createBusinessService } = require('../helpers/legacyBusinessService');
const { AiError } = require('../../src/modules/ai/service/errors');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const { createLegacyTestService: createTestService, createMemoryRequestGuard } = require('../helpers/aiFixture');
const now = () => new Date('2026-11-05T08:00:00Z');

function fixture({ secondChanges = {}, failStage } = {}) {
  let state = { drafts: new Map(), candidates: new Map(), history: [] }, saveCalls = 0;
  const requestGuard = createMemoryRequestGuard();
  const execute = requestGuard.fixtureExecutor.execute;
  requestGuard.fixtureExecutor.execute = async (sql, args) => {
    if (failStage === 'outer-completion' && sql.startsWith("UPDATE ai_request_run SET status='completed'")) {
      throw Object.assign(new Error('synthetic completion failure'), { code: 'ECONNRESET', sqlState: 'HY000' });
    }
    return execute(sql, args);
  };
  const writeDb = { getConnection: async () => {
    const infrastructure = await requestGuard.fixtureExecutor.getConnection();
    let checkpoint;
    return { transactionFixture: true,
      query: async () => [[]],
      beginTransaction: async () => { await infrastructure.beginTransaction(); checkpoint = structuredClone(state); },
      execute: async (sql, args) => {
        if (failStage === 'recovery' && sql.startsWith('UPDATE ai_request_run SET result_payload=?')) throw new Error('synthetic recovery failure');
        return infrastructure.execute(sql, args);
      },
      commit: async () => { await infrastructure.commit(); checkpoint = null; },
      rollback: async () => { if (checkpoint) state = checkpoint; await infrastructure.rollback(); },
      release: () => infrastructure.release(),
    };
  } };
  const draftStore = {
    save: jest.fn(async (owner, input, conn) => {
      expect(conn?.transactionFixture).toBe(true);
      if (++saveCalls === 2 && failStage === 'draft-2') throw new Error('synthetic second insert failure');
      const draft = { ...structuredClone(input), id: crypto.randomUUID(), version: 1, status: 'pending',
        expiresAt: now().getTime() + 900000 };
      state.drafts.set(draft.id, draft); return structuredClone(draft);
    }),
    get: jest.fn(async (owner, id) => {
      const draft = state.drafts.get(id);
      if (!draft) throw Object.assign(new Error('No fixture draft'), { status: 404 });
      return structuredClone(draft);
    }),
  };
  const candidateStore = {
    save: jest.fn(async (owner, input, conn) => {
      expect(conn?.transactionFixture).toBe(true);
      const candidate = { ...structuredClone(input), id: crypto.randomUUID(), status: 'pending', expiresAt: now().getTime() + 900000 };
      candidate.sourceCandidateId = candidate.id;
      state.candidates.set(candidate.id, candidate); return structuredClone(candidate);
    }),
    get: jest.fn(async (owner, id) => structuredClone(state.candidates.get(id))),
  };
  const conversationId = crypto.randomUUID();
  const conversationStore = { open: async () => ({ id: conversationId, history: [] }),
    append: jest.fn(async (owner, id, payload, conn) => {
      expect(conn?.transactionFixture).toBe(true);
      if (failStage === 'history') throw new Error('synthetic history failure');
      state.history.push(structuredClone(payload));
    }),
  };
  const legacy = createTestService({ now, draftStore, candidateStore, conversationStore, requestGuard, writeDb });
  const config = legacy.getRuntime('owner').config, previewId = crypto.randomUUID();
  const accountRef = 'r_' + 'a'.repeat(32), categoryRef = 'r_' + 'b'.repeat(32);
  const fields = amount => ({ amount, direction: 0, currency: 'CNY', transDate: '2026-11-05', accountId: 'fixture_balance' });
  const message = '余额账户记账支出10元和20元';
  const approved = { message, providerMessage: message, scope: { domains: ['finance'] }, conversationId,
    connectionId: legacy.getRuntime('owner').connectionId,
    provider: crypto.createHash('sha256').update(JSON.stringify([config.baseUrl, config.model, config.apiKey])).digest('hex'),
    snapshot: { choices: { cards: [{ ref: accountRef, name: '余额账户' }], categories: [{ ref: categoryRef, name: '餐饮' }] } },
    refMap: { [accountRef]: { kind: 'card', id: 'fixture_balance' }, [categoryRef]: { kind: 'category', id: 'fixture_food' } },
    localFinancialInputs: [{ fields: fields('10') }, { fields: fields('20') }], digest: 'f'.repeat(64),
  };
  const proposal = (amount, changes = {}) => ({ kind: 'transaction.create', fields: {
    amount, direction: 0, currency: 'CNY', transDate: '2026-11-05', accountRef, categoryRef,
    payMethod: '微信', remark: '餐饮', ...changes,
  } });
  let output = { answer: '', proposals: [proposal('10'), proposal('20', secondChanges)] };
  const provider = jest.fn(async () => ({ role: 'assistant', content: JSON.stringify(output) }));
  const previews = { get: async () => approved, approveAndGet: async () => approved,
    toProvider: async () => ({ datasets: [] }), resolve: async (_owner, _id, ref) => approved.refMap[ref]?.id };
  let lockedChecks = 0;
  const grants = { requireCoverage: jest.fn(async (_owner, _domains, _host, control) => {
    if (!control?.lock) return;
    expect(control.executor.transactionFixture).toBe(true);
    lockedChecks++;
    if ((failStage === 'grant-start' && lockedChecks === 1) || (failStage === 'grant-final' && lockedChecks === 2))
      throw new AiError('revoked at transactional boundary', 403, 'AI_GRANT_REQUIRED');
  }) };
  const business = createBusinessService({ legacyService: legacy, now, previews, provider,
    executor: { execute: async () => [{ affectedRows: 1 }] }, grants });
  const requestId = crypto.randomUUID(), request = { requestId, previewId, consent: true };
  return { legacy, business, requestGuard, draftStore, candidateStore, provider, approved, requestId, grants,
    send: () => business.chat('owner', request), setOutput: value => { output = value; }, proposal,
    state: () => state, close: async () => { await legacy.close(); await business.close(); } };
}

function singleFixture(options) {
  const f = fixture(options);
  f.approved.message = f.approved.providerMessage = '余额账户记账支出10元';
  f.approved.localFinancialInput = f.approved.localFinancialInputs[0];
  delete f.approved.localFinancialInputs;
  f.setOutput({ answer: '', proposal: f.proposal('10') });
  return f;
}

afterEach(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
});

test('a false current-execution claim in V3 buildResult rolls back a real inserted draft and leaves no history or recovery', async () => {
  const f = singleFixture();
  try {
    const budget = { requestId: f.requestId, calls: 2, check: jest.fn() };
    const prepared = await f.legacy.prepareTransactionProposal('owner', { amount: '10', direction: 0, currency: 'CNY', transDate: '2026-11-05',
      accountId: 'fixture_balance', categoryId: 'fixture_food', payMethod: '微信', remark: '餐饮' },
    { message: '余额账户记账支出10元', conversationId: f.approved.conversationId, budget });
    await expect(f.legacy.persistTransactionBatch('owner', [prepared], { conversationId: f.approved.conversationId, budget,
      buildResult: artifacts => {
        expect(artifacts[0].draft).toMatchObject({ id: expect.any(String), status: 'pending' });
        assertResultClaims('本次已完成入账。', { artifacts, currentReceipts: [] });
        throw new Error('unreachable');
      }, assertAuthorization: async () => {} })).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
    expect(f.draftStore.save).toHaveBeenCalledTimes(1); expect(f.state().drafts.size).toBe(0); expect(f.state().candidates.size).toBe(0);
    expect(f.state().history).toHaveLength(0);
    expect(f.provider).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('second model evidence mismatch is rejected before any batch persistence', async () => {
  const f = fixture({ secondChanges: { transDate: '2026-11-04' } });
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_TRANSACTION_EVIDENCE_MISMATCH' });
    expect(f.draftStore.save).not.toHaveBeenCalled(); expect(f.candidateStore.save).not.toHaveBeenCalled();
    expect(f.state().history).toHaveLength(0); expect(f.provider).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test.each(['draft-2', 'history', 'recovery'])('batch %s failure rolls back every draft, history and recovery payload', async failStage => {
  const f = fixture({ failStage });
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
    expect(f.state().drafts.size).toBe(0); expect(f.state().candidates.size).toBe(0); expect(f.state().history).toHaveLength(0);
    expect(await f.legacy.getRequestReceipt('owner', f.requestId)).toMatchObject({ status: 'failed' });
    await expect(f.send()).rejects.toMatchObject({ status: 409 }); expect(f.provider).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('mixed draft and incomplete candidate commit together with complete history and one durable receipt', async () => {
  const f = fixture({ secondChanges: { categoryRef: null } });
  try {
    const result = await f.send();
    expect(result.drafts).toHaveLength(1); expect(result.candidates).toHaveLength(1);
    expect(f.state().drafts.size).toBe(1); expect(f.state().candidates.size).toBe(1);
    expect(f.state().history).toHaveLength(1);
    expect(f.state().history[0].business).toMatchObject({ draftIds: [result.drafts[0].id], candidateIds: [result.candidates[0].inputCandidate.id] });
    expect(await f.legacy.getRequestReceipt('owner', f.requestId)).toMatchObject({ status: 'completed',
      result: { drafts: [{ id: result.drafts[0].id }], candidates: [{ inputCandidate: { id: result.candidates[0].inputCandidate.id } }] } });
    const candidate = f.state().candidates.get(result.candidates[0].inputCandidate.id);
    const laterDraft = { ...structuredClone(result.drafts[0]), id: crypto.randomUUID(), amount: '20', status: 'committed',
      version: 3, committedRecordId: 'fixture-receipt' };
    f.state().drafts.set(laterDraft.id, laterDraft);
    candidate.status = 'consumed'; candidate.draftId = laterDraft.id;
    const restored = await f.legacy.getRequestReceipt('owner', f.requestId);
    expect(restored.result.candidates[0]).toMatchObject({ inputCandidate: { status: 'consumed' },
      draft: { id: laterDraft.id, status: 'committed', version: 3, committedRecordId: 'fixture-receipt' } });
    await f.send(); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.draftStore.save).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('outer receipt completion failure recovers the committed batch and current terminal draft without another write', async () => {
  const f = fixture({ failStage: 'outer-completion' });
  try {
    await expect(f.send()).rejects.toMatchObject({ causeCode: 'ECONNRESET', causeSqlState: 'HY000' });
    expect(f.state().drafts.size).toBe(2); expect(f.state().history).toHaveLength(1);
    const first = [...f.state().drafts.values()][0]; first.status = 'discarded'; first.version++;
    const receipt = await f.legacy.getRequestReceipt('owner', f.requestId);
    expect(receipt).toMatchObject({ status: 'completed', recoveredFromBusinessTransaction: true });
    expect(receipt.result.drafts.find(item => item.id === first.id)).toMatchObject({ status: 'discarded', version: 2 });
    await f.send(); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.draftStore.save).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

test('a multi-preview cannot silently lose a transaction or repeat one single-preview transaction', async () => {
  let f = fixture();
  try {
    f.setOutput({ answer: '', proposal: f.proposal('10') });
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_TRANSACTION_EVIDENCE_MISMATCH' });
    expect(f.draftStore.save).not.toHaveBeenCalled();
  } finally { await f.close(); }
  f = fixture();
  try {
    delete f.approved.localFinancialInputs;
    f.approved.localFinancialInput = { fields: { amount: '10', direction: 0, currency: 'CNY', transDate: '2026-11-05', accountId: 'fixture_balance' } };
    f.setOutput({ answer: '', proposals: [f.proposal('10'), f.proposal('10')] });
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_TRANSACTION_EVIDENCE_MISMATCH' });
    expect(f.draftStore.save).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('multi-proposal output cannot introduce another business mutation', async () => {
  const f = fixture();
  try {
    f.setOutput({ answer: '', proposals: [f.proposal('10'), { kind: 'todo.create', fields: {} }] });
    await expect(f.send()).rejects.toThrow(); expect(f.draftStore.save).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(['history', 'recovery'])('single transaction %s failure rolls back its draft and receipt', async failStage => {
  const f = singleFixture({ failStage });
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
    expect(f.state().drafts.size).toBe(0); expect(f.state().candidates.size).toBe(0); expect(f.state().history).toHaveLength(0);
    expect(await f.legacy.getRequestReceipt('owner', f.requestId)).toMatchObject({ status: 'failed' });
    await expect(f.send()).rejects.toMatchObject({ status: 409 }); expect(f.provider).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test.each(['grant-start', 'grant-final'])('single transaction %s revocation rolls back all artifacts and never replays provider', async failStage => {
  const f = singleFixture({ failStage });
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
    expect(f.state().drafts.size).toBe(0); expect(f.state().candidates.size).toBe(0); expect(f.state().history).toHaveLength(0);
    expect(f.draftStore.save).toHaveBeenCalledTimes(failStage === 'grant-start' ? 0 : 1);
    expect(await f.legacy.getRequestReceipt('owner', f.requestId)).toMatchObject({ status: 'failed' });
    await expect(f.send()).rejects.toMatchObject({ status: 409 }); expect(f.provider).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('single transaction survives lost outer completion acknowledgement and restores its current draft', async () => {
  const f = singleFixture({ failStage: 'outer-completion' });
  try {
    await expect(f.send()).rejects.toMatchObject({ causeCode: 'ECONNRESET' });
    expect(f.state().drafts.size).toBe(1); expect(f.state().history).toHaveLength(1);
    const draft = [...f.state().drafts.values()][0]; draft.status = 'discarded'; draft.version++;
    const receipt = await f.legacy.getRequestReceipt('owner', f.requestId);
    expect(receipt).toMatchObject({ status: 'completed', recoveredFromBusinessTransaction: true,
      result: { draft: { id: draft.id, status: 'discarded', version: 2 } } });
    await f.send(); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.draftStore.save).toHaveBeenCalledTimes(1);
    expect(f.grants.requireCoverage.mock.calls.filter(call => call[3]?.lock)).toHaveLength(2);
  } finally { await f.close(); }
});

test('single incomplete transaction candidate has an atomic recoverable receipt', async () => {
  const f = singleFixture({ failStage: 'outer-completion' });
  f.setOutput({ answer: '', proposal: f.proposal('10', { categoryRef: null }) });
  try {
    await expect(f.send()).rejects.toMatchObject({ causeCode: 'ECONNRESET' });
    expect(f.state().drafts.size).toBe(0); expect(f.state().candidates.size).toBe(1); expect(f.state().history).toHaveLength(1);
    const candidate = [...f.state().candidates.values()][0];
    const receipt = await f.legacy.getRequestReceipt('owner', f.requestId);
    expect(receipt).toMatchObject({ status: 'completed', recoveredFromBusinessTransaction: true,
      result: { inputCandidate: { id: candidate.id, status: 'pending' } } });
    await f.send(); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.candidateStore.save).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
