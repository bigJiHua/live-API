const { normalizeInstallmentSavedStateClaims } = require('../../src/modules/ai/service/queryInstallmentStateClaims');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');

// Anonymous saved-state data. Reading historical state never proves execution.
function datasets() {
  return [{
    datasetId: 'installment-plans',
    columns: ['pending', 'entered', 'void', 'entering', 'unknown'].map(key => ({ key, type: 'number' })),
    rows: [
      { name: '分期甲', amount: '17.38', periods: 12, active: 1, nextDate: '2027-09-26', pending: 1, entered: 0, void: 0, entering: 0, unknown: 0 },
      { name: '分期乙', amount: '17.38', periods: 12, active: 0, nextDate: '2027-08-19', pending: 0, entered: 0, void: 1, entering: 0, unknown: 0 },
      { name: '分期甲', amount: '17.38', periods: 12, active: 0, nextDate: '2027-08-28', pending: 0, entered: 0, void: 1, entering: 0, unknown: 0 },
    ],
    queryMeta: { version: 1, queryId: 'q_' + 'a'.repeat(24), datasetId: 'installment-plans', effectiveScope: { startDate: '2027-11-01', endDate: '2027-11-09' } },
  }];
}
const rowText = '1. 分期甲：每期17.38元，共12期，启用中，计划下次日期2027-09-26；范围内待入账1期，已入账0、中止0、入账中0、未知0。';
function rejected(raw, data = datasets()) {
  expect(normalizeInstallmentSavedStateClaims(raw, data)).toBe(raw);
  expect(() => assertResultClaims(raw, { artifacts: [], currentReceipts: [] })).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
}

test('saved enumeration counts become typed status claims before the unchanged receipt guard', () => {
  const data = datasets(), before = structuredClone(data);
  expect(() => assertResultClaims(rowText, { artifacts: [], currentReceipts: [] })).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  const answer = normalizeInstallmentSavedStateClaims(rowText, data);
  expect(answer).toContain('已入账状态：0、中止0、入账中0、未知0');
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).not.toThrow();
  expect(answer).toContain('每期17.38元，共12期'); expect(answer).toContain('计划下次日期2027-09-26');
  expect(normalizeInstallmentSavedStateClaims(answer, data)).toBe(answer); expect(data).toEqual(before);
});

test.each(['', '期', '条', '笔'])('enumeration state counts support the declared unit %s', unit => {
  const raw = `1. 分期甲：启用中；范围内已入账0${unit}、中止0${unit}、入账中0${unit}、未知0${unit}。`;
  const answer = normalizeInstallmentSavedStateClaims(raw, datasets());
  expect(answer).toContain(`已入账状态：0${unit}、`);
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).not.toThrow();
});

test('equal grouped labels remain quoted state nouns with enumeration-delimited later counts', () => {
  const raw = '1. 分期甲：启用中；范围内已入账/中止/入账中/未知均为0、待入账1期。';
  const answer = normalizeInstallmentSavedStateClaims(raw, datasets());
  expect(answer).toContain('「已入账」/中止/入账中/未知均为0');
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).not.toThrow();
});

test('typed continuation inherits only the immediately identified saved plan', () => {
  const raw = '1. 分期甲：共12期，启用中\n范围内待入账1期，已入账0、中止0、入账中0、未知0。';
  const answer = normalizeInstallmentSavedStateClaims(raw, datasets());
  expect(answer).toContain('已入账状态：0、中止0');
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).not.toThrow();
});

test('existing comma-delimited typed counts continue to work', () => {
  const raw = rowText.replaceAll('、', '，');
  const answer = normalizeInstallmentSavedStateClaims(raw, datasets());
  expect(answer).toContain('已入账状态：0，中止0');
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).not.toThrow();
});

test('current configuration and state-count scope remain unchanged', () => {
  const raw = '查询范围2027-11-01至2027-11-09。\n' + rowText;
  const data = datasets(), before = structuredClone(data), answer = normalizeInstallmentSavedStateClaims(raw, data);
  expect(answer).toContain('查询范围2027-11-01至2027-11-09'); expect(data).toEqual(before);
});

test.each([
  rowText.replace('已入账0、', '已入账1、'),
  rowText.replace('中止0、', '中止2、'),
  rowText.replace('未知0。', '未知1。'),
])('any incorrect count prevents proof-based normalization: %s', raw => rejected(raw));

test('a state field without the declared number type cannot authorize the count', () => {
  const data = datasets(); data[0].columns.find(column => column.key === 'entered').type = 'money'; rejected(rowText, data);
});

test('wrong explicit state scope cannot borrow the current query counts', () => {
  rejected('查询范围2027-11-01至2027-11-10。\n' + rowText);
});

test('multiple queries do not lend equal count values across scopes', () => {
  const data = datasets(), other = structuredClone(data[0]); other.queryMeta.queryId = 'q_' + 'b'.repeat(24); other.queryMeta.effectiveScope.endDate = '2027-11-10'; data.push(other); rejected(rowText, data);
});

test('no current query identity cannot authorize saved-state wording', () => {
  const data = datasets(); delete data[0].queryMeta.queryId; rejected(rowText, data);
});

test('empty saved rows cannot authorize a claimed state count', () => {
  const data = datasets(); data[0].rows = []; rejected(rowText, data);
});

test('a mismatched ordinal and plan name cannot borrow another row', () => {
  rejected(rowText.replace('1. 分期甲', '2. 分期甲'));
});

test('an all-plan aggregate with a current completion cannot borrow one named plan count', () => {
  rejected('1. 分期甲：全部计划已入账0、中止0、未知0；本轮已经入账。');
});

test('a read-only aggregate is not rewritten from one row without aggregate proof', () => {
  const raw = '1. 分期甲：全部计划已入账0、中止0、未知0。';
  expect(normalizeInstallmentSavedStateClaims(raw, datasets())).toBe(raw);
});

test('a free-standing state claim cannot borrow a previous unrelated paragraph', () => {
  rejected('已入账0、中止0、入账中0、未知0。');
});

test.each([
  '本轮已经入账', '我已为你入账', '并已完成入账',
])('an explicit completed action still requires an execution receipt: %s', action => {
  rejected('1. 分期甲：启用中；范围内已入账0、中止0、未知0；' + action + '。');
});

test('a genuine English completion cannot be hidden beside saved-state enumeration', () => {
  const raw = rowText + '\nI have posted the transaction.';
  const answer = normalizeInstallmentSavedStateClaims(raw, datasets());
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test('another dataset cannot establish installment state provenance', () => {
  const data = datasets(); data[0].datasetId = data[0].queryMeta.datasetId = 'finance-transactions'; rejected(rowText, data);
});
