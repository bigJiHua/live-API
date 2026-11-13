// Text label spacing does not change a card identity; named repayment money
// still needs a matching approved row, including any stated date/bill month.
function normalizeNumericTextLabels(sentence, labels = []) {
  let text = String(sentence || '');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ordered = [...labels].filter(label => typeof label === 'string' && /\d/.test(label))
    .sort((a,b) => b.replace(/\s/g, '').length - a.replace(/\s/g, '').length);
  for (const label of ordered) {
    const compact = Array.from(label).filter(char => !/\s/.test(char));
    if (compact.length < 2) continue;
    const pattern = compact.map(escape).join('[ \\t]*') + (/\d$/.test(label.trim()) ? '(?!\\d)' : '');
    text = text.replace(new RegExp(pattern, 'g'), () => label);
  }
  return text;
}
function cents(raw) {
  const value = String(raw ?? '').replace(/,/g, '').replace(/^−/, '-');
  const parts = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!parts) return null;
  const amount = BigInt(parts[2]) * 100n + BigInt((parts[3] || '').padEnd(2, '0'));
  return parts[1] === '-' ? -amount : amount;
}
function validRepaymentAmountClaims(sentence, datasets = []) {
  const rows = datasets.filter(dataset => dataset.datasetId === 'card-repayments').flatMap(dataset => dataset.rows || []);
  if (!rows.length) return true;
  const text = String(sentence || ''), names = [...new Set(rows.map(row => String(row.name || '')).filter(Boolean))];
  const named = names.flatMap(name => [...text.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))]
    .filter(match => !/\d$/.test(name) || !/\d/.test(text[match.index + name.length] || ''))
    .map(match => ({ name, index: match.index, end: match.index + name.length }))).sort((a,b) => a.index - b.index || b.end - a.end);
  if (!named.length) return true; // Anonymous aggregate prose keeps the existing published-number guard.
  // A decimal/exponent continuing a numeric card name is not a separate amount.
  if (named.some(item => /\d$/.test(item.name) && /^(?:[.．]\d|[eE][+-]?\d)/.test(text.slice(item.end)))) return false;
  const pattern = /(?:CNY|人民币|[¥￥])\s*([-+−]?\d[\d,]*(?:\.\d+)?)|([-+−]?\d[\d,]*(?:\.\d+)?)\s*(?:元|CNY|人民币)|(?<!\d)([-+−]?\d[\d,]*\.\d{1,2})(?!\d)/g;
  for (const token of text.matchAll(pattern)) {
    if (named.some(item => token.index >= item.index && token.index + token[0].length <= item.end)) continue;
    if (named.some(item => token.index < item.end && token.index + token[0].length > item.index)) return false;
    const following = text.slice(token.index + token[0].length);
    if (/^\s*(?:笔|条|行|张|个)/.test(following)) continue;
    const prior = named.filter(item => item.end <= token.index).sort((a,b) => b.end - a.end)[0];
    const identity = prior || named.find(item => item.index >= token.index + token[0].length);
    if (!identity) continue;
    const next = named.find(item => item.index > Math.max(identity.index, token.index));
    const context = text.slice(Math.min(identity.index, token.index), next?.index ?? text.length);
    const dates = [...context.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map(match => match[0]);
    const months = [...context.matchAll(/\b20\d{2}-(?:0[1-9]|1[0-2])\b(?!-\d)/g)].map(match => match[0]);
    const possible = rows.filter(row => row.name === identity.name && (!dates.length || dates.includes(String(row.date || '').slice(0, 10)))
      && (!months.length || months.includes(row.month)));
    const value = cents(token[1] || token[2] || token[3]);
    if (value === null || !possible.some(row => row.amount != null && cents(row.amount) === value)) return false;
  }
  return true;
}
module.exports = { normalizeNumericTextLabels, validRepaymentAmountClaims };

