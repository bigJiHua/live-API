const { generateRandomString, generateUUID } = require('../../src/common/utils/crypto');

describe('General identifier utilities', () => {
  test('random identifiers respect length and the safe alphabet', () => {
    expect(generateRandomString()).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(generateRandomString(12)).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(generateRandomString(0)).toBe('');
  });
  test('UUIDs carry the version and variant required by API contracts', () => {
    const values = Array.from({ length: 100 }, () => generateUUID());
    for (const value of values) expect(value).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(new Set(values).size).toBe(values.length);
  });
});
