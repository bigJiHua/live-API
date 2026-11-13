// This module has no business-module dependencies: every context parser uses
// the same current-turn boundary before resolving old subjects or chart words.
const { explicitMemoryDeleteRequest } = require('./memoryDeleteTools');
function maskLiterals(message) {
  const blank = text => text.replace(/[\s\S]/g, ' ');
  return String(message || '').replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)|`[^`\n]*(?:`|$)/g, blank);
}

const MEMORY = /记住|记下来|记着|(?:新增|添加|保存|写入|修改|更新|删除|清空|读取|查看|查询|搜索|列出|展示|管理|读|查|搜)[^。！？;；\n]{0,18}(?:记忆|长期偏好)|(?:记忆|长期偏好)[^。！？;；\n]{0,18}(?:目录|列表|内容|有哪些|有什么|新增|保存|删除|读取|搜索)|\b(?:remember|(?:save|add|read|search|list|update|delete)\s+(?:a\s+|my\s+|the\s+)?memor(?:y|ies))\b/i;
const RESET = /(?:忘记|忽略|放下|放一边|不要再接着|不再继续)[^。！？;；\n]{0,18}(?:上面|之前|前面|刚才|旧|上一|这个|该)(?:[^。！？;；\n]{0,10})(?:内容|话题|任务|对话|请求)|(?:开启|开始|换|切换|重新开始)[^。！？;；\n]{0,8}(?:新(?:的)?话题|新(?:的)?主题|新的对话)|换个话题|\b(?:new topic|change (?:the )?topic|forget (?:the )?(?:previous|above) (?:topic|conversation))\b/i;
const SUBJECT = /收支|支出|收入|消费|流水|账单|账本|余额|账户|卡片|银行卡|借记卡|储蓄卡|信用卡|固定资产|流动资产|净资产|资产快照|资产构成|预算|待办|提醒|日程|日记|基金|收益|工资|薪资|分期|图表|饼图|折线|柱状|走势|趋势/;
const ACTION = /^(?:(?:请|帮我|请帮我|麻烦(?:你)?|劳驾|再|也|然后|接着|现在|本次|这次|顺便|同时|另外|我想|我要|我需要|能否|能不能|你(?:能|可以)(?:帮我)?)\s*)*(?:查(?:询|看|一下)?|看(?:下|一下)?|读取|统计|分析|汇总|列出|展示|比较|对比|给我|画|绘制|生成|新增|添加|创建|记一笔|记录|录入|修改|更新|删除|取消|完成|提醒我|设置|登记)/;

function affirmedInstruction(text, pattern) {
  for (const match of text.matchAll(new RegExp(pattern.source, 'gi'))) {
    const prefix = text.slice(0, match.index).split(/[，,。；;！？!?\n]|但是|而是/).at(-1);
    if (!/(?:不要|不用|无需|不必|不得|不能|不会|别|不是)[^，,。；;！？!?\n]{0,12}$/.test(prefix)
      && !/(?:如果|假如|假设|例如|比如|示例|如何|怎么|怎样)[^，,。；;！？!?\n]{0,32}$/.test(prefix)) return true;
  }
  return false;
}

function capabilityClause(text) {
  // Asking what an action supports has no requested values to execute. A
  // polite request with concrete dates/subjects still remains a business task.
  return /(?:用(?:了|的|到的)?|调用|使用)[^。！？;；\n]{0,24}(?:什么|哪些|哪个|哪种)[^。！？;；\n]{0,12}(?:工具|能力|功能)|^(?:你|AI|助手|系统)[^。！？;；\n]{0,24}(?:什么|哪些|哪个|哪种)[^。！？;；\n]{0,12}(?:能力|工具|功能)|^(?:能力|工具|功能)[^。！？;；\n]{0,16}(?:是什么|有哪些|告诉我|介绍|说明)/.test(text)
    || /(?:你|AI|助手|系统)[^。！？;；\n]{0,20}(?:能|可以|允许|支持)[^。！？;；\n]{0,30}(?:修改|编辑|更新|删除|查询|生成)[^。！？;；\n]{0,20}(?:什么|哪些|哪种)[^。！？;；\n]{0,12}(?:数据|字段|信息)/.test(text)
    || /^(?:你|AI|助手|系统)[^。！？;；\n]{0,24}(?:能|可以|会|支持)[^。！？;；\n]{0,16}(?:生成|绘制|画)\s*(?:个|一个|一张)?\s*(?:图表|饼图|折线图|柱状图)(?:了)?(?:吗|么|了吗)[?？\s]*$/.test(text)
    || /(?:固定资产|卡片|预算|待办|日程|基金)[^。！？;；\n]{0,12}(?:支持|允许|可以|可|能)[^。！？;；\n]{0,12}(?:修改|更新|编辑)[^。！？;；\n]{0,12}(?:哪些|什么)[^。！？;；\n]{0,8}(?:字段|信息|数据)/.test(text)
    || /^(?:你|AI|助手|系统)(?:刚才|之前|这次|这一次|上一轮)[^。！？;；\n]{0,18}(?:为什么|怎么|如何)[^。！？;；\n]{0,18}(?:生成|输出|绘制)[^。！？;；\n]{0,6}(?:图表|饼图|折线图|柱状图)/.test(text)
    || /^(?:请)?(?:介绍|说明|解释)[^。！？;；\n]{0,20}(?:你|助手|系统)(?:的)?(?:能力|工具|功能)/.test(text);
}

function feedbackClause(text) {
  const value = text.trim(), chart = /图表|饼图|折线图|柱状图|曲线图/.test(value);
  if (chart && /^(?:这(?:个|张|次)?|刚才(?:的)?|上一轮(?:的)?|你(?:刚才)?(?:生成|画|给)(?:的)?|图表|饼图|折线图|柱状图|曲线图|谢谢|感谢)/.test(value)
    && /(?:挺|很|比较|已经|可以|成功|正确|清楚|清晰|好看|不错|很好|谢谢|感谢|生成好了|生成完成|画好了)/.test(value)
    && !/(?:帮我|请|给我|重新|再生成|改成|修改|调整|查|看|多少|为什么|怎么|如何)/.test(value)) return true;
  if (chart && /^(?:这(?:个|张)?|刚才(?:的)?|图表|饼图|折线图|柱状图|曲线图)[^。！？;；\n]{0,16}(?:是什么意思|什么含义|有什么含义|什么口径|解释一下|怎么理解)[?？\s]*$/.test(value)) return true;
  return /(?:上次|上一笔|上一条|刚才|之前)[^。！？;；\n]{0,16}(?:已经|已)[^。！？;；\n]{0,12}(?:记好|记完|入账|保存|成功|完成)(?:了)?[。!?！？\s]*$/.test(value)
    && !/再|新(?:的)?一笔|重新|帮我|请|又(?:买|花|支出|收入)/.test(value);
}

function independentBusinessClause(text) {
  if (!text || /^(?:[-*]\s*)?(?:如果|假如|假设|例如|比如|示例|样例|每当|以后|今后|当我|只要|那么|否则|偏好|规则|要求|习惯)/.test(text)
    || /(?:时|的时候)[^。！？;；\n]{0,24}(?:只|不要|不用|无需|简洁|回复|输出)/.test(text)) return false;
  if (SUBJECT.test(text) && ACTION.test(text)) return true;
  if (/^(?:按月份|按月|按日|继续|接着|改成|更正|还是|回到)/.test(text) && /图|走势|趋势|查|看|收支|卡|资产|预算|待办/.test(text)) return true;
  if (SUBJECT.test(text) && /^(?:我(?:目前|现在)?(?:登记|保存|已有)?|今天|昨日|昨天|本月|这个月|今年|最近|当前|\d{1,2}月)/.test(text)
    && /多少|哪些|有哪些|哪张|什么|[?？]/.test(text)) return true;
  return /花了|花费|支付了|付了|买了|买菜|收到|收了|记一笔/.test(text)
    && /\d|[零〇一二两三四五六七八九十百千万]+\s*(?:元|块)/.test(text);
}

function memoryOperationFor(text, requested) {
  if (!requested) return null;
  // Existing state modifies the memory being read; it is not a new write.
  // Keep later explicit writes visible, including a read-then-save request.
  const actionText = text.replace(/(?:已(?:经)?|曾(?:经)?)(?:保存|写入|修改|更新)(?:的)?(?=[^。！？;；\n]{0,18}(?:记忆|长期偏好))/g,
    value => ' '.repeat(value.length));
  const write = /记住|记下来|记着|(?:新增|添加|保存|写入|修改|更新|删除|清空)[^。！？;；\n]{0,18}(?:记忆|长期偏好)|\b(?:remember|(?:save|add|update|delete)\s+(?:a\s+|my\s+|the\s+)?memor(?:y|ies))\b/i;
  if (affirmedInstruction(actionText, write)) {
    // A capability question alone asks about support, not a memory mutation.
    const capabilityOnly = /^(?:你|AI|助手|系统)[^。！？;；\n]{0,14}(?:能|可以|会|支持)[^。！？;；\n]{0,18}(?:新增|保存|添加|修改|删除|记住)[^。！？;；\n]{0,14}(?:记忆|偏好)(?:吗|么)[?？\s]*$/.test(text.trim());
    return capabilityOnly ? null : 'write';
  }
  // A question such as "有什么偏好" does not override "先读取记忆".
  const read = /(?:读取|读)[^。！？;；\n]{0,18}(?:记忆|长期偏好)(?!\s*(?:的)?(?:目录|列表))|\bread\s+(?:my\s+|the\s+|saved\s+)?memor(?:y|ies)\b/i;
  const requestedRead = affirmedInstruction(text, read);
  // A negated save clause can contain the following read in the broad MEMORY
  // matcher. Keep the separate affirmative read without changing write priority.
  if (!requestedRead && !affirmedInstruction(actionText, MEMORY)) return null;
  if (affirmedInstruction(text, /搜|\bsearch\b/i)) return 'search';
  if (requestedRead) return 'read';
  if (/目录|列表|列出|有哪些|有什么|\blist\b/i.test(text)) return 'list';
  return 'read';
}

function classifyCurrentTurn(message) {
  const original = typeof message === 'string' ? message : '', masked = maskLiterals(original);
  const memoryDeleteRequest = explicitMemoryDeleteRequest(original);
  const memoryRequest = memoryDeleteRequest || MEMORY.test(masked), capabilityQuestion = capabilityClause(masked);
  const feedback = masked.split(/[，,；;。\n！？!?]+|(?:同时|另外|此外|顺便|并且|以及)(?:再|也)?/).some(feedbackClause);
  const resetCandidate = affirmedInstruction(masked, RESET);
  const memoryOperation = memoryDeleteRequest ? 'delete' : memoryOperationFor(masked, memoryRequest);
  const presentationPreference = /^(?:以后|今后|如果(?:对话内)?我|当我|每当我|只要我|对话内我)[^。！？;；\n]{0,80}(?:图表|饼图|折线|柱状)[^。！？;；\n]{0,80}(?:回复|输出|简洁|只给|只要)/.test(masked.trim());
  if (!memoryRequest && !capabilityQuestion && !feedback && !resetCandidate && !presentationPreference) return {
    businessMessage: original, memoryRequest, memoryOperation, capabilityQuestion, feedback, topicReset: false, presentationPreference,
    businessSuppressed: false, auxiliaryRequest: false };

  const clauses = [], separator = /[，,；;。\n！？!?]+|(?:同时|另外|此外|顺便|并且|以及)(?:再|也)?|然后(?=\s*(?:请|帮我|再|查|看|读取|统计|生成|给我|新增|修改|开启|换))/g;
  let start = 0, explicitBoundary = false;
  for (const match of masked.matchAll(separator)) {
    clauses.push({ text: original.slice(start, match.index).trim(), semantic: masked.slice(start, match.index).trim(), explicitBoundary });
    start = match.index + match[0].length;
    explicitBoundary = /同时|另外|此外|顺便|并且|以及|然后/.test(match[0]);
  }
  clauses.push({ text: original.slice(start).trim(), semantic: masked.slice(start).trim(), explicitBoundary });
  let memoryBody = false, topicReset = false;
  const business = clauses.filter(({ text, semantic, explicitBoundary }) => {
    if (explicitBoundary) memoryBody = false;
    if (MEMORY.test(semantic) || explicitMemoryDeleteRequest(text)) {
      // Unquoted, multiline memory content is still user data. Only an
      // explicit second-task connector resumes business parsing after it.
      if (memoryOperation === 'write') memoryBody = true;
      return false;
    }
    if (memoryBody) return false;
    // A reset phrase inside requested memory content never changes the live
    // conversation. Decide durable boundaries only from independent clauses.
    if (affirmedInstruction(semantic, RESET)) topicReset = true;
    return !RESET.test(semantic) && !capabilityClause(semantic) && !feedbackClause(semantic) && independentBusinessClause(semantic);
  });
  const businessMessage = business.map(clause => clause.text).join('。');
  const auxiliaryRequest = memoryRequest || capabilityQuestion || feedback || topicReset || presentationPreference;
  return { businessMessage, memoryRequest, memoryOperation, capabilityQuestion, feedback, topicReset, presentationPreference,
    businessSuppressed: !businessMessage, auxiliaryRequest };
}

module.exports = { classifyCurrentTurn };
