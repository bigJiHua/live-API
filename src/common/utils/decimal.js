// Decimal boundaries for money: do not scale a binary float and then truncate it.
// String inputs retain their decimal digits. Number inputs have at most 15
// significant digits of business data (amount columns allow 10 + 4 digits);
// discard only IEEE-754 tail noise before exact BigInt arithmetic.
function parseDecimal(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = value.toPrecision(15);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else return null;
  if (!text || text.length > 512 || !Number.isFinite(Number(text))) return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || !(match[2] || match[3])) return null;
  const exponent = Number(match[4] || 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 308) return null;
  const fraction = match[3] || '';
  let digits = (match[2] || '0') + fraction;
  let scale = fraction.length - exponent;
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  const integer = BigInt(digits) * (match[1] === '-' ? -1n : 1n);
  return { integer, scale };
}

function rescale(integer, fromScale, toScale, round = false) {
  if (fromScale <= toScale) return integer * 10n ** BigInt(toScale - fromScale);
  const divisor = 10n ** BigInt(fromScale - toScale);
  const truncated = integer / divisor;
  const remainder = integer % divisor;
  if (round && (remainder < 0n ? -remainder : remainder) * 2n >= divisor) {
    return truncated + (integer < 0n ? -1n : 1n);
  }
  return truncated;
}

function toScaledInteger(value, scale = 4, round = false) {
  const decimal = parseDecimal(value);
  return decimal ? rescale(decimal.integer, decimal.scale, scale, round) : 0n;
}

function scaledToString(integer, scale = 4) {
  const negative = integer < 0n;
  const digits = (negative ? -integer : integer).toString().padStart(scale + 1, '0');
  const text = scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits;
  return (negative ? '-' : '') + text;
}

function truncateDecimal(value, scale = 4) {
  return Number(scaledToString(toScaledInteger(value, scale), scale));
}

function roundDecimal(value, scale = 2) {
  return Number(scaledToString(toScaledInteger(value, scale, true), scale));
}

// The exchange-rate convention is 100 foreign units = rate CNY.
function multiplyDecimal(left, right, divisorPower = 2, scale = 4) {
  const a = parseDecimal(left), b = parseDecimal(right);
  if (!a || !b) return 0;
  const units = rescale(a.integer * b.integer, a.scale + b.scale + divisorPower, scale);
  return Number(scaledToString(units, scale));
}

function formatDecimal(value, { useGrouping = true, scale = 4, minFraction = 2 } = {}) {
  const fixed = scaledToString(toScaledInteger(value, scale), scale);
  let [integer, fraction = ''] = fixed.split('.');
  while (fraction.length > minFraction && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  if (useGrouping) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return integer + (fraction ? '.' + fraction : '');
}

module.exports = { toScaledInteger, scaledToString, truncateDecimal, roundDecimal, multiplyDecimal, formatDecimal };
