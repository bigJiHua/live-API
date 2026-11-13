const { dailyConditionIssues: issues, normalizeDailyConditionClaims: normalize, stripProvenDailyConditionCountTokens: strip } = require('../../src/modules/ai/service/queryDailyConditionClaims');
const capture = require('../fixtures/aiDailyConditionFixture.json');
const source = () => structuredClone(capture.dataset);
const pass = (text, data = [source()]) => expect(issues(text,data)).toEqual([]);
const fail = (text, data = [source()]) => expect(issues(text,data).length).toBeGreaterThan(0);
const positive = () => source().rows.filter(row => !row.net.startsWith('-') && Number(row.net) > 0);
const dates = rows => rows.map(row => row.date + '（' + row.net + '）').join('、');
test('actual paid false four-day net-positive claim is detected independently of the shared number pool', () => {
  const line = capture.actualAnswer.split('\n').find(line => line.includes('仅有4天净收支为正'));
  expect(require('../../src/modules/ai/service/queryCountClaims').validCountClaims(line,[source()])).toBe(true);
  fail(line); expect(normalize(capture.actualAnswer,[source()])).not.toContain('仅有4天净收支为正');
  expect(normalize(capture.actualAnswer,[source()])).toContain('为全月最大单日净流出');
});
test.each(['全月有7天净收支为正。','共有23天净收支为负。','有0天净收支为零。','有0天净收支未知。',
  '全月有七天净收支为正。','净收支为正的天数为7天。','收入大于支出的日期数为7。','有23天收入小于支出。','有0天收入等于支出。'])('correct field-specific positive/negative/zero counts survive: %s', text => pass(text));
test('a complete correct closed date list survives in either order with exact same-date net cells', () => {
  pass('全月共有7天净收支为正：' + dates(positive()) + '。');
  pass('全月共有7天净收支为正：' + dates(positive().reverse()) + '。');
});
test('a correct day count cannot justify an incomplete closed date list', () => fail('共有7天净收支为正：' + dates(positive().slice(0,5)) + '。'));
test('a complete closed date list cannot include an omitted or wrong date', () => fail('共有7天净收支为正：' + dates(positive()).replace('2026-06-24','2026-06-30') + '。'));
test('a date cannot borrow the net value from another positive date', () => fail('共有7天净收支为正：' + dates(positive()).replace('2026-06-24（9.12）','2026-06-24（378.09）') + '。'));
test('a labelled date value cannot borrow another date value', () => fail('共有7天净收支为正：' + positive().map(row => row.date + '净收支' + (row.date === '2026-06-24' ? '378.09' : row.net) + '元').join('、') + '。'));
test('duplicated date identities cannot masquerade as a complete date list', () => { const rows=positive(); rows[0]=rows[1]; fail('共有7天净收支为正：'+dates(rows)+'。'); });
test('explicit examples may be partial while every example still needs a matching positive date', () => pass('共有7天净收支为正：例如'+dates(positive().slice(0,2))+'。'));
test('explicit examples cannot include a negative date', () => fail('共有7天净收支为正：例如2026-06-30（-24.28）。'));
test('ASCII and Chinese complete scope descriptions select the same query', () => {
  pass('2026-06-01至2026-06-30，有7天净收支为正。');
  pass('2026年6月1日至30日，有7天净收支为正。');
});
test.each([
  '有4天净收支为正。','有7天净收支为负。','有7天净收支为零。','有7天净收支未知。',
  '2026-05-01至2026-05-31，有7天净收支为正。','2026年5月1日至31日，有7天净收支为正。',
  '2026-05有7天净收支为正。','5月有7天净收支为正。','有-7天净收支为正。','有7e2天净收支为正。','有7%天净收支为正。',
])('incorrect count, condition or stated scope is not supported: %s', text => fail(text));
test.each([
  ['missing query identity', d=>{delete d.queryMeta.queryId;}],
  ['wrong provenance dataset', d=>{d.queryMeta.datasetId='finance-monthly';}],
  ['untyped net field', d=>{d.columns.find(c=>c.key==='net').type='text';}],
  ['untyped date field', d=>{d.columns.find(c=>c.key==='date').type='text';}],
  ['no typed pricing evidence', d=>{d.columns=d.columns.filter(c=>c.key!=='unpricedCount');}],
  ['partial detail window', d=>{d.rows=d.rows.slice(0,7);d.queryMeta.rowsComplete=false;d.queryMeta.returnedRowCount=7;d.truncated=true;}],
  ['contradictory truncation flag', d=>{d.truncated=true;}],
  ['published row count mismatch', d=>{d.queryMeta.returnedRowCount=29;}],
  ['source-count mismatch', d=>{d.queryMeta.sourceRecordCount=267;}],
  ['expense-only direction cannot prove unfiltered net income days', d=>{d.queryMeta.filters.direction='expense';}],
  ['unmentioned literal text filter', d=>{d.queryMeta.filters.text='餐饮';}],
  ['duplicate daily row date', d=>{d.rows[0].date=d.rows[1].date;}],
])('only matching complete typed query evidence can prove whole-range day counts: %s', (_, change) => { const d=source();change(d);fail('全月有7天净收支为正。',[d]); });
test('two complete queries with equal numerical values remain ambiguous', () => { const d=source(), other=source();other.queryMeta.queryId='q_'+'f'.repeat(24);fail('全月有7天净收支为正。',[d,other]); });
test('a complete source cannot conceal an equally scoped partial sibling', () => {const d=source(),other=source();other.queryMeta.queryId='q_'+'f'.repeat(24);other.queryMeta.rowsComplete=false;fail('全月有7天净收支为正。',[d,other]);});
test('null and unpriced net days stay unknown, not zero or positive', () => {
  const d=source();d.rows.find(row=>row.date==='2026-06-24').net=null;d.rows.find(row=>row.date==='2026-06-16').unpricedCount=1;
  pass('有5天净收支为正。',[d]);pass('有2天净收支未知。',[d]);pass('有0天净收支为零。',[d]);fail('有7天净收支为正。',[d]);
});
test('a malformed decimal is unknown rather than a matching numeric prefix', () => {const d=source();d.rows.find(row=>row.date==='2026-06-24').net='9.12e2';pass('有6天净收支为正。',[d]);pass('有1天净收支未知。',[d]);});
test('negative zero is classified separately from a negative day', () => {const d=source();d.rows.find(row=>row.date==='2026-06-24').net='-0.0000';pass('有6天净收支为正。',[d]);pass('有1天净收支为零。',[d]);pass('有23天净收支为负。',[d]);});
test('BigInt comparison distinguishes income and expense which binary Number collapses', () => {
  const d=source();d.rows=d.rows.slice(0,2);Object.assign(d.queryMeta,{matchedRowCount:2,returnedRowCount:2});
  Object.assign(d.rows[0],{income:'9007199254740992.01',expense:'9007199254740992.00',net:'0.01'});
  Object.assign(d.rows[1],{income:'9007199254740992.00',expense:'9007199254740992.01',net:'-0.01'});
  pass('有1天收入大于支出。',[d]);pass('有1天收入小于支出。',[d]);fail('有2天收入等于支出。',[d]);
});
test('a partial month cannot be described as a complete calendar month', () => {const d=source();d.queryMeta.effectiveScope.endDate='2026-06-09';d.rows=d.rows.filter(row=>row.date<='2026-06-09');Object.assign(d.queryMeta,{matchedRowCount:d.rows.length,returnedRowCount:d.rows.length});fail('全月有7天净收支为正。',[d]);});
test('an honest uncertainty statement or question is preserved without pretending to prove a count', () => {pass('无法确认有4天净收支为正。');pass('有4天净收支为正？');});
test('independent correct day facts and correct financial rank sentences survive a false aggregate sentence', () => {
  const text='2026-06-24：净收支9.12元。\n6月2日净结余最多。\n仅有4天净收支为正：'+dates(positive().slice(0,5))+'。';
  expect(normalize(text,[source()])).toBe('2026-06-24：净收支9.12元。\n6月2日净结余最多。\n');
});
test('only an independently proved conditional count is removed from the ordinary numeric pool check', () => {
  expect(strip('共有23天净收支为负，另有23元。',[source()])).toBe('共有  天净收支为负，另有23元。');
  expect(strip('共有4天净收支为正，另有4元。',[source()])).toBe('共有4天净收支为正，另有4元。');
});
test('an unsupported closed date list cannot get its count token masked as proved', () => {
  const text='共有7天净收支为正：'+dates(positive().slice(0,5))+'。';expect(strip(text,[source()])).toBe(text);
});
test.each(['5月和6月有7天净收支为正。','5月有7天净收支为正，6月有7天净收支为正。'])('all stated months must belong to the same proven scope: %s', text => fail(text));
test.each(['净收支为正的日期共有4天。','净收支为正共有4天。'])('condition-first natural count wording cannot bypass proof: %s', text => fail(text));
test('zero and unknown calendar counts cannot infer values from dates absent from the registered GROUP BY rows', () => {
  const d=source();d.rows=d.rows.filter(row=>row.date==='2026-06-02');Object.assign(d.queryMeta,{matchedRowCount:1,returnedRowCount:1});
  fail('全月有0天净收支为零。',[d]);fail('全月有0天净收支未知。',[d]);pass('全月有1天净收支为正。',[d]);
});
test('explicit registered-date zero and unknown counts do not fill missing calendar dates', () => {
  const d=source();d.rows=d.rows.filter(row=>row.date==='2026-06-02');Object.assign(d.queryMeta,{matchedRowCount:1,returnedRowCount:1});
  pass('有记录的日期中有0天净收支为零。',[d]);pass('有记录的日期中有0天净收支未知。',[d]);
});
