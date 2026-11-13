// Single source of truth for how an account/card is named in AI candidates,
// read-only datasets and commit receipts. The card module's own display
// fallback is: alias, otherwise "<bank name> <last4>". A shared placeholder
// such as "未命名账户" collapses dozens of cards into one indistinguishable
// candidate and must never be used.
//
// Bank ids are *_id fields and get redacted by egressPolicy, so the display
// name has to be built on the server (SQL or JS) before anything is disclosed.
// Only a 1-4 digit tail is ever included, never a full card number.
const PLACEHOLDER_BANK = '未命名银行';
const text = value => typeof value === 'string' ? value.trim() : '';

function cardDisplayName(alias, bankName, last4) {
  const aliasText = text(alias);
  if (aliasText) return aliasText;
  const tail = text(last4);
  return `${text(bankName) || PLACEHOLDER_BANK}${tail ? ` ${tail}` : ''}`;
}

// Caller supplies the column/alias names; every repository calls the same
// expression so V3 and legacy paths produce byte-identical names.
const cardNameSql = ({ alias = 'c.alias', bank = 'bank.name', tail = 'c.last4_no' } = {}) =>
  `COALESCE(NULLIF(${alias}, ''), TRIM(CONCAT(COALESCE(NULLIF(${bank}, ''), '${PLACEHOLDER_BANK}'), ' ', COALESCE(${tail}, ''))))`;
const cardBankJoin = ({ bankId = 'c.bank_id', bankAlias = 'bank' } = {}) =>
  `LEFT JOIN bus_category ${bankAlias} ON ${bankAlias}.id = ${bankId} AND ${bankAlias}.type = 'bank' AND ${bankAlias}.is_deleted = 0`;

// Only the bare legacy placeholders are anonymous. A fallback name such as
// "招商银行 7476" still identifies a card even when the bank name is missing.
const ANONYMOUS_NAME = /^未命名(?:账户|卡片|信用卡|银行)$/;
const isAnonymousCardName = name => !text(name) || ANONYMOUS_NAME.test(text(name));

// Keep candidate names unique without leaking internal ids. Both repositories
// must call this so a name referenced by the model resolves to the same card.
function dedupeCardNames(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row) continue;
    const name = text(row.name);
    const seen = (counts.get(name) || 0) + 1;
    counts.set(name, seen);
    if (seen > 1) row.name = `${name}（${seen}）`;
  }
  return rows;
}

module.exports = { cardDisplayName, cardNameSql, cardBankJoin, isAnonymousCardName, dedupeCardNames, PLACEHOLDER_BANK };
