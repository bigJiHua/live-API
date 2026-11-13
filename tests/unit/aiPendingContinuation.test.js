jest.mock('../../src/common/config/db', () => ({ execute: () => { throw new Error('Public DB forbidden'); } }));
const { buildPendingTransactionContext, carryPendingTransactionSources, pendingBatchCoverage,
  isPendingTransactionCancellation, isExplicitSelectedAccount } = require('../../src/modules/ai/service/pendingTransactions');

const conversationId = '052af9f1-7519-446a-9130-6669c2b685ce';
const turnId = '9fb89be8-4fb7-43b4-a3b7-e57951027bb5';
const sourceId = '5ccbc40e-1f3d-4446-81b2-0661b98c7dbe';
const currentId = 'd8c72de4-bc5c-428d-9e9c-a47d98b835d0';
const now = new Date('2026-11-08T12:54:06Z').getTime();
const date = '2026-11-08';
const original = '午餐花8.50元，买菜花20.40元，日用品花123.60元';
const transactions = [['8.50', '午餐花8.50元'], ['20.40', '买菜花20.40元'], ['123.60', '日用品花123.60元']]
  .map(([amount, quote]) => ({ fields: { amount, direction: 0, currency: 'CNY', transDate: date,
    remark: quote, payMethod: '银行卡' }, evidence: { sourceTurn: 1, quote }, missingFields: ['账户'] }));
function pending() {
  return buildPendingTransactionContext({ transactions, userTurns: ['农业银行 7476', original],
    userTurnDates: [date, date], userTurnIds: [turnId, sourceId], conversationId, turnId, now });
}
function carried() {
  return carryPendingTransactionSources({ context: pending(), conversationId, now: now + 1000,
    userTurns: ['农业银行 7476', original, '餐饮'], userTurnDates: [date, date, date],
    userTurnIds: [turnId, sourceId, currentId] });
}

test('pending sources in history keep their chronological positions, excluding older account evidence', () => {
  const result = carried();
  expect(result.userTurns).toEqual(['农业银行 7476', original, '餐饮']);
  expect(result.userTurnIds).toEqual([turnId, sourceId, currentId]);
  expect(result.pendingTransactions.items.every(item => item.evidence.sourceTurn === 1)).toBe(true);
  const cards = [{ id: 'selected', name: '农业银行 7476', type: 'debit' },
    { id: 'other', name: '农业银行 6838', type: 'debit' }];
  const amountSource = result.pendingTransactions.items[0].evidence.sourceTurn;
  expect(isExplicitSelectedAccount(cards[0], cards, result.userTurns.slice(amountSource),
    { allowBareTail: true })).toBe(false);
});

test('a source outside the window is pinned without reordering the remaining history', () => {
  const result = carryPendingTransactionSources({ context: pending(), conversationId, now: now + 1000,
    userTurns: ['后续1', '后续2', '后续3', '后续4', '7476'], userTurnDates: Array(5).fill(date) });
  expect(result.userTurns).toEqual([original, '后续1', '后续2', '后续3', '后续4', '7476']);
  expect(result.userTurnIds[0]).toBe(sourceId);
  expect(result.pendingTransactions.items.every(item => item.evidence.sourceTurn === 0)).toBe(true);
});

test('two identical messages on the same day remain distinct when their trusted turn IDs differ', () => {
  const result = carryPendingTransactionSources({ context: pending(), conversationId, now: now + 1000,
    userTurns: [original], userTurnDates: [date], userTurnIds: [currentId] });
  expect(result.userTurns).toEqual([original, original]);
  expect(result.userTurnIds).toEqual([sourceId, currentId]);
  expect(result.pendingTransactions.items.every(item => item.evidence.sourceTurn === 0)).toBe(true);
});

test('a separate date-source remains chronological and keeps its remapped evidence index', () => {
  const dated = buildPendingTransactionContext({ conversationId, turnId, now,
    userTurns: ['午餐花8.50元', '农业银行 7476', '昨天买的'],
    userTurnDates: [date, date, date], userTurnIds: [sourceId, turnId, currentId],
    transactions: [{ ...transactions[0], fields: { ...transactions[0].fields, transDate: '2026-11-07' },
      evidence: { sourceTurn: 0, quote: '午餐花8.50元', dateSourceTurn: 2, dateQuote: '昨天买的' } }] });
  const result = carryPendingTransactionSources({ context: dated, conversationId, now: now + 1000,
    userTurns: ['午餐花8.50元', '农业银行 7476', '昨天买的', '餐饮'], userTurnDates: Array(4).fill(date),
    userTurnIds: [sourceId, turnId, currentId, conversationId] });
  expect(result.userTurns).toEqual(['午餐花8.50元', '农业银行 7476', '昨天买的', '餐饮']);
  expect(result.pendingTransactions.items[0].evidence).toMatchObject({ sourceTurn: 0, dateSourceTurn: 2 });
});

test('one completed member cannot declare a three-transaction continuation complete', () => {
  const batch = carried().pendingTransactions;
  expect(pendingBatchCoverage(batch, [batch.items[0]])).toEqual({ expectedCount: 3, providedCount: 1,
    matchedCount: 1, missingCount: 2, duplicateCount: 0, unexpectedCount: 0, complete: false });
});

test('all original members can complete in a different provider order and scalar amount spelling', () => {
  const batch = carried().pendingTransactions;
  const items = [...batch.items].reverse().map(item => ({ fields: { ...item, amount: item.amount.replace(/0$/, '') },
    evidence: { ...item.evidence, quote: original } }));
  expect(pendingBatchCoverage(batch, items)).toMatchObject({ expectedCount: 3, matchedCount: 3, complete: true });
});

test.each(['duplicate', 'amount', 'source', 'quote', 'direction', 'currency'])
  ('a %s claim cannot clear the original pending batch', mode => {
    const batch = carried().pendingTransactions;
    const items = structuredClone(batch.items);
    if (mode === 'duplicate') items[2] = structuredClone(items[0]);
    if (mode === 'amount') items[0].amount = '99.00';
    if (mode === 'source') items[0].evidence.sourceTurn = 0;
    if (mode === 'quote') items[0].evidence.quote = '午餐';
    if (mode === 'direction') items[0].direction = 1;
    if (mode === 'currency') items[0].currency = 'USD';
    expect(pendingBatchCoverage(batch, items).complete).toBe(false);
  });

test('a broad equal-amount quote cannot merge two distinct transaction claims', () => {
  const batch = { status: 'awaiting_input', items: ['午餐8.5元', '晚餐8.5元'].map(quote => ({
    amount: '8.50', direction: 0, currency: 'CNY', evidence: { sourceTurn: 0, quote } })) };
  expect(pendingBatchCoverage(batch, [{ ...batch.items[0], evidence: { sourceTurn: 0, quote: '午餐8.5元，晚餐8.5元' } }]))
    .toMatchObject({ matchedCount: 0, missingCount: 2, unexpectedCount: 1, complete: false });
});

test('whole-source evidence recovered initially can continue through genuine per-transaction quotes', () => {
  const batch = carried().pendingTransactions;
  const recovered = { ...batch, items: batch.items.map(item => ({ ...item,
    evidence: { ...item.evidence, quote: original } })) };
  expect(pendingBatchCoverage(recovered, batch.items)).toMatchObject({ matchedCount: 3, missingCount: 0, complete: true });
  const narrow = batch.items.map(item => ({ ...item, evidence: { ...item.evidence, quote: item.amount } }));
  expect(pendingBatchCoverage(recovered, narrow).complete).toBe(true);
});

test('narrowing a quote cannot erase the distinction between two same-source equal-amount members', () => {
  const batch = { status: 'awaiting_input', items: ['午餐8.5元', '晚餐8.5元'].map(quote => ({
    amount: '8.50', direction: 0, currency: 'CNY', evidence: { sourceTurn: 0, quote } })) };
  expect(pendingBatchCoverage(batch, batch.items).complete).toBe(true);
  const ambiguous = batch.items.map(item => ({ ...item, evidence: { ...item.evidence, quote: '8.5' } }));
  expect(pendingBatchCoverage(batch, ambiguous)).toMatchObject({ matchedCount: 0, missingCount: 2,
    unexpectedCount: 2, complete: false });
});

test.each(['取消', '算了', '不用了。', '先不记了', '取消这三笔交易', '不要记这笔消费', '这笔记账取消'])
  ('a pending accounting cancellation is recognized: %s', message => {
    expect(isPendingTransactionCancellation(message)).toBe(true);
  });

test.each(['取消提醒', '取消这笔提醒', '不要取消记账', '不用取消这些交易', '农业银行7476', '看6月支出', '重新记一笔'])
  ('an unrelated task or negated cancellation leaves pending accounting intact: %s', message => {
    expect(isPendingTransactionCancellation(message)).toBe(false);
  });
