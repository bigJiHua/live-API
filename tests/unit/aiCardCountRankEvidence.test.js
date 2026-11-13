jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Public DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Public DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {validWindowClaims}=require('../../src/modules/ai/service/queryWindowClaims');
const {clearEmptyQueryTables}=require('../../src/modules/ai/service/queryEmptyTableProse');
const {buildQueryAnswer}=require('../../src/modules/ai/service/v3Service');
const captured=require('../fixtures/aiCardCountRankCaptured.json'),clone=x=>structuredClone(x),partial=()=>clone(captured.current.result.datasets[0]),complete=()=>clone(captured.history.result.datasets[0]);
const {cardCountsPartialRowsTable}=require('../../src/modules/ai/service/queryCountRankClaims');
test.each([
 ['展示的这一条（按类型数量降序首位）：',false],['当前展示的这一条是按类型数量降序首位。',false],
 ['类型按数量降序排列。',false],['数量排名第一类如下：',false],['首位类型是信用卡。',false],
 ['信用卡数量最多。',false],['信用卡最多。',false],['信用卡数量最少。',false],
 ['The displayed type has the highest card count.',false],['Types are in descending count order.',false],
 ['第一类是信用卡。',false],['信用卡位居第一。',false],
 ['当前展示第一条记录：信用卡，20张，占比24.7%。',true],['只展示第一行，数量20。',true],
 ['本次展示1条，匹配4行，来源81张卡片。',true],['不能确认数量最多的卡类型。',true],
 ['无法确定按数量降序的首位。',true],['Cannot determine the highest card count.',true],
 // The existing universal-window guard already rejects trailing uncertainty;
 // this candidate deliberately preserves that conservative behavior.
 ['数量最高的类型无法确定。',false],
])('partial quantity projection cannot establish rank and keeps ordinary facts: %s',(text,expected)=>expect(validWindowClaims(text,[partial()])).toBe(expected));
test.each([
 ['借记卡数量最多。',true],['借记卡最多。',true],['信用卡数量最多。',false],['信用卡最多。',false],
 ['虚拟余额数量最少。',true],['现金数量最低。',true],['现金数量最高。',false],
 ['按类型数量降序排列。',false],['按类型数量升序排列。',false],
 ['信用卡和借记卡按数量降序排列。',false],['信用卡、借记卡按类型数量降序排列。',false],
 ['本次返回信用卡和借记卡按数量降序排列。',false],
 ['借记卡数量最多，唯一首位。',true],['现金数量最少，唯一首位。',false],
])('complete current quantity rows prove labelled extrema without changing returned order: %s',(text,expected)=>expect(validWindowClaims(text,[complete()])).toBe(expected));
test('a fully returned descending projection establishes its order caption',()=>{
 const d=complete();d.rows.sort((a,b)=>b.count-a.count);expect(validWindowClaims('按类型数量降序排列，首位如下：',[d])).toBe(true);
});
test('a fully returned ascending projection establishes its order caption',()=>{
 const d=complete();d.rows.sort((a,b)=>a.count-b.count);expect(validWindowClaims('按类型数量升序排列。',[d])).toBe(true);
});
test.each([
 ['missing query id',d=>{delete d.queryMeta.queryId;}],['cross-dataset metadata',d=>{d.queryMeta.datasetId='card-cards';}],
 ['wrong returned count',d=>{d.queryMeta.returnedRowCount=3;}],['wrong matching count',d=>{d.queryMeta.matchedRowCount=3;}],
 ['unknown matching count',d=>{d.queryMeta.matchedRowCount=null;}],['missing count column',d=>{d.columns=d.columns.filter(c=>c.key!=='count');}],
 ['missing coverage',d=>{delete d.queryMeta;}],['invalid date',d=>{d.queryMeta.effectiveScope.endDate='2026-02-30';}],
 ['negative count',d=>{d.rows[0].count=-1;}],['unpublished truncated flag',d=>{d.truncated=true;}],
])('quantity proof rejects invalid current-source coverage: %s',(_,mutate)=>{const d=complete();mutate(d);expect(validWindowClaims('借记卡数量最多。',[d])).toBe(false);});
test('an unrelated full query cannot supply ranking to the current partial query',()=>expect(validWindowClaims('按类型数量降序首位。',[partial(),complete()])).toBe(false));
test('a count-rank token inside a published identity remains text data',()=>{
 const d=partial();d.rows[0].type='数量最多的示例类型';expect(validWindowClaims('本次展示第一行：数量最多的示例类型，20张。',[d])).toBe(true);
});
test('a different dataset keeps its original amount-ranking guard',()=>{
 const d={datasetId:'finance-transactions',domain:'finance',title:'收支明细',columns:[{key:'amountCNY',type:'money'}],rows:[{amountCNY:'20'}],truncated:true,
  queryMeta:{rowsComplete:false,rankingComplete:false,sort:'dateDesc'}};
 expect(validWindowClaims('支出最高的一笔为20元。',[d])).toBe(false);
});
test.each([
 ['| 类型 | 数量 |\n| --- | --- |',''],
 ['展示的这一条：\n\n| 类型 | 数量 |\n| --- | --- |',''],
 ['类型如下：\n| 类型 | 数量 |\n| --- | --- |\n\n说明：匹配4行。','说明：匹配4行。'],
 ['| Type | Count |\n| :--- | ---: |\n\nCurrent result has one shown row.','Current result has one shown row.'],
])('empty Markdown tables and attached presentation captions disappear: %s',(input,output)=>expect(clearEmptyQueryTables(input)).toBe(output));
test.each([
 '| 类型 | 数量 |\n| --- | --- |\n| 信用卡 | 20 |',
 '| 类型 | 数量 | 占比 |\n| --- | --- | --- |\n| 信用卡 | 20 | 24.7% |',
 '说明 | 数量的文字没有表格分隔线。',
 '```markdown\n| 类型 | 数量 |\n| --- | --- |\n```',
 '~~~markdown\n| 类型 | 数量 |\n| --- | --- |\n~~~',
])('correct table, ordinary text and fenced sample remain exact: %s',input=>expect(clearEmptyQueryTables(input)).toBe(input));
test('actual answer builder keeps the valid shown-row table and its numbers',()=>{
 const d=partial(),before=JSON.stringify(d),text='本次展示第一条记录：\n| 类型 | 数量 | 占比 |\n| --- | --- | --- |\n| 信用卡 | 20 | 24.7% |',answer=buildQueryAnswer(text,[d]);
 expect(answer).toContain('| 信用卡 | 20 | 24.7% |');expect(answer).toContain('本次展示第一条记录');expect(JSON.stringify(d)).toBe(before);
});
test('actual answer builder removes the captured residual rank and empty table without changing data',()=>{
 const d=partial(),before=JSON.stringify(d),answer=buildQueryAnswer(JSON.parse(captured.current.providers.at(-1).content).answer,[d]);
 expect(answer).not.toMatch(/降序|首位|\| 借记卡 \|/);expect(answer).toContain('| 信用卡 | 20 | 24.7 |');expect(answer).toContain('本次展示：1 条');expect(JSON.stringify(d)).toBe(before);
});
test.each([
 ['wrong dataset',d=>{d.datasetId='asset-composition';}],['wrong query identity',d=>{d.queryMeta.datasetId='card-cards';}],
 ['missing query identity',d=>{delete d.queryMeta.queryId;}],['wrong returned rows',d=>{d.queryMeta.returnedRowCount=2;}],
 ['nontruncated rows',d=>{d.truncated=false;}],['missing percentage column',d=>{d.columns=d.columns.filter(c=>c.key!=='sharePct');}],
 ['unknown percentage',d=>{d.rows[0].sharePct=null;}],['negative percentage',d=>{d.rows[0].sharePct='-1.0';}],
 ['impossible percentage',d=>{d.rows[0].sharePct='100.1';}],['missing count',d=>{d.rows[0].count=null;}],
])('server partial table needs published current row evidence: %s',(_,mutate)=>{const d=partial();mutate(d);expect(cardCountsPartialRowsTable(d)).toBe('');});
test('server partial table emits only one current row, no hidden type or full total',()=>{
 const d=partial(),before=JSON.stringify(d),table=cardCountsPartialRowsTable(d);expect(table).toContain('| 信用卡 | 20 | 24.7 |');
 expect(table).not.toMatch(/借记卡|59|72\.8|总计|81/);expect(JSON.stringify(d)).toBe(before);
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});

test.each([
 ['支付宝数量最多。',false],['首位类型是支付宝。',false],['未登记类型数量最多。',false],
 ['Alipay has the highest card count.',false],
 ['借记卡数量最多，支付宝数量最多。',false],['支付宝数量最多，借记卡数量最多。',false],
 ['支付宝与借记卡数量最多。',false],['借记卡59张，未登记类型数量最多。',false],
 ['不能确认支付宝数量最多。',true],['无法确定支付宝是否数量最多。',true],
 ['支付宝卡片未在本次类型记录中出现。',true],
 ['借记卡数量最多。',true],['虚拟余额数量最少。',true],['借记卡数量最多，唯一首位。',true],
])('positive quantity rank binds each named clause to a current type row: %s',(text,expected)=>{
 const d=complete(),before=JSON.stringify(d);expect(validWindowClaims(text,[d])).toBe(expected);
 expect(JSON.stringify(d)).toBe(before);
});

test.each([
 ['按类型数量降序排列，首位如下：',false,true],
 ['按类型数量升序排列，首位如下：',true,true],
 ['按类型数量降序排列，支付宝数量最多。',false,false],
 ['按类型数量降序排列，首位类型是支付宝。',false,false],
])('verified returned-order caption never sponsors an unreturned named type: %s',(text,ascending,expected)=>{
 const d=complete();d.rows.sort((a,b)=>ascending?a.count-b.count:b.count-a.count);
 const before=JSON.stringify(d);expect(validWindowClaims(text,[d])).toBe(expected);expect(JSON.stringify(d)).toBe(before);
});

test.each([
 '支付宝数量最多。','首位类型是支付宝。','未登记类型数量最多。',
 '借记卡数量最多，支付宝数量最多。','借记卡59张，未登记类型数量最多。',
])('actual answer builder discards unsupported named quantity rank and keeps the proven rows: %s',text=>{
 const d=complete(),before=JSON.stringify(d),answer=buildQueryAnswer(text,[d]);
 expect(answer).not.toMatch(/支付宝|未登记类型/);expect(answer).toContain('| 借记卡 | 59 |');
 expect(answer).toContain('| 信用卡 | 20 |');expect(JSON.stringify(d)).toBe(before);
});

test.each([
 ['借记卡数量最多59张，信用卡20张。',true],
 ['信用卡20张，借记卡数量最多59张。',true],
 ['借记卡数量最多，信用卡数量20张。',true],
 ['虚拟余额数量最少1张，借记卡59张。',true],
 ['借记卡数量最多59张，现金数量最少1张。',true],
 ['现金数量最少1张，借记卡数量最多59张。',true],
 ['借记卡数量最多，唯一首位，信用卡20张。',true],
 ['借记卡和信用卡数量最多。',false],
 ['借记卡数量最多，信用卡数量最多。',false],
 ['借记卡数量最多，支付宝数量最多。',false],
 ['借记卡59张，支付宝数量最多。',false],
 ['现金数量最少，唯一首位，借记卡59张。',false],
 ['现金是唯一数量最少的类型，借记卡59张。',false],
 ['信用卡数量最多20张，现金数量最少1张。',false],
 ['借记卡数量最多，唯一首位，现金数量最少1张。',true],
 ['现金数量最少1张，借记卡数量最多59张，唯一首位。',true],
 ['借记卡数量最多59张，现金是唯一数量最少的类型1张。',false],
 ['不能确认支付宝数量最多。',true],
])('quantity extremum subjects belong to their own ranked clause: %s',(text,expected)=>{
 const d=complete(),before=JSON.stringify(d);expect(validWindowClaims(text,[d])).toBe(expected);
 expect(JSON.stringify(d)).toBe(before);
});

test.each([
 '借记卡数量最多59张，信用卡20张。',
 '信用卡20张，借记卡数量最多59张。',
 '借记卡数量最多59张，现金数量最少1张。',
 '现金数量最少1张，借记卡数量最多59张，唯一首位。',
])('actual answer keeps a proved count extremum beside other row facts: %s',text=>{
 const d=complete(),before=JSON.stringify(d),answer=buildQueryAnswer(text,[d]);
 expect(answer).toContain(text);expect(answer).toContain('| 借记卡 | 59 |');
 expect(answer).toContain('| 信用卡 | 20 |');expect(JSON.stringify(d)).toBe(before);
});
