jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Live DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Live DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Live provider forbidden');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const captured=require('../fixtures/aiQueryWindowN06Recorded.json');
const rawAnswer=JSON.parse(captured.responses[1].content).answer;
const prefix=rawAnswer.split('几点解读：')[0];
const outcomes=[];
const memoryStore={list:jest.fn(async()=>({files:[],warnings:[]}))};
function cardsReplay(claim,{complete=false,capturedExact=false}={}){
  const source=structuredClone(captured.result.datasets[0]);
  source.rows=source.rows.map((row,index)=>Object.fromEntries(Object.entries({...row,cardId:'offline-window-card-'+index}).filter(([key])=>!key.endsWith('Ref'))));
  const wanted=capturedExact?rawAnswer:prefix+claim;
  const response={role:'assistant',content:JSON.stringify({...JSON.parse(captured.responses[1].content),answer:wanted})};
  const f=fixture([structuredClone(captured.responses[0]),response],{memoryStore,clock:()=>new Date(source.asOf)});
  f.repository.query.mockImplementation(async(_,args)=>{
    const data=structuredClone(source),scope={startDate:args.scope.startDate,endDate:args.scope.endDate};
    if(complete){data.truncated=false;data.totalCount=data.rows.length;}
    data.queryMeta={...data.queryMeta,queryId:args.queryId,requestedScope:args.requestedScope||scope,effectiveScope:scope,
      ...(complete?{rowsComplete:true,matchedRowCount:data.rows.length}:{}),returnedRowCount:data.rows.length};
    return{...f.raw,scope:args.scope,asOf:data.asOf,datasets:[data]};
  });
  const send=()=>f.send(captured.message);
  return{f,send,wanted};
}
function durable(f,result){
  expect(f.provider).toHaveBeenCalledTimes(2);expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.provider.mock.calls[1][2]).toEqual([]);expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);
  expect(f.state.conversationStore.append.mock.calls[0][2].business.datasets).toEqual(result.datasets);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
}
test('N06 recorded window regression packet retains every approved card fact and removes both unsupported full-source conclusions',async()=>{
  const {f,send}=cardsReplay('',{capturedExact:true}),result=await send();durable(f,result);
  expect(result.answer).not.toContain('所有卡的临时额度目前均为 0');
  expect(result.answer).not.toContain('在信用卡里相对最早');
  for(const row of captured.result.datasets[0].rows)expect(result.answer).toContain(row.name);
  expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:81,returnedRowCount:10,rowsComplete:false,rankingComplete:false});
  outcomes.push({name:'exact paid N06 packet',originalRequestId:captured.requestId,answer:result.answer});
});
test.each([
  ['所有卡的临时额度目前均为0元。','所有卡的临时额度'],
  ['全部卡片临时额度为0元。','全部卡片临时额度'],
  ['每张卡的临时额度都是0元。','每张卡的临时额度'],
  ['登记到期月份中，示例Visa在信用卡里最早到期。','最早到期'],
  ['示例Visa是所有信用卡里最晚到期的。','最晚到期'],
  ['示例Visa的临时额度在所有卡中最高。','所有卡中最高'],
  ['All cards have temporary limits of 0.00.','All cards have'],
  ['示例Visa has the earliest expiration among all cards.','earliest expiration'],
  ['当前展示的卡片额度均为0元，所有卡片额度也都为0元。','所有卡片额度也都'],
  ['All displayed cards have limits of 0.00, 示例Visa is earliest among all credit cards.','earliest among all credit cards'],
  ['本次展示10张但所有卡临时额度均0元。','所有卡临时额度均'],
  ['所有卡均未确认币种。','所有卡均未确认币种'],
])('a 10/81 approved window rejects an unrestricted property or wrong-key extreme: %s',async(claim,fragment)=>{
  const {f,send}=cardsReplay(claim),result=await send();durable(f,result);expect(result.answer).not.toContain(fragment);
  expect(result.answer).toContain('本次展示 10 行');outcomes.push({name:claim,answer:result.answer});
});
test.each([
  '当前展示的所有卡临时额度均为0元。',
  '在当前展示的信用卡中，示例Visa登记到期月份最早。',
  '前10张卡的临时额度均为0元。',
  '这些卡的临时额度均为0元。',
  'All displayed cards have temporary limits of 0.00.',
  '不能由当前展示的卡片确认所有卡的临时额度均为0元。',
  '目前尚未确认所有卡的币种。',
])('explicit displayed-window facts and honest uncertainty remain usable: %s',async claim=>{
  const {f,send}=cardsReplay(claim),result=await send();durable(f,result);
  expect(result.answer).toContain(claim);outcomes.push({name:claim,answer:result.answer});
});
test('complete approved rows still establish all cards and expiry extrema',async()=>{
  const claim='所有卡的临时额度均为0元。示例Visa在信用卡里最早到期。';
  const {f,send}=cardsReplay(claim,{complete:true}),result=await send();durable(f,result);
  expect(result.answer).toContain('所有卡的临时额度均为0元');expect(result.answer).toContain('最早到期');
  expect(result.datasets[0].queryMeta.rowsComplete).toBe(true);outcomes.push({name:'complete rows',answer:result.answer});
});
test.each([
  ['所有匹配记录总数81条。',false],
  ['所有卡片的临时额度合计0元。',true],
])('metadata counts survive while missing attribute summaries do not: %s',async(claim,remove)=>{
  const {f,send}=cardsReplay(claim),result=await send();durable(f,result);
  if(remove)expect(result.answer).not.toContain(claim);else expect(result.answer).toContain(claim);
  outcomes.push({name:claim,answer:result.answer});
});
test.each([['所有流水支出合计100.00元。',true],['所有流水支出合计5,000元。',true],['所有流水收入合计100.00元。',false],['这笔支出金额最高，为100.00元。',true],['这笔支出金额最高，为5,000元。',true],['这笔支出金额最高，为5元。',false],['这笔收入金额最高，为100.00元。',false],['这笔支出发生时间最早。',false],['所有流水都已经定价。',true],['所有交易均为支出。',true]])(
  'full-range summaries and only the approved ranking key remain usable: %s',async(claim,keep)=>{
    const f=fixture([calls('query_data',{datasetId:'finance-transactions',direction:'expense',sort:'amountDesc',limit:1}),final({answer:claim})],{memoryStore});
    const actualAmount=claim.includes('5,000')?'5000.00':'100.00';
    f.raw.datasets=[{datasetId:'finance-transactions',domain:'finance',title:'收支明细',columns:[{key:'date',label:'日期',type:'date'},{key:'category',label:'分类',type:'text'},{key:'amountCNY',label:'金额',type:'money'}],
      rows:[{date:'2026-11-07',category:'餐饮',amountCNY:actualAmount}],summary:{expense:actualAmount,income:'0.00',count:5,expenseCount:5,incomeCount:0,unpricedCount:0,currency:'CNY'},truncated:true,totalCount:5}];
    f.repository.query.mockImplementation(async(_,args)=>({...f.raw,scope:args.scope,datasets:f.raw.datasets.map(d=>({...d,queryMeta:{version:1,queryId:args.queryId,datasetId:d.datasetId,
      requestedScope:args.requestedScope||{startDate:args.scope.startDate,endDate:args.scope.endDate},effectiveScope:{startDate:args.scope.startDate,endDate:args.scope.endDate},filters:{direction:'expense',text:''},sort:'amountDesc',
      matchedRowCount:5,returnedRowCount:1,sourceRecordCount:5,rowsComplete:false,summaryComplete:true,rankingComplete:true,returnedDateRange:{startDate:'2026-11-07',endDate:'2026-11-07'},asOf:f.raw.asOf}}))}));
    const result=await f.send('查看本月支出明细，按金额降序排列，仅展示1条。');
    if(keep)expect(result.answer).toContain(claim);else expect(result.answer).not.toContain(claim);
    expect(f.repository.query).toHaveBeenCalledTimes(1);expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);outcomes.push({name:claim,answer:result.answer});
  });
test.each(['全部信用卡临时额度为0元。','所有信用卡最早到期的是示例Visa。','所有卡均未确认币种。'])(
  'complete type counts cannot mask partial or unavailable card attributes in actual service prose: %s',claim=>{
    const {buildQueryAnswer}=require('../../src/modules/ai/service/v3Service');
    const cards=structuredClone(captured.result.datasets[0]);
    const counts={datasetId:'card-counts',domain:'card',title:'卡片数量',columns:[{key:'type',label:'类型',type:'text'},{key:'count',label:'数量',type:'number'}],
      rows:[{type:'信用卡',count:20}],summary:{count:20,totalCount:20},truncated:false,
      queryMeta:{queryId:'q_222222222222222222222222',matchedRowCount:1,returnedRowCount:1,rowsComplete:true,summaryComplete:true,rankingComplete:false}};
    const result=buildQueryAnswer(prefix+claim,[counts,cards]);expect(result).not.toContain(claim);
    expect(result).toContain('示例卡片 01');outcomes.push({name:claim,multipleSources:true,answer:result});
  });
test.each([['购汇最早发生于2026-05-01。',true],['购汇最早发生于2026-05-02。',false],['购汇在所有分类里最早发生于2026-05-01。',false]])(
  'a published category date bound stays with that exact category/date and cannot rank unseen categories: %s',(claim,keep)=>{
    const {buildQueryAnswer}=require('../../src/modules/ai/service/v3Service');
    const data={datasetId:'finance-categories',domain:'finance',title:'分类收支',columns:[{key:'category',type:'text'},{key:'firstDate',type:'date'},{key:'lastDate',type:'date'}],
      rows:[{category:'购汇',firstDate:'2026-05-01',lastDate:'2026-05-31'}],summary:{},truncated:true,
      queryMeta:{queryId:'q_333333333333333333333333',matchedRowCount:23,returnedRowCount:1,rowsComplete:false,summaryComplete:true,rankingComplete:false}};
    const result=buildQueryAnswer(claim,[data]);if(keep)expect(result).toContain(claim);else expect(result).not.toContain(claim);
    outcomes.push({name:claim,answer:result});
  });
afterAll(()=>{
 expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
 expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});

