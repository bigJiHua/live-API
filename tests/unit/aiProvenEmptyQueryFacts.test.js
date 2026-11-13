const { buildProvenEmptyQueryFacts, isProvenEmptyDataset } = require('../../src/modules/ai/service/queryEmptyFacts');
const { DATASETS, getDatasetCapability } = require('../../src/modules/ai/service/datasetCapabilities');
const { fundQueryFacts } = require('../../src/modules/ai/service/queryFundProse');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
function empty(datasetId='work-salary') {
  const scope={ startDate:'2027-11-01', endDate:'2027-11-09' };
  return { datasetId, domain:DATASETS[datasetId], title:'匿名查询 '+datasetId, columns:[], rows:[], summary:{},
    queryMeta:{ version:1,queryId:'q_'+'a'.repeat(24),datasetId,requestedScope:{...scope},effectiveScope:{...scope},
      filters:{direction:'both',text:'EMPTY_无匹配'},sort:getDatasetCapability(datasetId).defaults.sort,
      matchedRowCount:0,returnedRowCount:0,sourceRecordCount:null,rowsComplete:true,summaryComplete:false,
      rankingComplete:false,returnedDateRange:null,asOf:'2027-11-10T00:00:00Z' } };
}
test.each(Object.keys(DATASETS))('verified empty %s uses server facts without inventing an empty-result cause', id=>{
  const d=empty(id),before=structuredClone(d),answer=buildProvenEmptyQueryFacts([d]);
  expect(isProvenEmptyDataset(d)).toBe(true);expect(answer).toBeTruthy();
  expect(answer).not.toMatch(/标识.*(?:无效|有效)|权限|数据源.*(?:出错|异常)|连接.*失败/);
  expect(d).toEqual(before);expect(() => assertResultClaims(answer,{artifacts:[],currentReceipts:[]})).not.toThrow();
  if(id.startsWith('fund-'))expect(answer).toBe(fundQueryFacts([d]));
});
test('empty salary cannot become zero wages or bank settlement',()=>{
  expect(buildProvenEmptyQueryFacts([empty()])).toContain('没有工资记录不等于零工资，工资登记也不代表银行到账。');
});
test('saved-state data do not acquire a historical date range',()=>{
  const d=empty('work-rules'),answer=buildProvenEmptyQueryFacts([d]);
  expect(answer).toContain(`${d.title}读取目前已保存状态，不按查询起止日期筛选；无法凭该数据集证明历史时点。`);
  expect(answer).not.toContain('扩大日期');
});
test('installment dates select state counts rather than reconstructing plan configuration',()=>{
  expect(buildProvenEmptyQueryFacts([empty('installment-plans')])).toContain('分期计划读取目前保存配置，日期范围仅限定期次状态。');
});
test('mixed all-empty datasets preserve dedicated fund facts and salary caveats',()=>{
  const fund=empty('fund-history'),data=[empty(),fund],before=structuredClone(data),answer=buildProvenEmptyQueryFacts(data);
  expect(answer).toContain(fundQueryFacts([fund]));expect(answer).toContain('零工资');expect(data).toEqual(before);
});
test.each([
  ['missing query metadata',d=>delete d.queryMeta],
  ['unknown match count',d=>d.queryMeta.matchedRowCount=null],
  ['known unreturned records',d=>d.queryMeta.matchedRowCount=7],
  ['partial source',d=>d.queryMeta.rowsComplete=false],
  ['legacy truncation',d=>d.truncated=true],
  ['contradictory row',d=>d.rows=[{name:'example'}]],
  ['nonzero returned count',d=>d.queryMeta.returnedRowCount=1],
  ['contradictory returned date',d=>d.queryMeta.returnedDateRange={startDate:'2027-11-01',endDate:'2027-11-01'}],
  ['missing identity',d=>delete d.queryMeta.queryId],
  ['malformed identity',d=>d.queryMeta.queryId='q_example'],
  ['wrong version',d=>d.queryMeta.version=2],
  ['wrong dataset identity',d=>d.queryMeta.datasetId='fund-history'],
  ['wrong domain',d=>d.domain='fund'],
  ['no title',d=>d.title=''],
  ['non-array rows',d=>d.rows=null],
  ['reversed scope',d=>d.queryMeta.effectiveScope.startDate='2027-11-30'],
  ['invalid calendar date',d=>d.queryMeta.effectiveScope.endDate='2027-11-31'],
  ['absent requested scope',d=>delete d.queryMeta.requestedScope],
  ['contradictory summary count',d=>d.summary.count=8],
  ['contradictory summary expense',d=>d.summary.expense='8.00'],
  ['unknown dataset',d=>d.datasetId='private-other'],
])('%s declines authoritative all-empty presentation',(_,change)=>{
  const d=empty();change(d);expect(isProvenEmptyDataset(d)).toBe(false);expect(buildProvenEmptyQueryFacts([d])).toBe('');
});
test('no query and mixed nonempty data never become an all-empty response',()=>{
  const row=empty('fund-history');row.rows=[{name:'基金甲',date:'2027-11-01',profit:'1.0000'}];row.queryMeta.matchedRowCount=row.queryMeta.returnedRowCount=1;
  expect(buildProvenEmptyQueryFacts([])).toBe('');expect(buildProvenEmptyQueryFacts([empty(),row])).toBe('');
});
test.each(['memory_list','memory_read','memory_search','memory_write','history_search','history_read'])('an actual %s call keeps the established context/receipt presentation path',tool=>{
  expect(buildProvenEmptyQueryFacts([empty()],{toolTrace:[{tool}]})).toBe('');
});
test.each(['记住我的偏好，再看工资。','核对长期记忆。','我说过什么？','搜索之前问过的问题。','读取历史对话原话。','查看聊天记录。','核对更早的聊天。','查阅以前告诉你的消息。','Check my memory.','Remember my preference.','Read conversation history.'])('an explicit context task is not replaced: %s',message=>{
  expect(buildProvenEmptyQueryFacts([empty()],{message})).toBe('');
});
test('ordinary ledger history remains an eligible business query',()=>{
  expect(buildProvenEmptyQueryFacts([empty('card-repayments')],{message:'查询还款历史，没有匹配请说明。'})).toBeTruthy();
});
test('a current business completion still needs the unchanged execution receipt guard',()=>{
  expect(() => assertResultClaims('我已为你入账。',{artifacts:[],currentReceipts:[]})).toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH'}));
});

test.each([
 ['transaction-max','finance-transactions','amountDesc','expense'],
 ['transaction-max','finance-transactions','amountDesc','income'],
 ['daily-max','finance-daily','expenseDesc','expense'],
 ['daily-max','finance-daily','incomeDesc','income'],
])('dedicated empty rank presentation stays on the existing server chain: %s %s %s %s',(activeMetric,id,sort,direction)=>{
 const d=empty(id);d.queryMeta.sort=sort;d.queryMeta.filters.direction=direction;const before=structuredClone(d);
 expect(buildProvenEmptyQueryFacts([d],{activeMetric})).toBe('');expect(d).toEqual(before);
});
test.each([
 ['transaction-max','work-salary','dateDesc','both'],
 ['transaction-max','finance-transactions','dateDesc','expense'],
 ['transaction-max','finance-transactions','amountDesc','both'],
 ['daily-max','finance-daily','dateDesc','expense'],
 ['daily-max','finance-daily','expenseDesc','income'],
 ['daily-max','finance-transactions','amountDesc','expense'],
 ['transactions','finance-transactions','amountDesc','expense'],
])('unrelated or unsupported ranking context keeps proven generic empty facts: %s %s %s %s',(activeMetric,id,sort,direction)=>{
 const d=empty(id);d.queryMeta.sort=sort;d.queryMeta.filters.direction=direction;
 const text=buildProvenEmptyQueryFacts([d],{activeMetric});expect(text).toContain('没有匹配记录');
 expect(text).not.toMatch(/标识.*(?:无效|非法)/);if(id==='work-salary')expect(text).toContain('不等于零工资');
});
test('duplicate rank identities cannot borrow one dedicated answer',()=>{
 const a=empty('finance-transactions');a.queryMeta.sort='amountDesc';a.queryMeta.filters.direction='expense';
 const b=structuredClone(a);b.queryMeta.queryId='q_'+'b'.repeat(24);
 expect(buildProvenEmptyQueryFacts([a,b],{activeMetric:'transaction-max'})).toContain('没有匹配记录');
});
test('an unrelated stale rank metric preserves the dedicated fund facts and context skip',()=>{
 const fund=empty('fund-history');expect(buildProvenEmptyQueryFacts([fund],{activeMetric:'transaction-max'})).toBe(fundQueryFacts([fund]));
 const d=empty('finance-transactions');d.queryMeta.sort='amountDesc';d.queryMeta.filters.direction='expense';
 expect(buildProvenEmptyQueryFacts([d],{activeMetric:'transaction-max',toolTrace:[{tool:'memory_read'}]})).toBe('');
 expect(buildProvenEmptyQueryFacts([d],{activeMetric:'transaction-max',message:'读取历史对话原话'})).toBe('');
});
