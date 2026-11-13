jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,calls,final}=require('./fixtures/aiV3SourceCurrencyFixture.cjs');
const capture=require('./fixtures/aiSourceCurrencyCapturedCase.json');
function setup(answer,{mixed=true}={}){
 // A context read in the same batch makes this a real mixed workflow, so the
 // independently scripted captured final packet reaches ordinary validation.
 // The current one-call grounded maximum path is separately covered below.
 const batch=calls('query_data',{datasetId:'finance-transactions',startDate:'2026-06-01',endDate:'2026-06-30',direction:'expense',sort:'amountDesc',limit:1});
 if(mixed)batch.tool_calls.push(...calls('history_search',{query:'财务',limit:1}).tool_calls);
 else batch.content=answer;
 const f=fixture([batch,final({...capture.output,answer})],
  {clock:()=>new Date(capture.dataset.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.state.queryContext={version:1,activeQuery:{startDate:'2026-06-01',endDate:'2026-06-30',direction:'expense',category:null,metric:'transaction-max',status:'succeeded',periodSource:'inherited'},lastResults:[{...capture.dataset.queryMeta,status:'succeeded',source:'previous-turn'}]};
 f.state.taskContext={version:1,mode:'query',subject:'finance',targetDatasetId:'finance-transactions',metric:'transaction-max',querySort:'amountDesc',requireFreshQuery:true,
  scope:{startDate:'2026-06-01',endDate:'2026-06-30'},status:'succeeded',cardTypes:[],comparisonScopes:[],chartRequest:null};
 f.history.push({role:'user',content:'查看6月份收入和支出。',sourceDate:'2026-11-09'},{role:'assistant',content:'6月范围为2026-06-01至2026-06-30。',queryContext:f.state.queryContext,taskContext:f.state.taskContext});
 f.repository.query.mockImplementation(async(_,input)=>{const d=structuredClone(capture.dataset);d.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[d],choices:{},asOf:d.asOf};});return f;
}
function verify(f,result){
 expect(result.datasets[0].rows).toEqual(capture.dataset.rows);expect(result.datasets[0].summary).toEqual(capture.dataset.summary);
 expect(result.datasets[0].queryMeta).toMatchObject({effectiveScope:{startDate:'2026-06-01',endDate:'2026-06-30'},matchedRowCount:153,returnedRowCount:1,sourceRecordCount:153,rowsComplete:false});
 const saved=f.state.conversationStore.append.mock.calls[0][2];expect(saved.answer).toBe(result.answer);expect(saved.business.datasets).toEqual(result.datasets);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 const approved=f.audits.find(item=>item.phase==='tool'&&item.toolName==='query_data').response.result;
 expect(result.datasets[0].rows).toEqual(approved.datasets[0].rows);
 expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.repository.query).toHaveBeenCalledTimes(1);
}
test('actual X19 same-scope maximum and approved rows persist without unsupported 153-row original-CNY claim',async()=>{
 const f=setup(capture.output.answer),result=await f.send(capture.message);verify(f,result);expect(result.answer).toContain('支出最大的一笔发生在 2026-06-18');expect(result.answer).toContain('CNY 999.00');
 expect(result.answer).not.toContain('原币 CNY，未混币');
});
test.each([capture.issue.unsupportedQuote,'这笔交易原币为CNY，未混币。'])('one-call grounded maximum retains the exact approved source and ignores unverified prelude: %s',async prelude=>{
 const f=setup(prelude,{mixed:false}),result=await f.send(capture.message);verify(f,result);
 expect(f.provider).toHaveBeenCalledTimes(1);expect(f.audits.filter(item=>item.phase==='grounded-done')).toHaveLength(1);
 expect(result.answer).toContain('2026-06-18');expect(result.answer).toContain('CNY 999.00');
 expect(result.answer).not.toContain('原币 CNY，未混币');expect(result.datasets[0].rows[0].currency).toBe('CNY');
});
test('local approved transaction original CNY remains after actual service window validation',async()=>{
 const f=setup('这笔交易原币为CNY，未混币。'),result=await f.send(capture.message);verify(f,result);expect(result.answer).toContain('这笔交易原币为CNY，未混币');
});
test('a quantifier-free unmixed assertion cannot borrow the one approved original-CNY row',async()=>{
 const f=setup('未混币。'),result=await f.send(capture.message);verify(f,result);expect(result.answer).not.toContain('未混币');
});
test('source-currency validation does not weaken actual business execution claims',async()=>{
 const f=setup('这笔交易原币为CNY，未混币。\n我已经完成入账。');await expect(f.send(capture.message)).rejects.toMatchObject({code:'AI_RESULT_CLAIM_MISMATCH'});
 expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
