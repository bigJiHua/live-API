const { compare } = require('./queryFinancialRankClaims');
const NUMBER = '(?:[-+−]?\\d[\\d.,eE+%％\\-]*(?:[ \\t]*[%％])?|[零〇一二两三四五六七八九十百]+)';
const CONDITION = '(?:净(?:收支|结余|收入)\\s*(?:为?正(?:数)?|大于\\s*(?:0|零)|[>＞]\\s*0|为?负(?:数)?|小于\\s*(?:0|零)|[<＜]\\s*0|为?零|等于\\s*(?:0|零)|[=＝]\\s*0|未知|未定价|无法确认)|收入\\s*(?:大于|高于|多于|超过|[>＞]|小于|低于|少于|[<＜]|等于|[=＝])\\s*支出)';
const conditionPatterns = [
  new RegExp('(?:仅有|只有|共有|总共|共|有)?\\s*(' + NUMBER + ')\\s*天\\s*(' + CONDITION + ')', 'g'),
  new RegExp('(' + CONDITION + ')(?:的)?\\s*(?:天数|日期数|日期)(?:为|是|共有|共|有|[：:])?\\s*(' + NUMBER + ')(?:\\s*天)?', 'g'),
  new RegExp('(' + CONDITION + ')(?:的)?\\s*(?:共有|总共|共|有|为|是)\\s*(' + NUMBER + ')\\s*天', 'g'),
];
const validDate = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
function integer(token) {
  if (/^\d+$/.test(token)) { const value = Number(token); return Number.isSafeInteger(value) ? value : null; }
  if (/\d/.test(token)) return null;
  if (!/^(?:[零〇一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九]百(?:[零〇]?[一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?)?)$/.test(token)) return null;
  const digits = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  let result = 0, current = 0;
  for (const char of token) {
    if (Object.hasOwn(digits, char)) current = digits[char];
    else if (char === '十' || char === '百') { result += (current || 1) * (char === '十' ? 10 : 100); current = 0; }
    else return null;
  }
  return result + current;
}
function predicate(condition) {
  const field = /^收入/.test(condition) ? 'comparison' : 'net';
  const state = /未知|未定价|无法确认/.test(condition) ? 'unknown'
    : /负|小于|低于|少于|[<＜]/.test(condition) ? 'negative'
      : /为?零|等于|[=＝]/.test(condition) ? 'zero' : 'positive';
  return { field, state };
}
const typed = (dataset, key, type = 'money') => dataset.columns?.some(column => column.key === key && column.type === type);
function ranges(text, scope) {
  const found = [...text.matchAll(/(20\d{2}-\d{2}-\d{2})\s*(?:至|到|to|~|～)\s*(20\d{2}-\d{2}-\d{2})/gi)]
    .map(match => ({ startDate:match[1], endDate:match[2], index:match.index, length:match[0].length }));
  for (const match of text.matchAll(/(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日?\s*(?:至|到)\s*(?:(20\d{2})年\s*)?(?:(\d{1,2})月\s*)?(\d{1,2})日/g)) {
    const year = match[1] || scope.startDate.slice(0,4);
    found.push({ startDate:year + '-' + match[2].padStart(2,'0') + '-' + match[3].padStart(2,'0'),
      endDate:(match[4] || year) + '-' + (match[5] || match[2]).padStart(2,'0') + '-' + match[6].padStart(2,'0'), index:match.index, length:match[0].length });
  }
  return found;
}
function scopeMatches(text, dataset) {
  const scope = dataset.queryMeta.effectiveScope;
  if (ranges(text, scope).some(range => range.startDate !== scope.startDate || range.endDate !== scope.endDate)) return false;
  if (/(?:全月|整月)/.test(text)) {
    const last = new Date(Date.UTC(Number(scope.endDate.slice(0,4)), Number(scope.endDate.slice(5,7)), 0)).toISOString().slice(0,10);
    if (!scope.startDate.endsWith('-01') || scope.startDate.slice(0,7) !== scope.endDate.slice(0,7) || scope.endDate !== last) return false;
  }
  let withoutRanges = text;
  for (const range of ranges(text,scope).sort((a,b) => b.index-a.index)) withoutRanges = withoutRanges.slice(0,range.index) + ' '.repeat(range.length) + withoutRanges.slice(range.index+range.length);
  const months = [...withoutRanges.matchAll(/\b(20\d{2})-(\d{2})(?![-\d])\b|(?:(20\d{2})年\s*)?(\d{1,2})月(?!\s*\d{1,2}日)/g)];
  for (const month of months) {
    const target = (month[1] || month[3] || scope.startDate.slice(0,4)) + '-' + (month[2] || month[4]).padStart(2,'0');
    if (target !== scope.startDate.slice(0,7) || target !== scope.endDate.slice(0,7)) return false;
  }
  return dataset.queryMeta.filters?.direction === 'both' && (dataset.queryMeta.filters.text === ''
    || typeof dataset.queryMeta.filters.text === 'string' && text.includes(dataset.queryMeta.filters.text));
}
function validSource(dataset, field) {
  const meta = dataset.queryMeta, scope = meta?.effectiveScope;
  const keys = field === 'net' ? ['net'] : ['income', 'expense'];
  return dataset.datasetId === 'finance-daily' && dataset.domain === 'finance' && meta?.datasetId === dataset.datasetId
    && /^q_[a-f0-9]{24}$/.test(meta?.queryId || '') && validDate(scope?.startDate) && validDate(scope?.endDate) && scope.startDate <= scope.endDate
    && meta.version === 1 && meta.rowsComplete === true && dataset.truncated !== true && Array.isArray(dataset.rows) && meta.returnedRowCount === dataset.rows.length && meta.matchedRowCount === dataset.rows.length
    && typed(dataset,'date','date') && typed(dataset,'unpricedCount','number') && keys.every(key => typed(dataset,key)) && dataset.summary?.currency === 'CNY'
    && Number.isSafeInteger(meta.sourceRecordCount) && meta.sourceRecordCount === dataset.summary.count
    && dataset.rows.every(row => validDate(row.date) && row.date >= scope.startDate && row.date <= scope.endDate)
    && new Set(dataset.rows.map(row => row.date)).size === dataset.rows.length;
}
function rowState(row, dataset, field) {
  if (!Number.isSafeInteger(row.unpricedCount) || row.unpricedCount !== 0) return 'unknown';
  const order = field === 'net' ? compare(row.net,'0') : compare(row.income,row.expense);
  return order === null ? 'unknown' : order > 0 ? 'positive' : order < 0 ? 'negative' : 'zero';
}
function calendarCoverage(text, dataset, state) {
  if (!['zero','unknown'].includes(state)) return true;
  // GROUP BY yields registered date rows; a missing calendar date supplies
  // neither a zero net value nor a known/unknown money cell. Zero/unknown
  // counts must state they concern registered dates or cover every date.
  if (/(?:有记录|有流水|已登记|已保存记录|匹配记录)(?:的)?(?:日期|天|日)/.test(text)) return true;
  const scope=dataset.queryMeta.effectiveScope;
  const span=(Date.parse(scope.endDate+'T00:00:00Z')-Date.parse(scope.startDate+'T00:00:00Z'))/86400000+1;
  return dataset.rows.length===span;
}
function dateTokens(text, scope) {
  let body = text;
  for (const range of ranges(text,scope).sort((a,b) => b.index-a.index)) body = body.slice(0,range.index) + ' '.repeat(range.length) + body.slice(range.index+range.length);
  const tokens = [], singleYear = scope.startDate.slice(0,4) === scope.endDate.slice(0,4);
  let month = scope.startDate.slice(0,7) === scope.endDate.slice(0,7) ? scope.startDate.slice(5,7) : null;
  for (const match of body.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b|(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日|(?<![\d年月.\-])(\d{1,2})日/g)) {
    const year = match[2] || (singleYear ? scope.startDate.slice(0,4) : null);
    if (match[1]) { month=match[1].slice(5,7); tokens.push({ date:match[1], index:match.index, length:match[0].length }); continue; }
    if (match[3]) month = match[3].padStart(2,'0');
    const date = year && month ? year + '-' + month + '-' + (match[4] || match[5]).padStart(2,'0') : null;
    tokens.push({ date, index:match.index, length:match[0].length });
  }
  return tokens;
}
function listProves(text, claim, dataset, expected) {
  const after = text.slice(claim.index + claim.length);
  const listStart = /^\s*(?:[：:]|[，,]?\s*分别(?:为|是)|[，,]?\s*(?:日期|具体日期)(?:为|是)[：:]?)/.exec(after);
  if (!listStart) return true;
  const list = after.slice(listStart[0].length).split(/——|—{2,}|其中|但是|但仍/)[0];
  const tokens = dateTokens(list,dataset.queryMeta.effectiveScope), expectedDates = new Set(expected.map(row => row.date));
  if (tokens.some(token => !token.date || !expectedDates.has(token.date))) return false;
  const open = /例如|比如|举例|部分|包括/.test(list);
  if (!open && (tokens.length !== expectedDates.size || new Set(tokens.map(token=>token.date)).size !== expectedDates.size)) return false;
  // Dates with parenthesized money values inherit the declared net predicate.
  // Verify each amount against that exact same date row, not any other cell.
  for (const [index,token] of tokens.entries()) {
    const tail = list.slice(token.index+token.length, tokens[index+1]?.index);
    const amount = /^\s*[（(]\s*(?:净(?:收支|结余|收入)\s*[：:]?\s*)?([+\-−]?\d+(?:\.\d+)?)\s*(?:元)?\s*[）)]/.exec(tail);
    if (!amount) {
      if (/^\s*[（(]/.test(tail) && /\d/.test(tail.split(/[）)]/)[0])) return false;
      const labelled = /净(?:收支|结余|收入)\s*[：:]?\s*([+\-−]?\d+(?:\.\d+)?)(?=\s*(?:元|[，,、。；;！？]|$))/.exec(tail);
      if (/净(?:收支|结余|收入)\s*[：:]?\s*[-+−]?\d/.test(tail) && !labelled) return false;
      if (labelled && (!typed(dataset,'net') || compare(expected.find(row=>row.date===token.date).net,labelled[1]) !== 0)) return false;
      continue;
    }
    const row = expected.find(row => row.date === token.date);
    if (!typed(dataset,'net') || compare(row.net,amount[1]) !== 0) return false;
  }
  return true;
}
function claims(text) {
  return conditionPatterns.flatMap((pattern,patternIndex) => [...String(text || '').matchAll(pattern)].map(match => {
    const number = match[patternIndex === 0 ? 1 : 2], condition = match[patternIndex === 0 ? 2 : 1];
    return { match, number, condition, numberIndex:match.index + (patternIndex === 0 ? match[0].indexOf(number) : match[0].lastIndexOf(number)) };
  }));
}
function dailyConditionIssues(text, datasets = []) {
  if (!datasets.some(dataset => dataset.datasetId === 'finance-daily')) return [];
  const issues = [];
  for (const {match,number,condition} of claims(text)) {
    if (/(?:不能确认|无法确认|尚未确认|不代表|不是|未证明)[^。；;！？\n]{0,30}$/.test(text.slice(0,match.index)) || /[？?]\s*$/.test(text)) continue;
    const value = integer(number), kind = predicate(condition);
    const candidates = datasets.filter(dataset => dataset.datasetId === 'finance-daily' && validDate(dataset.queryMeta?.effectiveScope?.startDate)
      && validDate(dataset.queryMeta?.effectiveScope?.endDate) && scopeMatches(text,dataset));
    const sources = candidates.length === 1 ? candidates.filter(dataset => validSource(dataset,kind.field)) : [];
    const queries = new Set(sources.map(dataset => dataset.queryMeta.queryId));
    const claim = { index:match.index, length:match[0].length };
    const proven = value !== null && sources.length === 1 && queries.size === 1 && sources.every(dataset => {
      const expected = dataset.rows.filter(row => rowState(row,dataset,kind.field) === kind.state);
      return calendarCoverage(text,dataset,kind.state) && expected.length === value && listProves(text,claim,dataset,expected);
    });
    if (!proven) issues.push({ claim:match[0], index:match.index, field:kind.field, state:kind.state, value, queryIds:[...queries] });
  }
  return issues;
}
function stripProvenDailyConditionCountTokens(text, datasets = []) {
  const original = String(text || '');
  if (!datasets.some(dataset => dataset.datasetId === 'finance-daily') || dailyConditionIssues(original,datasets).length) return original;
  let body = original;
  for (const claim of claims(original).sort((a,b) => b.numberIndex-a.numberIndex))
    body = body.slice(0,claim.numberIndex) + ' '.repeat(claim.number.length) + body.slice(claim.numberIndex+claim.number.length);
  return body;
}
function normalizeDailyConditionClaims(text, datasets = []) {
  return (String(text || '').match(/[^。；;！？\n]+[。；;！？]?|\n+/g) || []).map(sentence =>
    /^\n+$/.test(sentence) || !dailyConditionIssues(sentence,datasets).length ? sentence : '').join('').replace(/\n{3,}/g,'\n\n');
}
module.exports = { dailyConditionIssues, normalizeDailyConditionClaims, stripProvenDailyConditionCountTokens, rowState };
