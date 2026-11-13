jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw new Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw new Error('Real provider forbidden');})}));
const crypto = require('crypto');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const id = () => crypto.randomUUID();
const date = '2026-11-08';
const now = () => new Date('2026-11-08T13:22:14Z');
const final = output => ({ role: 'assistant', content: JSON.stringify({ answer: '已处理。', proposal: null, ...output }) });
const calls = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + id(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function fixture(responses, { memoryStore, historyReader = { loadSummary: jest.fn(async () => null),
  search: jest.fn(async () => []) }, userId = 'offline-memory-owner', clock = now } = {}) {
  const scripted = [...responses, responses.at(-1)];
  const fixtureDate = clock().toISOString().slice(0, 10);
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
    businessPolicy: { enabled: true, domains: ['finance','card','account','todo','budget','fund','asset','fixedAsset','work','installment'], actions: ['transaction.create', 'todo.create'] } };
  state.conversationStore = {
    open: jest.fn(async () => ({ id: conversationId, history, latestDraftId: state.latestDraftId || null })),
    session: jest.fn(async () => ({ id: conversationId })),
    loadQueryContext: jest.fn(async () => state.queryContext || history.findLast(turn => turn.queryContext)?.queryContext || null),
    loadTaskContext: jest.fn(async () => state.taskContext || history.findLast(turn => turn.taskContext)?.taskContext || null),
    loadPendingTransactionContext: jest.fn(async () => state.pendingContext || null),
    append: jest.fn(async (_, __, payload) => {
      if (payload.message) history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: fixtureDate });
      history.push({ role: 'assistant', content: payload.answer, turnId: payload.requestId,
        ...(payload.queryContext ? { queryContext: payload.queryContext } : {}),
        ...(payload.taskContext ? { taskContext: payload.taskContext } : {}), business: payload.business });
      if (payload.taskContext) state.taskContext = payload.taskContext;
      if (payload.business?.pendingTransactions) state.pendingContext = payload.business.pendingTransactions;
    }),
    appendFailure: jest.fn(async (_, __, payload) => {
      history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: fixtureDate },
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
  const raw = { scope: { domains: [], startDate: '2026-11-01', endDate: fixtureDate }, asOf: clock().toISOString(),
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
      await state.conversationStore.append(userId, conversationId, built.appendPayload, conn);
      await state.requestGuard.saveV3Recovery(conn, userId, options.budget.requestId, built.result);
      return built.result;
    }) };
  const service = createV3Service({ legacyService: legacy, memoryStore, historyReader, businessService: {}, executor, repository,
    previews: createPreviewStore({ executor, now: () => clock().getTime() }), provider,
    proposals: { create: jest.fn(() => { throw new Error('Unexpected business proposal in quality replay'); }) },
    grants: { requireCoverage: jest.fn(async () => {}) }, callLog: { record: entry => audits.push(entry) }, now: clock });
  const send = message => service.chat(userId, { requestId: id(), message, conversationId, consent: true });
  return { send, service, state, history, repository, provider, raw, legacy, audits, conversationId };
}



const publicDb=require('../../src/common/config/db'),publicProvider=require('../../src/modules/ai/service/deepseek');
function matchingTotalFixture(){
  const clock=()=>new Date('2026-11-10T00:00:00Z'),answer='按已保存收益登记展示。',f=fixture([calls('query_data',{datasetId:'fund-history',startDate:'2026-01-01',endDate:'2026-11-09',filter:'基金甲',limit:50}),final({answer})],
    {clock,memoryStore:{list:jest.fn(async()=>({files:[],warnings:[],count:0,totalBytes:0}))}});
  const rows=Array.from({length:42},(_,index)=>({name:'基金甲',date:new Date(Date.UTC(2026,0,1+index)).toISOString().slice(0,10),profit:(0.03+index/10000).toFixed(4),capitalDelta:'0.00'})).reverse();
  const choices={cards:[],categories:[],funds:[],todos:[],fixedAssets:[],moods:[]};
  f.repository.query=jest.fn(async(_,args)=>({scope:args.scope,choices,asOf:clock().toISOString(),datasets:[{datasetId:'fund-history',domain:'fund',title:'基金收益历史',
    columns:[{key:'name',label:'基金',type:'text'},{key:'date',label:'日期',type:'date'},{key:'profit',label:'收益增量',type:'decimal'},{key:'capitalDelta',label:'本金增量',type:'money'}],rows,summary:{},policy:'只读已保存收益与本金增量。',truncated:false,
    queryMeta:{version:1,queryId:args.queryId,datasetId:'fund-history',requestedScope:args.requestedScope,effectiveScope:{startDate:args.scope.startDate,endDate:args.scope.endDate},
      filters:{direction:'both',text:args.filter},sort:'dateDesc',matchedRowCount:42,returnedRowCount:42,sourceRecordCount:null,rowsComplete:true,summaryComplete:false,rankingComplete:false,
      returnedDateRange:{startDate:rows.at(-1).date,endDate:rows[0].date},asOf:clock().toISOString()}}]}));
  return{...f,rows};
}
test('actual V3 explicitly prints 42 matches and 42 displayed rows for 匹配总数',async()=>{
  const f=matchingTotalFixture(),result=await f.send('查询2026年1月1日至11月9日基金收益登记历史，只匹配名称基金甲，最多展示50条。告诉我匹配总数。');
  expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:42,returnedRowCount:42,rowsComplete:true});
  expect(result.answer).toContain('匹配 42 行');expect(result.answer).toContain('本次展示 42 行');expect(result.answer).toContain('2026-01-01 至 2026-11-09');
  expect(result.datasets[0].rows.map(({name,date,profit,capitalDelta})=>({name,date,profit,capitalDelta}))).toEqual(f.rows);
  expect(result.answer).toContain('收益增量 '+f.rows.at(-1).profit);expect(result.answer).toContain('未登记日期不补零');expect(f.history.at(-1).content).toBe(result.answer);
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test('actual V3 does not add quantity prose when the nonempty fund query did not ask for it',async()=>{
  const f=matchingTotalFixture(),result=await f.send('查询2026年1月1日至11月9日基金收益登记历史，只匹配名称基金甲，最多展示50条。');
  expect(result.datasets[0].rows.length).toBe(42);expect(result.answer).not.toContain('匹配 42 行');expect(result.answer).not.toContain('本次展示 42 行');
  expect(result.answer).toContain('未登记日期不补零');expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
afterEach(()=>{expect(publicDb.execute).not.toHaveBeenCalled();expect(publicDb.getConnection).not.toHaveBeenCalled();expect(publicProvider.deepseekChat).not.toHaveBeenCalled();});
