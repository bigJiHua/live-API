jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const paid=require('../fixtures/aiCardLimitBasisPaidRegression.json');
const {capture,extracted}=paid;
const raw=JSON.parse(extracted.providers.at(-1).content),dataset=capture.payload.data.datasets[0],mode='production',reports=[];
const note='图中固定额度是逐卡登记的配置值，不代表当前可用额度；共享池额度不能逐卡相加当作可用额度，实时可用额度需要另有可核对的数据。';
function setup({message=capture.message,wrongId=false,noChart=false,wrongScope=false,otherColumn=false,malformed=false,modelAnswer}={}){
 const scripts=[calls('query_data',{datasetId:'card-cards',startDate:'2026-11-01',endDate:'2026-11-09',limit:10})];
 if(malformed){scripts.push(calls('list_choices',{domain:'card',group:'cards',limit:20}));scripts.push({role:'assistant',content:extracted.providers[2].content});}
 scripts.push((_,messages)=>{const approved=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).find(p=>p.datasets?.length);
  return final({...raw,answer:modelAnswer??raw.answer,chart:noChart?null:{...raw.chart,queryId:wrongId?'q_'+'0'.repeat(24):approved.datasets[0].queryMeta.queryId,yKeys:otherColumn?['tempLimit']:raw.chart.yKeys}});});
 const f=fixture(scripts,{clock:()=>new Date(dataset.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.state.taskContext=structuredClone(extracted.providers[0].taskInput.taskContexts.tasks[0]);
 f.state.conversationStore.loadQueryCoverage=jest.fn(async()=>({version:1,results:structuredClone(extracted.providers[0].taskInput.previousQueryCoverage)}));
 f.repository.query.mockImplementation(async(_,args)=>{const copy=structuredClone(dataset);copy.queryMeta.queryId=args.queryId;
  if(wrongScope){copy.queryMeta.requestedScope={startDate:'2026-06-01',endDate:'2026-06-30'};copy.queryMeta.effectiveScope={...copy.queryMeta.requestedScope};}
  return{scope:args.scope,asOf:dataset.asOf,choices:f.raw.choices,datasets:[copy]};});
 return{f,message};
}
test.each([false,true])('actual service replays captured C06 final JSON and preserves requested basis (late final=%s)',async malformed=>{
 const {f,message}=setup({malformed}),result=await f.send(message);
 expect(result.answer.includes(note)).toBe(true);expect(result.answer.includes('共享')).toBe(true);
 expect(result.answer).not.toContain('浦发系三卡');expect(result.answer).not.toContain('6838/9485/KiMi');expect(result.answer).not.toContain('临时额度均为');
 expect(result.chart).toMatchObject({datasetId:'card-cards',type:'bar',xKey:'name',yKeys:['creditLimit']});expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);
 expect(result.datasets[0].rows.map(({cardRef,poolRef,...row})=>row)).toEqual(dataset.rows.map(({cardRef,poolRef,...row})=>row));
 expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:81,returnedRowCount:10,rowsComplete:false,summaryComplete:false,rankingComplete:false});
 const saved=f.state.conversationStore.append.mock.calls[0][2];expect(saved.answer).toBe(result.answer);expect(saved.business.chart).toEqual(result.chart);
 expect(saved.business.datasets).toEqual(result.datasets);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
 reports.push({caseId:'C06',originalRequestId:capture.requestId,mode,malformed,answer:result.answer,chart:result.chart,providerFixtureCalls:f.provider.mock.calls.length,
  basisPreserved:result.answer.includes(note),originalFailurePreserved:capture.status==='failed'});
});
test('invalid chart query identity is rejected and never persisted',async()=>{const {f,message}=setup({wrongId:true});
 await expect(f.send(message)).rejects.toMatchObject({code:'AI_CHART_INVALID'});expect(f.state.conversationStore.append).not.toHaveBeenCalled();});
test('actual mismatched tool scope is rejected before a result or notice can be persisted',async()=>{const {f,message}=setup({wrongScope:true});
 await expect(f.send(message)).rejects.toMatchObject({code:'AI_PREVIEW_INVALID'});expect(f.state.conversationStore.append).not.toHaveBeenCalled();});
test('actual target replaces a negated model basis without retaining a contradictory sentence',async()=>{
 const negated='图中额度并不是逐卡配置值，也不认为共享池额度不能相加当作可用额度。';
 const {f,message}=setup({modelAnswer:negated}),result=await f.send(message);
 expect(result.answer.includes(note)).toBe(true);expect(result.answer.includes(negated)).toBe(!(true));
 expect(result.chart.queryId).toBe(result.datasets[0].queryMeta.queryId);
 expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);
 expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 reports.push({negatedBasis:true,mode,answer:result.answer,notice:result.answer.includes(note),contradictionRetained:result.answer.includes(negated)});
});
test('actual target canonical notice is emitted exactly once',async()=>{const {f,message}=setup({modelAnswer:note}),result=await f.send(message);
 expect(result.answer.split(note).length-1).toBe(1);reports.push({canonicalOnce:true,mode,answer:result.answer});});
test('actual target keeps proved numeric row and metadata clauses next to general basis',async()=>{
 const text='农业银行 6838固定额度5000，逐卡登记。范围内匹配81张，本次展示10张，图中额度是逐卡配置值。';
 const {f,message}=setup({modelAnswer:text}),result=await f.send(message);
 expect(result.answer).toContain('农业银行 6838固定额度5000');expect(result.answer).toContain('范围内匹配81张');expect(result.answer).toContain('本次展示10张');
 expect(result.answer.includes(note)).toBe(true);
 reports.push({numericAdjacent:true,mode,answer:result.answer});
});
test('actual unrelated request keeps its prose outside this target-specific restoration',async()=>{
 const negated='图中额度并不是逐卡配置值，也不认为共享池额度不能相加当作可用额度。';
 const {f,message}=setup({message:'查看当前卡片清单，给前10张卡固定额度柱状图，以卡片名称作横轴。',modelAnswer:negated}),result=await f.send(message);
 expect(result.answer).not.toContain(note);expect(result.answer).toContain(negated);
 reports.push({nonTargetNegated:true,mode,answer:result.answer});
});
test.each([{noChart:true},{otherColumn:true},{message:'查看当前卡片清单，给前10张卡固定额度柱状图，以卡片名称作横轴。'}])('actual non-target or unmatched result does not gain a basis: %j',async options=>{
 const {f,message}=setup(options),result=await f.send(message);expect(result.answer).not.toContain(note);
 reports.push({negative:options,mode,answer:result.answer,chart:result.chart});
});
test('shared final assembly keeps grounded finance monthly completion unchanged',async()=>{
 const finance=structuredClone(paid.financeDataset);
 const f=fixture([calls('query_data',{datasetId:'finance-monthly',startDate:'2026-06-01',endDate:'2026-06-30'})],{memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
 f.repository.query.mockImplementation(async(_,args)=>{const d=structuredClone(finance);d.queryMeta.queryId=args.queryId;return{scope:args.scope,asOf:finance.asOf,choices:{},datasets:[d]};});
 const result=await f.send('查看2026年6月收入和支出，给月度柱状图。');expect(result.answer).not.toContain(note);
 expect(result.chart).toMatchObject({datasetId:'finance-monthly',type:'bar',xKey:'month',yKeys:['income','expense']});expect(f.provider).toHaveBeenCalledTimes(1);
 reports.push({groundedFinance:true,mode,providerFixtureCalls:f.provider.mock.calls.length,answer:result.answer});
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
 expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
