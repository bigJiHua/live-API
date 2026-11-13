const { AiError } = require('./errors');
const { validateMemoryPath } = require('./memoryStore');

const CN_OBJECT = '(?:长期记忆|记忆(?:文件|库|档案|信息)?|(?:答复|回答|图表|展示|语言|用户|记账|你的?)?偏好(?:设置|配置|文件|档案)?)';
const EN_OBJECT = '(?:(?:long[- ]term|persistent)\\s+memor(?:y|ies)|memor(?:y|ies)(?:\\s+(?:file|store))?|(?:(?:reply|answer|response|chart|display|language|user|your|my)\\s+)?preferences?)';
const CN_ACTION = '(?:删除|删掉|删去|移除|清除|清空|忘掉|忘记)';
const EN_ACTION = '(?:deleted|removed|erased|cleared|forgotten)';
const CN_GAP = '(?:(?!并|以及|同时|而且|账本|账簿|画像|规则|交易|转账|付款|支付|还款|未|没有|不会|不能)[^，,。!！?？;；\\n]){0,30}?';
const EN_GAP = '(?:(?!\\band\\b|\\bbut\\b|\\bnot\\b|\\bnever\\b|\\bledger\\b|\\bprofile\\b|\\brules?\\b|\\bpayment\\b)[^，,。.!！?？;；\\n]){0,45}?';
const patterns = [
  new RegExp(`(?:(?:我(?:们)?|本轮|本次|这次)?(?:已经|已|现已|成功))${CN_GAP}${CN_ACTION}${CN_GAP}${CN_OBJECT}`, 'giu'),
  new RegExp(`(?:(?:我(?:们)?|本轮|本次|这次)?(?:已经|已|现已|成功))${CN_GAP}${CN_OBJECT}${CN_GAP}${CN_ACTION}`, 'giu'),
  new RegExp(`${CN_OBJECT}${CN_GAP}(?:已经|已|现已|成功)(?:被)?${CN_GAP}${CN_ACTION}`, 'giu'),
  new RegExp(`${CN_ACTION}(?:了)?${CN_GAP}${CN_OBJECT}(?:${CN_GAP})?(?:成功|完成|好了)`, 'giu'),
  new RegExp(`${CN_ACTION}了${CN_GAP}${CN_OBJECT}`, 'giu'),
  new RegExp(`${CN_OBJECT}${CN_GAP}${CN_ACTION}(?:成功|完成|好了)`, 'giu'),
  new RegExp(`(?:(?:I|We)\\s*(?:have|['’]ve|had)?\\s*(?:successfully\\s+)?)?${EN_ACTION}${EN_GAP}${EN_OBJECT}`, 'giu'),
  new RegExp(`${EN_OBJECT}\\s+(?:(?:have|has|had)\\s+been\\s+|(?:was|were)\\s+)?${EN_ACTION}`, 'giu'),
];
const barePatterns = [
  /(?:(?:我(?:们)?|本轮|本次|这次)?(?:已经|已|现已|成功))(?:为你|帮你|替你)?(?:忘掉|忘记)(?:了)?/giu,
  /(?:我(?:们)?)?(?:忘掉了|忘记了)/giu,
  /(?:I|We)\s*(?:have|['’]ve|had)\s+(?:successfully\s+)?forgotten(?:\s+(?:it|that))?/giu,
];
const maskQuotes = value => String(value).replace(/^ {0,3}(~{3,})(?!~)[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1~*[ \t]*\r?$/gm,
  text => text.replace(/[^\n]/g, ' ')).replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|(?<![A-Za-z])'(?:\\.|[^'\\])*'/g,
  text => text.replace(/[^\n]/g, ' '));
const validReceiptIdentity = receipt => {
  if (!receipt || receipt.status === 'error' || typeof receipt.revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(receipt.revision)) return false;
  try { return validateMemoryPath(receipt.path) === receipt.path; } catch { return false; }
};
const validDeleteReceipt = receipt => validReceiptIdentity(receipt) && receipt.deleted === true && receipt.partialDeleted !== true;
const validPartialDeleteReceipt = receipt => validReceiptIdentity(receipt) && receipt.partialDeleted === true && receipt.deleted !== true
  && (receipt.saved === true || receipt.status === 'saved') && receipt.changed === true;

function currentDeletionEffects(receipts) {
  const latest = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (validDeleteReceipt(receipt) || validPartialDeleteReceipt(receipt)) latest.set(receipt.path, receipt);
    else if (validReceiptIdentity(receipt) && (receipt.saved === true || receipt.status === 'saved')) {
      // A later save can restore removed information. An unchanged save of the
      // same version preserves the established deletion effect.
      if (receipt.changed !== false || latest.get(receipt.path)?.revision !== receipt.revision) latest.delete(receipt.path);
    }
  }
  return [...latest.values()];
}

function affirmative(text, start, end) {
  const prior = text.slice(0, start), boundary = [...prior.matchAll(/[，,。.!！?？;；\n]|但是|然而|可是|\bbut\b|\bhowever\b/giu)].at(-1);
  const prefix = prior.slice(boundary ? boundary.index + boundary[0].length : 0);
  if (/(?:没有|并未|尚未|还未|未|没|不能|不会|无法|不要|不代表|不表示|不意味着)[^，,。.!！?？;；\n]{0,24}$/u.test(prefix)
    || /\b(?:no|not|never|cannot|can't|haven't|hasn't|didn't|wasn't|weren't|unable to)(?:\s+\w+){0,6}\s*$/iu.test(prefix)) return false;
  if (/(?:如果|假如|假设|若|确认后|核对后|批准后|将|会|可以|才会|计划|打算|例如|比如|示例)[^，,。.!！?？;；\n]{0,30}$/u.test(prefix)
    || /\b(?:if|when|will|would|could|may|might|can|plan to|example)(?:\s+\w+){0,6}\s*$/iu.test(prefix)) return false;
  const suffix = text.slice(end).split(/[，,。.!！?？;；\n]/u)[0], clause = prefix + text.slice(start, end) + suffix;
  if (/上次|此前|之前|以前|原来|历史|曾经|previously|earlier|last time|before/iu.test(clause)
    && !/本轮|本次|这次|现在|this time|this turn|just now/iu.test(clause)) return false;
  if (/(?:吗|么)\s*$/u.test(suffix)) return false;
  return true;
}
function matchingReceipt(original, candidate, receipts) {
  if (!receipts.length) return false;
  const before = original.slice(0, candidate.start).split(/[，,。!！?？;；\n]|\.(?=\s|$)/u).at(-1);
  const after = original.slice(candidate.end).split(/[，,。!！?？;；\n]|\.(?=\s|$)/u)[0];
  const clause = before + original.slice(candidate.start, candidate.end) + after;
  const join = /并且|并|以及|同时|而且|\band\b/iu;
  const scope = before.split(join).at(-1) + original.slice(candidate.start, candidate.end) + after.split(join)[0];
  const whole = /(?:全部|所有|整个|整份|完整的?)\s*(?:的|长期|用户|个人|你的|我的|\s)*(?:记忆|偏好|文件|记录|条目|信息|内容|[^，,。!！?？;；\n\s]+\.md)|(?:记忆(?:文件|库|档案)?|偏好(?:设置|配置|文件|档案)?)\s*(?:都|也|已经|已|现已|被)*\s*(?:全部|所有|整个)|\b(?:all|entire|whole|complete)\s+(?:(?:of\s+)?(?:the|my|your)\s+)?(?:long[- ]term\s+)?(?:memor(?:y|ies)|preferences?|files?|store|records?|entries|information|contents?)\b/iu.test(scope);
  const partial = !whole && /(?:记忆|偏好)(?:文件|档案)?(?:《[^》]*》|[\s\p{L}\p{N}_.-]*\.md)?(?:中|里|内)(?:的)?|从[^，,。!！?？;；\n]{0,80}(?:记忆|偏好|\.md)[^，,。!！?？;；\n]{0,8}(?:中|里|内)|(?:部分|一项|这一项|该项|某项|这条|该条|一条|这项|该记录|旧记录)[^，,。!！?？;；\n]{0,20}(?:记忆|偏好|记录|信息)|(?:记忆|偏好)[^，,。!！?？;；\n]{0,12}(?:部分|一项|这一项|该项|某项|这条|该条|一条|这项|记录|条目|信息)|\b(?:from|in|within)\s+(?:(?:the|my|your)\s+)?(?:memor(?:y|ies)|preferences?|memory\s+file)\b|\bmemor(?:y|ies)\s+(?:entries|entry|records?|items?|details?)\b|\b(?:one|a|this|that|some|part(?:\s+of)?)\s+(?:memory\s+)?(?:entries|entry|records?|items?|preferences?)\b/iu.test(scope);
  const applicable = receipts.filter(receipt => validDeleteReceipt(receipt) || partial && validPartialDeleteReceipt(receipt));
  if (!applicable.length) return false;
  const quotedFiles = [...clause.matchAll(/《([^》\n]{1,80}\.md)》|「([^」\n]{1,80}\.md)」|『([^』\n]{1,80}\.md)』|"([^"\n]{1,80}\.md)"|'([^'\n]{1,80}\.md)'|`([^`\n]{1,80}\.md)`/gu)]
    .map(match => match.slice(1, 7).find(value => value !== undefined));
  const knownPaths = applicable.map(item => item.path);
  const explicit = [...quotedFiles];
  const unquoted = clause.replace(/《[^》\n]*》|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu, ' ');
  for (const match of unquoted.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_ .-]{0,75}\.md/gu)) {
    const found = knownPaths.find(path => match[0].endsWith(path));
    explicit.push(found || match[0].trim());
  }
  if (explicit.length && explicit.some(path => !knownPaths.includes(path))) return false;
  const counts = [...clause.matchAll(/(?:全部|所有|all)\s*(\d+)\s*(?:条|份|个|files?|memor(?:y|ies))|(?:删除|移除|deleted|removed)\s*(\d+)\s*(?:条|份|个|files?|memor(?:y|ies))/giu)]
    .map(match => Number(match[1] || match[2]));
  if (counts.some(count => count > applicable.length)) return false;
  return true;
}
function sharedObject(original, item) {
  const after = original.slice(item.end).split(/[，,。!！?？;；\n]|\.(?=\s|$)/u)[0];
  // A single verb can govern memory and a second object. Keep that verb for
  // the separate business checker, including the partial-memory object tail.
  const connector = /(?:和|及|与|以及|并|\band\b)\s*(?:(删除|修改|更新|deleted|removed|updated|modified)\s*)?(?=账本|账簿|账户|交易|待办|日程|用户画像|画像|规则|(?:the\s+|your\s+)?(?:ledger|account|transaction|todo|reminder|profile|rules?))/iu.exec(after);
  if (!connector || connector.index > 80 || /删除|删掉|移除|清除|保留|保持|修改|更新|保存|\b(?:deleted|removed|kept|retained|updated|saved)\b/iu.test(after.slice(0, connector.index))) return null;
  return { offset: connector.index + connector[0].length, action: connector[1] };
}
function failureReason(errors, english) {
  let value = Array.isArray(errors) ? errors.find(item => typeof item?.message === 'string' && item.message.trim())?.message : null;
  value = value || (english ? 'The memory deletion tool returned an error.' : '记忆删除工具返回了错误。');
  return Array.from(value.replace(/https?:\/\/[^\s<>]+|[A-Za-z]:[\\/][^'"\r\n]*|\\\\[^'"\r\n]*|\bsk-[A-Za-z0-9_-]+\b|\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:[rh]_[a-f0-9]{32}|q_[a-f0-9]{24})\b/giu, '[信息已隐藏]')
    .replace(/(?:api[ _-]?key|access[ _-]?token|secret[ _-]?key|password|密码|密钥)\s*(?:[:=：]|为|是)\s*["']?[^\s"']{4,}|(?<!\d)\d{12,19}(?!\d)|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '[信息已隐藏]')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, ' ')).slice(0, 200).join('').trim();
}

function reconcileMemoryDeleteClaims(answer, { receipts = [], errors = [], explicitOnly = false } = {}) {
  if (typeof explicitOnly !== 'boolean') throw new AiError('记忆删除声明校验范围无效', 502, 'AI_INVALID_RESULT');
  const original = typeof answer === 'string' ? answer : String(answer ?? '');
  const masked = maskQuotes(original), candidates = [], deletes = currentDeletionEffects(receipts);
  const selectedPatterns = explicitOnly ? patterns : [...patterns, ...barePatterns];
  for (const pattern of selectedPatterns) {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      if (!affirmative(masked, match.index, match.index + match[0].length)) continue;
      candidates.push({ start: match.index, end: match.index + match[0].length, supported: false });
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans = [];
  for (const item of candidates) if (!spans.length || item.start >= spans.at(-1).end) {
    item.supported = matchingReceipt(original, item, deletes); spans.push(item);
  }
  let result = original, businessClaimsText = original;
  for (const item of [...spans].reverse()) {
    const english = !/[\u3400-\u9FFF]/u.test(original.slice(item.start, item.end));
    // Retain the completed marker so an adjacent ledger claim remains checked.
    let replacement = english ? 'I have' : '已', tailStart = item.end;
    const shared = sharedObject(original, item);
    if (shared != null) {
      const action = shared.action === 'removed' ? 'deleted' : shared.action;
      replacement = english ? `I have ${action || 'deleted'}` : `已${action || '删除'}`;
      tailStart += shared.offset;
      if (english) replacement += ' ';
    }
    businessClaimsText = businessClaimsText.slice(0, item.start) + replacement + businessClaimsText.slice(tailStart);
    if (!item.supported) result = result.slice(0, item.start) +
      (english ? 'No long-term memory deletion was confirmed in this turn' : '本轮未确认删除长期记忆') + result.slice(item.end);
  }
  const corrected = spans.some(item => !item.supported);
  if (corrected && Array.isArray(errors) && errors.length) {
    const english = !/[\u3400-\u9FFF]/u.test(original);
    result += `${english ? '\nDeletion failed: ' : '\n未删除原因：'}${failureReason(errors, english)}`;
  }
  return { answer: result, businessClaimsText, corrected };
}

function memoryDeleteFailureNotice(receipts = []) {
  const effects = currentDeletionEffects(receipts);
  const paths = effects.filter(validDeleteReceipt).map(item => item.path);
  const partialPaths = effects.filter(validPartialDeleteReceipt).map(item => item.path);
  return [paths.length ? `本轮已删除 ${paths.length} 条长期记忆（${paths.join('、')}），删除已生效；其余处理未完成。` : '',
    partialPaths.length ? `本轮已删除 ${partialPaths.length} 个记忆文件中的部分记录（${partialPaths.join('、')}），文件中的其他内容保留，部分记忆修改已生效；其余处理未完成。` : '']
    .filter(Boolean).join('\n');
}

module.exports = { reconcileMemoryDeleteClaims, validDeleteReceipt, validPartialDeleteReceipt, memoryDeleteFailureNotice };
