// Real V3 orchestration with malicious model narrowing; no live DB/provider.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }), getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const publicDb=require('../../src/common/config/db');
const {deepseekChat}=require('../../src/modules/ai/service/deepseek');
const {buildTaskContext,sanitizeTaskContext,finalizeTaskContext}=require('../../src/modules/ai/service/taskContext');
const {fixture,final,calls,now}=require('../fixtures/aiV3MemoryFixture');
const build=(message,previous)=>buildTaskContext({message,today:'2026-11-08',previous});
const taskInput=messages=>JSON.parse(messages.find(item=>item.role==='user'&&item.content.startsWith('TASK_INPUT:\n')).content.slice('TASK_INPUT:\n'.length));
const rawRows=[{type:'credit',count:20},{type:'debit',count:59},{type:'virtual_balance',count:1},{type:'virtual_cash',count:1}];
function replay(modelTypes=['debit','credit'],modelFilter='',modelAnswer='查询完成。'){
 const response=(_,messages,__,options)=>!options.json&&!messages.some(item=>item.role==='tool')
  ?calls('query_data',{datasetId:'card-counts',cardTypes:modelTypes,filter:modelFilter,limit:10}):final({answer:modelAnswer});
 const f=fixture(Array.from({length:60},()=>response),{memoryStore:{list:jest.fn(async()=>({files:[],count:0,warnings:[]}))}});
 f.raw.datasets=[{datasetId:'card-counts',domain:'card',title:'本人卡片数量',columns:[{key:'type',label:'卡片类型',type:'text'},{key:'count',label:'数量',type:'number'}],rows:structuredClone(rawRows),summary:{},totalCount:4,truncated:false,asOf:now().toISOString(),policy:'全部未删除卡片类型。'}];
 return f;
}
afterEach(()=>{expect(publicDb.execute).not.toHaveBeenCalled();expect(publicDb.getConnection).not.toHaveBeenCalled();expect(deepseekChat).not.toHaveBeenCalled();});
test.each(['查看当前我的全部卡片按类型分别有多少张。','查看所有卡片的数量。','全部卡片呢？'])('explicit all types has a durable optional marker: %s',message=>{
 const task=build(message,build('只看借记卡数量'));expect(task).toMatchObject({subject:'cards',metric:'card-count',cardTypes:[],allCardTypes:true});
 expect(finalizeTaskContext(task,{status:'succeeded',turnId:'all_cards'})).toMatchObject({allCardTypes:true,cardTypes:[]});
});
test.each(['所有借记卡数量','全部卡片，不要信用卡','全部卡片，不含现金'])('specific type mention never fabricates unrestricted intent: %s',message=>expect(build(message)).not.toHaveProperty('allCardTypes'));
test('optional marker cannot coexist with a concrete type or non-card subject',()=>{
 expect(sanitizeTaskContext({...build('只看借记卡数量'),allCardTypes:true})).not.toHaveProperty('allCardTypes');
 expect(sanitizeTaskContext({version:1,mode:'query',subject:'finance',cardTypes:[],allCardTypes:true})).not.toHaveProperty('allCardTypes');
});
test.each([[['debit','credit'],''],[['debit'],'借记卡']])('all card request defeats model-only narrowing %j',async(modelTypes,modelFilter)=>{
 const f=replay(modelTypes,modelFilter),result=await f.send('查看当前我的全部卡片按类型分别有多少张。');
 expect(f.repository.query.mock.calls[0][1].cardTypes).toBeUndefined();expect(f.repository.query.mock.calls[0][1].filter||'').toBe('');
 expect(result.datasets[0].rows.map(row=>[row.type,row.count])).toEqual([['信用卡',20],['借记卡',59],['虚拟余额',1],['现金',1]]);
 expect(result.datasets[0].summary.totalCount).toBe(81);expect(result.datasets[0].queryMeta.sourceRecordCount).toBe(81);
 expect(result.datasets[0].queryMeta.filters.cardTypes).toBeUndefined();expect(taskInput(f.provider.mock.calls[0][1]).taskContext.allCardTypes).toBe(true);
});
test('two bank types retain denominator79 then all-cards followup clears old narrowing',async()=>{
 const f=replay(['debit']);const banks=await f.send('查看借记卡和信用卡的数量比例。');expect(banks.datasets[0].summary.totalCount).toBe(79);
 expect(banks.datasets[0].queryMeta.filters.cardTypes).toEqual(['debit','credit']);
 const at=f.provider.mock.calls.length,all=await f.send('全部卡片呢？');expect(all.datasets[0].summary.totalCount).toBe(81);
 expect(taskInput(f.provider.mock.calls[at][1]).taskContext).toMatchObject({allCardTypes:true,cardTypes:[]});
 const credit=await f.send('信用卡呢？');expect(credit.datasets[0].summary.totalCount).toBe(20);expect(f.state.taskContext).not.toHaveProperty('allCardTypes');
});

test('explicit historical all-card request keeps its requested dates while counts remain current saved state',async()=>{
 const message='查看2025-06-01至2025-06-30我的全部卡片按类型数量，请明确当前保存状态不能重建当时的历史数量。';
 const historicalScope={startDate:'2025-06-01',endDate:'2025-06-30'};
 expect(build(message)).toMatchObject({subject:'cards',metric:'card-count',allCardTypes:true});
 expect(build(message).scope).toBeUndefined();
 const f=replay(['debit','credit'],'','目前保存的全部卡片共81张；系统没有历史卡片快照，无法重建当时的数量。');
 const result=await f.send(message),dataset=result.datasets[0];
 expect(dataset.queryMeta.requestedScope).toEqual(historicalScope);
 expect(dataset.queryMeta.effectiveScope).toEqual(historicalScope);
 expect(f.repository.query.mock.calls[0][1].scope).toMatchObject(historicalScope);
 expect(dataset.summary.totalCount).toBe(81);expect(dataset.queryMeta.sourceRecordCount).toBe(81);
 expect(dataset.rows.map(row=>[row.type,row.count])).toEqual([['信用卡',20],['借记卡',59],['虚拟余额',1],['现金',1]]);
 expect(result.answer).toMatch(/目前保存|当前保存/);expect(result.answer).toMatch(/无法重建.*数量/);
 expect(result.answer).not.toMatch(/2025.*当时.*(?:共有|合计|共)81张/);
});
