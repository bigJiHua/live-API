const { todayShanghai } = require('./validation');
const { AiError } = require('./errors');
const choices = {
  accounts: [{ id: 'mock_balance', name: '模拟余额账户', type: 'virtual_balance' }],
  categories: [{ id: 'mock_food', name: '餐饮', type: 'expense' },
    { id: 'mock_salary', name: '工资', type: 'income' }],
};
function createMockRepository() {
  return {
    choices: async () => structuredClone(choices),
    summary: async (_, range) => ({ ...range, currency: 'CNY', income: '8000.00', expense: '632.00', count: 4,
      categories: [{ direction: 0, category: '餐饮', amount: '632.00', count: 3 },
        { direction: 1, category: '工资', amount: '8000.00', count: 1 }], categoryLimit: 30,
      policy: '模拟固定样例，不代表用户账本；剔除转账、还款和冲正。' }),
    transactions: async (_, range) => ({ ...range, rows: [{ date: range.endDate, direction: 0,
      amount: '32.00', currency: 'CNY', amountCNY: '32.00', category: '餐饮', remark: '模拟午饭' }],
      total: 1, hasMore: false }),
  };
}
async function mockChat(messages, tools, today = todayShanghai()) {
  if (messages[messages.length - 1].role === 'tool') {
    return { role: 'assistant', content: '模拟流程已完成。请查看服务端查询结果或记账草稿；未写入正式账本。' };
  }
  const text = messages.find(message => message.role === 'user').content;
  let call;
  if (tools.some(tool => tool.function.name === 'propose_transaction')) {
    if (/(转账|还款|分期|冲正|删除|修改|退款)/.test(text)) throw new AiError('测试版仅支持普通收支草稿，请使用原有专用页面');
    const numbers = [...text.matchAll(/\d+(?:\.\d{1,4})?/g)];
    if (numbers.length !== 1) throw new AiError('模拟模式请使用包含一个金额的普通记账句子');
    const direction = /(收入|工资|到账)/.test(text) ? 1 : 0;
    const transDate = text.includes('昨天') ? new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10) : today;
    call = { name: 'propose_transaction', arguments: JSON.stringify({ direction, amount: numbers[0][0],
      currency: 'CNY', transDate, categoryId: direction === 1 ? 'mock_salary' : /饭|餐|吃/.test(text) ? 'mock_food' : null,
      accountId: /余额|支付宝|微信/.test(text) ? 'mock_balance' : null,
      payMethod: /支付宝/.test(text) ? '支付宝' : /微信/.test(text) ? '微信' : /余额/.test(text) ? '余额' : null,
      remark: text.slice(0, 255) }) };
  } else {
    call = { name: /流水|明细/.test(text) ? 'query_transactions' : 'query_finance_summary',
      arguments: JSON.stringify({ startDate: `${today.slice(0, 7)}-01`, endDate: today }) };
  }
  return { role: 'assistant', content: null,
    tool_calls: [{ id: 'mock_call_1', type: 'function', function: call }] };
}
module.exports = { createMockRepository, mockChat };
