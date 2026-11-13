jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Public DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Public DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture}=require('../fixtures/aiV3MemoryFixture');
const {validWindowClaims}=require('../../src/modules/ai/service/queryWindowClaims');
const {buildQueryAnswer}=require('../../src/modules/ai/service/v3Service'),capture=require('../fixtures/aiOmittedDateWindowCaptured.json'),clone=x=>structuredClone(x),outcomes=[];
const dataset=()=>clone(capture.current.result.datasets[0]);
let log,error;beforeEach(()=>{log=jest.spyOn(console,'log').mockImplementation(()=>{});error=jest.spyOn(console,'error').mockImplementation(()=>{});});afterEach(()=>{log.mockRestore();error.mockRestore();});
test('original C10 capture and independent full source are diagnostic evidence, not approved omitted-date proof',()=>{
  expect(capture.current.providers).toHaveLength(4);expect(capture.current.providers.at(-1).content).toContain('2026-05-15 之前');
  expect(capture.baselineEvidence.fullCount).toBe(53);expect(capture.baselineEvidence.unreturnedRows.map(row=>row.date)).toEqual(['2026-05-14','2026-05-14','2026-05-13']);
  expect(dataset().queryMeta).toMatchObject({matchedRowCount:53,returnedRowCount:50,rowsComplete:false,returnedDateRange:{startDate:'2026-05-15',endDate:'2026-08-13'}});
});
test.each([
  ['另有3条更早记录（2026-05-15之前）未包含在本次展示内。',false],
  ['更早的3条（2026-05-15 之前）未包含在本次50条内。',false],
  ['未返回的记录早于2026-05-15。',false],['The omitted records are before 2026-05-15.',false],
  ['The remaining records are earlier than 2026-05-15.',false],
  ['未返回记录不晚于2026-05-15。',true],['未返回记录不迟于2026-05-15。',true],
  ['The omitted records are on or before 2026-05-15.',true],['The remaining records are no later than 2026-05-15.',true],
  ['未返回记录早于2026-05-16。',true],['未返回记录晚于2026-04-30。',true],
  ['未返回记录晚于2026-05-01。',false],['未返回记录早于2026-05-14。',false],
  ['无法确认未返回记录是否早于2026-05-15。',true],
  ['当前展示记录日期范围为2026-05-15至2026-08-13。',true],
  ['同一日期的记录可能未全部展示。',true],
  ['另有3条更早记录（2026年5月15日之前）未包含在本次展示内。',false],
  ['另有3条更早记录（5月15日之前）未包含在本次展示内。',false],
  ['未返回记录早于2026年5月15日。',false],['未返回记录早于5月15日。',false],
  ['未返回记录早于05月15日。',false],['未返回记录不晚于2026年5月15日。',true],
  ['未返回记录不晚于5月15日。',true],['未返回记录不迟于05月15日。',true],
  ['未返回记录早于2026年5月16日。',true],['未返回记录早于5月16日。',true],
  ['未返回记录晚于2026年4月30日。',true],['未返回记录晚于4月30日。',true],
  ['未返回记录晚于2026年5月1日。',false],['未返回记录晚于5月1日。',false],
  ['未返回记录早于2026年2月30日。',false],['未返回记录早于2月30日。',false],
  ['无法确定总额，但未返回记录都在2026-05-15之前。',false],
  ['无法确定总额，未返回记录都在2026-05-15之前。',false],
  ['无法确定总额。但未返回记录都在2026-05-15之前。',false],
  ['无法确定总额；未返回记录都在2026-05-15之前。',false],
  ['无法确定总额：未返回记录都在2026-05-15之前。',false],
  ['无法确定总额但是未返回记录都在2026年5月15日之前。',false],
  ['尚未确认总额，未返回记录都在5月15日之前。',false],
  ['Cannot determine the total, but the omitted records are before 2026-05-15.',false],
  ['Cannot determine the total; the omitted records are before 2026-05-15.',false],
  ['未返回记录可能早于2026-05-15。',true],['未返回记录不一定早于5月15日。',true],
  ['无法确认未返回记录早于2026年5月15日。',true],
  ['无法确认未返回记录是否早于5月15日。',true],
  ['The omitted records may be before 2026-05-15.',true],
  ['Cannot confirm the omitted records are before 2026-05-15.',true],
  ['未返回记录不早于2026-05-16。',false],['未返回记录不早于5月16日。',false],
  ['The remaining records are not before 2026-05-16.',false],
  ['未返回记录不早于2026-05-01。',true],['未返回记录不早于5月1日。',true],
  ['The remaining records are not before 2026-05-01.',true],
  ['The remaining records are not earlier than 2026-05-16.',false],
  ['The remaining records are no earlier than 2026-05-16.',false],
  ['The omitted records are on or after 2026-05-16.',false],
  ['The omitted records are on or after 2026-05-01.',true],
  ['The omitted records are not after 2026-05-15.',true],
  ['The omitted records are not after 2026-04-30.',false],
  ['未返回记录不在5月16日之前。',false],['未返回记录不在5月1日之前。',true],
  ['未返回记录并非早于2026-05-16。',false],['未返回记录不是早于2026-05-16。',false],
  ['The omitted records are never before 2026-05-16.',false],
  ['THE OMITTED RECORDS ARE NEVER BEFORE 2026-05-16.',false],
])('current date window enforces inclusive boundary and preserves facts: %s',(sentence,expected)=>expect(validWindowClaims(sentence,[dataset()])).toBe(expected));
test.each([
  ['amount sorted',d=>{d.queryMeta.sort='amountDesc';}],['unknown sort',d=>{d.queryMeta.sort='unknown';}],
  ['no query ID',d=>{delete d.queryMeta.queryId;}],['wrong identity',d=>{d.queryMeta.datasetId='finance-transactions';}],
  ['missing row date',d=>{d.rows[0].date=null;}],['unpublished date column',d=>{d.columns=d.columns.filter(c=>c.key!=='date');}],
  ['incorrect lower window date',d=>{d.queryMeta.returnedDateRange.startDate='2026-05-14';}],
  ['incorrect upper window date',d=>{d.queryMeta.returnedDateRange.endDate='2026-08-14';}],
  ['unordered rows',d=>{d.rows.reverse();}],['wrong returned count',d=>{d.queryMeta.returnedRowCount=49;}],
  ['full rows',d=>{d.queryMeta.rowsComplete=true;d.queryMeta.matchedRowCount=50;}],
  ['unknown matched count',d=>{d.queryMeta.matchedRowCount=null;}],['invalid scope',d=>{d.queryMeta.effectiveScope.startDate='2026-02-30';}],
  ['saved state source',d=>{d.datasetId='card-cards';d.queryMeta.datasetId='card-cards';}],
])('inclusive bound needs published current source/order/range proof: %s',(_,mutate)=>{const d=dataset();mutate(d);expect(validWindowClaims('未返回记录不晚于2026-05-15。',[d])).toBe(false);});
test('a second query cannot authorize an ambiguous omitted-date assertion',()=>expect(validWindowClaims('未返回记录不晚于2026-05-15。',[dataset(),dataset()])).toBe(false));
test.each([
  ['未返回记录不晚于5月15日。',false],['未返回记录早于5月16日。',false],
  ['未返回记录不晚于2026年5月15日。',true],['未返回记录早于2026年5月16日。',true],
])('short Chinese date requires one scope year; explicit year remains valid: %s',(sentence,expected)=>{
  const d=dataset();d.queryMeta.effectiveScope.startDate='2025-11-01';
  expect(validWindowClaims(sentence,[d])).toBe(expected);
});
test('uncertainty on an omitted-date clause never authorizes a separate following assertion',()=>{
  expect(validWindowClaims('无法确认未返回记录是否早于2026-05-15，但未返回记录都在5月15日之前。',[dataset()])).toBe(false);
  expect(validWindowClaims('无法确认未返回记录是否早于2026-05-15；未返回记录都在2026年5月15日之前。',[dataset()])).toBe(false);
});
test('tie guidance does not authorize a following population property claim',()=>expect(validWindowClaims('同一日期的记录可能未全部展示，全部还款金额为0。',[dataset()])).toBe(false));
test('same-day ties do not prove strictly earlier omitted dates',()=>{
  const d=dataset();d.rows=d.rows.slice(-1);d.queryMeta.returnedRowCount=1;d.queryMeta.matchedRowCount=2;
  d.queryMeta.returnedDateRange={startDate:'2026-05-15',endDate:'2026-05-15'};
  expect(validWindowClaims('未返回记录不晚于2026-05-15。',[d])).toBe(true);
  expect(validWindowClaims('未返回记录早于2026-05-15。',[d])).toBe(false);
});
test('canonical current visible coverage survives rejected omitted-date sentence without altering data',()=>{
  const d=dataset(),before=JSON.stringify(d),answer=buildQueryAnswer('另有3条更早记录（2026-05-15之前）未包含在本次展示内。\n当前展示记录日期范围为2026-05-15至2026-08-13。',[d]);
  expect(answer).not.toContain('2026-05-15之前');expect(answer).toContain('当前展示记录日期范围为2026-05-15至2026-08-13');expect(JSON.stringify(d)).toBe(before);
});
test.each([
  '另有3条更早记录（2026年5月15日之前）未包含在本次展示内。',
  '另有3条更早记录（5月15日之前）未包含在本次展示内。',
  '无法确定总额，但未返回记录都在2026-05-15之前。',
])('actual answer builder discards unsupported omitted boundary without changing published rows: %s',sentence=>{
  const d=dataset(),before=JSON.stringify(d),answer=buildQueryAnswer(sentence+'\n当前展示记录日期范围为2026-05-15至2026-08-13。',[d]);
  expect(answer).not.toContain(sentence);expect(answer).toContain('当前展示记录日期范围为2026-05-15至2026-08-13');expect(JSON.stringify(d)).toBe(before);
});
test('actual createV3Service preserves the four original provider rounds, range and chart while excluding unsupported strict date bound',async()=>{
  let queryId;const originalQueryId=dataset().queryMeta.queryId;
  const scripted=capture.current.providers.map(provider=>()=>({role:'assistant',content:provider.content?.split(originalQueryId).join(queryId||originalQueryId)??null,
    reasoning_content:provider.reasoning,...(provider.toolCalls.length?{tool_calls:clone(provider.toolCalls)}:{})}));
  const f=fixture(scripted,{memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))},clock:()=>new Date('2026-11-09T15:22:08.173Z')});
  for(const turn of capture.history)f.history.push({role:turn.role,content:turn.content,...clone(turn.meta),sourceDate:'2026-11-09'});
  f.state.taskContext=clone(capture.history.findLast(turn=>turn.role==='assistant').meta.taskContext);
  f.repository.query.mockImplementation(async(_,input)=>{queryId=input.queryId;const raw=clone(capture.current.tool.result);raw.datasets[0].queryMeta.queryId=queryId;
    return{scope:input.scope,datasets:raw.datasets,choices:raw.choices,asOf:raw.asOf};});
  const result=await f.send(capture.current.message),messages=f.provider.mock.calls.map(call=>clone(call[1]));
  outcomes.push({mode:process.env.AI_C10_MODE||'candidate',sourceKind:'original-paid-response/scripted-provider/current-actual-service',originalRequestId:capture.current.requestId,
    originalAnswer:capture.current.result.answer,result,regeneratedProviderMessages:messages,repositoryCalls:f.repository.query.mock.calls,replayAudits:f.audits});
  expect(f.provider).toHaveBeenCalledTimes(4);expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(result.answer).not.toContain('2026-05-15 之前');expect(result.answer).toContain('2026-05-15 至 2026-08-13');
  expect(result.answer).toContain('匹配 53 行，本次展示 50 行');expect(result.chart).toMatchObject({queryId,type:'line',xKey:'date',yKeys:['amount']});
  expect(result.datasets[0].queryMeta).toEqual({...dataset().queryMeta,queryId});
  expect(result.datasets[0].rows).toEqual(dataset().rows.map(row=>Object.fromEntries(dataset().columns.map(column=>[column.key,row[column.key]]))));
  for(const raw of messages){const input=JSON.parse(raw.find(item=>item.content?.startsWith('TASK_INPUT:')).content.slice(11));
    expect(input.taskContext.scope).toEqual({startDate:'2026-05-01',endDate:'2026-08-31'});
    expect(input.priorAnswers).toEqual(capture.current.providers[0].taskInput.priorAnswers);}
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(result.answer);expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
afterAll(()=>{
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
