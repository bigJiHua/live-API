const { isSupportedDraftCategory } = require('../../src/modules/ai/service/draftPolicy');

const ordinary = { id: 'category-1', name: '餐饮', type: 'expense' };
const specialNames = ['转账', '提现', '购汇', '结汇', '还款', '信用卡还款',
  '分期', '冲正', '退款', '证券买卖', 'installment', '信用卡分期', '初始化余额'];

describe('ordinary AI draft category policy', () => {
  test.each(['CATEGORY_REPAY', 'installment'])('renaming reserved ID %s cannot turn it into an ordinary category', id => {
    expect(isSupportedDraftCategory({ ...ordinary, id, name: '自定义餐饮' })).toBe(false);
  });

  test.each(specialNames)('the exact special category name %s remains blocked after trimming', name => {
    expect(isSupportedDraftCategory({ ...ordinary, name })).toBe(false);
    expect(isSupportedDraftCategory({ ...ordinary, name: ` \t${name} \n` })).toBe(false);
  });

  test.each([null, undefined, false, 0, '餐饮', []])('a category must be a valid object: %p', value => {
    expect(isSupportedDraftCategory(value)).toBe(false);
  });

  test.each(['', ' \t\n ', null, undefined, 123, {}, []])('a category name must be a nonempty string: %p', name => {
    expect(isSupportedDraftCategory({ ...ordinary, name })).toBe(false);
  });

  test.each(['', '   ', null, undefined, 123, {}, 'path/id', 'x'.repeat(65)])('a category ID must match the tool ID contract: %p', id => {
    expect(isSupportedDraftCategory({ ...ordinary, id })).toBe(false);
  });

  test.each(['bank', 'income ', 'Expense', '', null, undefined, 0])('only income and expense category types are accepted: %p', type => {
    expect(isSupportedDraftCategory({ ...ordinary, type })).toBe(false);
  });

  test.each([
    ['投资收益', 'income'], ['住房', 'expense'], ['银行手续费', 'expense'],
    ['购汇手续费', 'expense'], ['结汇手续费', 'expense'], ['信用卡年费', 'expense'],
    ['分期手续费', 'expense'], ['自定义买菜', 'expense'], ['自定义稿费', 'income'],
  ])('ordinary custom category %s is preserved without substring or remark filtering', (name, type) => {
    expect(isSupportedDraftCategory({ ...ordinary, name, type, remark: '不应按备注中的转账、分期、投资关键词屏蔽' })).toBe(true);
    expect(isSupportedDraftCategory({ ...ordinary, name: ` ${name} `, type })).toBe(true);
  });

  test.each(['a_b-c9', 'x'.repeat(64)])('valid string ID %s remains accepted', id => {
    expect(isSupportedDraftCategory({ ...ordinary, id })).toBe(true);
  });
});
