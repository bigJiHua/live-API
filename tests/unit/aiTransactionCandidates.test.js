jest.mock('../../src/common/config/db',()=>({execute:()=>{throw new Error('Public DB forbidden');}}));
const crypto=require('crypto');
const {createTransactionCandidateStore}=require('../../src/modules/ai/service/transactionCandidates');
const {isEncrypted}=require('../../src/common/utils/fieldCrypto');
function fixture() {
  const rows=[],operations=[];let clock=Date.parse('2026-11-06T04:00:00Z');
  const execute=async(sql,p)=>{
    operations.push({sql,p});
    if(sql.startsWith('INSERT')) {
      const [id,user_id,source,conversation_id,request_id,source_fingerprint,input_digest,payload,created_at,expires_at]=p;
      if(rows.some(row=>row.user_id===user_id&&((request_id&&row.request_id===request_id)||(source_fingerprint&&row.source_fingerprint===source_fingerprint))))
        throw Object.assign(new Error('duplicate'),{code:'ER_DUP_ENTRY'});
      rows.push({id,user_id,source,conversation_id,request_id,source_fingerprint,input_digest,payload,created_at,expires_at,status:'pending',draft_id:null});
      return [{affectedRows:1}];
    }
    if(sql.startsWith('SELECT')) return [rows.filter(row=>row.user_id===p[0]&&
      (sql.includes('((? IS NOT NULL')?(row.request_id===p[2]&&p[1]!=null)||(row.source_fingerprint===p[4]&&p[3]!=null):
        sql.includes('source_fingerprint=?')?row.source_fingerprint===p[1]:row.id===p[1]))];
    if(sql.includes("SET payload='expired'")) {
      for(const row of rows) if(row.user_id===p[0]&&row.payload!=='expired'&&((row.status!=='consumed'&&row.expires_at<=p[1])||row.created_at<p[2])) {
        row.payload='expired';if(row.status==='pending')row.status='failed';
      }return [{affectedRows:1}];
    }
    if(sql.includes("SET status='consumed'")) {
      const row=rows.find(row=>row.user_id===p[1]&&row.id===p[2]&&row.status==='pending'&&row.expires_at>p[3]);
      if(!row)return [{affectedRows:0}];row.status='consumed';row.draft_id=p[0];return [{affectedRows:1}];
    }
    if(sql.includes("SET status='discarded'")) {
      const row=rows.find(row=>row.user_id===p[0]&&row.id===p[1]&&row.status==='pending');
      if(!row)return [{affectedRows:0}];row.status='discarded';return [{affectedRows:1}];
    }
    if(sql.includes("expires_at=?,status='pending'")) {
      const row=rows.find(row=>row.user_id===p[3]&&row.id===p[4]&&!row.draft_id&&['pending','failed'].includes(row.status));
      if(!row)return [{affectedRows:0}];
      row.payload=p[0];row.input_digest=p[1];row.expires_at=p[2];row.status='pending';return [{affectedRows:1}];
    }
    if(sql.includes('SET payload=?,input_digest=?')) {
      const row=rows.find(row=>row.user_id===p[2]&&row.id===p[3]&&row.input_digest===p[4]&&row.status==='pending'&&!row.draft_id&&row.expires_at>p[5]);
      if(!row)return [{affectedRows:0}];row.payload=p[0];row.input_digest=p[1];return [{affectedRows:1}];
    }
    throw new Error('Unexpected SQL');
  };
  const executor={execute};const store=createTransactionCandidateStore({executor,now:()=>clock});
  return {store,executor,rows,operations,advance:ms=>clock+=ms};
}
const input=()=>({source:'image-ocr',eligible:true,fields:{amount:'39.91',accountId:null},sourceFingerprint:'a'.repeat(64),
  evidence:{amount:'39.91'},trace:[{tool:'recognize_payment_image',result:{amount:'39.91'}}]});
const pendingInput=()=>({source:'user-readonly',eligible:true,conversationId:'11111111-1111-4111-8111-111111111111',
  pendingTaskId:'22222222-2222-4222-8222-222222222222',pendingTaskIndex:0,pendingTaskRevision:1,
  fields:{amount:'8300',direction:1,currency:'CNY',transDate:'2026-11-11',accountId:null},
  originalText:'今天收入8300元',sourceFingerprint:'c'.repeat(64)});
test('explicit pending recovery refreshes the same expired identity, including a cleaned tombstone',async()=>{
  const f=fixture(),saved=await f.store.restorePending('owner',pendingInput(),f.executor);
  f.advance(900001);
  await f.store.save('owner',{...input(),sourceFingerprint:'d'.repeat(64)});
  expect(f.rows[0].payload).toBe('expired');
  const restored=await f.store.restorePending('owner',pendingInput(),f.executor);
  expect(restored.id).toBe(saved.id);expect(restored.status).toBe('pending');
  expect(restored.fields.amount).toBe('8300');expect(f.rows).toHaveLength(2);
});
test('cancelled pending sources cannot resume; consumed sources keep the existing draft',async()=>{
  const f=fixture(),saved=await f.store.restorePending('owner',pendingInput(),f.executor);
  await f.store.discard('owner',saved.id);
  await expect(f.store.restorePending('owner',pendingInput(),f.executor)).rejects.toMatchObject({code:'AI_CANDIDATE_ENDED'});
  const other=fixture(),candidate=await other.store.restorePending('owner',pendingInput(),other.executor);
  await other.store.consume('owner',candidate.id,'existing-draft',other.executor);
  expect(await other.store.restorePending('owner',pendingInput(),other.executor)).toMatchObject({id:candidate.id,draftId:'existing-draft'});
});
test('new task revisions clear an old account choice and changed source facts remain rejected',async()=>{
  const f=fixture(),value=pendingInput();value.fields.accountId='old-bank';
  await f.store.restorePending('owner',value,f.executor);
  const next=await f.store.restorePending('owner',{...pendingInput(),pendingTaskRevision:2},f.executor);
  expect(next.fields.accountId).toBeNull();expect(next.pendingTaskRevision).toBe(2);
  await expect(f.store.restorePending('owner',{...pendingInput(),fields:{...next.fields,amount:'8301'}},f.executor))
    .rejects.toMatchObject({code:'AI_PENDING_CONFLICT'});
});
test('owner candidate fields and short evidence are encrypted; images never enter persistence',async()=>{
  const f=fixture(),saved=await f.store.save('owner',input());
  expect(isEncrypted(f.rows[0].payload)).toBe(true);expect(f.rows[0].payload).not.toContain('39.91');
  expect((await f.store.get('owner',saved.id)).fields.amount).toBe('39.91');
  await expect(f.store.save('owner',{...input(),sourceFingerprint:null,trace:[{dataUrl:'data:image/png;base64,x'}]})).rejects.toMatchObject({code:'AI_CANDIDATE_INVALID'});
  await expect(f.store.get('other',saved.id)).rejects.toMatchObject({status:404});
});
test('same source returns one candidate and cancellation cannot revive it',async()=>{
  const f=fixture(),saved=await f.store.save('owner',input());
  expect((await f.store.save('owner',input())).id).toBe(saved.id);expect(f.rows).toHaveLength(1);
  await f.store.discard('owner',saved.id);await expect(f.store.save('owner',input())).rejects.toMatchObject({code:'AI_CANDIDATE_ENDED'});
  expect((await f.store.findByFingerprint('owner','a'.repeat(64))).status).toBe('discarded');
  expect(await f.store.discard('owner',saved.id)).toMatchObject({cancelled:true});
});
test('a request ID binds its original candidate payload',async()=>{
  const f=fixture(),value={...input(),sourceFingerprint:null,requestId:crypto.randomUUID()};
  const saved=await f.store.save('owner',value);
  expect((await f.store.save('owner',value)).id).toBe(saved.id);
  await expect(f.store.save('owner',{...value,fields:{amount:'40'}})).rejects.toMatchObject({code:'AI_CANDIDATE_CONFLICT'});
});
test('consumption is atomic compare-and-set and never yields two drafts',async()=>{
  const f=fixture(),saved=await f.store.save('owner',input());
  await f.store.consume('owner',saved.id,'draft-one',f.executor);
  await expect(f.store.consume('owner',saved.id,'draft-two',f.executor)).rejects.toMatchObject({code:'AI_CANDIDATE_CONFLICT'});
  expect((await f.store.get('owner',saved.id)).draftId).toBe('draft-one');
  await expect(f.store.discard('owner',saved.id)).rejects.toMatchObject({code:'AI_CANDIDATE_CONSUMED'});
});

test('same source supplementation uses a digest CAS and freezes transaction evidence',async()=>{
  const f=fixture(),saved=await f.store.save('owner',{source:'user-readonly',eligible:true,fields:{amount:'8.5',direction:0,currency:'CNY',transDate:'2026-11-06',accountId:null,remark:'消费'}});
  const fields={...saved.fields,payMethod:'余额'};
  const updated=await f.store.supplement('owner',saved.id,saved.inputDigest,fields,{tool:'transaction_supplement'});
  expect(updated.id).toBe(saved.id);expect(f.rows).toHaveLength(1);expect(updated.inputDigest).not.toBe(saved.inputDigest);
  await expect(f.store.supplement('owner',saved.id,saved.inputDigest,fields,{})).rejects.toMatchObject({code:'AI_CANDIDATE_CONFLICT'});
  await expect(f.store.supplement('owner',saved.id,updated.inputDigest,{...fields,amount:'10'},{})).rejects.toMatchObject({code:'AI_CONTINUATION_INPUT_INVALID'});
  await f.store.consume('owner',saved.id,'one',f.executor);
  await expect(f.store.supplement('owner',saved.id,updated.inputDigest,fields,{})).rejects.toMatchObject({code:'AI_CANDIDATE_CONFLICT'});
});
test('expired payload is cleaned in bounded owner batches while source tombstone remains non-reusable',async()=>{
  const f=fixture(),saved=await f.store.save('owner',input());f.advance(900001);
  await f.store.save('owner',{...input(),sourceFingerprint:'b'.repeat(64)});
  expect(f.rows[0].payload).toBe('expired');
  const tombstone=await f.store.findByFingerprint('owner','a'.repeat(64));expect(tombstone.fields).toEqual({});
  await expect(f.store.get('owner',saved.id)).rejects.toMatchObject({code:'AI_CANDIDATE_EXPIRED'});
  expect((await f.store.get('owner',saved.id,undefined,{allowEnded:true})).status).toBe('expired');
  expect(f.operations.some(operation=>operation.sql.includes('LIMIT 100'))).toBe(true);
});
test('tampered encrypted payload digest fails closed',async()=>{
  const f=fixture(),saved=await f.store.save('owner',input());f.rows[0].input_digest='0'.repeat(64);
  await expect(f.store.get('owner',saved.id)).rejects.toMatchObject({code:'AI_CANDIDATE_INVALID'});
});
test('cancellation losing a cross-connection race to consumption cannot report that the candidate was cancelled',async()=>{
  const f=fixture(),saved=await f.store.save('owner',input()),execute=f.executor.execute;
  f.executor.execute=async(sql,params)=>{
    if(sql.includes("SET status='discarded'")) { f.rows[0].status='consumed';f.rows[0].draft_id='race-draft'; }
    return execute(sql,params);
  };
  await expect(f.store.discard('owner',saved.id)).rejects.toMatchObject({code:'AI_CANDIDATE_CONSUMED'});
  expect((await f.store.get('owner',saved.id)).draftId).toBe('race-draft');
});
