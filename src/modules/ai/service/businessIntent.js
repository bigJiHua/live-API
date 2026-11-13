const { AiError } = require('./errors');
const { extractMoneyTokens } = require('./transactionInput');

const SPECIAL_ACCOUNTING = /转账|还款|退款|冲正|分期|购汇|结汇|提现|初始化|余额调整|本金调整|证券买卖|正式折旧|精密重算|\b(?:transfer|repayment|refund|reversal|installment|withdrawal)\b/i;
const READ_REQUEST = /(?:查(?:看|询)?|看看|看一下|统计|分析|汇总|列出|显示|展示|告诉我|解释|比较|对比|核对|了解|说明)/;
const READ_QUESTION = /(?:如何|怎么|怎样|有什么(?:风险|后果|影响)|会不会|会影响|是否已经|有没有|哪些|多少|为何|为什么)/;
const NEGATION = /(?:不要|不用|无需|不需要|不能|禁止|别(?!名|的)|暂不|不想|先不|不必|不准|不允许|不)[^，,。；;\n]{0,12}$/;
const DIRECT_REQUEST = /(?:请|帮我|麻烦|我要|我想|想要|把|将|然后|接着|并且|并|再)/;
const QUOTED_TEXT = /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|《[^》]*》|"[^"\n]*"|'[^'\n]*'/g;
const commandText = message => message.replace(QUOTED_TEXT, value => ' '.repeat(value.length));

function deny(message = '这条我没看出要办的账务操作。想记账就直接说，比如「花 35 买咖啡，微信付」；查账直接问就行。', code = 'AI_ACTION_NOT_REQUESTED', status = 403) {
  throw new AiError(message, status, code);
}

function amountTokens(message, options) {
  return extractMoneyTokens(message,options).map(token => token.valid ? token.amount : null).filter(value => value != null);
}

function canonicalAmount(value) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  const zero = integer === '0' && !fraction;
  return `${match[1] === '-' && !zero ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`;
}

function explicitAmount(message, amount, options) {
  if (typeof message !== 'string' || typeof amount !== 'string' || !/^-?\d+(?:\.\d{1,4})?$/.test(amount)) return false;
  return amountTokens(message,options).some(value => canonicalAmount(value) === canonicalAmount(amount));
}

// Each kind has its own actual action. Query terms, narrative states and a
// different mutation are never enough to authorize a provider-selected kind.
const ACTIONS = Object.freeze({
  'transaction.create': /记账|记一笔|记下|记笔|帮我记|登记(?:这笔|收入|支出|消费|交易)|录入(?:收入|支出|消费|交易)|花了|花费了?|付了|支付了?|支出|收入|买了|收到|收了|停车(?:费)?|午饭|晚饭|早饭|吃饭|餐费|饭钱/,
  'budget.create': /新增|新建|创建|建立|添加|登记|制定|设置|设定|做(?:一个|一份|个|份)?|安排/,
  'todo.create': /新增|新建|创建|添加|登记|录入|安排|提醒我|帮我提醒|帮我记|记一个|记个|记条|记一条|记下/,
  'todo.update': /修改|更新|调整|更改|改成|改到|改为|重新安排|设置|设为|取消提醒|关闭提醒|开启提醒|打开提醒/,
  'todo.complete': /(?:标记|标|设置|设|置|改)(?:为|成|回)?(?:已完成|待完成)|取消(?:已完成|完成标记)|重新打开|(?<!已|未|待)完成/,
  'todo.delete': /删除|删掉|移除|删去/,
  'diary.create': /(?:写|整理|总结|生成|创建|新增|记一篇|记篇|记录)[^。\n]{0,40}日记|日记[：:]/,
  'card.metadata': /修改|更新|更改|改成|改为|设置|设为|重命名|更名|挂失|注销|恢复正常/,
  'fixedAsset.create': /新增|新建|创建|添加|登记|录入|记下/,
  'fixedAsset.update': /修改|更新|更改|改成|改为|重命名|更名|设置|设为/,
  'fixedAsset.delete': /删除|删掉|移除|(?:移到|移入|放入).{0,10}回收站|回收(?:固定资产|资产)/,
  'fixedAsset.restore': /恢复|还原|撤销删除/,
  'fixedAsset.permanentDelete': /(?:永久|彻底|不可恢复地?)[^。\n]{0,12}(?:删除|删掉)|(?:删除|删掉)[^。\n]{0,12}(?:永久|彻底|不可恢复)/,
  'fund.returnBatch': /新增|登记|录入|记录|补录|添加|保存|整理/,
  'system.backup': /备份/,
});

function assertProposalIntent(kind, message, {accounts=[],entities=accounts}={}) {
  if (!Object.hasOwn(ACTIONS, kind)) deny('这个业务动作未向 AI 开放', 'AI_ACTION_NOT_ALLOWED');
  if (typeof message !== 'string' || !message.trim() || message.length > 1500) deny();
  if (kind === 'transaction.create' && SPECIAL_ACCOUNTING.test(message)) deny('特殊金融操作不能转为普通收支草稿', 'AI_ACTION_NOT_ALLOWED');
  // Quoted names/content are task data. A card named “已核对” must not turn an
  // explicit restore request into a read query, and a quoted “删除” is not an
  // authorization to delete anything. Preserve offsets for clause checks.
  const command = commandText(message);
  const action = ACTIONS[kind].exec(command);
  if (!action) deny();
  const before = command.slice(0, action.index), after = command.slice(action.index + action[0].length);
  if (NEGATION.test(before) || /^(?:过|了吗|过吗)/.test(after)) deny();
  // A read request may mention an action as data, e.g. "查看已完成待办".
  // A separately stated imperative after the read clause is an explicit request.
  if (READ_REQUEST.test(before) && !DIRECT_REQUEST.test(before.slice((before.search(READ_REQUEST)) + 1))) deny();
  if (READ_QUESTION.test(command) && !/^(?:请|帮我|麻烦|我要|我想|想要)/.test(command.trim())) deny();
  if (/(?:已|已经|未|待|曾经|刚刚)$/.test(before.trim())) deny();
  if (kind === 'transaction.create') {
    const requestedBookkeeping = /记账|记一笔|记下|记笔|帮我记|登记|录入/.test(message);
    const amounts = amountTokens(message,{entities});
    // A clear purchase may omit the currency unit. The shared token parser
    // already excludes dates, counts, account suffixes and balance references.
    // Precision/limit failures still belong in local financial preflight;
    // intention only requires a positive numeric token, never a suffix/year.
    if (!requestedBookkeeping && !amounts.some(value=>/^\d+(?:\.\d+)?$/.test(value)&&/[1-9]/.test(value))) deny();
    // 追加165：2-3 笔同方向多笔由 parseTransactionInputs 拆分 + proposalFrom 逐笔 evidence-match 防合并，
    // 意图层只拦超上限；「防单笔误吞多金额」的旧职责由逐笔匹配接管
    if (amounts.length > 3) deny('这条消息金额超过一次 3 笔的上限，请分开发送并逐笔核对。', 'AI_MULTIPLE_TRANSACTIONS', 400);
  }
  if (kind === 'budget.create' && !/预算/.test(message)) deny();
  if (kind === 'fund.returnBatch' && !/收益|日收益/.test(message)) deny();
  if (kind === 'fixedAsset.delete' && /永久|彻底|不可恢复/.test(message)) deny('永久删除必须使用明确的永久删除草稿');
  // Do not turn a request to change one domain into an unrelated same-verb card.
  if (kind === 'todo.create' && !/待办|任务|日程|事项|事件|安排|提醒|生日|纪念日|倒计时/.test(message)) deny();
  if (kind.startsWith('fixedAsset.') && !/固定资产|资产|回收站/.test(message)) deny();
  if (kind === 'system.backup' && !/^(?:请|帮我|麻烦|我要|我想|想要)?\s*(?:备份|做|创建|生成|执行|进行|开始|启动)/.test(message.trim())) deny();
  return true;
}

// In a personal assistant chat a date followed by a concrete personal activity
// is also a scheduling request: “明天取快递” need not say “新增待办”. This
// narrow V3 allowance creates only a reviewable todo proposal. It does not
// authorize any provider-selected update, completion or deletion.
function naturalTodoRequest(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 1500) return false;
  const command = commandText(message).trim();
  if (READ_REQUEST.test(command) || READ_QUESTION.test(command) || /[?？]|(?:吗|么|呢)[。！!]?\s*$/.test(command)) return false;
  if (/(?:不要|不用|无需|不需要|不能|禁止|别|暂不|不想|先不|不必|不准|不允许|不去|没去|未去)/.test(command)) return false;
  if (/(?:已经|已完成|已删除|已取消|做完|完成了|取消了|曾经|刚刚|昨天|前天|故事|示例|样例|文案|假设|如果|听说|他说|她说|说过|这句话|这段话|作为测试)/.test(command)) return false;
  if (/(?:删除|删掉|移除|修改|更新|更改|改成|改为|标记|恢复|还原|备份|新建|创建|登记|录入|记账|永久|彻底)/.test(command)) return false;
  const prefix = /^(?:(?:请|帮我|麻烦|我要|我想|想要)\s*)?(?:我\s*)?(?:今天|今晚|明天|明晚|明早|后天|大后天|下(?:周|星期)[一二三四五六日天]?|下个月|这(?:周|星期)[一二三四五六日天]|本周[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|20\d{2}(?:-|年)\d{1,2}(?:-|月)\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号])\s*(?:(?:早上|上午|中午|下午|晚上|傍晚|凌晨)\s*)?(?:(?:\d{1,2}(?:[:：]\d{2}|点(?:半|\d{1,2}分)?|时(?:\d{1,2}分)?))\s*)?(?:我\s*)?(?:要|得|准备|打算)?\s*/;
  const match = prefix.exec(command);
  if (!match) return false;
  const activity = command.slice(match[0].length).trim();
  // Concrete activities, rather than arbitrary text after a date. An explicit
  // “提醒我…” remains governed by the general command gate above.
  return /^(?:去(?:取|拿|买|看|参加|办|交|缴|坐|赶|接|送|做|跑|游|吃|复查|体检)|取快递|拿快递|买(?:菜|票|药|东西)|开会|参加|复查|体检|交(?:作业|报告|材料|费)|缴(?:费|水电)|接|送|出发|坐(?:车|飞机|火车)|赶(?:车|飞机|火车)|跑步|游泳|吃(?:饭|药)|见|面试|看(?:医生|病|电影)|打(?:电话|疫苗)|办(?:证|手续)|上(?:班|课)|学习|考试|还(?:书|款|信用卡))\S/.test(activity)
    || /^(?:取快递|拿快递|买菜|买票|买药|开会|复查|体检|出发|跑步|游泳|面试|考试|上班|上课|学习|吃饭|吃药|看医生|看病|看电影|打电话|打疫苗|办证|办手续|还书|还款|还信用卡)$/.test(activity);
}

function assertV3ProposalIntent(kind, message, options = {}) {
  // Keep the established per-kind gate authoritative for every other action.
  if (kind === 'todo.create' && naturalTodoRequest(message)) return true;
  return assertProposalIntent(kind, message, options);
}

function validateFundEvidence(entries, message) {
  const invalid = () => deny('基金日收益须每行明确提供一个日期及对应金额；歧义或重复日期请先手动整理', 'AI_AMOUNT_NOT_EXPLICIT', 400);
  if (!Array.isArray(entries) || !entries.length || entries.length > 31 || typeof message !== 'string') invalid();
  const lines = message.split(/[\n；;]/).filter(line => line.trim());
  const dates = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(entry.date) ||
        typeof entry.amount !== 'string' || !/^-?\d+(?:\.\d{1,4})?$/.test(entry.amount) || dates.has(entry.date)) invalid();
    dates.add(entry.date);
    const date = new Date(`${entry.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== entry.date) invalid();
    const matching = lines.filter(line => line.includes(entry.date));
    if (matching.length !== 1) invalid();
    const line = matching[0], foundDates = line.match(/20\d{2}-\d{2}-\d{2}/g) || [];
    if (foundDates.length !== 1 || foundDates[0] !== entry.date) invalid();
    // Read only the amount after this single date; a fund name such as 中证500
    // before the date cannot be confused with that day's return.
    const suffix = line.slice(line.indexOf(entry.date) + entry.date.length);
    const tokens = amountTokens(suffix,{ignoreFinancialReferences:false});
    if (tokens.length !== 1 || canonicalAmount(tokens[0]) !== canonicalAmount(entry.amount)) invalid();
  }
  return true;
}

module.exports = { assertProposalIntent, assertV3ProposalIntent, validateFundEvidence, explicitAmount };
