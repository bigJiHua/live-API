jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {financialRankIssues:issues,normalizeFinancialRankClaims:normalize}=require('../../src/modules/ai/service/queryFinancialRankClaims');
const {fixture,calls,final}=require('../fixtures/aiV3MemoryFixture'),capture=require('../fixtures/aiFinancialRankFixture.json');
const d=capture.dataset;
test('correct fully stated Chinese scope does not become a second row identity',()=>{
 for(const text of ['2026年6月1日至30日，6月2日支出最高。','2026年6月1日至6月30日，6月2日支出最高。','2026年6月1日至2026年6月30日，6月2日支出最高。','6月1日到30日，6月2日支出最高。']){expect(issues(text,[d])).toEqual([]);expect(normalize(text,[d])).toBe(text);}
});
test('wrong fully stated Chinese scope cannot borrow June maximum',()=>expect(issues('2026年5月1日至31日，6月2日支出最高。',[d]).length).toBeGreaterThan(0));
test('correct Chinese range does not authorize the wrong date or ordinal',()=>{
 expect(issues('2026年6月1日至30日，6月18日支出最高。',[d]).length).toBeGreaterThan(0);expect(issues('2026年6月1日至30日，6月8日支出第二高。',[d]).length).toBeGreaterThan(0);
});
function setup(answer){const f=fixture([calls('query_data',{datasetId:'finance-daily',startDate:'2026-06-01',endDate:'2026-06-30',limit:50}),(_,messages)=>{const tool=messages.filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);return final({...capture.output,answer,chart:{...capture.output.chart,queryId:tool.datasets[0].queryMeta.queryId}});}],{clock:()=>new Date(d.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});f.repository.query.mockImplementation(async(_,input)=>{const dataset=structuredClone(d);dataset.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[dataset],choices:{},asOf:dataset.asOf};});return f;}
test('actual combined service retains correct Chinese-scoped highest and original approved chart/history rows',async()=>{
 const f=setup('2026年6月1日至30日，6月2日支出1093.97元，支出最高。'),result=await f.send(capture.message);expect(result.answer).toContain('6月2日支出1093.97元，支出最高');expect(result.datasets[0].rows).toEqual(d.rows);expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
});
test('actual combined service rejects wrong Chinese-scoped maximum without dropping approved dataset',async()=>{
 const f=setup('2026年6月1日至30日，6月18日支出1015.19元，支出最高。'),result=await f.send(capture.message);expect(result.answer).not.toContain('支出最高');expect(result.datasets[0].rows).toEqual(d.rows);
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
