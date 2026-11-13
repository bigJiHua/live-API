jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
const { createConversationSyncStore } = require('../../src/modules/ai/service/conversationSync');
const { encryptField } = require('../../src/common/utils/fieldCrypto');
const { createAiService } = require('../../src/modules/ai/service');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');

test('snapshot is read-only and every state query is scoped by owner and conversation', async () => {
  const queries=[];
  const executor={execute:jest.fn(async(sql,params)=>{
    queries.push({sql,params});
    if(sql.startsWith('SELECT id FROM ai_conversation')) return [[{id:'chat'}]];
    if(sql.includes('FROM ai_chat_activity')) return [[{request_id:'r',message_payload:encryptField('原话'),status:'running',stage:'reading',created_at:1,updated_at:2,deadline_at:2000}]];
    if(sql.includes('FROM bus_ai_draft')) return [[{id:'d',status:'reviewed',version:2,expires_at:2000}]];
    return [[]];
  })};
  const conversations={messagesSince:jest.fn(async()=>({messages:[{messageId:8,role:'user',content:'已保存'}],lastId:8}))};
  const state=await createConversationSyncStore({executor,conversations,clock:()=>1000}).snapshot('owner','chat',3);
  expect(conversations.messagesSince).toHaveBeenCalledWith('owner','chat',3);
  expect(state.activities[0]).toMatchObject({message:'原话',status:'running',stage:'reading'});
  expect(state.activities[0]).not.toHaveProperty('execution_token');expect(state.entities.drafts[0]).toMatchObject({version:2,status:'reviewed'});
  expect(queries.every(query=>query.sql.startsWith('SELECT'))).toBe(true);
  // run 行真值查询按 owner+requestIds 定位（2026-11-10 活动镜像），不属于 conversationId 域。
  for(const query of queries.filter(query=>!query.sql.startsWith('SELECT id FROM ai_conversation') && !query.sql.includes('FROM ai_request_run'))) expect(query.params.slice(0,2)).toEqual(['owner','chat']);
});

test('deleted or foreign conversations cannot expose messages, activities or artifact IDs', async () => {
  const executor={execute:jest.fn(async()=>[[]])}, conversations={messagesSince:jest.fn()};
  await expect(createConversationSyncStore({executor,conversations}).snapshot('stranger','chat',0)).rejects.toMatchObject({code:'AI_CONVERSATION_EXPIRED',status:404});
  expect(conversations.messagesSince).not.toHaveBeenCalled();expect(executor.execute).toHaveBeenCalledTimes(1);
});

test('activity originals are encrypted and duplicate attempts update only their own execution token', async () => {
  const executor={execute:jest.fn(async sql=>sql.startsWith('SELECT')?[[{id:'chat'}]]:[{affectedRows:1}])};
  const store=createConversationSyncStore({executor,clock:()=>1000});
  const handle=await store.begin('owner','chat','request','原始内容',30000);await store.update(handle,'running','reading');
  const insert=executor.execute.mock.calls.find(([sql])=>sql.startsWith('INSERT'));
  expect(insert[1][4]).toMatch(/^enc\.v1:/);expect(insert[1][4]).not.toContain('原始内容');
  const update=executor.execute.mock.calls.find(([sql])=>sql.startsWith('UPDATE'));
  expect(update[0]).toContain('execution_token=?');expect(update[0]).toContain("status IN ('queued','running')");expect(update[1].slice(-3)).toEqual(['owner','request',handle.token]);
});

test('reconnection state exposes current expired status without writing or replaying an execution', async () => {
  const executor={execute:jest.fn(async sql=>{
    if(sql.startsWith('SELECT id FROM ai_conversation'))return [[{id:'chat'}]];
    if(sql.includes('FROM ai_chat_activity'))return [[{request_id:'r',message_payload:encryptField('原话'),status:'queued',stage:'queued',created_at:0,updated_at:0,deadline_at:5}]];
    return [[]];
  })};
  const store=createConversationSyncStore({executor,clock:()=>10,conversations:{messagesSince:async()=>({messages:[],lastId:4})}});
  expect((await store.snapshot('owner','chat',4)).activities[0]).toMatchObject({status:'failed',errorCode:'AI_TURN_TIMEOUT'});
  expect(executor.execute.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
});

test('pending activities mirror the request receipt truth: interrupted run mirrors failed, fresh lease stays running', async () => {
  const executor={execute:jest.fn(async (sql,params)=>{
    if(sql.startsWith('SELECT id FROM ai_conversation')) return [[{id:'chat'}]];
    if(sql.includes('FROM ai_chat_activity')) return [[
      {request_id:'dead',message_payload:encryptField('中断'),status:'running',stage:'thinking',error_code:null,notice:null,created_at:1,updated_at:2,deadline_at:5000},
      {request_id:'alive',message_payload:encryptField('进行中'),status:'running',stage:'reading',error_code:null,notice:null,created_at:3,updated_at:4,deadline_at:5000},
      {request_id:'lost',message_payload:encryptField('排队'),status:'queued',stage:'queued',error_code:null,notice:null,created_at:5,updated_at:6,deadline_at:5}]];
    if(sql.includes('FROM ai_request_run')) return [[
      {id:'dead',status:'failed',error_code:'AI_TURN_INTERRUPTED',deadline_at:5000},
      {id:'alive',status:'running',error_code:null,deadline_at:5000}]];
    return [[]];
  })};
  const store=createConversationSyncStore({executor,clock:()=>1000,conversations:{messagesSince:async()=>({messages:[],lastId:0})}});
  const byId=Object.fromEntries((await store.snapshot('owner','chat',0)).activities.map(row=>[row.requestId,row]));
  // run 行已失败（进程死亡被停机标记/租约 reap）→ 镜像为中断终态；
  // 租约仍新鲜 → 保持 running；run 行缺失（排队未准入）→ 回退活动自身死线熔断。
  expect(byId.dead).toMatchObject({status:'failed',errorCode:'AI_TURN_INTERRUPTED',notice:'服务中断或已重启，本轮处理未完成，请查看回执。'});
  expect(byId.alive).toMatchObject({status:'running',stage:'reading'});
  expect(byId.lost).toMatchObject({status:'failed',errorCode:'AI_TURN_TIMEOUT'});
});

test('an expired activity deadline cannot fail a request with a fresh running lease', async () => {
  const executor={execute:jest.fn(async sql=>{
    if(sql.startsWith('SELECT id FROM ai_conversation')) return [[{id:'chat'}]];
    if(sql.includes('FROM ai_chat_activity')) return [[{request_id:'alive',message_payload:encryptField('进行中'),
      status:'running',stage:'reading',created_at:1,updated_at:2,deadline_at:5}]];
    if(sql.includes('FROM ai_request_run')) return [[{id:'alive',status:'running',error_code:null,deadline_at:5000}]];
    return [[]];
  })};
  const store=createConversationSyncStore({executor,clock:()=>1000,conversations:rememberConversations()});
  const activity=(await store.snapshot('owner','chat',0)).activities[0];
  expect(activity).toMatchObject({status:'running',stage:'reading'});
  expect(activity).not.toHaveProperty('errorCode');expect(activity).not.toHaveProperty('notice');
  expect(executor.execute.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
});

test('an authoritative run read failure cannot turn a completed request into an invented timeout', async () => {
  const outage = Error('synthetic read outage'); let failRead = false;
  const executor = { execute: jest.fn(async sql => {
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'chat' }]];
    if (sql.includes('FROM ai_chat_activity')) return [[{ request_id: 'done', message_payload: encryptField('原话'), status: 'running', stage: 'reading', created_at: 1, updated_at: 2, deadline_at: 5 }]];
    if (sql.includes('FROM ai_request_run')) { if (failRead) throw outage; return [[{ id: 'done', status: 'completed', deadline_at: 5 }]]; }
    return [[]];
  }) };
  const store = createConversationSyncStore({ executor, clock: () => 1000, conversations: { messagesSince: async () => ({ messages: [], lastId: 0 }) } });
  expect((await store.snapshot('owner', 'chat', 0)).activities[0]).toMatchObject({ status: 'completed', updatedAt: 2 });
  failRead = true;
  await expect(store.snapshot('owner', 'chat', 0)).rejects.toBe(outage);
  expect(executor.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
});

test('an already cancelled begin never acquires SQL resources or creates an activity', async () => {
  const disconnected = new AbortController(); disconnected.abort();
  const executor = { execute: jest.fn(), getConnection: jest.fn() };
  const store = createConversationSyncStore({ executor });
  await expect(store.begin('owner', 'chat', 'request', '原话', 30000, { signal: disconnected.signal })).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED', providerCalls: 0 });
  expect(executor.getConnection).not.toHaveBeenCalled(); expect(executor.execute).not.toHaveBeenCalled();
});

test('cancellation during a locked parent read rolls back before inserting or committing a late activity', async () => {
  const disconnected = new AbortController(); let finishRead;
  const conn = { beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(),
    execute: jest.fn(() => new Promise(resolve => { finishRead = resolve; })) };
  const store = createConversationSyncStore({ executor: { getConnection: async () => conn } });
  const pending = store.begin('owner', 'chat', 'request', '原话', 30000, { signal: disconnected.signal });
  await new Promise(resolve => setImmediate(resolve));
  disconnected.abort(); finishRead([[{ id: 'chat' }]]);
  await expect(pending).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect(conn.execute).toHaveBeenCalledTimes(1); expect(conn.rollback).toHaveBeenCalledTimes(1); expect(conn.release).toHaveBeenCalledTimes(1);
  expect(conn.commit).not.toHaveBeenCalled();
});

test('every snapshot exposes retry claims even before the child persists or the parent exceeds the cursor', async () => {
  const executor={execute:jest.fn(async sql=>sql.startsWith('SELECT id FROM ai_conversation')?[[{id:'chat'}]]:[[]])};
  const retryLinks=[{retryOf:'parent',requestId:'child'}];
  const conversations={messagesSince:jest.fn(async()=>({messages:[],lastId:200})),retryLinks:jest.fn(async()=>retryLinks)};
  const state=await createConversationSyncStore({executor,conversations,clock:()=>1000}).snapshot('owner','chat',200);
  expect(state.messages).toEqual([]);expect(state.retryLinks).toEqual(retryLinks);
  expect(conversations.retryLinks).toHaveBeenCalledWith('owner','chat');
});

test.each(['queued','running'])('a completed request wins over a stale %s activity and its expired deadlines', async activityStatus => {
  const executor={execute:jest.fn(async sql=>{
    if(sql.startsWith('SELECT id FROM ai_conversation')) return [[{id:'chat'}]];
    if(sql.includes('FROM ai_chat_activity')) return [[{request_id:'done',message_payload:encryptField('已完成'),
      status:activityStatus,stage:'reading',error_code:null,notice:null,created_at:1,updated_at:2,deadline_at:5}]];
    if(sql.includes('FROM ai_request_run')) return [[{id:'done',status:'completed',error_code:null,deadline_at:5}]];
    return [[]];
  })};
  const store=createConversationSyncStore({executor,clock:()=>1000,conversations:rememberConversations()});
  const activity=(await store.snapshot('owner','chat',0)).activities[0];
  expect(activity).toMatchObject({status:'completed',stage:'completed'});
  expect(activity).not.toHaveProperty('errorCode');expect(activity).not.toHaveProperty('notice');
  expect(executor.execute.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
});

test('duplicate handles and late progress cannot overwrite the original execution or terminal status',async()=>{
  let row;
  const executor={execute:jest.fn(async(sql,params)=>{
    if(sql.startsWith('SELECT'))return [[{id:'chat'}]];
    if(sql.startsWith('INSERT')){row ||= {token:params[3],status:'queued',stage:'queued'};return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE')){
      if(row.token===params.at(-1)&&['queued','running'].includes(row.status)){row.status=params[0];row.stage=params[1];}
      return [{affectedRows:1}];
    }
    throw Error('Unexpected SQL');
  })};
  const store=createConversationSyncStore({executor,clock:()=>1000});
  const original=await store.begin('owner','chat','request','原话',30000),duplicate=await store.begin('owner','chat','request','原话',30000);
  await store.update(original,'running','reading');await store.update(duplicate,'failed','failed');expect(row.status).toBe('running');
  await store.update(original,'completed','completed');await store.update(original,'running','thinking');expect(row.status).toBe('completed');
});

test('activity creation locks its parent and owner deletion uses the caller transaction',async()=>{
  const calls=[],conn={beginTransaction:jest.fn(),commit:jest.fn(),rollback:jest.fn(),release:jest.fn(),execute:jest.fn(async(sql,params)=>{
    calls.push({sql,params});return sql.startsWith('SELECT')?[[{id:'chat'}]]:[{affectedRows:1}];
  })};
  const executor={getConnection:async()=>conn,execute:jest.fn()};const store=createConversationSyncStore({executor});
  await store.begin('owner','chat','request','原话',30000);
  expect(calls[0].sql).toContain('FOR UPDATE');expect(conn.commit).toHaveBeenCalledTimes(1);expect(conn.release).toHaveBeenCalledTimes(1);
  await store.remove('owner','chat',conn);expect(calls.at(-1)).toEqual({sql:'DELETE FROM ai_chat_activity WHERE user_id=? AND conversation_id=?',params:['owner','chat']});
  expect(executor.execute).not.toHaveBeenCalled();
});

test('activity cleanup failure is diagnosed without failing an already loaded conversation list',async()=>{
  const list=[{id:'chat',title:'history',messageCount:2}],error=Object.assign(Error('cleanup failed'),{code:'ER_CANT_AGGREGATE_2COLLATIONS'});
  const conversationStore={list:jest.fn(async()=>list)},sync={pruneOrphans:jest.fn(async()=>{throw error;})};
  const service=createAiService({conversationStore,conversationSyncStore:sync,settingsStore:createSettingsStore()});
  const logger=jest.spyOn(console,'error').mockImplementation(()=>{});
  try{
    await expect(service.listConversations('owner')).resolves.toBe(list);
    expect(conversationStore.list).toHaveBeenCalledWith('owner',50);expect(sync.pruneOrphans).toHaveBeenCalledWith('owner');
    expect(logger.mock.calls.flat().join(' ')).toContain('conversation-activity-prune');
    conversationStore.list.mockRejectedValueOnce(Error('history unavailable'));
    await expect(service.listConversations('owner')).rejects.toThrow('history unavailable');
    expect(sync.pruneOrphans).toHaveBeenCalledTimes(1);
  }finally{logger.mockRestore();}
});

// Stateful activity/receipt fixture: same SQL semantics as MySQL for the rows
// conversationSync owns, so begin() decisions can be exercised end to end.
function syncDb({ transactional = false } = {}) {
  const activities = new Map(), runs = new Set(), calls = [];
  const key = (userId, requestId) => userId + '|' + requestId;
  const run = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'chat' }]];
    if (sql.startsWith('SELECT status FROM ai_chat_activity')) {
      const row = activities.get(key(params[0], params[1]));
      return [row ? [{ status: row.status }] : []];
    }
    if (sql.startsWith('SELECT 1 FROM ai_request_run')) return [runs.has(key(params[0], params[1])) ? [{ 1: 1 }] : []];
    if (sql.startsWith('INSERT INTO ai_chat_activity')) {
      const [user_id, request_id, conversation_id, execution_token, message_payload, created_at, updated_at, deadline_at] = params;
      if (!activities.has(key(user_id, request_id))) activities.set(key(user_id, request_id), { user_id, request_id, conversation_id,
        execution_token, message_payload, status: 'queued', stage: 'queued', error_code: null, notice: null, created_at, updated_at, deadline_at });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_chat_activity SET conversation_id=')) {
      const row = activities.get(key(params[5], params[6]));
      if (!row || row.status !== 'failed') return [{ affectedRows: calls.at(-1).affectedRows = 0 }];
      Object.assign(row, { conversation_id: params[0], execution_token: params[1], message_payload: params[2], status: 'queued',
        stage: 'queued', error_code: null, notice: null, updated_at: params[3], deadline_at: params[4] });
      return [{ affectedRows: calls.at(-1).affectedRows = 1 }];
    }
    if (sql.startsWith('UPDATE ai_chat_activity SET status=')) {
      const row = activities.get(key(params[5], params[6]));
      if (!row || row.execution_token !== params[7] || !['queued', 'running'].includes(row.status)) return [{ affectedRows: calls.at(-1).affectedRows = 0 }];
      Object.assign(row, { status: params[0], stage: params[1], error_code: params[2], notice: params[3], updated_at: params[4] });
      return [{ affectedRows: calls.at(-1).affectedRows = 1 }];
    }
    if (sql.includes('FROM ai_chat_activity WHERE user_id=? AND conversation_id=?')) {
      return [[...activities.values()].filter(row => row.user_id === params[0] && row.conversation_id === params[1])];
    }
    return [[]];
  };
  const execute = jest.fn(run);
  if (!transactional) return { executor: { execute }, activities, runs, calls };
  const conn = { beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}), release: jest.fn(() => {}), execute: jest.fn(run) };
  return { executor: { execute, getConnection: jest.fn(async () => conn) }, activities, runs, calls, conn };
}
const rememberConversations = () => ({ messagesSince: jest.fn(async () => ({ messages: [], lastId: 0 })) });
const lastStatusUpdate = calls => calls.filter(call => call.sql.startsWith('UPDATE ai_chat_activity SET status=')).at(-1);

test('an unreceipted busy refusal is requeued under the same id and the retry is visible through to completion', async () => {
  const { executor, activities } = syncDb();
  const store = createConversationSyncStore({ executor, conversations: rememberConversations(), clock: () => 1000 });
  const refused = await store.begin('owner', 'chat', 'request', '原话', 30000);
  await store.update(refused, 'failed', 'failed', { code: 'AI_REQUEST_BUSY', message: 'AI 正在处理其他请求' });
  const retried = await store.begin('owner', 'chat', 'request', '原话', 30000);
  expect(retried.token).not.toBe(refused.token);
  const queued = (await store.snapshot('owner', 'chat', 0)).activities[0];
  expect(queued).toMatchObject({ status: 'queued', stage: 'queued' });expect(queued).not.toHaveProperty('errorCode');
  await store.update(retried, 'running', 'thinking');
  expect((await store.snapshot('owner', 'chat', 0)).activities[0]).toMatchObject({ status: 'running', stage: 'thinking' });
  await store.update(refused, 'running', 'reading');
  expect(activities.get('owner|request').status).toBe('running');
  await store.update(retried, 'completed', 'completed');
  const completed = (await store.snapshot('owner', 'chat', 0)).activities[0];
  expect(completed).toMatchObject({ status: 'completed', stage: 'completed' });expect(completed).not.toHaveProperty('errorCode');
});

test('an admitted failure receipt keeps its execution token and cannot be requeued', async () => {
  const { executor, activities, runs, calls } = syncDb();
  runs.add('owner|request');
  const store = createConversationSyncStore({ executor, conversations: rememberConversations(), clock: () => 1000 });
  const admitted = await store.begin('owner', 'chat', 'request', '原话', 30000);
  await store.update(admitted, 'failed', 'failed', { code: 'AI_PROVIDER_FAILED', message: '供应商失败' });
  const replay = await store.begin('owner', 'chat', 'request', '原话', 30000);
  const row = activities.get('owner|request');
  expect(row).toMatchObject({ status: 'failed', execution_token: admitted.token, error_code: 'AI_PROVIDER_FAILED' });
  await store.update(replay, 'running', 'thinking');
  expect(lastStatusUpdate(calls).affectedRows).toBe(0);
  expect(activities.get('owner|request')).toMatchObject({ status: 'failed', execution_token: admitted.token });
});

test('a concurrent second begin cannot take over a running execution', async () => {
  const { executor, activities, calls } = syncDb();
  const store = createConversationSyncStore({ executor, conversations: rememberConversations(), clock: () => 1000 });
  const first = await store.begin('owner', 'chat', 'request', '原话', 30000);
  await store.update(first, 'running', 'thinking');
  const second = await store.begin('owner', 'chat', 'request', '原话', 30000);
  expect(second.token).not.toBe(first.token);
  expect(activities.get('owner|request')).toMatchObject({ status: 'running', stage: 'thinking', execution_token: first.token });
  await store.update(second, 'completed', 'completed');
  expect(lastStatusUpdate(calls).affectedRows).toBe(0);
  expect(activities.get('owner|request').status).toBe('running');
});

test('a completed turn is never requeued or replayed by another begin', async () => {
  const { executor, activities, calls } = syncDb();
  const store = createConversationSyncStore({ executor, conversations: rememberConversations(), clock: () => 1000 });
  const first = await store.begin('owner', 'chat', 'request', '原话', 30000);
  await store.update(first, 'running', 'thinking');await store.update(first, 'completed', 'completed');
  const replay = await store.begin('owner', 'chat', 'request', '原话', 30000);
  expect(activities.get('owner|request')).toMatchObject({ status: 'completed', stage: 'completed', execution_token: first.token });
  await store.update(replay, 'running', 'thinking');
  expect(lastStatusUpdate(calls).affectedRows).toBe(0);
  expect(activities.get('owner|request').status).toBe('completed');
});

test('transactional requeue locks the activity, preserves created_at and commits once', async () => {
  const { executor, activities, calls, conn } = syncDb({ transactional: true });
  activities.set('owner|request', { user_id: 'owner', request_id: 'request', conversation_id: 'chat', execution_token: 'old',
    message_payload: encryptField('原话'), status: 'failed', stage: 'failed', error_code: 'AI_REQUEST_BUSY', notice: '请稍后再试',
    created_at: 10, updated_at: 20, deadline_at: 30 });
  const store = createConversationSyncStore({ executor, clock: () => 1000 });
  const handle = await store.begin('owner', 'chat', 'request', '原话', 30000);
  expect(activities.get('owner|request')).toMatchObject({ conversation_id: 'chat', execution_token: handle.token,
    status: 'queued', stage: 'queued', created_at: 10, updated_at: 1000, deadline_at: 31000 });
  expect(activities.get('owner|request').error_code).toBeNull();expect(activities.get('owner|request').notice).toBeNull();
  expect(calls.find(call => call.sql.startsWith('SELECT status FROM ai_chat_activity')).sql).toContain('FOR UPDATE');
  expect(calls.some(call => call.sql.startsWith('INSERT INTO ai_chat_activity'))).toBe(false);
  expect(conn.commit).toHaveBeenCalledTimes(1);expect(conn.release).toHaveBeenCalledTimes(1);
});
