jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Public DB forbidden'); }) }));
const { createConversationStore } = require('../../src/modules/ai/service/conversations');

const conversationId='10000000-0000-4000-8000-000000000001';
const otherConversationId='10000000-0000-4000-8000-000000000002';
const parentId='20000000-0000-4000-8000-000000000001';
const childId='30000000-0000-4000-8000-000000000001';
const otherChildId='30000000-0000-4000-8000-000000000002';
const message='查一下本月收支';

// Stateful rows plus a transaction lock exercise cross-connection ownership:
// two callers must observe the persisted claim after the first commit.
function retryDb({ failure=true, continuedBy, original=message, owner='owner', conversation=conversationId,
  missingUser=false, missingAssistant=false, rejectUpdate=false }={}) {
  const rows=[];
  if(!missingUser)rows.push({id:11,user_id:owner,conversation_id:conversation,role:'user',content:original,
    meta:{turnId:parentId,requestId:parentId}});
  if(!missingAssistant)rows.push({id:12,user_id:owner,conversation_id:conversation,role:'assistant',content:'需要授权',
    meta:{turnId:parentId,...(failure?{failure:{requestId:parentId,status:'failed',code:'AI_GRANT_REQUIRED'}}:{requestId:parentId}),
      ...(continuedBy?{continuedBy}:{})}});
  const calls=[],connections=[];
  let lock=Promise.resolve();
  const executor={execute:jest.fn(()=>{throw Error('Retry claim must use its transaction connection');}),
    getConnection:jest.fn(async()=>{
      let unlock,locked=false;
      const releaseLock=()=>{if(locked){locked=false;unlock();}};
      const conn={beginTransaction:jest.fn(async()=>{}),commit:jest.fn(async()=>releaseLock()),
        rollback:jest.fn(async()=>releaseLock()),release:jest.fn(()=>releaseLock()),execute:jest.fn(async(sql,params=[])=>{
          calls.push({sql,params});
          if(sql.startsWith('SELECT')&&sql.includes('FROM ai_conversation')){
            if(sql.includes('FOR UPDATE')){
              const previous=lock;
              lock=new Promise(resolve=>{unlock=resolve;});
              await previous;locked=true;
            }
            return [[{id:params.find(value=>[conversationId,otherConversationId].includes(value))}]];
          }
          if(sql.startsWith('SELECT')&&sql.includes('FROM ai_message')){
            const queryOwner=params.includes('stranger')?'stranger':'owner';
            const queryConversation=params.includes(otherConversationId)?otherConversationId:conversationId;
            let matching=rows.filter(row=>row.user_id===queryOwner&&row.conversation_id===queryConversation);
            if(/role\s*=\s*'assistant'/.test(sql))matching=matching.filter(row=>row.role==='assistant');
            if(/role\s*=\s*'user'/.test(sql))matching=matching.filter(row=>row.role==='user');
            const requested=params.find(value=>typeof value==='string'&&/^[23]0000000-/.test(value));
            if(sql.includes("'$.retryOf'"))matching=matching.filter(row=>row.meta.retryOf===requested);
            else if(requested)matching=matching.filter(row=>[row.meta.requestId,row.meta.failure?.requestId,row.meta.turnId].includes(requested));
            return [structuredClone(matching)];
          }
          if(sql.startsWith('UPDATE ai_message')){
            if(rejectUpdate)return [{affectedRows:0}];
            const target=rows.find(row=>row.id===12&&params.includes(row.id)&&params.includes(row.user_id)&&params.includes(row.conversation_id));
            if(!target)return [{affectedRows:0}];
            const child=params.find(value=>[childId,otherChildId].includes(value));
            if(target.meta.continuedBy&&target.meta.continuedBy!==child)return [{affectedRows:0}];
            target.meta.continuedBy=child;
            return [{affectedRows:1}];
          }
          throw Error('Unexpected retry SQL: '+sql);
        })};
      connections.push(conn);return conn;
    })};
  return {rows,calls,connections,executor,store:createConversationStore({executor})};
}
const claim=(f,overrides={})=>f.store.claimRetry('owner',conversationId,{retryOf:parentId,requestId:childId,message,...overrides});

test('an owned failed authorization is claimed once before continuation without changing either original message',async()=>{
  const f=retryDb();await claim(f);
  expect(f.rows[0].content).toBe(message);expect(f.rows[0].meta).toEqual({turnId:parentId,requestId:parentId});
  expect(f.rows[1].content).toBe('需要授权');
  expect(f.rows[1].meta).toMatchObject({continuedBy:childId,failure:{requestId:parentId,status:'failed',code:'AI_GRANT_REQUIRED'}});
  const writes=f.calls.filter(call=>!call.sql.startsWith('SELECT'));
  expect(writes).toHaveLength(1);expect(writes[0].sql).toMatch(/^UPDATE ai_message/);
  expect(writes[0].sql).toContain('JSON_SET');expect(writes[0].sql).toContain('continuedBy');
  expect(writes[0].sql).toContain("role = 'assistant'");expect(writes[0].sql).toContain("JSON_EXTRACT(meta, '$.continuedBy') IS NULL");
  expect(f.calls.filter(call=>call.sql.startsWith('SELECT')).every(call=>call.params.includes('owner')&&call.params.includes(conversationId))).toBe(true);
  expect(f.calls.find(call=>call.sql.includes('FROM ai_conversation')).sql).toContain('FOR UPDATE');
  expect(f.connections[0].commit).toHaveBeenCalledTimes(1);expect(f.connections[0].rollback).not.toHaveBeenCalled();
  expect(f.connections[0].release).toHaveBeenCalledTimes(1);expect(f.executor.execute).not.toHaveBeenCalled();
});

test.each([
  ['successful parent',{failure:false}],
  ['different original message',{original:'原来的其他问题'}],
  ['different original whitespace',{original:message+' '}],
  ['another owner',{owner:'stranger'}],
  ['another conversation',{conversation:otherConversationId}],
  ['missing user',{missingUser:true}],
  ['missing assistant',{missingAssistant:true}],
])('%s cannot authorize a continuation or write a claim',async(_label,options)=>{
  const f=retryDb(options);
  await expect(claim(f)).rejects.toMatchObject({code:'AI_RETRY_INVALID'});
  expect(f.calls.filter(call=>!call.sql.startsWith('SELECT'))).toEqual([]);
  expect(f.connections[0].commit).not.toHaveBeenCalled();expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
  expect(f.connections[0].release).toHaveBeenCalledTimes(1);
});

test('a valid UUID with no persisted parent does not match another failure by text',async()=>{
  const f=retryDb();await expect(claim(f,{retryOf:otherChildId})).rejects.toMatchObject({code:'AI_RETRY_INVALID'});
  expect(f.calls.filter(call=>!call.sql.startsWith('SELECT'))).toEqual([]);
});

test('a failed compare-and-set claim rolls back instead of accepting a continuation',async()=>{
  const f=retryDb({rejectUpdate:true});await expect(claim(f)).rejects.toMatchObject({code:'AI_RETRY_CONSUMED'});
  expect(f.rows[1].meta).not.toHaveProperty('continuedBy');
  expect(f.connections[0].commit).not.toHaveBeenCalled();expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
});

test('another child cannot continue an already consumed parent',async()=>{
  const f=retryDb({continuedBy:otherChildId});
  await expect(claim(f)).rejects.toMatchObject({code:'AI_RETRY_CONSUMED'});
  expect(f.rows[1].meta.continuedBy).toBe(otherChildId);
  expect(f.calls.filter(call=>!call.sql.startsWith('SELECT'))).toEqual([]);
});

test('the same child can confirm its existing claim without creating another claim',async()=>{
  const f=retryDb({continuedBy:childId});await claim(f);
  expect(f.rows[1].meta.continuedBy).toBe(childId);
  expect(f.calls.filter(call=>!call.sql.startsWith('SELECT'))).toEqual([]);
  expect(f.connections[0].commit).toHaveBeenCalledTimes(1);
});

test.each([
  {retryOf:'invalid'},
  {requestId:'invalid'},
  {requestId:parentId},
])('invalid or self-referential request IDs are rejected before a transaction: %j',async overrides=>{
  const f=retryDb();await expect(claim(f,overrides)).rejects.toMatchObject({code:'AI_RETRY_INVALID'});
  expect(f.executor.getConnection).not.toHaveBeenCalled();
});

test('concurrent children across connections consume a failed parent only once',async()=>{
  const f=retryDb();const results=await Promise.allSettled([claim(f),claim(f,{requestId:otherChildId})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.find(result=>result.status==='rejected').reason).toMatchObject({code:'AI_RETRY_CONSUMED'});
  expect([childId,otherChildId]).toContain(f.rows[1].meta.continuedBy);
  expect(f.calls.filter(call=>!call.sql.startsWith('SELECT'))).toHaveLength(1);
  expect(f.connections.reduce((count,conn)=>count+conn.commit.mock.calls.length,0)).toBe(1);
  expect(f.connections.reduce((count,conn)=>count+conn.rollback.mock.calls.length,0)).toBe(1);
});
