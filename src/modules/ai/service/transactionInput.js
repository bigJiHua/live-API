const { todayShanghai } = require('./validation');
const { accountPaymentConflict } = require('../../../common/services/accountPayment');

const PARSER_VERSION = 'transaction-input-v1';
const SPECIAL = /转账|还款|退款|冲正|分期|购汇|结汇|提现|初始化|余额调整|本金调整|证券买卖|正式折旧|精密重算|借款|贷款|\b(?:transfer|repayment|refund|reversal|installment|withdrawal|loans?|borrow(?:ing)?|lending|investment|securities|depreciation)\b/i;
const EXPENSE = /支出|消费|花了|花费|支付|付款|付了|停车(?:费)?|午饭|晚饭|早饭|餐费|买了/;
const INCOME = /收入|收到|收了|收款|到账/;
const BOOK = /记账|记一笔|帮我记|记下|登记(?:收入|支出|消费|交易)|录入(?:收入|支出|消费|交易)/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Width conversion preserves every character position used in evidence.
const numberWidth = value => value.replace(/[０-９．，＋－]/g, char => String.fromCharCode(char.charCodeAt(0)-0xFEE0));
const canonical = value => {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const zero = integer === '0' && !fraction;
  return `${match[1] === '-' && !zero ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`;
};

function normalizeTransactionAmount(value, { scale = 2, signed = false, allowZero = false, maxIntegerDigits = 10 } = {}) {
  if (typeof value !== 'string' || value.length > 80 || !Number.isInteger(scale) || scale < 0 || scale > 4) return null;
  const normalized = canonical(value.trim());
  if (normalized == null || (!signed && normalized.startsWith('-'))) return null;
  const [integer, fraction = ''] = normalized.replace(/^-/, '').split('.');
  if (integer.length > maxIntegerDigits || fraction.length > scale || (!allowZero && integer === '0' && !fraction)) return null;
  return normalized;
}

function entitySpans(message, entities = []) {
  message = numberWidth(message);
  const spans = [];
  // An account label is a string, including all leading zeroes. Only labels
  // introduced as accounts/cards are stripped without a trusted candidate.
  const pattern = /(?:借记卡|信用卡|银行卡|卡尾号|尾号|卡号|账户|账号|卡)\s*[：:]?\s*[「“"]?([A-Za-z\d_-]+)[」”"]?(?=\s|[，,。；;]|借记卡|信用卡|银行卡|账户|支出|收入|消费|支付|买了|花|付|金额|今天|今日|昨天|昨日|前天|明天|后天|$)/g;
  for (const match of message.matchAll(pattern)) spans.push({ index: match.index, end: match.index + match[0].length, label: match[1], text: match[0] });
  const quoted = /(?:账户|账号|借记卡|信用卡|银行卡)\s*[：:]?\s*[「“"]([^」”"]+)[」”"]/g;
  for (const match of message.matchAll(quoted)) spans.push({ index: match.index, end: match.index + match[0].length, label: match[1], text: match[0] });
  for (const entity of entities) {
    const rawName = typeof entity === 'string' ? entity : entity?.name || entity?.alias;
    const name = typeof rawName === 'string' ? numberWidth(rawName) : rawName;
    if (!name || typeof name !== 'string' || name.length > 100) continue;
    for (const match of message.matchAll(new RegExp(escape(name), 'g'))) {
      const numeric = /^\d+$/.test(name);
      if (numeric && !spans.some(span => span.label === name && match.index >= span.index && match.index < span.end)) continue;
      if (['现金','余额','微信','支付宝','银行卡'].includes(name) &&
          !spans.some(span => span.label === name && match.index >= span.index && match.index < span.end) &&
          !/(?:账户|账号|借记卡|信用卡|银行卡)\s*[：:]?\s*$/.test(message.slice(0,match.index)) &&
          !/^(?:账户|账号)/.test(message.slice(match.index+name.length))) continue;
      spans.push({ index: match.index, end: match.index + name.length, label: name, text: name });
    }
  }
  return spans;
}

function maskedInput(message, entities, {ignoreFinancialReferences=true}={}) {
  message = numberWidth(message);
  const chars = message.split('');
  const mask = (index, length) => { for (let i=index; i<index+length; i++) chars[i] = ' '; };
  for (const span of entitySpans(message, entities)) mask(span.index, span.end-span.index);
  for (const expression of [
    /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g,
    /\d{1,2}:\d{2}(?::\d{2})?/g,
    /[+-]?\d+(?:\.\d+)?\s*(?:年|月|日|号|天|期|次|岁|小时|分钟|%|％|个|件|条|笔)/g,
    /(?:手机号?|电话|订单号|流水号|身份证号?)\s*[：:]?\s*[\dXx -]{6,}/g,
    /https?:\/\/[^\s]+|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\bsk-[\w-]+/gi,
  ]) for (const match of message.matchAll(expression)) mask(match.index,match[0].length);
  if (ignoreFinancialReferences) for (const match of message.matchAll(/(?:余额|额度|应还|账单总额|合计)\s*[：:]?\s*[¥￥]?\s*[+-]?\d[\d,.]*(?:\s*(?:千|万))?\s*(?:元|块|人民币|CNY)?/g)) mask(match.index,match[0].length);
  return chars.join('');
}

function statedPaymentMethod(message, accounts) {
  const value = maskedInput(message, accounts);
  const methods = [...value.matchAll(/(?:支付方式\s*[：:]?\s*|(?:用|使用|通过)\s*)?(现金|余额|微信|支付宝|银行卡)(?=\s*支付|\s*付款|\s*消费|\s*支出|\s*收入|\s*[，,。；;]|\s*$)/g)].map(match => match[1]);
  const unique = [...new Set(methods)];
  return unique.length === 1 ? unique[0] : null;
}

function expandToken(number, unit) {
  if (/e/i.test(number) || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(number)) return null;
  const clean = number.replace(/,/g,'');
  const value = canonical(clean);
  if (value == null) return null;
  if (!unit) return value;
  if (!['千','万'].includes(unit)) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  const fraction = match[3] || '';
  const power = unit === '千' ? 3 : 4;
  const digits = match[2] + fraction;
  const scale = fraction.length - power;
  const expanded = scale <= 0 ? digits + '0'.repeat(-scale) : digits.slice(0,-scale) + '.' + digits.slice(-scale);
  return canonical(match[1] + expanded);
}

function extractMoneyTokens(message, { entities = [],ignoreFinancialReferences=true } = {}) {
  if (typeof message !== 'string' || message.length > 1500) return [];
  const value = maskedInput(message, entities,{ignoreFinancialReferences});
  const tokens = [];
  const pattern = /(?<![\dA-Za-z._])[+-]?\d(?:[\d.,]*\d)?(?:[eE][+-]?\d+)?(?:\s*[千万元百十亿兆角分]+(?:元|块)?|\s*(?:元|块|人民币|CNY)|[kKwW])?(?![\dA-Za-z._])/g;
  for (const match of value.matchAll(pattern)) {
    const source = match[0].trim();
    const parts = /^([+-]?\d[\d.,]*(?:[eE][+-]?\d+)?)(?:\s*([千万百十亿兆角分]+)(?:元|块)?|\s*(元|块|人民币|CNY)|([kKwW]))?$/.exec(source);
    const unit = parts?.[2] || parts?.[4] || '';
    const before = value.slice(0,match.index), after = value.slice(match.index+match[0].length);
    const separatedNegative = !/^[+-]/.test(source) && /[-−－负]\s*[¥￥]?\s*$/.test(before);
    const approximate = /(?:大概|大约|约莫|差不多|约)\s*[¥￥]?\s*$/.test(before) || /^\s*(?:左右|上下|余|多|来)(?:元|块|人民币|CNY)?/.test(after);
    const amount = parts && !separatedNegative && !approximate ? expandToken(parts[1],unit) : null;
    tokens.push({ text: message.slice(match.index,match.index+match[0].length).trim(), index:match.index,
      amount, unit, valid: amount != null, reasonCode: amount == null ? 'AI_AMOUNT_AMBIGUOUS' : null });
  }
  return tokens;
}

function dateCandidate(message, today) {
  if (typeof today!=='string' || !/^20\d{2}-\d{2}-\d{2}$/.test(today) ||
    !Number.isFinite(Date.parse(today+'T00:00:00Z')) || new Date(today+'T00:00:00Z').toISOString().slice(0,10)!==today) return {error:'AI_DATE_INVALID'};
  const fullDates = [...message.matchAll(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g)];
  const dates = fullDates.map(match => {
    const pieces = match[0].match(/\d+/g);
    return { text:match[0], date:`${pieces[0]}-${pieces[1].padStart(2,'0')}-${pieces[2].padStart(2,'0')}` };
  });
  if (dates.length > 1) return { error:'AI_DATE_AMBIGUOUS' };
  const partialDates = [...message.matchAll(/\d{1,2}月\d{1,2}[日号]|(?<![\d/-])\d{1,2}[-/]\d{1,2}(?!\d)/g)];
  if (partialDates.some(match => !fullDates.some(full => match.index >= full.index && match.index < full.index + full[0].length)))
    return { error:'AI_DATE_AMBIGUOUS' };
  const relativeDates = [...message.matchAll(/前天|昨天|昨日|今天|今日/g)].map(match => {
    const offset = match[0] === '前天' ? 2 : /昨天|昨日/.test(match[0]) ? 1 : 0;
    return { text:match[0], date:new Date(Date.parse(today+'T00:00:00Z')-offset*86400000).toISOString().slice(0,10) };
  });
  const explicitDates = [...dates,...relativeDates];
  if (new Set(explicitDates.map(item=>item.date)).size > 1) return { error:'AI_DATE_AMBIGUOUS' };
  const date = explicitDates[0]?.date || today;
  const parsed = new Date(date+'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) return { error:'AI_DATE_INVALID' };
  if (date > today || /明天|后天|下周|下个月|计划(?:支出|消费|支付)|预计(?:支出|消费|支付)/.test(message)) return { error:'AI_FUTURE_TRANSACTION' };
  return { date,text:explicitDates[0]?.text || '今天',historical:date<today };
}

function parseTransactionInput(message, { accounts = [], accountId = null, today = todayShanghai() } = {}) {
  const result = { intent:'other',status:'needs_input',reasonCodes:[],fields:{ amount:null,direction:null,currency:'CNY',transDate:null,accountId:null },
    evidence:{ amount:null,account:null,date:null },accountCandidates:[],parserVersion:PARSER_VERSION };
  const stop = (status,code) => ({ ...result,status,reasonCodes:[code] });
  if (typeof message !== 'string' || !message.trim() || message.length > 1500) return stop('block','AI_INPUT_INVALID');
  if (/查看|查询|统计|分析|怎么样|多少|是否|会不会|能不能|如何|怎么/.test(message) && !BOOK.test(message)) return result;
  if (SPECIAL.test(message)) {result.intent='transaction';return stop('block','AI_ACTION_NOT_ALLOWED');}
  const directional = maskedInput(message,accounts).replace(/支付方式\s*[：:]?\s*(?:微信|支付宝|银行卡|现金|余额)/g,'');
  const hasIncome = INCOME.test(directional);
  const strongExpense = /支出|消费|花了|花费|支付|付款|付了|买了/.test(directional);
  const hasExpense = strongExpense || (!hasIncome && EXPENSE.test(directional));
  if (!(BOOK.test(message) || hasExpense || hasIncome)) return result;
  result.intent='transaction';
  if (/[−－]\s*\d/.test(message)) return stop('needs_input','AI_AMOUNT_AMBIGUOUS');
  if (/\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD)\b|美元|港币|港元|欧元|日元|英镑/i.test(message)) return stop('block','AI_CURRENCY_UNSUPPORTED');
  if (/\$/.test(message)) return stop('needs_input','AI_CURRENCY_AMBIGUOUS');
  if (hasExpense && hasIncome) return stop('needs_input','AI_DIRECTION_AMBIGUOUS');
  result.fields.direction = hasExpense ? 0 : hasIncome ? 1 : null;
  const date = dateCandidate(message,today);
  if (date.error) return stop(date.error==='AI_DATE_AMBIGUOUS'?'needs_input':'block',date.error);
  result.fields.transDate=date.date; result.evidence.date=date;
  const tokens = extractMoneyTokens(message,{entities:accounts});
  if (!tokens.length) return stop('needs_input','AI_AMOUNT_MISSING');
  if (tokens.length > 1) return stop('needs_input','AI_MULTIPLE_TRANSACTIONS');
  if (!tokens[0].valid) return stop('needs_input',tokens[0].reasonCode);
  const amount = normalizeTransactionAmount(tokens[0].amount);
  if (amount == null) return stop('block','AI_AMOUNT_INVALID');
  result.fields.amount=amount;
  result.evidence.amount={ ...tokens[0],normalized:amount,parserVersion:PARSER_VERSION };
  const labels = new Set(entitySpans(message,accounts).map(span=>span.label));
  const candidates = accounts.filter(account => labels.has(account.name || account.alias) ||
    [...labels].some(label => label === account.tail || label === account.last4 || label === account.cardTail));
  if (accountId != null) {
    const selected = accounts.find(account => account.id === accountId || account.ref === accountId);
    if (!selected) return stop('block','AI_ACCOUNT_INVALID');
    result.fields.accountId=selected.id || selected.ref;
    result.evidence.account={ source:'user-selection',label:selected.name || selected.alias || null };
  } else if (candidates.length===1) {
    result.fields.accountId=candidates[0].id || candidates[0].ref;
    result.evidence.account={ source:'explicit-unique-label',label:candidates[0].name || candidates[0].alias };
  } else {
    result.accountCandidates=candidates.map(account=>({id:account.id || account.ref,name:account.name || account.alias,type:account.type || account.cardType}));
  }
  if (result.fields.direction == null) return stop('needs_input','AI_DIRECTION_MISSING');
  if (!result.fields.accountId) return stop('needs_input',candidates.length>1?'AI_ACCOUNT_AMBIGUOUS':'AI_ACCOUNT_MISSING');
  const selectedAccount = accounts.find(account => (account.id || account.ref) === result.fields.accountId);
  const method = statedPaymentMethod(message, accounts);
  if (method) result.fields.payMethod = method;
  if (accountPaymentConflict(selectedAccount?.type || selectedAccount?.cardType, method))
    return stop('needs_input','ACCOUNT_PAYMENT_CONFLICT');
  return { ...result,status:'pass',reasonCodes:[] };
}

// 追加165：同方向多笔拆分——单笔解析器在「多个金额」处返回 AI_MULTIPLE_TRANSACTIONS，
// 本函数在该分叉上把每个有效金额拆成独立一笔（共享方向/日期/账户解析，全部沿用单笔同一套规则）。
// 边界：最多 3 笔；方向混合、多个日期、特殊账务、外币一律沿用单笔的拦截码（回落原 UX）。
function parseTransactionInputs(message, { accounts = [], accountId = null, today = todayShanghai() } = {}) {
  const fail = (status, code) => ({ status, reasonCode: code, entries: null });
  if (typeof message !== 'string' || !message.trim() || message.length > 1500) return fail('block', 'AI_INPUT_INVALID');
  if (SPECIAL.test(message)) return fail('block', 'AI_ACTION_NOT_ALLOWED');
  if (/[−－]\s*\d/.test(message)) return fail('needs_input', 'AI_AMOUNT_AMBIGUOUS');
  if (/\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD)\b|美元|港币|港元|欧元|日元|英镑/i.test(message)) return fail('block', 'AI_CURRENCY_UNSUPPORTED');
  if (/\$/.test(message)) return fail('needs_input', 'AI_CURRENCY_AMBIGUOUS');
  const masked = maskedInput(message, accounts).replace(/支付方式\s*[：:]?\s*(?:微信|支付宝|银行卡|现金|余额)/g, '');
  const hasIncome = INCOME.test(masked);
  const strongExpense = /支出|消费|花了|花费|支付|付款|付了|买了/.test(masked);
  const hasExpense = strongExpense || (!hasIncome && EXPENSE.test(masked));
  if (!hasExpense && !hasIncome) return fail('needs_input', 'AI_DIRECTION_MISSING');
  if (hasExpense && hasIncome) return fail('needs_input', 'AI_DIRECTION_AMBIGUOUS');
  const direction = hasExpense ? 0 : 1;
  const date = dateCandidate(message, today);
  if (date.error) return fail(date.error === 'AI_DATE_AMBIGUOUS' ? 'needs_input' : 'block', date.error);
  const tokens = extractMoneyTokens(message, { entities: accounts });
  if (tokens.length > 1 && /合计|总计|总共|共计|一共|小计|总额/.test(message))
    return fail('needs_input', 'AI_MULTIPLE_TRANSACTIONS');
  // An uncertain item remains part of the user's batch. Do not silently
  // generate only its clear neighbours or lose the original item count.
  if (tokens.some(token => !token.valid)) return fail('needs_input', 'AI_AMOUNT_AMBIGUOUS');
  if (tokens.length === 0) return fail('needs_input', 'AI_AMOUNT_MISSING');
  if (tokens.length === 1) return fail('needs_input', 'AI_MULTIPLE_TRANSACTIONS'); // 单笔回落原路径
  if (tokens.length > 3) return fail('needs_input', 'AI_MULTIPLE_TRANSACTIONS');   // 超上限回落，请分开发送
  // 账户解析与单笔完全一致（全局标签命中唯一才填，多命中留空反问）
  const labels = new Set(entitySpans(message, accounts).map(span => span.label));
  const candidates = accounts.filter(account => labels.has(account.name || account.alias) ||
    [...labels].some(label => label === account.tail || label === account.last4 || label === account.cardTail));
  let resolvedAccountId = null;
  if (accountId != null) {
    const selected = accounts.find(account => account.id === accountId || account.ref === accountId);
    if (!selected) return fail('block', 'AI_ACCOUNT_INVALID');
    resolvedAccountId = selected.id || selected.ref;
  } else if (candidates.length === 1) {
    resolvedAccountId = candidates[0].id || candidates[0].ref;
  }
  const selectedAccount = accounts.find(account => (account.id || account.ref) === resolvedAccountId);
  const method = statedPaymentMethod(message, accounts);
  if (accountPaymentConflict(selectedAccount?.type || selectedAccount?.cardType, method))
    return fail('needs_input', 'ACCOUNT_PAYMENT_CONFLICT');
  const entries = tokens.map(token => {
    const amount = normalizeTransactionAmount(token.amount);
    return { amount, direction, currency: 'CNY', transDate: date.date, accountId: resolvedAccountId };
  });
  if (entries.some(entry => entry.amount == null)) return fail('needs_input', 'AI_AMOUNT_INVALID');
  if (!resolvedAccountId && candidates.length > 1) return fail('needs_input', 'AI_ACCOUNT_AMBIGUOUS');
  if (!resolvedAccountId) return fail('needs_input', 'AI_ACCOUNT_MISSING');
  return { status: 'pass', reasonCode: null, entries, direction, transDate: date.date, accountId: resolvedAccountId };
}

module.exports = { PARSER_VERSION, normalizeNumberWidth: numberWidth, normalizeTransactionAmount, extractMoneyTokens, parseTransactionInput, parseTransactionInputs,
  transactionEntitySpans:entitySpans, statedPaymentMethod,
  containsSpecialFinancialIntent:value=>typeof value==='string'&&SPECIAL.test(value),parseTransactionDate:dateCandidate };
