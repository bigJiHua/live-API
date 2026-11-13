// One fixed valuation rule for both AI query paths. ICU's currency registry
// admits named currencies; missing, malformed and unknown codes stay unknown.
const QUERY_CURRENCIES = Object.freeze(Intl.supportedValuesOf('currency').filter(code => /^[A-Z]{3}$/.test(code)));

function financeQueryMoney(alias = 'a') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('INVALID_QUERY_ALIAS');
  const currencyKnown = `BINARY ${alias}.currency IN (${QUERY_CURRENCIES.map(code => `'${code}'`).join(',')})`;
  const currency = `CASE WHEN ${currencyKnown} THEN ${alias}.currency ELSE NULL END`;
  const cny = `CASE WHEN BINARY ${alias}.currency = 'CNY' THEN ROUND(${alias}.amount, 2)
    WHEN ${currencyKnown} AND ${alias}.exchange_rate IS NOT NULL AND ${alias}.exchange_rate > 0
      THEN ROUND(${alias}.amount * ${alias}.exchange_rate / 100, 2) ELSE NULL END`;
  const unpriced = `CASE WHEN (${cny}) IS NULL THEN 1 ELSE 0 END`;
  // A known empty set is zero. A set containing only unvalued records is null.
  const total = `CASE WHEN COUNT(${cny}) = 0 AND COUNT(*) > 0 THEN NULL ELSE COALESCE(SUM(${cny}), 0) END`;
  function forDirection(direction) {
    if (![0, 1].includes(direction)) throw new Error('INVALID_QUERY_DIRECTION');
    return `CASE WHEN COUNT(CASE WHEN ${alias}.direction = ${direction} THEN ${cny} END) = 0
      AND COALESCE(SUM(CASE WHEN ${alias}.direction = ${direction} THEN ${unpriced} ELSE 0 END), 0) > 0
      THEN NULL ELSE COALESCE(SUM(CASE WHEN ${alias}.direction = ${direction} THEN ${cny} ELSE 0 END), 0) END`;
  }
  return { currency, cny, unpriced, total, forDirection };
}
module.exports = { financeQueryMoney, QUERY_CURRENCIES };
