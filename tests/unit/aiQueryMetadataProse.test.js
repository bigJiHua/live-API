jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw Error('metadata prose tests must not query the database'); }),
  getConnection: jest.fn(() => { throw Error('metadata prose tests must not open a connection'); }),
}));
const { normalizeQueryMetadataProse } = require('../../src/modules/ai/service/queryMetadataProse');
const { readableQueryProse, queryCoverageProse } = require('../../src/modules/ai/service/queryCoverageProse');
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const db = require('../../src/common/config/db');
const scope = {startDate: '2026-06-01', endDate: '2026-06-30'};
const monthly = {datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
  columns: [{key: 'month', type: 'date'}, {key: 'income', label: '收入', type: 'money'},
    {key: 'expense', label: '支出', type: 'money'}, {key: 'count', label: '笔数', type: 'number'}],
  rows: [{month: '2026-06', income: '3911.24', expense: '5784.61', count: 268}], truncated: false,
  summary: {income: '3911.24', expense: '5784.61', count: 268, incomeCount: 115, expenseCount: 153,
    unpricedCount: 0, currency: 'CNY'},
  queryMeta: {queryId: 'q_aaaaaaaaaaaaaaaaaaaaaaaa', requestedScope: scope, effectiveScope: scope,
    filters: {direction: 'both', text: ''}, matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 268,
    rowsComplete: true, summaryComplete: true, rankingComplete: true}};

test('query prose renders range/count identifiers in Chinese and preserves business dates, amounts and server coverage', () => {
  const datasets = [JSON.parse(JSON.stringify(monthly))], original = JSON.parse(JSON.stringify(datasets));
  const prose = '2026-06-01 至 2026-06-30，收入3911.24元，支出5784.61元。\n'
    + '匹配数量：matchedRowCount=1 行，本次展示数量：returnedRowCount=1 行（limit=1，truncated=false）。\n'
    + 'requestedScope = effectiveScope，rowsComplete/summaryComplete/rankingComplete 均为完整。';
  const answer = readableQueryProse(buildQueryAnswer(prose, datasets), datasets);
  expect(answer).not.toMatch(/\b(?:effectiveScope|requestedScope|matchedRowCount|returnedRowCount|rowsComplete|summaryComplete|rankingComplete|limit|truncated)\b/);
  for (const fact of ['2026-06-01 至 2026-06-30', '3911.24', '5784.61', '匹配数量：1 行',
    '本次展示数量：1 行', '原请求范围与实际读取范围一致']) expect(answer).toContain(fact);
  const coverage = queryCoverageProse(datasets);
  expect(normalizeQueryMetadataProse(coverage, datasets)).toBe(coverage);
  expect(coverage).toContain('匹配 1 行，本次展示 1 行，来源 268 笔记录');
  expect(datasets).toEqual(original);
});

test.each([
  ['rowsComplete=true', '已返回全部匹配行'], ['rowsComplete:false', '明细尚未全部返回'],
  ['summaryComplete=true', '汇总覆盖完整范围'], ['summaryComplete=false', '汇总尚未确认覆盖完整范围'],
  ['rankingComplete=true', '金额排名覆盖完整范围'], ['rankingComplete:false', '金额排名尚未确认覆盖完整范围'],
  ['truncated=true', '仅展示部分匹配记录'], ['"truncated":false', '本次未截取匹配记录'],
  ['`limit`=10', '本次展示上限为 10 行'], ['"limit":1', '本次展示上限为 1 行'],
  ['sourceRecordCount=268 笔', '来源记录数量为 268 笔'], ['queryMeta 记录当前范围', '查询信息 记录当前范围'],
])('query metadata syntax has a readable rendering: %s', (text, expected) => {
  expect(readableQueryProse(text, [monthly])).toBe(expected);
});

test.each(['备注中写了limit=1，请按原文保留。', 'Archive requestedScope = effectiveScope for support.',
  'rowsComplete/summaryComplete/rankingComplete 均为完整', '__AI_METADATA_PLACEHOLDER_0__ truncated=true；English / 中文。'])
  ('approved text cells containing metadata words are preserved exactly: %s', remark => {
    const datasets = [{columns: [{key: 'remark', type: 'text'}], rows: [{remark}]}];
    const text = '原始备注「' + remark + '」。matchedRowCount=81 行，returnedRowCount=10 行。';
    const result = readableQueryProse(text, datasets);
    expect(result).toContain('原始备注「' + remark + '」');
    expect(result).toContain('匹配数量为 81 行，本次展示数量为 10 行');
  });

test.each(['The credit limit is unchanged. The English word truncated describes this paragraph.',
  'effectiveScopes requestedScopes limitlessly matchedRowCounts returnedRowCounter',
  '正常中文与 English explanation；日期2026-06-01，支出5784.61元。'])
  ('ordinary language and token lookalikes remain unchanged: %s', text => {
    expect(normalizeQueryMetadataProse(text, [])).toBe(text);
  });

test('exact source text and adjacent diagnostic metadata are handled independently without marker placeholders', () => {
  const datasets = [{columns: [{key: 'name', type: 'text'}, {key: 'remark', type: 'text'}],
    rows: [{name: 'queryMeta:matchedRowCount=81', remark: 'matchedRowCount=81'}]}];
  expect(normalizeQueryMetadataProse('queryMeta:matchedRowCount=81；matchedRowCount=81；returnedRowCount=10。', datasets))
    .toBe('queryMeta:matchedRowCount=81；matchedRowCount=81；本次展示数量为 10。');
  expect(normalizeQueryMetadataProse('备注「matchedRowCount=80」；returnedRowCount=10。', datasets))
    .toBe('备注「匹配数量为 80」；本次展示数量为 10。');
});

afterEach(() => {expect(db.execute).not.toHaveBeenCalled(); expect(db.getConnection).not.toHaveBeenCalled();});
