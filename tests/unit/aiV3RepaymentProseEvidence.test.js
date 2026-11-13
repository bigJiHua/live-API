jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
// Anonymous single-sentence equivalents of paid N10. The actual v3Service
// answer builder runs, while any live DB/pool access is forbidden.
const rows = () => ({ datasetId: 'card-repayments', domain: 'card', title: '信用卡还款历史',
  columns: [{ key: 'name', type: 'text' }, { key: 'month', type: 'date' }, { key: 'amount', type: 'money' }, { key: 'date', type: 'text' }, { key: 'method', type: 'text' }],
  rows: [{ name: '示例卡 9485', month: '2026-07', amount: '3.00', date: '2026-07-27', method: 'bank_card' },
    { name: '对照卡', month: '2026-08', amount: '81.67', date: '2026-08-13', method: 'bank_card' },
    { name: '示例卡 9485', month: '2026-08', amount: '6.25', date: '2026-08-14', method: 'bank_card' }],
  summary: {}, truncated: true, queryMeta: { datasetId: 'card-repayments', effectiveScope: { startDate: '2026-05-01', endDate: '2026-08-31' },
    filters: { direction: 'both', text: '' }, matchedRowCount: 53, returnedRowCount: 3, sourceRecordCount: null, rowsComplete: false } });
test.each([
  ['7. 示例卡9485｜账单月2026-07｜3.00元｜2026-07-27｜银行卡', '7. 示例卡 9485｜账单月2026-07｜3.00元｜2026-07-27｜银行卡'],
  ['7. 示例卡 9485｜账单月2026-07｜3元｜2026-07-27｜银行卡', '7. 示例卡 9485｜账单月2026-07｜3元｜2026-07-27｜银行卡'],
  ['7. 示例卡\t9485｜账单月2026-07｜CNY 3.00｜2026-07-27', '7. 示例卡 9485｜账单月2026-07｜CNY 3.00｜2026-07-27'],
])('same approved card identity survives spacing: %s', (raw, expected) => { expect(buildQueryAnswer(raw, [rows()])).toContain(expected); });
test.each([
  '7. 示例卡9486｜账单月2026-07｜3.00元｜2026-07-27',
  '7. 示例卡94850｜账单月2026-07｜3.00元｜2026-07-27',
  '7. 示例卡9485.3元，2026-07-27',
  '7. 示例卡 9485.3元，2026-07-27',
  '7. 示例卡9485e3元，2026-07-27',
  '7. 示例卡 9485e3元，2026-07-27',
  '7. 示例卡9485｜账单月2026-07｜81.67元｜2026-07-27',
  '7. 示例卡9485｜账单月2026-07｜6.25元｜2026-07-27',
  '7. 示例卡9485｜账单月2026-08｜3.00元｜2026-08-14',
  '7. 示例卡9485｜账单月2026-07｜-3.00元｜2026-07-27',
  '7. 示例卡9485｜账单月2026-07｜CNY 81.67｜2026-07-27',
  '7. 示例卡9485｜账单月2026-07｜81.67｜2026-07-27',
  '7. 示例卡 9485｜账单月2026-07｜81.67元｜2026-07-27',
  '7. 示例卡 9485｜账单月2026-07｜6.25元｜2026-07-27',
])('tail, amount, date and sign cannot borrow another approved row: %s', raw => { expect(buildQueryAnswer(raw, [rows()])).not.toContain('7.'); });
test('two named repayments keep their own amounts within one sentence', () => {
  expect(buildQueryAnswer('示例卡9485账单月2026-07还款3元，对照卡账单月2026-08还款81.67元。', [rows()]))
    .toContain('示例卡 9485账单月2026-07还款3元，对照卡账单月2026-08还款81.67元。');
  expect(buildQueryAnswer('示例卡9485账单月2026-07还款81.67元，对照卡账单月2026-08还款3元。', [rows()])).not.toContain('81.67元');
});
test('normalization and row-bound checks do not mutate the approved source rows', () => {
  const data = rows(), before = JSON.stringify(data);
  buildQueryAnswer('示例卡9485账单月2026-07还款3元。', [data]);
  expect(JSON.stringify(data)).toBe(before);
});

