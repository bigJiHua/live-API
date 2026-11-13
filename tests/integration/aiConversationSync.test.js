jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
const express=require('express');
const {randomUUID}=require('crypto');
const {createAiRouter}=require('../../src/modules/ai/api');
const {AiError}=require('../../src/modules/ai/service/errors');
let server,base,state;
const conversationId=randomUUID(), requestId=randomUUID(), draftId=randomUUID();
const agent={chat:jest.fn()}, service={getConversationSync:jest.fn(async(owner,id,since)=>{
  if(owner!=='owner'||id!==conversationId||state.deleted) throw new AiError('已删除',404,'AI_CONVERSATION_EXPIRED');
  return {conversationId,lastId:state.lastId,messages:state.messages.filter(item=>item.messageId>since),
    activities:[{requestId,message:'查询',status:state.status,stage:state.stage}],
    entities:{drafts:[{id:draftId,status:'pending',version:state.version}],proposals:[],candidates:[]},revision:String(state.version)+state.stage};
})};
beforeAll(async()=>{
  const app=express();app.use(express.json());app.use('/ai',createAiRouter({service,agent,business:{},syncIntervalMs:10,syncLifetimeMs:2000,
    guard:(req,res,next)=>{req.userId=req.headers['x-owner'];if(!req.userId)return res.status(401).json({status:401});next();}}));
  server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});base=`http://127.0.0.1:${server.address().port}/ai`;
});
beforeEach(()=>{state={status:'queued',stage:'queued',version:1,messages:[],lastId:0};agent.chat.mockClear();service.getConversationSync.mockClear();});
afterAll(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function stream(since=0){
  const controller=new AbortController();
  const response=await fetch(`${base}/conversations/${conversationId}/events?since=${since}`,{headers:{'x-owner':'owner'},signal:controller.signal});
  expect(response.status).toBe(200);const reader=response.body.getReader();let buffer='';const decoder=new TextDecoder();
  return {close:()=>controller.abort(),async next(predicate=()=>true){
    for(;;){let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
      const data=frame.match(/^data: (.*)$/m),event=frame.match(/^event: (.*)$/m);if(data){const value={event:event?.[1],data:JSON.parse(data[1])};if(predicate(value))return value;}}
      const part=await reader.read();if(part.done)throw Error('Stream ended');buffer+=decoder.decode(part.value,{stream:true});
    }
  }};
}
test('two devices receive queued/running/final messages and artifact versions, and reconnect retrieves current state',async()=>{
  const a=await stream(),b=await stream();let c;
  try{
    expect((await a.next()).data.activities[0].status).toBe('queued');expect((await b.next()).data.activities[0].status).toBe('queued');
    state.status='running';state.stage='reading';
    await Promise.all([a.next(frame=>frame.data.activities?.[0].status==='running'),b.next(frame=>frame.data.activities?.[0].status==='running')]);
    state.status='completed';state.stage='completed';state.lastId=2;state.messages=[{messageId:1,role:'user',content:'查询'},{messageId:2,role:'assistant',content:'结果'}];
    const results=await Promise.all([a.next(frame=>frame.data.lastId===2),b.next(frame=>frame.data.lastId===2)]);
    expect(results.every(frame=>frame.data.messages.length===2)).toBe(true);
    state.version=2;expect((await b.next(frame=>frame.data.entities?.drafts[0].version===2)).data.messages).toEqual([]);
    c=await stream(2);const replay=await c.next();expect(replay.data.messages).toEqual([]);expect(replay.data.entities.drafts[0].version).toBe(2);
    state.deleted=true;await Promise.all([a.next(frame=>frame.event==='deleted'),b.next(frame=>frame.event==='deleted')]);
    expect(agent.chat).not.toHaveBeenCalled();
  }finally{a.close();b.close();c?.close();}
});
test('synchronization requires authentication and owner access, validates cursors, and accepts no POST action',async()=>{
  const path=`${base}/conversations/${conversationId}`;
  expect((await fetch(path+'/sync')).status).toBe(401);
  expect((await fetch(path+'/events',{headers:{'x-owner':'stranger'}})).status).toBe(404);
  expect((await fetch(path+'/sync?since=-1',{headers:{'x-owner':'owner'}})).status).toBe(400);
  expect((await fetch(path+'/events',{method:'POST',headers:{'x-owner':'owner'}})).status).toBe(404);
  expect(agent.chat).not.toHaveBeenCalled();
});
