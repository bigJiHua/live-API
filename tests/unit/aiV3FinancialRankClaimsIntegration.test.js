jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,calls,final}=require('../fixtures/aiV3MemoryFixture');
const capture=require('../fixtures/aiFinancialRankFixture.json');
function setup(answer){const f=fixture([calls('query_data',{datasetId:'finance-daily',startDate:'2026-06-01',endDate:'2026-06-30',limit:50}),(_,messages)=>{const tool=messages.filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);return final({...capture.output,answer,chart:{...capture.output.chart,queryId:tool.datasets[0].queryMeta.queryId}});}],{clock:()=>new Date(capture.dataset.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.repository.query.mockImplementation(async(_,input)=>{const d=structuredClone(capture.dataset);d.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[d],choices:{},asOf:d.asOf};});return f;}
test('actual C04 passes actual combined V3 service with all 30 row facts and chart preserved but wrong rank annotations absent',async()=>{
 const f=setup(capture.output.answer),result=await f.send(capture.message);
 expect(result.datasets).toHaveLength(1);expect(result.datasets[0].rows).toEqual(capture.dataset.rows);expect(result.chart).toMatchObject({datasetId:'finance-daily',xKey:'date',yKeys:['income','expense']});expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);
 expect(result.answer).not.toContain('全月支出最高的一天');expect(result.answer).not.toContain('全月支出第二高');
 for(const row of result.datasets[0].rows){const [y,m,d]=row.date.split('-');expect(result.answer).toMatch(new RegExp(Number(m)+'月0?'+Number(d)+'日'));expect(result.answer).toContain(row.income);expect(result.answer).toContain(row.expense);}
 expect(result.answer).toContain('全月收入最高');expect(result.answer).toContain('净结余最多');
 const saved=f.state.conversationStore.append.mock.calls[0][2];expect(saved.answer).toBe(result.answer);expect(saved.business.datasets).toEqual(result.datasets);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 const approved=f.provider.mock.calls[1][1].filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);expect(result.datasets[0].rows).toEqual(approved.datasets[0].rows);
 expect(f.repository.query).toHaveBeenCalledTimes(1);expect(f.provider).toHaveBeenCalledTimes(capture.providerCalls);
});
test('actual combined service preserves correct maximum and second and third rankings',async()=>{
 const text='6月2日支出1093.97元，支出最高。\n6月18日支出1015.19元，支出第二高。\n6月8日支出711.30元，支出第三高。';
 const f=setup(text),result=await f.send(capture.message);for(const ordinal of ['支出最高','支出第二高','支出第三高'])expect(result.answer).toContain(ordinal);
});
test('actual combined service removes borrowed amount/field/date rank statements',async()=>{
 const text='6月18日支出1093.97元，支出最高。\n6月2日收入1093.97元，收入最高。';const f=setup(text),result=await f.send(capture.message);
 expect(result.answer).not.toContain('支出最高');expect(result.answer).not.toContain('收入最高');expect(result.datasets[0].rows).toEqual(capture.dataset.rows);
});
test('actual combined service continues rejecting fake ledger execution after financial ranking text',async()=>{
 const f=setup('6月2日支出最高。\n我已经完成入账。');await expect(f.send(capture.message)).rejects.toMatchObject({code:'AI_RESULT_CLAIM_MISMATCH'});expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
});
function setupExtra(dataset,args,answer,message,chart){const f=fixture([calls('query_data',args),(_,messages)=>{const tool=messages.filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);return final({answer,proposal:null,proposals:null,clarification:null,chart:chart?{...chart,queryId:tool.datasets[0].queryMeta.queryId}:null});}],{clock:()=>new Date(capture.dataset.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.repository.query.mockImplementation(async(_,input)=>{const d=structuredClone(dataset);d.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[d],choices:{},asOf:d.asOf};});return {f,message};}
function monthlyDataset(){const d=structuredClone(capture.dataset);d.datasetId='finance-monthly';d.title='收支月度趋势';d.columns=d.columns.map(c=>c.key==='date'?{key:'month',label:'月份',type:'text'}:c);d.rows=[
 {month:'2026-05',expense:'100.00',income:'10.00',net:'-90.00',count:2,unpricedCount:0},
 {month:'2026-06',expense:'200.00',income:'20.00',net:'-180.00',count:2,unpricedCount:0},
 {month:'2026-07',expense:'300.00',income:'30.00',net:'-270.00',count:2,unpricedCount:0},
 ];d.summary={income:'60.00',expense:'600.00',count:6,incomeCount:3,expenseCount:3,unpricedCount:0,currency:'CNY'};
 Object.assign(d.queryMeta,{datasetId:d.datasetId,effectiveScope:{startDate:'2026-05-01',endDate:'2026-07-31'},requestedScope:{startDate:'2026-05-01',endDate:'2026-07-31'},matchedRowCount:3,returnedRowCount:3,sourceRecordCount:6,sort:'monthAsc',returnedDateRange:null});d.truncated=false;d.totalCount=3;return d;}
test('actual combined service keeps correct full monthly rankings and removes a wrong month ordinal',async()=>{
 const {f,message}=setupExtra(monthlyDataset(),{datasetId:'finance-monthly',startDate:'2026-05-01',endDate:'2026-07-31',limit:10},'2026-07支出最高。\n2026-06支出第二高。\n2026-05支出最高。','查看2026年5月至7月收支月度汇总及月度排名。',null);
 const result=await f.send(message);expect(result.answer).toContain('2026-07支出最高');expect(result.answer).toContain('2026-06支出第二高');expect(result.answer).not.toContain('2026-05支出最高');expect(result.datasets[0].queryMeta.rowsComplete).toBe(true);
});
test('actual combined service keeps partial category amount rank from same direction with supplemental window proof',async()=>{
 const d=structuredClone(capture.dataset);d.datasetId='finance-categories';d.title='分类收支';d.columns=[{key:'category',label:'分类',type:'text'},{key:'direction',label:'收支',type:'number'},{key:'amountCNY',label:'金额',type:'money'},{key:'count',label:'笔数',type:'number'},{key:'unpricedCount',label:'未定价',type:'number'}];d.rows=[{category:'收入A',direction:1,amountCNY:'500.00',count:1,unpricedCount:0},{category:'餐饮',direction:0,amountCNY:'300.00',count:1,unpricedCount:0}];d.summary={income:'500.00',expense:'400.00',count:3,incomeCount:1,expenseCount:2,unpricedCount:0,currency:'CNY'};Object.assign(d.queryMeta,{datasetId:d.datasetId,matchedRowCount:3,returnedRowCount:2,sourceRecordCount:3,sort:'categoryAmountDesc',rowsComplete:false,rankingComplete:true,returnedDateRange:null});d.truncated=true;d.totalCount=3;
 const {f,message}=setupExtra(d,{datasetId:'finance-categories',startDate:'2026-06-01',endDate:'2026-06-30',limit:2},'餐饮支出300.00元，支出最高。','查看2026年6月收支分类和各收支方向金额排名，最多展示2条。',null);
 const result=await f.send(message);expect(result.answer).toContain('餐饮支出300.00元，支出最高');expect(result.datasets[0].queryMeta.rowsComplete).toBe(false);expect(result.datasets[0].queryMeta.rankingComplete).toBe(true);
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
