jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const { fixture, final, calls, now, id } = require('../fixtures/aiV3MemoryFixture');
const { buildPendingTransactionContext } = require('../../src/modules/ai/service/pendingTransactions');
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const date = '2026-11-08';
const memoryStore = { list: jest.fn(async () => ({ files: [], count: 0, warnings: [] })) };
function omittedEvidence(_, messages) {
  const tool = JSON.parse(messages.findLast(message => message.role === 'tool').content);
  return final({ answer: '请核对这笔草稿。', proposal: { kind: 'transaction.create', fields: {
    direction: 0, amount: '8.50', currency: 'CNY', transDate: date, payMethod: '银行卡', remark: '午餐',
    accountRef: tool.choices.cards.find(item => item.name === '农业银行 7476').ref,
    categoryRef: tool.choices.categories[0].ref } } });
}
const setup = () => fixture([calls('list_choices', { domain: 'finance' }), omittedEvidence], { memoryStore });
function addHistory(f, content, turnId = id()) {
  f.history.push({ role: 'user', content, sourceDate: date, turnId },
    { role: 'assistant', content: '已查看。', turnId });
  return turnId;
}
afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});
test('an independent current purchase recovers omitted evidence even with ten earlier purchases of the same amount', async () => {
  const f = setup();
  for (let index = 0; index < 10; index++) addHistory(f, `之前午餐花了8.50元，第${index}次`);
  const current = '今天午餐花了8.50元，农业银行借记卡支付';
  const result = await f.send(current);
  expect(result.draft).toMatchObject({ amount: '8.50', accountId: 'fixture-ag-debit', transDate: date });
  expect(f.legacy.prepareTransactionProposal.mock.calls[0][2].message).toBe(current);
});
test('two identical amounts in the current utterance remain ambiguous and cannot silently become one draft', async () => {
  const f = setup();
  await expect(f.send('今天午餐8.50元，晚餐8.50元，都用农业银行借记卡支付'))
    .rejects.toMatchObject({ code: 'AI_AMOUNT_NOT_EXPLICIT' });
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});
test('a pending transaction recovers only its pinned source rather than a later unrelated equal-price purchase', async () => {
  const f = setup(), original = '今天午餐花了8.50元', originalId = addHistory(f, original);
  addHistory(f, '以前也买过8.50元的零食');
  f.state.pendingContext = buildPendingTransactionContext({ conversationId: f.conversationId, turnId: originalId, now,
    userTurns: [original], userTurnDates: [date], userTurnIds: [originalId], transactions: [{
      fields: { direction: 0, amount: '8.50', currency: 'CNY', transDate: date, remark: '午餐' },
      evidence: { sourceTurn: 0, quote: '8.50' }, missingFields: ['账户', '支付方式'] }] });
  const result = await f.send('农业银行借记卡付的');
  expect(result.draft).toMatchObject({ amount: '8.50', accountId: 'fixture-ag-debit', transDate: date });
  expect(f.state.pendingContext.status).toBe('cleared');
});
