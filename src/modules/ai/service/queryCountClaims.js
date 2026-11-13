// Count claims must match their meaning; an equal monetary value is not evidence.
const { namedRowCountEvidence, validTypedRowCountClaims, validFundRecordCountClaims } = require('./queryRowCountClaims');
function validCountClaims(sentence, datasets = []) {
  if (!validTypedRowCountClaims(sentence, datasets) || !validFundRecordCountClaims(sentence, datasets)) return false;
  const finance = datasets.filter(dataset => dataset.domain === 'finance');
  if (!finance.length) return true;
  const pattern = /((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(笔|条|行|组)/g;
  for (const token of sentence.matchAll(pattern)) {
    const value = Number(token[1].replace(/,/g, ''));
    if (!Number.isSafeInteger(value)) return false;
    const before = sentence.slice(0, token.index);
    if (/[-−负]\s*$/.test(before)) return false;
    const prefix = before.split(/[，,。；;！？\n]/).at(-1).trim();
    const after = sentence.slice(token.index + token[0].length);
    const returnedMatch = /(?:返回|展示|显示|列出|截取)(?:了|的)?\s*(支出|收入)?\s*(?:前|最近)?\s*(?:共|共有|总共)?\s*$/.exec(prefix);
    const returned = Boolean(returnedMatch);
    const direction = returnedMatch?.[1]
      || returned && /(支出|收入)\s*(?:已|本次|本轮)?\s*(?:返回|展示|显示|列出|截取)/.exec(prefix)?.[1]
      || /(支出|收入)(?:流水|记录|明细)?\s*(?:笔数)?\s*(?:共|共有|一共|共计|有|为|是)?\s*$/.exec(prefix)?.[1]
      || /^\s*(支出|收入)/.exec(after)?.[1];
    // Range endpoints identify a whole query, not the final monthly row. A
    // later explicit "10月共..." still binds its own row count.
    const rangePattern = /\b(20\d{2}-\d{2}-\d{2})\s*(?:至|到|～|~|—|–)\s*(20\d{2}-\d{2}-\d{2})\b/g;
    const ranges = [...before.matchAll(rangePattern)];
    const countBefore = ranges.length ? before.replace(rangePattern, ' ')
      .replace(/(?:\d{1,2}\s*月\s*)?仅统计(?:到|至)\s*\d{1,2}\s*日/g, ' ') : before;
    const month = [...countBefore.matchAll(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月|((?:20\d{2})-\d{2})-\d{2}/g)].at(-1);
    const candidates = finance.filter(dataset => {
      if (ranges.length && !ranges.every(range => dataset.queryMeta?.effectiveScope.startDate === range[1]
        && dataset.queryMeta?.effectiveScope.endDate === range[2])) return false;
      if (!month || !dataset.queryMeta) return true;
      const start = dataset.queryMeta.effectiveScope.startDate.slice(0, 7), end = dataset.queryMeta.effectiveScope.endDate.slice(0, 7);
      const target = month[3] || `${month[1] || start.slice(0, 4)}-${month[2].padStart(2, '0')}`;
      return start <= target && target <= end;
    });
    const rowEvidence = returned ? null : namedRowCountEvidence(countBefore, after, candidates, value, token[2], null, month);
    if (rowEvidence === true) continue;
    if (rowEvidence === false) return false;
    const sourceWords = /^(?:\s*的)?\s*(?:流水|交易|收支|记录|明细)/.test(after);
    const supported = candidates.some(dataset => {
      const meta = dataset.queryMeta, summary = dataset.summary || {};
      let expected;
      if (returned) {
        if (!meta || (token[2] === '笔' || token[2] === '条' && sourceWords) && dataset.datasetId !== 'finance-transactions'
          || token[2] === '组' && dataset.datasetId !== 'finance-categories') return false;
        if (direction) {
          const wanted = direction === '支出' ? 'expense' : 'income';
          const code = direction === '支出' ? 0 : 1;
          if (meta.filters.direction !== wanted && !(dataset.rows.length > 0 && dataset.rows.every(row => row.direction === code))) return false;
        }
        expected = meta.returnedRowCount;
      } else if (direction && ['笔', '条'].includes(token[2])) {
        expected = summary[direction === '支出' ? 'expenseCount' : 'incomeCount'];
      } else if (token[2] === '笔' || token[2] === '条' && (sourceWords || dataset.datasetId === 'finance-transactions')) {
        expected = meta ? meta.sourceRecordCount : summary.count;
        if (month && dataset.datasetId === 'finance-monthly') {
          const target = month[3] || `${month[1] || meta?.effectiveScope.startDate.slice(0, 4) || ''}-${month[2].padStart(2, '0')}`;
          const rows = dataset.rows.filter(row => row.month === target);
          if (rows.length === 1) expected = rows[0].count;
        }
      } else {
        if (token[2] === '组' && dataset.datasetId !== 'finance-categories') return false;
        expected = meta ? meta.matchedRowCount : !dataset.truncated ? dataset.rows.length : null;
      }
      return expected != null && Number(expected) === value;
    });
    if (!supported) return false;
  }
  return true;
}

module.exports = { validCountClaims };
