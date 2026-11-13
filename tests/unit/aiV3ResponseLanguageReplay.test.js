jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Live DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Live DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const Chinese='根据你保存的偏好：编程说明请使用 English；你喜欢红色，不喜欢蓝色。';
function store(){return {list:jest.fn(async()=>({files:[],warnings:[],totalBytes:0})),write:jest.fn(()=>{throw Error('No memory writes');})};}
test('English current request is explicitly carried to finalization and wrong-language correction is tool-free',async()=>{
 const memoryStore=store();
 const answer='Your programming explanations should use English. You prefer red and do not prefer blue.';
 const f=fixture([final({answer:Chinese}),final({answer:Chinese}),final({answer})],{memoryStore});
 const result=await f.send('What language should you use for programming explanations, and what color do I prefer?');
 expect(result.answer).toBe(answer);expect(f.provider).toHaveBeenCalledTimes(3);
 const [,messages,tools,options]=f.provider.mock.calls[2];
 expect(tools).toEqual([]);expect(options.json).toBe(true);
 expect(messages.at(-1).content).toContain('Answer in English');
 expect(messages.some(m=>m.content?.includes('wrong response language'))).toBe(true);
 expect(JSON.parse(f.provider.mock.calls[0][1][1].content.slice('TASK_INPUT:\n'.length)).responseLanguage).toBe('en');
 expect(memoryStore.write).not.toHaveBeenCalled();
});
test('language correction is bounded to one existing-budget call and preserves a valid answer if still wrong',async()=>{
 const f=fixture([final({answer:Chinese}),final({answer:Chinese}),final({answer:Chinese})],{memoryStore:store()});
 const result=await f.send('What color do I prefer?');
 expect(result.answer).toBe(Chinese);expect(f.provider).toHaveBeenCalledTimes(3);
 expect(f.audits.filter(row=>row.phase==='language-recovery')).toHaveLength(1);
});
test('invalid JSON does not become a language-repair retry',async()=>{
 const f=fixture([final({answer:Chinese}),{role:'assistant',content:'not JSON'}],{memoryStore:store()});
 await expect(f.send('What color do I prefer?')).rejects.toMatchObject({code:'AI_INVALID_RESULT'});
 expect(f.provider).toHaveBeenCalledTimes(2);
});
