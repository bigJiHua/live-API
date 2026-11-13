// Anonymous fixtures keep saved instants separate from business calendar dates.
const {
  normalizeSavedTimestampDisplay,
  normalizeQueryTimestampDisplay,
} = require('../../src/modules/ai/service/queryTimestampDisplay');
const { stripVerifiedClockTokens } = require('../../src/modules/ai/service/queryTemporalProse');

const clone = value => structuredClone(value);
function accounts() {
  return [{
    datasetId: 'account-balances', title: '账户余额',
    columns: [
      { key: 'name', type: 'text' }, { key: 'type', type: 'text' },
      { key: 'currency', type: 'text' }, { key: 'balance', type: 'money' },
      { key: 'updatedAt', type: 'text' },
    ],
    rows: [
      { name: '账户甲', type: 'debit', currency: 'CNY', balance: '12.34', updatedAt: '2027-02-12T04:20:44.568Z' },
      { name: '账户乙', type: 'debit', currency: 'CNY', balance: '56.78', updatedAt: '2027-02-12T13:14:45.489Z' },
    ],
    queryMeta: {
      version: 1,
      queryId: 'q_' + 'a'.repeat(24), datasetId: 'account-balances',
      effectiveScope: { startDate: '2027-02-01', endDate: '2027-02-14' },
      matchedRowCount: 2, returnedRowCount: 2,
      asOf: '2027-02-13T16:25:20.491Z',
    },
  }];
}
function monthly() {
  return [{
    datasetId: 'finance-monthly', title: '月度收支',
    columns: [{ key: 'month', type: 'date' }, { key: 'income', type: 'money' }, { key: 'expense', type: 'money' }, { key: 'count', type: 'number' }],
    rows: [{ month: '2027-01', income: '12.34', expense: '56.78', count: 16 }],
    summary: { income: '12.34', expense: '56.78', count: 16, net: '-44.44' },
    queryMeta: {
      version: 1,
      queryId: 'q_' + 'c'.repeat(24), datasetId: 'finance-monthly',
      effectiveScope: { startDate: '2027-01-01', endDate: '2027-01-31' },
      matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: 16,
      asOf: '2027-02-13T16:24:00.808Z',
    },
  }];
}
function composition(maxUpdatedAt = '2027-01-12T13:14:45.489Z') {
  return [{
    datasetId: 'asset-composition',
    columns: [{ key: 'type', type: 'text' }, { key: 'currency', type: 'text' }, { key: 'minUpdatedAt', type: 'text' }, { key: 'maxUpdatedAt', type: 'text' }],
    rows: [{ type: 'debit', currency: 'CNY', minUpdatedAt: '2027-01-12T04:20:44.568Z', maxUpdatedAt }],
  }];
}

test('date-only reading claim uses the current UTC instant without changing monthly facts', () => {
  const data = monthly(), before = clone(data);
  const answer = normalizeQueryTimestampDisplay('2027-01-01至2027-01-31，收入12.34，支出56.78，16笔，净支出44.44。数据截至2027-02-13。', data);
  expect(answer).toContain('数据读取时间：2027-02-13 16:24:00.808 UTC');
  expect(answer).not.toContain('数据截至2027-02-13');
  for (const fact of ['2027-01-01', '2027-01-31', '12.34', '56.78', '16笔', '44.44']) expect(answer).toContain(fact);
  expect(data).toEqual(before);
});

test('saved clocks gain UTC while raw ISO timestamps, amounts and row counts stay intact', () => {
  const data = accounts(), before = clone(data);
  const answer = normalizeQueryTimestampDisplay('账户甲余额12.34 CNY，最后保存2027-02-12 04:20。账户乙余额56.78 CNY，最后保存2027-02-12 13:14。匹配2行，展示2行。', data);
  expect(answer).toContain('04:20（UTC）'); expect(answer).toContain('13:14（UTC）');
  for (const fact of ['12.34 CNY', '56.78 CNY', '匹配2行', '展示2行']) expect(answer).toContain(fact);
  expect(data).toEqual(before);
});

test.each(['北京时间', '上海时间', 'CST', 'UTC+08:00', 'Asia/Shanghai'])('proven source clock repairs the incorrect %s label before temporal validation', label => {
  const raw = `账户甲余额12.34 CNY，最后保存2027-02-12 04:20（${label}）。`;
  expect(stripVerifiedClockTokens(raw, accounts()).unsupported).toBe(true);
  const answer = normalizeSavedTimestampDisplay(raw, accounts());
  expect(answer).toContain('12.34 CNY'); expect(answer).toContain('04:20（UTC）');
  expect(answer).not.toContain(`（${label}）`);
  expect(stripVerifiedClockTokens(answer, accounts()).unsupported).toBe(false);
});

test.each([
  '2027-02-12 12:20（北京时间）', '2027-02-12 13:14',
  '2027-02-13 04:20', '2027-02-12 04:21',
  '2027-02-12 04:20:45', '2027-02-12 04:20+08:00',
])('wrong row, date, clock, second or numeric offset remains unsupported: %s', value => {
  const raw = `账户甲余额12.34 CNY，最后保存${value}。`;
  expect(normalizeSavedTimestampDisplay(raw, accounts())).toBe(raw);
  expect(stripVerifiedClockTokens(raw, accounts()).unsupported).toBe(true);
});

test('calendar cutoff and business history remain separate from the query read instant', () => {
  const data = monthly(); data[0].queryMeta.effectiveScope.endDate = '2027-02-13';
  for (const raw of ['交易截至2027-02-13。', '历史记录截至2027-02-13。', '数据截至2027-02-13。', '查询范围截至2027-01-31。']) {
    expect(normalizeQueryTimestampDisplay(raw, data)).toBe(raw);
  }
});

test('ambiguous multiple-query read times receive an explicit replacement and separate instants', () => {
  const data = monthly(), other = clone(data[0]);
  other.datasetId = other.queryMeta.datasetId = 'finance-daily'; other.title = '每日收支';
  other.queryMeta.queryId = 'q_' + 'b'.repeat(24); other.queryMeta.asOf = '2027-02-13T17:00:01.000Z'; data.push(other);
  const answer = normalizeQueryTimestampDisplay('完整查询。数据截至2027-02-13。', data);
  expect(answer).not.toContain('数据截至2027-02-13'); expect(answer).toContain('各数据集读取时刻分别见下文。');
  expect(answer).toContain('16:24:00.808 UTC'); expect(answer).toContain('17:00:01.000 UTC');
  expect(normalizeQueryTimestampDisplay(answer, data)).toBe(answer);
});

test('opaque source remarks and ordinary Chinese or English punctuation stay byte-for-byte intact', () => {
  const data = accounts(); data[0].columns.push({ key: 'remark', type: 'text' });
  data[0].rows[0].remark = '数据截至2027-02-13，最后保存2027-02-12 04:20（北京时间）';
  const raw = `备注：「${data[0].rows[0].remark}」。`;
  expect(normalizeQueryTimestampDisplay(raw, data)).toBe(raw);
  const onlyRemark = [{ datasetId: 'finance-transactions', columns: [{ key: 'name', type: 'text' }, { key: 'remark', type: 'text' }], rows: [{ name: '记录甲', remark: '2027-02-12T04:20:44.568Z' }] }];
  expect(stripVerifiedClockTokens('记录甲最后保存2027-02-12 04:20。', onlyRemark).unsupported).toBe(true);
  const punctuation = 'foo,,bar!! 甲，，乙。。';
  expect(normalizeQueryTimestampDisplay(punctuation, monthly())).toBe(punctuation);
  data[0].rows[0].remark = 'foo,,bar!!';
  expect(normalizeQueryTimestampDisplay('备注：「foo,,bar!!」。', data)).toBe('备注：「foo,,bar!!」。');
});

test('both clocks in a same-source range are proven before a shared UTC suffix is appended', () => {
  const raw = '借记卡 / CNY：快照时间2027-01-12 04:20至13:14';
  const answer = normalizeSavedTimestampDisplay(raw, composition());
  expect(answer).toBe(raw + '（UTC）'); expect(stripVerifiedClockTokens(answer, composition()).unsupported).toBe(false);
});

test.each(['+08:00', '-02:30'])('explicit numeric source offset %s preserves its source clock', zone => {
  const data = accounts(); data[0].rows[0].updatedAt = '2027-02-12T04:20:44.568' + zone;
  const raw = '账户甲最后保存2027-02-12 04:20';
  const answer = normalizeSavedTimestampDisplay(raw, data);
  expect(answer).toBe(raw + `（UTC${zone}）`); expect(stripVerifiedClockTokens(answer, data).unsupported).toBe(false);
});

test('a source without a zone remains explicitly unknown and cannot authorize a UTC claim', () => {
  const data = accounts(); data[0].rows[0].updatedAt = '2027-02-12 04:20:44.568';
  const raw = '账户甲最后保存2027-02-12 04:20';
  expect(normalizeSavedTimestampDisplay(raw, data)).toBe(raw + '（时区未标明）');
  expect(stripVerifiedClockTokens(raw + '（UTC）', data).unsupported).toBe(true);
  expect(stripVerifiedClockTokens(raw + '（时区未标明）', data).unsupported).toBe(false);
});

test.each(['2027-02-30T04:20:00Z', '2027-02-12T04:20:00+99:99'])('illegal calendar dates or offsets cannot establish saved evidence: %s', value => {
  const data = accounts(); data[0].rows[0].updatedAt = value;
  const raw = '账户甲最后保存' + value.slice(0, 10) + ' 04:20';
  expect(stripVerifiedClockTokens(raw, data).unsupported).toBe(true);
  expect(normalizeSavedTimestampDisplay(raw, data)).toBe(raw);
});

test('different source zones cannot establish one shared range timezone', () => {
  const data = composition('2027-01-12 13:14:45.489');
  const raw = '借记卡 / CNY：快照时间2027-01-12 04:20至13:14';
  expect(stripVerifiedClockTokens(raw, data).unsupported).toBe(true);
  expect(normalizeSavedTimestampDisplay(raw, data)).toBe(raw);
});

test('conflicting prefix and suffix labels are repaired only for the proven clock', () => {
  const raw = '账户甲最后保存UTC 2027-02-12 04:20（北京时间）。';
  expect(stripVerifiedClockTokens(raw, accounts()).unsupported).toBe(true);
  const answer = normalizeSavedTimestampDisplay(raw, accounts());
  expect(answer).toContain('04:20（UTC）'); expect(answer).not.toContain('北京时间'); expect(answer).not.toContain('UTC 2027-');
  expect(stripVerifiedClockTokens(answer, accounts()).unsupported).toBe(false);
});

test('middle and repeated range labels move to one proven suffix and stay idempotent', () => {
  const raw = '借记卡 / CNY：快照时间2027-01-12 04:20（UTC）至13:14';
  const expected = '借记卡 / CNY：快照时间2027-01-12 04:20至13:14（UTC）';
  for (const extra of ['', '（UTC）', '（北京时间）']) {
    const answer = normalizeSavedTimestampDisplay(raw + extra, composition());
    expect(answer).toBe(expected); expect(normalizeSavedTimestampDisplay(answer, composition())).toBe(answer);
    expect(stripVerifiedClockTokens(answer, composition()).unsupported).toBe(false);
  }
  expect(normalizeSavedTimestampDisplay(expected + ' UTC', composition())).toBe(expected);
});

test('original ISO Z and trailing wrong labels retain the original instant without repeated labels', () => {
  const raw = '账户甲最后保存2027-02-12T04:20:44.568Z（北京时间）';
  const answer = normalizeSavedTimestampDisplay(raw, accounts());
  expect(answer).toBe('账户甲最后保存2027-02-12T04:20:44.568Z（UTC）');
  expect(normalizeSavedTimestampDisplay(answer, accounts())).toBe(answer);
});

test('wrong reading dates and clocks are replaced only from the unique current asOf source', () => {
  for (const raw of ['数据截至2027-02-12。', '数据截至2027-02-14。', '数据读取时间2027-02-12 11:22 UTC。', '数据截至2027年2月13日。']) {
    expect(normalizeQueryTimestampDisplay(raw, monthly())).toBe('数据读取时间：2027-02-13 16:24:00.808 UTC。');
  }
});

test('missing query identity cannot authorize a specific reading correction', () => {
  const data = monthly(); delete data[0].queryMeta.queryId;
  expect(normalizeQueryTimestampDisplay('数据截至2027-02-13。', data)).toBe('数据截至2027-02-13。');
});

test('the declared repayment timestamp exception does not shift date-only business values', () => {
  const data = [{ datasetId: 'card-repayments', columns: [{ key: 'name', type: 'text' }, { key: 'date', type: 'date' }], rows: [{ name: '还款账户', date: '2027-02-12 04:20:44' }] }];
  const raw = '还款账户发生于2027-02-12 04:20';
  expect(normalizeSavedTimestampDisplay(raw, data)).toBe(raw + '（时区未标明）');
  expect(normalizeQueryTimestampDisplay('还款日期2027-02-12，账单月份2027-02。', data)).toBe('还款日期2027-02-12，账单月份2027-02。');
});
