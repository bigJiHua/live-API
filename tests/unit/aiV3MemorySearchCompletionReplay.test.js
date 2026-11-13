jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Live DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Live DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const question='Search my saved memory for the literal text "English" and show me the matching original text.';
function store(truncated=false){return {list:jest.fn(async()=>({files:[],warnings:[],totalBytes:0})),search:jest.fn(async()=>({matches:[{path:'preferences.md',line:2,text:'I prefer English and red.',textTruncated:truncated}],count:1,truncated:false,warnings:[]})),read:jest.fn(()=>{throw Error('Unexpected whole-file read');}),write:jest.fn(()=>{throw Error('Unexpected write');})};}
test('complete original matching line leads directly to final JSON without rereading the file',async()=>{
 const memoryStore=store();const answer='Found 1 matching line in preferences.md: 「I prefer English and red.」';
 const f=fixture([calls('memory_search',{pattern:'English',mode:'literal'}),final({answer})],{memoryStore});
 const result=await f.send(question);expect(result.answer).toBe(answer);expect(f.provider).toHaveBeenCalledTimes(2);
 expect(f.provider.mock.calls[0][2].map(tool=>tool.function.name)).toEqual(['memory_search']);
 expect(f.provider.mock.calls[1][2]).toEqual([]);expect(f.provider.mock.calls[1][3].json).toBe(true);
 expect(memoryStore.read).not.toHaveBeenCalled();expect(memoryStore.write).not.toHaveBeenCalled();
 expect(result.toolTrace.map(trace=>trace.tool)).toEqual(['memory_search']);
});
test('a clipped matching line keeps the ordinary follow-up tool stage open',async()=>{
 const memoryStore=store(true);
 const f=fixture([calls('memory_search',{pattern:'English'}),final({answer:'This matching line is clipped.'}),final({answer:'This matching line is clipped.'})],{memoryStore});
 await f.send(question);expect(f.provider).toHaveBeenCalledTimes(3);
 expect(f.provider.mock.calls[1][2].map(tool=>tool.function.name)).toEqual(['memory_read','memory_search']);
});
test('a pure search does not execute a provider-selected unrelated memory write',async()=>{
 const memoryStore=store();const f=fixture([calls('memory_write',{})],{memoryStore});
 await expect(f.send(question)).rejects.toMatchObject({code:'AI_TOOL_DENIED'});expect(memoryStore.write).not.toHaveBeenCalled();
});
