// Saved-state canonical scope runs after actual tool validation, never before it.
jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw new Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw new Error('Paid provider forbidden');})}));
const publicDb=require('../../src/common/config/db');const {deepseekChat}=require('../../src/modules/ai/service/deepseek');
const {fixture,calls,final,now}=require('../fixtures/aiV3MemoryFixture');
const {validateTool}=require('../../src/modules/ai/service/v3Tools');
const noMemory=()=>({list:jest.fn(async()=>({files:[],count:0,warnings:[]}))});
function setup(responses,datasetId='work-rules'){
 const f=fixture(responses,{memoryStore:noMemory()});f.state.businessPolicy.domains.push('work');
 f.raw.datasets=[{datasetId,domain:'work',title:datasetId==='work-rules'?'工资规则':'工资登记历史',columns:[{key:'company',label:'公司',type:'text'}],rows:[],summary:{},totalCount:0,truncated:false,asOf:now().toISOString(),policy:datasetId==='work-rules'?'目前保存规则。':'按登记日期筛选。'}];return f;
}
afterEach(()=>{expect(publicDb.execute).not.toHaveBeenCalled();expect(publicDb.getConnection).not.toHaveBeenCalled();expect(deepseekChat).not.toHaveBeenCalled();});
test('two saved-state ranges in one provider batch reuse one canonical read and pair both empty results',async()=>{
 const first=calls('query_data',{datasetId:'work-rules',startDate:'2026-06-01',endDate:'2026-06-30'}),second=calls('query_data',{datasetId:'work-rules',startDate:'2025-01-01',endDate:'2025-12-31'});
 const f=setup([{role:'assistant',content:null,tool_calls:[...first.tool_calls,...second.tool_calls]},final({answer:'目前没有保存工资规则。'})]);
 const result=await f.send('查看2026年11月1日至8日目前保存的工资规则。');expect(f.repository.query).toHaveBeenCalledTimes(1);
 expect(f.repository.query.mock.calls[0][1].scope).toMatchObject({startDate:'2026-11-01',endDate:'2026-11-08'});expect(result.datasets).toHaveLength(1);
 expect(result.datasets[0].queryMeta.effectiveScope).toEqual({startDate:'2026-11-01',endDate:'2026-11-08'});
 const paired=f.provider.mock.calls[1][1].filter(item=>item.role==='tool');expect(paired.map(item=>item.tool_call_id)).toEqual([first.tool_calls[0].id,second.tool_calls[0].id]);
 expect(paired.map(item=>JSON.parse(item.content).datasets[0].queryMeta.queryId)).toEqual([result.datasets[0].queryMeta.queryId,result.datasets[0].queryMeta.queryId]);
 expect(f.provider).toHaveBeenCalledTimes(2);expect(f.provider.mock.calls[1][2]).toEqual([]);expect(f.provider.mock.calls[1][3]).toMatchObject({json:true,toolChoice:'none'});
});
test('no explicit task scope pins saved-state to the actual initial default rather than model history',async()=>{
 const f=setup([calls('query_data',{datasetId:'work-rules',startDate:'2025-01-01',endDate:'2025-12-31'}),final({answer:'目前没有保存工资规则。'})]);await f.send('查看目前保存的工资规则。');
 expect(f.repository.query.mock.calls[0][1].scope).toMatchObject({startDate:'2026-11-01',endDate:'2026-11-08'});
});
test.each([{startDate:'2026-02-30',endDate:'2026-11-08'},{startDate:'2026-11-08',endDate:'2026-11-01'},{startDate:'2027-01-01',endDate:'2027-02-01'}])('an invalid raw saved-state range %j cannot be laundered by task scope',async range=>{
 const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});try{
  const f=setup([calls('query_data',{datasetId:'work-rules',...range}),final({answer:'查询日期无效，请核对日期。'})]);
  let originalError;try{validateTool('query_data',{datasetId:'work-rules',...range},'2026-11-08');}catch(error){originalError=error;}
  expect(originalError).toBeDefined();expect(originalError.code).toBe('AI_SCOPE_INVALID');
  const result=await f.send('查看2026年11月1日至8日目前保存的工资规则。');
  expect(f.repository.query).not.toHaveBeenCalled();expect(result.datasets).toEqual([]);expect(result.toolTrace).toEqual([]);
  const feedback=f.provider.mock.calls[1][1].filter(item=>item.role==='tool').map(item=>JSON.parse(item.content));
  expect(feedback).toEqual([expect.objectContaining({status:'error',code:originalError.code,recoverable:true,retryAllowed:true})]);
  expect(f.audits.filter(entry=>entry.phase==='tool-recovery'&&entry.status==='error'))
    .toEqual([expect.objectContaining({errorCode:originalError.code})]);
  expect(f.provider).toHaveBeenCalledTimes(3);expect(result.request.providerCalls).toBe(3);
  expect(result.answer).toBe('查询日期无效，请核对日期。');
  expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
 }finally{quiet.mockRestore();}
});
test('a repaired valid saved-state model range reads canonical task scope after one original validation failure',async()=>{
 const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});try{
  const f=setup([calls('query_data',{datasetId:'work-rules',startDate:'2026-11-08',endDate:'2026-11-01'}),calls('query_data',{datasetId:'work-rules',startDate:'2025-01-01',endDate:'2025-12-31'}),final({answer:'目前没有保存工资规则。'})]);
  await f.send('查看2026年11月1日至8日目前保存的工资规则。');expect(f.repository.query).toHaveBeenCalledTimes(1);expect(f.repository.query.mock.calls[0][1].scope).toMatchObject({startDate:'2026-11-01',endDate:'2026-11-08'});
  expect(f.audits.filter(entry=>entry.phase==='tool-recovery'&&entry.status==='error')).toHaveLength(1);
 }finally{quiet.mockRestore();}
});
test('work-salary remains a dated history query and never enters saved-state cache',async()=>{
 const f=setup([calls('query_data',{datasetId:'work-salary',startDate:'2026-06-01',endDate:'2026-06-30'}),final({answer:'该日期范围没有工资登记记录。'})],'work-salary');
 await f.send('查看2026年6月工资登记历史。');expect(f.repository.query.mock.calls[0][1].scope).toMatchObject({startDate:'2026-06-01',endDate:'2026-06-30'});
 const prompt=f.provider.mock.calls[0][1].find(item=>item.role==='system').content;expect(prompt).toContain('工资登记work-salary是按日期范围查询的历史记录');
});
