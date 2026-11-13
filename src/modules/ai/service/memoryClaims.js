const { supportsReadState } = require('./memoryReadStateClaims');
const { CN_MEMORY, EN_MEMORY } = require('./memoryClaimVocabulary');
const { AiError } = require('./errors');
const { reconcileMemoryDeleteClaims } = require('./memoryDeleteClaims');
// A bounded wording correction, not a semantic proof of arbitrary prose.
// Only server-created memory-write receipts may authorize saved wording.
const CN_DONE = '(?:(?:我(?:们)?|本轮|本次|这次)?(?:已经|已|现已|成功))';
const CN_ACTION = '(?:保存|存入|写入|记录|更新|修改|调整|记住|牢记|记下)';
const CN_GAP = '(?:(?!并|以及|同时|而且|账本|账簿|转账|付款|支付|还款|删除|未|没有|不会|不能)[^，,。!！?？;；\\n]){0,18}?';
const EN_ACTION = '(?:saved|stored|recorded|updated|memorized|remembered)';
const EN_GAP = '(?:(?!\\band\\b|\\bbut\\b|\\bnot\\b|\\bnever\\b|\\bledger\\b|\\bpayment\\b)[^，,。!！?？;；\\n]){0,30}?';
const patterns = [
  new RegExp(`${CN_DONE}${CN_GAP}${CN_ACTION}${CN_GAP}${CN_MEMORY}(?:${CN_GAP}(?:保存|写入|存入)(?:到|至)?${CN_MEMORY})?`, 'giu'),
  new RegExp(`${CN_DONE}${CN_GAP}${CN_MEMORY}${CN_GAP}${CN_ACTION}(?:(?:到|至|进)${CN_MEMORY})?`, 'giu'),
  new RegExp(`${CN_MEMORY}${CN_GAP}${CN_DONE}${CN_GAP}${CN_ACTION}`, 'giu'),
  new RegExp(`${CN_DONE}(?:为你|帮你|替你)?(?:记住|牢记)(?:了)?(?:${CN_GAP}${CN_MEMORY})?`, 'giu'),
  new RegExp(`(?:我(?:们)?)?(?:记住了|记下了|记好了|牢记了)(?:${CN_GAP}${CN_MEMORY})?`, 'giu'),
  new RegExp(`${CN_MEMORY}${CN_ACTION}(?:成功|完成|好了)`, 'giu'),
  new RegExp(`(?:(?:I|We)\\s*(?:have|['’]ve|had)?\\s*(?:successfully\\s+)?)?${EN_ACTION}${EN_GAP}${EN_MEMORY}`, 'giu'),
  new RegExp(`${EN_MEMORY}\\s+(?:(?:have|has|had)\\s+been\\s+|(?:was|were)\\s+)?${EN_ACTION}`, 'giu'),
  /(?:I|We)\s*(?:have|['’]ve|had)\s+(?:successfully\s+)?(?:remembered|memorized)(?:\s+that)?/giu,
];
const explicitMemoryObject = new RegExp(`${CN_MEMORY}|${EN_MEMORY}`, 'iu');
const CN_NOT = '(?:(?:我(?:们)?|本轮|本次|这次|现在)?(?:还没有|还没|并没有|没有|并未|尚未|还未|未|没))';
const negativePatterns = [
  new RegExp(`${CN_NOT}${CN_GAP}${CN_ACTION}${CN_GAP}${CN_MEMORY}`, 'giu'),
  new RegExp(`${CN_NOT}${CN_GAP}${CN_MEMORY}${CN_GAP}${CN_ACTION}`, 'giu'),
  new RegExp(`${CN_MEMORY}${CN_GAP}${CN_NOT}${CN_GAP}${CN_ACTION}`, 'giu'),
  new RegExp(`(?:I|We)\\s+(?:have\\s+not|haven't|hasn't|did\\s+not|didn't)\\s+(?:save[ds]?|store[ds]?|record(?:ed)?|updat(?:e|ed)|remember(?:ed)?|memorize[ds]?)${EN_GAP}${EN_MEMORY}`, 'giu'),
  new RegExp(`${EN_MEMORY}\\s+(?:(?:have|has|had)\\s+not\\s+been|(?:haven't|hasn't)\\s+been|(?:was|were)\\s+not|wasn't|weren't|not)\\s+${EN_ACTION}`, 'giu'),
  new RegExp(`No\\s+${EN_MEMORY}\\s+(?:(?:was|were|has\\s+been)\\s+)?${EN_ACTION}`, 'giu'),
];

function maskedQuotes(text) {
  return text.replace(/^ {0,3}(~{3,})(?!~)[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1~*[ \t]*\r?$/gm,
    value => value.replace(/[^\n]/g, ' '))
    .replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|(?<![A-Za-z])'(?:\\.|[^'\\])*'/g,
    value => value.replace(/[^\n]/g, ' '));
}

function claimSegments(text, explicitOnly) {
  if (!explicitOnly) return [{ text, start: 0 }];
  const segments = [];
  let start = 0;
  // The legacy English gap permits periods. Prose mode must not use a
  // different sentence's memory noun or consume its independent save claim.
  for (const boundary of text.matchAll(/\.(?=\s|$)/g)) {
    segments.push({ text: text.slice(start, boundary.index), start });
    start = boundary.index + 1;
  }
  segments.push({ text: text.slice(start), start });
  return segments;
}

function affirmative(text, start) {
  const before = text.slice(0, start);
  const separator = [...before.matchAll(/[，,。!！?？;；\n]|但是|然而|可是|\bbut\b|\bhowever\b/giu)].pop();
  const prefix = before.slice(separator ? separator.index + separator[0].length : 0);
  if (/(?:没有|并未|尚未|还未|未|没|不能|不会|无法|不要|不代表|不表示|不意味着)[^，,。!！?？;；\n]{0,18}$/u.test(prefix) ||
    /\b(?:no|not|never|cannot|can't|haven't|hasn't|didn't|wasn't|weren't|unable to)(?:\s+\w+){0,5}\s*$/iu.test(prefix)) return false;
  if (/(?:如果|假如|假设|若|确认后|核对后|批准后|将|会|可以|才会|计划|打算)[^，,。!！?？;；\n]{0,18}$/u.test(prefix) ||
    /\b(?:if|when|will|would|could|may|might|can|plan to)(?:\s+\w+){0,5}\s*$/iu.test(prefix)) return false;
  const clause = prefix + text.slice(start).split(/[，,。!！?？;；\n]/u)[0];
  if (/上次|此前|之前|以前|原来|历史|曾经|previously|earlier|last time|before/iu.test(clause) &&
    !/本轮|本次|这次|现在|我(?:已经|已)|this time|this turn|(?:I|We)\s*(?:have|['’]ve)/iu.test(clause)) return false;
  return true;
}

function completionPrefix(text) {
  const chinese = /(?:(?:我(?:们)?|本轮|本次|这次)?(?:已经|已|现已|成功))/u.exec(text)?.[0];
  if (chinese) return chinese;
  if (/记住了|记下了|记好了|牢记了|成功|完成/u.test(text)) return '已';
  return /\b(?:I|We)\s*(?:have|['’]ve|had)/iu.exec(text)?.[0] || 'I have';
}

function savedReceipt(receipt) {
  return receipt && (receipt.saved === true || receipt.status === 'saved') &&
    typeof receipt.path === 'string' && receipt.path.endsWith('.md') &&
    typeof receipt.revision === 'string' && /^[a-f0-9]{64}$/u.test(receipt.revision);
}

function failureReason(errors, english) {
  const supplied = errors.find(error => typeof error?.message === 'string' && error.message.trim())?.message;
  let text = supplied || (english ? 'The memory tool returned an error.' : '记忆工具返回了错误。');
  text = text.replace(/https?:\/\/[^\s<>]+/giu, '[链接已隐藏]')
    .replace(/[A-Za-z]:[\\/][^'"\r\n]*/gu, '[路径已隐藏]')
    .replace(/\\\\[^'"\r\n]*/gu, '[路径已隐藏]')
    .replace(/(^|[\s'"(])\/(?:[^\s'"<>]+\/)*[^\s'"<>]+/gu, '$1[路径已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b|\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, '[密钥已隐藏]')
    .replace(/(?:api[ _-]?key|access[ _-]?token|secret[ _-]?key|password|密码|密钥)\s*(?:[:=：]|为|是)\s*["']?[^\s"']{4,}|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b/giu, '[密钥已隐藏]')
    .replace(/(?<!\d)\d{12,19}(?!\d)|(?:\d{4}[ -]){2,4}\d{2,4}/gu, '[号码已隐藏]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:[rh]_[0-9a-f]{32}|q_[0-9a-f]{24})\b/giu, '[标识已隐藏]')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return Array.from(text).slice(0, 200).join('').trim();
}

function negativeClaimApplies(masked, match, receipts, errors) {
  if (Array.isArray(errors) && errors.length) return false;
  const before = masked.slice(0, match.start), after = masked.slice(match.end);
  const prefix = before.split(/[，,。!！?？;；\n]/u).pop();
  const suffix = after.split(/[，,。!！?？;；\n]/u)[0];
  const clause = prefix + match.text + suffix;
  if (/版本(?:冲突|变化)|revision[^，,。!！?？;；\n]{0,20}(?:conflict|changed)/iu.test(masked)) return false;
  const explicitPaths = [...clause.matchAll(/\.md\b/giu)];
  if (explicitPaths.length > 1 || explicitPaths.length === 1 && !receipts.some(receipt => savedReceipt(receipt) && clause.includes(receipt.path))) return false;
  const explicitRevisions = [...clause.matchAll(/\b[a-f0-9]{64}\b/giu)].map(value => value[0]);
  if (explicitRevisions.some(value => !receipts.some(receipt => savedReceipt(receipt) && receipt.revision === value))) return false;
  if (/更新|修改|updated/iu.test(match.text) && receipts.filter(savedReceipt).every(receipt => receipt.changed === false)) return false;
  return affirmative(masked, match.start);
}

function reconcileMemoryClaims(answer, { receipts = [], readReceipts = [], searchReceipts = [], errors = [], explicitOnly = false } = {}) {
  if (typeof explicitOnly !== 'boolean') throw new AiError('记忆声明校验范围无效', 502, 'AI_INVALID_RESULT');
  const original = typeof answer === 'string' ? answer : String(answer ?? '');
  const saved = Array.isArray(receipts) && receipts.some(savedReceipt);
  const masked = maskedQuotes(original), candidates = [];
  const segments = claimSegments(masked, explicitOnly);
  for (const pattern of patterns) for (const segment of segments) {
    pattern.lastIndex = 0;
    for (const match of segment.text.matchAll(pattern)) {
      // Test the actual matched span. A memory topic elsewhere in an article
      // cannot turn a literary "I remembered" into a persistent write claim.
      if (explicitOnly && !explicitMemoryObject.test(match[0])) continue;
      const matchStart = segment.start + match.index;
      if (affirmative(masked, matchStart)) candidates.push({ start: matchStart, end: matchStart + match[0].length,
        text: original.slice(matchStart, matchStart + match[0].length) });
    }
  }
  for (const candidate of candidates) candidate.readState = supportsReadState(original, candidate, readReceipts, searchReceipts);
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const spans = [];
  for (const match of candidates) if (!spans.length || match.start >= spans[spans.length - 1].end) spans.push(match);
  const negativeCandidates = [];
  if (saved) for (const pattern of negativePatterns) for (const segment of segments) {
    pattern.lastIndex = 0;
    for (const match of segment.text.matchAll(pattern)) {
      if (explicitOnly && !explicitMemoryObject.test(match[0])) continue;
      const matchStart = segment.start + match.index;
      const candidate = { start: matchStart, end: matchStart + match[0].length,
        text: original.slice(matchStart, matchStart + match[0].length), negative: true };
      if (negativeClaimApplies(masked, candidate, receipts, errors)) negativeCandidates.push(candidate);
    }
  }
  negativeCandidates.sort((left, right) => left.start - right.start || right.end - left.end);
  for (const match of negativeCandidates) if (!spans.some(existing => existing.start < match.end && match.start < existing.end)) spans.push(match);
  spans.sort((left, right) => left.start - right.start);
  let correctedAnswer = original, businessClaimsText = original;
  for (const match of [...spans].reverse()) {
    const english = !/[\u3400-\u9FFF]/u.test(match.text);
    if (match.negative) {
      correctedAnswer = correctedAnswer.slice(0, match.start) +
        (english ? 'Long-term memory was saved in this turn' : '本轮已保存到长期记忆') + correctedAnswer.slice(match.end);
      businessClaimsText = businessClaimsText.slice(0, match.start) + businessClaimsText.slice(match.end);
      continue;
    }
    // Retain the completion marker: "已保存偏好并修改账本" must still
    // become an affirmative business claim "已并修改账本", not lose 已.
    businessClaimsText = businessClaimsText.slice(0, match.start) + completionPrefix(match.text) + businessClaimsText.slice(match.end);
    if (!saved && !match.readState) correctedAnswer = correctedAnswer.slice(0, match.start) +
      (english ? 'No long-term memory was saved in this turn' : '本轮未保存到长期记忆') + correctedAnswer.slice(match.end);
  }
  const corrected = spans.some(match => match.negative) || spans.some(match => !match.readState) && !saved;
  if (corrected && !saved && Array.isArray(errors) && errors.length) {
    const english = !/[\u3400-\u9FFF]/u.test(original);
    correctedAnswer += `${english ? '\nSave failed: ' : '\n未保存原因：'}${failureReason(errors, english)}`;
  }
  const deletion = reconcileMemoryDeleteClaims(correctedAnswer, { receipts, errors, explicitOnly });
  const deletionBusiness = reconcileMemoryDeleteClaims(businessClaimsText, { receipts, errors, explicitOnly });
  return { answer: deletion.answer, businessClaimsText: deletionBusiness.businessClaimsText,
    corrected: corrected || deletion.corrected };
}

module.exports = { reconcileMemoryClaims };
