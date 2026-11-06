const { executeTool } = require('../../src/modules/ai/service/tools');
const proposal = { direction: 0, amount: '12', currency: 'CNY', transDate: '2026-11-06',
  categoryId: 'food', accountId: 'one', payMethod: '银行卡', remark: '' };
const context = accounts => ({ scene: 'chat', userId: 'owner', today: '2026-11-06', origin: 'model',
  repository: { choices: async () => ({ categories: [{ id: 'food', name: '餐饮', type: 'expense' }], accounts }) } });

test('a model cannot choose an unnamed account', async () => {
  const result = await executeTool(context([{ id: 'one', name: '未命名账户', type: 'debit' }]), 'propose_transaction', proposal);
  expect(result.accountId).toBeNull();
  expect(result.missingFields).toContain('账户');
});
test('same-name accounts require a human choice even when the model returns a valid owned ID', async () => {
  const result = await executeTool(context([{ id: 'one', name: '银行', type: 'debit' }, { id: 'two', name: '银行', type: 'debit' }]), 'propose_transaction', proposal);
  expect(result.accountId).toBeNull();
});
test('an explicit unique account in the message cannot be silently replaced', async () => {
  const ctx = context([{ id: 'one', name: '主账户', type: 'debit' }, { id: 'two', name: '备用账户', type: 'debit' }]);
  ctx.message = '账户「备用账户」支出12元';
  const result = await executeTool(ctx, 'propose_transaction', proposal);
  expect(result.accountId).toBeNull();
});
test('a human-selected ID remains valid for unnamed accounts', async () => {
  const ctx = context([{ id: 'one', name: '未命名账户', type: 'debit' }]);
  ctx.origin = 'manual';
  expect((await executeTool(ctx, 'propose_transaction', proposal)).accountId).toBe('one');
});
test('a unique matching name can generate a pending proposal', async () => {
  const ctx = context([{ id: 'one', name: '主账户', type: 'debit' }]);
  ctx.message = '账户「主账户」支出12元';
  expect((await executeTool(ctx, 'propose_transaction', proposal)).accountId).toBe('one');
});

test.each(['转账', '提现', '购汇', '结汇', '还款', '信用卡还款', '分期', '冲正', '退款', '证券买卖',
  'installment', '信用卡分期', '初始化余额'])(
  'the ordinary proposal tool cannot accept the special category %s', async name => {
    const ctx = context([{ id: 'one', name: '主账户', type: 'debit' }]);
    ctx.repository.choices = async () => ({ accounts: [{ id: 'one', name: '主账户', type: 'debit' }],
      categories: [{ id: 'food', name, type: 'expense' }] });
    await expect(executeTool(ctx, 'propose_transaction', proposal)).rejects.toThrow();
  }
);

test.each(['CATEGORY_REPAY', 'installment'])('the actual proposal tool rejects a renamed reserved category ID %s', async id => {
  const ctx = context([{ id: 'one', name: '主账户', type: 'debit' }]);
  ctx.repository.choices = async () => ({ accounts: [{ id: 'one', name: '主账户', type: 'debit' }],
    categories: [{ id, name: '自定义餐饮', type: 'expense' }] });
  await expect(executeTool(ctx, 'propose_transaction', { ...proposal, categoryId: id })).rejects.toThrow();
});

test.each(['', ' \t ', null, 123])('the actual proposal tool rejects an invalid stored category name %p', async name => {
  const ctx = context([{ id: 'one', name: '主账户', type: 'debit' }]);
  ctx.repository.choices = async () => ({ accounts: [{ id: 'one', name: '主账户', type: 'debit' }],
    categories: [{ id: 'food', name, type: 'expense' }] });
  await expect(executeTool(ctx, 'propose_transaction', proposal)).rejects.toThrow();
});

test.each([
  ['投资收益', 'income', 1], ['住房', 'expense', 0],
  ['银行手续费', 'expense', 0], ['购汇手续费', 'expense', 0], ['自定义买菜', 'expense', 0],
])('the actual proposal tool preserves ordinary category %s', async (name, type, direction) => {
  const ctx = context([{ id: 'one', name: '主账户', type: 'debit' }]);
  ctx.repository.choices = async () => ({ accounts: [{ id: 'one', name: '主账户', type: 'debit' }],
    categories: [{ id: 'food', name, type }] });
  await expect(executeTool(ctx, 'propose_transaction', { ...proposal, direction })).resolves.toMatchObject({
    categoryId: 'food', categoryName: name, accountId: 'one', missingFields: [],
  });
});
