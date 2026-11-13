jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Live DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Live DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Live provider forbidden');})}));
const {fixture,calls,final}=require('../fixtures/aiV3MemoryFixture');
const outcomes=[];
function setup(answer,{rows=[{category:'工资',direction:1,amountCNY:'500.00'},{category:'餐饮',direction:0,amountCNY:'300.00'}],sort='categoryAmountDesc',rankingComplete=true,complete=false}={}){
 const f=fixture([calls('query_data',{datasetId:'finance-categories',startDate:'2026-06-01',endDate:'2026-06-30',limit:2}),final({answer})],{memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.repository.query.mockImplementation(async(_,input)=>({scope:input.scope,asOf:f.raw.asOf,choices:{},datasets:[{datasetId:'finance-categories',domain:'finance',title:'分类收支',asOf:f.raw.asOf,
  columns:[{key:'category',label:'分类',type:'text'},{key:'direction',label:'方向',type:'number'},{key:'amountCNY',label:'金额',type:'money'}],rows,
  summary:{expense:'400.00',income:'500.00',count:3,expenseCount:2,incomeCount:1,unpricedCount:0,currency:'CNY'},truncated:!complete,totalCount:complete?rows.length:3,
  queryMeta:{version:1,queryId:input.queryId,datasetId:'finance-categories',requestedScope:input.requestedScope||input.scope,effectiveScope:{startDate:'2026-06-01',endDate:'2026-06-30'},filters:{direction:'both',text:''},sort,
  matchedRowCount:complete?rows.length:3,returnedRowCount:rows.length,sourceRecordCount:3,rowsComplete:complete,summaryComplete:true,rankingComplete,returnedDateRange:null,asOf:f.raw.asOf}}]}));return f;
}
test.each([
 ['餐饮支出最高。',true,{}],
 ['餐饮支出最高，为300.00元。',true,{}],
 ['工资收入最高，为500.00元。',true,{}],
 ['在所有支出分类中，餐饮支出最高，为300.00元。',true,{}],
 ['餐饮在所有分类中支出最高。',true,{}],
 ['在所有分类中，工资收入最高，为500.00元。',true,{}],
 ['所有分类支出均为300.00元。',false,{}],
 ['在所有分类中，支出均为300.00元，餐饮支出最高。',false,{}],
 ['餐饮收入最高。',false,{}],
 ['餐饮支出最高，为500.00元。',false,{}],
 ['餐饮支出最低。',false,{}],
 ['餐饮支出最高。',false,{rankingComplete:false}],
])('combined actual V3 service binds category rank and its direction/amount/coverage: %s',async(answer,keep,options)=>{
 const f=setup(answer,options),result=await f.send('查看6月分类收支，仅展示2条。');
 if(keep)expect(result.answer).toContain(answer);else expect(result.answer).not.toContain(answer);
 expect(f.provider).toHaveBeenCalledTimes(2);expect(f.repository.query).toHaveBeenCalledTimes(1);
 expect(result.datasets[0].rows).toHaveLength(2);expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:3,returnedRowCount:2,rowsComplete:false});
 expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);
 expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
 outcomes.push({answer,keep,result:result.answer,queryMeta:result.datasets[0].queryMeta});
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
 });
