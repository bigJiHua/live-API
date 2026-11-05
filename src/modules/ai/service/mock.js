const { todayShanghai } = require('./validation');
const { AiError } = require('./errors');
const choices = {
  accounts: [{ id: 'mock_balance', name: '模拟余额账户', type: 'virtual_balance' },
    { id: 'mock_cash', name: '模拟现金账户', type: 'virtual_cash' }],
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
async function mockChat(messages, tools, today = todayShanghai(), recentDraft) {
  if (messages[messages.length - 1].role === 'tool') {
    const data = JSON.parse(messages[messages.length - 1].content);
    return { role: 'assistant', content: data.needsReview
      ? '我把这笔收支整理好了。你可以直接在下面的草稿卡片里修改，再确认核对。'
      : '这是本次查询的收支情况。下方的数据卡片保留了查询范围和明细，方便你核对。' };
  }
  const text = messages.filter(message => message.role === 'user').at(-1).content;
  const combined = tools.length > 2;
  if (combined && /^(你好|嗨|hi|hello)[！!。\s]*$/i.test(text)) {
    return { role: 'assistant', content: '你好，我是你的财务助手。可以帮你查收支，也可以把一句话整理成记账草稿。你想先聊哪笔账？' };
  }
  if (combined && recentDraft && /这笔|刚才|草稿/.test(text) && !/\d/.test(text)) {
    return { role: 'assistant', content: `刚才这份草稿的金额是${recentDraft.amount}元，分类是${recentDraft.categoryName || '待选择'}。${recentDraft.status === 'discarded' ? '这份草稿已取消。' : recentDraft.status === 'reviewed' ? '这份草稿已核对，仍未入账。' : '你可以在原卡片上修改或完成核对。'}` };
  }
  let call;
  if (tools.some(tool => tool.function.name === 'propose_transaction') &&
      (!combined || /记账|记一笔|花了|付了|午饭|工资到账/.test(text))) {
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
