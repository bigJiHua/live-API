jest.mock('../../src/common/config/db', () => ({ execute: () => { throw new Error('DB forbidden in pending-source tests'); } }));
const crypto = require('crypto');
const { buildPendingTransactionContext, carryPendingTransactionSources, pinPendingTransactionSupplement,
  sanitizePendingTransactionContext, TTL_MS, MAX_SUPPLEMENT_SOURCES, MAX_CARRY_SOURCES } = require('../../src/modules/ai/service/pendingTransactions');
const { explicitUniqueAccountSelection, isRejectedAccountSelection } = require('../../src/modules/ai/service/candidateSelection');
const id = () => crypto.randomUUID();
const conversationId = id(), sourceId = id(), date = '2026-11-08';
const now = new Date('2026-11-08T12:54:06Z').getTime();
const original = '今天午餐花了8.50元，农业银行借记卡付的';
const item = { fields: { amount: '8.50', direction: 0, currency: 'CNY', transDate: date, remark: '午餐', payMethod: '银行卡' },
  evidence: { sourceTurn: 0, quote: '8.50' }, missingFields: ['账户'] };
const context = () => buildPendingTransactionContext({ transactions: [item], userTurns: [original], userTurnDates: [date],
  userTurnIds: [sourceId], conversationId, turnId: sourceId, now });
const pin = (value, message, offset = 1000) => pinPendingTransactionSupplement(value,
  { message, sourceDate: date, turnId: id(), conversationId, now: now + offset });

test('an account-type correction survives six later user rounds and overrides the original debit account', () => {
  const pending = pin(context(), '不是借记卡，是信用卡');
  const recent = ['聊天3', '聊天4', '聊天5', '聊天6', '请继续'];
  const carried = carryPendingTransactionSources({ context: pending, conversationId, now: now + 7000,
    userTurns: recent, userTurnDates: Array(recent.length).fill(date), userTurnIds: recent.map(id) });
  expect(carried.userTurns.slice(0, 2)).toEqual([original, '不是借记卡，是信用卡']);
  expect(carried.pendingTransactions.items[0].evidence).toMatchObject({ sourceTurn: 0, quote: '8.50' });
  const cards = [{ id: 'debit', name: '农业银行 1111', bankName: '农业银行', type: 'debit' },
    { id: 'credit', name: '农业银行 2222', bankName: '农业银行', type: 'credit' },
    { id: 'other', name: '其他银行 3333', bankName: '其他银行', type: 'credit' }];
  expect(isRejectedAccountSelection(cards[0], carried.userTurns, cards)).toBe(true);
  expect(explicitUniqueAccountSelection(cards[1], cards, carried.userTurns)).toBe(true);
});

test('supplementation keeps six newest statements without changing original TTL or carrying executable fields', () => {
  let pending = context();
  for (let index = 0; index < 8; index++) pending = pin(pending, `分类补充${index}`, 1000 + index);
  expect(pending.supplementSources).toHaveLength(MAX_SUPPLEMENT_SOURCES);
  expect(pending.supplementSources.map(source => source.text)).toEqual(Array.from({ length: 6 }, (_, index) => `分类补充${index + 2}`));
  expect(pending.supplementSources.map(source => source.order)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(pending.createdAt).toBe(now);
  expect(pending.expiresAt).toBe(now + TTL_MS);
  expect(JSON.stringify(pending)).not.toMatch(/accountId|accountRef|categoryId|categoryRef/);
});

test('rebuilding the same batch merges pinned supplements while a new original source starts a new batch', () => {
  const pending = pin(context(), '不是借记卡，是信用卡');
  const rebuilt = buildPendingTransactionContext({ transactions: [item], userTurns: [original], userTurnDates: [date],
    userTurnIds: [sourceId], previous: pending, conversationId, turnId: id(), now: now + 3000 });
  expect(rebuilt.supplementSources).toEqual(pending.supplementSources);
  expect(rebuilt.sources[0].order).toBe(0);
  expect(rebuilt.expiresAt).toBe(pending.expiresAt);
  const newSource = '今天晚餐花了8.50元';
  const next = buildPendingTransactionContext({ transactions: [item], userTurns: [newSource], userTurnDates: [date],
    userTurnIds: [id()], previous: pending, conversationId, turnId: id(), now: now + 3000 });
  expect(next.supplementSources).toBeUndefined();
});

test('a legacy source gets a stable earlier order when a current supplement is merged and later rebuilt', () => {
  const legacy = context(); delete legacy.sources[0].order;
  const pending = pin(legacy, '不是借记卡，是信用卡');
  const rebuilt = buildPendingTransactionContext({ transactions: [item], userTurns: [original], userTurnDates: [date],
    userTurnIds: [sourceId], previous: pending, conversationId, turnId: id(), now: now + 2000 });
  expect(rebuilt.sources[0].order).toBeLessThan(rebuilt.supplementSources[0].order);
});

test('original sources and supplements still in the recent window are neither duplicated nor reordered', () => {
  const pending = pin(context(), '不是借记卡，是信用卡');
  const supplement = pending.supplementSources[0];
  const userTurns = ['较旧聊天', original, supplement.text, '继续'];
  const result = carryPendingTransactionSources({ context: pending, conversationId, now: now + 2000, userTurns,
    userTurnDates: Array(4).fill(date), userTurnIds: [id(), sourceId, supplement.turnId, id()] });
  expect(result.userTurns).toEqual(userTurns);
  expect(result.pendingTransactions.items[0].evidence.sourceTurn).toBe(1);
});

test('a budget-omitted middle correction stays after the original amount and older account prose', () => {
  let pending = pin(context(), '用借记卡');
  pending = pin(pending, '不是借记卡，是信用卡' + '。'.repeat(900), 2000);
  const [oldAccount, correction] = pending.supplementSources;
  const currentId = id();
  const chronologicalSources = [
    { text: original, sourceDate: date, turnId: sourceId }, oldAccount, correction,
    { text: '请继续', sourceDate: date, turnId: currentId },
  ];
  const result = carryPendingTransactionSources({ context: pending, conversationId, now: now + 3000,
    userTurns: [original, oldAccount.text, '请继续'], userTurnDates: [date, date, date],
    userTurnIds: [sourceId, oldAccount.turnId, currentId], chronologicalSources });
  expect(result.userTurns).toEqual(chronologicalSources.map(source => source.text));
  const amountTurn = result.pendingTransactions.items[0].evidence.sourceTurn;
  expect(result.userTurns[amountTurn]).toBe(original);
  const sourceUtterances = result.userTurns.slice(amountTurn);
  const cards = [{ id: 'debit', name: '农业银行 1111', bankName: '农业银行', type: 'debit' },
    { id: 'credit', name: '农业银行 2222', bankName: '农业银行', type: 'credit' }];
  expect(isRejectedAccountSelection(cards[0], sourceUtterances, cards)).toBe(true);
  expect(explicitUniqueAccountSelection(cards[1], cards, sourceUtterances)).toBe(true);
});

test('the carried protocol remains bounded to sixteen turns and evidence always points to the real amount source', () => {
  let pending = context();
  for (let index = 0; index < 6; index++) pending = pin(pending, `补充说明${index}`, 1000 + index);
  const recent = Array.from({ length: 20 }, (_, index) => `聊天${index}`);
  const result = carryPendingTransactionSources({ context: pending, conversationId, now: now + 3000,
    userTurns: recent, userTurnDates: recent.map(() => date), userTurnIds: recent.map(id) });
  expect(result.userTurns).toHaveLength(MAX_CARRY_SOURCES);
  expect(result.userTurns.at(-1)).toBe('聊天19');
  expect(result.userTurns[result.pendingTransactions.items[0].evidence.sourceTurn]).toBe(original);
  expect(result.userTurns).toContain('补充说明5');
});

test('expired or cleared memory cannot be revived by a newly pinned supplement', () => {
  expect(pinPendingTransactionSupplement(context(), { message: '用信用卡', sourceDate: date, turnId: id(),
    conversationId, now: now + TTL_MS })).toBeNull();
  const cleared = pin(context(), '不记了');
  expect(cleared.status).toBe('cleared');
  expect(pin(cleared, '用信用卡').status).toBe('cleared');
});

test('malformed supplement metadata cannot be accepted as pending source memory', () => {
  const pending = pin(context(), '用信用卡');
  pending.supplementSources[0].order = -1;
  expect(sanitizePendingTransactionContext(pending, { conversationId, now })).toBeNull();
});
