const {sourceCurrencyIssues:issues,normalizeSourceCurrencyClaims:normalize}=require('../../src/modules/ai/service/querySourceCurrencyClaims');
const capture=require('./fixtures/aiSourceCurrencyCapturedCase.json');
const source=()=>structuredClone(capture.dataset),pass=(text,data=[source()])=>expect(issues(text,data)).toEqual([]),fail=(text,data=[source()])=>expect(issues(text,data).length).toBeGreaterThan(0);
function complete(){const d=source();d.rows=Array.from({length:3},(_,index)=>({...d.rows[0],date:'2026-06-'+String(18+index).padStart(2,'0')}));
 Object.assign(d.queryMeta,{matchedRowCount:3,returnedRowCount:3,sourceRecordCount:3,rowsComplete:true,rankingComplete:true});d.summary.count=d.summary.expenseCount=3;d.truncated=false;return d;}
function cards(){const d=source();d.datasetId='card-monthlyConsumption';d.domain='card';d.title='按卡区间消费统计（人民币）';
 d.columns=[{key:'name',type:'text'},{key:'currency',type:'text'},{key:'sourceCurrencies',type:'text'},{key:'count',type:'number'},{key:'amountCNY',type:'money'}];
 d.rows=[{name:'甲卡',currency:'CNY',sourceCurrencies:'USD',count:3,amountCNY:'100.00'},{name:'乙卡',currency:'CNY',sourceCurrencies:'CNY',count:4,amountCNY:'200.00'}];
 Object.assign(d.queryMeta,{datasetId:d.datasetId,groupBy:'card',matchedRowCount:2,returnedRowCount:2,sourceRecordCount:7,rowsComplete:true});d.truncated=false;return d;}
test('actual paid whole-source original-CNY and unmixed claim is not proved by the returned one-row window',()=>{
 fail(capture.issue.unsupportedQuote);expect(normalize(capture.actualAnswer,[source()])).not.toContain('原币 CNY，未混币');
 expect(normalize(capture.actualAnswer,[source()])).toContain('支出最大的一笔发生在 2026-06-18');
});
test('a single returned row on a date does not prove every unreturned source record on that date',()=>{
 fail('2026-06-18的支出原币均为CNY。');pass('2026-06-18这笔支出原币为CNY。');
});
test.each(['本次返回1笔，但153笔支出原币均为CNY，未混币。','153笔支出原币CNY，未混币，仅返回1笔。'])('a larger source count cannot borrow displayed-row locality: %s',text=>fail(text));
test.each(['这笔交易原币为CNY，未混币。','本次返回1笔，原币均为CNY，未混币。','本次展示的所有记录原币为CNY。',
 '本次返回的1条记录为单一币种CNY。','上述记录原币为人民币。'])('explicit displayed-row original currency belongs to its own approved window: %s',text=>pass(text));
test.each(['这笔交易原币为USD。','这笔交易原币为XYZ。','本次返回1笔，单一币种USD。'])('a wrong currency cannot borrow converted CNY or uniformity: %s',text=>fail(text));
test.each(['未混币。','原币均为CNY。','单一币种CNY。','该范围153笔支出原币CNY。','全部支出记录原币CNY。',
 '本次返回1笔，但所有支出原币CNY。'])('whole-scope currency claims need full original coverage even without an all-rows quantifier: %s',text=>fail(text));
test('converted amount and an honest denial retain ordinary prose',()=>{pass('该范围支出折算金额为CNY 5784.61。');pass('无法确认该范围未混币。');pass('是否未混币？');});
test('complete original transaction rows prove their own single currency and reject a different currency',()=>{const d=complete();pass('该范围全部支出记录原币CNY，未混币。',[d]);fail('该范围全部支出记录原币USD。',[d]);});
test('complete mixed original currencies cannot be called a single original currency',()=>{const d=complete();d.rows[1].currency='USD';fail('该范围全部支出未混币。',[d]);fail('全部支出原币CNY。',[d]);pass('全部支出原币为CNY和USD。',[d]);});
test('unknown original currency is not a uniform known original currency',()=>{const d=complete();d.rows[1].currency=null;fail('全部支出原币CNY，未混币。',[d]);});
test.each([
 ['wrong source scope ISO','2026-05-01至2026-05-31全部支出原币CNY。'],
 ['wrong source scope Chinese','2026年5月1日至31日全部支出原币CNY。'],
 ['wrong stated month','5月全部支出原币CNY。'],
 ['mixed stated month','5月和6月全部支出原币CNY。'],
])('complete evidence must belong to the claimed scope: %s',(_,text)=>fail(text,[complete()]));
test.each([
 ['missing query identity',d=>{delete d.queryMeta.queryId;}],
 ['missing original currency type',d=>{d.columns.find(c=>c.key==='currency').type='money';}],
 ['source count mismatch',d=>{d.queryMeta.sourceRecordCount=153;}],
 ['contradictory partial metadata',d=>{d.queryMeta.rowsComplete=false;}],
 ['missing published row',d=>{d.queryMeta.returnedRowCount=4;}],
 ['unmentioned source text filter',d=>{d.queryMeta.filters.text='餐饮';}],
])('original provenance and complete coverage cannot be replaced by a summary label: %s',(_,change)=>{const d=complete();change(d);fail('该范围全部支出原币CNY，未混币。',[d]);});
test('CNY-converted monthly summary and grouped rows do not publish original-currency evidence',()=>{
 const d=complete();d.datasetId=d.queryMeta.datasetId='finance-monthly';d.columns=[{key:'month',type:'date'},{key:'income',type:'money'},{key:'expense',type:'money'}];
 d.rows=[{month:'2026-06',income:'3911.24',expense:'5784.61'}];Object.assign(d.queryMeta,{matchedRowCount:1,returnedRowCount:1,sourceRecordCount:268});
 fail('全月原币CNY，未混币。',[d]);pass('全月支出折算金额为CNY 5784.61。',[d]);
});
test('equal currency values from another query cannot choose the intended source',()=>{const d=complete(),other=complete();other.queryMeta.queryId='q_'+'f'.repeat(24);fail('该范围支出原币CNY，未混币。',[d,other]);});
test('original-currency projection is row-complete for a named grouped card even with other cards omitted',()=>{
 const d=cards();d.rows=d.rows.slice(0,1);d.queryMeta.returnedRowCount=1;d.queryMeta.rowsComplete=false;d.truncated=true;
 pass('甲卡原币为USD，未混币。',[d]);fail('甲卡原币为CNY。',[d]);fail('该范围全部消费原币USD，未混币。',[d]);
});
test('all complete grouped original-currency sets prove mixed originals instead of their CNY statistic currency',()=>{const d=cards();pass('该范围消费原币为CNY和USD。',[d]);fail('该范围消费原币CNY，未混币。',[d]);});
test('a card sourceCurrencies unknown value blocks complete original-currency uniformity',()=>{const d=cards();d.rows[0].sourceCurrencies='unknown';fail('该范围消费未混币。',[d]);});
test('sourceCurrencies is unavailable without its actual published text column, grouping and count provenance',()=>{
 for(const change of [d=>{d.columns=d.columns.filter(c=>c.key!=='sourceCurrencies');},d=>{delete d.queryMeta.groupBy;},d=>{d.rows[0].count='3';}]){const d=cards();change(d);fail('甲卡原币USD，未混币。',[d]);}
});
test('partial card-month rows cannot prove a named card currency over unreturned months',()=>{
 const d=cards();d.queryMeta.groupBy='cardMonth';d.queryMeta.effectiveScope={startDate:'2026-08-01',endDate:'2026-11-08'};
 d.rows=d.rows.slice(0,1);d.queryMeta.returnedRowCount=1;d.queryMeta.rowsComplete=false;d.truncated=true;
 fail('甲卡原币USD，未混币。',[d]);pass('本次展示的甲卡原币USD，未混币。',[d]);
});
test('complete card-month evidence combines the named card original currencies across its months',()=>{
 const d=cards();d.queryMeta.groupBy='cardMonth';d.rows.push({...d.rows[0],sourceCurrencies:'EUR',count:2});
 Object.assign(d.queryMeta,{matchedRowCount:3,returnedRowCount:3,sourceRecordCount:9});
 pass('甲卡原币为USD和EUR。',[d]);fail('甲卡原币USD，未混币。',[d]);
});
test('a financial aggregate cannot borrow a same-scope transaction currency unless the single transaction is named',()=>{
 const d=source(),monthly=complete();monthly.datasetId=monthly.queryMeta.datasetId='finance-monthly';monthly.title='收支月度趋势';monthly.columns=[];
 fail('该范围原币CNY，未混币。',[d,monthly]);pass('这笔交易原币CNY，未混币。',[d,monthly]);
});
