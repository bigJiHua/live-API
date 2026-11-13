const { AiError } = require('./errors');
const { getDatasetCapability } = require('./datasetCapabilities');

// Only explicit user query instructions establish a literal filter or display
// cap. Quoted/fenced examples remain data and cannot introduce other intent.
function extractExplicitQueryConstraints(message, options = {}) {
  const text = String(message || ''), literals = [], spans = [];
  const quoted = /```[\s\S]*?(?:```|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)|`[^`\n]*(?:`|$)/g;
  let semantic = text, predicateEnd = -1;
  for (const match of text.matchAll(quoted)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].startsWith('```') || match[0].startsWith('`')) continue;
    let before = text.slice(0, match.index);
    for (const span of spans.slice(0, -1).reverse()) before = before.slice(0, span.start) + ' '.repeat(span.end - span.start) + before.slice(span.end);
    const prefix = before.split(/[。；;！？!?\n]/).at(-1);
    const instruction = /(?:文本|名称|内容|备注|文字)(?:里|中|内)?\s*(?:字面(?:上)?\s*)?(?:包含|含有|匹配)\s*$/.test(prefix);
    const connectedLiteral = predicateEnd >= 0
      && /^\s*[,，]?\s*(?:或(?:者)?|和|及|与|、|以及|and|or)\s*$/i.test(text.slice(predicateEnd, match.index));
    const example = /(?:例如|比如|示例|样例|演示|假设|工具参数|工具示例)/.test(prefix)
      || /(?:不要|不用|无需|不需要|别)[^，,]{0,20}$/.test(prefix);
    // A quoted value after a text/name contains instruction is an explicit
    // literal predicate; users need not add the word 字面 to make it effective.
    if ((instruction || connectedLiteral) && !example) {
      const closing = { '“': '”', '‘': '’', '「': '」', '『': '』', '"': '"', "'": "'" }[match[0][0]];
      if (closing && match[0].at(-1) === closing) {
        literals.push(match[0].slice(1, -1));
        predicateEnd = match.index + match[0].length;
      }
    }
  }
  for (const span of spans.reverse()) semantic = semantic.slice(0, span.start) + ' '.repeat(span.end - span.start) + semantic.slice(span.end);
  const clear = [...semantic.matchAll(/(?:清空|清除|取消)(?:文字|文本)?筛选/g)].some(match =>
    !/(?:例如|比如|示例|样例|演示|假设|不要|不用|无需|不需要|别)\s*$/.test(semantic.slice(0, match.index).split(/[，,。；;！？!?\n]/).at(-1)));
  if (clear) literals.push('');
  const limits = [];
  for (const match of semantic.matchAll(/(?:只|最多|仅|仅仅)\s*(?:展示|显示|返回|列出)\s*(?:前)?\s*(\d{1,3})\s*(?:条|笔|行|天|组)(?!\d)/g)) {
    const prefix = semantic.slice(0, match.index).split(/[，,。；;！？!?\n]/).at(-1);
    if (/(?:例如|比如|示例|样例|演示|假设|工具参数|工具示例)|(?:不要|不用|无需|不需要|别)\s*$/.test(prefix)) continue;
    limits.push(Number(match[1]));
  }
  for (const match of semantic.matchAll(/(?:只|仅|仅仅)\s*(?:给|看|展示|显示|返回|列出)\s*(?:第(?:一|1)名|top\s*1)(?![\dA-Za-z])|(?:only|just)\s+(?:(?:show|return)\s+)?top\s*1\b/giu)) {
    const prefix = semantic.slice(0, match.index).split(/[，,。；;！？!?\n]/).at(-1);
    if (/(?:例如|比如|示例|样例|演示|假设|工具参数|工具示例)|(?:不要|不用|无需|不需要|别)\s*$/.test(prefix)) continue;
    limits.push(1);
  }
  const uniqueFilters = [...new Set(literals)], uniqueLimits = [...new Set(limits)], result = {};
  if (uniqueFilters.length === 1) result.filter = uniqueFilters[0];
  if (uniqueLimits.length === 1 && uniqueLimits[0] >= 1 && uniqueLimits[0] <= 50) result.limit = uniqueLimits[0];
  const constraints = Object.keys(result).length ? result : null;
  return options.evidence === true ? { constraints, filterLiterals: uniqueFilters, ambiguousFilters: uniqueFilters.length > 1 } : constraints;
}
function pinExplicitQueryConstraints(input, constraints) {
  if (!constraints) return input;
  if (constraints.filter && getDatasetCapability(input?.datasetId)?.acceptedArgs.filter.reader === false) {
    const error = new AiError('此数据集不支持文本筛选，请改用支持筛选的数据集', 400, 'AI_TOOL_ARGUMENT_INVALID');
    error.validationDiagnostic = { issues: [{ path: 'filter', rule: 'dataset.filter' }] };
    throw error;
  }
  return { ...input, ...constraints };
}
module.exports = { extractExplicitQueryConstraints, pinExplicitQueryConstraints };
