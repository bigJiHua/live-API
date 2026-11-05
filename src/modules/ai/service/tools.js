const { validateTool } = require('./validation');
const { AiError } = require('./errors');
const date = { type: 'string', description: 'YYYY-MM-DD，按Asia/Shanghai解析，不能晚于今天' };
const range = { startDate: date, endDate: date };
function tool(name, description, properties, required) {
  return { type: 'function', function: { name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
const definitions = Object.freeze({
  query_finance_summary: tool('query_finance_summary', '只读查询本人最多93天的收支及分类汇总，人民币口径，剔除转账/还款/冲正。', range, Object.keys(range)),
  query_transactions: tool('query_transactions', '只读查询本人相关流水，最多20条；分页结果不能用来推断全量总额。',
    { ...range, categoryId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 },
      offset: { type: 'integer', minimum: 0, maximum: 100 } }, Object.keys(range)),
  list_record_choices: tool('list_record_choices', '只读取得本人的账户别名和收支分类候选，用于匹配；不得猜测候选ID。', {}, []),
  propose_transaction: tool('propose_transaction', '仅生成一笔普通人民币收支草稿，不入账；不支持转账/还款/分期/冲正/退款。不明确的ID或支付方式传null。', {
    direction: { type: 'integer', enum: [0, 1], description: '0支出，1收入' },
    amount: { type: 'string', description: '用户明确给出的正数金额，最多4位小数，不能猜测' },
    currency: { type: 'string', enum: ['CNY'] }, transDate: date,
    categoryId: { type: ['string', 'null'] }, accountId: { type: ['string', 'null'] },
    payMethod: { type: ['string', 'null'], enum: ['现金', '余额', '支付宝', '微信', '银行卡', null] },
    remark: { type: 'string' },
  }, ['direction', 'amount', 'currency', 'transDate', 'categoryId', 'accountId', 'payMethod', 'remark']),
});
function getTools(scene) {
  if (scene === 'chat') return Object.values(definitions);
  return (scene === 'draft' ? ['list_record_choices', 'propose_transaction']
    : ['query_finance_summary', 'query_transactions']).map(name => definitions[name]);
}
async function executeTool({ scene, userId, repository, today }, name, input) {
  if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
  if (!getTools(scene).some(entry => entry.function.name === name)) throw new AiError('当前场景不允许此工具', 403, 'AI_TOOL_DENIED');
  const args = validateTool(name, input, today);
  if (name === 'query_finance_summary') return repository.summary(userId, args);
  if (name === 'query_transactions') return repository.transactions(userId, args);
  if (name === 'list_record_choices') return repository.choices(userId);
  // Proposal only. No dependency on writable account/card models.
  const choices = await repository.choices(userId);
  const category = args.categoryId === null ? null : choices.categories.find(item => item.id === args.categoryId);
  const account = args.accountId === null ? null : choices.accounts.find(item => item.id === args.accountId);
  if (args.categoryId !== null && (!category || category.type !== (args.direction === 0 ? 'expense' : 'income'))) {
    throw new AiError('草稿分类不存在或不符合收支方向');
  }
  if (args.accountId !== null && !account) throw new AiError('草稿账户不属于当前用户或已停用');
  if (args.direction === 1 && account?.type === 'credit') throw new AiError('信用卡不支持收入草稿');
  const missingFields = [];
  if (!category) missingFields.push('分类');
  if (!account) missingFields.push('账户');
  if (args.payMethod === null) missingFields.push('支付方式');
  return { ...args, categoryName: category?.name || null, accountName: account?.name || null,
    missingFields, choices, needsReview: true, formalWriteEnabled: false };
}
module.exports = { getTools, executeTool };
