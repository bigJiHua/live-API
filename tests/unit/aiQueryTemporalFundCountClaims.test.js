const {validCountClaims}=require('../../src/modules/ai/service/queryCountClaims');
function meta(id,start='2026-05-01',end='2026-06-30',count=2){return {queryId:id,effectiveScope:{startDate:start,endDate:end},filters:{direction:'both',text:''},sourceRecordCount:520,
  matchedRowCount:count,returnedRowCount:count,rowsComplete:true,summaryComplete:true};}
const monthly=()=>({datasetId:'finance-monthly',domain:'finance',columns:[{key:'month',type:'date'},{key:'count',type:'number'}],
  rows:[{month:'2026-05',count:252},{month:'2026-06',count:268}],summary:{count:520,incomeCount:178,expenseCount:342},queryMeta:meta('q_000000000000000000000001')});
const fund=()=>({datasetId:'fund-history',domain:'fund',columns:[{key:'name',type:'text'},{key:'date',type:'date'},{key:'profit',type:'decimal'}],
  rows:[{name:'示例基金',date:'2026-06-02',profit:'8.0000'},{name:'示例基金',date:'2026-06-03',profit:'-8.0000'}],summary:{},
  queryMeta:{...meta('q_000000000000000000000002','2026-06-01','2026-06-30'),sourceRecordCount:null}});
test.each([
  ['5月共252笔流水，6月共268笔流水。',true],['5月共268笔流水，6月共252笔流水。',false],
  ['5月收入178笔。',false],['5月支出342笔。',false],['5月收入笔数178。',false],['5月支出笔数342。',false],
  ['2026-05收入178笔。',false],['全范围收入178笔、支出342笔。',true],['两个月全范围共520笔收支。',true],
  ['5月2日共252笔。',false],['2025年5月共252笔。',false],['2026年13月共252笔。',false],
])('monthly count evidence does not borrow full-range directions: %s',(text,expected)=>expect(validCountClaims(text,[monthly()])).toBe(expected));
test('published monthly directional number fields support the matching month independently',()=>{
  const d=monthly();d.columns.push({key:'incomeCount',type:'number'},{key:'expenseCount',type:'number'});
  Object.assign(d.rows[0],{incomeCount:63,expenseCount:189});Object.assign(d.rows[1],{incomeCount:115,expenseCount:153});
  expect(validCountClaims('5月收入63笔，6月收入115笔。',[d])).toBe(true);
  expect(validCountClaims('5月支出189笔，6月支出153笔。',[d])).toBe(true);
  expect(validCountClaims('5月收入115笔。',[d])).toBe(false);
});
test('exact complete single month retains its full summary directional counts',()=>{
  const d=monthly();d.rows=d.rows.slice(1);d.queryMeta=meta('q_000000000000000000000001','2026-06-01','2026-06-30',1);
  d.summary={count:268,incomeCount:115,expenseCount:153};
  expect(validCountClaims('6月收入115笔、支出153笔。',[d])).toBe(true);
  expect(validCountClaims('6月收入笔数115。',[d])).toBe(true);
  d.queryMeta.effectiveScope.endDate='2026-06-20';expect(validCountClaims('6月收入115笔。',[d])).toBe(false);
  d.queryMeta.effectiveScope.endDate='2026-06-30';d.queryMeta.summaryComplete=false;
  expect(validCountClaims('6月收入115笔。',[d])).toBe(false);
});
test('the single-month full-summary exception cannot borrow another query packet',()=>{
  const d=monthly();d.rows=d.rows.slice(1);d.queryMeta=meta('q_000000000000000000000001','2026-06-01','2026-06-30',1);d.summary.incomeCount=115;
  const sibling=structuredClone(d);sibling.queryMeta.queryId='q_000000000000000000000003';sibling.queryMeta.filters.text='另一筛选';
  expect(validCountClaims('6月收入115笔。',[d,sibling])).toBe(false);
});
test.each([
  ['6月2日共8笔收益记录。',false],['6月2日笔数8。',false],['6月收益历史共2条记录。',false],
  ['本次匹配2条收益记录。',true],['共2条收益登记记录。',true],['本次展示2条。',true],
  ['本次展示8条。',false],['共8条收益记录。',false],['共8.5条收益记录。',false],['共-2条收益记录。',false],
  ['2026-06-01至2026-06-30共2条收益记录。',true],['2026-05-01至2026-05-31共2条收益记录。',false],
  ['查询范围2026-06-01至2026-06-30，共2条收益记录。',true],['截至2026-06-30共2条记录。',true],
  ['截至2026-06-02共2条记录。',false],['6月全范围共2条收益记录。',true],['5月全范围共2条收益记录。',false],
])('fund record counts cannot come from profit money values: %s',(text,expected)=>expect(validCountClaims(text,[fund()])).toBe(expected));
test('a declared date row count does not establish a direction count',()=>{
  const d=fund();d.columns.push({key:'count',type:'number'});d.rows[0].count=8;
  expect(validCountClaims('6月2日共8笔记录。',[d])).toBe(true);
  expect(validCountClaims('6月2日收入8笔记录。',[d])).toBe(false);
  expect(validCountClaims('6月2日收入笔数8。',[d])).toBe(false);
});
test('card, installment and work saved-state count handling is untouched',()=>{
  const card={datasetId:'card-counts',domain:'card',columns:[{key:'type',type:'text'},{key:'count',type:'number'}],rows:[{type:'credit',count:20}],summary:{count:20},queryMeta:{matchedRowCount:1,returnedRowCount:1}};
  expect(validCountClaims('信用卡20张。',[card])).toBe(true);
  expect(validCountClaims('分期计划共3条，待入账1期。',[{datasetId:'installment-plans',domain:'installment',rows:[],columns:[]}])).toBe(true);
  expect(validCountClaims('目前保存工资规则0条。',[{datasetId:'work-rules',domain:'work',rows:[],columns:[]}])).toBe(true);
});

test('ISO months cite only their own published source-row count, not an all-month total',()=>{
  const d=monthly();d.rows=[{month:'2026-04',count:203},{month:'2026-05',count:252},{month:'2026-06',count:268},{month:'2026-07',count:165},
    {month:'2026-08',count:58},{month:'2026-09',count:15},{month:'2026-10',count:5},{month:'2026-11',count:12}];
  d.summary.count=978;d.queryMeta.effectiveScope={startDate:'2025-11-10',endDate:'2026-11-09'};d.queryMeta.sourceRecordCount=978;d.queryMeta.matchedRowCount=d.queryMeta.returnedRowCount=8;
  for(const row of d.rows)expect(validCountClaims('- '+row.month+'：收入100元 / 支出50元（'+row.count+'笔）',[d])).toBe(true);
  expect(validCountClaims('- 2026-04：收入100元 / 支出50元（252笔）',[d])).toBe(false);
  expect(validCountClaims('- 2026-04：收入100元 / 支出50元（978笔）',[d])).toBe(false);
  const sibling=structuredClone(d);sibling.queryMeta.queryId='q_000000000000000000000004';
  expect(validCountClaims('- 2026-04：收入100元 / 支出50元（203笔）',[d,sibling])).toBe(false);
});
