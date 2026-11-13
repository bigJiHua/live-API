jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw new Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw new Error('Real provider forbidden');})}));
const {fixture,final,calls,now}=require('../fixtures/aiV3MemoryFixture');
const mode='after',reports=[];
const base={
  "datasets": {
    "finance-monthly": {
      "rows": [
        {
          "month": "2026-05",
          "expense": "6644.73",
          "income": "8160.37",
          "count": 252,
          "expenseCount": 189,
          "incomeCount": 63,
          "unpricedCount": 0
        },
        {
          "month": "2026-06",
          "expense": "5784.61",
          "income": "3911.24",
          "count": 268,
          "expenseCount": 153,
          "incomeCount": 115,
          "unpricedCount": 0
        }
      ]
    }
  }
};
const scope={startDate:'2026-05-01',endDate:'2026-06-30'};
const money=value=>{const[whole,fraction='']=value.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));};
const text=value=>{const magnitude=value<0n?-value:value;return(value<0n?'-':'')+String(magnitude/100n)+'.'+String(magnitude%100n).padStart(2,'0');};
function monthDataset(single=false,publishedDirections=false){
  const rows=base.datasets['finance-monthly'].rows.filter(row=>['2026-05','2026-06'].includes(row.month)&&(!single||row.month==='2026-06'));
  const summary={income:text(rows.reduce((sum,row)=>sum+money(row.income),0n)),expense:text(rows.reduce((sum,row)=>sum+money(row.expense),0n)),
    count:rows.reduce((sum,row)=>sum+row.count,0),incomeCount:rows.reduce((sum,row)=>sum+row.incomeCount,0),expenseCount:rows.reduce((sum,row)=>sum+row.expenseCount,0),
    unpricedCount:0,currency:'CNY',incomplete:false,startDate:single?'2026-06-01':scope.startDate,endDate:scope.endDate};
  const columns=[{key:'month',label:'月份',type:'date'},{key:'income',label:'收入',type:'money'},{key:'expense',label:'支出',type:'money'},
    {key:'count',label:'笔数',type:'number'},{key:'unpricedCount',label:'未定价笔数',type:'number'},
    ...(publishedDirections?[{key:'incomeCount',label:'收入笔数',type:'number'},{key:'expenseCount',label:'支出笔数',type:'number'}]:[])];
  return {datasetId:'finance-monthly',domain:'finance',title:'收支月度趋势',columns,
    rows:rows.map(row=>Object.fromEntries(columns.map(column=>[column.key,row[column.key]]))),summary,policy:'独立已保存全范围月度汇总。',isEstimated:false,truncated:false,asOf:now().toISOString(),
    queryMeta:{version:1,queryId:'q_000000000000000000000001',datasetId:'finance-monthly',requestedScope:{startDate:summary.startDate,endDate:summary.endDate},effectiveScope:{startDate:summary.startDate,endDate:summary.endDate},
      filters:{direction:'both',text:''},sort:'monthAsc',matchedRowCount:rows.length,returnedRowCount:rows.length,sourceRecordCount:summary.count,rowsComplete:true,summaryComplete:true,rankingComplete:false,returnedDateRange:null,asOf:now().toISOString()}};
}
function fundDataset(){return{datasetId:'fund-history',domain:'fund',title:'基金收益历史',columns:[{key:'name',label:'基金',type:'text'},{key:'date',label:'日期',type:'date'},
  {key:'profit',label:'收益增量',type:'decimal'},{key:'capitalDelta',label:'本金增量',type:'money'}],
  rows:[{name:'示例基金',date:'2026-06-02',profit:'8.0000',capitalDelta:'0.00'},{name:'示例基金',date:'2026-06-03',profit:'-8.0000',capitalDelta:'0.00'}],summary:{},policy:'已保存收益增量，仅原始记录。',asOf:now().toISOString(),isEstimated:false,truncated:false,
  queryMeta:{version:1,queryId:'q_000000000000000000000002',datasetId:'fund-history',requestedScope:{startDate:'2026-06-01',endDate:'2026-06-30'},effectiveScope:{startDate:'2026-06-01',endDate:'2026-06-30'},
    filters:{direction:'both',text:''},sort:'dateDesc',matchedRowCount:2,returnedRowCount:2,sourceRecordCount:null,rowsComplete:true,summaryComplete:false,rankingComplete:false,returnedDateRange:{startDate:'2026-06-02',endDate:'2026-06-03'},asOf:now().toISOString()}};}
async function replay(dataset,answer,message){
  const args={datasetId:dataset.datasetId,...dataset.queryMeta.effectiveScope,limit:10,...(dataset.domain==='finance'?{direction:'both',sort:'monthAsc'}:{})};
  const f=fixture([calls('query_data',args),final({answer,proposal:null,proposals:null,clarification:null,chart:null})],{memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
  f.state.businessPolicy.domains.push('fund');f.repository.query.mockImplementation(async(_,input)=>{const clone=structuredClone(dataset);clone.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[clone],choices:{},asOf:now().toISOString()};});
  const result=await f.send(message);reports.push({mode,inputAnswer:answer,actualAnswer:result.answer,datasets:result.datasets,mockProviderCalls:f.provider.mock.calls.length});
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();return result;
}
test('actual service rejects the full two-month incomeCount reused as May count',async()=>{
  const result=await replay(monthDataset(),'5月收入178笔。','查看2026-05-01至2026-06-30逐月收入、支出与笔数。');
  expect(result.answer.includes('5月收入178笔')).toBe(mode!=='after');
});
test('actual service preserves complete multi-month full-range directions',async()=>{
  const result=await replay(monthDataset(),'全范围收入178笔、支出342笔。','查看2026-05-01至2026-06-30逐月收入、支出与笔数。');
  expect(result.answer).toContain('全范围收入178笔、支出342笔');
});
test('actual service preserves exact full single-month income count',async()=>{
  const result=await replay(monthDataset(true),'6月收入115笔。','查看6月逐月收入与支出汇总。');expect(result.answer).toContain('6月收入115笔');
});
test('actual service can cite separately published same-month direction-count rows',async()=>{
  const result=await replay(monthDataset(false,true),'5月收入63笔，6月收入115笔。','查看2026-05-01至2026-06-30逐月收入、支出与笔数。');
  expect(result.answer.includes('5月收入63笔，6月收入115笔')).toBe(mode==='after');
});
test('actual fund-only service rejects a date-specific record count taken from profit 8.0000',async()=>{
  const result=await replay(fundDataset(),'6月2日共8笔收益记录。','查看6月基金收益历史，按登记记录展示。');
  expect(result.answer.includes('6月2日共8笔收益记录')).toBe(mode!=='after');
});
test('actual fund-only service rejects an unsupported full count taken from profit money',async()=>{
  const result=await replay(fundDataset(),'共8条收益记录。','查看6月基金收益历史，按登记记录展示。');
  expect(result.answer.includes('共8条收益记录')).toBe(mode!=='after');
});
test('actual fund-only service retains the correctly published matching and displayed counts',async()=>{
  const result=await replay(fundDataset(),'本次匹配2条收益记录，展示2条。','查看6月基金收益历史，按登记记录展示。');
  expect(result.answer).toContain('本次匹配2条收益记录');expect(result.answer).toContain('展示2条');
});
afterAll(()=>{
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
