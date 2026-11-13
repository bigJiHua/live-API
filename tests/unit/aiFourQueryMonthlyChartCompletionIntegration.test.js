jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,final}=require('../fixtures/aiV3MemoryFixture');
const paid=require('../fixtures/aiFourQueryMonthlyChartPaidRegression.json');
const mode='production',reports=[];
function capturedRound(index){return{role:'assistant',content:paid.providers[index].content||null,tool_calls:structuredClone(paid.providers[index].toolCalls).map(({index,...call})=>call)};}
function setup({finalKind='controlled',missing=false,scopeMismatch=false,wrongChartId=false,wrongChartDataset=false}={}){
 const finalization=(config,messages,tools,options)=>{
  if(finalKind==='captured-extraneous')return capturedRound(2);
  if(finalKind==='malformed')return{role:'assistant',content:'Final response is not JSON.'};
  const approved=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).flatMap(p=>p.datasets||[]);
  const finance=approved.find(d=>d.datasetId==='finance-monthly');
  return final({answer:'已按各部分独立查询。工资记录属于已保存的登记信息，不代表银行到账。资产保存总额币种未确认。',proposal:null,proposals:null,clarification:null,
   chart:{datasetId:wrongChartDataset?'work-salary':'finance-monthly',queryId:wrongChartId?'q_'+'f'.repeat(24):finance.queryMeta.queryId,type:'bar',xKey:'month',yKeys:['income','expense'],title:'6月收入和支出'}});
 };
 const f=fixture([capturedRound(0),capturedRound(1),finalization],{clock:()=>new Date('2026-11-09T15:36:23.747Z'),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.state.businessPolicy.domains.push('asset','work');
 f.state.taskContext=structuredClone(paid.taskInput.taskContexts.tasks.at(-1));
 f.state.conversationStore.loadTaskContexts=jest.fn(async()=>structuredClone(paid.taskInput.taskContexts));
 f.state.conversationStore.loadQueryCoverage=jest.fn(async()=>({version:1,results:structuredClone(paid.taskInput.previousQueryCoverage)}));
 for(let i=0;i<paid.taskInput.userTurns.length-1;i++){
  f.history.push({role:'user',content:paid.taskInput.userTurns[i],turnId:'prior-'+i,sourceDate:paid.today});
  f.history.push({role:'assistant',content:paid.taskInput.priorAnswers[i]||'上轮查询未完成。',turnId:'prior-'+i,
   ...(paid.taskInput.priorAnswers[i]===null?{failure:{code:'AI_CHART_INVALID'}}:{})});
 }
 f.repository.query.mockImplementation(async(_,args)=>{
  const source=paid.tools.find(t=>t.originalArgs.datasetId===args.datasetId);
  if(!source)throw Error('Unexpected query after complete evidence: '+args.datasetId);
  const copy=structuredClone(source.result.datasets[0]);copy.queryMeta.queryId=args.queryId;
  if(missing&&args.datasetId==='asset-snapshots'){copy.queryMeta.rowsComplete=false;copy.queryMeta.matchedRowCount=null;copy.truncated=true;}
  if(scopeMismatch&&args.datasetId==='asset-snapshots'){copy.queryMeta.requestedScope.startDate='2026-10-01';copy.queryMeta.effectiveScope.startDate='2026-10-01';}
  return{scope:args.scope,asOf:copy.asOf,choices:{},datasets:[copy]};
 });
 return f;
}
test('complete captured evidence receives no tools and hard-rejects further reads',async()=>{
 const f=setup({finalKind:'captured-extraneous'});
 await expect(f.send(paid.message)).rejects.toMatchObject({code:'AI_LOOP_BLOCKED'});
 const third=f.provider.mock.calls[2];expect(third[2].length===0).toBe(true);expect(third[3].toolChoice).toBe('none');
 expect(f.repository.query).toHaveBeenCalledTimes(4);expect(f.state.conversationStore.append).not.toHaveBeenCalled();
 expect(f.audits.filter(a=>a.phase==='tool-recovery')).toHaveLength(1);
 reports.push({name:'captured-extraneous',mode,providerFixtureCalls:3,repositories:4,finalToolsEmpty:third[2].length===0,notPersisted:true});
});
test('controlled final JSON uses real schema, chart, claims, persistence and receipt after all four captured reads',async()=>{
 const f=setup(),result=await f.send(paid.message);
 const third=f.provider.mock.calls[2];expect(third[2].length===0).toBe(true);
 expect(f.provider).toHaveBeenCalledTimes(3);expect(f.repository.query).toHaveBeenCalledTimes(4);
 expect(f.audits.filter(a=>a.phase==='tool-recovery')).toHaveLength(1);
 const tasks=JSON.parse(f.provider.mock.calls[0][1].find(m=>m.content.startsWith('TASK_INPUT:')).content.slice(12)).currentTasks;
 expect(tasks).toEqual(paid.taskInput.currentTasks);
 expect(result.datasets).toHaveLength(4);
 for(const expected of paid.tools.map(t=>t.result.datasets[0])){
  const actual=result.datasets.find(d=>d.datasetId===expected.datasetId);
  expect(actual.queryMeta).toEqual({...expected.queryMeta,queryId:actual.queryMeta.queryId});
  const publicRows=rows=>rows.map(({ref,cardRef,poolRef,...row})=>row);
  expect(publicRows(actual.rows)).toEqual(publicRows(expected.rows));expect(actual.summary).toEqual(expected.summary);
 }
 const finance=result.datasets.find(d=>d.datasetId==='finance-monthly');
 expect(result.chart).toMatchObject({datasetId:'finance-monthly',queryId:finance.queryMeta.queryId,type:'bar',xKey:'month',yKeys:['income','expense']});
 expect(result.answer).toContain('5784.61');expect(result.answer).toContain('3911.24');expect(result.answer).toContain('268');
 expect(result.answer).toContain('2026-06-01');expect(result.answer).toContain('2026-09-01');expect(result.answer).toContain('2026-11-01');
 expect(result.answer).toContain('币种未确认');expect(result.answer).toContain('不代表银行到账');
 expect(result.datasets.find(d=>d.datasetId==='work-salary').rows).toEqual([]);
 const saved=f.state.conversationStore.append.mock.calls[0][2];expect(saved.answer).toBe(result.answer);expect(saved.business.chart).toEqual(result.chart);
 expect(saved.business.datasets).toEqual(result.datasets);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
 reports.push({name:'controlled-final',mode,notPaidAcceptance:true,providerFixtureCalls:f.provider.mock.calls.length,repositoryFixtureQueries:4,
  finalToolsEmpty:third[2].length===0,answer:result.answer,chart:result.chart,coverage:result.datasets.map(d=>({id:d.datasetId,rows:d.rows.length,summary:d.summary,meta:d.queryMeta}))});
});
test('unknown source coverage keeps third provider tools available',async()=>{
 const f=setup({finalKind:'captured-extraneous',missing:true});await expect(f.send(paid.message)).rejects.toMatchObject({code:'AI_TOOL_ARGUMENT_INVALID'});
 expect(f.provider.mock.calls[2][2].length).toBeGreaterThan(0);expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});
test('wrong effective scope is refused before completion or persistence',async()=>{
 const f=setup({scopeMismatch:true});await expect(f.send(paid.message)).rejects.toMatchObject({code:'AI_PREVIEW_INVALID'});
 expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});
test('schema-invalid controlled final is refused without persistence',async()=>{
 const f=setup({finalKind:'malformed'});await expect(f.send(paid.message)).rejects.toMatchObject({code:'AI_INVALID_RESULT'});
 expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});
test('existing proved monthly chart normalization pins a stale model id to the current query',async()=>{
 const f=setup({wrongChartId:true}),result=await f.send(paid.message);
 expect(result.chart.queryId).toBe(result.datasets.find(d=>d.datasetId==='finance-monthly').queryMeta.queryId);
 expect(result.chart.queryId).not.toBe('q_'+'f'.repeat(24));
});
test('unproved chart dataset is refused without persistence',async()=>{
 const f=setup({wrongChartDataset:true});await expect(f.send(paid.message)).rejects.toMatchObject({code:'AI_CHART_INVALID'});
 expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});
afterAll(()=>{
 expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
 expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
