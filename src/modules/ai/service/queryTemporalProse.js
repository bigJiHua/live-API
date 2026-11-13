// Clock text is evidence only as a timestamp on the same approved source row.
const { rowIdentityLabels, rowHasPrimaryIdentity, lastIdentityIndex } = require('./queryRowCountClaims');
const SAVED_TIME_FIELDS = new Set(['updatedAt', 'recordedAt', 'minUpdatedAt', 'maxUpdatedAt']);
const SAVED_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?$/;
const CLOCK_TOKEN = /(?<![\d.])\d{1,3}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?(?![\d.:])/g;
const LEGAL_CLOCK = /^((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?$/;
const TEMPORAL_WORD = /(?:最后|最早|最新)?(?:保存|更新|记录|创建|发生|读取|快照)\s*(?:时间|于)?[：:]?\s*$|(?:saved|updated|recorded|created|timestamp|time)(?:\s+at)?[：:]?\s*$/i;
const MONEY_PREFIX = /(?:金额|余额|支出|收入|费用|应还|待还)[^，,；;|\n]{0,30}$/;
const MONEY_SUFFIX = /^\s*(?:元|人民币|美元|欧元|英镑|CNY|USD|EUR|GBP)(?:\b|$|[，,。；;！？])/;
function validSavedTime(value) {
  const match = typeof value === 'string' ? SAVED_TIMESTAMP.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(match[1] + 'T00:00:00Z'))
    || new Date(match[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== match[1]) return null;
  if (match[3] && match[3] !== 'Z' && !/^[+-](?:0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/.test(match[3])) return null;
  return match;
}
function isSavedTimestamp(value) { return Boolean(validSavedTime(value)); }
function stripVerifiedClockTokens(sentence, datasets = [], { proofOnlyZoneLabels = false } = {}) {
  const verifiedSpans = [];
  const sourceRows = datasets.flatMap(dataset => (dataset.rows || []).map(row => ({
    labels: rowIdentityLabels(row), primary: rowHasPrimaryIdentity(row), currency: row.currency,
    timestamps: (dataset.columns || []).filter(column => ['text', 'date'].includes(column.type) && (SAVED_TIME_FIELDS.has(column.key)
      || dataset.datasetId === 'card-repayments' && column.key === 'date'))
      .map(column => validSavedTime(String(row[column.key] || ''))).filter(Boolean),
  })));
  let unsupported = false, lastClock = null;
  const text = String(sentence || '').replace(CLOCK_TOKEN, (token, offset) => {
    const before = sentence.slice(0, offset), after = sentence.slice(offset + token.length);
    let date = /(\d{4}-\d{2}-\d{2})[T \t]+$/.exec(before);
    const isRangeEnd = !date && lastClock && /^\s*(?:至|到|~|～|—|-)\s*$/.test(sentence.slice(lastClock.end, offset));
    if (isRangeEnd) date = [lastClock.date, lastClock.date];
    const dateOffset = isRangeEnd ? lastClock.dateOffset : date ? offset - date[0].length : offset;
    const datePrefix = sentence.slice(0, dateOffset).split(/[，,。；;！？\n|]/).at(-1);
    const temporal = TEMPORAL_WORD.test(datePrefix);
    const money = MONEY_SUFFIX.test(after) || MONEY_PREFIX.test(datePrefix) && !temporal;
    // Ratios receive no clock exemption. Explicit currency or timestamp text
    // cannot authorize malformed clocks or clocks from a different date/row.
    if (!date && !temporal && !money) return token;
    const legal = LEGAL_CLOCK.exec(token);
    if (!date || !legal || money) { unsupported = true; lastClock = null; return token; }
    const named = sourceRows.flatMap(row => row.labels.map(label => ({ row, label, index: lastIdentityIndex(before, label) })))
      .filter(item => item.index >= 0).sort((a, b) => Number(b.row.primary) - Number(a.row.primary) || b.index + b.label.length - a.index - a.label.length);
    if (!named.length && sourceRows.some(row => row.labels.length)) { unsupported = true; lastClock = null; return token; }
    const rowContext = named.length ? before.slice(named[0].index) : datePrefix;
    const currency = /\b(?:CNY|USD|EUR|GBP|JPY|HKD|AUD|CAD|CHF|SGD)\b|未登记/.exec(rowContext)?.[0];
    const rows = named.length ? named.filter(item => item.index === named[0].index && item.label === named[0].label)
      .map(item => item.row).filter(row => !currency || !row.currency || row.currency === currency) : sourceRows;
    const matches = rows.flatMap(row => row.timestamps.filter(saved => saved[1] === date[1]
      && (saved[2] === legal[1] || saved[2].startsWith(legal[1] + ':') || saved[2].startsWith(legal[1] + '.'))
      && (!legal[2] || legal[2] === saved[3])));
    const zones = [...new Set(matches.map(saved => saved[3] || null))];
    const prefixZone = /(?:[（(]\s*)?(UTC(?:\+08:00)?|GMT(?:\+08:00)?|北京时间|上海时间|Asia\/Shanghai|CST)(?:\s*[）)])?\s*$/i.exec(sentence.slice(0, dateOffset));
    const suffixZone = /^\s*(?:[（(]\s*)?(UTC(?:\+08:00)?|GMT(?:\+08:00)?|北京时间|上海时间|Asia\/Shanghai|CST)(?:\s*[）)])?(?=$|[，,。；;！？\n|])/i.exec(after);
    const declared = [prefixZone?.[1], suffixZone?.[1]].filter(Boolean);
    const declaredZones = declared.map(label => /^(?:UTC|GMT)$/i.test(label) ? 'Z' : '+08:00');
    const verified = matches.length > 0 && zones.length === 1
      && (!isRangeEnd || lastClock.sourceZone === zones[0])
      && (proofOnlyZoneLabels || declaredZones.every(zone => zone === zones[0]));
    if (!verified) { unsupported = true; lastClock = null; return token; }
    verifiedSpans.push({token, offset, dateOffset, end: offset + token.length, isRangeEnd: Boolean(isRangeEnd), sourceZone: zones[0]});
    lastClock = { date: date[1], dateOffset, end: offset + token.length, sourceZone: zones[0] };
    return ' ';
  });
  return { text, unsupported, verifiedSpans };
}
module.exports = { isSavedTimestamp, stripVerifiedClockTokens };
