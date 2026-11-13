'use strict';

// Only a single explicit search request can be completed by line-level search
// evidence. Unrecognized language remains on the ordinary model/tool path.
const QUOTED_TARGET = /"([^"\r\n]{1,200})"|'([^'\r\n]{1,200})'|“([^”\r\n]{1,200})”|「([^」\r\n]{1,200})」|『([^』\r\n]{1,200})』/gu;
const EN_HEAD = /^(?:please\s+)?(?:search|find)\s+(?:(?:in|within)\s+)?(?:(?:my|the)\s+)?(?:(?:saved|long[- ]term|persistent)\s+)?memor(?:y|ies)\s+(?:(?:for|using|with)\s+)?(?:(?:the\s+)?(?:literal(?:\s+text)?|regex(?:\s+pattern)?|regular\s+expression)(?:\s+(?:for|of))?\s+)?$/iu;
const CN_HEAD = /^(?:请\s*)?(?:(?:在|从)\s*)?(?:我的?\s*)?(?:(?:已保存的?|长期)\s*)?记忆(?:中|里|内)?\s*(?:(?:按|使用)\s*)?(?:字面|literal|正则(?:表达式)?|regex)?\s*(?:搜索|检索|查找)\s*(?:文本|文字|模式)?\s*[:：]?\s*$/iu;
const EN_TAIL = /^(?:(?:and\s+)?(?:show|return|give|tell)\s+(?:me\s+)?(?:(?:all|the)\s+)?(?:matching\s+)?(?:original\s+)?(?:text|lines?|matches|results|files?(?:\s+and\s+(?:original\s+)?text)?)(?:\s+(?:and|with)\s+(?:files?|line(?:\s+numbers?)?|original\s+text)){0,2})?[.!?。！？]?$/iu;
const CN_TAIL = /^(?:(?:并|然后)?(?:告诉我|展示|显示|返回)(?:匹配的?|相关的?)?(?:文件(?:名)?和)?(?:原文(?:内容)?|匹配(?:结果)?|行号|文件(?:名)?)(?:和(?:原文(?:内容)?|行号|文件(?:名)?)){0,2})?[。.!！?？]?$/u;
const FINALIZATION_INSTRUCTION = '记忆检索任务已完成。只依据本轮 memory_search 回执说明匹配数量、文件名、行号与匹配原文；这些是行级匹配结果，不是整个文件，不声称已读取文件全文。无匹配时说明本次搜索未发现匹配。保持本轮指定答复语言，不再调用工具。';

function explicitMemorySearchGoal({ message, taskContext = null, currentQueryGoals = [], hasBusinessTask = false } = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 1500 || hasBusinessTask !== false
    || !Array.isArray(currentQueryGoals) || currentQueryGoals.length
    || taskContext && taskContext.mode !== 'chat') return null;
  const text = message.trim();
  QUOTED_TARGET.lastIndex = 0;
  const targets = [...text.matchAll(QUOTED_TARGET)];
  if (targets.length !== 1) return null;
  const target = targets[0], pattern = target.slice(1, 6).find(value => value !== undefined);
  if (!pattern?.trim() || pattern.length > 200) return null;
  const before = text.slice(0, target.index), after = text.slice(target.index + target[0].length).trim().replace(/^[，,;；:：]\s*/u, '');
  const english = EN_HEAD.test(before), chinese = CN_HEAD.test(before);
  if (!(english && EN_TAIL.test(after) || chinese && CN_TAIL.test(after))) return null;
  const mode = /\bregex\b|regular\s+expression|正则/iu.test(before) ? 'regex' : 'literal';
  return { pattern, mode };
}

function completeSearchResult(goal, search) {
  const args = search?.args, result = search?.result;
  if (!args || args.pattern !== goal.pattern || (args.mode ?? 'literal') !== goal.mode
    || !result || result.status !== undefined && result.status !== 'ok' || result.truncated !== false
    || !Array.isArray(result.warnings) || result.warnings.length
    || !Array.isArray(result.matches) || !Number.isInteger(result.count) || result.count !== result.matches.length) return false;
  return result.matches.every(match => typeof match?.path === 'string' && match.path.endsWith('.md') && !match.path.includes('..')
    && Number.isInteger(match.line) && match.line > 0 && typeof match.text === 'string' && match.text.trim()
    && match.textTruncated === false
    && (goal.mode !== 'literal' || match.text.toLocaleLowerCase().includes(goal.pattern.toLocaleLowerCase())));
}

function memorySearchCompletion({ searches = [], ...context } = {}) {
  const goal = explicitMemorySearchGoal(context);
  if (!goal || !Array.isArray(searches) || !searches.some(search => completeSearchResult(goal, search))) return null;
  return { ...goal, finalizationInstruction: FINALIZATION_INSTRUCTION };
}

module.exports = { explicitMemorySearchGoal, memorySearchCompletion };
