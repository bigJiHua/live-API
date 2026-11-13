const { AiError } = require('./errors');

// This is a bounded consistency check on final model wording, not an intent
// router or a general proof that arbitrary natural-language answers are true.
// Facts must come from server-created artifacts, never from model fields.
// 追加170：散落规则收敛为声明式规则表（纯结构重构：正则/注释逐字随迁，零行为变化，
// 导出契约冻结）。组织层次 = 词素 → 规则表 → fail-closed 守卫 → 机制函数 → 主循环。

// ---- 词素 LEXICON：全部 pattern 模板插值的唯一正则文本来源（原三处分散常量归组）----
const DONE = '(?:已(?!经?有)(?:经)?|现已(?!有)|成功)';
const DRAFT = '(?:草稿|提案)';
const MAKE = '(?:生成|创建|整理|准备|拟好|做好|制作|形成)';
const GAP = '[^，,。!！?？;；\\n]';
// "入账记录" and "还款历史" name read-only data. The exclusion is
// attached to that noun occurrence, not to the entire sentence: a later
// "并完成入账" must still be checked as a separate completed action.
const DATA_NOUN = '(?!\\s*(?:的\\s*)?(?:回执|登记记录|记录|数据|历史|明细|情况|状态|信息|方式|草稿|提案))';
// Ledger wording includes the concrete bypass found during the 2026-11-11
// audit. This remains a bounded wording check; operationOutcome is the source
// of truth for this turn's formal action status, not this vocabulary.
const ACTION = `(?:入账${DATA_NOUN}|记账${DATA_NOUN}|(?:记入|写入|写进)(?:账本|账簿)|入库${DATA_NOUN}|删除|修改|更新)`;
const MONEY_ACTION = `(?:付款|支付|还款|退款|转账)${DATA_NOUN}`;
const SUBJECT = '(?:我(?:们)?|本次(?:操作)?|这次(?:操作)?|本轮(?:操作)?|刚才(?:这笔)?|这笔|本笔|当前(?:这笔|这个)?|这个待办|该待办)';
const BRIDGE = '(?:\\s|说|声称|宣称|表示|视为|认为|认定|把|当成|本次|这次|这笔|我|我们|已经|已|真正|实际|成功|完成|能|的|还|就|是|现在)*';

// ---- 声明规则表 CLAIM_RULES：表序 = 原数组序（先 draft 4 后 execution 8），加载期构造一次 ----
const CLAIM_RULES = Object.freeze([
  { pattern: new RegExp(`${DONE}${GAP}{0,18}${MAKE}${GAP}{0,14}${DRAFT}`, 'g'), kind: 'draft', requiresComplete: true },
  { pattern: new RegExp(`${DRAFT}${GAP}{0,10}${DONE}${GAP}{0,10}(?:${MAKE}|就绪|备妥|完成)`, 'g'), kind: 'draft', requiresComplete: true },
  { pattern: new RegExp(`${MAKE}(?:好(?:了)?|完成|了)${GAP}{0,10}${DRAFT}`, 'g'), kind: 'draft', requiresComplete: true },
  { pattern: new RegExp(`${DRAFT}${GAP}{0,8}${MAKE}(?:好(?:了)?|完成|了)`, 'g'), kind: 'draft', requiresComplete: true },
  { pattern: new RegExp(`${SUBJECT}${GAP}{0,8}${DONE}${GAP}{0,16}${ACTION}`, 'g'), kind: 'execution', requiresComplete: false },
  { pattern: new RegExp(`${DONE}(?:为你|帮你|替你|把这笔|将这笔|把这个|将这个)${GAP}{0,18}${ACTION}`, 'g'), kind: 'execution', requiresComplete: false },
  { pattern: new RegExp(`^\\s*(?:也|并且|并|同时)?${DONE}${GAP}{0,7}${ACTION}`, 'g'), kind: 'execution', requiresComplete: false },
  { pattern: new RegExp(`^\\s*${ACTION}(?:成功|完成|已完成)`, 'g'), kind: 'execution', requiresComplete: false },
  { pattern: new RegExp(`(?:我(?:们)?|本次操作|这次操作|本轮操作)${GAP}{0,8}${DONE}${GAP}{0,16}${MONEY_ACTION}`, 'g'), kind: 'execution', requiresComplete: false,
    note: "A user's existing payment is not proof that the assistant executed it. Money actions require an explicit assistant/agent subject in the answer." },
  { pattern: new RegExp(`${DONE}(?:为你|帮你|替你|代你)${GAP}{0,18}${MONEY_ACTION}`, 'g'), kind: 'execution', requiresComplete: false },
  { pattern: /(?:I|We)\s+(?:(?:have|had)\s+)?(?:(?:and|also)\s+)?(?:successfully\s+)?(?:updated|modified|deleted)\s+(?:the\s+|your\s+)?(?:ledger|account\s+balance|transaction|todo|reminder)\b/gi, kind: 'execution', requiresComplete: false },
  { pattern: /(?:I|We)\s+(?:(?:have|had)\s+)?(?:(?:and|also)\s+)?(?:successfully\s+)?(?:paid|transferred|refunded|repaid|posted|booked)\b/gi, kind: 'execution', requiresComplete: false },
]);

// 主循环 pattern 清单：从规则表按 kind 过滤派生（加载期一次，遍历序与原数组逐元素一致）。
const draftPatterns = CLAIM_RULES.filter(rule => rule.kind === 'draft').map(rule => rule.pattern);
const executionPatterns = CLAIM_RULES.filter(rule => rule.kind === 'execution').map(rule => rule.pattern);

// ---- 达成谓词表 AFFIRMATIVE_RULES（含原内联英文条件前缀正则提常量，字面逐字）----
const AFFIRMATIVE_RULES = Object.freeze({
  negativePrefix: new RegExp(`(?:并未|尚未|还未|没有|不会|不能|不可|不应|不代表|不表示|不意味着|不要|禁止|避免|无法|未|没)${BRIDGE}$`),
  futurePrefix: new RegExp(`(?:如果|假如|假设|若|等到|确认后|核对后|批准后|执行后|将|会|可以|即可|能够|才能|才会|计划|打算)${BRIDGE}$`),
  englishConditional: /\b(?:if|when|after|cannot|can't|not|never|don't|will|would|could|may|might)\s*$/i,
  history: /历史|此前|之前|上次|原有|原来的|原记录|原卡片|曾经|以前|昨天|前天|上周|上月|去年|过去/,
  explicitCurrent: /本次|这次|本轮|当前|我(?:们)?(?:已|已经)|(?:已|已经)(?:为你|帮你|替你)/,
});

// ---- continuation 规则域：主正则 + 业务对象正则 + 句子切分 + 三阶段守卫谓词表 ----
// A directly joined clause inherits an explicit completed assistant/current
// subject: "我已经核对，并完成入账". A bare "并完成入账" alone is
// deliberately insufficient. Do not carry this context across hard sentences.
const completedContinuation = new RegExp(
  SUBJECT + GAP + '{0,8}' + DONE + GAP + '{0,16}[，,]\\s*(?:并且|并|且|同时|也)\\s*完成(?:了)?\\s*(?<action>' + ACTION + ')', 'g');

// Generic editing verbs need an explicit business object in this extension.
// Rendering or updating an answer/chart never proves a committed table edit.
const continuationBusinessObject = /^\s*(?:了)?\s*(?:(?:这个|这条|这笔|这项|这份|这张|该|本次的?|本轮的?|当前的?|你的|您的|我的)\s*)?(?:已保存的?|保存的?)?\s*(?:账本|账簿|账户(?:余额|配置|设置|信息)?|余额|交易(?:记录)?|收支(?:记录|流水)?|待办(?:日程)?|提醒|预算(?:计划)?|分期(?:计划)?|卡片(?:配置|设置|信息)?|工资(?:规则|记录)?|基金(?:登记|持仓)?|固定资产(?:登记)?|资产登记)/;

// The server may choose prose scope for a turn without business activity.
// An article edit or literary draft is not a formal application effect. Bind
// generic edit verbs to their own adjacent object, never a whole-answer keyword.
const prosePreposedBusinessObject = /(?:账本|账簿|账户(?:余额|配置|设置|信息)?|余额|交易(?:记录)?|收支(?:记录|流水)?|待办(?:日程)?|提醒|预算(?:计划)?|分期(?:计划)?|卡片(?:配置|设置|信息)?|工资(?:规则|记录)?|基金(?:登记|持仓)?|固定资产(?:登记)?|资产登记)\s*(?:已|已经|现已|成功|完成|都|也|为你|帮你|替你|了)?\s*$/;
const proseCategoryObject = /^\s*(?:了)?\s*(?:这个|这条|该|你的|您的|我的)?\s*[\p{L}\p{N}]{0,12}分类(?:配置|设置)?(?:了)?(?=\s*(?:$|并|以及|同时|成功|完成))/u;
const prosePreposedCategoryObject = /[\p{L}\p{N}]{0,12}分类(?:配置|设置)?\s*(?:已|已经|现已|成功|完成|都|也|为你|帮你|替你|了)?\s*$/u;
const proseBusinessDraft = /(?:记账|入账|交易|预算|分期|还款|转账|待办|提醒|账户|卡片|分类|工资|基金|固定资产|业务操作)(?:操作)?(?:的)?(?:草稿|提案)/;
const englishBusinessObject = /\b(?:ledger|account\s+balance|transaction|todo|reminder)\b/i;
const proseMoneySource = /(?:这笔|本笔|本次操作|这次操作|本轮|银行卡|微信|支付宝|现金|银行账户|账户余额|(?:\d+(?:\.\d+)?)\s*元|[¥￥$]\s*\d+)/;
const proseMoneyObject = /^\s*(?:(?:到|向|给|从|这笔|本笔|一笔|这次|本次|本轮|他的|她的|你的|您的|我的|这个|该|所有|全部|剩余|应付的?)\s*){0,3}(?:账户|银行卡|微信|支付宝|现金|银行|余额|款项|金额|资金|贷款|费用|手续费|账单|欠款|交易|还款|退款|转账|付款|支付|\d+(?:\.\d+)?\s*(?:美元|欧元|港币|日元|英镑|人民币|元|USD|CNY|EUR)|[¥￥$]\s*\d+)/i;
const proseEnglishMoneyObject = /^\s*(?:(?:to|from|into|for|the|your|our|my|his|her|a|an|this|all)\s+){0,3}(?:money|funds|payment|repayment|refund|transfer|transaction|loan|fee|bill|debt|ledger|account|bank|balance|\d+(?:\.\d+)?\s*(?:USD|CNY|dollars?|yuan)\b|[$¥￥]\s*\d+)/i;
const proseMoneyFacts = /账户|银行|微信|支付宝|现金|余额|款项|金额|资金|贷款|费用|手续费|账单|欠款|(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+)\s*(?:美元|欧元|港币|日元|英镑|人民币|元|USD|CNY|EUR)|[¥￥$]\s*\d+|\b(?:money|funds|bank|account|balance|payment|repayment|refund|transaction|loan|fee|bill|debt)\b/i;
const proseLiteraryMoneyObject = /^(?:(?:高昂|沉重|巨大|昂贵|惨痛|无形)(?:的)?\s*)?代价|^到(?:他|她|你|我|我们|他们|她们)(?:的)?(?:心里|心中|心底)(?:的)?孤岛|^(?:a\s+|the\s+)?(?:high|heavy|steep)\s+price\b|^(?:a\s+|the\s+)?tribute\b|^(?:a\s+|the\s+|my\s+|your\s+)?(?:poem|sonnet|verse|story|article)\b/i;
const balanceStatePattern = /(?:你的|您的|当前的?|本次的?|本轮的?)?(?:账户(?:的)?余额|余额)\s*(?:也|都)?\s*(?:已经|已|现已|成功)\s*(?:被)?\s*(?:更新|修改|改变|变更|变化|变动|调整|变了)(?:了)?/g;
const balanceMutationPattern = new RegExp(`${SUBJECT}${GAP}{0,8}${DONE}${GAP}{0,16}(?:改变|变更|调整|更改)\\s*(?:了)?\\s*(?:(?:你|您)的)?\\s*(?:账户(?:的)?余额|余额)`, 'g');

const CONTINUATION_SENTENCE_SPLIT = /(?<!\d)\.|\.(?!\d)|[。!！?？;；\n]|但是|然而|可是|却/;

const CONTINUATION_GUARDS = Object.freeze({
  prefix: Object.freeze([
    { pattern: AFFIRMATIVE_RULES.history,
      note: "History preceding this subject is descriptive. Reading historical records inside the completed clause cannot hide its separate action." },
    { pattern: /保存(?:期次)?状态|历史记录/ },
    { pattern: /(?:请|需|需要|须|必须|应|应该|如果|假如|假设|若|只有|等到)/ },
  ]),
  action: Object.freeze([
    { pattern: /^(?:删除|修改|更新)$/ },
  ]),
  tail: Object.freeze([
    { pattern: /^\s*(?:后|前|时|之前|之后|以后|需要|需|须|将|会)/ },
    { pattern: /^\s*(?:了吗|吗)\s*$|^\s*(?:是否|能否|可否)|^\s*的(?:条件|要求|前提)/,
      note: "The joined action can itself be a question or a prerequisite noun. This qualification is local and cannot exempt a later assertion." },
  ]),
});

// ---- 效果分类表 EFFECT_RULES（表序 = 原 if 序，payment 兜底保持代码内联不入表）----
const EFFECT_WHITELIST = Object.freeze(['ledger', 'delete', 'update', 'payment']);

const EFFECT_RULES = Object.freeze([
  { pattern: /入账|记账|(?:记入|写入|写进)(?:账本|账簿)|入库|\b(?:posted|booked)\b/i, effect: 'ledger' },
  { pattern: /删除|\bdeleted\b/i, effect: 'delete' },
  { pattern: /修改|更新|\b(?:updated|modified)\b/i, effect: 'update' },
]);

// ---- 回执映射表 RECEIPT_RULES（ledger 精确相等与其余后缀正则两种形态并存，不强行统一）----
const RECEIPT_RULES = Object.freeze([
  { effect: 'ledger', kindPredicate: kind => kind === 'transaction.create' },
  { effect: 'delete', kindPredicate: kind => /\.(?:delete|permanentDelete)$/.test(kind) },
  { effect: 'update', kindPredicate: kind => /\.(?:update|metadata|complete)$/.test(kind) },
  { effect: 'payment', kindPredicate: kind => /\.(?:pay|payment|repayment|refund|transfer)$/.test(kind) },
]);

// ---- 完整草稿复验词面（原主循环内联正则提常量，字面逐字）----
const COMPLETE_DRAFT_PATTERN = /(?:完整|可执行|可以直接(?:入账|执行)|可直接(?:入账|执行))/;

// ---- 加载期结构守卫（fail-closed）：规则表结构性漏配 = 启动失败，不进入服务态。
// 对正常输入不可达，属纯新增防漏配设施；不引入模块级可变状态、不新增 require。
function assertRuleTablesIntact() {
  const fail = () => { throw new AiError('claims 规则表结构不完整', 500, 'AI_INVALID_RESULT'); };
  for (const rule of CLAIM_RULES) {
    if (!(rule.pattern instanceof RegExp) || (rule.kind !== 'draft' && rule.kind !== 'execution')) fail();
    if (rule.kind === 'draft' && rule.requiresComplete !== true) fail();
  }
  if (EFFECT_RULES.map(rule => rule.effect).join(',') !== 'ledger,delete,update') fail();
  if (RECEIPT_RULES.map(rule => rule.effect).join(',') !== 'ledger,delete,update,payment') fail();
  for (const key of ['negativePrefix', 'futurePrefix', 'englishConditional', 'history', 'explicitCurrent'])
    if (!(AFFIRMATIVE_RULES[key] instanceof RegExp)) fail();
  for (const stage of ['prefix', 'action', 'tail'])
    if (!Array.isArray(CONTINUATION_GUARDS[stage]) || CONTINUATION_GUARDS[stage].length === 0) fail();
}
assertRuleTablesIntact();

function unquoted(text) {
  // Preserve positions and separators. Quoted examples/status names are not
  // assertions that the current operation completed.
  return text.replace(/^ {0,3}(~{3,})(?!~)[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1~*[ \t]*\r?$/gm,
    value => value.replace(/[^\n]/g, ' '))
    .replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    value => value.replace(/[^\n]/g, ' '));
}

function affirmative(clause, start) {
  const prefix = clause.slice(0, start);
  if (AFFIRMATIVE_RULES.negativePrefix.test(prefix) || AFFIRMATIVE_RULES.futurePrefix.test(prefix)) return false;
  if (AFFIRMATIVE_RULES.englishConditional.test(prefix)) return false;
  if (AFFIRMATIVE_RULES.history.test(clause) && !AFFIRMATIVE_RULES.explicitCurrent.test(clause)) return false;
  return true;
}

function matches(clause, patterns, accept = () => true) {
  const found = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of clause.matchAll(pattern)) if (affirmative(clause, match.index) && accept(match)) found.push(match[0]);
  }
  return found;
}

function proseExecutionClaim(clause, match) {
  const edit = /(删除|修改|更新)(?:成功|已完成|完成)?$/.exec(match[0]);
  if (edit) {
    const before = match[0].slice(0, edit.index);
    const after = clause.slice(match.index + edit.index + edit[1].length)
      .replace(/^\s*(?:成功|已完成|完成)/, '');
    return continuationBusinessObject.test(after) || proseCategoryObject.test(after)
      || prosePreposedBusinessObject.test(before) || prosePreposedCategoryObject.test(before)
      || englishBusinessObject.test(match[0]);
  }
  const money = /(付款|支付|还款|退款|转账|paid|transferred|refunded|repaid|posted|booked)$/i.exec(match[0]);
  if (!money) return true; // Unambiguous ledger actions always require receipts.
  const before = match[0].slice(0, money.index);
  const after = clause.slice(match.index + money.index + money[0].length)
    .replace(/^\s*(?:已完成|完成|成功)?(?:了)?\s*/, '');
  if (proseMoneySource.test(before) || proseMoneyObject.test(after) || proseEnglishMoneyObject.test(after)
      || proseMoneyFacts.test(before + after)) return true;
  // Missing an object in the financial vocabulary is not evidence of prose.
  // Only an explicit local literary object may qualify the completed verb.
  return !proseLiteraryMoneyObject.test(after);
}

function balanceClaims(text) {
  const claims = [];
  for (const sentence of text.split(CONTINUATION_SENTENCE_SPLIT)) {
    balanceStatePattern.lastIndex = 0;
    for (const match of sentence.matchAll(balanceStatePattern)) {
      if (!affirmative(sentence, match.index)) continue;
      const prefix = sentence.slice(0, match.index);
      const observed = /(?:(?:查询|工具)(?:结果|记录|数据)|(?:账本|历史|原有|已有)?记录)(?:显示|表明|记载)[，,：:]?\s*$/.test(prefix)
        || /根据(?:本轮)?(?:查询|工具)(?:结果|记录|数据)[，,：:]\s*$/.test(prefix);
      if (!observed) claims.push(match[0]);
    }
    claims.push(...matches(sentence, [balanceMutationPattern]));
  }
  return claims;
}

function continuationClaims(text) {
  const claims = [];
  const sentences = text.split(CONTINUATION_SENTENCE_SPLIT);
  for (const sentence of sentences) {
    completedContinuation.lastIndex = 0;
    for (const match of sentence.matchAll(completedContinuation)) {
      const clauseStart = Math.max(sentence.lastIndexOf('，', match.index - 1),
        sentence.lastIndexOf(',', match.index - 1)) + 1;
      const prefix = sentence.slice(clauseStart, match.index);
      const local = sentence.slice(clauseStart);
      if (!affirmative(local, match.index - clauseStart)) continue;
      if (CONTINUATION_GUARDS.prefix.some(guard => guard.pattern.test(prefix))) continue;
      const after = sentence.slice(match.index + match[0].length);
      let tail = after;
      if (CONTINUATION_GUARDS.action.some(guard => guard.pattern.test(match.groups.action))) {
        const object = continuationBusinessObject.exec(after) || proseCategoryObject.exec(after);
        if (!object) continue;
        tail = after.slice(object[0].length);
      }
      if (CONTINUATION_GUARDS.tail.some(guard => guard.pattern.test(tail))) continue;
      claims.push(match.groups.action);
    }
  }
  return claims;
}

const hasId = value => value && typeof value.id === 'string' && value.id.trim().length > 0;
const pending = value => hasId(value) && ['pending', 'reviewed'].includes(value.status);
const complete = value => pending(value) && value.actionUnavailable !== true &&
  (value.missingFields == null || (Array.isArray(value.missingFields) && value.missingFields.length === 0));

function effectOf(claim) {
  const matched = EFFECT_RULES.find(rule => rule.pattern.test(claim));
  const effect = matched ? matched.effect : 'payment';
  if (!EFFECT_WHITELIST.includes(effect)) mismatch(effect);
  return effect;
}

function hasReceipt(receipts, effect) {
  const rule = RECEIPT_RULES.find(entry => entry.effect === effect);
  if (!rule) mismatch(effect);
  return receipts.some(receipt => {
    if (!receipt || typeof receipt.recordId !== 'string' || !receipt.recordId.trim() ||
      !Number.isFinite(receipt.committedAt) || receipt.committedAt <= 0 || typeof receipt.kind !== 'string') return false;
    return rule.kindPredicate(receipt.kind);
  });
}

function mismatch(claimType) {
  const error = new AiError('本轮没有对应的可核对草稿或入账回执，已停止；请查看实际卡片和回执。',
    502, 'AI_RESULT_CLAIM_MISMATCH');
  error.claimType = claimType;
  throw error;
}

function assertResultClaims(answer, { artifacts = [], currentReceipts = [], scope = 'business' } = {}) {
  if (typeof answer !== 'string' || !Array.isArray(artifacts) || !Array.isArray(currentReceipts)
      || !['business', 'prose'].includes(scope)) {
    throw new AiError('最终答复真实性核验参数无效', 502, 'AI_INVALID_RESULT');
  }
  const draftLike = artifacts.flatMap(artifact => [artifact?.draft, artifact?.proposal]).filter(pending);
  const plain = unquoted(answer);
  if (balanceClaims(plain).length && !hasReceipt(currentReceipts, 'update')) mismatch('update');
  for (const claim of continuationClaims(plain)) {
    const effect = effectOf(claim);
    if (!hasReceipt(currentReceipts, effect)) mismatch(effect);
  }
  const clauses = plain.split(/(?<!\d)\.|\.(?!\d)|[，,。!！?？;；\n]|但是|然而|可是|却/);
  for (const clause of clauses) {
    const generated = matches(clause, draftPatterns);
    if (generated.length && (scope === 'business' || artifacts.length || proseBusinessDraft.test(clause))) {
      if (!draftLike.length) mismatch('draft');
      if (COMPLETE_DRAFT_PATTERN.test(clause) && !draftLike.some(complete)) mismatch('complete-draft');
    }
    for (const claim of matches(clause, executionPatterns,
      match => scope === 'business' || proseExecutionClaim(clause, match))) {
      const effect = effectOf(claim);
      if (!hasReceipt(currentReceipts, effect)) mismatch(effect);
    }
  }
}

module.exports = { assertResultClaims };
