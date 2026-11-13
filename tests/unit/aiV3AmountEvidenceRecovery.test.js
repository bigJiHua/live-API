// Pure evidence functions only: no app, provider, API routes or database access.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));
const { moneyLiterals, recoverMissingAmountEvidence, validateAmountEvidence } = require('../../src/modules/ai/service/v3Evidence');
const source = '需要的 今晚买菜花了 30 块 8 毛 2 然后买鸭肉花了 20 块 4 毛 然后去了趟超市 买了点生活物品 花了 123 块 6 都是用的农业银行卡付的';
const turns = ['晚上好啊', '这个月是几月份', source];
const proposal = (amount, extra = {}) => ({ kind: 'transaction.create', fields: { amount, currency: 'CNY',
  direction: 0, transDate: '2026-11-08', accountRef: null, categoryRef: 'r_synthetic', payMethod: '银行卡' }, ...extra });

test('the reported three oral amounts retain the omitted cent and no component literals', () => {
  expect([...moneyLiterals(source)]).toEqual(['30.82', '20.4', '123.6']);
});
test.each([
  ['30 块 8 毛 2', '30.82'], ['三十块八毛二', '30.82'], ['30块8角2然后买菜', '30.82'],
  ['30块8毛2分', '30.82'], ['30块8毛', '30.8'], ['123 块 6', '123.6'], ['三十元八角二分', '30.82'],
])('oral cents use one monetary literal: %s', (text, amount) => {
  expect([...moneyLiterals(text)]).toEqual([amount]);
});
test('an unrelated quantity after 毛 cannot become an omitted cent', () => {
  expect([...moneyLiterals('30块8毛2个苹果')]).toEqual(['30.8']);
  expect(moneyLiterals('30块8毛20元')).not.toContain('30.82');
});
test.each(['30块8毛 2 个苹果', '30块8毛 2个苹果', '30块8毛2 个苹果', '30块8毛 2 瓶水', '30块8毛 2 公斤苹果'])
('a quantity after whitespace cannot become an omitted cent: %s', text => {
  expect(moneyLiterals(text)).toContain('30.8');
  expect(moneyLiterals(text)).not.toContain('30.82');
});
test.each(['30块8毛 2 元', '30块8毛 2元', '30块8毛2 元', '30块8毛 2 块钱'])
('another currency amount after whitespace is preserved: %s', text => {
  expect([...moneyLiterals(text)]).toEqual(['30.8', '2']);
});
test('a quantity following the yuan shorthand cannot become an omitted tenths digit', () => {
  expect([...moneyLiterals('30块 8 个苹果')]).toEqual(['30']);
});
test.each(['30.82', '20.40', '123.60'])('missing evidence recovers %s solely from raw user source index 2', amount => {
  const input = proposal(amount), recovered = recoverMissingAmountEvidence(input, turns);
  expect(recovered.evidence).toEqual({ sourceTurn: 2, quote: source });
  expect(recovered.fields).toBe(input.fields);
  expect(input).not.toHaveProperty('evidence');
  expect(() => validateAmountEvidence(recovered, amount, turns)).not.toThrow();
  expect(recovered.fields.accountRef).toBeNull();
});
test('null evidence is an omitted envelope, not a source selected by the model', () => {
  expect(recoverMissingAmountEvidence(proposal('30.82', { evidence: null }), turns).evidence).toEqual({ sourceTurn: 2, quote: source });
});

test('evidence recovery supports the expanded sixteen-source context without accepting a seventeenth source', () => {
  const expanded = [...Array(15).fill('今天心情挺好'), source];
  const recovered = recoverMissingAmountEvidence(proposal('30.82'), expanded);
  expect(recovered.evidence).toEqual({ sourceTurn: 15, quote: source });
  expect(() => validateAmountEvidence(recovered, '30.82', expanded)).not.toThrow();
  const beyond = proposal('30.82');
  expect(recoverMissingAmountEvidence(beyond, ['你好', ...expanded])).toBe(beyond);
});
test('an existing wrong quote or wrong sourceTurn remains rejected', () => {
  for (const evidence of [{ sourceTurn: 0, quote: '30 块 8 毛 2' }, { sourceTurn: 2, quote: '买菜30.82元' }, {}]) {
    const input = proposal('30.82', { evidence });
    expect(recoverMissingAmountEvidence(input, turns)).toBe(input);
    expect(() => validateAmountEvidence(input, '30.82', turns)).toThrow();
  }
});
test.each([
  ['same amount twice in one utterance', ['买菜30元，买鸭肉30元']],
  ['same amount in different turns', ['昨晚买菜30元', '今晚买鸭肉30元']],
  ['same normalized amount twice', ['买菜30元，买鸭肉三十块']],
])('ambiguous %s never gains evidence', (_, userTurns) => {
  const input = proposal('30.00');
  expect(recoverMissingAmountEvidence(input, userTurns)).toBe(input);
  expect(() => validateAmountEvidence(input, input.fields.amount, userTurns)).toThrow();
});
test('the first explicit quote can still disambiguate equal amounts without recovery', () => {
  const input = proposal('30.00', { evidence: { sourceTurn: 1, quote: '买鸭肉30元' } });
  const userTurns = ['买菜30元', '买鸭肉30元'];
  expect(recoverMissingAmountEvidence(input, userTurns)).toBe(input);
  expect(() => validateAmountEvidence(input, input.fields.amount, userTurns)).not.toThrow();
});
test.each([8.5, '30.820', '30.82元', '0.00', '-30.82', '30,82', '99999999999.00'])('invalid amount %s is not coerced or recovered', amount => {
  const input = proposal(amount);
  expect(recoverMissingAmountEvidence(input, turns)).toBe(input);
});
test('non-transaction actions and foreign currency are not repaired', () => {
  for (const input of [{ kind: 'budget.create', fields: { budgetAmount: '30.82' } },
    { ...proposal('30.82'), fields: { amount: '30.82', currency: 'USD' } }]) {
    expect(recoverMissingAmountEvidence(input, turns)).toBe(input);
  }
});
test('only the supplied user turns are sources, never a model answer or tool dataset', () => {
  const input = proposal('7150.00');
  expect(recoverMissingAmountEvidence(input, ['6月份支出最多的是哪一天？'])).toBe(input);
  expect(recoverMissingAmountEvidence(input, [{ role: 'assistant', content: '支出7150元' },
    { rows: [{ expense: '7150.00' }] }])).toBe(input);
});
test.each(['查上个月30.82元那笔', '昨晚买菜花了30.82元吗？', '统计30.82元的消费'])('query source %s cannot gain a recording citation', raw => {
  const input = proposal('30.82');
  expect(recoverMissingAmountEvidence(input, [raw])).toBe(input);
});
test('an explicit recording request can accompany a question', () => {
  const raw = '帮我记一笔，今晚买菜30.82元，可以吗？';
  expect(recoverMissingAmountEvidence(proposal('30.82'), [raw]).evidence).toEqual({ sourceTurn: 0, quote: raw });
});
test('unrecoverable missing evidence names the model omission without saying the user omitted money', () => {
  const input = proposal('30.82');
  try { validateAmountEvidence(input, input.fields.amount, ['买菜30元']); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error.code).toBe('AI_AMOUNT_NOT_EXPLICIT');
    expect(error.message).toBe('模型草稿未给出可核对的原话引用，本轮未生成草稿；请重发这笔交易。');
  }
});
test('provided but inconsistent monetary evidence retains its existing rejection', () => {
  const input = proposal('30.82', { evidence: { sourceTurn: 0, quote: '买菜30元' } });
  expect(() => validateAmountEvidence(input, input.fields.amount, ['买菜30元'])).toThrow('模型金额与引用原话不一致，已停止生成草稿');
});
test.each([
  ['2026年11月8日，银行卡尾号3082', '3082.00', []],
  ['生活3082卡付款', '3082.00', [{ name: '生活3082卡' }]],
  ['买了30个鸡蛋', '30.00', []],
])('calendar, account and quantity numerals cannot recover money: %s', (text, amount, entities) => {
  const input = proposal(amount);
  expect(recoverMissingAmountEvidence(input, [text], entities)).toBe(input);
});
test('full-width literal recovery retains the exact original quote', () => {
  const raw = '今天买菜花了３０．８２元';
  const recovered = recoverMissingAmountEvidence(proposal('30.82'), [raw]);
  expect(recovered.evidence).toEqual({ sourceTurn: 0, quote: raw });
  expect(() => validateAmountEvidence(recovered, '30.82', [raw])).not.toThrow();
});
