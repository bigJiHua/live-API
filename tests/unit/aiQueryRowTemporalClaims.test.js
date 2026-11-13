jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { validCountClaims } = require('../../src/modules/ai/service/queryCountClaims');
const { stripVerifiedClockTokens } = require('../../src/modules/ai/service/queryTemporalProse');
const { buildQueryAnswer } = require('../../src/modules/ai/service/v3Service');
const { clearOrphanQueryHeadings, normalizeQueryPagination } = require('../../src/modules/ai/service/queryCoverageProse');

// Anonymous equivalents of paid-response failures: no owner, transaction ID,
// actual account name, actual amount, or live database is used in regression.
const scope = { startDate: '2026-06-01', endDate: '2026-06-30' };
const meta = (datasetId, { matched = 3, returned = matched, source = null } = {}) => ({
  version: 1, queryId: `q_${'a'.repeat(24)}`, datasetId, requestedScope: scope, effectiveScope: scope,
  filters: { direction: 'both', text: '' }, sort: 'dateDesc', matchedRowCount: matched,
  returnedRowCount: returned, sourceRecordCount: source, rowsComplete: matched === returned,
  summaryComplete: source !== null, rankingComplete: false, returnedDateRange: null,
});
const categories = () => ({ datasetId: 'finance-categories', domain: 'finance', title: '分类收支',
  columns: [{ key: 'category', type: 'text' }, { key: 'direction', type: 'number' },
    { key: 'amountCNY', type: 'money' }, { key: 'count', type: 'number' }, { key: 'unpricedCount', type: 'number' }],
  rows: [{ category: '奖励收入', direction: 1, amountCNY: '450.00', count: 41, unpricedCount: 0 },
    { category: '出行支出', direction: 0, amountCNY: '230.00', count: 14, unpricedCount: 0 },
    { category: '兼职收入', direction: 1, amountCNY: '80.00', count: 22, unpricedCount: 0 }],
  summary: { count: 77, incomeCount: 63, expenseCount: 14, income: '530.00', expense: '230.00' },
  queryMeta: meta('finance-categories', { matched: 9, returned: 3, source: 77 }), truncated: true,
});
const balances = () => ({ datasetId: 'account-balances', domain: 'account', title: '账户余额快照',
  columns: [{ key: 'name', type: 'text' }, { key: 'type', type: 'text' }, { key: 'currency', type: 'text' },
    { key: 'balance', type: 'money' }, { key: 'updatedAt', type: 'text' }],
  rows: [{ name: '日常借记卡', type: 'debit', currency: 'CNY', balance: '321.00', updatedAt: '2026-06-08T04:20:44.568Z' },
    { name: '备用借记卡', type: 'debit', currency: 'CNY', balance: '678.90', updatedAt: '2026-06-08T13:14:45.489Z' },
    { name: '未保存信用卡', type: 'credit', currency: null, balance: null, updatedAt: null }],
  summary: {}, queryMeta: meta('account-balances'), truncated: false,
});
const composition = () => ({ datasetId: 'asset-composition', domain: 'asset', title: '已保存账户余额组成（分币种）',
  columns: [{ key: 'type', type: 'text' }, { key: 'currency', type: 'text' },
    { key: 'positiveAssets', type: 'money' }, { key: 'count', type: 'number' }, { key: 'missingSnapshots', type: 'number' },
    { key: 'minUpdatedAt', type: 'text' }, { key: 'maxUpdatedAt', type: 'text' }],
  rows: [{ type: 'debit', currency: 'CNY', positiveAssets: '999.90', count: 13, missingSnapshots: 0,
    minUpdatedAt: '2026-06-08T04:20:44.568Z', maxUpdatedAt: '2026-06-08T13:14:45.489Z' },
  { type: 'credit', currency: '未登记', positiveAssets: '0.00', count: 7, missingSnapshots: 7, minUpdatedAt: null, maxUpdatedAt: null },
  { type: 'virtual_balance', currency: 'CNY', positiveAssets: '210.00', count: 1, missingSnapshots: 0,
    minUpdatedAt: '2026-06-08T04:20:44.568Z', maxUpdatedAt: '2026-06-08T04:20:44.568Z' },
  { type: 'virtual_cash', currency: 'CNY', positiveAssets: '70.00', count: 1, missingSnapshots: 0,
    minUpdatedAt: '2026-06-08T04:20:44.568Z', maxUpdatedAt: '2026-06-08T04:20:44.568Z' }],
  summary: {}, queryMeta: meta('asset-composition', { matched: 4 }), truncated: false,
});

test.each([
  ['奖励收入450.00元（41笔）', true],
  ['奖励收入450.00元（14笔）', false],
  ['奖励收入450.00元（77笔）', false],
  ['出行支出230.00元，共41笔', false],
  ['收入：出行支出14笔', false],
  ['出行支出230.00元，全月共77笔', true],
  ['出行支出230.00元，未定价0笔', true],
])('category source counts follow the named row and field: %s', (sentence, expected) => {
  expect(validCountClaims(sentence, [categories()])).toBe(expected);
});

test('verified category list facts survive with truncation, while a borrowed count is removed', () => {
  const rows = categories(), raw = rows.rows.map((row, index) => `${index+1}. ${row.category}${row.amountCNY}元（${row.count}笔）`).join('\n');
  const result = buildQueryAnswer(raw, [rows]);
  for (const row of rows.rows) expect(result).toContain(`${row.category}${row.amountCNY}元（${row.count}笔）`);
  expect(buildQueryAnswer('奖励收入450.00元（14笔）', [rows])).not.toContain('奖励收入450.00元（14笔）');
});

test.each([
  ['借记卡 / CNY：账户数13', true], ['借记卡 / CNY：账户数7', false],
  ['借记卡 / CNY：13个账户', true], ['借记卡 / CNY：7个账户', false],
  ['借记卡 / CNY：缺快照0', true], ['借记卡 / CNY：缺快照7', false],
  ['信用卡 / 未登记：账户数7', true], ['信用卡 / 未登记：缺快照7', true],
])('asset group quantities remain typed without a finance dataset: %s', (sentence, expected) => {
  expect(validCountClaims(sentence, [composition()])).toBe(expected);
});

test('currency groups cannot borrow counts or prove an ambiguous unqualified type', () => {
  const rows = composition(); rows.rows.push({ ...rows.rows[0], currency: 'USD', count: 2 });
  expect(validCountClaims('借记卡 / USD：账户数2', [rows])).toBe(true);
  expect(validCountClaims('借记卡 / USD：账户数13', [rows])).toBe(false);
  expect(validCountClaims('借记卡：账户数13', [rows])).toBe(false);
});

test('same category in both directions requires the stated direction', () => {
  const rows = categories(); rows.rows = [{ ...rows.rows[0], category: '同名分类', direction: 1, count: 41 },
    { ...rows.rows[1], category: '同名分类', direction: 0, count: 14 }];
  expect(validCountClaims('同名分类41笔', [rows])).toBe(false);
  expect(validCountClaims('收入：同名分类41笔', [rows])).toBe(true);
  expect(validCountClaims('支出：同名分类41笔', [rows])).toBe(false);
});

test.each([
  ['日常借记卡最后保存2026-06-08 04:20', false],
  ['日常借记卡最后保存2026-06-08 04:20:44', false],
  ['日常借记卡最后保存2026-06-08T04:20:44.568Z', false],
  ['日常借记卡最后保存2026-06-09 04:20', true],
  ['日常借记卡最后保存2026-06-08 05:20', true],
  ['日常借记卡最后保存2026-06-08 04:20:45', true],
  ['备用借记卡最后保存2026-06-08 04:20', true],
  ['未保存信用卡最后保存2026-06-08 04:20', true],
  ['最后保存2026-06-08 04:20', true],
  ['日常借记卡最后保存2026-06-08 24:20', true],
  ['日常借记卡最后保存2026-06-08 04:99', true],
  ['日常借记卡最后保存2026-06-08 04:20:99', true],
  ['日常借记卡最后保存2026-06-08 04:20+08:00', true],
  ['日常借记卡金额2026-06-08 04:20元', true],
  ['日常借记卡金额123:99元', true],
  ['日常借记卡金额04:20元', true],
])('clock evidence binds a legal same-row, same-day timestamp: %s', (sentence, unsupported) => {
  expect(stripVerifiedClockTokens(sentence, [balances()]).unsupported).toBe(unsupported);
  if (unsupported) expect(buildQueryAnswer(sentence, [balances()])).not.toContain(sentence);
});

test('both balance rows retain original timestamps and amounts', () => {
  const raw = '1. 日常借记卡余额321.00 CNY，最后保存2026-06-08 04:20\n2. 备用借记卡余额678.90 CNY，最后保存2026-06-08 13:14';
  const result = buildQueryAnswer(raw, [balances()]);
  expect(result).toContain('1. 日常借记卡余额321.00 CNY，最后保存2026-06-08 04:20');
  expect(result).toContain('2. 备用借记卡余额678.90 CNY，最后保存2026-06-08 13:14');
});

test('same-day range endpoints belong to the same typed asset group', () => {
  const rows = [balances(), composition()];
  expect(stripVerifiedClockTokens('借记卡 / CNY：快照时间2026-06-08 04:20至13:14', rows).unsupported).toBe(false);
  expect(stripVerifiedClockTokens('虚拟余额 / CNY：快照时间2026-06-08 04:20至13:14', rows).unsupported).toBe(true);
  expect(stripVerifiedClockTokens('借记卡 / CNY：快照时间2026-06-08 04:20至2026-06-09 13:14', rows).unsupported).toBe(true);
});

test('a type annotation cannot override the explicit account identity', () => {
  expect(stripVerifiedClockTokens('备用借记卡（借记，CNY）最后保存2026-06-08 04:20', [balances(), composition()]).unsupported).toBe(true);
});

test('malformed clocks never become amounts when the constituent digits are allowed', () => {
  const rows = balances(); rows.rows.push({ name: '金额测试甲', balance: '123.00' }, { name: '金额测试乙', balance: '99.00' },
    { name: '金额测试丙', balance: '4.00' }, { name: '金额测试丁', balance: '20.00' });
  expect(buildQueryAnswer('日常借记卡金额123:99元', [rows])).not.toContain('金额123:99元');
  expect(buildQueryAnswer('日常借记卡金额04:20元', [rows])).not.toContain('金额04:20元');
  expect(buildQueryAnswer('日常借记卡最后保存2026-06-09 04:20', [rows])).not.toContain('最后保存2026-06-09 04:20');
});

test.each(['1）', '1．', '（1）', '(1)', '1.', '1、'])('ordered marker %s is presentation, while a decimal amount remains a number', marker => {
  const rows = balances();
  // These rows contain no approved numeric 1: the assertion must prove marker
  // stripping instead of passing through a coincidentally equal direction code.
  expect(buildQueryAnswer(`${marker} 日常借记卡321.00 CNY`, [rows])).toContain(`${marker} 日常借记卡321.00 CNY`);
});

test('a decimal amount at the beginning cannot lose its integer digits as a list marker', () => {
  const rows = balances(); rows.rows.push({ name: '整数金额对照', type: 'debit', currency: 'CNY', balance: '20.00', updatedAt: null });
  rows.queryMeta = meta('account-balances', { matched: 4 });
  expect(buildQueryAnswer('1.20元', [rows])).not.toContain('1.20元');
  expect(buildQueryAnswer('20.00元', [rows])).toContain('20.00元');
});

test('orphan headings disappear without deleting populated lists or data scope', () => {
  const empty = '按金额排序，本次展示前 3 个分类：\n收入：\n\n支出：\n\n实际读取数据范围：2026-06-01至2026-06-30';
  const result = clearOrphanQueryHeadings(empty);
  expect(result).not.toMatch(/收入：|支出：|前 3 个分类：/);
  expect(result).toContain('实际读取数据范围');
  const populated = '收入：\n1. 奖励收入450.00元\n支出：\n1. 出行支出230.00元';
  expect(clearOrphanQueryHeadings(populated)).toBe(populated);
});

test('saved balances continue by name, and dated records can narrow dates', () => {
  expect(normalizeQueryPagination('可继续按分页查看。', [balances()])).toBe('可按名称筛选后继续查看。');
  expect(normalizeQueryPagination('可继续翻页查看。', [categories()])).toBe('可按分类筛选或缩小日期范围后继续查看。');
  expect(normalizeQueryPagination('可分页继续读取。', [{ datasetId: 'card-repayments', columns: [{ key: 'name', type: 'text' }] }]))
    .toBe('可按名称筛选或缩小日期范围后继续查看。');
});
