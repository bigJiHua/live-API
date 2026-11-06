const { toCNY, formatCNY } = require('../../src/common/utils/currency');
const { truncateDecimal, roundDecimal } = require('../../src/common/utils/decimal');

describe('decimal money boundaries', () => {
  test.each([
    [39.91, '39.91'], ['39.91', '39.91'], ['39.9100', '39.91'],
    [39.90999999999999, '39.91'], [0.1 + 0.2, '0.30'],
    [9.1132, '9.1132'], [0.0001, '0.0001'], ['1.2345999', '1.2345'],
    [1.2345999, '1.2345'], ['39.9099', '39.9099'],
    [-39.91, '-39.91'], ['-1.2345999', '-1.2345'],
    ['1000.1234', '1,000.1234'], ['9999999999.9999', '9,999,999,999.9999'],
    [1e-4, '0.0001'], ['1.2345e3', '1,234.50'], [0, '0.00'], [NaN, '0.00'],
  ])('formatCNY(%p) preserves four decimal places without corrupting the integer or fraction', (input, expected) => {
    expect(formatCNY(input)).toBe(expected);
  });

  test('an exact four-place stored amount is never rounded to cents by display formatting', () => {
    expect(truncateDecimal('39.9099')).toBe(39.9099);
    expect(truncateDecimal(39.91)).toBe(39.91);
    expect(truncateDecimal(0.1 + 0.2)).toBe(0.3);
  });

  test.each([
    ['39.9100', 'CNY', 1, 39.91], ['39.91', 'USD', '100', 39.91],
    [1, 'GBP', '911.3200', 9.1132], [1, 'HKD', '86.5800', 0.8658],
    ['1.2345999', 'USD', 100, 1.2345], ['123.4567', 'USD', '711.2345', 878.0666],
    ['-39.91', 'USD', 100, -39.91], [1, 'USD', undefined, 0.01],
    [1, 'USD', null, 0.01], [1, 'USD', 0, 0.01],
  ])('toCNY(%p, %p, %p) calculates decimal multiplication before truncation', (amount, currency, rate, expected) => {
    expect(toCNY(amount, currency, rate)).toBe(expected);
  });

  test('cent rounding follows decimal half-up boundaries without binary scaling artifacts', () => {
    expect(roundDecimal('1.005', 2)).toBe(1.01);
    expect(roundDecimal('1.015', 2)).toBe(1.02);
    expect(roundDecimal('-1.005', 2)).toBe(-1.01);
    expect(toCNY('39.9100', 'CNY', 1)).toBe(39.91);
  });
});
