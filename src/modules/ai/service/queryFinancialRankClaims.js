// Rank relationships require the same approved query, identity and money field.
// A value appearing somewhere in a shared numeric pool is not ranking evidence.
const FINANCE_IDS = new Set(['finance-daily', 'finance-monthly', 'finance-categories']);
const FIELDS = [['净收支|净结余|净收入', 'net'], ['(?<!净)支出|expense|spending', 'expense'], ['(?<!净)收入|income', 'income']];
const ORDINALS = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
const RANK = '(?:并列)?(?:第([1-9]\\d*|[一二三四五六七八九十])(?:高|大|多|低|少)|最(?:高|大|多|低|少))';
const MONEY = '(?:CNY|人民币|[¥￥])?\\s*((?:负|[-+−])?\\d[\\d,]*(?:\\.\\d+)?)';
function decimal(raw) {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).replace(/,/g, '').replace(/^负|^−/, '-');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = (match[3] || '').replace(/0+$/, '');
  return { coefficient:(match[1] === '-' ? -1n : 1n) * BigInt(match[2] + fraction), scale:fraction.length };
}
function compare(left, right) {
  const a = decimal(left), b = decimal(right);
  if (!a || !b) return null;
  const scale = Math.max(a.scale, b.scale), x = a.coefficient * 10n ** BigInt(scale-a.scale), y = b.coefficient * 10n ** BigInt(scale-b.scale);
  return x > y ? 1 : x < y ? -1 : 0;
}
function typed(dataset, key) { return dataset.columns?.some(column => column.key === key && ['money','decimal'].includes(column.type)); }
function validQuery(dataset) {
  const meta = dataset.queryMeta, scope = meta?.effectiveScope;
  return FINANCE_IDS.has(dataset.datasetId) && /^q_[a-f0-9]{24}$/.test(meta?.queryId || '') && scope
    && /^20\d{2}-\d{2}-\d{2}$/.test(scope.startDate) && /^20\d{2}-\d{2}-\d{2}$/.test(scope.endDate)
    && scope.startDate <= scope.endDate && Array.isArray(dataset.rows);
}
function negated(prefix) { return /(?:不是|并非|不代表|不能|无法|尚未|尚不能|不能确认|未确认|可能|也许|或许|待核实|否认)[^，,。；;！？\n]{0,35}$/.test(prefix); }
function statedScopes(sentence, scope) {
  const ranges = [...sentence.matchAll(/(20\d{2}-\d{2}-\d{2})\s*(?:至|到|to)\s*(20\d{2}-\d{2}-\d{2})/gi)]
    .map(match => ({ startDate:match[1], endDate:match[2], index:match.index, length:match[0].length }));
  for (const match of sentence.matchAll(/(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日\s*(?:至|到)\s*(?:(20\d{2})年\s*)?(?:(\d{1,2})月\s*)?(\d{1,2})日/g)) {
    const year = match[1] || scope.startDate.slice(0,4);
    ranges.push({ startDate:year+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0'),
      endDate:(match[4] || year)+'-'+(match[5] || match[2]).padStart(2,'0')+'-'+match[6].padStart(2,'0'), index:match.index, length:match[0].length });
  }
  return ranges;
}
function scopeMatches(sentence, dataset) {
  const scope = dataset.queryMeta.effectiveScope;
  for (const stated of statedScopes(sentence, scope))
    if (stated.startDate !== scope.startDate || stated.endDate !== scope.endDate) return false;
  if (/全月/.test(sentence)) {
    if (scope.startDate.slice(0,7) !== scope.endDate.slice(0,7) || !scope.startDate.endsWith('-01')) return false;
    const last = new Date(Date.UTC(Number(scope.endDate.slice(0,4)), Number(scope.endDate.slice(5,7)), 0)).toISOString().slice(0,10);
    if (scope.endDate !== last) return false;
  }
  return true;
}
function dayTokens(sentence, scope) {
  let body = sentence;
  for (const range of statedScopes(sentence, scope).sort((left,right) => right.index-left.index))
    body = body.slice(0,range.index)+' '+body.slice(range.index+range.length);
  return [...body.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b|(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日|(?<![\d-])(\d{1,2})月\s*(\d{1,2})日|(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g)]
    .map(match => match[1] || `${match[2] || scope.startDate.slice(0,4)}-${(match[3]||match[5]||match[7]).padStart(2,'0')}-${(match[4]||match[6]||match[8]).padStart(2,'0')}`);
}
function monthTokens(sentence, scope) {
  const body = sentence.replace(/20\d{2}-\d{2}-\d{2}/g, ' ').replace(/\d{1,2}月\s*\d{1,2}日/g, ' ');
  return [...body.matchAll(/\b(20\d{2})-(\d{2})(?![-\d])\b|(20\d{2})年\s*(\d{1,2})月|(?<![\d-])(\d{1,2})月/g)]
    .map(match => `${match[1] || match[3] || scope.startDate.slice(0,4)}-${(match[2]||match[4]||match[5]).padStart(2,'0')}`);
}
function selectRows(sentence, dataset, field) {
  const scope = dataset.queryMeta.effectiveScope;
  const key = dataset.datasetId === 'finance-categories' ? 'amountCNY' : field;
  if (!typed(dataset, key) || !scopeMatches(sentence, dataset)) return [];
  let selected;
  if (dataset.datasetId === 'finance-daily') {
    const dates = [...new Set(dayTokens(sentence, scope))];
    if (!dates.length) return [];
    selected = dataset.rows.filter(row => dates.includes(row.date));
    if (selected.length !== dates.length) return [];
  } else if (dataset.datasetId === 'finance-monthly') {
    const months = [...new Set(monthTokens(sentence, scope))];
    if (!months.length) return [];
    selected = dataset.rows.filter(row => months.includes(row.month));
    if (selected.length !== months.length) return [];
  } else {
    if (!['expense','income'].includes(field)) return [];
    const direction = field === 'expense' ? 0 : 1;
    selected = dataset.rows.filter(row => row.direction === direction && typeof row.category === 'string' && row.category.trim()
      && sentence.includes(row.category) && !dataset.rows.some(other => other.direction === direction && other.category !== row.category
        && String(other.category || '').startsWith(row.category) && sentence.includes(other.category)));
  }
  return selected.map(row => ({ dataset, row, key }));
}
function matchingColumnAmounts(sentence, selected) {
  for (const item of selected) for (const [aliases, field] of FIELDS) for (const claim of sentence.matchAll(new RegExp('(?:' + aliases + ')(?:金额)?\\s*(?:为|是|[:：=]|is)?\\s*' + MONEY, 'gi'))) {
    const key = item.dataset.datasetId === 'finance-categories' ? field === 'net' ? null : 'amountCNY' : field;
    if (!key || !typed(item.dataset, key) || compare(item.row[key], claim[1]) !== 0) return false;
    if (item.dataset.datasetId === 'finance-categories' && item.row.direction !== (field === 'expense' ? 0 : 1)) return false;
  }
  return true;
}
function rankProof(item, field, rank, ascending, tied, sentence) {
  const {dataset,row,key} = item, meta = dataset.queryMeta, value = row[key];
  if (decimal(value) === null) return false;
  const comparable = dataset.rows.filter(candidate => dataset.datasetId !== 'finance-categories' || candidate.direction === row.direction);
  if (comparable.some(candidate => decimal(candidate[key]) === null || Number(candidate.unpricedCount || 0) > 0)) return false;
  // Full displayed rows prove either direction. A ranked partial window proves
  // only its published field and descending ordering, never an unrelated field.
  const complete = meta.rowsComplete === true && meta.returnedRowCount === dataset.rows.length
    && meta.matchedRowCount === dataset.rows.length;
  const expectedSort = dataset.datasetId === 'finance-categories' ? 'categoryAmountDesc'
    : field === 'expense' ? 'expenseDesc' : field === 'income' ? 'incomeDesc' : null;
  if (!complete && !(meta.rankingComplete === true && !ascending && expectedSort && meta.sort === expectedSort)) return false;
  if (Number(dataset.summary?.unpricedCount || 0) > 0 || meta.rankingComplete !== true && !/已定价/.test(sentence)) return false;
  if (!complete && comparable.some((candidate,index) => index > 0 && compare(comparable[index-1][key],candidate[key]) < 0)) return false;
  const better = comparable.filter(candidate => { const valueOrder=compare(candidate[key],value);return ascending ? valueOrder < 0 : valueOrder > 0; });
  if (better.length + 1 !== rank) return false;
  if (tied && comparable.filter(candidate => compare(candidate[key],value) === 0).length < 2) return false;
  return true;
}
function financialRankIssues(sentence, datasets = []) {
  const finance = [...new Map(datasets.filter(validQuery).map(dataset => [dataset.queryMeta.queryId,dataset])).values()];
  if (!datasets.some(dataset => FINANCE_IDS.has(dataset.datasetId))) return [];
  const issues = [];
  for (const [aliases, field] of FIELDS) {
    const patterns = [new RegExp('(?:' + aliases + ')(?:金额|累计金额|累计)?\\s*(?:排名)?\\s*(' + RANK + ')','gi'),
      new RegExp('(' + RANK + ')(?:的)?\\s*(?:' + aliases + ')','gi')];
    for (const pattern of patterns) for (const claim of sentence.matchAll(pattern)) {
      if (negated(sentence.slice(0,claim.index)) || /[？?]\s*$/.test(sentence)) continue;
      const rankToken = claim[1], numeral = claim[2], rank = numeral ? Number(numeral) || ORDINALS[numeral] : 1;
      const ascending = /低|少/.test(rankToken), tied = /并列/.test(rankToken);
      const selected = finance.flatMap(dataset => selectRows(sentence,dataset,field));
      const queryIds = new Set(selected.map(item => item.dataset.queryMeta.queryId));
      const identities = new Set(selected.map(item => JSON.stringify([item.dataset.queryMeta.queryId,item.row.date,item.row.month,item.row.category,item.row.direction])));
      const supported = queryIds.size === 1 && selected.length > 0 && (identities.size === 1 || tied)
        && matchingColumnAmounts(sentence, selected) && selected.every(item => rankProof(item,field,rank,ascending,tied,sentence))
        && (!tied || selected.every(item => compare(item.row[item.key],selected[0].row[selected[0].key]) === 0));
      if (!supported) issues.push({field,rank,ascending,tied,claim:claim[0],index:claim.index,queryIds:[...queryIds]});
    }
  }
  return issues;
}
function normalizeFinancialRankClaims(text, datasets = []) {
  return (String(text || '').match(/[^。；;！？\n]+[。；;！？]?|\n+/g) || []).map(sentence => {
    const issues = financialRankIssues(sentence,datasets);
    if (!issues.length) return sentence;
    // A false trailing rank annotation must not erase independently verified
    // row date/amount/count facts. Every removed rank must be inside annotations.
    const annotations = [...sentence.matchAll(/[（(][^）)]*[）)]/g)];
    if (!issues.every(issue => annotations.some(annotation => issue.index > annotation.index && issue.index < annotation.index + annotation[0].length))) return '';
    const stripped = sentence.replace(/[（(][^）)]*[）)]/g, annotation => /最高|最大|最多|最低|最少|第[一二三四五六七八九十\d]+[高大多低少]/.test(annotation) ? '' : annotation);
    const bindings = datasets.filter(validQuery).flatMap(dataset => selectRows(stripped,dataset,issues[0].field));
    if (bindings.length !== 1 || !matchingColumnAmounts(stripped,bindings)) return '';
    const aliases = FIELDS.find(([,field]) => field === issues[0].field)?.[0];
    if (!aliases || !new RegExp('(?:' + aliases + ')(?:金额)?\\s*(?:为|是|[:：=]|is)?\\s*' + MONEY,'i').test(stripped)) return '';
    return stripped;
  }).join('').replace(/\n{3,}/g,'\n\n');
}
module.exports = { compare, financialRankIssues, normalizeFinancialRankClaims };
