jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,calls,final}=require('../fixtures/aiV3MemoryFixture');
const capture=require('../fixtures/aiDailyConditionFixture.json');
const positive=()=>capture.dataset.rows.filter(row=>Number(row.net)>0);
const dates=rows=>rows.map(row=>row.date+'（'+row.net+'）').join('、');
function setup(answer,{partial=false}={}){
 const f=fixture([calls('query_data',{datasetId:'finance-daily',startDate:'2026-06-01',endDate:'2026-06-30',direction:'both',sort:'dateDesc',limit:50}),(_,messages)=>{
  const approved=messages.filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);
  return final({...capture.output,answer,chart:{...capture.output.chart,queryId:approved.datasets[0].queryMeta.queryId}});
 }],{clock:()=>new Date(capture.dataset.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.state.queryContext={version:1,activeQuery:{startDate:'2026-06-01',endDate:'2026-06-30',direction:null,category:null,metric:'summary',status:'succeeded',periodSource:'explicit'},
  lastResults:[{...capture.dataset.queryMeta,source:'previous-turn',status:'succeeded',returnedRowCount:10,rowsComplete:false}]};
 f.state.taskContext={version:1,mode:'query',subject:'finance',targetDatasetId:'finance-daily',metric:'summary',querySort:'dateDesc',requireFreshQuery:true,
  scope:{startDate:'2026-06-01',endDate:'2026-06-30'},status:'succeeded',cardTypes:[],comparisonScopes:[],chartRequest:null};
 f.history.push({role:'user',content:'查看6月份逐日收入与支出的每日汇总。最多展示10条。',sourceDate:'2026-11-09'},
  {role:'assistant',content:'6月范围为2026-06-01至2026-06-30，匹配30天，展示10天，来源268笔流水。',queryContext:f.state.queryContext,taskContext:f.state.taskContext});
 f.repository.query.mockImplementation(async(_,input)=>{const d=structuredClone(capture.dataset);d.queryMeta.queryId=input.queryId;
  if(partial){d.rows=d.rows.slice(0,7);Object.assign(d.queryMeta,{returnedRowCount:7,rowsComplete:false,rankingComplete:false});d.truncated=true;d.queryMeta.returnedDateRange={startDate:'2026-06-24',endDate:'2026-06-30'};}
  return{scope:input.scope,datasets:[d],choices:{},asOf:d.asOf};});
 return f;
}
function verify(f,result){
 expect(result.datasets).toHaveLength(1);expect(result.datasets[0].summary).toEqual(capture.dataset.summary);
 expect(result.chart).toMatchObject({datasetId:'finance-daily',type:'line',xKey:'date',yKeys:['income','expense']});expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);
 const saved=f.state.conversationStore.append.mock.calls[0][2];expect(saved.answer).toBe(result.answer);expect(saved.business.datasets).toEqual(result.datasets);
 expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 const approved=f.provider.mock.calls[1][1].filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);
 expect(result.datasets[0].rows).toEqual(approved.datasets[0].rows);expect(result.datasets[0].summary).toEqual(approved.datasets[0].summary);
 expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.repository.query).toHaveBeenCalledTimes(1);
}
test('actual paid C04 body loses the false day-count and closed-list sentence while chart/source/history/recovery agree',async()=>{
 const f=setup(capture.output.answer),result=await f.send(capture.message);verify(f,result);
 expect(result.answer).not.toContain('仅有4天净收支为正');expect(result.answer).not.toContain('仅有4天');
 expect(result.answer).toContain('为全月最大单日净流出');expect(result.answer).toContain('收入高峰在6月2日');
 expect(result.datasets[0].rows).toEqual(capture.dataset.rows);expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:30,returnedRowCount:30,sourceRecordCount:268,rowsComplete:true});
});
test('correct positive closed date list and derived negative count survive actual numeric scrub without borrowing its pool',async()=>{
 const text='全月有7天净收支为正：'+dates(positive())+'。\n全月共有23天净收支为负。';
 const f=setup(text),result=await f.send(capture.message);verify(f,result);expect(result.answer).toContain('有7天净收支为正');expect(result.answer).toContain('共有23天净收支为负');
 for(const row of positive())expect(result.answer).toContain(row.date);
});
test('correct count with an incorrect closed date list is removed by actual service while chart is retained',async()=>{
 const f=setup('全月有7天净收支为正：'+dates(positive().slice(0,5))+'。'),result=await f.send(capture.message);verify(f,result);
 expect(result.answer).not.toContain('有7天净收支为正');expect(result.datasets[0].rows).toEqual(capture.dataset.rows);
});
test('a partial daily date window cannot publish a whole-month conditional count',async()=>{
 const f=setup('全月有7天净收支为正。',{partial:true}),result=await f.send(capture.message);verify(f,result);
 expect(result.answer).not.toContain('有7天净收支为正');expect(result.datasets[0].queryMeta.rowsComplete).toBe(false);expect(result.datasets[0].rows).toHaveLength(7);
});
test('correct date values and correct financial ranks remain beside an invalid aggregate sentence',async()=>{
 const text='2026-06-24：净收支9.12元。\n6月2日净结余最多。\n全月有4天净收支为正：'+dates(positive().slice(0,5))+'。';
 const f=setup(text),result=await f.send(capture.message);verify(f,result);
 expect(result.answer).toContain('2026-06-24：净收支9.12元');expect(result.answer).toContain('6月2日净结余最多');expect(result.answer).not.toContain('有4天净收支为正');
});
test('the real service still rejects false current execution claims before conditional-day normalization',async()=>{
 const f=setup(capture.output.answer+'\n我已经完成入账。');await expect(f.send(capture.message)).rejects.toMatchObject({code:'AI_RESULT_CLAIM_MISMATCH'});
 expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
