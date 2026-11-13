jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw new Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw new Error('Paid provider forbidden');})}));
const fs=require('node:fs/promises'),path=require('node:path');
const {createMemoryStore}=require('../../src/modules/ai/service/memoryStore');
const {fixture,final,calls,now}=require('../fixtures/aiV3MemoryFixture');
const {fixture:guardFixture,request}=require('../fixtures/aiMemoryGuardFixture');
const {memoryFailureNotice}=require('../../src/modules/ai/service/memoryEvidence');
const roots=[],base=path.resolve(__dirname,'../../../temp/ai-all23-20261109'),source='我喜欢红色。';
const args=content=>({path:'preference.md',operation:'create',title:'颜色偏好',type:'preference',content,evidence:{sourceTurn:0,quote:source},reason:'保存用户原话'});
async function store(){const root=await fs.mkdtemp(path.join(base,'candidate-memory-'));roots.push(root);return createMemoryStore({root,now});}
afterAll(async()=>{for(const root of roots){const relative=path.relative(base,path.resolve(root));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Unsafe cleanup');await fs.rm(root,{recursive:true,force:true});}});
test('V3 rejects red-source blue-body and does not claim memory saved',async()=>{
 const memoryStore=await store(),f=fixture([calls('memory_write',args('我喜欢蓝色。')),final({answer:'已保存你的颜色偏好。'})],{memoryStore});
 const result=await f.send(source);expect((await memoryStore.list('offline-memory-owner')).files).toHaveLength(0);expect(result.answer).toContain('未保存');
 const tool=JSON.parse(f.provider.mock.calls[1][1].findLast(m=>m.role==='tool').content);expect(tool.code).toBe('AI_MEMORY_CONTENT_NOT_SOURCED');
});
test('V3 truthfully discloses already-saved memory when final JSON fails',async()=>{
 const memoryStore=await store(),f=fixture([calls('memory_write',args(source)),{role:'assistant',content:'not-json'}],{memoryStore});
 await expect(f.send(source)).rejects.toMatchObject({code:'AI_INVALID_RESULT',message:expect.stringContaining('已保存 1 条长期记忆')});
 expect(f.history.findLast(turn=>turn.failure).content).toContain('已生效');expect((await memoryStore.list('offline-memory-owner')).files).toHaveLength(1);
});
test('guard durable failed receipt retains the same proved memory notice',async()=>{
 const f=guardFixture(),notice=memoryFailureNotice([{saved:true,changed:true,path:'preference.md',revision:'a'.repeat(64)}]);
 await expect(f.guard.run('owner',request('memory-failure',{failureNotice:()=>notice}),async()=>{throw new Error('later failure');})).rejects.toMatchObject({code:'AI_REQUEST_FAILED',message:expect.stringContaining(notice)});
 const first=await f.guard.get('owner','memory-failure'),second=await f.make().get('owner','memory-failure');expect(first.error.message).toContain(notice);expect(second).toEqual(first);expect(first.providerCalls).toBe(0);
});
test('guard cancellation after a proved save exposes that effect in durable receipt',async()=>{
 const f=guardFixture(),controller=new AbortController(),notice=memoryFailureNotice([{saved:true,changed:true,path:'preference.md',revision:'a'.repeat(64)}]);
 let started;const ready=new Promise(resolve=>started=resolve);
 const work=f.guard.run('owner',request('memory-cancel',{signal:controller.signal,failureNotice:()=>notice}),async()=>{started();return new Promise(()=>{});});
 const expectation=expect(work).rejects.toMatchObject({code:'AI_REQUEST_CANCELLED',message:expect.stringContaining(notice)});await ready;controller.abort();await expectation;
 expect((await f.guard.get('owner','memory-cancel')).error.message).toContain(notice);
});
