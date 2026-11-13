jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getConnection: jest.fn() }));
const crypto = require('crypto');
const { createLegacyBusinessService: createBusinessService, explicitAmount, chartFor, SYSTEM_PROMPT } = require('../helpers/legacyBusinessService');
const { AiError } = require('../../src/modules/ai/service/errors');
const { parseTransactionInput } = require('../../src/modules/ai/service/transactionInput');
const { createMemoryCandidateStore, createMemoryFinancialRepository } = require('../helpers/aiFixture');
const id = () => crypto.randomUUID();
const now = () => new Date('2026-11-06T03:00:00Z');
function fixture(output = { answer: '请核对卡片', proposal: null }) {
  const config = { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fixture' };
  const values = new Map(), claimed = new Set(), runs = new Map(), history = [];
  const conversationId = id();
  const state = { config, connectionId: null, conversationStore: {
    open: jest.fn(async () => ({ id: conversationId, history })),
    session: jest.fn(async () => ({ id: conversationId, sessionKind: 'default', sessionDay: '2026-11-06' })),
    messages: jest.fn(async () => []), append: jest.fn(),
  }, requestGuard: { run: async (userId, request, work) => {
    const key = userId + request.requestId;
    if (runs.has(key)) return runs.get(key);
    let calls = 0;
    const budget = { check() {}, get calls() { return calls; }, invoke: async fn => { if (++calls > 1) throw new Error('loop'); return fn(); } };
    const promise = work(budget); runs.set(key, promise); return promise;
  } } };
  const accounts = [{ id: 'owned_internal_target', name: '借记卡000', type: 'debit' }, { id: 'other_owned_card', name: '生活500卡', type: 'debit' }];
  const financial = createMemoryFinancialRepository({ now, accounts: accounts.map(row => ({ id: row.id, card_type: row.type, currency: 'CNY', status: '正常' })) });
  const candidates = createMemoryCandidateStore({ now });
  const legacy = { getRuntime: () => state, proposeTransaction: jest.fn(async () => ({ id: id() })),
    financialPreflight: jest.fn(async (_, input) => {
      const parsed = input.fields ? { intent: 'transaction', status: 'pass', fields: input.fields, reasonCodes: [] }
        : parseTransactionInput(input.message, { accounts, today: '2026-11-06' });
      const financialCheck = parsed.status === 'pass' ? await financial.check('owner', parsed.fields)
        : { status: parsed.status, reasonCodes: parsed.reasonCodes, reasons: parsed.reasonCodes.map(code => ({ code })) };
      return { ...parsed, financialCheck, choices: { accounts, categories: [{ id: 'food', name: '餐饮', type: 'expense' }] } };
    }), saveTransactionCandidate: jest.fn((userId, result, metadata) => candidates.save(userId, {
      fields: result.fields, source: 'user-readonly', originalText: metadata.message, conversationId: metadata.conversationId,
      requestId: metadata.requestId || null, eligible: true,
    })) };
  const snapshot = { scope: { domains: [], startDate: '2026-11-01', endDate: '2026-11-06' }, datasets: [], choices: { todos: [], moods: [],
    cards: accounts.map((row, index) => ({ ref: 'r_' + (index ? 'c' : 'a').repeat(32), name: row.name })),
    categories: [{ ref: 'r_' + 'b'.repeat(32), name: '餐饮', type: 'expense' }] } };
  const refMap = Object.fromEntries(snapshot.choices.cards.map((row, index) => [row.ref, { kind: 'card', id: accounts[index].id }]));
  refMap[snapshot.choices.categories[0].ref] = { kind: 'category', id: 'food' };
  const previews = {
    prepare: jest.fn(async (_, input) => { const previewId = id(); const safe = { ...snapshot, ...(input.localFinancialInput ? { normalizedTransaction: {
      amount: input.localFinancialInput.fields.amount, direction: input.localFinancialInput.fields.direction,
      currency: 'CNY', transDate: input.localFinancialInput.fields.transDate,
      accountRef: snapshot.choices.cards.find(row => refMap[row.ref].id === input.localFinancialInput.fields.accountId).ref,
    } } : {}) }; values.set(previewId, { ...input, snapshot: safe, refMap, providerMessage: input.message, approvedAt: null }); return { previewId, datasets: [], digest: 'f'.repeat(64), expiresAt: Date.now() + 900000 }; }),
    get: jest.fn(async (_, previewId) => { if (!values.has(previewId)) throw new AiError('not found', 404); return values.get(previewId); }),
    approveAndGet: jest.fn(async (_, previewId) => { values.get(previewId).approvedAt = Date.now(); return values.get(previewId); }),
    toProvider: jest.fn(async (_, previewId) => ({ ...values.get(previewId).snapshot, message: values.get(previewId).message })),
    resolve: jest.fn(async (_, _previewId, ref) => refMap[ref]?.id || 'owned_internal_target'),
  };
  const provider = jest.fn(async () => ({ role: 'assistant', content: JSON.stringify(output) }));
  const executor = { execute: jest.fn(async (_, args) => { const key = args[1]; if (claimed.has(key)) return [{ affectedRows: 0 }]; claimed.add(key); return [{ affectedRows: 1 }]; }) };
  const proposals = { create: jest.fn(async (_, input) => ({ id: id(), kind: input.kind, fields: input.fields, previewId: input.previewId })), get: jest.fn() };
  const grants = { requireCoverage: jest.fn() };
  const service = createBusinessService({ legacyService: legacy, previews, provider, executor, proposals, repository: { query: async () => snapshot }, now, grants });
  const start = async (message = '查询数据', domains = []) => service.preview('owner', { message, scope: { domains } });
  const send = preview => service.chat('owner', { requestId: id(), previewId: preview.previewId, consent: true });
  return { service, start, send, provider, state, values, snapshot, legacy, proposals, history, candidates, previews, grants };
}
test('preview and daily/manual session never call a provider; only confirmed chat calls once', async () => {
  const f = fixture(); await f.service.session('owner'); const p = await f.start(); expect(f.provider).not.toHaveBeenCalled();
  const r = await f.send(p); expect(r.request.providerCalls).toBe(1); expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.provider.mock.calls[0][2]).toEqual([]); expect(f.provider.mock.calls[0][3].json).toBe(true);
});
test('same preview under a fresh requestId cannot call the provider again', async () => {
  const f = fixture(), p = await f.start(); await f.send(p);
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_PREVIEW_ALREADY_SENT' }); expect(f.provider).toHaveBeenCalledTimes(1);
});
test('duplicate requestId returns same receipt without another provider call', async () => {
  const f = fixture(), p = await f.start(), request = { requestId: id(), previewId: p.previewId, consent: true };
  const [a, b] = await Promise.all([f.service.chat('owner', request), f.service.chat('owner', request)]);
  expect(a).toEqual(b); expect(f.provider).toHaveBeenCalledTimes(1);
});
test('connection changes stop before external disclosure', async () => {
  const f = fixture(), p = await f.start(); f.state.connectionId = id();
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_CONNECTION_EXPIRED' }); expect(f.provider).not.toHaveBeenCalled();
});
test.each([{ role: 'assistant', content: '{bad' }, { role: 'assistant', content: '{}', tool_calls: [{ function: { name: 'execute_sql' } }] }])('malformed/provider tool output ends after one call', async response => {
  const f = fixture(), p = await f.start(); f.provider.mockResolvedValue(response); await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_INVALID_RESULT' }); expect(f.provider).toHaveBeenCalledTimes(1); expect(f.proposals.create).not.toHaveBeenCalled();
});
test('unknown/precision action is denied without creating a proposal', async () => {
  const f = fixture({ answer: '还款', proposal: { kind: 'card.repay', fields: {} } }), p = await f.start('查询信用卡还款记录', ['card']);
  await expect(f.send(p)).rejects.toThrow(); expect(f.proposals.create).not.toHaveBeenCalled(); expect(f.provider).toHaveBeenCalledTimes(1);
});
test('proposal outside approved domain and an unrequested mutation fail closed', async () => {
  let f = fixture({ answer: '', proposal: { kind: 'todo.delete', fields: { targetRef: null } } });
  await expect(f.send(await f.start('删除待办', ['finance']))).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  f = fixture({ answer: '', proposal: { kind: 'todo.create', fields: {} } });
  await expect(f.send(await f.start('看看待办', ['todo']))).rejects.toMatchObject({ code: 'AI_ACTION_NOT_REQUESTED' });
});
test('raw IDs and guessed money cannot enter a proposal', async () => {
  let f = fixture({ answer: '', proposal: { kind: 'todo.delete', fields: { targetId: 'real' } } });
  await expect(f.send(await f.start('删除待办', ['todo']))).rejects.toMatchObject({ code: 'AI_REF_INVALID' });
  f = fixture({ answer: '', proposal: { kind: 'budget.create', fields: { budgetAmount: '2026' } } });
  await expect(f.send(await f.start('创建2026年预算', ['budget']))).rejects.toMatchObject({ code: 'AI_AMOUNT_NOT_EXPLICIT' });
});

test.each(['todo.update','todo.complete','todo.delete','card.metadata','fixedAsset.update','fixedAsset.delete','fixedAsset.restore','fixedAsset.permanentDelete','fund.returnBatch'])(
  'provider instructions give a nested fields example for %s', kind => {
    const example = SYSTEM_PROMPT.split('\n').filter(line => line.startsWith('{')).map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).find(value => value?.proposal?.kind === kind);
    expect(example).toBeDefined(); expect(Object.keys(example.proposal).sort()).toEqual(['fields','kind']);
    expect(example.proposal.fields).toEqual(expect.any(Object));
    expect(Object.keys(example.proposal.fields).length).toBeGreaterThan(0);
  });

test.each(['todo.update','todo.complete','todo.delete','card.metadata','fixedAsset.update','fixedAsset.delete','fixedAsset.restore','fund.returnBatch'])(
  'flat provider fields stay rejected without output repair or another call: %s', async kind => {
    const f = fixture({ answer:'', proposal:{kind,targetRef:'r_'+'a'.repeat(32),status:'已完成'} });
    await expect(f.send(await f.start('请修改卡片与待办', ['card','todo','fixedAsset','fund']))).rejects.toMatchObject({code:'AI_INVALID_INPUT'});
    expect(f.provider).toHaveBeenCalledTimes(1); expect(f.proposals.create).not.toHaveBeenCalled();
  });

test.each(['挂失','注销'])('card metadata can restore an explicit unique %s card from its approved dataset', async status => {
  const ref='r_'+'d'.repeat(32), f=fixture({answer:'',proposal:{kind:'card.metadata',fields:{targetRef:ref,status:'正常'}}});
  f.snapshot.datasets.push({datasetId:'card-cards',domain:'card',rows:[{cardRef:ref,name:'停用生活卡',type:'credit',status}],columns:[]});
  const preview=await f.start('请将银行卡「停用生活卡」恢复正常状态',['card']);
  f.values.get(preview.previewId).refMap[ref]={kind:'card',id:'inactive-owned-card'};
  const result=await f.send(preview);
  expect(f.proposals.create).toHaveBeenCalledWith('owner',expect.objectContaining({kind:'card.metadata',fields:{targetId:'inactive-owned-card',status:'正常'}}));
  expect(result.proposal.choices.cards).toContainEqual(expect.objectContaining({id:'inactive-owned-card',name:'停用生活卡',status}));
  expect(f.snapshot.choices.cards.some(item=>item.ref===ref)).toBe(false);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('metadata dataset candidates still require a unique explicit alias and exclude virtual accounts', async () => {
  const ref='r_'+'d'.repeat(32), f=fixture({answer:'',proposal:{kind:'card.metadata',fields:{targetRef:ref,status:'正常'}}});
  f.snapshot.datasets.push({datasetId:'card-cards',domain:'card',rows:[
    {cardRef:ref,name:'重复卡名',type:'credit',status:'挂失'},
    {cardRef:'r_'+'e'.repeat(32),name:'重复卡名',type:'debit',status:'注销'},
    {cardRef:'r_'+'f'.repeat(32),name:'虚拟余额',type:'virtual_balance',status:'正常'},
  ],columns:[]});
  const preview=await f.start('请将银行卡「重复卡名」恢复正常状态',['card']);
  f.values.get(preview.previewId).refMap[ref]={kind:'card',id:'inactive-owned-card'};
  const result=await f.send(preview);
  expect(result.proposal.fields.targetId).toBeNull();
  expect(result.proposal.choices.cards.some(item=>item.name==='虚拟余额')).toBe(false);
});
test('special accounting input cannot be laundered into an ordinary transaction', async () => {
  const f = fixture({ answer: '', proposal: { kind: 'transaction.create', fields: { amount: '39.91', remark: '普通消费' } } });
  const result = await f.start('记账还款39.91元', ['finance']);
  expect(result.financialCheck.reasonCodes).toContain('AI_ACTION_NOT_ALLOWED');
  expect(result.inputCandidate).toBeDefined(); expect(result.request.providerCalls).toBe(0);
  expect(f.provider).not.toHaveBeenCalled(); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
});
test('fund amounts must belong to their explicitly paired dates, with signed values preserved', async () => {
  const f = fixture({ answer: '', proposal: { kind: 'fund.returnBatch', fields: { entries: [{ date: '2026-11-04', amount: '9.1132' }] } } });
  await expect(f.send(await f.start('登记收益\n2026-11-04 0.8658\n2026-11-05 9.1132', ['fund']))).rejects.toMatchObject({ code: 'AI_AMOUNT_NOT_EXPLICIT' });
  expect(explicitAmount('2026-11-04 -0.8658', '-0.8658')).toBe(true); expect(explicitAmount('日期2026-11-04', '2026')).toBe(false);
});
test('only the latest four user messages form visible context, excluding previous statistics', async () => {
  const f = fixture(); f.history.push({ role: 'assistant', content: '旧域财务统计' }, ...Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: '上下文' + i })));
  const p = await f.start(); expect(f.values.get(p.previewId).context.map(item => item.content)).toEqual(['上下文5', '上下文6', '上下文7', '上下文8']);
});
test('charts reuse only server dataset numeric fields and contain no executable expressions', () => {
  const dataset = { datasetId: 'finance-months', title: '按月', columns: [{ key: 'month', type: 'text' }, { key: 'expense', type: 'money' }], rows: [{ month: '2026-11', expense: '39.91' }] };
  expect(chartFor('走势', [dataset])).toMatchObject({ datasetId: dataset.datasetId, xKey: 'month', yKeys: ['expense'], type: 'line' });
  expect(chartFor('普通聊天', [dataset])).toBeNull();
});

test.each(['借记卡000支出100001元', '支出1000元', '借记卡000支出39.9099元'])('unsafe transaction stops locally with one persisted candidate and zero model calls: %s', async message => {
  const f = fixture(), result = await f.start(message, ['finance']);
  expect(result.inputCandidate).toMatchObject({ source: 'user-readonly', status: 'pending' });
  expect(['block', 'needs_input']).toContain(result.financialCheck.status);
  expect(result.request.providerCalls).toBe(0); expect(result.previewId).toBeUndefined();
  expect(f.legacy.saveTransactionCandidate).toHaveBeenCalledTimes(1);
  expect(f.provider).not.toHaveBeenCalled(); expect(f.previews.prepare).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append.mock.calls[0][2].business.inputCandidate.id).toBe(result.inputCandidate.id);
});

test('a clear unit-free snack purchase stops in the local missing-account card before any provider',async()=>{
  const f=fixture(),result=await f.start('今天去赵一鸣买了 8.5的零食',['finance']);
  expect(result.inputCandidate.fields).toMatchObject({amount:'8.5',direction:0,currency:'CNY',accountId:null});
  expect(result.financialCheck.reasonCodes).toContain('AI_ACCOUNT_MISSING');
  expect(result.request.providerCalls).toBe(0);expect(f.provider).not.toHaveBeenCalled();expect(f.previews.prepare).not.toHaveBeenCalled();
});
test('a source-less payment reply gives local recovery guidance without reading arbitrary history',async()=>{
  const f=fixture();f.history.push({role:'user',content:'买了零食8.5元'});
  await expect(f.start('余额支付的。',['account'])).rejects.toMatchObject({code:'AI_CONTINUATION_SOURCE_REQUIRED'});
  expect(f.provider).not.toHaveBeenCalled();expect(f.previews.prepare).not.toHaveBeenCalled();expect(f.legacy.financialPreflight).not.toHaveBeenCalled();
});
test('explicit continuation still needs finance scope and grant; same candidate may return a ready local card',async()=>{
  const f=fixture(),conversationId=id(),sourceCandidateId=id();
  const artifact={inputCandidate:{id:sourceCandidateId,sourceCandidateId,status:'pending',conversationId,fields:{amount:'8.5',currency:'CNY'}},
    financialCheck:{status:'pass'},financialChoices:{accounts:[],categories:[]}};
  f.legacy.continueTransactionCandidate=jest.fn(async(_user,_id,control)=>{await control.assertAuthorization({});await control.append(artifact,{});return artifact;});
  const request={message:'余额支付的。',conversationId,sourceCandidateId,scope:{domains:['account']}};
  await expect(f.service.preview('owner',request)).rejects.toMatchObject({code:'AI_SCOPE_DENIED'});
  expect(f.legacy.continueTransactionCandidate).not.toHaveBeenCalled();
  request.scope={domains:['finance']};const result=await f.service.preview('owner',request);
  expect(result).toMatchObject({answer:'',inputCandidate:{id:sourceCandidateId},financialCheck:{status:'pass'},request:{providerCalls:0}});
  expect(result.previewId).toBeUndefined();expect(f.provider).not.toHaveBeenCalled();
  f.grants.requireCoverage.mockRejectedValueOnce(new AiError('revoked',403,'AI_GRANT_REQUIRED'));
  await expect(f.service.preview('owner',request)).rejects.toMatchObject({code:'AI_GRANT_REQUIRED'});
});

test.each(['查询支出1000元明细', '不要记账支出1000元', '创建预算1000元'])('query, negated action and another domain do not borrow funds preprocessing: %s', async message => {
  const f = fixture(); await f.start(message, ['finance']);
  expect(f.legacy.financialPreflight).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
});

const transaction = changes => ({ answer: '不重复金额卡片', proposal: { kind: 'transaction.create', fields: {
  direction: 0, amount: '39.91', currency: 'CNY', transDate: '2026-11-06', accountRef: 'r_' + 'a'.repeat(32),
  categoryRef: 'r_' + 'b'.repeat(32), payMethod: '银行卡', remark: '停车费', ...changes,
} } });
test('safe transaction binds the original fields and produces one draft with one model call', async () => {
  const f = fixture(transaction()), p = await f.start('借记卡000支出39.91元', ['finance']);
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.values.get(p.previewId).localFinancialInput.fields).toMatchObject({ amount: '39.91', accountId: 'owned_internal_target' });
  const result = await f.send(p);
  expect(result.draft.id).toBeDefined(); expect(result.answer).toBe('');
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.legacy.financialPreflight).toHaveBeenCalledTimes(2);
  expect(f.legacy.proposeTransaction.mock.calls[0][1]).toMatchObject({ amount: '39.91', direction: 0, accountId: 'owned_internal_target' });
});

test('a null optional remark becomes an empty string while authoritative money fields stay bound', async () => {
  const f = fixture(transaction({ remark: null })), p = await f.start('借记卡000支出39.91元', ['finance']);
  const result = await f.send(p);
  expect(result.draft.id).toBeDefined(); expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.legacy.proposeTransaction.mock.calls[0][1]).toMatchObject({ remark: '', amount: '39.91', accountId: 'owned_internal_target' });
  expect(SYSTEM_PROMPT).toContain('remark 必须为字符串');
});
test.each([{ direction: 1 }, { accountRef: 'r_' + 'c'.repeat(32) }, { transDate: '2026-11-05' }, { currency: 'USD' }])('model cannot change already-fixed transaction fields: %j', async changes => {
  const f = fixture(transaction(changes)), p = await f.start('借记卡000支出39.91元', ['finance']);
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_TRANSACTION_EVIDENCE_MISMATCH' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
});
test('changed funds after preview stop before external disclosure and a duplicate request reuses the zero-call receipt', async () => {
  const f = fixture(transaction()), p = await f.start('借记卡000支出39.91元', ['finance']);
  f.legacy.financialPreflight.mockResolvedValueOnce({ intent: 'transaction', fields: f.values.get(p.previewId).localFinancialInput.fields,
    financialCheck: { status: 'block', reasonCodes: ['INSUFFICIENT_FUNDS'] }, choices: { accounts: [], categories: [] } });
  const request = { requestId: id(), previewId: p.previewId, consent: true };
  const result = await f.service.chat('owner', request);
  expect(result.request.providerCalls).toBe(0); expect(result.inputCandidate).toBeDefined();
  expect(await f.service.chat('owner', request)).toEqual(result);
  expect(f.provider).not.toHaveBeenCalled(); expect(f.legacy.saveTransactionCandidate).toHaveBeenCalledTimes(1);
});
test('a legacy candidate receipt is expanded rather than nested as a draft', async () => {
  const f = fixture(transaction()), p = await f.start('借记卡000支出39.91元', ['finance']);
  f.legacy.proposeTransaction.mockResolvedValueOnce({ inputCandidate: { id: 'candidate-only' }, financialCheck: { status: 'needs_input' } });
  const result = await f.send(p);
  expect(result.inputCandidate.id).toBe('candidate-only'); expect(result.draft).toBeUndefined(); expect(result.answer).toBe('');
  expect(f.provider).toHaveBeenCalledTimes(1);
});
test('a trusted account alias containing digits is resolved once and never mistaken for another transaction amount', async () => {
  const f = fixture(transaction({ accountRef: 'r_' + 'c'.repeat(32) })), p = await f.start('生活500卡支出39.91元', ['finance']);
  const result = await f.send(p);
  expect(result.draft.id).toBeDefined(); expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.legacy.proposeTransaction.mock.calls[0][1]).toMatchObject({ accountId: 'other_owned_card', amount: '39.91', direction: 0 });
});
test('revoking an approved financial domain before chat stops the old preview from being sent', async () => {
  const f = fixture();
  f.state.businessPolicy = { enabled: true, domains: ['finance', 'todo'], actions: ['transaction.create'] };
  const p = await f.start('查询收支情况', ['finance']);
  f.state.businessPolicy = { enabled: true, domains: ['todo'], actions: ['transaction.create'] };
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.previews.approveAndGet).not.toHaveBeenCalled();
});
test('domain revoked while local recheck awaits stops disclosure at the final provider boundary', async () => {
  const f = fixture(transaction());
  f.state.businessPolicy = { enabled: true, domains: ['finance', 'todo'], actions: ['transaction.create'] };
  const p = await f.start('借记卡000支出39.91元', ['finance']);
  const original = f.values.get(p.previewId).localFinancialInput.fields;
  const current = await f.legacy.financialPreflight('owner', { fields: original });
  f.legacy.financialPreflight.mockImplementationOnce(async () => {
    f.state.businessPolicy = { enabled: true, domains: ['todo'], actions: ['transaction.create'] }; return current;
  });
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
});
test('domain revoked while the paid response awaits cannot persist its late proposal', async () => {
  const f = fixture(transaction());
  f.state.businessPolicy = { enabled: true, domains: ['finance', 'todo'], actions: ['transaction.create'] };
  const p = await f.start('借记卡000支出39.91元', ['finance']);
  f.provider.mockImplementationOnce(async () => {
    f.state.businessPolicy = { enabled: true, domains: ['todo'], actions: ['transaction.create'] };
    return { role: 'assistant', content: JSON.stringify(transaction()) };
  });
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test('grant revoked during local recheck stops at the final provider boundary', async () => {
  const f = fixture(transaction()), p = await f.start('借记卡000支出39.91元', ['finance']);
  const current = await f.legacy.financialPreflight('owner', { fields: f.values.get(p.previewId).localFinancialInput.fields });
  f.legacy.financialPreflight.mockImplementationOnce(async () => {
    f.grants.requireCoverage.mockRejectedValue(new AiError('revoked', 403, 'AI_GRANT_REQUIRED'));
    return current;
  });
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test.each([
  [transaction(), '借记卡000支出39.91元', ['finance']],
  [{ answer: '', proposal: { kind: 'todo.create', fields: { content: '买牛奶' } } }, '创建待办买牛奶', ['todo']],
])('grant revoked while provider awaits stops every late proposal: %j', async (output, message, domains) => {
  const f = fixture(output), p = await f.start(message, domains);
  f.provider.mockImplementationOnce(async () => {
    f.grants.requireCoverage.mockRejectedValue(new AiError('revoked', 403, 'AI_GRANT_REQUIRED'));
    return { role: 'assistant', content: JSON.stringify(output) };
  });
  await expect(f.send(p)).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
  expect(f.proposals.create).not.toHaveBeenCalled(); expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test.each([
  ['记账支出10元和20元', 'AI_ACCOUNT_MISSING', '资金账户'],
  ['借记卡000记账支出10元、20元和约30元', 'AI_AMOUNT_AMBIGUOUS', '每笔完整金额'],
])('incomplete batch requests explain how to repair the whole message without a provider call: %s', async (message, code, text) => {
  const f = fixture(), result = await f.start(message, ['finance']);
  expect(result.financialCheck).toMatchObject({ status: 'needs_input', reasonCodes: [code] });
  expect(result.financialCheck.reasons[0].message).toContain(text);
  expect(f.provider).not.toHaveBeenCalled(); expect(f.legacy.proposeTransaction).not.toHaveBeenCalled();
});
