const { AiError } = require('./errors');

const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const units = { 十: 10n, 百: 100n, 千: 1000n, 万: 10000n, 亿: 100000000n };
function canonical(amount) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(amount));
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, ''), fraction = (match[3] || '').replace(/0+$/, '');
  return `${match[1] === '-' && (integer !== '0' || fraction) ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`;
}
function literalNumber(input) {
  const text = input.normalize('NFKC').replace(/负/g, '-').replace(/正/g, '+');
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return canonical(text);
  const scaled = /^([+-]?\d+(?:\.\d+)?)(万|亿|千|百)$/.exec(text);
  if (scaled) return multiply(scaled[1], units[scaled[2]]);
  const match = /^([+-]?)([^点]+)(?:点(.+))?$/.exec(text);
  if (!match) return null;
  const sign = match[1] === '-' ? '-' : '', whole = match[2];
  let amount;
  if (/^[零〇一二两三四五六七八九]+$/.test(whole)) amount = BigInt([...whole].map(char => digits[char]).join(''));
  else {
    let result = 0n, section = 0n, number = 0n;
    for (const char of whole) {
      if (/\d/.test(char)) { number = number * 10n + BigInt(char); continue; }
      if (Object.hasOwn(digits, char)) { number = BigInt(digits[char]); continue; }
      const unit = units[char];
      if (!unit) return null;
      if (unit < 10000n) { section += (number || 1n) * unit; number = 0n; }
      // 万 settles the sub-万 section; 亿 settles the whole section. Multiplying
      // the running total at 万 would scale an earlier 亿 once more.
      else if (unit === 10000n) { section = (section + number) * unit; number = 0n; }
      else { result = (result + section + number) * unit; section = 0n; number = 0n; }
    }
    amount = result + section + number;
  }
  let fraction = '';
  if (match[3]) {
    fraction = [...match[3]].map(char => /\d/.test(char) ? char : digits[char]).join('');
    if (!/^\d{1,4}$/.test(fraction)) return null;
  }
  return canonical(`${sign}${amount}${fraction ? '.' + fraction : ''}`);
}
function multiply(value, multiplier) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value || '');
  if (!match) return null;
  const scale = 10n ** BigInt((match[3] || '').length);
  const result = (BigInt(match[2]) * scale + BigInt(match[3] || '0')) * multiplier;
  const padded = result.toString().padStart((match[3] || '').length + 1, '0');
  return canonical(`${match[1]}${match[3] ? padded.slice(0, -match[3].length) + '.' + padded.slice(-match[3].length) : padded}`);
}
// Only verifies the monetary literal chosen by the model. No function here identifies intent, chooses data or assigns a category.
function moneyLiteralOccurrences(input, entities = []) {
  let text = input.normalize('NFKC');
  for (const entity of entities) if (entity.name?.length >= 2) text = text.split(entity.name.normalize('NFKC')).join(' ');
  text = text.replace(/负(?=[0-9零〇一二两三四五六七八九])/g, '-').replace(/正(?=[0-9零〇一二两三四五六七八九])/g, '+')
    .replace(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/g, ' ').replace(/\d{8,}/g, ' ');
  const values = [];
  const consumed = [];
  const numeral = '[+-]?(?:\\d+(?:\\.\\d{1,4})?(?:[万亿千百](?:\\d+[万千百十]?)*)?|[零〇一二两三四五六七八九十][零〇一二两三四五六七八九十百千万亿]*(?:点[0-9零〇一二两三四五六七八九]+)?)';
  const boundary = '(?<![0-9.点零〇一二两三四五六七八九十百千万亿])';
  const digit = '[0-9零〇一二两三四五六七八九]';
  const fractionEnd = '(?!\\s*(?:块钱?|元|圆|毛|角|分|年|月|日|号|笔|个|次|张|位|公斤|千克|斤|克|包|袋|瓶|盒|件))(?=[\\s，。！？,.;!?]|$|然后|再|又|买|的|付|零食)';
  const fraction = `(?:\\s*${digit}\\s*(?:毛|角)(?:\\s*${digit}\\s*分|\\s*${digit}${fractionEnd})?|\\s*${digit}\\s*分|\\s*${digit}${fractionEnd})?`;
  for (const match of text.matchAll(new RegExp(`${boundary}(${numeral})\\s*(?:块钱?|元|圆)(${fraction})`, 'g'))) {
    const integer = literalNumber(match[1]);
    if (integer == null) continue;
    consumed.push([match.index, match.index + match[0].length]);
    if (match[2].trim() && /^\d+$/.test(integer)) {
      const suffix = [...match[2].matchAll(/([0-9零〇一二两三四五六七八九])\s*(毛|角|分)?/g)];
      let tenths = '0', hundredths = '';
      for (let index = 0; index < suffix.length; index++) {
        if (suffix[index][2] === '分' || index === 1) hundredths = literalNumber(suffix[index][1]);
        else tenths = literalNumber(suffix[index][1]);
      }
      const fractional = `${tenths}${hundredths}`;
      values.push(canonical(`${integer}.${fractional}`));
    } else values.push(integer);
  }
  for (const match of text.matchAll(new RegExp(`${boundary}${numeral}`, 'g'))) {
    if (consumed.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const before = text.slice(Math.max(0, match.index - 10), match.index).replace(/\s/g, ''), after = text.slice(match.index + match[0].length).trimStart();
    if (match[0] === '零' && after.startsWith('食')) continue;
    if (/[零〇一二两三四五六七八九十百千万亿]/.test(match[0]) && !/\d/.test(match[0])) {
      const leftBoundary = !before || !/[\u4e00-\u9fffA-Za-z0-9]$/.test(before) ||
        /(?:花了|花费|花|支付了|支付|付了|用了|用|支出|收入|收到|收了|金额|价格|共|总计|合计|买了|为|是)$/.test(before);
      const rightBoundary = !after || !/^[\u4e00-\u9fffA-Za-z0-9]/.test(after) || /^(?:的|元|块|毛|角|分|万|千|买|支付|付款|零食)/.test(after);
      if (!leftBoundary || !rightBoundary) continue;
    }
    if (/(?:尾号|编号|账号|卡号|末[四4]位|后[四4]位|末尾[四4]位)(?:为|是|[:：])?$/.test(before) ||
      /^(?:年|月|日|号|笔|个|次|张|位)/.test(after)) continue;
    const numeric = literalNumber(match[0]);
    if (numeric == null) continue;
    const multiplier = /^\s*(万|千)(?:元|块|人民币)?/.exec(after)?.[1];
    values.push(multiplier ? multiply(numeric, units[multiplier]) : numeric);
    if (multiplier) consumed.push([match.index, match.index + match[0].length + /^\s*(万|千)/.exec(after)[0].length]);
  }
  return values;
}
function moneyLiterals(input, entities = []) {
  return new Set(moneyLiteralOccurrences(input, entities));
}
// Repair only an omitted evidence envelope. Existing model-selected evidence is
// never rewritten, and amounts/intent/accounts remain subject to the usual guards.
// Occurrences, rather than distinct values, prevent guessing between equal amounts.
function recoverMissingAmountEvidence(proposed, userTurns, entities = []) {
  const amount = proposed?.fields?.amount;
  if (proposed?.kind !== 'transaction.create' || proposed.evidence != null || proposed.fields?.currency !== 'CNY'
    || typeof amount !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(amount)
    || !/[1-9]/.test(amount) || !Array.isArray(userTurns) || userTurns.length > 16) return proposed;
  const normalized = canonical(amount);
  const sources = [];
  for (let sourceTurn = 0; sourceTurn < userTurns.length; sourceTurn++) {
    const source = userTurns[sourceTurn];
    if (typeof source !== 'string' || !source || source.length > 1500) continue;
    for (const literal of moneyLiteralOccurrences(source, entities)) if (literal === normalized) sources.push(sourceTurn);
  }
  if (sources.length !== 1) return proposed;
  const sourceTurn = sources[0];
  const source = userTurns[sourceTurn];
  const explicitRecording = /记账|记一笔|记录|录入|入账/.test(source);
  if (!explicitRecording && /查|查看|看看|看一下|统计|汇总|多少|哪(?:一|天|笔|个|家)|是不是|是否|[吗么?？]/.test(source)) return proposed;
  return { ...proposed, evidence: { sourceTurn, quote: source } };
}
function validateAmountEvidence(proposed, amount, userTurns, entities = []) {
  const evidence = proposed.evidence, source = evidence && userTurns[evidence.sourceTurn];
  if (typeof amount !== 'string' || !canonical(amount) || !source || !source.includes(evidence.quote)) throw new AiError(evidence == null
    ? '模型草稿未给出可核对的原话引用，本轮未生成草稿；请重发这笔交易。'
    : '草稿金额缺少用户原话依据，请明确金额后再试', 400, 'AI_AMOUNT_NOT_EXPLICIT');
  const normalized = canonical(amount);
  if (!moneyLiterals(source, entities).has(normalized) || !moneyLiterals(evidence.quote, entities).has(normalized)) throw new AiError('模型金额与引用原话不一致，已停止生成草稿', 400, 'AI_AMOUNT_NOT_EXPLICIT');
}
function validateDateEvidence(date, source, sourceDate, today = sourceDate) {
  const invalid = () => { throw new AiError('草稿日期缺少明确来源，请写明日期后再试', 400, 'AI_DATE_NOT_EXPLICIT'); };
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) invalid();
  const instant = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date || date > today) invalid();
  const expected = new Set(), text = source.normalize('NFKC').replace(/(\d)\s*(年|月|日|号)/g, '$1$2').replace(/(年|月)\s*(?=\d)/g, '$1');
  const anchor = typeof sourceDate === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(sourceDate) ? new Date(`${sourceDate}T00:00:00Z`) : null;
  const base = anchor && Number.isFinite(anchor.getTime()) && anchor.toISOString().slice(0, 10) === sourceDate && sourceDate <= today ? anchor : null;
  const iso = value => value.toISOString().slice(0, 10);
  for (const [word, offset] of [['今天', 0], ['今日', 0], ['昨天', -1], ['昨日', -1], ['前天', -2], ['前日', -2]]) {
    if (text.includes(word) && base) expected.add(iso(new Date(base.getTime() + offset * 86400000)));
  }
  for (const match of text.matchAll(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|号)?/g)) expected.add(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
  for (const match of text.matchAll(/(?:(去年|前年|今年))?(\d{1,2})月(\d{1,2})(?:日|号)/g)) {
    if (!base) continue;
    // A month/day already preceded by an explicit year must not also acquire the anchor's year.
    if (/20\d{2}年$/.test(text.slice(Math.max(0, match.index - 5), match.index))) continue;
    const year = base.getUTCFullYear() - (match[1] === '去年' ? 1 : match[1] === '前年' ? 2 : 0);
    expected.add(`${year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
  }
  for (const match of text.matchAll(/(\d{1,3})天前/g)) if (base) expected.add(iso(new Date(base.getTime() - Number(match[1]) * 86400000)));
  for (const match of text.matchAll(/(上|这|本)?(?:周|星期)([一二三四五六日天])/g)) {
    if (!base) continue;
    const target = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[match[2]];
    const day = base.getUTCDay(), mondayOffset = (day + 6) % 7, targetOffset = (target + 6) % 7;
    const offset = match[1] === '上' ? -mondayOffset - 7 + targetOffset : match[1] ? -mondayOffset + targetOffset : -((day - target + 7) % 7);
    expected.add(iso(new Date(base.getTime() + offset * 86400000)));
  }
  // Missing date defaults to the trusted application date, while unsupported explicit relative dates require clarification.
  if (!expected.size && /20\d{2}年|去年|前年|上周|上个月|前几天|以前|过去|明天|后天|下周|下个月/.test(text)) invalid();
  if (!expected.size && base) expected.add(sourceDate);
  if (!expected.size) invalid();
  if (!expected.has(date)) invalid();
}
module.exports = { canonical, literalNumber, moneyLiterals, recoverMissingAmountEvidence, validateAmountEvidence, validateDateEvidence };
