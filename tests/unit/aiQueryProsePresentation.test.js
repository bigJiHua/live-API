jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const { readableQueryProse } = require('../../src/modules/ai/service/queryCoverageProse');

test('readable coverage wording preserves false and true evidence values', () => {
  expect(readableQueryProse('summaryComplete=false，rankingComplete: false', []))
    .toBe('汇总尚未确认覆盖完整范围，金额排名尚未确认覆盖完整范围');
  expect(readableQueryProse('summaryComplete=true，rankingComplete=true', []))
    .toBe('汇总覆盖完整范围，金额排名覆盖完整范围');
});
test('ordered row markers cannot erase approved facts or leave holes and blank paragraphs', () => {
  const data = { datasetId: 'finance-transactions', domain: 'finance', columns: [
    { key: 'remark', type: 'text' }, { key: 'amountCNY', type: 'money' }],
    rows: [{ remark: '早餐', amountCNY: '8.50' }, { remark: '午饭', amountCNY: '25.70' }, { remark: '晚饭', amountCNY: '17.30' }],
    summary: { expense: '51.50', count: 3 }, truncated: false };
  const result = buildQueryAnswer('1. 早餐8.50元\n2. 午饭25.70元\n3. 晚饭17.30元\n\n\n\n金额9999元无依据', [data]);
  expect(result).toContain('2. 午饭25.70元');
  expect(result).toContain('3. 晚饭17.30元');
  expect(result).not.toContain('9999');
  expect(result).not.toMatch(/\n{3,}/);
});

test.each(['）', '．'])('Chinese numbered-list marker %s preserves legitimate row facts', marker => {
  const dataset = { datasetId: 'finance-categories', domain: 'finance', columns: [
    { key: 'category', type: 'text' }, { key: 'amountCNY', type: 'money' }],
    rows: [{ category: '测试分类', amountCNY: '0.08' }], summary: {}, truncated: false };
  const result = buildQueryAnswer(`1${marker} 测试分类支出0.08`, [dataset]);
  expect(result).toContain('测试分类支出0.08');
});

test('a leading decimal amount cannot borrow the fractional digits as a listed fact', () => {
  const dataset = { datasetId: 'finance-transactions', domain: 'finance',
    columns: [{ key: 'amountCNY', type: 'money' }], rows: [{ amountCNY: '20.00' }], summary: {}, truncated: false };
  expect(buildQueryAnswer('1.20元是不在账本里的支出', [dataset])).not.toContain('不在账本里的支出');
});

test.each(['）', ')', '、'])('a list delimiter %s directly before a date preserves all ten approved records', marker => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ date: '2026-06-30', amountCNY: `${21 + index}.00` }));
  const dataset = { datasetId: 'finance-transactions', domain: 'finance',
    columns: [{ key: 'date', type: 'date' }, { key: 'amountCNY', type: 'money' }],
    rows, summary: {}, truncated: false };
  const input = rows.map((row, index) => `${index + 1}${marker}${row.date} 支出${row.amountCNY}元`).join('\n');
  const result = buildQueryAnswer(input, [dataset]);
  for (const row of rows) expect(result).toContain(`支出${row.amountCNY}元`);
});
