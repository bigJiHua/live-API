const CARD_TYPES = Object.freeze(['credit', 'debit', 'virtual_cash', 'virtual_balance', 'virtual_wechat', 'virtual_alipay']);
const BANK_ALIASES = Object.freeze({ 农行: '农业银行', 中国农业银行: '农业银行', 工行: '工商银行', 中国工商银行: '工商银行',
  建行: '建设银行', 中国建设银行: '建设银行', 中行: '中国银行', 交行: '交通银行', 招行: '招商银行', 浦发: '浦发银行' });
const TYPE_WORDS = Object.freeze([[/信用卡|贷记卡/g, 'credit'], [/借记卡|储蓄卡/g, 'debit'], [/虚拟余额|余额/g, 'virtual_balance'],
  [/现金/g, 'virtual_cash'], [/微信/g, 'virtual_wechat'], [/支付宝/g, 'virtual_alipay']]);
const compact = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s/g, '') : '';
function normalizedBankName(value) {
  if (typeof value !== 'string') return '';
  const name = value.normalize('NFKC').replace(/\s/g, '').replace(/(?:借记卡|储蓄卡|信用卡|贷记卡|银行卡|卡)$/, '');
  return BANK_ALIASES[name] || name;
}
// Stored bank names use the canonical seed ("中国农业银行"), while filters use
// either the short label or the common alias. Return every stored spelling
// that normalizes to the same bank so SQL can filter before truncation.
function bankNameVariants(value) {
  const name = normalizedBankName(value);
  if (!name) return [];
  return [...new Set([name, ...Object.entries(BANK_ALIASES).filter(([, full]) => full === name).map(([alias]) => alias)])];
}
function accountBank(row) {
  // Older candidate snapshots retained a full bank/tail label without the
  // structured bank column. Explicit metadata always wins over that label.
  return normalizedBankName(row?.bankName) || normalizedBankName(/^(.+?银行)(?:\s*\d{1,4}(?:\(\d+\))?)?$/.exec(row?.name || '')?.[1]);
}
function statedCardTypes(message) {
  return [...new Set(accountParts(message).filter(part => !part.negative).flatMap(part => part.types))];
}

function accountTail(row) {
  const direct = [row?.tail, row?.last4, row?.last4_no, row?.cardTail, row?.last4No]
    .find(value => typeof value === 'string' && /^\d{1,4}$/.test(value));
  return direct || /(?:\s|银行\s*)(\d{4})(?:\(\d+\))?$/.exec(row?.name || '')?.[1] || null;
}

// Keep polarity local to the account phrase. The returned text is always an
// original substring, so a positive replacement never invents user evidence.
function accountParts(message, candidates = []) {
  if (typeof message !== 'string') return [];
  const banks = [...new Set([...Object.values(BANK_ALIASES), ...candidates.map(accountBank)].filter(Boolean))];
  return message.split(/[，,。.!！?？；;\n]/).flatMap(clause => {
    const markers = [...clause.matchAll(/不是用|不是|不使用|不用|不选|不要(?:使用|用|选)?|别(?:使用|用|选)?|非(?=信用卡|借记卡|储蓄卡)|而是|改(?:用|为|成)|换(?:用|成)|使用|选择|用|选|是/g)];
    const entityRanges = TYPE_WORDS.flatMap(([pattern]) => [...clause.matchAll(pattern)].map(match => [match.index, match.index + match[0].length]));
    for (const row of candidates) {
      if (typeof row.name !== 'string' || !row.name) continue;
      for (let start = clause.indexOf(row.name); start >= 0; start = clause.indexOf(row.name, start + 1))
        entityRanges.push([start, start + row.name.length]);
    }
    const starts = [0, ...markers.filter(marker => marker.index > 0 &&
      !entityRanges.some(([start, end]) => marker.index > start && marker.index < end) &&
      !(marker[0] === '是' && /(?:尾号|末四位|后四位|银行卡|账户|卡)\s*$/.test(clause.slice(0, marker.index))))
      .map(marker => marker.index)];
    return [...new Set(starts)].map((start, index, positions) => {
      const text = clause.slice(start, positions[index + 1] ?? clause.length), value = compact(text);
      const negative = /^(?:不是|不使用|不用|不选|不要|别|非)/.test(value);
      const types = TYPE_WORDS.filter(([pattern]) => new RegExp(pattern.source).test(value)).map(([, type]) => type);
      const mentionedBanks = banks.filter(bank => [bank, ...Object.entries(BANK_ALIASES).filter(([, full]) => full === bank).map(([alias]) => alias)]
        .some(alias => value.includes(alias)));
      const named = candidates.filter(row => compact(row.name) && value.includes(compact(row.name)));
      const names = named.filter(row => !named.some(other => other.id !== row.id && compact(other.name).length > compact(row.name).length &&
        compact(other.name).includes(compact(row.name)))).map(row => row.id);
      const tails = [...value.matchAll(/(?:尾号|末四位|后四位|银行卡|信用卡|借记卡|卡)(?:是|为|[:：])?(\d{1,4})(?!\d|(?:元|块|年|月|日))/g)].map(match => match[1]);
      const bareTail = /^(?:用|使用|选|选择|就是|是)?(\d{1,4})(?:那张|这张|的卡|卡|银行卡|借记卡|信用卡)?(?:付的|付款|支付)?$/.exec(value)?.[1];
      if (bareTail) tails.push(bareTail);
      const prior = negative && /(?:刚才|之前|原来|前面|那|这)(?:的)?(?:一?张|个)?(?:卡|账户)?/.test(value);
      const genericBank = negative && /银行卡/.test(value) && !types.length && !mentionedBanks.length && !names.length && !tails.length;
      const meaningful = types.length || mentionedBanks.length || names.length || tails.length || prior || genericBank;
      return { text, negative, types, banks: mentionedBanks, names, tails: [...new Set(tails)], prior, genericBank, meaningful };
    }).filter(part => part.meaningful);
  });
}

function latestAccountDirective(sourceUtterances, candidates) {
  for (let index = sourceUtterances.length - 1; index >= 0; index--) {
    const parts = accountParts(sourceUtterances[index], candidates);
    if (parts.length) return { index, parts };
  }
  return { index: -1, parts: [] };
}

function accountSelectionUtterances(sourceUtterances = [], candidates = []) {
  return latestAccountDirective(sourceUtterances, candidates).parts.filter(part => !part.negative).map(part => part.text);
}

function positiveConstraints(parts) {
  const positive = parts.filter(part => !part.negative);
  return Object.fromEntries(['types', 'banks', 'names', 'tails'].map(key => [key, [...new Set(positive.flatMap(part => part[key]))]]));
}

function matchesConstraints(selected, constraints) {
  return (!constraints.types.length || constraints.types.includes(selected.cardType || selected.type)) &&
    (!constraints.banks.length || constraints.banks.includes(accountBank(selected))) &&
    (!constraints.names.length || constraints.names.includes(selected.id)) &&
    (!constraints.tails.length || constraints.tails.includes(accountTail(selected)));
}

function identifiesAccount(constraints) {
  return constraints.names.length === 1 || constraints.tails.length === 1 ||
    constraints.banks.length === 1 && constraints.types.length === 1;
}

function isRejectedAccountSelection(selected, sourceUtterances = [], candidates = []) {
  if (!selected?.id || !candidates.some(row => row.id === selected.id)) return true;
  const { index, parts } = latestAccountDirective(sourceUtterances, candidates);
  const positive = positiveConstraints(parts);
  // Multiple positive alternatives are a question for the user, including
  // names that the older name-based guard could otherwise choose arbitrarily.
  if (Object.values(positive).some(values => values.length > 1) || !matchesConstraints(selected, positive)) return true;
  // A generic later bank/type reply cannot undo an account cancellation and
  // let the single-card service fallback revive the rejected account. A new
  // explicit account selection can deliberately replace that cancellation.
  if (!identifiesAccount(positive)) {
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
      const earlier = accountParts(sourceUtterances[previousIndex], candidates);
      if (earlier.filter(part => part.negative).some(part =>
        part.prior || part.genericBank && ['credit', 'debit'].includes(selected.cardType || selected.type) ||
        (part.types.length || part.banks.length || part.names.length || part.tails.length) && matchesConstraints(selected, part))) return true;
      if (identifiesAccount(positiveConstraints(earlier))) break;
    }
  }
  return parts.filter(part => part.negative).some(part => {
    const identified = part.types.length || part.banks.length || part.names.length || part.tails.length;
    if (identified) return matchesConstraints(selected, part);
    if (part.genericBank) return ['credit', 'debit'].includes(selected.cardType || selected.type);
    if (!part.prior) return false;
    const previous = positiveConstraints(latestAccountDirective(sourceUtterances.slice(0, index), candidates).parts);
    const priorCandidates = Object.values(previous).some(values => values.length)
      ? candidates.filter(row => matchesConstraints(row, previous)) : [];
    return priorCandidates.length === 1 ? priorCandidates[0].id === selected.id
      : !Object.values(positive).some(values => values.length);
  });
}
function filterCandidateRows(group, rows = [], args = {}) {
  const direction = ['expense', 'income'].includes(args.direction) ? args.direction
    : group === 'categories' && args.filter === '支出' ? 'expense'
      : group === 'categories' && args.filter === '收入' ? 'income' : null;
  const filter = group === 'categories' && ['支出', '收入'].includes(args.filter) ? '' : args.filter || '';
  const needle = filter.toLocaleLowerCase();
  const bank = normalizedBankName(args.bankName);
  return rows.filter(row => (!needle || String(row.name || '').toLocaleLowerCase().includes(needle)) &&
    (group !== 'cards' || (!bank || normalizedBankName(row.bankName) === bank) &&
      (!args.cardType || (row.cardType || row.type) === args.cardType)) &&
    (group !== 'categories' || !direction || row.type === direction));
}
// A bank is not itself an account. It becomes explicit only when the user
// supplies a card type and the complete owner-bound candidates contain one
// account for that bank and type. The selected id still resolves this turn.
function explicitUniqueAccountSelection(selected, candidates = [], sourceUtterances = []) {
  if (!selected?.id || !candidates.some(row => row.id === selected.id)) return false;
  const bank = accountBank(selected);
  const type = selected.cardType || selected.type;
  if (!bank || !CARD_TYPES.includes(type) || isRejectedAccountSelection(selected, sourceUtterances, candidates)) return false;
  const latest = latestAccountDirective(sourceUtterances, candidates);
  const constraints = positiveConstraints(latest.parts);
  if (!Object.values(constraints).some(values => values.length)) return false;
  // A correction may change just the bank or just the type. Inherit only an
  // unchanged, unambiguous field from earlier original user account wording.
  for (let index = latest.index - 1; index >= 0 && (!constraints.banks.length || !constraints.types.length); index--) {
    const previousParts = accountParts(sourceUtterances[index], candidates);
    const previous = positiveConstraints(previousParts);
    if (previousParts.some(part => part.negative) && !Object.values(previous).some(values => values.length)) break;
    const named = candidates.filter(row => previous.names.includes(row.id) || previous.tails.includes(accountTail(row)));
    if (named.length === 1) {
      if (!previous.banks.length && accountBank(named[0])) previous.banks = [accountBank(named[0])];
      if (!previous.types.length) previous.types = [named[0].cardType || named[0].type];
    }
    if (!constraints.banks.length && previous.banks.length) constraints.banks = previous.banks;
    if (!constraints.types.length && previous.types.length) constraints.types = previous.types;
  }
  if (constraints.banks.length !== 1 || constraints.types.length !== 1 || !matchesConstraints(selected, constraints)) return false;
  const matching = candidates.filter(row => accountBank(row) === bank && (row.cardType || row.type) === type);
  return matching.length === 1 && matching[0].id === selected.id;
}
module.exports = { CARD_TYPES, normalizedBankName, bankNameVariants, statedCardTypes, filterCandidateRows, accountSelectionUtterances,
  isRejectedAccountSelection, explicitUniqueAccountSelection };
