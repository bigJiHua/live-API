jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real database forbidden');}),getConnection:jest.fn(()=>{throw Error('Real database forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden in integration replay');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const asOf='2026-11-09T16:24:00.808Z';
const scope={startDate:'2026-06-01',endDate:'2026-06-30'};
function monthly(){return {datasetId:'finance-monthly',domain:'finance',title:'收支月度趋势',
 columns:[{key:'month',label:'月份',type:'date'},{key:'income',label:'收入',type:'money'},{key:'expense',label:'支出',type:'money'},{key:'count',label:'笔数',type:'number'},{key:'net',label:'净收支',type:'money'},{key:'unpricedCount',label:'未定价笔数',type:'number'}],
 rows:[{month:'2026-06',income:'100.00',expense:'50.00',count:2,net:'50.00',unpricedCount:0}],summary:{income:'100.00',expense:'50.00',count:2,incomeCount:1,expenseCount:1,net:'50.00',surplus:'50.00',deficit:'0.00',unpricedCount:0,currency:'CNY'},
 policy:'本月完整汇总',asOf,isEstimated:false,truncated:false,
 queryMeta:{version:1,queryId:'q_'+'1'.repeat(24),datasetId:'finance-monthly',requestedScope:{...scope},effectiveScope:{...scope},filters:{direction:'both',text:''},sort:'monthAsc',matchedRowCount:1,returnedRowCount:1,sourceRecordCount:2,rowsComplete:true,summaryComplete:true,rankingComplete:true,returnedDateRange:null,asOf}};}
function account(){const range={startDate:'2026-11-01',endDate:'2026-11-10'};return {datasetId:'account-balances',domain:'account',title:'账户余额快照',
 columns:[{key:'name',label:'账户',type:'text'},{key:'type',label:'类型',type:'text'},{key:'balance',label:'余额',type:'money'},{key:'currency',label:'币种',type:'text'},{key:'updatedAt',label:'最后保存时间',type:'text'}],
 rows:[{name:'日常账户',type:'debit',balance:'509.00',currency:'CNY',updatedAt:'2026-11-08T04:20:44.568Z'}],summary:{},policy:'目前已保存状态',asOf,isEstimated:false,truncated:false,
 queryMeta:{version:1,queryId:'q_'+'2'.repeat(24),datasetId:'account-balances',requestedScope:range,effectiveScope:{...range},filters:{direction:'both',text:''},sort:'dateDesc',matchedRowCount:1,returnedRowCount:1,sourceRecordCount:null,rowsComplete:true,summaryComplete:false,rankingComplete:false,returnedDateRange:null,asOf}};}
function setup(dataset,answer){
 const scripts=[calls('query_data',{datasetId:dataset.datasetId,startDate:dataset.queryMeta.effectiveScope.startDate,endDate:dataset.queryMeta.effectiveScope.endDate,limit:10}),final({answer})];
 const f=fixture(scripts,{clock:()=>new Date(asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.repository.query.mockImplementation(async(_,args)=>{const copy=structuredClone(dataset);copy.queryMeta.queryId=args.queryId;return {scope:args.scope,asOf,choices:f.raw.choices,datasets:[copy]};});
 return f;
}
function assertUnchanged(f,result,source){
 const dataset=result.datasets[0];
 expect(dataset.rows).toEqual(source.rows);expect(dataset.summary).toEqual(source.summary);expect(dataset.asOf).toBe(asOf);expect(dataset.queryMeta.asOf).toBe(asOf);
 expect(dataset.queryMeta.effectiveScope).toEqual(source.queryMeta.effectiveScope);
 expect(f.history.at(-1).content).toBe(result.answer);expect(f.history.at(-1).business.datasets).toEqual(result.datasets);
 expect(result.proposal).toBeUndefined();expect(result.inputCandidate).toBeUndefined();
}
test('cross-midnight read date is explicitly UTC and local business today remains November 10 through actual service',async()=>{
 const source=monthly(),f=setup(source,'6月收入100.00元，支出50.00元。数据截至2026-11-09。'),result=await f.send('查看6月份收入和支出月度汇总，并说明数据范围。');
 expect(result.answer).toMatch(/2026-11-09[^。\n]*UTC|UTC[^。\n]*2026-11-09/);
 expect(result.answer).toContain('100.00');expect(result.answer).toContain('50.00');
 expect(result.answer).not.toMatch(/数据截至\s*2026-11-09[。\n]/);
 const input=JSON.parse(f.provider.mock.calls[0][1].find(message=>message.role==='user'&&message.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
 expect(input.today).toBe('2026-11-10');expect(input.businessTimeZone).toBe('Asia/Shanghai');expect(input.timestampTimeZone).toBe('UTC');
 assertUnchanged(f,result,source);
});
test.each(['','（北京时间）','（UTC+08:00）'])('same UTC clock receives its correct zone without dropping adjacent balance: %s',async label=>{
 const source=account(),f=setup(source,`日常账户｜余额509.00 CNY｜最后保存2026-11-08 04:20${label}。`),result=await f.send('查看当前已保存的账户余额和最后保存时间。');
 expect(result.answer).toMatch(/04:20[^。\n]*UTC/);expect(result.answer).not.toMatch(/04:20[^。\n]*(?:北京时间|UTC\+08)/);
 expect(result.answer).toContain('509.00');assertUnchanged(f,result,source);
});
test('a different clock cannot borrow the same row date or amount as timestamp evidence',async()=>{
 const source=account(),f=setup(source,'日常账户｜余额509.00 CNY｜最后保存2026-11-08 09:20 UTC。'),result=await f.send('查看当前已保存的账户余额和最后保存时间。');
 expect(result.answer).not.toContain('09:20');expect(result.answer).toContain('509.00');assertUnchanged(f,result,source);
});
test('explicit period cutoff stays a business date even when it equals the UTC read day',async()=>{
 const source=monthly();source.rows[0].month='2026-11';source.queryMeta.requestedScope={startDate:'2026-11-01',endDate:'2026-11-09'};source.queryMeta.effectiveScope={...source.queryMeta.requestedScope};
 const f=setup(source,'查询范围截至2026-11-09，收入100.00元，支出50.00元。'),result=await f.send('查看2026年11月1日至9日收入和支出月度汇总。');
 expect(result.answer).toContain('查询范围截至2026-11-09');expect(result.answer).not.toMatch(/查询范围截至2026-11-10/);assertUnchanged(f,result,source);
});
