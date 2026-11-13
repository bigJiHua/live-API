jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Public DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Public DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture}=require('../fixtures/aiV3MemoryFixture'),capture=require('../fixtures/aiCardCountRankCaptured.json'),clone=x=>structuredClone(x);
test('original paid F07 two provider rounds replay through the actual service with unchanged scope, data and saved receipt',async()=>{
 let queryId;const originalQueryId=capture.current.result.datasets[0].queryMeta.queryId;
 const responses=capture.current.providers.map(provider=>()=>({role:'assistant',content:provider.content?.split(originalQueryId).join(queryId||originalQueryId)??null,
  reasoning_content:provider.reasoning,...(provider.toolCalls.length?{tool_calls:clone(provider.toolCalls)}:{})}));
 const f=fixture(responses,{memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))},clock:()=>new Date('2026-11-10T00:09:36.365Z')});
 const old=capture.current.providers[0].taskInput,coverage=clone(old.previousQueryCoverage[0]);
 const queryContext={version:1,activeQuery:{...coverage.effectiveScope,direction:null,category:null,metric:'summary',status:'succeeded',explicit:{},periodSource:'default'},lastResults:[coverage]};
 const taskContext=clone(old.taskContexts.tasks[0]);
 f.history.push({role:'user',content:capture.history.message,sourceDate:'2026-11-10'},
  {role:'assistant',content:capture.history.result.answer,sourceDate:'2026-11-10',queryContext,taskContext});
 f.state.queryContext=queryContext;f.state.taskContext=taskContext;
 f.repository.query.mockImplementation(async(_,input)=>{queryId=input.queryId;const raw=clone(capture.current.tool.result);raw.datasets[0].queryMeta.queryId=queryId;
  return{scope:input.scope,datasets:raw.datasets,choices:raw.choices,asOf:raw.asOf};});
 const result=await f.send(capture.current.message),messages=f.provider.mock.calls.map(call=>clone(call[1]));
 expect(f.provider).toHaveBeenCalledTimes(2);expect(f.repository.query).toHaveBeenCalledTimes(1);
 expect(result.answer).not.toMatch(/降序首位|\| 借记卡 \|/);
 expect(result.answer).toContain('| 信用卡 | 20 | 24.7 |');expect(result.answer).toContain('卡片数量占比(%)');
 expect(result.answer).toContain('匹配 4 行，本次展示 1 行，来源 81 张卡片');expect(result.answer).toContain('数量 81');
 expect(result.datasets[0].queryMeta).toEqual({...capture.current.result.datasets[0].queryMeta,queryId});
 expect(result.datasets[0].rows).toEqual([{type:'信用卡',count:20,sharePct:'24.7'}]);
 for(const raw of messages){const input=JSON.parse(raw.find(item=>item.content?.startsWith('TASK_INPUT:')).content.slice(11));
  expect(input.priorAnswers).toEqual(old.priorAnswers);expect(input.previousQueryCoverage[0].effectiveScope).toEqual(coverage.effectiveScope);}
 expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(result.answer);expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
 expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
 expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
