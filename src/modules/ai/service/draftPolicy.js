// These categories use separate financial workflows and cannot become ordinary AI records.
const specialNames = new Set(['转账', '提现', '购汇', '结汇', '还款', '信用卡还款',
  '分期', '冲正', '退款', '证券买卖', 'installment', '信用卡分期', '初始化余额']);
const specialIds = new Set(['category_repay', 'installment']);
function isSupportedDraftCategory(category) {
  return !!category && typeof category.id === 'string' && /^[\w-]{1,64}$/.test(category.id) &&
    !specialIds.has(category.id.toLowerCase()) && ['income', 'expense'].includes(category.type) &&
    typeof category.name === 'string' && category.name.trim().length > 0 &&
    !specialNames.has(category.name.trim().toLowerCase());
}
module.exports = { isSupportedDraftCategory };
