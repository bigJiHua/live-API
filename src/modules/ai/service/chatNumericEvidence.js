const { canonical, literalNumber } = require('./v3Evidence');
const { evaluateCalc } = require('./calcTools');

// This guard consumes only this turn's published business rows and successful
// calculator receipts. Dates, labels and a user's question never enlarge the
// set of financial values. Pure conversation is kept outside it by the caller.
const NUMERIC_TYPES = new Set(['money', 'decimal', 'number']);
const NO_NUMBER_KEY = /(?:^|_)(?:id|ref|date|time|year|month|day|name|title|currency)(?:$|_)/i;
const FINANCIAL = /金额|资产|余额|收入|支出|工资|预算|收益|利润|本金|市值|净值|负债|欠款|还款|消费|总额|合计|比例|占比|amount|asset|balance|income|expense|salary|budget|profit|principal|total|ratio/i;
const CHINESE_NUMBER = '[负正+-]?[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九0-9]+)?';
const HYPOTHESIS_START = /(?:如果|(?<![该此])假设(?!值|结果)|假如|假定|若|\bif\b|\bassume\b|\bsuppose\b)/gi;
const PARAMETER_NUMBER = `([+-]?\\d+(?:\\.\\d+)?(?:万|亿|千|百)?|${CHINESE_NUMBER})`;
const PARAMETER_UNITS = '(?:小时|天|个月|月|年|次|笔|张|倍|%|元|块|CNY|USD|hours?|days?|months?|years?)';
const TIME_UNITS = '(?:小时|天|个月|月|年|hours?|days?|months?|years?)';

function normalizedNumber(raw) {
  if (!['string', 'number', 'bigint'].includes(typeof raw)) return null;
  const text = String(raw).normalize('NFKC').replace(/−/g, '-').trim();
  if (text.includes(',')) {
    if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) return null;
    return canonical(text.replace(/,/g, ''));
  }
  return canonical(text);
}

function publishedEvidence(datasets = []) {
  const values = new Set(), labels = new Set();
  const add = value => { const number = normalizedNumber(value); if (number != null) values.add(number); };
  const summary = (value, key = '', depth = 0) => {
    if (depth > 5 || NO_NUMBER_KEY.test(key) || /(?:Id|Ref|At|Date|Time)$/.test(key)) return;
    if (Array.isArray(value)) value.forEach(item => summary(item, key, depth + 1));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([name, item]) => summary(item, name, depth + 1));
    else add(value);
  };
  for (const dataset of datasets) {
    summary(dataset?.summary);
    for (const key of ['matchedRowCount', 'returnedRowCount', 'sourceRecordCount']) add(dataset?.queryMeta?.[key]);
    const columns = Array.isArray(dataset?.columns) ? dataset.columns : [];
    for (const row of dataset?.rows || []) for (const column of columns) {
      if (NUMERIC_TYPES.has(column.type)) add(row[column.key]);
      else if (column.type === 'text' && /^(?:name|title|type|company|bankName|category)$/.test(column.key)
        && typeof row[column.key] === 'string' && row[column.key].length >= 2
        && normalizedNumber(row[column.key]) == null && !/[¥￥$%]|元|CNY|USD|HKD|EUR|JPY|GBP/i.test(row[column.key])
        && !(FINANCIAL.test(row[column.key]) && /[\d零〇一二两三四五六七八九十百千万亿]/.test(row[column.key])))
        labels.add(row[column.key]);
    }
  }
  return { values, labels };
}

function hypothesisInputs(sourceMessage = '') {
  // A quoted example/preference is not an active hypothetical request.
  const text = String(sourceMessage).normalize('NFKC')
    .replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"/g, ' ')
    .replace(/(?<![\d,])([+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?![\d,])/g, value => value.replace(/,/g, ''));
  const inputs = new Set();
  const quantity = new RegExp(PARAMETER_NUMBER + '\\s*' + PARAMETER_UNITS, 'i');
  const timePrefix = new RegExp('^\\s*' + PARAMETER_NUMBER + '\\s*' + TIME_UNITS, 'i');
  const add = match => {
    if (!match) return;
    const number = literalNumber(match[1].replace(/−/g, '-'));
    if (number != null) inputs.add(number);
  };
  for (const start of text.matchAll(HYPOTHESIS_START)) {
    const body = text.slice(start.index + start[0].length).split(/[。！？;；\n]/, 1)[0].slice(0, 160);
    const [condition, ...following] = body.split(/[，,]/);
    const first = quantity.exec(condition);
    // The condition's first explicit quantity is a parameter. Do not scan its
    // remaining predicates for predicted amounts, and never cross an equation
    // to turn a RHS result into an input. Following comma clauses may contribute
    // only an initial time quantity ("three months"), never their result money.
    if (first && !/[=＝×*/+^%→]|(?:\d|[零〇一二两三四五六七八九十百千万亿])\s*-/.test(condition.slice(0, first.index))) add(first);
    for (const clause of following) add(timePrefix.exec(clause));
  }
  return inputs;
}

function expressionInputs(expression) {
  const inputs = [], tokens = expression.match(/\d+(?:\.\d+)?|pi|e|[()+*\/%^\-]/g) || [];
  let expectedOperand = true, negative = false;
  for (const token of tokens) {
    if (token === '(') { expectedOperand = true; negative = false; }
    else if (token === ')') { expectedOperand = false; negative = false; }
    else if (token === '+' || token === '-') {
      if (expectedOperand) { if (token === '-') negative = !negative; }
      else { expectedOperand = true; negative = false; }
    } else if (/^[*\/%^]$/.test(token)) { expectedOperand = true; negative = false; }
    else {
      if (/^\d/.test(token)) inputs.push(normalizedNumber((negative ? '-' : '') + token));
      expectedOperand = false; negative = false;
    }
  }
  return inputs;
}

function calculationValues(calculations, published, sourceMessage, suppliedInputs = [], scenarioMessage = '') {
  const result = new Set(), scenarioValues = new Set(), provenInputs = new Set(published);
  const hypotheses = hypothesisInputs(sourceMessage);
  hypothesisInputs(scenarioMessage).forEach(value => hypotheses.add(value));
  for (const value of suppliedInputs) { const number = normalizedNumber(value); if (number != null) hypotheses.add(number); }
  const neutral = new Set(['0', '1', '100']);
  for (const receipt of calculations || []) {
    if (!receipt || receipt.status === 'error' || !['money', 'number'].includes(receipt.mode)
      || typeof receipt.expression !== 'string' || normalizedNumber(receipt.value) == null) continue;
    // A literal or neutral-only expression is not a derivation of a business fact.
    if (!/[+*/%^]|\d\s*-/.test(receipt.expression)) continue;
    const inputs = expressionInputs(receipt.expression);
    const sourceInput = input => provenInputs.has(input);
    const scenarioInput = input => scenarioValues.has(input) || hypotheses.has(input);
    if (!inputs.length || !inputs.some(input => !neutral.has(input) && (sourceInput(input) || scenarioInput(input))) || inputs.some(input => !sourceInput(input)
      && !scenarioInput(input) && !neutral.has(input))) continue;
    try {
      const actual = evaluateCalc({ expression: receipt.expression, mode: receipt.mode });
      if (normalizedNumber(actual.value) !== normalizedNumber(receipt.value)) continue;
    } catch (_) { continue; }
    const value = normalizedNumber(receipt.value);
    if (inputs.some(input => !sourceInput(input) && scenarioInput(input))) scenarioValues.add(value);
    else { result.add(value); provenInputs.add(value); }
  }
  return { values: result, scenarios: new Set([...scenarioValues, ...hypotheses]), inputs: hypotheses };
}

function evidence(options = {}) {
  const { values, labels } = publishedEvidence(options.datasets || []);
  const calculations = calculationValues(options.calculations, values, options.sourceMessage, options.calculationInputs, options.scenarioMessage);
  calculations.values.forEach(value => values.add(value));
  return { values, labels, scenarios: calculations.scenarios, scenarioInputs: calculations.inputs };
}

function maskDates(text) {
  // Explicit date-shaped text is calendar syntax, never an amount allowance.
  return text.replace(/https?:\/\/[^\s<>]+/g, ' ')
    .replace(/(?<!\d)20\d{2}[-/.年](?:0?[1-9]|1[0-2])[-/.月](?:0?[1-9]|[12]\d|3[01])日?(?!\d|\s*(?:元|块|CNY))/g, ' ')
    .replace(/(?<!\d)20\d{2}[-/]\d{2}(?![-/\d]|\s*(?:元|块|CNY))|20\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月(?:初|中|底)?|\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/(?<!\d)(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\s*(?:至|到|—|~|～)\s*(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])(?!\d|\s*(?:元|块|CNY|=))/g, ' ')
    .replace(/(?:今天|日期|截至|截止|登记日|发生于)[（(:：\s]*\d{1,2}[-/]\d{1,2}[）)]?/g, ' ');
}

function numberTokens(input, labels, { diagram = false } = {}) {
  let text = String(input).normalize('NFKC').replace(/−/g, '-').replace(/负(?=\d)/g, '-').replace(/正(?=\d)/g, '+')
    .replace(/([+-])([¥￥$])/g, '$2$1').replace(/(?<![\dA-Za-z])([+-]?)\.(\d+)/g, '$10.$2');
  text = maskDates(text);
  for (const label of [...labels].sort((a, b) => b.length - a.length)) text = text.split(label.normalize('NFKC')).join(' ');
  // Ordered list indices are layout, not facts. Numerical code-chart axis
  // ranges likewise select layout; data point rows remain fully checked.
  text = text.replace(/^\s*(?:\d+[.．)）、](?!\d)|[（(]\d+[）)])\s*/gm, ' ');
  if (diagram) text = text.replace(/^\s*(?:y-axis|x-axis)\b[^\n]*$/gmi, line => {
    const labels = [...line.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)]
      .map(match => (match[1] ?? match[2]).replace(/\\(["'])/g, '$1'));
    if (labels.length) return labels.filter(label => FINANCIAL.test(label) || /(?:元|CNY|USD|%|％)/.test(label)).join('\n');
    const label = line.replace(/^\s*(?:y-axis|x-axis)\s*/i, '')
      .replace(/\s+[+-]?\d+(?:\.\d+)?\s*(?:-->|to)\s*[+-]?\d+(?:\.\d+)?\s*$/i, '');
    return FINANCIAL.test(label) || /(?:元|CNY|USD|%|％)/.test(label) ? label : ' ';
  });
  const numbers = [];
  const take = (raw, value) => { numbers.push({ raw, value }); return ' '; };
  text = text.replace(/百分之([负正+-]?[零〇一二两三四五六七八九十百千万亿\d]+(?:点[零〇一二两三四五六七八九\d]+|\.\d+)?)/g,
    (_, raw) => take('百分之' + raw, literalNumber(raw)));
  text = text.replace(/(?<![\dA-Za-z._])([+-]?\d+(?:\.\d+)?)(万|亿|千|百)(?![\dA-Za-z])/g,
    (raw, number, unit) => take(raw, literalNumber(number + unit)));
  text = text.replace(new RegExp(`(${CHINESE_NUMBER})\\s*(?:元|块|人民币|倍|小时|天|个月|笔|个|次|张|期|条)`, 'g'),
    (raw, number) => take(raw, literalNumber(number)));
  if (diagram) text = text.replace(/^(\s*(?:bar|line)\s*\[)([^\]\n]*)(\])/gmi,
    (_, before, values, after) => before + values.replace(/,/g, ' ') + after);
  for (const match of text.matchAll(/(?<![\dA-Za-z._])[+-]?\d(?:[\d,]*\d)?(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\dA-Za-z._])/g))
    numbers.push({ raw: match[0], value: normalizedNumber(match[0]) });
  return numbers;
}

function blocks(answer) {
  const output = [];
  const regex = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g;
  let start = 0;
  for (const match of answer.matchAll(regex)) {
    if (match.index > start) output.push({ text: answer.slice(start, match.index), kind: 'prose' });
    const lang = match[4].trim().toLowerCase();
    output.push({ text: match[0], kind: lang === 'mermaid' ? 'mermaid' : 'code', lang });
    start = match.index + match[0].length;
  }
  if (start < answer.length) output.push({ text: answer.slice(start), kind: 'prose' });
  return output;
}

function diagramClaimText(text) {
  if (/^\s*(?:pie|xychart(?:-beta)?)\b/m.test(text)) return { text, numeric: true };
  // Structure IDs, styling numbers and arrows are syntax. Human labels that
  // assert financial figures are still evidence-bearing and cannot bypass it.
  const labels = [];
  for (const line of text.split('\n')) {
    if (/^\s*(?:classDef|style|linkStyle|click|%%)\b/.test(line)) continue;
    const participant = /^\s*(?:participant|actor)\s+\S+\s+as\s+(.+)$/.exec(line);
    if (participant) labels.push(participant[1]);
    for (const match of line.matchAll(/\[([^\]]*)\]|\(([^()]*)\)|\{([^}]*)\}|"([^"]*)"|\|([^|]*)\|/g))
      labels.push(match.slice(1).find(value => value != null));
    const message = /(?:--?>[>]?|--?x|--?\))[^:]*:\s*(.*)/.exec(line);
    if (message) labels.push(message[1]);
  }
  const humanText = labels.join('\n');
  return { text: FINANCIAL.test(humanText) || /(?:元|块|CNY|USD|%|％)/i.test(humanText) ? humanText : '', numeric: false };
}

function codeHasFinancialContext(block, precedingProse) {
  if (FINANCIAL.test(block.text) || /(?:元|CNY|USD|¥|￥)/.test(block.text)) return true;
  const body = block.text.replace(/^\n?[ \t]*(?:`{3,}|~{3,})[^\n]*\n/, '')
    .replace(/\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/, '').trim();
  const bareData = /^[\s\d,.+\-*/%^=()[\]{}:;"'eE]+$/.test(body);
  if (bareData && FINANCIAL.test(String(precedingProse).slice(-160))) return true;
  return /^(?:|text|plaintext|plain|json|yaml|yml|csv|tsv|xml)$/.test(block.lang || '')
    && FINANCIAL.test(String(precedingProse).slice(-160));
}

const HYPOTHETICAL_TEXT = /假设|假如|假定|如果|按该假设|情景|在该条件|scenario|hypothetical|assum(?:e|ing|ption)|\bif\b/i;
const ACTUAL_TEXT = /已保存|当前|实际|真实|账本|登记|本月实得|saved|current|actual|recorded|ledger/i;
function scenarioHeading(text) {
  return HYPOTHETICAL_TEXT.test(text) && !ACTUAL_TEXT.test(text) && /(?:[:：]\s*$|^\s*#{1,6}\s)/.test(text);
}
function proseChunks(text) {
  let scenario = false;
  return (text.match(/[^。；;！？\n]+[。；;！？]?|\n+/g) || []).map(chunk => {
    if (scenarioHeading(chunk)) scenario = true;
    else if (/^\s*#{1,6}\s/.test(chunk) || ACTUAL_TEXT.test(chunk)) scenario = false;
    return { text: chunk, scenario: scenario && /^\s*(?:\||[-*]\s)/.test(chunk) };
  });
}
function precedingScenario(text) {
  const last = String(text).split('\n').filter(line => line.trim()).at(-1) || '';
  return scenarioHeading(last);
}
function unsupported(text, sources, options = {}) {
  const scenario = (HYPOTHETICAL_TEXT.test(text) || options.scenario)
    && !/已保存|当前|实际|真实|账本|登记|本月实得|saved|current|actual|recorded|ledger/i.test(text);
  return numberTokens(text, sources.labels, options).filter(token => token.value == null
    || !sources.values.has(token.value) && !(scenario && sources.scenarios.has(token.value)));
}

function stripPseudoToolProtocol(text) {
  // These strings are provider prose, not native tool_calls. Never interpret
  // their arguments or manufacture a calculator receipt from their payload.
  // Fenced examples are handled separately and do not pass through this path.
  return String(text)
    .replace(/<(?:tool_call|function_call|arg_key|arg_value)\b[^>]*\/\s*>/gi, '')
    .replace(/<(tool_call|function_call)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(arg_key|arg_value)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:tool_call|function_call|arg_key|arg_value)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/?(?:tool_call|function_call|arg_key|arg_value)\b[^>]*\/?\s*>/gi, '');
}

function verifyChatNumbers(answer, options = {}) {
  const sources = evidence(options), unknown = [];
  let precedingProse = '';
  for (const block of blocks(String(answer || ''))) {
    if (block.kind === 'code' && !codeHasFinancialContext(block, precedingProse)) continue;
    if (block.kind === 'mermaid') {
      const claim = diagramClaimText(block.text);
      unknown.push(...unsupported(claim.text, sources, { diagram: claim.numeric, scenario: precedingScenario(precedingProse) }));
    } else {
      for (const chunk of proseChunks(block.text)) unknown.push(...unsupported(chunk.text, sources, { scenario: chunk.scenario }));
      if (block.kind === 'prose' && block.text.trim()) precedingProse = block.text;
    }
  }
  return { valid: unknown.length === 0,
    unsupportedNumbers: [...new Set(unknown.map(token => token.value ?? token.raw))],
    scenarioInputs: [...sources.scenarioInputs] };
}

function sanitizeChatNumbers(answer, options = {}) {
  const original = String(answer || ''), sources = evidence(options), kept = [];
  let precedingProse = '';
  for (const block of blocks(original)) {
    if (block.kind === 'code') {
      if (!codeHasFinancialContext(block, precedingProse) || !unsupported(block.text, sources).length) kept.push(block.text);
      continue;
    }
    if (block.kind === 'mermaid') {
      const claim = diagramClaimText(block.text);
      if (!unsupported(claim.text, sources, { diagram: claim.numeric, scenario: precedingScenario(precedingProse) }).length) kept.push(block.text);
      continue;
    }
    // Preserve valid rows and sentences instead of deleting an entire answer.
    const prose = stripPseudoToolProtocol(block.text);
    const chunks = proseChunks(prose);
    kept.push(chunks.filter(chunk => !unsupported(chunk.text, sources, { scenario: chunk.scenario }).length).map(chunk => chunk.text).join(''));
    if (prose.trim()) precedingProse = prose;
  }
  let text = kept.join('').replace(/\n{3,}/g, '\n\n').trim();
  // A table whose body was rejected must not leave a misleading empty header.
  text = text.replace(/(^|\n)(\|[^\n]+\|\n\|[\s:|\-]+\|)(?=\n(?:\n|[^|])|$)/g, '$1');
  return { answer: text, changed: text !== original.trim(), ...verifyChatNumbers(text, options) };
}

function buildPublishedNumberFacts(datasets = [], { language = 'zh' } = {}) {
  const english = language === 'en', parts = [];
  const sources = evidence({ datasets });
  const safeText = (text, fallback = '') => unsupported(String(text), sources).length ? fallback : String(text);
  const displayLabel = column => safeText(english ? String(column.key).replace(/([a-z])([A-Z])/g, '$1 $2') : column.label || column.key,
    english ? 'value' : '保存数值');
  for (const dataset of datasets.slice(0, 4)) {
    const columns = (dataset.columns || []).filter(column => NUMERIC_TYPES.has(column.type));
    const identities = (dataset.columns || []).filter(column => ['text', 'date'].includes(column.type));
    const rows = [];
    for (const row of (dataset.rows || []).slice(0, 4)) {
      const fields = columns.filter(column => normalizedNumber(row[column.key]) != null)
        .sort((a, b) => Number(normalizedNumber(row[a.key]) === '0') - Number(normalizedNumber(row[b.key]) === '0'))
        .slice(0, 6).map(column => `${displayLabel(column)} ${row[column.key]}`);
      if (!fields.length) continue;
      const identity = identities.map(column => row[column.key]).filter(value => typeof value === 'string' && value.length <= 100
        && (!english || !/[\u4e00-\u9fff]/.test(value))).slice(0, 2).join(' · ');
      const safeIdentity = safeText(identity);
      rows.push(`${safeIdentity ? safeIdentity + '：' : ''}${fields.join(english ? ', ' : '，')}`);
    }
    if (!rows.length) continue;
    const title = english ? 'Published figures' : safeText(dataset.title || '已保存记录', '已保存记录');
    parts.push(`${title}：${rows.join(english ? '; ' : '；')}。`);
  }
  return parts.join('\n\n');
}

module.exports = { verifyChatNumbers, sanitizeChatNumbers, buildPublishedNumberFacts, normalizedNumber };
