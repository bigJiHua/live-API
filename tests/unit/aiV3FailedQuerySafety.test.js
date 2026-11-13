jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,calls,final}=require('../fixtures/aiV3MemoryFixture');
const reports=[];
const memoryStore=()=>({list:jest.fn(async()=>({files:[],warnings:[]}))});
const request='查看2026年11月1日至8日目前保存的工资规则。';
const dateError={datasetId:'work-rules',startDate:'2026-02-30',endDate:'2026-11-08'};
const noZero=answer=>!/(?:已查询|已读取|已统计|查到|读取到|没有(?:保存)?(?:工资规则|记录)|(?:匹配|返回|查到)[^。；;\n]{0,12}\b0\s*(?:条|行|笔))/.test(answer);
function setup(responses){const f=fixture(responses,{memoryStore:memoryStore()});f.state.businessPolicy.domains.push('work');return f;}
function assertSaved(f,result){
 expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);const saved=f.state.conversationStore.append.mock.calls[0][2];
 expect(saved.answer).toBe(result.answer);expect(saved.business.datasets).toEqual(result.datasets);expect(saved.business.request).toEqual(result.request);
 expect(f.state.requestGuard.saveV3Recovery).toHaveBeenCalledTimes(1);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);
 expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
 return saved;
}
afterEach(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
test.each(['目前没有保存工资规则。','已查询目前保存的工资规则，没有记录。','查询匹配0条工资规则。'])('failed date packet cannot persist a false empty/success conclusion: %s',async answer=>{
 const f=setup([calls('query_data',dateError),final({answer})]),result=await f.send(request);
 const saved=assertSaved(f,result);reports.push({name:answer,answer:result.answer,queries:f.repository.query.mock.calls.length,savedTask:saved.taskContext?.status});
 expect(noZero(result.answer)).toBe(true);expect(result.answer).toBe('查询日期无效，请核对日期。');expect(result.datasets).toEqual([]);expect(result.toolTrace).toEqual([]);expect(f.repository.query).not.toHaveBeenCalled();
 expect(f.provider).toHaveBeenCalledTimes(3);expect(result.request.providerCalls).toBe(3);expect(saved.taskContext.status).toBe('pending');
 expect(f.audits.filter(x=>x.phase==='tool-recovery'&&x.status==='error')).toHaveLength(1);expect(f.audits.filter(x=>x.phase==='query-evidence-recovery')).toHaveLength(0);
});
test('an invalid enum packet uses server-known parameter failure rather than model zero-record prose',async()=>{
 const f=setup([calls('query_data',{datasetId:'work-rules',sort:'expenseDesc'}),final({answer:'已查到0条工资规则，当前没有记录。'})]),result=await f.send(request),saved=assertSaved(f,result);
 expect(result.answer).toMatch(/查询未完成.*参数未通过校验.*无法确认/);expect(noZero(result.answer)).toBe(true);expect(f.repository.query).not.toHaveBeenCalled();expect(saved.taskContext.status).toBe('pending');expect(f.provider).toHaveBeenCalledTimes(3);
 reports.push({name:'invalid capability enum',answer:result.answer,queries:0});
});
test('the safe failure fallback cannot repair an invalid output clarification packet',async()=>{
 const f=setup([calls('query_data',dateError),final({answer:'没有工资规则。',clarification:{question:'已查询并确认没有保存工资规则，请补充规则。',items:[]}})]);
 await expect(f.send(request)).rejects.toMatchObject({code:'AI_INVALID_RESULT'});expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
 reports.push({name:'malformed final schema remains rejected',rejected:true});
});
test('a correct date-error explanation remains usable and durable without any read',async()=>{
 const f=setup([calls('query_data',dateError),final({answer:'查询日期无效，请核对日期。'})]),result=await f.send(request);
 expect(result.answer).toBe('查询日期无效，请核对日期。');expect(f.repository.query).not.toHaveBeenCalled();assertSaved(f,result);expect(f.provider).toHaveBeenCalledTimes(3);
 reports.push({name:'correct error explanation',answer:result.answer});
});
test('successful monthly evidence survives a different query failure and the failed subtask stays pending',async()=>{
 const first=calls('query_data',{datasetId:'finance-monthly',startDate:'2026-06-01',endDate:'2026-06-30',sort:'monthAsc'}),second=calls('query_data',dateError);
 const f=setup([{role:'assistant',content:null,tool_calls:[...first.tool_calls,...second.tool_calls]},final({answer:'6月收入100.00元，支出20.00元。已查询工资规则，没有记录。'})]);
 f.raw.datasets=[{datasetId:'finance-monthly',domain:'finance',title:'收支月度趋势',columns:[{key:'month',label:'月份',type:'date'},{key:'income',label:'收入',type:'money'},{key:'expense',label:'支出',type:'money'},{key:'count',label:'笔数',type:'number'}],rows:[{month:'2026-06',income:'100.00',expense:'20.00',count:2}],summary:{income:'100.00',expense:'20.00',count:2,incomeCount:1,expenseCount:1,unpricedCount:0,currency:'CNY',incomplete:false},totalCount:1,truncated:false,asOf:'2026-11-08T13:22:14Z',policy:'查询范围2026-06-01至2026-06-30。'}];
 const result=await f.send('分别查询：2026年6月收入和支出月度汇总；2026年11月1日至8日目前保存的工资规则。'),saved=assertSaved(f,result);
 expect(f.repository.query).toHaveBeenCalledTimes(1);expect(result.datasets).toHaveLength(1);expect(result.datasets[0].datasetId).toBe('finance-monthly');expect(result.datasets[0].rows).toMatchObject(f.raw.datasets[0].rows);expect(result.datasets[0].summary.income).toBe('100.00');expect(result.datasets[0].summary.expense).toBe('20.00');
 expect(result.answer).not.toMatch(/已查询工资|没有(?:保存)?工资规则/);expect(result.answer).toContain('对应查询尚无本轮获准数据');expect(saved.taskContexts.tasks.find(t=>t.subject==='work').status).toBe('pending');
 const paired=f.provider.mock.calls[1][1].filter(item=>item.role==='tool');expect(paired.map(t=>t.tool_call_id)).toEqual([first.tool_calls[0].id,second.tool_calls[0].id]);expect(JSON.parse(paired[0].content).datasets).toHaveLength(1);expect(JSON.parse(paired[1].content).status).toBe('error');expect(result.datasets[0].rows).toEqual(JSON.parse(paired[0].content).datasets[0].rows);
 reports.push({name:'mixed approved read plus failed read',answer:result.answer,datasets:result.datasets.map(d=>({datasetId:d.datasetId,rows:d.rows,summary:d.summary})),statuses:saved.taskContexts.tasks.map(t=>({subject:t.subject,status:t.status}))});
});
test('a corrected valid query keeps its actual complete empty evidence and succeeds normally',async()=>{
 const f=setup([calls('query_data',dateError),calls('query_data',{datasetId:'work-rules'}),final({answer:'目前没有保存工资规则。'})]);
 f.raw.datasets=[{datasetId:'work-rules',domain:'work',title:'工资规则',columns:[{key:'company',label:'公司',type:'text'}],rows:[],summary:{},totalCount:0,truncated:false,asOf:'2026-11-08T13:22:14Z',policy:'目前保存规则。'}];
 const result=await f.send(request),saved=assertSaved(f,result);expect(f.repository.query).toHaveBeenCalledTimes(1);expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:0,returnedRowCount:0,rowsComplete:true});expect(saved.taskContext.status).toBe('succeeded');expect(result.answer).not.toContain('查询日期无效');
 reports.push({name:'valid correction with proven empty result',answer:result.answer});
});
test('a provider that never queries and has no tool error still fails the original fresh-evidence guard',async()=>{
 const f=setup(Array.from({length:5},()=>final({answer:'目前没有保存工资规则。'})));
 await expect(f.send(request)).rejects.toMatchObject({code:'AI_QUERY_EVIDENCE_REQUIRED'});expect(f.repository.query).not.toHaveBeenCalled();expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
 reports.push({name:'no error cannot bypass fresh evidence',rejected:true});
});
