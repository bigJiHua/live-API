const crypto = require('crypto');
const { liveDates, liveCase, seedLiveDomains, groundedAnswer, extractAmounts, containsExpectedPoints, verifiedCalcReceipts } = require('./liveFixtures');

test('live calendar crosses year and leap boundaries while keeping next month expectation aligned', () => {
  const dates = liveDates('2028-01-31');
  expect(dates).toEqual({ today: '2028-01-31', currentMonth: '2028-01-01', previousMonth: '2027-12-01',
    olderMonth: '2027-11-01', nextMonth: '2028-02-01', soon: '2028-02-02' });
  const original = { id: 'todo-next-month', expect: { answerContains: ['2026-12-01'] } };
  expect(liveCase(original, dates).expect.answerContains).toEqual(['2028-02-01']);
  expect(original.expect.answerContains).toEqual(['2026-12-01']);
});

test('seed writes reject any database or owner outside the designated isolated fixture', async () => {
  const pool = { query: jest.fn(async () => [[{ name: 'live_mock_20261112' }]]), getConnection: jest.fn() };
  await expect(seedLiveDomains(pool, { userId: 'ai_real_test_user', today: '2026-11-12' })).rejects.toThrow('仅允许');
  expect(pool.getConnection).not.toHaveBeenCalled();
  pool.query.mockResolvedValue([[{ name: 'live_ai_test' }]]);
  await expect(seedLiveDomains(pool, { userId: 'someone_else', today: '2026-11-12' })).rejects.toThrow('仅允许');
  expect(pool.getConnection).not.toHaveBeenCalled();
});

test('grounding uses exact canonical numeric values, preserving sign and decimals', () => {
  const data = [{ rows: [{ income: '8500.00', profit: '-200.0000' }], summary: {} }];
  expect(groundedAnswer('收入 8500 元，收益 -200.00 元。', data, {})).toBe(true);
  expect(groundedAnswer('收入 50.00 元。', data, {})).toBe(false);
  expect(groundedAnswer('收益 200.00 元。', data, {})).toBe(false);
  expect(groundedAnswer('收入 8500.99 元。', data, {})).toBe(false);
  expect(groundedAnswer('收入 8500.00001 元。', data, {})).toBe(false);
  expect(groundedAnswer('收入 5e9 元。', data, {})).toBe(false);
  expect(groundedAnswer('费用 50 元。', [], { expect: { allowedNumbers: ['1050.50'] } })).toBe(false);
});

test('dates and fund identifiers are not mistaken for money; one digit money and large decimal values remain checked', () => {
  expect(extractAmounts('沪深300指数A，2026-11-12 市值 12850.00 元，收益 -200.1234 元。')).toEqual(['12850', '-200.1234']);
  expect(groundedAnswer('金额 5.00 元。', [], {})).toBe(false);
  expect(groundedAnswer('金额 5 元。', [], {})).toBe(false);
});

test('only a matching transaction draft can use money literally stated by the user', () => {
  const caseDef = { message: '今天午饭花了20块4毛，微信支付', draft: {}, expect: { proposalAmount: '20.40' } };
  expect(groundedAnswer('草稿支出 20.40 元。', [], caseDef, { draft: { amount: '20.40' } })).toBe(true);
  expect(groundedAnswer('草稿支出 20.40 元、服务费 50.00 元。', [], caseDef, { draft: { amount: '20.40' } })).toBe(false);
  expect(groundedAnswer('支出 20.40 元。', [], caseDef, { draft: { amount: '20.00' } })).toBe(false);
  expect(groundedAnswer('支出 20.40 元。', [], { message: caseDef.message })).toBe(false);
});

test('complete thousands grouping canonicalizes while slash and Chinese dates are masked', () => {
  const data = [{ rows: [{ planned: '2000.00', registeredUsed: '1450.00' }] }];
  const answer = '2026/11/12 计划预算 2,000.00 元，已登记使用 1,450 元；保存日期2026年11月12日。';
  expect(extractAmounts(answer)).toEqual(['2000', '1450']);
  expect(groundedAnswer(answer, data, {})).toBe(true);
  expect(groundedAnswer('已登记使用 450 元。', data, {})).toBe(false);
  expect(groundedAnswer('已登记使用 -1,450 元。', data, {})).toBe(false);
  expect(groundedAnswer('已登记使用 −¥1,450 元。', data, {})).toBe(false);
  expect(groundedAnswer('已登记使用 1,450,00 元。', data, {})).toBe(false);
  expect(extractAmounts('每期416.67元，11-01 至 11-12 窗口内有1笔待入账。')).toEqual(['416.67']);
  expect(groundedAnswer('未验证算式11-1=10元。', [], {})).toBe(false);
});

test('only digest-matched actual successful calc values enter grounding, not expression inputs', () => {
  const result = { expression: '620/7718.90*100', mode: 'money', value: '8.03', cents: '803' };
  const digest = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
  const traces = [{ tool: 'calculate', records: 1, digest }];
  const rows = [{ status: 'ok', response_payload: JSON.stringify({ tool: 'calculate', digest, result }) }];
  const receipts = verifiedCalcReceipts(rows, traces);
  expect(groundedAnswer('占比 8.03%。', [], {}, {}, receipts)).toBe(true);
  expect(groundedAnswer('金额 620 元。', [], {}, {}, receipts)).toBe(false);
  expect(groundedAnswer('金额 803 元。', [], {}, {}, receipts)).toBe(false);
  expect(verifiedCalcReceipts([{ ...rows[0], status: 'error' }], traces)).toEqual([]);
  expect(verifiedCalcReceipts(rows, [{ ...traces[0], digest: 'stale' }])).toEqual([]);
  expect(verifiedCalcReceipts([{ status: 'ok', response_payload: JSON.stringify({ tool: 'calculate', digest, result: { ...result, value: '99' } }) }], traces)).toEqual([]);
});

test('numeric expected points match complete tokens rather than normalized substrings', () => {
  expect(containsExpectedPoints('预算 2,000 元，已用1,450.00 元。', ['2000.00', '1450.00'])).toBe(true);
  expect(containsExpectedPoints('工资 8,500.00 元。', ['50.00'])).toBe(false);
  expect(containsExpectedPoints('预算 1,450.00 元。', ['450'])).toBe(false);
  expect(containsExpectedPoints('收益 -200 元。', ['200.00'])).toBe(false);
  expect(containsExpectedPoints('下次日期2026/11/12，总期数6期。', ['2026'])).toBe(false);
  expect(containsExpectedPoints('总期数6期。', ['6'])).toBe(true);
  expect(containsExpectedPoints('工资 8,500 元。', ['工资', '8500.00'])).toBe(true);
});

test('milliseconds on a published clock are not mistaken for a monetary amount', () => {
  expect(extractAmounts('数据读取时间2026-11-12 07:00:49.119 UTC，优先级2。')).toEqual([]);
  expect(groundedAnswer('数据读取时间2026-11-12 07:00:49.119 UTC。', [], {})).toBe(true);
  expect(groundedAnswer('未经核验的金额49.119元。', [], {})).toBe(false);
});

test('explicit abbreviated calendar references are not financial operands', () => {
  expect(extractAmounts('11月至今（截至11-12）没有已保存工资记录。')).toEqual([]);
  expect(groundedAnswer('截至11-12，已登记工资8500元。', [{ rows: [{ income: '8500' }] }], {})).toBe(true);
  expect(groundedAnswer('未经核验金额11-12=-1元。', [], {})).toBe(false);
});

test('date points accept Chinese date layout with the correct year context', () => {
  const point = ['2026-12-01'];
  expect(containsExpectedPoints('下个月（2026年12月）只有1条：12月1日信用卡还款。', point)).toBe(true);
  expect(containsExpectedPoints('2026年12月1号信用卡还款。', point)).toBe(true);
  expect(containsExpectedPoints('12月1日信用卡还款。', point, { nextMonth: '2026-12-01' })).toBe(true);
  expect(containsExpectedPoints('2025年12月只有1条：12月1日信用卡还款。', point, { nextMonth: '2026-12-01' })).toBe(false);
  expect(containsExpectedPoints('2026年12月2日信用卡还款。', point)).toBe(false);
  expect(containsExpectedPoints('2026-12-011', point)).toBe(false);
});
