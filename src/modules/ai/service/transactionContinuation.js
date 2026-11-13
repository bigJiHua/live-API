const { AiError } = require('./errors');
const { containsSpecialFinancialIntent, extractMoneyTokens, normalizeTransactionAmount,
  transactionEntitySpans, statedPaymentMethod, normalizeNumberWidth } = require('./transactionInput');
const fail = (message = '这句只能补充本笔支付方式、资金账户或分类；修改金额或日期请在原卡片核对', code = 'AI_CONTINUATION_INPUT_INVALID') => {
  throw new AiError(message, 400, code);
};
function assertContinuable(candidate, conversationId, now = Date.now()) {
  if (!candidate || candidate.status !== 'pending' || candidate.draftId || Number(candidate.expiresAt) <= Number(now))
    fail('这份候选已结束或过期，请读取原卡片', 'AI_CANDIDATE_ENDED');
  if (!conversationId || candidate.conversationId !== conversationId)
    fail('候选不属于本次对话', 'AI_CANDIDATE_CONVERSATION_MISMATCH');
  if (candidate.source !== 'user-readonly' || candidate.eligible !== true || candidate.fields?.currency !== 'CNY' ||
      ![0, 1].includes(candidate.fields.direction) || !normalizeTransactionAmount(candidate.fields.amount) ||
      containsSpecialFinancialIntent(candidate.originalText || ''))
    fail('本候选不能通过聊天补充，请在原卡片核对来源', 'AI_CANDIDATE_SOURCE_FORBIDDEN');
  const date = new Date(candidate.fields.transDate + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== candidate.fields.transDate ||
      candidate.fields.transDate > new Date(Number(now)+8*3600000).toISOString().slice(0,10))
    fail('原候选日期尚未核实，请在卡片补齐', 'AI_CANDIDATE_SOURCE_FORBIDDEN');
}
function supplementFields(candidate, message, choices = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 300) fail();
  const accounts = choices.accounts || [], categories = (choices.categories || []).filter(row =>
    row.type === (candidate.fields.direction === 0 ? 'expense' : 'income'));
  // No old narrative is concatenated. A new transaction, query, negation,
  // amount, direction or date cannot turn into a supplement to this source.
  if (containsSpecialFinancialIntent(message) || /不要|不用|无需|不能|禁止|取消|不记|别|查看|查询|看看|统计|分析|多少|是否|如何|怎么|买了|花了|消费|支出|收入|收款|到账|收到|记账|另[一笔]|新[一笔]|昨天|今天|明天|前天|后天|金额|日期|美元|港币|欧元|日元|英镑|\b(?:USD|HKD|EUR|JPY|GBP)\b|[$€£]|不[是用]/i.test(message)) fail();
  if (extractMoneyTokens(message, { entities: [...accounts, ...categories] }).length) fail();
  const spans = transactionEntitySpans(message, accounts), labels = new Set(spans.map(span => span.label));
  const matchedAccounts = accounts.filter(row => labels.has(normalizeNumberWidth(row.name || row.alias || '')) ||
    [...labels].some(label => [row.tail,row.last4,row.cardTail].some(value=>typeof value==='string'&&label===normalizeNumberWidth(value))));
  if (matchedAccounts.length > 1) fail('账户有多个匹配，请在候选卡明确选择', 'AI_ACCOUNT_AMBIGUOUS');
  const categorySpans = [];
  for (const row of categories) {
    if (!row.name || typeof row.name !== 'string') continue;
    const index = message.indexOf(row.name);
    if (index >= 0 && !spans.some(span=>index>=span.index&&index<span.end))
      categorySpans.push({ row, index, end: index + row.name.length });
  }
  if (categorySpans.length > 1) fail('分类有多个匹配，请在候选卡明确选择', 'AI_CATEGORY_AMBIGUOUS');
  let paymentText=message;
  for(const span of [...spans,...categorySpans].sort((a,b)=>b.index-a.index))paymentText=paymentText.slice(0,span.index)+' '.repeat(span.end-span.index)+paymentText.slice(span.end);
  if(/20\d{2}|\d+[年月日号]/.test(normalizeNumberWidth(paymentText)))fail();
  const methods = [...new Set(paymentText.match(/银行卡|支付宝|微信|现金|余额/g) || [])];
  const method = statedPaymentMethod(message, accounts) || (methods.length===1?methods[0]:null);
  if (methods.length > 1) fail('支付方式有多个匹配，请在卡片明确选择');
  const fields = { ...candidate.fields };
  if (matchedAccounts.length === 1) fields.accountId = matchedAccounts[0].id;
  if (categorySpans.length === 1) fields.categoryId = categorySpans[0].row.id;
  if (method) fields.payMethod = method;
  // After removing recognized values, accept only a small supplement grammar.
  // Merchant prose, instructions and another action never qualify merely by
  // containing an account name or a payment keyword.
  let residual = message;
  const mask = [...spans, ...categorySpans].sort((a, b) => b.index - a.index);
  for (const span of mask) residual = residual.slice(0, span.index) + ' '.repeat(span.end - span.index) + residual.slice(span.end);
  residual = residual.replace(/银行卡|支付宝|微信|现金|余额/g, '')
    .replace(/支付方式|付款方式|资金账户|扣款账户|账户|账号|分类|类别|归类|支付|付款|付的|付|用了|使用|选择|选|改为|改成|设为|填为|用|从|通过|是|的|了|我|这个|这张|这笔|请|按|算|为|到/g, '')
    .replace(/[\s，,。.!！：:；;「」“”"'、]/g, '');
  if (residual || (!method && !matchedAccounts.length && !categorySpans.length)) fail();
  return fields;
}
function isSourceLessSupplement(message) {
  try {supplementFields({fields:{direction:0}},message,{});return true;}catch(_){return false;}
}
module.exports = { assertContinuable, supplementFields, isSourceLessSupplement };
