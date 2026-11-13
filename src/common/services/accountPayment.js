// A payment channel may use a linked bank card, while cash and stored balance
// name the funds themselves. Keep those funding identities consistent.
function accountPaymentConflict(accountType, method) {
  if (method == null || method === '') return false;
  if (!['现金', '余额', '微信', '支付宝', '银行卡', '借记卡', '信用卡'].includes(method)) return false;
  if (accountType === 'virtual_cash') return method !== '现金';
  if (accountType === 'virtual_balance') return !['余额', '微信', '支付宝'].includes(method);
  return ['debit', 'credit'].includes(accountType) && ['现金', '余额'].includes(method);
}
module.exports = { accountPaymentConflict };
