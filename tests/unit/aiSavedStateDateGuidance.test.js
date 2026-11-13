const { correctSavedStateDateGuidance, readableQueryProse } = require('../../src/modules/ai/service/queryCoverageProse');
const titles = { 'work-rules': '工资规则参考', 'work-salary': '已登记每日工资',
  'fund-holdings': '基金登记汇总', 'fund-history': '基金日收益登记历史',
  'card-repayments': '信用卡还款历史', 'account-balances': '账户余额快照',
  'card-cards': '本人卡片清单', 'card-pools': '共享额度池配置', 'fixedAsset-saved': '固定资产账面快照' };
const dataset = id => ({ datasetId: id, title: titles[id] || id, rows: [], columns: [],
  queryMeta: { effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' }, rowsComplete: true, matchedRowCount: 0, returnedRowCount: 0 } });
const mixedWork = () => [dataset('work-rules'), dataset('work-salary')];

test('a rule outside-window story is removed while the dated salary explanation survives', () => {
  const truePart = '工资规则参考读取目前保存状态；每日工资按日期查询，该范围内没有工资记录。';
  const badPart = '如果规则此前已登记，可能保存在此范围之外，需要时可以告诉我大致入职时间，我再按对应日期查询。';
  const answer = correctSavedStateDateGuidance(truePart + badPart, mixedWork());
  expect(answer).toContain(truePart);
  expect(answer).not.toMatch(/如果规则|此范围之外|大致入职时间|按对应日期查询/);
  expect(answer).toContain('工资规则参考读取目前已保存状态，不按查询起止日期筛选；仅扩大日期范围不会增加匹配记录。');
});

test.each([
  ['work-rules', '工资规则可能保存在范围外，可扩大日期范围再查询。'],
  ['work-rules', '工资规则可能在其他月份，建议扩大日期查询。'],
  ['work-rules', '工资规则可以按入职日期查询更多记录。'],
  ['work-rules', '工资规则参考可更换日期范围继续查找。'],
  ['account-balances', '账户余额可能保存在范围外，可扩大日期范围再查。'],
  ['card-cards', '卡片清单可以扩大时间范围查别的记录。'],
  ['card-pools', '共享池配置可能落在此区间之外，可扩大日期查找。'],
  ['fixedAsset-saved', '固定资产可按其他月份查询历史记录。'],
  ['fund-holdings', '基金持仓可以扩展日期范围查询记录。'],
  ['work-rules', 'salary rules may be stored outside this date range.'],
  ['work-rules', 'salary rules can expand date range to find records.'],
])('only a known saved-state subject gets a date-search correction: %s %s', (id, text) => {
  const result = correctSavedStateDateGuidance(text, [dataset(id)]);
  expect(result).not.toContain(text);
  expect(result).toContain(`${titles[id]}读取目前已保存状态`);
  expect(result).toContain('仅扩大日期范围不会增加匹配记录');
});

test.each([
  ['work-salary', '每日工资可以按其他月份查询历史记录。'],
  ['work-salary', '工资历史可能在范围外，可扩大日期范围再查询。'],
  ['fund-history', '基金收益历史可能在范围外，可扩大日期范围再查询。'],
  ['fund-history', '收益历史可按其他月份查询。'],
  ['card-repayments', '还款历史可以扩大日期范围找记录。'],
  ['card-repayments', '还款记录可以按对应日期查询。'],
])('date-range datasets keep valid historical search advice: %s %s', (id, text) => {
  expect(correctSavedStateDateGuidance(text, [dataset('work-rules'), dataset(id)])).toBe(text);
});

test.each([
  '工资规则不按日期筛选，扩大日期不会增加匹配记录。',
  '工资规则不能靠扩大日期查询记录。',
  '工资规则记录不可能在范围外。',
  '工资规则在其他月份登记过，当前仍应按保存状态读取。',
  '工资规则可按名称关键词搜索，名称含其他月份不代表起止日期筛选。',
  '工资规则可根据入职日期核对任职资格。',
  '工资规则参考 currently cannot expand date range to find more records.',
])('true limitations and actual keyword/eligibility operations survive: %s', text => {
  expect(correctSavedStateDateGuidance(text, mixedWork())).toBe(text);
});

test('mixed comma clauses keep useful dated advice and remove the saved-state misconception', () => {
  const text = '工资规则可能保存在范围外，每日工资可以按其他月份查询。';
  const result = correctSavedStateDateGuidance(text, mixedWork());
  expect(result).not.toContain('工资规则可能保存在范围外');
  expect(result).toContain('每日工资可以按其他月份查询。');
});

test('a true saved-state fact is retained before bad advice in a mixed query', () => {
  const text = '工资规则当前已保存两条，可能保存在范围外，每日工资可按其他月份查询。';
  const result = correctSavedStateDateGuidance(text, mixedWork());
  expect(result).toContain('工资规则当前已保存两条');
  expect(result).not.toContain('可能保存在范围外');
  expect(result).toContain('每日工资可按其他月份查询。');
});

test('the order of mixed saved and dated clauses does not remove history advice', () => {
  const text = '每日工资可以按其他月份查询，工资规则可以扩大日期范围找记录。';
  const result = correctSavedStateDateGuidance(text, mixedWork());
  expect(result).toContain('每日工资可以按其他月份查询');
  expect(result).not.toContain('工资规则可以扩大日期范围找记录');
});

test.each([
  [[dataset('fund-holdings'), dataset('fund-history')], '基金持仓参考当前保存状态，基金收益历史可扩大日期范围查询。'],
  [[dataset('card-pools'), dataset('card-repayments')], '共享池配置不按日期筛选，还款历史可按其他月份查询。'],
])('saved siblings do not block a clearly named dated query', (datasets, text) => {
  expect(correctSavedStateDateGuidance(text, datasets)).toBe(text);
});

test('an unbound or ambiguous recommendation is not globally deleted', () => {
  const text = '可以按其他月份查询记录。';
  expect(correctSavedStateDateGuidance(text, mixedWork())).toBe(text);
  const ambiguous = '工资规则和每日工资可以扩大日期范围查询。';
  expect(correctSavedStateDateGuidance(ambiguous, mixedWork())).toBe(ambiguous);
});

test('unknown dataset semantics cannot manufacture a saved-state correction', () => {
  const rows = { datasetId: 'unknown-rules', title: '工资规则参考', rows: [] };
  const text = '工资规则参考可能保存在范围外，可扩大日期范围再查询。';
  expect(correctSavedStateDateGuidance(text, [rows])).toBe(text);
});

test('dataset identifiers work and repeated corrections only emit one factual notice', () => {
  const text = 'work-rules可以扩大日期范围查记录。工资规则可能在范围外。';
  const result = correctSavedStateDateGuidance(text, mixedWork());
  expect((result.match(/仅扩大日期范围不会增加匹配记录/g) || []).length).toBe(1);
  expect(result).not.toContain('work-rules可以扩大日期范围查记录');
  expect(readableQueryProse(text, mixedWork())).toContain('工资规则参考读取目前已保存状态');
});
