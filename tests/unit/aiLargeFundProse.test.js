jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
const { validFundAmountClaims, fundQueryFacts } = require('../../src/modules/ai/service/queryFundProse');
const { scrubModelProse, buildQueryAnswer } = require('../../src/modules/ai/service/v3AnswerPresentation');

const scope = { startDate: '2023-11-12', endDate: '2026-11-12' };
function history() {
  return { datasetId: 'fund-history', domain: 'fund', title: '三年基金收益',
    columns: [{ key: 'name', label: '基金', type: 'text' }, { key: 'date', label: '月份', type: 'text' },
      { key: 'profit', label: '收益', type: 'decimal' }, { key: 'capitalDelta', label: '增持', type: 'decimal' }],
    rows: [{ name: '基金甲', fundRef: 'fund-a', date: '2026-11', profit: '0.9999', capitalDelta: '0.0000' },
      { name: '基金乙', fundRef: 'fund-b', date: '2026-11', profit: '12.5000', capitalDelta: '100.0000' }],
    summary: { profit: '9876.5432', capitalDelta: '246.9120', count: 1097 },
    queryMeta: { version: 1, datasetId: 'fund-history', queryId: 'q_0123456789abcdef01234567', resolution: 'month',
      requestedScope: scope, effectiveScope: scope, summaryComplete: true, rowsComplete: false,
      matchedRowCount: 74, returnedRowCount: 2, sourceRecordCount: 1097, filters: { direction: 'both', text: '' },
      sort: 'dateDesc', returnedDateRange: null, asOf: '2026-11-12T06:00:00.000Z' }, truncated: true };
}

test.each([
  '三年基金收益合计为9876.5432元。',
  '全范围基金累计收益为9876.5432元。',
  '三年本金增量合计为246.9120元。',
  '2023-11-12至2026-11-12基金收益合计为9876.5432元。',
])('complete SQL summaries can support an explicit whole-range claim: %s', phrase => {
  const dataset = history();
  expect(validFundAmountClaims(phrase, [dataset])).toBe(true);
  const expected = phrase.includes('9876.5432') ? '9876.5432' : '246.9120';
  expect(buildQueryAnswer(phrase, [dataset])).toContain(expected);
  if (!phrase.startsWith('2023-')) expect(scrubModelProse(phrase, [dataset])).toContain(expected);
});

test.each([
  '三年基金收益合计为9876.54元。',
  '基金甲收益合计为9876.5432元。',
  '基金丙收益合计为9876.5432元。',
  '基金甲2号收益合计为9876.5432元。',
  '2025年基金收益合计为9876.5432元。',
  '2026年11月基金收益合计为9876.5432元。',
  '2024-11-12至2026-11-12基金收益合计为9876.5432元。',
  '三年基金登记市值为9876.5432元。',
])('a value match alone cannot prove another name, period, field or amount: %s', phrase => {
  expect(validFundAmountClaims(phrase, [history()])).toBe(false);
});

test.each([
  { summaryComplete: false },
  { sourceRecordCount: null },
  { requestedScope: { startDate: '2022-11-12', endDate: '2026-11-12' } },
  { effectiveScope: { startDate: '2025-11-13', endDate: '2026-11-12' } },
])('an incomplete scope or summary cannot claim complete three-year totals: case %#', patch => {
  const dataset = history(); dataset.queryMeta = { ...dataset.queryMeta, ...patch };
  expect(validFundAmountClaims('三年基金收益合计为9876.5432元。', [dataset])).toBe(false);
  expect(fundQueryFacts([dataset])).not.toContain('已保存收益合计 9876.5432');
});

test.each([
  ['基金甲2026年11月收益增量0.9999元。', true],
  ['基金甲2026-11收益合计0.9999元。', true],
  ['基金乙2026年11月本金增量100.0000元。', true],
  ['基金甲2025年11月收益增量0.9999元。', false],
  ['基金甲2026年10月收益增量0.9999元。', false],
  ['基金乙2026年11月收益增量0.9999元。', false],
  ['基金甲2026年11月12日收益增量0.9999元。', false],
  ['基金甲2026年收益增量0.9999元。', false],
  ['基金甲11月收益增量0.9999元。', false],
])('monthly source facts retain name and exact period: %s', (phrase, expected) => {
  expect(validFundAmountClaims(phrase, [history()])).toBe(expected);
});

test('yearly rows support only the declared year, not a day or month inside it', () => {
  const dataset = history(); dataset.queryMeta.resolution = 'year';
  dataset.rows = [{ name: '基金甲', date: '2026', profit: '19.8765', capitalDelta: '12.3400' }];
  expect(validFundAmountClaims('基金甲2026年收益合计为19.8765元。', [dataset])).toBe(true);
  expect(validFundAmountClaims('基金甲2025年收益合计为19.8765元。', [dataset])).toBe(false);
  expect(validFundAmountClaims('基金甲2026年11月收益合计为19.8765元。', [dataset])).toBe(false);
  expect(validFundAmountClaims('基金甲2026-11-12收益合计为19.8765元。', [dataset])).toBe(false);
  delete dataset.queryMeta.resolution;
  expect(validFundAmountClaims('基金甲2026年收益合计为19.8765元。', [dataset])).toBe(false);
});

test('a filtered single-fund complete result proves its own sum, never a returned prefix or an unreturned fund', () => {
  const dataset = history();
  dataset.rows = Array.from({ length: 37 }, (_, index) => ({
    name: '基金甲', fundRef: 'fund-a', date: new Date(Date.UTC(2023, 10 + index, 1)).toISOString().slice(0, 7),
    profit: '1.0000', capitalDelta: '0.0000',
  }));
  dataset.summary = { profit: '37.0000', capitalDelta: '0.0000', count: 1097 };
  dataset.queryMeta = { ...dataset.queryMeta, matchedRowCount: 37, returnedRowCount: 37, rowsComplete: true,
    filters: { direction: 'both', text: '基金甲' } };
  expect(validFundAmountClaims('基金甲三年收益合计为37.0000元。', [dataset])).toBe(true);
  expect(validFundAmountClaims('基金甲2号三年收益合计为37.0000元。', [dataset])).toBe(false);
  dataset.queryMeta.rowsComplete = false;
  expect(validFundAmountClaims('基金甲三年收益合计为37.0000元。', [dataset])).toBe(false);
  dataset.queryMeta.rowsComplete = true; dataset.rows.at(-1).fundRef = 'another-fund';
  expect(validFundAmountClaims('基金甲三年收益合计为37.0000元。', [dataset])).toBe(false);
});

test('the final answer publishes full-precision SQL totals before its partial monthly display', () => {
  const answer = buildQueryAnswer('三年基金收益合计为9876.5432元。', [history()]);
  expect(answer).toContain('2023-11-12 至 2026-11-12');
  expect(answer).toContain('已保存收益合计 9876.5432');
  expect(answer).toContain('本金增量合计 246.9120');
  expect(answer).toContain('按月汇总');
  expect(answer).toContain('部分登记记录，不能相加作为完整合计');
});
