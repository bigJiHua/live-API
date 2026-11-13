jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const mysql = require('mysql2/promise');
const { createBusinessReadRepository, validateScope, decimalString, nextRepaymentDate, expirationMonth, budgetKeywords, savedTimestamp, DOMAINS } = require('../../src/modules/ai/service/businessRead');
const { tablesRead, CANDIDATE_SOURCE_TABLES } = require('../helpers/sqlTables');

// Candidate reads are contract-checked on table references, not SQL keywords:
// FROM and JOIN (and subqueries) all count; columns, aliases and literals cannot.
const executedTables = calls => calls.flatMap(([{ sql }]) => tablesRead(sql));
const onlyCandidateTables = (calls, group) => expect(executedTables(calls)).toEqual(CANDIDATE_SOURCE_TABLES[group]);

const now = () => new Date('2026-11-06T04:00:00Z');
const scope = { domains: ['finance'], startDate: '2026-11-01', endDate: '2026-11-06' };
let conn;
beforeEach(() => {
  jest.clearAllMocks();
  conn = { query: jest.fn().mockResolvedValue(), beginTransaction: jest.fn().mockResolvedValue(),
    execute: jest.fn().mockResolvedValue([[]]), rollback: jest.fn().mockResolvedValue(), release: jest.fn() };
  mysql.createPool.mockReturnValue({ getConnection: jest.fn().mockResolvedValue(conn), end: jest.fn().mockResolvedValue() });
});

test('all ten domains use fixed owner-bound SELECTs in one independent read-only transaction', async () => {
  const result = await createBusinessReadRepository({ dbConfig: { user: 'ai_readonly' }, now }).query('owner-123', { ...scope, domains: DOMAINS });
  expect(result.datasets.length).toBeGreaterThanOrEqual(10);
  expect(conn.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
  expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(mysql.createPool).toHaveBeenCalledWith(expect.objectContaining({ user: 'ai_readonly', decimalNumbers: false, multipleStatements: false }));
  for (const [{ sql, timeout }, params] of conn.execute.mock.calls) {
    expect(sql.trim()).toMatch(/^SELECT\b/);
    expect(sql).toMatch(/user_id = \?/);
    expect(sql).not.toContain('owner-123');
    // A 1-4 digit tail may appear only inside the server-built display name
    // (TRIM(CONCAT(...))); the raw column must never be projected as a field.
    expect(sql).not.toMatch(/SELECT\s+\*|\blast4_no\s+AS\b|full_?card_?no|card_?no|card_bin|fund_account|trade_account|\bINSERT\b|\bUPDATE\b|\bDELETE\b|CALL\s|FOR UPDATE/i);
    expect(params[0]).toBe('owner-123');
    expect(timeout).toBe(5000);
  }
});

test.each([
  { domains: ['unknown'] }, { domains: ['finance', 'finance'] }, { domains: 'finance' },
  { ...scope, startDate: '2026-02-30' }, { ...scope, endDate: '2026-10-01' },
  { ...scope, startDate: '2000-01-01' },
])('invalid scope is rejected before opening the database: %j', async input => {
  const repo = createBusinessReadRepository({ dbConfig: {}, now });
  await expect(repo.query('owner', input)).rejects.toMatchObject({ code: 'AI_SCOPE_INVALID' });
  expect(conn.query).not.toHaveBeenCalled();
});

test('explicit empty scope reads no business data and needs no database', async () => {
  const result = await createBusinessReadRepository({ now }).query('owner', { domains: [] });
  expect(result.datasets).toEqual([]);
  expect(result.choices.cards).toEqual([]);
  expect(conn.query).not.toHaveBeenCalled();
  expect(validateScope({ domains: [] }, now()).domains).toEqual([]);
  await expect(createBusinessReadRepository({ now }).query('owner', scope)).rejects.toMatchObject({ code: 'AI_READ_UNAVAILABLE' });
});

test('DECIMAL stays exact and incomplete foreign-currency totals are clearly marked', async () => {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('AS income') && !sql.includes('GROUP BY')) return [[{ income: '0.0000', expense: '39.9100', count: 2, unpricedCount: '1' }]];
    if (sql.includes('SELECT a.id')) return [[{ id: 'flow-1', cardId: 'card-1', categoryId: 'food-1', date: '2026-11-06', direction: 0,
      amount: '39.9100', currency: 'CNY', amountCNY: '39.9100', category: '交通', remark: '停车费' }]];
    return [[]];
  });
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', scope);
  expect(result.datasets[0].summary).toMatchObject({ income: '0.00', expense: '39.91', incomplete: true });
  expect(result.datasets.find(d => d.datasetId === 'finance-transactions').rows[0]).toMatchObject({ amount: '39.91', amountCNY: '39.91' });
  const financialSql = conn.execute.mock.calls.find(([{ sql }]) => sql.includes('SELECT a.id'))[0].sql;
  expect(financialSql).toContain('ELSE NULL END');
  expect(decimalString('39.9099')).toBe('39.91');
  expect(decimalString('999999999999.9950')).toBe('1000000000000.00');
  expect(decimalString('-0.0050')).toBe('-0.01');
  expect(decimalString('0.0000', 4)).toBe('0.0000');
  expect(() => decimalString('1e5')).toThrow();
});

test('all-unvalued sums and unknown currencies stay null, while incomplete card totals keep their reliability marker', async () => {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('AS income')) return [[{ income: null, expense: null, count: 2, unpricedCount: '2' }]];
    if (sql.includes('AS sourceCurrencies')) return [[{ cardId: 'card-unknown', month: '2026-11', name: '未核实账户', currency: 'CNY',
      amountCNY: null, count: 2, unpricedCount: '2', sourceCurrencies: 'unknown,USD' }]];
    if (sql.includes('SELECT a.id')) return [[{ id: 'unknown-flow', cardId: 'card-unknown', categoryId: 'food', date: '2026-11-06',
      direction: 0, amount: '100.0000', currency: null, amountCNY: null, category: '餐饮', remark: '' }]];
    return [[]];
  });
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['finance', 'card'] });
  expect(result.datasets.find(d => d.datasetId === 'finance-monthly').summary).toMatchObject({ income: null, expense: null, incomplete: true });
  expect(result.datasets.find(d => d.datasetId === 'finance-transactions').rows[0]).toMatchObject({ amount: '100.0000', currency: null, amountCNY: null });
  expect(result.datasets.find(d => d.datasetId === 'card-monthlyConsumption')).toMatchObject({ summary: { incomplete: true },
    rows: [expect.objectContaining({ amountCNY: null, unpricedCount: '2' })] });
});

test('saved timestamps normalize trusted time fields to calendar instants without interpreting phone-like values', async () => {
  const instant='2026-11-07T07:38:13.155Z', epoch=String(Date.parse(instant));
  expect(savedTimestamp(epoch)).toBe(instant);expect(savedTimestamp(instant)).toBe(instant);
  expect(savedTimestamp('2026-11-07 15:38:13.155')).toBe(instant);
  expect(savedTimestamp('2026-11-07T15:38:13.155+08:00')).toBe(instant);
  for(const invalid of [null,'','13800138000','2026-02-30 12:00:00','2026-11-07 25:00:00','not-a-time'])expect(savedTimestamp(invalid)).toBeNull();
  conn.execute.mockImplementation(async ({sql})=>sql.includes('FROM card_base c LEFT JOIN account_balance')?[[
    {cardId:'saved-card',name:'合成账户',type:'debit',balance:'20.00',currency:'CNY',updatedAt:epoch},
    {cardId:'unknown-card',name:'未知账户',type:'debit',balance:null,currency:null,updatedAt:null},
  ]]:[[]]);
  const result=await createBusinessReadRepository({dbConfig:{},now}).query('owner',{...scope,domains:['account']});
  expect(result.datasets[0].rows[0].updatedAt).toBe(instant);expect(result.datasets[0].rows[1].updatedAt).toBeNull();
});

test('display rows stop at 100 and candidates cannot silently truncate', async () => {
  conn.execute.mockImplementation(async ({ sql }) => sql.includes('FROM fixed_asset')
    ? [Array.from({ length: 101 }, (_, i) => ({ id: `asset-${i}`, name: `设备${i}`, buyPrice: '1.00', savedValue: '1.00', status: 'using' }))] : [[]]);
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['fixedAsset'] });
  expect(result.datasets[0].truncated).toBe(true);
  expect(result.datasets[0].rows).toHaveLength(100);
  expect(result.choices.fixedAssets).toHaveLength(100);
  conn.execute.mockResolvedValue([Array.from({ length: 101 }, (_, i) => ({ id: `card-${i}` }))]);
  await expect(createBusinessReadRepository({ dbConfig: {}, now }).query('owner', scope)).rejects.toMatchObject({ code: 'AI_SCOPE_TOO_LARGE' });
});

test('installment JSON projection removes card/flow IDs and does not execute expiration or entry', async () => {
  conn.execute.mockImplementation(async ({ sql }) => sql.includes('FROM bus_recurring') ? [[{ id: 'plan', name: '设备分期', amount: '10.00',
    periods: 12, active: 1, monthRecords: { '2026-11': { status: 'pending', card_id: 'private-card', accountId: 'private-flow' },
      '2026-10': { status: 'entered' } } }]] : [[]]);
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['installment'] });
  expect(result.datasets[0].rows[0]).toMatchObject({ pending: 1, entered: 0 });
  expect(JSON.stringify(result)).not.toMatch(/private-card|private-flow|monthRecords/);
  expect(conn.execute.mock.calls.every(([{ sql }]) => sql.startsWith('SELECT'))).toBe(true);
});

test('read-only failure releases the connection and exposes no SQL/credential details', async () => {
  conn.query.mockRejectedValue(new Error('password=secret; internal SQL'));
  await expect(createBusinessReadRepository({ dbConfig: {}, now }).query('owner', scope)).rejects.toMatchObject({ code: 'AI_READ_FAILED' });
  expect(conn.execute).not.toHaveBeenCalled();
  expect(conn.rollback).toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
});

test('fixed asset trash stays owner-bound and requires explicit restore/trash intent', async () => {
  conn.execute.mockImplementation(async ({ sql }, params) => sql.includes('FROM fixed_asset')
    ? [[{ id: 'asset', name: '电脑', status: 'using', isDeleted: params[1] === 1 ? 1 : 0 }]] : [[]]);
  const repo = createBusinessReadRepository({ dbConfig: {}, now });
  const live = await repo.query('owner', { ...scope, domains: ['fixedAsset'], message: '看看固定资产' });
  expect(live.choices.fixedAssets[0].status).toBe('using');
  const trash = await repo.query('owner', { ...scope, domains: ['fixedAsset'], message: '从回收站恢复电脑' });
  expect(trash.choices.fixedAssets[0].status).toBe('回收站');
  const last = conn.execute.mock.calls.at(-1);
  expect(last[1]).toEqual(['owner', 1]);
  expect(last[0].sql).toContain('is_deleted IN (0, ?)');
  expect(trash.datasets[0].columns).toContainEqual({ key: 'isDeleted', label: '在回收站', type: 'number' });
});

test('card monthly consumption reads owner-bound ledger, never bill amounts, and only narrows a unique explicit alias', async () => {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes("status = '正常'")) return [[{ id: 'life-card', name: '生活卡', type: 'credit' }]];
    if (sql.includes('GROUP_CONCAT')) return [[{ cardId: 'life-card', name: '生活卡', month: '2026-11', currency: 'CNY',
      amountCNY: '39.9100', count: 2, unpricedCount: '1', sourceCurrencies: 'CNY,USD' }]];
    return [[]];
  });
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['card'], message: '生活卡最近消费' });
  expect(result.datasets.find(d => d.datasetId === 'card-monthlyConsumption').rows[0]).toMatchObject({ amountCNY: '39.91', currency: 'CNY', unpricedCount: '1' });
  const [{ sql }, params] = conn.execute.mock.calls.find(([{ sql }]) => sql.includes('GROUP_CONCAT'));
  expect(sql).toContain('FROM account a JOIN card_base');
  expect(sql).not.toContain('card_bill');
  expect(sql).toContain('a.direction = 0');
  expect(sql).toContain("a.category_id <> 'CATEGORY_REPAY'");
  expect(sql).toContain('a.reversed_id IS NULL');
  expect(sql).toContain('c.user_id = a.user_id');
  expect(params).toEqual(['owner', scope.startDate, scope.endDate, 'life-card']);
});

test('card expiration and next configured repayment dates use pure calendar fields including short months', async () => {
  expect(expirationMonth('2028-02')).toBe('2028-02');
  expect(expirationMonth('2028-02-01')).toBe('2028-02');
  expect(expirationMonth('2026-02-30')).toBeNull();
  expect(nextRepaymentDate(31, '2026-02-28')).toBe('2026-02-28');
  expect(nextRepaymentDate(31, '2026-01-31')).toBe('2026-01-31');
  expect(nextRepaymentDate(5, '2026-12-06')).toBe('2027-01-05');
  expect(nextRepaymentDate(0, '2026-11-06')).toBeNull();
  conn.execute.mockImplementation(async ({ sql }) => sql.includes('expire_date AS savedExpiration')
    ? [[{ cardId: 'credit', name: '卡', type: 'credit', repayDay: 5, savedExpiration: '2028-02' },
      { cardId: 'debit', name: '储蓄卡', type: 'debit', repayDay: 5, savedExpiration: '' }]] : [[]]);
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['card'] });
  expect(result.datasets[0].rows[0]).toMatchObject({ expirationMonth: '2028-02', nextRepayDate: '2026-12-05' });
  expect(result.datasets[0].rows[1].nextRepayDate).toBeNull();
  expect(result.datasets[0].userPolicy).toContain('不代表有欠款');
  expect(result.datasets[0].policy).not.toContain('不代表有欠款');
});

test('budget known keyword matching is bounded and parameterized; ambiguity does not silently filter', async () => {
  expect(budgetKeywords('找香港一日游预算')).toEqual(['香港', '一日游']);
  expect(budgetKeywords('香港还是一日游预算？')).toEqual([]);
  expect(budgetKeywords('不找香港预算')).toEqual([]);
  const repo = createBusinessReadRepository({ dbConfig: {}, now });
  await repo.query('owner', { ...scope, domains: ['budget'], message: "找香港一日游预算 '; DROP TABLE account" });
  const [{ sql }, params] = conn.execute.mock.calls.at(-1);
  expect(sql).not.toContain('DROP');
  expect(sql).toContain('title LIKE ? OR route LIKE ? OR budget_details LIKE ?');
  expect(params).toEqual(['owner', scope.startDate, scope.endDate, '%香港%', '%香港%', '%香港%', '%一日游%', '%一日游%', '%一日游%']);
  await repo.query('owner', { ...scope, domains: ['budget'], message: '看看预算' });
  expect(conn.execute.mock.calls.at(-1)[0].sql).not.toContain('LIKE');
});

test('asset saved-balance composition keeps currencies and credit snapshots separate without credit pools', async () => {
  conn.execute.mockImplementation(async ({ sql }) => sql.includes('AS positiveAssets') ? [[{ type: 'debit', currency: 'USD', count: 1,
    positiveAssets: '10.00', creditDebt: '0.00', creditOverflow: '0.00', otherDebt: '0.00', missingSnapshots: 0 }]] : [[]]);
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['asset'] });
  expect(result.datasets.find(d => d.datasetId === 'asset-composition').rows[0]).toMatchObject({ currency: 'USD', positiveAssets: '10.00' });
  const [{ sql }, params] = conn.execute.mock.calls.find(([{ sql }]) => sql.includes('AS positiveAssets'));
  expect(sql).toContain("GROUP BY c.card_type, COALESCE(b.currency, '未登记')");
  expect(sql).toContain("c.card_type = 'credit' AND b.balance < 0");
  expect(sql).not.toContain('card_credit_pool');
  expect(params).toEqual(['owner']);
});

test('same-day asset comparison refuses inferred CNY differences when total tables have no currency evidence', async () => {
  conn.execute.mockImplementation(async ({ sql }) => sql.includes('NULL AS netDifference') ? [[{ date: '2026-11-06',
    manualNetAsset: '100.00', systemNetAsset: '90.00', netDifference: null, currency: 'unverified', reason: '币种不明，不推导' }]] : [[]]);
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['asset'] });
  const comparison = result.datasets.find(d => d.datasetId === 'asset-comparison');
  expect(comparison.rows[0]).toMatchObject({ manualNetAsset: '100.00', systemNetAsset: '90.00', netDifference: null, currency: 'unverified' });
  expect(comparison.summary.currency).toBe('unverified');
  const [{ sql }] = conn.execute.mock.calls.at(-1);
  expect(sql).toContain('s.record_date = r.register_date');
  expect(sql).toContain('newer.user_id = r.user_id');
  expect(sql).not.toContain('total_balance -');
});

// F1: one shared naming rule for every AI account/card surface.
const { cardDisplayName, cardNameSql, cardBankJoin, isAnonymousCardName, dedupeCardNames } = require('../../src/modules/ai/service/cardNames');
test('card display fallback is alias, otherwise bank name plus last4, never a shared placeholder', () => {
  expect(cardDisplayName('工资卡', '招商银行', '7476')).toBe('工资卡');
  expect(cardDisplayName('', '招商银行', '7476')).toBe('招商银行 7476');
  expect(cardDisplayName('  ', '', '7476')).toBe('未命名银行 7476');
  expect(cardDisplayName(null, '农业银行', null)).toBe('农业银行');
  expect(isAnonymousCardName('未命名账户')).toBe(true);
  expect(isAnonymousCardName('未命名卡片')).toBe(true);
  expect(isAnonymousCardName('未命名银行 7476')).toBe(false);
  expect(isAnonymousCardName('招商银行 7476')).toBe(false);
});
test('shared SQL expression builds the display name on the server and never projects the raw tail', () => {
  const sql = cardNameSql(), join = cardBankJoin();
  expect(sql).toContain('TRIM(CONCAT(');
  expect(sql).toContain('bank.name');
  expect(sql).toContain("COALESCE(c.last4_no, '')");
  expect(sql).not.toMatch(/\blast4_no\s+AS\b/i);
  expect(join).toContain("type = 'bank'");
  expect(join).toContain('c.bank_id');
});
test('dedupe is deterministic and shared by both repositories', () => {
  const rows = [{ name: '招商银行 7476' }, { name: '招商银行 7476' }, { name: '农业银行 6838' }, { name: '招商银行 7476' }];
  expect(dedupeCardNames(rows).map(row => row.name)).toEqual(
    ['招商银行 7476', '招商银行 7476（2）', '农业银行 6838', '招商银行 7476（3）']);
});
test('card monthly consumption keeps card type and server-authored subtotals', async () => {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('GROUP BY a.card_id, LEFT')) return [[
      { cardId: 'c1', month: '2026-10', name: '花呗', cardType: 'credit', currency: 'CNY', amountCNY: '200.00', count: 1, unpricedCount: 0, sourceCurrencies: 'CNY' },
      { cardId: 'c2', month: '2026-10', name: '浦发新贵卡', cardType: 'credit', currency: 'CNY', amountCNY: '17.38', count: 1, unpricedCount: 0, sourceCurrencies: 'CNY' },
      { cardId: 'c3', month: '2026-10', name: '现金', cardType: 'virtual_cash', currency: 'CNY', amountCNY: '1.00', count: 1, unpricedCount: 0, sourceCurrencies: 'CNY' },
    ]];
    return [[]];
  });
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner-1',
    { domains: ['card'], startDate: '2026-10-01', endDate: '2026-10-31' });
  const dataset = result.datasets.find(item => item.datasetId === 'card-monthlyConsumption');
  expect(dataset.rows.map(row => row.type)).toEqual(['信用卡', '信用卡', '现金']);
  expect(dataset.summary).toMatchObject({ expense: '218.38', count: 3, incomplete: false });
});

test('card-period ranking aggregates the entire date range in SQL before sorting, rather than selecting the largest card-month', async () => {
  // A spends 60 in each of three months (180 total); B spends 100 in one month.
  // The SQL result has a different winner at card and card-month granularity.
  const periodRows = [
    { cardId: 'card-a', name: '生活卡A', cardType: 'debit', currency: 'CNY', amountCNY: '180.0000', count: 3, unpricedCount: 0, sourceCurrencies: 'CNY' },
    { cardId: 'card-b', name: '生活卡B', cardType: 'debit', currency: 'CNY', amountCNY: '100.0000', count: 1, unpricedCount: 0, sourceCurrencies: 'CNY' },
  ];
  const monthRows = [
    { ...periodRows[1], month: '2026-09' },
    ...['2026-11', '2026-10', '2026-09'].map(month => ({ ...periodRows[0], month, amountCNY: '60.0000', count: 1 })),
  ];
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('AS matchedRowCount')) return [[{ expense: '280.0000', count: 4, unpricedCount: 0,
      matchedRowCount: sql.includes('COUNT(DISTINCT a.card_id, LEFT') ? 4 : 2 }]];
    if (sql.includes('GROUP_CONCAT')) return [sql.includes('GROUP BY a.card_id, LEFT') ? monthRows : periodRows];
    return [[]];
  });
  const input = { datasetId: 'card-monthlyConsumption', domains: ['card'], startDate: '2026-09-01', endDate: '2026-11-06',
    cardTypes: ['debit'], sort: 'amountDesc', message: '最近三个月哪张借记卡支出最高？' };
  const repo = createBusinessReadRepository({ dbConfig: {}, now });
  const monthly = (await repo.query('owner-1', input)).datasets.find(item => item.datasetId === input.datasetId);
  const grouped = (await repo.query('owner-1', { ...input, groupBy: 'card' })).datasets.find(item => item.datasetId === input.datasetId);
  expect(monthly.rows[0]).toMatchObject({ name: '生活卡B', amountCNY: '100.00', month: '2026-09' });
  expect(monthly.cardMonthlyQuery).toMatchObject({ groupBy: 'cardMonth', direction: 'expense', matchedRowCount: 4 });
  expect(grouped.rows[0]).toMatchObject({ name: '生活卡A', amountCNY: '180.00', count: 3 });
  expect(grouped.rows).toHaveLength(2);
  expect(grouped.rows.every(row => !Object.hasOwn(row, 'month'))).toBe(true);
  expect(grouped.columns.some(column => column.key === 'month')).toBe(false);
  expect(grouped.title).toBe('按卡区间消费统计（人民币）');
  expect(grouped.policy).toContain('按查询日期范围逐卡合计，每行一张卡');
  expect(grouped.cardMonthlyQuery).toMatchObject({ groupBy: 'card', direction: 'expense', cardTypes: ['debit'], matchedRowCount: 2, sort: 'amountDesc' });
  expect(grouped.summary).toMatchObject({ expense: '280.00', count: 4, incomplete: false });
  const [{ sql }, params] = conn.execute.mock.calls.filter(([{ sql }]) => sql.includes('GROUP_CONCAT')).at(-1);
  expect(sql).toContain('GROUP BY a.card_id, c.alias, bank.name, c.last4_no, c.card_type ORDER BY amountCNY DESC, a.card_id LIMIT 101');
  expect(sql).not.toContain('LEFT(a.trans_date, 7)');
  expect(sql).toContain('a.user_id = ?');
  expect(sql).toContain('c.user_id = a.user_id');
  expect(sql).toContain('a.direction = 0');
  expect(sql).toContain("a.pay_type <> '转账'");
  expect(sql).toContain("a.category_id <> 'CATEGORY_REPAY'");
  expect(sql).toContain('a.reversed_id IS NULL');
  expect(sql).toContain('c.card_type IN (?)');
  expect(params).toEqual(['owner-1', input.startDate, input.endDate, 'debit']);
  const [{ sql: countSql }] = conn.execute.mock.calls.filter(([{ sql }]) => sql.includes('AS matchedRowCount')).at(-1);
  expect(countSql).toContain('COUNT(DISTINCT a.card_id) AS matchedRowCount');
  expect(countSql).not.toContain('LEFT(a.trans_date, 7)');
});

test('card-period full counts and monetary summary survive truncated ranked rows and retain unknown pricing', async () => {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('AS matchedRowCount')) return [[{ expense: '50000.0000', count: 450, unpricedCount: 1, matchedRowCount: 150 }]];
    if (sql.includes('GROUP_CONCAT')) return [Array.from({ length: 101 }, (_, index) => ({
      cardId: `card-${index}`, name: `合成卡${index}`, cardType: 'debit', currency: 'CNY', amountCNY: `${200 - index}.0000`,
      count: 3, unpricedCount: 0, sourceCurrencies: 'CNY',
    }))];
    return [[]];
  });
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', {
    ...scope, domains: ['card'], datasetId: 'card-monthlyConsumption', groupBy: 'card', cardTypes: ['debit'], sort: 'amountDesc',
  });
  const dataset = result.datasets.find(item => item.datasetId === 'card-monthlyConsumption');
  expect(dataset.rows).toHaveLength(100);
  expect(dataset.truncated).toBe(true);
  expect(dataset.summary).toMatchObject({ expense: '50000.00', count: 450, unpricedCount: 1, incomplete: true, currency: 'CNY' });
  expect(dataset.cardMonthlyQuery).toMatchObject({ matchedRowCount: 150, groupBy: 'card', direction: 'expense' });
  expect(dataset.rows.every(row => !Object.hasOwn(row, 'month'))).toBe(true);
});

test('card-period aggregates retain all-unpriced null totals and exact frozen-rate SQL valuation', async () => {
  conn.execute.mockImplementation(async ({ sql }) => {
    if (sql.includes('AS matchedRowCount')) return [[{ expense: null, count: 2, unpricedCount: 2, matchedRowCount: 1 }]];
    if (sql.includes('GROUP_CONCAT')) return [[{ cardId: 'unknown-card', name: '未定价卡', cardType: 'debit', currency: 'CNY',
      amountCNY: null, count: 2, unpricedCount: 2, sourceCurrencies: 'unknown,USD' }]];
    return [[]];
  });
  const result = await createBusinessReadRepository({ dbConfig: {}, now }).query('owner', {
    ...scope, domains: ['card'], datasetId: 'card-monthlyConsumption', groupBy: 'card', sort: 'amountDesc',
  });
  const dataset = result.datasets.find(item => item.datasetId === 'card-monthlyConsumption');
  expect(dataset.rows[0]).toMatchObject({ amountCNY: null, count: 2, unpricedCount: 2, sourceCurrencies: 'unknown,USD' });
  expect(dataset.summary).toMatchObject({ expense: null, count: 2, unpricedCount: 2, incomplete: true });
  const [{ sql }] = conn.execute.mock.calls.find(([{ sql }]) => sql.includes('GROUP_CONCAT'));
  expect(sql).toContain('ROUND(a.amount * a.exchange_rate / 100, 2)');
  expect(sql).toContain('a.exchange_rate > 0');
  expect(sql).toContain('ELSE NULL END');
});

test.each([
  { datasetId: 'card-monthlyConsumption', groupBy: 'card_id' },
  { datasetId: 'card-monthlyConsumption', groupBy: 'card; DROP TABLE account' },
  { datasetId: 'card-cards', groupBy: 'card' },
])('invalid card grouping is rejected before business reads: %j', async input => {
  await expect(createBusinessReadRepository({ dbConfig: {}, now }).query('owner', { ...scope, domains: ['card'], ...input }))
    .rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID', status: 400 });
  expect(conn.query).not.toHaveBeenCalled();
  expect(conn.execute).not.toHaveBeenCalled();
});

// A list_choices group must decide the read plan: unrelated groups neither
// raise the candidate cap nor push the requested rows out of the LIMIT 101 window.
const executor = handler => ({ query: jest.fn().mockResolvedValue(), beginTransaction: jest.fn().mockResolvedValue(),
  execute: jest.fn(async ({ sql }, params) => [await handler(sql, params)]), rollback: jest.fn().mockResolvedValue() });

test('category candidates succeed despite 101 unrelated normal accounts and never read card_base', async () => {
  const unrelated = Array.from({ length: 101 }, (_, i) => ({ id: `card-${i}`, name: `普通账户${i}`,
    type: 'debit', cardType: 'debit', bankName: '建设银行' }));
  const db = executor(sql => sql.includes('FROM card_base') ? unrelated
    : sql.includes('FROM bus_category') ? [{ id: 'expense-1', name: '餐饮', type: 'expense' }] : []);
  const result = await createBusinessReadRepository({ executor: db, now }).query('owner', {
    ...scope, domains: ['finance'], group: 'categories', direction: 'expense', filter: '支出', limit: 10, candidateOnly: true });
  expect(result.choices.categories).toEqual([{ id: 'expense-1', name: '餐饮', type: 'expense' }]);
  // Candidate-only reads must not enter the finance ledger loop or the card
  // table: every SQL stays inside the category candidate's allowed table set.
  onlyCandidateTables(db.execute.mock.calls, 'categories');
  const [{ sql }, params] = db.execute.mock.calls.find(([{ sql }]) => sql.includes('FROM bus_category'));
  expect(sql).toContain('AND type = ?');
  expect(sql).not.toContain('INSTR');
  expect(params).toEqual(['owner', 'expense']);
});

test('candidate-only reads succeed when unrelated ledger permission is denied or amounts are dirty', async () => {
  const denyLedger = sql => {
    if (tablesRead(sql).includes('account')) {
      const error = new Error('SELECT command denied to user');
      error.code = 'ER_TABLEACCESS_DENIED_ERROR';
      throw error;
    }
  };
  const categories = executor(sql => {
    denyLedger(sql);
    return sql.includes('FROM bus_category') ? [{ id: 'expense-1', name: '餐饮', type: 'expense' }] : [];
  });
  const categoryResult = await createBusinessReadRepository({ executor: categories, now }).query('owner', {
    ...scope, domains: ['finance'], group: 'categories', direction: 'expense', limit: 10, candidateOnly: true });
  expect(categoryResult.choices.categories).toEqual([{ id: 'expense-1', name: '餐饮', type: 'expense' }]);
  const cards = executor(sql => {
    denyLedger(sql);
    return sql.includes('FROM card_base c')
      ? [{ id: 'card-1', name: '工资卡', type: 'debit', cardType: 'debit', bankName: '建设银行' }] : [];
  });
  const cardResult = await createBusinessReadRepository({ executor: cards, now }).query('owner', {
    ...scope, domains: ['finance'], group: 'cards', limit: 10, candidateOnly: true });
  expect(cardResult.choices.cards[0]).toMatchObject({ id: 'card-1', name: '工资卡' });
  onlyCandidateTables(categories.execute.mock.calls, 'categories');
  onlyCandidateTables(cards.execute.mock.calls, 'cards');
});

test('fund and todo candidates stop at their own source table', async () => {
  const funds = executor(sql => {
    if (sql.includes('bus_fund_history')) throw new Error('history ledger must not be read');
    return sql.includes('FROM fund f')
      ? [{ id: 'fund-1', name: '基金A', principal: '0.00', profit: '0.0000', marketValue: '0.00', lastReportDate: '2026-10-01' }] : [];
  });
  const fundResult = await createBusinessReadRepository({ executor: funds, now }).query('owner', {
    ...scope, domains: ['fund'], group: 'funds', limit: 10, candidateOnly: true });
  expect(fundResult.choices.funds).toEqual([{ id: 'fund-1', name: '基金A' }]);
  // FROM and JOIN both count: the holdings aggregate must not reach history either.
  expect(funds.execute.mock.calls.some(([{ sql }]) => sql.includes('bus_fund_history'))).toBe(false);
  expect(fundResult.datasets).toEqual([]);
  onlyCandidateTables(funds.execute.mock.calls, 'funds');
  const todos = executor(sql => sql.includes('FROM todo') ? [] : []);
  const todoResult = await createBusinessReadRepository({ executor: todos, now }).query('owner', {
    ...scope, domains: ['todo'], group: 'todos', limit: 10, candidateOnly: true });
  expect(todoResult.choices.todos).toEqual([]);
  onlyCandidateTables(todos.execute.mock.calls, 'todos');
});

test('card candidates filter by bank, type and name in SQL before the 101-row cap', async () => {
  const others = Array.from({ length: 101 }, (_, i) => ({ id: `card-${i}`, name: `建设银行 ${1000 + i}`,
    type: 'debit', cardType: 'debit', bankName: '建设银行' }));
  const target = { id: 'target', name: '工资卡', type: 'credit', cardType: 'credit', bankName: '工商银行' };
  const db = executor((sql, params) => {
    if (!sql.includes('FROM card_base c')) return [];
    return sql.includes('c.card_type = ?') && sql.includes('bank.name IN (') && sql.includes('INSTR(LOWER(')
      && params.includes('credit') && params.includes('工商银行') && params.includes('中国工商银行')
      && params.includes('工资') ? [target] : others;
  });
  const result = await createBusinessReadRepository({ executor: db, now }).query('owner', {
    ...scope, domains: ['finance'], group: 'cards', bankName: '工行', cardType: 'credit', filter: '工资', limit: 10, candidateOnly: true });
  expect(result.choices.cards).toEqual([target]);
  onlyCandidateTables(db.execute.mock.calls, 'cards');
  const [{ sql }, params] = db.execute.mock.calls.find(([{ sql }]) => sql.includes('FROM card_base c'));
  expect(sql).toContain('AND c.card_type = ?');
  expect(sql).toContain('AND bank.name IN (');
  expect(sql).toContain('INSTR(LOWER(');
  expect(params).toEqual(['owner', 'credit', '工商银行', '工行', '中国工商银行', '工资']);
});

test('more than one hundred target categories still raise the candidate cap error', async () => {
  const categories = Array.from({ length: 101 }, (_, i) => ({ id: `cat-${i}`, name: `分类${i}`, type: 'expense' }));
  const db = executor(sql => sql.includes('FROM bus_category') ? categories : []);
  await expect(createBusinessReadRepository({ executor: db, now }).query('owner', {
    ...scope, domains: ['finance'], group: 'categories', direction: 'expense', candidateOnly: true }))
    .rejects.toMatchObject({ code: 'AI_SCOPE_TOO_LARGE', status: 400 });
  onlyCandidateTables(db.execute.mock.calls, 'categories');
});
