jest.mock('../../src/common/config/db', () => ({ execute: jest.fn() }));
const { createPendingTransactionRecovery } = require('../../src/modules/ai/service/pendingTransactionRecovery');
const { buildPendingTransactionContext, readPendingTransactionTask, TTL_MS } = require('../../src/modules/ai/service/pendingTransactions');
const conversationId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const createdAt=Date.parse('2026-11-11T05:00:00Z');
function fixture({ expired=false, draft=null }={}) {
  const context=buildPendingTransactionContext({ conversationId,turnId:taskId,now:createdAt,
    userTurns:['今天收入8300元进工商银行卡'],userTurnDates:['2026-11-11'],userTurnIds:[taskId],
    transactions:[{ fields:{amount:'8300',direction:1,currency:'CNY',transDate:'2026-11-11',remark:'收入',payMethod:'银行卡'},
      evidence:{sourceTurn:0,quote:'今天收入8300元进工商银行卡'},missingFields:['账户','分类'] }] });
  const task=readPendingTransactionTask(context,{conversationId,now:createdAt+(expired?TTL_MS+1:1000)});
  const conn={beginTransaction:jest.fn(async()=>{}),commit:jest.fn(async()=>{}),rollback:jest.fn(async()=>{}),release:jest.fn(),
    execute:jest.fn(async()=>[[{id:conversationId}]])};
  const inspect=jest.fn(async(_user,input)=>({intent:'transaction',fields:input.fields,
    choices:{accounts:[{id:'salary',name:'招商工资储蓄卡',type:'debit'},{id:'daily',name:'招商日常信用卡',type:'credit'}],categories:[]},
    financialCheck:{status:'needs_input'},missingFields:['账户','分类']}));
  const candidateStore={restorePending:jest.fn(async(_user,input)=>({...input,id:taskId,sourceCandidateId:taskId,
    status:draft?'consumed':'pending',draftId:draft?.id||null}))};
  const conversationStore={loadPendingTransactionTask:jest.fn(async()=>task)};
  const service=createPendingTransactionRecovery({conversationStore,candidateStore,executor:{getConnection:async()=>conn},
    now:()=>createdAt+(expired?TTL_MS+1:1000),
    requireAccess:jest.fn(),inspect,draftStore:{get:jest.fn(async()=>draft)},enrichDraft:async(_u,value)=>value});
  return {service,task,inspect,candidateStore,conn,conversationStore,
    request:{conversationId,taskId:task.taskId,revision:task.revision,itemIndex:0}};
}
test('expired task is displayed without exposing source text or executing anything',async()=>{
  const f=fixture({expired:true});
  const result=await f.service.readPendingTransaction('owner',{conversationId});
  expect(result.pendingTask).toMatchObject({status:'expired',taskId,items:[{fields:{amount:'8300',transDate:'2026-11-11'}}]});
  expect(JSON.stringify(result)).not.toMatch(/工商|sourceTurn|quote/);
  expect(f.candidateStore.restorePending).not.toHaveBeenCalled();
});
test('explicit cross-day recovery retains source facts and offers owner-bound account choices',async()=>{
  const f=fixture({expired:true});
  const result=await f.service.resumePendingTransaction('owner',f.request);
  expect(result.fields).toMatchObject({amount:'8300',direction:1,transDate:'2026-11-11',accountId:null});
  expect(result.choices.accounts).toHaveLength(2);
  expect(f.candidateStore.restorePending).toHaveBeenCalledWith('owner',expect.objectContaining({pendingTaskId:taskId,
    originalText:'今天收入8300元进工商银行卡'}),f.conn);
  expect(f.conversationStore.loadPendingTransactionTask).toHaveBeenCalledWith('owner',conversationId,f.conn);
  expect(f.conn.commit).toHaveBeenCalledTimes(1);
});
test.each([{revision:99},{taskId:'33333333-3333-4333-8333-333333333333'},{itemIndex:2}])('stale task selection rejects before candidate creation: %j',async(change)=>{
  const f=fixture();
  await expect(f.service.resumePendingTransaction('owner',{...f.request,...change})).rejects.toMatchObject({status:409});
  expect(f.candidateStore.restorePending).not.toHaveBeenCalled();
  expect(f.conn.rollback).toHaveBeenCalledTimes(1);
});
test('a consumed task returns the existing draft instead of another draft',async()=>{
  const draft={id:'33333333-3333-4333-8333-333333333333',conversationId,choices:{accounts:[]},financialCheck:{status:'pass'}};
  const f=fixture({draft});
  expect((await f.service.resumePendingTransaction('owner',f.request)).draft).toBe(draft);
  expect(f.inspect).toHaveBeenCalledTimes(1);
});
test('recovery does not accept client-supplied amounts',async()=>{
  const f=fixture();
  await expect(f.service.resumePendingTransaction('owner',{...f.request,amount:'99999'})).rejects.toMatchObject({status:400});
  expect(f.conn.beginTransaction).not.toHaveBeenCalled();
});
