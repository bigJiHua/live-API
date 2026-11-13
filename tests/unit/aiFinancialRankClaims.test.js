const {compare,financialRankIssues:issues,normalizeFinancialRankClaims:normalize}=require('../../src/modules/ai/service/queryFinancialRankClaims');
const captured=require('../fixtures/aiFinancialRankFixture.json');
const daily=()=>structuredClone(captured.dataset),clone=structuredClone;
const pass=(text,data)=>expect(issues(text,data)).toEqual([]),fail=(text,data)=>expect(issues(text,data).length).toBeGreaterThan(0);
test('exact decimal comparison distinguishes values which Number collapses',()=>{
 expect(compare('9007199254740992.01','9007199254740992.00')).toBe(1);expect(compare('-9007199254740992.01','-9007199254740992.00')).toBe(-1);
 expect(compare('01.1000','1.1')).toBe(0);expect(compare(null,'0')).toBeNull();
});
test('actual paid wrong highest annotation is rejected while its correct date/amount/count line survives',()=>{
 const text='6月18日：收入8.56元，支出1015.19元，13笔，净-1006.63元（全月支出最高的一天）';fail(text,[daily()]);expect(normalize(text,[daily()])).toBe(text.replace('（全月支出最高的一天）',''));
});
test('actual paid wrong second-highest annotation is rejected with correct third-place facts intact',()=>{
 const text='6月08日：收入40.00元，支出711.30元，7笔，净-671.30元（全月支出第二高）';fail(text,[daily()]);expect(normalize(text,[daily()])).toBe(text.replace('（全月支出第二高）',''));
});
test('correct complete highest and second and third pass',()=>{
 for(const text of ['6月2日全月支出最高。','6月18日全月支出第二高。','6月8日全月支出第三高。'])pass(text,[daily()]);
});
test('correct same-day income highest and net maximum are independent fields',()=>{
 pass('6月2日全月收入最高。',[daily()]);pass('6月2日净结余最多。',[daily()]);fail('6月18日全月收入最高。',[daily()]);
});
test('standalone wrong rank sentence is removed',()=>expect(normalize('6月18日全月支出最高。',[daily()])).toBe(''));
test('wrong day cannot borrow the true maximum amount',()=>fail('6月18日支出1093.97元，全月支出最高。',[daily()]));
test('wrong field cannot borrow expense maximum for an income ranking',()=>fail('6月2日收入1093.97元，收入最高。',[daily()]));
test('wrong explicit scope cannot borrow matching daily identity',()=>fail('2026-05-01至2026-05-31，6月2日支出最高。',[daily()]));
test('full-month wording cannot use a partial calendar month',()=>{const d=daily();d.queryMeta.effectiveScope.endDate='2026-06-09';fail('6月2日全月支出最高。',[d]);});
test('duplicate identities from a second approved query remain ambiguous',()=>{const d=daily(),other=clone(d);other.queryMeta.queryId='q_111111111111111111111111';fail('6月2日支出最高。',[d,other]);});
test('explicit exact query scope selects only its matching query',()=>{const d=daily(),other=clone(d);other.queryMeta.queryId='q_111111111111111111111111';other.queryMeta.effectiveScope={startDate:'2026-05-01',endDate:'2026-05-31'};pass('2026-06-01至2026-06-30，6月2日支出最高。',[d,other]);});
test('missing query identity cannot prove ranking',()=>{const d=daily();delete d.queryMeta.queryId;fail('6月2日支出最高。',[d]);});
test('untyped money field cannot prove ranking',()=>{const d=daily();d.columns.find(c=>c.key==='expense').type='text';fail('6月2日支出最高。',[d]);});
test('one row in date window cannot prove the highest',()=>{const d=daily();d.rows=d.rows.filter(r=>r.date==='2026-06-02');d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=1;d.queryMeta.rankingComplete=false;fail('6月2日支出最高。',[d]);});
test('corresponding expenseDesc rankingComplete window proves its own field',()=>{
 const d=daily();d.rows=d.rows.sort((a,b)=>-compare(a.expense,b.expense)).slice(0,2);d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=2;d.queryMeta.sort='expenseDesc';pass('6月2日支出最高。',[d]);pass('6月18日支出第二高。',[d]);
});
test('expense ranking does not prove an income or minimum ranking',()=>{
 const d=daily();d.rows=d.rows.sort((a,b)=>-compare(a.expense,b.expense)).slice(0,2);d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=2;d.queryMeta.sort='expenseDesc';fail('6月2日收入最高。',[d]);fail('6月18日支出最低。',[d]);
});
test('unpriced source prevents a global complete monetary ranking',()=>{const d=daily();d.summary.unpricedCount=1;fail('6月2日支出最高。',[d]);});
test('wrong amount outside a false annotation causes the entire sentence to be removed',()=>expect(normalize('6月18日支出1093.97元（支出最高）',[daily()])).toBe(''));
test('negated unsupported rankings retain honest explanations',()=>pass('不能确认6月18日是否支出最高。',[daily()]));
test('ties retain every valid highest date and require actual tie proof',()=>{
 const d=daily();d.rows[0].expense=d.rows.find(r=>r.date==='2026-06-02').expense;pass('6月2日支出最高。',[d]);pass('6月2日和6月30日支出并列最高。',[d]);fail('6月18日和6月2日支出并列最高。',[d]);
});
test('a claimed tie cannot be proved by a one-row ranked window',()=>{const d=daily();d.rows=d.rows.filter(r=>r.date==='2026-06-02');d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=1;d.queryMeta.sort='expenseDesc';fail('6月2日支出并列最高。',[d]);});
test('exact large values rank without Number money collisions',()=>{const d=daily();d.rows=d.rows.slice(0,2);d.rows[0].expense='9007199254740992.00';d.rows[1].expense='9007199254740992.01';d.queryMeta.returnedRowCount=2;d.queryMeta.matchedRowCount=2;pass('6月29日支出最高。',[d]);fail('6月30日支出最高。',[d]);});
function monthly(){const d=daily();d.datasetId='finance-monthly';d.queryMeta.datasetId=d.datasetId;d.queryMeta.effectiveScope={startDate:'2026-05-01',endDate:'2026-07-31'};d.queryMeta.matchedRowCount=3;d.queryMeta.returnedRowCount=3;d.queryMeta.sort='monthAsc';d.columns=[{key:'month',type:'text'},{key:'income',type:'money'},{key:'expense',type:'money'}];d.rows=[{month:'2026-05',expense:'100.00',income:'10.00'},{month:'2026-06',expense:'200.00',income:'20.00'},{month:'2026-07',expense:'300.00',income:'30.00'}];return d;}
test('complete monthly rankings bind their month and direction',()=>{const d=monthly();pass('2026-07支出最高。',[d]);pass('6月支出第二高。',[d]);fail('2026-05支出最高。',[d]);fail('7月收入300.00元，收入最高。',[d]);});
test('monthly partial chronological rows cannot prove rankingComplete unrelated sort',()=>{const d=monthly();d.rows=d.rows.slice(-1);d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=1;fail('7月支出最高。',[d]);});
function categories(){const d=daily();d.datasetId='finance-categories';d.queryMeta.datasetId=d.datasetId;d.queryMeta.matchedRowCount=3;d.queryMeta.returnedRowCount=3;d.queryMeta.sort='categoryAmountDesc';d.columns=[{key:'category',type:'text'},{key:'direction',type:'number'},{key:'amountCNY',type:'money'}];d.rows=[{category:'收入A',direction:1,amountCNY:'500.00'},{category:'餐饮',direction:0,amountCNY:'300.00'},{category:'交通',direction:0,amountCNY:'100.00'}];return d;}
test('complete category ranking compares only same direction',()=>{const d=categories();pass('餐饮支出最高。',[d]);pass('交通支出第二高。',[d]);fail('交通支出最高。',[d]);fail('餐饮收入最高。',[d]);});
test('amount-sorted category partial rank retains direction-bound maximum',()=>{const d=categories();d.rows=d.rows.slice(0,2);d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=2;pass('餐饮支出最高。',[d]);fail('餐饮支出最低。',[d]);});
test('other dataset count or expiry text is outside financial rank guard',()=>pass('所有卡片的有效期最早为2030-07。',[{datasetId:'card-cards',rows:[]} ]));
test('net expense ranking is not misinterpreted as gross expense ranking',()=>{
 const d=monthly();const sentence='2026-07为净支出最高月。';pass(sentence,[d]);expect(normalize(sentence,[d])).toBe(sentence);
});
