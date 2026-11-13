// Fund money claims need their own row, field and date. A shared numeric value
// on another fund (or another day) cannot authorize a claim.
const FUND_IDS = new Set(['fund-holdings', 'fund-history']);
const FIELD_ALIASES = '已登记收益合计|登记收益合计|累计收益|总收益|收益合计|本金增量合计|增持本金合计|累计增持本金|总增持本金|登记本金|本金增量|本金变化|本金变动|收益增量|每日收益|日收益|登记市值|市值|本金|收益|total\\s+capital\\s+delta|total\\s+profit|registered\\s+principal|capital\\s+delta|registered\\s+profit|market\\s+value|principal|profit';
const CLAIM_PATTERN = new RegExp('(' + FIELD_ALIASES + ')(?:\\s*(?:(?:仍|依然|依旧|始终|均)?(?:为|是)(?:\\s*约)?|保持(?:为|在)?|维持(?:为|在)?|约|[:：=]|(?:still\\s+)?(?:is|was)|remains?(?:\\s+at)?|continues?\\s+to\\s+be|of))?\\s*(?:CNY|USD|EUR|GBP|人民币)?\\s*((?:负|[-+−])?\\d[\\d,]*(?:\\.\\d+)?|零|zero)', 'gi');
function decimalValue(raw) {
  const value = String(raw ?? '').replace(/,/g, '').replace(/^负|^−/, '-').replace(/^(?:零|zero)$/i, '0');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const digits = whole.replace(/^0+(?=\d)/, '') + (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '');
  return /^0(?:\.0*)?$/.test(digits) ? '0' : (negative ? '-' : '') + digits;
}
function fieldKey(alias, datasetId) {
  if (/市值|market\s+value/i.test(alias)) return datasetId === 'fund-holdings' ? 'marketValue' : null;
  if (/本金|principal|capital\s+delta/i.test(alias)) return datasetId === 'fund-history'
    ? /增量|变化|变动|capital\s+delta/i.test(alias) ? 'capitalDelta' : null
    : /增量|变化|变动|capital\s+delta/i.test(alias) ? null : 'principal';
  if (/收益|profit/i.test(alias)) return datasetId === 'fund-holdings' && /增量|每日|日收益/.test(alias)
    || datasetId === 'fund-history' && /合计|registered\s+profit/.test(alias) ? null : 'profit';
  return null;
}
function lastFundName(before, after, rows) {
  const matches = [];
  for (const row of rows) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    let index = before.lastIndexOf(name);
    while (index >= 0) {
      const tail = before.slice(index + name.length) + after;
      // A known short name cannot match the prefix of a different fund name.
      if (!tail || /^[\s：:，,。；;！？\/|()（）]/.test(tail) || /^(?:20\d{2}[-年]|\d{1,2}月\s*\d{1,2}日|\d{2}-\d{2}(?!\d))/.test(tail)
        || /^(?:近|最近|过去)?(?:[一二两三四五六七八九十]|\d{1,2})年/.test(tail)
        || new RegExp('^(?:的)?(?:' + FIELD_ALIASES + ')', 'i').test(tail)) {
        matches.push({ name, index, end: index + name.length }); break;
      }
      if (index === 0) break;
      index = before.lastIndexOf(name, index - 1);
    }
  }
  matches.sort((a, b) => b.end - a.end || b.name.length - a.name.length);
  return matches[0]?.name || null;
}
function implicitFundContext(before, resolution = 'detail') {
  const contextual = ['month', 'year'].includes(resolution)
    ? before.replace(/\b20\d{2}-\d{2}\b|20\d{2}年\s*\d{1,2}月|\b20\d{2}年/g, '') : before;
  const remaining = contextual.replace(new RegExp(CLAIM_PATTERN.source, CLAIM_PATTERN.flags), '')
    .replace(/\b20\d{2}-\d{2}-\d{2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{1,2}月\s*\d{1,2}日|(?<![\d-])\d{2}-\d{2}(?![\d-])/g, '')
    .replace(/^\s*(?:[（(]\d+[）)]|\d+[.)、）．](?!\d))\s*/, '')
    .replace(/[\s：:，,。；;！？\/|()（）-]/g, '');
  return /^(?:(?:该基金|本基金|这只基金|基金|说明|登记记录|登记情况))*$/.test(remaining);
}
function claimedDate(before, scope) {
  const tokens = [...before.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b|(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日|(?<![\d-])(\d{1,2})月\s*(\d{1,2})日|(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g)];
  const token = tokens.at(-1);
  if (!token) return null;
  if (token[1]) return token[1];
  if (token[2]) return `${token[2]}-${token[3].padStart(2,'0')}-${token[4].padStart(2,'0')}`;
  const year = scope?.startDate?.slice(0,4);
  if (!year || year !== scope?.endDate?.slice(0,4)) return null;
  return `${year}-${(token[5] || token[7]).padStart(2,'0')}-${(token[6] || token[8]).padStart(2,'0')}`;
}
const legalDate = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function completeHistorySummary(dataset) {
  const meta = dataset.queryMeta, requested = meta?.requestedScope, effective = meta?.effectiveScope;
  return dataset.datasetId === 'fund-history' && meta?.summaryComplete === true
    && dataset.summary?.incomplete !== true && dataset.summary?.currency !== 'unverified'
    && Number.isSafeInteger(meta.sourceRecordCount) && meta.sourceRecordCount >= 0
    && legalDate(requested?.startDate) && legalDate(requested?.endDate)
    && legalDate(effective?.startDate) && legalDate(effective?.endDate)
    && requested.startDate === effective.startDate && requested.endDate === effective.endDate
    && requested.startDate <= requested.endDate;
}
function periodToken(before, scope, resolution) {
  if (resolution !== 'month' && resolution !== 'year') return claimedDate(before, scope);
  // A daily label must never borrow a monthly/yearly total.
  if (/\b20\d{2}-\d{2}-\d{2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{1,2}月\s*\d{1,2}日/.test(before)) return null;
  if (resolution === 'month') {
    const explicit = [...before.matchAll(/\b(20\d{2})-(\d{2})(?![-\d])|(20\d{2})年\s*(\d{1,2})月(?!\s*\d{1,2}日)/g)].at(-1);
    if (explicit) {
      const value = (explicit[1] || explicit[3]) + '-' + (explicit[2] || explicit[4]).padStart(2, '0');
      return legalDate(value + '-01') ? value : null;
    }
    const month = [...before.matchAll(/(?<![\d年])(\d{1,2})月(?!\s*\d{1,2}日)/g)].at(-1)?.[1];
    const year = scope?.startDate?.slice(0, 4);
    const value = year && year === scope?.endDate?.slice(0, 4) && month ? year + '-' + month.padStart(2, '0') : null;
    return value && legalDate(value + '-01') ? value : null;
  }
  if (/\b20\d{2}-\d{2}\b|\d{1,2}月/.test(before)) return null;
  return [...before.matchAll(/\b(20\d{2})(?:年)?(?![-\d])/g)].at(-1)?.[1] || null;
}
function aggregateField(alias) {
  if (/市值|market\s+value/i.test(alias)) return null;
  if (/本金|capital\s+delta/i.test(alias)) return /增量|变化|变动|增持|capital\s+delta/i.test(alias) ? 'capitalDelta' : null;
  return /收益|profit/i.test(alias) ? 'profit' : null;
}
function summaryRangeMatches(before, scope) {
  const dates = [...before.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b|(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/g)]
    .map(match => match[1] || match[2] + '-' + match[3].padStart(2, '0') + '-' + match[4].padStart(2, '0'));
  if (dates.length) return dates.length === 2 && dates[0] === scope.startDate && dates[1] === scope.endDate
    || dates.length === 1 && scope.startDate === scope.endDate && dates[0] === scope.startDate;
  const month = periodToken(before, scope, 'month');
  if (month) return scope.startDate.slice(0, 7) === month && scope.endDate.slice(0, 7) === month;
  if (/\b20\d{2}-\d{2}\b|(?:20\d{2}年)?\s*\d{1,2}月/.test(before)) return false;
  const years = [...before.matchAll(/\b(20\d{2})年/g)].map(match => match[1]);
  if (years.length) return years.length === 1 && scope.startDate.slice(0, 4) === years[0] && scope.endDate.slice(0, 4) === years[0];
  const counts = [...before.matchAll(/(?:近|最近|过去)?([一二两三四五六七八九十]|\d{1,2})年/g)];
  if (counts.length) {
    const numbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const amount = numbers[counts.at(-1)[1]] || Number(counts.at(-1)[1]);
    const days = (Date.parse(scope.endDate) - Date.parse(scope.startDate)) / 86400000;
    return amount > 0 && days >= amount * 365 - 1 && days <= amount * 366 + 1;
  }
  return true;
}
function summaryContext(before, alias, name, dataset) {
  const meta = dataset.queryMeta, scope = meta?.effectiveScope;
  if (!completeHistorySummary(dataset) || !/合计|累计|总|汇总|total|aggregate|overall/i.test(before + alias)
    || !summaryRangeMatches(name ? before.split(name).join('') : before, scope)) return false;
  if (name) {
    const rows = dataset.rows || [];
    const refs = new Set(rows.map(row => row.fundRef || row.fundId || row.name));
    if (meta.filters?.text !== name || meta.rowsComplete !== true || !rows.length
      || rows.some(row => row.name !== name) || refs.size !== 1) return false;
  }
  // Generic portfolio language is allowed; an unknown fund name must not
  // inherit the portfolio total merely because no returned name matched it.
  const plain = (name ? before.split(name).join('') : before)
    .replace(new RegExp(CLAIM_PATTERN.source, CLAIM_PATTERN.flags), '')
    .replace(/\b20\d{2}-\d{2}-\d{2}\b|\b20\d{2}-\d{2}\b|20\d{2}年|(?:近|最近|过去)?[一二两三四五六七八九十\d]+年|\d{1,2}月\s*\d{1,2}日|\d{1,2}月/g, '')
    .replace(/本次|本轮|所选|查询|完整|整个|全范围|范围|区间|所有|全部|基金|组合|持仓|收益|增持|本金|保存|登记|合计|累计|总|汇总|以内|内|已|为|是|元|CNY|人民币|from|through|to|all|funds?|portfolio|overall|total|registered|saved|profit|capital|delta/gi, '')
    .replace(/[\s：:，,。；;！？\/|()（）·至到—–-]/g, '');
  return plain === '';
}
// A field followed by a monetary value must not bypass row/date evidence
// merely because the model chose an unsupported connector. Dates and record
// counts are metadata, not monetary claims. Canonical row facts remain separate.
function unparsedFundAmountClaim(sentence) {
  const claims = [...sentence.matchAll(new RegExp(CLAIM_PATTERN.source, CLAIM_PATTERN.flags))];
  if (claims.some(token => /^\s*(?:%|％|‰|‱|(?:个)?百分点|千分比|百分比|percent(?:age)?(?:s)?(?:\s+points?)?\b|per\s+cent\b|basis\s+points?\b|bps?\b)/i.test(sentence.slice(token.index + token[0].length)))) return true;
  const recognized = claims.map(token => ({start: token.index, end: token.index + token[1].length}));
  const fields = new RegExp('(' + FIELD_ALIASES + ')(?![A-Za-z])', 'gi');
  for (const field of sentence.matchAll(fields)) {
    if (recognized.some(token => token.start < field.index + field[0].length && token.end > field.index)
      || /^[A-Za-z]/.test(field[1]) && /[A-Za-z_]/.test(sentence[field.index - 1] || '')) continue;
    let tail = sentence.slice(field.index + field[0].length).split(/[。；;！？\n]/)[0];
    const nextField = new RegExp(FIELD_ALIASES, 'i').exec(tail);
    if (nextField) tail = tail.slice(0, nextField.index);
    tail = tail.replace(/\b20\d{2}-\d{2}-\d{2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{1,2}月\s*\d{1,2}日|(?<![\d-])\d{2}-\d{2}(?![\d-])/g, ' ')
      .replace(/(?:[-+−]?\d[\d,]*(?:\.\d+)?|零|zero)\s*(?:条|行|笔|张|个|天|日|月|年|次|页|期|rows?\b|records?\b|entries\b|days?\b|months?\b|years?\b)/gi, ' ');
    if (/(?<![A-Za-z_\d])(?:(?:负|[-+−])?\d[\d,]*(?:\.\d+)?|零|\bzero\b)/i.test(tail)) return true;
  }
  return false;
}
function validFundAmountClaims(sentence, datasets = []) {
  const funds = datasets.filter(dataset => FUND_IDS.has(dataset.datasetId));
  if (!funds.length) return true;
  const allRows = funds.flatMap(dataset => dataset.rows || []);
  const onlyFunds = funds.length === datasets.length;
  if (!onlyFunds && !allRows.some(row => sentence.includes(String(row.name || ''))) && !/基金|登记本金|登记市值|收益增量|本金增量/.test(sentence)) return true;
  if (unparsedFundAmountClaim(String(sentence || ''))) return false;
  for (const token of String(sentence || '').matchAll(new RegExp(CLAIM_PATTERN.source, CLAIM_PATTERN.flags))) {
    const before = sentence.slice(0, token.index), after = sentence.slice(token.index);
    const name = lastFundName(before, after, allRows);
    const value = decimalValue(token[2]);
    const summaries = funds.flatMap(dataset => {
      const key = aggregateField(token[1]);
      if (!key || !summaryContext(before, token[1], name, dataset) || decimalValue(dataset.summary?.[key]) === null) return [];
      return [{ value: decimalValue(dataset.summary[key]), identity: JSON.stringify(['summary', dataset.datasetId,
        dataset.queryMeta.effectiveScope, dataset.queryMeta.filters?.text || '', key]) }];
    });
    if (new Set(summaries.map(item => item.identity)).size === 1 && summaries.some(item => item.value === value)) continue;
    const possible = funds.flatMap(dataset => {
      const resolution = dataset.queryMeta?.resolution || 'detail';
      const key = fieldKey(token[1], dataset.datasetId) || (dataset.datasetId === 'fund-history' && ['month', 'year'].includes(resolution)
        ? aggregateField(token[1]) : null);
      if (!key || !(dataset.columns || []).some(column => column.key === key && ['money', 'decimal'].includes(column.type))) return [];
      const date = periodToken(name ? before.split(name).join('') : before, dataset.queryMeta?.effectiveScope, resolution);
      const names = new Set((dataset.rows || []).map(row => row.name));
      const selectedName = name || (names.size === 1 && implicitFundContext(before, resolution) ? [...names][0] : null);
      if (!selectedName) return [];
      return (dataset.rows || []).filter(row => row.name === selectedName && (dataset.datasetId !== 'fund-history' || date && row.date === date))
        .map(row => ({ row, key, identity: JSON.stringify([dataset.datasetId, dataset.queryMeta?.effectiveScope,
          row.fundRef || row.fundId || row.name, row.date]) }));
    });
    const identities = new Set(possible.map(item => item.identity));
    if (value === null || identities.size !== 1 || !possible.some(item => decimalValue(item.row[item.key]) === value)) return false;
  }
  return true;
}
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const saved = value => value == null ? '未登记' : cell(value);
function fundQueryFacts(datasets = []) {
  return datasets.filter(dataset => FUND_IDS.has(dataset.datasetId)).map(dataset => {
    const rows = dataset.rows || [], history = dataset.datasetId === 'fund-history';
    const summaryLines = [];
    if (completeHistorySummary(dataset)) {
      const summary = dataset.summary, fields = [];
      if (decimalValue(summary.profit) !== null) fields.push('已保存收益合计 ' + saved(summary.profit));
      if (decimalValue(summary.capitalDelta) !== null) fields.push('本金增量合计 ' + saved(summary.capitalDelta));
      if (fields.length) summaryLines.push(dataset.queryMeta.effectiveScope.startDate + ' 至 ' + dataset.queryMeta.effectiveScope.endDate
        + (dataset.queryMeta.filters?.text ? '（文字筛选“' + cell(dataset.queryMeta.filters.text) + '”）' : '')
        + '：' + fields.join('，') + '，来源 ' + dataset.queryMeta.sourceRecordCount + ' 笔登记。');
    }
    const grain = history && ['month', 'year'].includes(dataset.queryMeta?.resolution)
      ? ['展示粒度：按' + (dataset.queryMeta.resolution === 'year' ? '年' : '月') + '汇总。'] : [];
    if (!rows.length && !summaryLines.length) return `${dataset.title}：所选范围没有已保存记录，不代表本金或收益为零。`;
    const lines = rows.map(row => history
      ? `- ${cell(row.name)} · ${cell(row.date)}：收益增量 ${saved(row.profit)}，本金增量 ${saved(row.capitalDelta)}。`
      : `- ${cell(row.name)}：登记本金 ${saved(row.principal)}，已登记收益合计 ${saved(row.profit)}，登记市值 ${saved(row.marketValue)}。`);
    const partial = dataset.queryMeta?.rowsComplete === false || dataset.truncated;
    return [`${dataset.title}：`, ...summaryLines, ...grain, ...lines,
      !rows.length ? '所选范围没有已保存记录，登记合计不代表未登记时期的实际本金或收益。' : '',
      partial ? '以上为本次返回的部分登记记录，不能相加作为完整合计。' : '',
      history ? '未登记日期不补零，以上是保存的收益与本金增量。' : '以上是目前已保存的基金登记，不重建历史时点或自行求整体合计。'].filter(Boolean).join('\n');
  }).join('\n\n');
}
function fundQueryExplanation(text, datasets) {
  const funds = datasets.filter(dataset => FUND_IDS.has(dataset.datasetId)), names = funds.flatMap(dataset => (dataset.rows || []).map(row => String(row.name || '')));
  return String(text || '').split(/(?<=[。；;！？])|\n+/).filter(part => {
    const value = part.trim();
    if (!value || /^\|/.test(value)) return false;
    const plain = value.replace(/^\s*(?:[（(]\d+[）)]|\d+(?:[.．](?!\d)|[)）、])|[-•])\s*/, '');
    const direct = names.some(name => name && plain.startsWith(name)) || /^20\d{2}-\d{2}-\d{2}/.test(plain);
    return !(direct && new RegExp(CLAIM_PATTERN.source, CLAIM_PATTERN.flags).test(plain));
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
module.exports = { validFundAmountClaims, fundQueryFacts, fundQueryExplanation, decimalValue };
