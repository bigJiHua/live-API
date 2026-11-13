// Short dates are normalized to an exact ISO source date only after the line's
// evidence identifies one current query and one unique legal date.
const SHORT_DATE = /(?<![\d.\-])((?:0?[1-9]|1[0-2]))-((?:0?[1-9]|[12]\d|3[01]))(?![\d.\-])/g;
const ISO_DATE = /^(20\d{2})-(\d{2})-(\d{2})(?:$|[T ])/;
const LEGAL_DATE = date => /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z'))
  && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
const CHINESE_RANGE = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:至|到|～|~|—|–|-)\s*(?:(20\d{2})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/g;
function normalizeVerifiedDateRanges(sentence, datasets = []) {
  let unsupported = false;
  const text = String(sentence || '').replace(CHINESE_RANGE, (token, year, month, day, endYear, endMonth, endDay) => {
    const date = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const startDate = date(year, month, day), endDate = date(endYear || year, endMonth || month, endDay);
    const matching = datasets.filter(dataset => dataset.queryMeta?.queryId && ['requestedScope', 'effectiveScope'].some(key =>
      dataset.queryMeta[key]?.startDate === startDate && dataset.queryMeta[key]?.endDate === endDate));
    if (!LEGAL_DATE(startDate) || !LEGAL_DATE(endDate) || startDate > endDate || !matching.length) { unsupported = true; return token; }
    return `${startDate}至${endDate}`;
  });
  return { text, unsupported };
}
function stripVerifiedShortDates(sentence, datasets = []) {
  const ranges = normalizeVerifiedDateRanges(sentence, datasets);
  sentence = ranges.text;
  let unsupported = ranges.unsupported;
  const text = String(sentence || '').replace(SHORT_DATE, (token, month, day, offset) => {
    const before = sentence.slice(0, offset), after = sentence.slice(offset + token.length);
    // "金额06-18元" is not a date. Accepted forms are list dates, 日/号,
    // date-labelled fields and standalone dates before a transaction value.
    const ordinalPrefix = /^\s*(?:[-*]\s*|\d+[.)）、]\s*)?$/.test(before);
    const datePrefix = /(?:日期|发生于|发生日期|交易日期|日期为|date)[：: ]*$/i.test(before);
    const dateSuffix = /^(?:日|号|\s+(?:支出|收入|收支|消费)|\s*[：:])/i.test(after);
    const monthAnnotation = /(20\d{2})-(0[1-9]|1[0-2])\s*[（(]\s*截至\s*$/.exec(before);
    if (monthAnnotation) {
      const exactDate = `${monthAnnotation[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const publishedMonth = `${monthAnnotation[1]}-${monthAnnotation[2]}`;
      const matches = datasets.filter(dataset => dataset.queryMeta?.queryId && dataset.queryMeta.effectiveScope?.endDate === exactDate
        && dataset.columns?.some(column => column.key === 'month' && column.type === 'date')
        && dataset.rows?.some(row => row.month === publishedMonth));
      if (!LEGAL_DATE(exactDate) || Number(monthAnnotation[2]) !== Number(month) || new Set(matches.map(dataset => dataset.queryMeta.queryId)).size !== 1) {
        unsupported = true; return token;
      }
      return exactDate;
    }
    if (/^\s*(?:元|块|人民币|美元|欧元|CNY|USD|EUR)/i.test(after)
      || /(?:金额|余额|费用|应还|待还)\s*[:：]?\s*$/.test(before)) return token;
    if (!ordinalPrefix && !datePrefix && !dateSuffix) return token;
    const rows = datasets.flatMap(dataset => {
      const dateKeys = (dataset.columns || []).filter(column => column.type === 'date').map(column => column.key);
      if (!dataset.queryMeta?.queryId) return [];
      return (dataset.rows || []).flatMap(row => dateKeys.map(key => {
        const date = ISO_DATE.exec(String(row[key] || ''));
        return date && LEGAL_DATE(date[0].slice(0, 10)) && Number(date[2]) === Number(month) && Number(date[3]) === Number(day)
          ? { dataset, row, date: date[0].slice(0, 10) } : null;
      }).filter(Boolean));
    });
    // If the line contains numeric row values, they must identify at least one
    // matching dated row; a valid day elsewhere cannot validate wrong detail.
    const matching = rows.filter(({ dataset, row }) => {
      let ownText = after;
      for (const column of dataset.columns || []) if (column.type === 'text') {
        const label = String(row[column.key] ?? '').trim();
        if (label.length >= 2 && ownText.includes(label)) ownText = ownText.split(label).join(' ');
      }
      const amountTokens = (ownText.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(value => Number(value.replace(/,/g, '')));
      const values = (dataset.columns || []).filter(column => ['money', 'number', 'decimal'].includes(column.type))
        .map(column => Number(row[column.key])).filter(Number.isFinite).map(Math.abs);
      return !amountTokens.length || amountTokens.every(number => values.includes(Math.abs(number)));
    });
    const identities = new Set(matching.map(({ dataset, date }) => dataset.queryMeta.queryId + '|' + date));
    if (identities.size !== 1) { unsupported = true; return token; }
    return matching[0].date;
  });
  return { text, unsupported };
}
// Calendar quantities are proven by the query scope, not by accidentally
// matching a monetary amount or record count. Keep the user's date wording in
// the answer; only remove proven calendar tokens during numeric verification.
function stripVerifiedMonthlyCalendarTokens(sentence, datasets = []) {
  const monthly = datasets.filter(dataset => dataset.datasetId === 'finance-monthly');
  if (!monthly.length || monthly.length !== datasets.length) return { text: String(sentence || ''), unsupported: false };
  const scoped = monthly.filter(dataset => dataset.queryMeta?.queryId
    && LEGAL_DATE(dataset.queryMeta.effectiveScope?.startDate)
    && LEGAL_DATE(dataset.queryMeta.effectiveScope?.endDate));
  let unsupported = false;
  let text = String(sentence || '').replace(/(?:最近|近|过去)\s*(\d+)\s*个?月/g, (token, count) => {
    const matches = scoped.filter(dataset => {
      const scope = dataset.queryMeta.effectiveScope;
      const monthIndex = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
      return scope.startDate.endsWith('-01') && Number(count) === monthIndex(scope.endDate) - monthIndex(scope.startDate) + 1;
    });
    if (new Set(matches.map(dataset => dataset.queryMeta.queryId)).size !== 1) { unsupported = true; return token; }
    return ' ';
  });
  text = text.replace(/(?:截至|截止|(?:仅)?统计(?:到|至))\s*(\d{1,2})\s*(?:日|号)|(?:才过(?:了)?|已过(?:了)?|前)\s*(\d{1,2})\s*天/g, (token, cutoffDay, elapsedDay, offset) => {
    const day = cutoffDay || elapsedDay;
    const before = text.slice(0, offset);
    const month = [...before.matchAll(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月|\b(20\d{2})-(\d{2})\b/g)].at(-1);
    if (!month) { unsupported = true; return token; }
    const matches = scoped.filter(dataset => {
      const scope = dataset.queryMeta.effectiveScope, end = scope.endDate;
      const year = month[1] || month[3] || (scope.startDate.slice(0, 4) === end.slice(0, 4) ? end.slice(0, 4) : null);
      const targetMonth = year + '-' + (month[2] || month[4]).padStart(2, '0');
      return end === targetMonth + '-' + day.padStart(2, '0')
        && dataset.columns?.some(column => column.key === 'month' && column.type === 'date')
        && dataset.rows?.some(row => row.month === targetMonth);
    });
    if (new Set(matches.map(dataset => dataset.queryMeta.queryId)).size !== 1) { unsupported = true; return token; }
    return ' ';
  });
  return { text, unsupported };
}
module.exports = { stripVerifiedShortDates, normalizeVerifiedDateRanges, stripVerifiedMonthlyCalendarTokens };
