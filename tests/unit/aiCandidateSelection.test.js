jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const { explicitUniqueAccountSelection, accountSelectionUtterances, isRejectedAccountSelection,
  statedCardTypes } = require('../../src/modules/ai/service/candidateSelection');
const { isExplicitSelectedAccount } = require('../../src/modules/ai/service/pendingTransactions');
const { validateTool, selectSnapshot } = require('../../src/modules/ai/service/v3Tools');
const { createBusinessReadRepository } = require('../../src/modules/ai/service/businessRead');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const scope = { domains: ['finance'], startDate: '2026-11-08', endDate: '2026-11-08' };
const asOf = '2026-11-08T12:54:06Z';
const cards = [{ id: 'ag-debit', name: '主刷卡', bankName: '农业银行', type: 'debit', cardType: 'debit', tail: '7476' },
  { id: 'ag-credit', name: '农行万事达', bankName: '农业银行', type: 'credit', cardType: 'credit', tail: '6838' },
  { id: 'other-debit', name: '另外一张', bankName: '兴业银行', type: 'debit', cardType: 'debit', tail: '9716' }];
const rawChoices = () => ({ scope, datasets: [], choices: { cards, categories: [
  { id: 'food', name: '买菜', type: 'expense' }, { id: 'transport', name: '交通', type: 'expense' },
  { id: 'salary', name: '工资', type: 'income' }] }, asOf });
test.each(['农业银行借记卡', '用农行储蓄卡付的', '中国农业银行借记卡'])('bank and type uniquely identify the owner account: %s', message => {
  expect(explicitUniqueAccountSelection(cards[0], cards, [message])).toBe(true);
});
test.each(['农业银行卡', '用银行卡付的', '不是用农业银行借记卡', '农业银行信用卡', '农业银行借记卡或兴业银行借记卡'])
  ('bank alone, conflicting type/bank and negation never select an account: %s', message => {
    expect(explicitUniqueAccountSelection(cards[0], cards, [message])).toBe(false);
  });
test('multiple owner accounts of the same bank/type remain ambiguous', () => {
  expect(explicitUniqueAccountSelection(cards[0], [...cards, { ...cards[0], id: 'another' }], ['农业银行借记卡'])).toBe(false);
});

test.each(['不是借记卡，是信用卡', '用农业银行信用卡，不是借记卡', '是农业银行信用卡不是借记卡'])
  ('a later credit correction shadows the earlier debit selection: %s', message => {
    const sources = ['今天买菜15元，用农业银行借记卡', message];
    expect(isRejectedAccountSelection(cards[0], sources, cards)).toBe(true);
    expect(explicitUniqueAccountSelection(cards[0], cards, sources)).toBe(false);
    expect(isRejectedAccountSelection(cards[1], sources, cards)).toBe(false);
    expect(explicitUniqueAccountSelection(cards[1], cards, sources)).toBe(true);
    expect(statedCardTypes(message)).toEqual(['credit']);
  });

test('a later debit correction shadows an earlier named credit account', () => {
  const sources = ['买菜15元，农行万事达付的', '不是信用卡，是借记卡'];
  expect(isRejectedAccountSelection(cards[1], sources, cards)).toBe(true);
  expect(explicitUniqueAccountSelection(cards[0], cards, sources)).toBe(true);
  expect(accountSelectionUtterances(sources, cards)).toEqual(['是借记卡']);
});

test.each(['不要用农业银行借记卡，用兴业银行借记卡', '用兴业银行', '用兴业银行借记卡，不是农业银行借记卡'])
  ('a later bank replacement shadows the original account: %s', message => {
    const sources = ['买菜15元，农业银行借记卡', message];
    expect(isRejectedAccountSelection(cards[0], sources, cards)).toBe(true);
    expect(explicitUniqueAccountSelection(cards[2], cards, sources)).toBe(true);
  });

test('a category-only clarification preserves earlier account wording', () => {
  const sources = ['买菜15元，农业银行借记卡', '分类不是交通，是买菜'];
  expect(accountSelectionUtterances(sources, cards)).toEqual(['农业银行借记卡']);
  expect(explicitUniqueAccountSelection(cards[0], cards, sources)).toBe(true);
});

test.each(['别用刚才那张', '不要用农业银行借记卡'])('cancelling the account cannot reach a single-card fallback: %s', message => {
  expect(isRejectedAccountSelection(cards[0], ['农业银行借记卡', message], [cards[0]])).toBe(true);
  expect(explicitUniqueAccountSelection(cards[0], [cards[0]], ['农业银行借记卡', message])).toBe(false);
});

test('rejecting the previous card still applies when the replacement bank is unchanged', () => {
  const sources = ['农业银行借记卡', '别用刚才那张，用农业银行'];
  expect(isRejectedAccountSelection(cards[0], sources, cards)).toBe(true);
  expect(explicitUniqueAccountSelection(cards[0], cards, sources)).toBe(false);
});

test('an account cancellation ends inheritance of its old card type', () => {
  expect(explicitUniqueAccountSelection(cards[0], cards, ['农业银行借记卡', '别用刚才那张', '用农业银行'])).toBe(false);
});

test('a generic later card type cannot revive a cancelled single card through the service fallback', () => {
  const sources = ['农业银行借记卡', '不要用农业银行借记卡', '用借记卡'];
  expect(isRejectedAccountSelection(cards[0], sources, [cards[0]])).toBe(true);
  expect(isRejectedAccountSelection(cards[0], [...sources, '分类买菜', '借记卡'], [cards[0]])).toBe(true);
  expect(isRejectedAccountSelection(cards[0], [...sources, '用农业银行借记卡'], [cards[0]])).toBe(false);
});

test.each(['用主刷卡或农行万事达', '用农业银行借记卡或兴业银行借记卡', '用信用卡或借记卡', '尾号7476或尾号6838'])
  ('multiple positive account alternatives never permit the old name guard: %s', message => {
    expect(isRejectedAccountSelection(cards[0], ['主刷卡', message], cards)).toBe(true);
  });

test('a negated old tail yields an original positive replacement phrase', () => {
  const sources = ['银行卡尾号7476', '不是尾号7476，是尾号6838'];
  const scoped = accountSelectionUtterances(sources, cards);
  expect(scoped).toEqual(['是尾号6838']);
  expect(sources[1].includes(scoped[0])).toBe(true);
  expect(isRejectedAccountSelection(cards[0], sources, cards)).toBe(true);
  expect(isRejectedAccountSelection(cards[1], sources, cards)).toBe(false);
  expect(isExplicitSelectedAccount(cards[1], cards, scoped)).toBe(true);
});

test('a bare tail replacement is explicit only in an existing pending transaction', () => {
  const sources = ['农业银行借记卡', '不是7476，是6838'];
  const scoped = accountSelectionUtterances(sources, cards);
  expect(isExplicitSelectedAccount(cards[1], cards, scoped)).toBe(false);
  expect(isExplicitSelectedAccount(cards[1], cards, scoped, { allowBareTail: true })).toBe(true);
  expect(accountSelectionUtterances(['主刷卡', '这笔金额是6838元'], cards)).toEqual(['主刷卡']);
});

test('legacy full bank/tail candidate labels remain explicit without structured bank metadata', () => {
  const legacy = [{ id: 'old-ag', name: '农业银行 7476', type: 'debit' }, { id: 'old-icbc', name: '工商银行 6838', type: 'debit' }];
  const sources = ['买菜15元，农业银行卡付的', '都是农业银行 7476 那张借记卡付的'];
  expect(isRejectedAccountSelection(legacy[0], sources, legacy)).toBe(false);
  expect(isExplicitSelectedAccount(legacy[0], legacy, accountSelectionUtterances(sources, legacy))).toBe(true);
  expect(isRejectedAccountSelection({ ...legacy[0], bankName: '工商银行' }, sources,
    [{ ...legacy[0], bankName: '工商银行' }, legacy[1]])).toBe(true);
});
test('bank/type filters use structured fields despite an unrelated alias, with complete coverage', () => {
  const args = validateTool('list_choices', { domain: 'finance', group: 'cards', bankName: '农行', cardType: 'debit' }, '2026-11-08');
  const selected = selectSnapshot('list_choices', args, rawChoices());
  expect(selected.choices.cards).toEqual([cards[0]]);
  expect(selected.choiceCoverage.cards).toEqual({ total: 1, returned: 1, truncated: false });
});
test.each([{ direction: 'expense' }, { filter: '支出' }])('expense category filtering preserves 买菜 and 交通: %j', input => {
  const args = validateTool('list_choices', { domain: 'finance', group: 'categories', ...input }, '2026-11-08');
  const selected = selectSnapshot('list_choices', args, rawChoices());
  expect(selected.choices.categories.map(row => row.name)).toEqual(['买菜', '交通']);
  expect(selected.choiceCoverage.categories.total).toBe(2);
});
test('filter remains literal rather than guessing bank identity from an alias', () => {
  const args = validateTool('list_choices', { domain: 'finance', group: 'cards', filter: '农业银行卡' }, '2026-11-08');
  expect(selectSnapshot('list_choices', args, rawChoices()).choices.cards).toEqual([]);
});
test('credit/debit counts exclude virtual accounts and publish the full denominator and shares', () => {
  const args = validateTool('query_data', { datasetId: 'card-counts', cardTypes: ['credit', 'debit'] }, '2026-11-08');
  args.queryId = 'q_111111111111111111111111';
  const raw = { asOf, datasets: [{ datasetId: 'card-counts', domain: 'card', title: '本人卡片数量',
    columns: [{ key: 'type', label: '类型', type: 'text' }, { key: 'count', label: '数量', type: 'number' }],
    rows: [{ type: 'credit', count: 59 }, { type: 'debit', count: 20 }, { type: 'virtual_cash', count: 1 }, { type: 'virtual_balance', count: 1 }],
    summary: {}, asOf, policy: '本人卡片数量', truncated: false }] };
  const selected = selectSnapshot('query_data', args, raw).datasets[0];
  expect(selected.rows.map(row => [row.type, row.count, row.sharePct])).toEqual([['信用卡', 59, '74.7'], ['借记卡', 20, '25.3']]);
  expect(selected.summary).toMatchObject({ count: 79, totalCount: 79, ratio: '2.95', approximateRatio: 3,
    ratioNumeratorType: '信用卡', ratioDenominatorType: '借记卡' });
  expect(selected.queryMeta).toMatchObject({ matchedRowCount: 2, returnedRowCount: 2, sourceRecordCount: 79,
    rowsComplete: true, summaryComplete: true });
});
test.each([{ datasetId: 'finance-monthly', cardTypes: ['credit'] }, { datasetId: 'card-counts', cardTypes: ['sql'] }])
  ('unsupported cardTypes cannot enter a query: %j', args => expect(() => validateTool('query_data', args, '2026-11-08')).toThrow());
test('card consumption filters and amount ordering happen before the SQL limit, while full counts remain published', async () => {
  const calls = [], monthly = [{ cardId: 'largest', month: '2026-11', name: '月初大额', cardType: 'credit', amountCNY: '9000.00', count: 3, unpricedCount: 0 }];
  const conn = { query: jest.fn(), beginTransaction: jest.fn(), rollback: jest.fn(), execute: jest.fn(async ({ sql }, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(DISTINCT a.card_id')) return [[{ expense: '12000.00', count: 600, unpricedCount: 0, matchedRowCount: 200 }]];
    if (sql.includes('GROUP BY a.card_id')) return [monthly];
    return [[]];
  }) };
  const args = validateTool('query_data', { datasetId: 'card-monthlyConsumption', startDate: '2026-11-01', endDate: '2026-11-08',
    cardTypes: ['credit'], sort: 'amountDesc', limit: 1 }, '2026-11-08');
  args.queryId = 'q_222222222222222222222222';
  const raw = await createBusinessReadRepository({ executor: conn, now: () => new Date(asOf) }).query('owner', { ...args, ...args.scope });
  const query = calls.find(call => call.sql.includes('GROUP BY a.card_id'));
  expect(query.sql).toMatch(/c\.card_type IN \(\?\)/);
  expect(query.sql).toMatch(/ORDER BY amountCNY DESC, month DESC, a\.card_id LIMIT 101/);
  expect(query.params).toEqual(['owner', '2026-11-01', '2026-11-08', 'credit']);
  const selected = selectSnapshot('query_data', args, raw).datasets[0];
  expect(selected.rows[0].amountCNY).toBe('9000.00');
  expect(selected.summary.expense).toBe('12000.00');
  expect(selected.queryMeta).toMatchObject({ matchedRowCount: 200, returnedRowCount: 1, sourceRecordCount: 600,
    rowsComplete: false, summaryComplete: true, rankingComplete: true });
});
test('preview keeps structured candidate facts and new derived fields without exposing identifiers or full tails', async () => {
  const records = new Map();
  const executor = { execute: jest.fn(async (sql, params) => {
    if (sql.startsWith('INSERT')) {
      const [id, user_id, digest, payload, created_at, expires_at] = params;
      records.set(id, { id, user_id, digest, payload, created_at, expires_at, approved_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT')) {
      const row = records.get(params[0]); return [[...(row && row.user_id === params[1] ? [row] : [])]];
    }
    return [{ affectedRows: 1 }];
  }) };
  const store = createPreviewStore({ executor, now: () => new Date(asOf) });
  const snapshot = rawChoices();
  snapshot.choices.cards.push({ id: 'unsafe-card', name: '银行', type: 'debit', cardType: 'debit', bankName: '农业银行', tail: '1234567890123456' });
  snapshot.datasets = [{ datasetId: 'finance-monthly', domain: 'finance', title: '收支', columns: [
    { key: 'net', label: '净收支', type: 'money' }, { key: 'changeAmt', label: '变化金额', type: 'money' },
    { key: 'changePct', label: '变化(%)', type: 'decimal' }], rows: [{ net: '-1873.37', changeAmt: '12.34', changePct: '2.5' }],
    summary: { income: '3911.24', expense: '5784.61', net: '-1873.37', deficit: '1873.37', totalCount: 79, sharePct: '74.7' }, policy: '本人收支', asOf }];
  const result = await store.prepare('owner', { scope, snapshot, message: '看一下本月收支', provider: 'configured', connectionId: 'read-only' });
  expect(result.datasets[0].summary).toMatchObject({ net: '-1873.37', deficit: '1873.37', totalCount: 79, sharePct: '74.7' });
  expect(result.datasets[0].rows[0]).toEqual({ net: '-1873.37', changeAmt: '12.34', changePct: '2.5' });
  expect(result.choices.cards[0]).toMatchObject({ name: '主刷卡', bankName: '农业银行', cardType: 'debit', tail: '7476' });
  expect(JSON.stringify(result.choices)).not.toMatch(/ag-debit|unsafe-card|1234567890123456/);
});
test('card subtotal arithmetic preserves exact cents beyond floating point precision', () => {
  const args = validateTool('query_data', { datasetId: 'card-monthlyConsumption', cardTypes: ['credit'], sort: 'amountDesc' }, '2026-11-08');
  const selected = selectSnapshot('query_data', args, { asOf, datasets: [{ datasetId: 'card-monthlyConsumption', domain: 'card',
    columns: [{ key: 'type', label: '类型', type: 'text' }, { key: 'amountCNY', label: '消费', type: 'money' }],
    rows: [{ type: '信用卡', amountCNY: '90071992547409.91', unpricedCount: 0 }, { type: '信用卡', amountCNY: '0.01', unpricedCount: 0 },
      { type: '现金', amountCNY: '5.00', unpricedCount: 0 }], summary: { expense: '90071992547414.92', currency: 'CNY' },
    aggregates: { expense: { column: 'amountCNY', kind: 'money' } }, truncated: false, policy: '', asOf }] }).datasets[0];
  expect(selected.summary.expense).toBe('90071992547409.92');
  expect(selected.rows).toHaveLength(2);
});
