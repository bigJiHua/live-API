jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Default DB forbidden');})}));
const crypto=require('crypto');
const db=require('../../src/common/config/db');
const {createTransactionCandidateStore}=require('../../src/modules/ai/service/transactionCandidates');
const {encryptField}=require('../../src/common/utils/fieldCrypto');
const {digestInput}=require('../../src/modules/ai/service/requestGuard');
const now=Date.parse('2026-11-06T04:00:00Z');

function fixture({status='consumed',expired=false,tombstone=false,tampered=false}={}) {
  const requestId=crypto.randomUUID(),id=crypto.randomUUID(),payload={source:'user-readonly',eligible:true,
    fields:{amount:'39.91',accountId:'account-id'},conversationId:'conversation-id'};
  const row={id,user_id:'owner',request_id:requestId,source:'user-readonly',conversation_id:'conversation-id',
    payload:tombstone?'expired':encryptField(JSON.stringify(payload)),input_digest:tampered?'0'.repeat(64):digestInput(payload),
    status,draft_id:status==='consumed'?'existing-draft-id':null,expires_at:now+(expired?-1:60000),created_at:now-1000};
  const executor={execute:jest.fn(async(sql,params)=>{
    expect(sql).toBe('SELECT * FROM ai_transaction_candidate WHERE user_id=? AND request_id=? LIMIT 1');
    return [[row].filter(value=>value.user_id===params[0]&&value.request_id===params[1])];
  })};
  return {row,executor,requestId,id,store:createTransactionCandidateStore({executor,now:()=>now})};
}
beforeEach(()=>jest.clearAllMocks());

test('request recovery reads the owner candidate and preserves the existing consumed draft without writes',async()=>{
  const f=fixture(),before=structuredClone(f.row);
  const value=await f.store.findByRequestId('owner',f.requestId);
  expect(value).toMatchObject({id:f.id,requestId:f.requestId,status:'consumed',draftId:'existing-draft-id',fields:{amount:'39.91'}});
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
  expect(f.executor.execute).toHaveBeenCalledWith(expect.stringContaining('user_id=? AND request_id=?'),['owner',f.requestId]);
  expect(f.row).toEqual(before);expect(db.execute).not.toHaveBeenCalled();
});

test('expired consumed tombstones retain only the existing draft link and cannot restore purged fields',async()=>{
  const f=fixture({expired:true,tombstone:true}),value=await f.store.findByRequestId('owner',f.requestId);
  expect(value).toMatchObject({status:'consumed',draftId:'existing-draft-id',fields:{},eligible:false,requestId:f.requestId});
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
});

test.each(['pending','failed','discarded'])('ended request candidate %s never becomes a consumed draft through lookup',async(status)=>{
  const f=fixture({status}),value=await f.store.findByRequestId('owner',f.requestId);
  expect(value.status).toBe(status);expect(value.draftId).toBeNull();expect(f.row.status).toBe(status);
});

test('pending expiry is represented as an ended lookup without cleaning or reviving the row',async()=>{
  const f=fixture({status:'pending',expired:true}),value=await f.store.findByRequestId('owner',f.requestId);
  expect(value.status).toBe('expired');expect(value.draftId).toBeNull();expect(f.row.status).toBe('pending');
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
});

test('foreign owners and unknown request IDs return no candidate or draft information',async()=>{
  const f=fixture();
  expect(await f.store.findByRequestId('other',f.requestId)).toBeNull();
  expect(await f.store.findByRequestId('owner',crypto.randomUUID())).toBeNull();
  expect(f.executor.execute).toHaveBeenCalledTimes(2);expect(db.execute).not.toHaveBeenCalled();
});

test('malformed request identifiers stop before database access',async()=>{
  const f=fixture();
  for(const [owner,request] of [['',f.requestId],['owner','not-a-uuid'],['x'.repeat(65),f.requestId]])
    await expect(f.store.findByRequestId(owner,request)).rejects.toMatchObject({code:'AI_CANDIDATE_INVALID',status:400});
  expect(f.executor.execute).not.toHaveBeenCalled();expect(db.execute).not.toHaveBeenCalled();
});

test('tampered payload integrity does not produce a recovery receipt',async()=>{
  const f=fixture({tampered:true});
  await expect(f.store.findByRequestId('owner',f.requestId)).rejects.toMatchObject({code:'AI_CANDIDATE_INVALID',status:409});
  expect(f.executor.execute).toHaveBeenCalledTimes(1);
});
