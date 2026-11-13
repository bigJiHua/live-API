jest.mock('../../src/common/config/db', () => ({ execute: () => { throw new Error('Public DB forbidden'); } }));
const { buildPendingTransactionContext, sanitizePendingTransactionContext, clearPendingTransactionContext,
  carryPendingTransactionSources, isExplicitSelectedAccount, readPendingTransactionTask, summarizePendingTransactionTask,
  pinPendingTransactionSupplement, TTL_MS } = require('../../src/modules/ai/service/pendingTransactions');
const conversationId = '052af9f1-7519-446a-9130-6669c2b685ce';
const turnId = '9fb89be8-4fb7-43b4-a3b7-e57951027bb5';
const now = new Date('2026-11-08T12:54:06Z').getTime();
const original = '今晚买菜花了30.82元，然后买鸭肉花了20.40元，然后超市生活物品花了123.60元，都是用的农业银行卡付的';
function fixture() {
  return buildPendingTransactionContext({ conversationId, turnId, now,
    userTurns: ['晚上好啊', '这个月是几月份', original], userTurnDates: ['2026-11-08', '2026-11-08', '2026-11-08'],
    transactions: [['30.82', '买菜花了30.82元', '买菜'], ['20.40', '买鸭肉花了20.40元', '买鸭肉'],
      ['123.60', '生活物品花了123.60元', '生活物品']].map(([amount, quote, remark]) => ({
      fields: { amount, direction: 0, currency: 'CNY', transDate: '2026-11-08', remark,
        payMethod: '银行卡', accountRef: 'old-reference', categoryId: 'private-category-id' },
      evidence: { sourceTurn: 2, quote }, missingFields: ['账户'] })) });
}
test('three pending transactions preserve amounts and original evidence without executable IDs or refs', () => {
  const context = fixture();
  expect(context.items.map(item => item.fields.amount)).toEqual(['30.82', '20.40', '123.60']);
  expect(context.sources).toEqual([{ text: original, sourceDate: '2026-11-08', order: 0 }]);
  expect(context.items.every(item => item.evidence.sourceTurn === 0)).toBe(true);
  expect(JSON.stringify(context)).not.toMatch(/old-reference|private-category-id|accountRef|categoryId/);
});
test('a mixed complete/incomplete batch retains every member without inventing missing fields', () => {
  const context = fixture();
  context.items[0].missingFields = [];
  const pending = sanitizePendingTransactionContext(context, { conversationId, now });
  expect(pending.items).toHaveLength(3);
  expect(pending.items[0].missingFields).toEqual([]);
  expect(pending.items[1].missingFields).toEqual(['账户']);
  pending.items.forEach(item => { item.missingFields = []; });
  expect(sanitizePendingTransactionContext(pending, { conversationId, now })).toBeNull();
});
test('a tail-only reply carries the original source and three intents within the sixteen-turn protocol', () => {
  const result = carryPendingTransactionSources({ context: fixture(), conversationId, now: now + 1000,
    userTurns: ['早期聊天1', '早期聊天2', '早期聊天3', '早期聊天4', '7476'], userTurnDates: Array(5).fill('2026-11-08') });
  expect(result.userTurns).toEqual([original, '早期聊天1', '早期聊天2', '早期聊天3', '早期聊天4', '7476']);
  expect(result.pendingTransactions.transactionCount).toBe(3);
  expect(result.pendingTransactions.items.every(item => item.evidence.sourceTurn === 0)).toBe(true);
  expect(result.pendingTransactions.items.map(item => item.amount)).toEqual(['30.82', '20.40', '123.60']);
});
test('an original source already in history is not duplicated', () => {
  const result = carryPendingTransactionSources({ context: fixture(), conversationId, now: now + 1000,
    userTurns: ['晚上好啊', original, '7476'], userTurnDates: Array(3).fill('2026-11-08') });
  expect(result.userTurns.filter(text => text === original)).toHaveLength(1);
  expect(result.userTurns.at(-1)).toBe('7476');
});
test('cross-day source keeps its original date anchor', () => {
  const result = carryPendingTransactionSources({ context: fixture(), conversationId, now: now + 1000,
    userTurns: ['7476'], userTurnDates: ['2026-11-09'] });
  expect(result.userTurnDates).toEqual(['2026-11-08', '2026-11-09']);
  expect(result.pendingTransactions.items.every(item => item.transDate === '2026-11-08')).toBe(true);
});
test.each(['amount', 'quote', 'date', 'duplicate', 'foreign', 'special'])('modified %s cannot become trusted pending memory', mode => {
  const context = fixture();
  if (mode === 'amount') context.items[0].fields.amount = '999.99';
  if (mode === 'quote') context.items[0].evidence.quote = '模型改写的金额';
  if (mode === 'date') context.items[0].fields.transDate = '2026-11-07';
  if (mode === 'duplicate') context.items[1] = structuredClone(context.items[0]);
  if (mode === 'foreign') context.sources[0].text += '美元';
  if (mode === 'special') context.sources[0].text += '用于还款';
  expect(sanitizePendingTransactionContext(context, { conversationId, now })).toBeNull();
});
test('expired, future-created and other-conversation memory cannot supplement a new turn', () => {
  expect(sanitizePendingTransactionContext(fixture(), { conversationId, now: now + TTL_MS })).toBeNull();
  expect(sanitizePendingTransactionContext(fixture(), { conversationId, now: now - 1 })).toBeNull();
  expect(sanitizePendingTransactionContext(fixture(), { conversationId: turnId, now })).toBeNull();
});
test('cleared is an explicit tombstone and never carries earlier transaction intent', () => {
  const context = clearPendingTransactionContext({ conversationId, turnId, now });
  expect(context.status).toBe('cleared');
  const carried = carryPendingTransactionSources({ context, conversationId, now, userTurns: ['7476'], userTurnDates: ['2026-11-08'] });
  expect(carried.userTurns).toEqual(['7476']);
  expect(carried.pendingTransactions).toBeNull();
});
test('expired task remains inspectable but never enters automatic continuation', () => {
  const context = fixture(), expiredAt = now + TTL_MS;
  const task = readPendingTransactionTask(context, { conversationId, now: expiredAt });
  expect(task).toMatchObject({ taskId: turnId, revision: 1, status: 'expired', expiresAt: expiredAt });
  expect(task.items.map(item => item.fields.amount)).toEqual(['30.82', '20.40', '123.60']);
  expect(sanitizePendingTransactionContext(task, { conversationId, now: expiredAt })).toBeNull();
  context.items[0].fields.amount = '999.99';
  expect(readPendingTransactionTask(context, { conversationId, now: expiredAt })).toBeNull();
});
test('legacy shorter expiry follows the current TTL and summary omits raw sources and evidence', () => {
  const context = fixture();
  context.expiresAt = now + 15 * 60 * 1000;
  delete context.taskId; delete context.revision;
  const summary = summarizePendingTransactionTask(context, { conversationId, now: now + 60 * 60 * 1000 });
  expect(summary).toMatchObject({ taskId: turnId, revision: 1, status: 'awaiting_input', expiresAt: now + TTL_MS });
  expect(summary.items[0]).toMatchObject({ index: 0, fields: { amount: '30.82', transDate: '2026-11-08' }, missingFields: ['账户'] });
  expect(summary).not.toHaveProperty('sources');
  expect(summary.items[0]).not.toHaveProperty('evidence');
});
test('source supplement increments task revision once and clearing preserves the task identity', () => {
  const context = fixture(), replyId = '11111111-1111-4111-8111-111111111111';
  const supplement = { message: '招商银行，说错了', sourceDate: '2026-11-08', turnId: replyId, conversationId, now: now + 1000 };
  const next = pinPendingTransactionSupplement(context, supplement);
  expect(next).toMatchObject({ taskId: context.taskId, revision: 2, expiresAt: context.expiresAt });
  expect(pinPendingTransactionSupplement(next, supplement).revision).toBe(2);
  const cleared = clearPendingTransactionContext({ conversationId, turnId: replyId, previous: next, now: now + 2000 });
  expect(cleared).toMatchObject({ taskId: context.taskId, revision: 3, status: 'cleared' });
  expect(summarizePendingTransactionTask(cleared, { conversationId, now: now + 2000 })).toBeNull();
});
test('rebuilding the same task preserves identity and changes revision only when pending facts change', () => {
  const first = fixture(), replyId = '11111111-1111-4111-8111-111111111111';
  const rebuild = (previous, items = previous.items) => buildPendingTransactionContext({ conversationId, turnId: replyId,
    now: now + 1000, previous, userTurns: previous.sources.map(source => source.text),
    userTurnDates: previous.sources.map(source => source.sourceDate), transactions: items });
  const same = rebuild(first);
  expect(same).toMatchObject({ taskId: first.taskId, revision: first.revision, expiresAt: first.expiresAt });
  const changed = structuredClone(same.items);
  changed[0].missingFields.push('分类');
  const next = rebuild(same, changed);
  expect(next).toMatchObject({ taskId: first.taskId, revision: first.revision + 1, expiresAt: first.expiresAt });
});
const cards = [{ id: 'ag-credit', name: '农业银行 6838', type: 'credit' },
  { id: 'ag-debit', name: '农业银行 7476', type: 'debit' }, { id: 'ag-other', name: '农业银行 9485', type: 'credit' }];
test.each(['7476', '用7476那张', '尾号7476', '农业银行7476', '农业银行 7476'])('explicit unique account reply accepts %s', text => {
  expect(isExplicitSelectedAccount(cards[1], cards, [text], { allowBareTail: true })).toBe(true);
});
test.each(['金额7476', '花了7476元', '支出7476', '余额7476', '2026年7476', '不用7476', '不是用农业银行7476'])
  ('numbers in financial/date/negative prose never select an account: %s', text => {
    expect(isExplicitSelectedAccount(cards[1], cards, [text], { allowBareTail: true })).toBe(false);
  });
test('bare tail without a pending question and duplicated tail cannot select an account', () => {
  expect(isExplicitSelectedAccount(cards[1], cards, ['7476'])).toBe(false);
  const duplicates = [...cards, { id: 'duplicate', name: '另一银行 7476' }];
  expect(isExplicitSelectedAccount(cards[1], duplicates, ['7476'], { allowBareTail: true })).toBe(false);
  expect(isExplicitSelectedAccount(cards[1], duplicates, ['尾号7476'])).toBe(false);
  expect(isExplicitSelectedAccount(cards[1], duplicates, ['农业银行 7476'])).toBe(true);
});
test('an explicitly bank-labelled account still works inside the original transaction prose', () => {
  expect(isExplicitSelectedAccount(cards[1], cards, ['今晚买菜花了30.82元，用农业银行7476付的'])).toBe(true);
  expect(isExplicitSelectedAccount(cards[1], cards, ['农业银行7476元'])).toBe(false);
});
