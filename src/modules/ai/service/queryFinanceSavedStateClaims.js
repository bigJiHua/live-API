const FINANCE_DATASETS = new Set(['finance-monthly', 'finance-categories', 'finance-transactions', 'finance-daily']);
const amountPattern = '-?\\d+(?:\\.\\d+)?';
// A matching decimal prefix does not prove an exponent, percentage, malformed
// decimal or other numeric token. Only an entire amount cell may bind.
const amountToken = amountPattern + '(?!,\\d)(?![ \\t]*(?:[eE][+-]?\\d|[%％]))(?=$|[ \\t、，,。；;！？\\n（）()元])';
const statePredicate = /(^|[。；;！？\n])([ \t]*(?:这些|上述(?:金额|数值|汇总值)?)[ \t]*是[ \t]*)当前已入账[ \t]*(?:（历史发生）|\(历史发生\))[ \t]*的[ \t]*汇总值(?=[，,。；;！？\n]|$)/g;
const decimal = value => {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const reduced = fraction.replace(/0+$/, '');
  const digits = whole.replace(/^0+(?=\d)/, '') + (reduced ? '.' + reduced : '');
  return (value.startsWith('-') && /[1-9]/.test(digits) ? '-' : '') + digits;
};
const validDate = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
function fullMonth(scope) {
  const last = new Date(Date.UTC(Number(scope.endDate.slice(0, 4)), Number(scope.endDate.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return scope.startDate.endsWith('-01') && scope.startDate.slice(0, 7) === scope.endDate.slice(0, 7) && scope.endDate === last;
}
function provesSummary(anchor, dataset) {
  const summary = dataset.summary;
  if (/^(?:如果|假如|假设|若)|(?:尚未入账|未入账|计划入账)/.test(anchor)) return false;
  if (/(?:全月|整月)/.test(anchor) && !fullMonth(dataset.queryMeta.effectiveScope)) return false;
  for (const [label, key] of [['已计入收入', 'income'], ['已计入支出', 'expense']]) {
    const occurrences = [...anchor.matchAll(new RegExp(label, 'g'))];
    const matches = [...anchor.matchAll(new RegExp(label + '[ \\t]*CNY[ \\t]*(' + amountToken + ')', 'g'))];
    if (!matches.length || matches.length !== occurrences.length || matches.some(match => decimal(match[1]) !== decimal(summary[key]))) return false;
  }
  for (const [label, key] of [['净收支', 'net'], ['赤字', 'deficit'], ['盈余', 'surplus']]) {
    const occurrences = [...anchor.matchAll(new RegExp(label, 'g'))];
    const matches = [...anchor.matchAll(new RegExp(label + '[ \\t]*[：:]?[ \\t]*(?:CNY[ \\t]*)?(' + amountToken + ')', 'g'))];
    if (matches.length !== occurrences.length || matches.some(match => decimal(match[1]) !== decimal(summary[key]))) return false;
  }
  return true;
}
function normalizeFinanceSavedStateClaims(text, datasets = []) {
  const original = String(text || '');
  const finance = datasets.filter(dataset => FINANCE_DATASETS.has(dataset.datasetId));
  // A numerical coincidence between different approved queries is not proof
  // of which summary the demonstrative "these" denotes.
  if (finance.length !== 1) return original;
  const dataset = finance[0], meta = dataset.queryMeta, summary = dataset.summary;
  const scope = meta?.effectiveScope;
  const moneyKeys = ['finance-monthly', 'finance-daily'].includes(dataset.datasetId) ? ['income', 'expense'] : ['amountCNY'];
  if (dataset.domain !== 'finance' || meta?.datasetId !== dataset.datasetId || !/^q_[a-f0-9]{24}$/.test(meta?.queryId || '')
    || meta.summaryComplete !== true || !validDate(scope?.startDate)
    || !validDate(scope?.endDate) || scope.startDate > scope.endDate
    || !moneyKeys.every(key => dataset.columns?.some(column => column.key === key && column.type === 'money'))
    || summary?.currency !== 'CNY' || summary.incomplete !== false || summary.unpricedCount !== 0
    || summary.startDate !== scope.startDate || summary.endDate !== scope.endDate
    || !Array.isArray(dataset.rows) || !Number.isSafeInteger(meta.matchedRowCount) || meta.matchedRowCount < 0
    || meta.returnedRowCount !== dataset.rows.length || meta.returnedRowCount > meta.matchedRowCount
    || !Number.isSafeInteger(meta.sourceRecordCount) || meta.sourceRecordCount !== summary.count
    || decimal(summary.income) === null || decimal(summary.expense) === null) return original;
  return original.replace(statePredicate, (whole, boundary, subject, offset) => {
    const prefix = original.slice(0, offset);
    const scopeRanges = [...prefix.matchAll(/(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(20\d{2}-\d{2}-\d{2})/g)];
    if (!scopeRanges.length || scopeRanges.some(range => range[1] !== scope.startDate || range[2] !== scope.endDate)) return whole;
    // Only the immediately preceding summary sentence in the same paragraph
    // can establish this historical data-state predicate. It cannot borrow
    // an old answer, an unrelated row value, or an execution receipt.
    const breakAt = prefix.lastIndexOf('\n\n');
    const paragraph = prefix.slice(breakAt < 0 ? 0 : breakAt + 2);
    const anchor = paragraph.split(/[。；;！？\n]/).at(-1)?.trim() || '';
    if (!provesSummary(anchor, dataset)) return whole;
    return boundary + subject + '已保存的收支汇总值';
  });
}
module.exports = { normalizeFinanceSavedStateClaims };
