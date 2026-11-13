jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Provider forbidden'); }) }));
const { estimateTokens, historyTokenBudget, selectBudgetedHistory, buildContextSummary, sanitizeContextSummary,
  redactContextData } = require('../../src/modules/ai/service/modelContext');
const date = '2026-11-08';
const history = (count, userText = index => `用户问题${index}`, answerText = index => `答复${index}`) => Array.from({ length: count }, (_, index) => [
  { role: 'user', turnId: `turn_${index}`, content: userText(index), sourceDate: date },
  { role: 'assistant', turnId: `turn_${index}`, content: answerText(index) },
]).flat();

test('Chinese context has a larger token estimate than the same number of ASCII characters', () => {
  expect(estimateTokens('中文'.repeat(20))).toBeGreaterThan(estimateTokens('ab'.repeat(20)));
  expect(estimateTokens({ text: '中文', currentTurn: 0 })).toBeGreaterThan(0);
  expect(estimateTokens(undefined)).toBe(0);
});

test('history selection retains complete recent pairs and caps requested windows at twelve user turns', () => {
  const original = history(16), before = structuredClone(original);
  const result = selectBudgetedHistory(original, { budget: 12000, limit: 99 });
  expect(result.turns.map(turn => turn.turnId)).toEqual(Array.from({ length: 12 }, (_, index) => `turn_${index + 4}`));
  expect(result.turns.every(turn => turn.user && turn.answer && turn.status === 'completed')).toBe(true);
  expect(original).toEqual(before);
});

test('an oversized recent history turn is summarized instead of bypassing the token budget', () => {
  const original = history(2, index => index ? '原'.repeat(1500) : '短问题', index => index ? '答'.repeat(1200) : '短答复');
  const result = selectBudgetedHistory(original, { budget: 500 });
  expect(result.turns.map(turn => turn.turnId)).toEqual(['turn_0']);
  expect(result.omitted.map(turn => turn.turnId)).toEqual(['turn_1']);
  expect(result.estimatedTokens).toBeLessThanOrEqual(result.budget);
  expect(buildContextSummary(null, result.omitted)).toEqual({ version: 1,
    items: [{ text: '原'.repeat(320), sourceDate: date, status: 'completed' }], truncated: true });
});

test('a zero history budget or zero window carries no partial user/assistant pairs', () => {
  const zeroBudget = selectBudgetedHistory(history(2), { budget: 0 });
  expect(zeroBudget).toMatchObject({ turns: [], estimatedTokens: 0, budget: 0, truncated: true });
  expect(zeroBudget.omitted).toHaveLength(2);
  expect(selectBudgetedHistory(history(2), { budget: 500, limit: 0 })).toMatchObject({ turns: [], omitted: [], estimatedTokens: 0 });
});

test('history budget settings accept bounded integer values and fall back for invalid inputs', () => {
  const previous = process.env.AI_CONTEXT_HISTORY_TOKENS;
  try {
    process.env.AI_CONTEXT_HISTORY_TOKENS = '800';
    expect(historyTokenBudget()).toBe(800);
    for (const value of ['499', '12001', '1.5', 'invalid']) {
      process.env.AI_CONTEXT_HISTORY_TOKENS = value;
      expect(historyTokenBudget()).toBe(3500);
    }
  } finally {
    if (previous === undefined) delete process.env.AI_CONTEXT_HISTORY_TOKENS;
    else process.env.AI_CONTEXT_HISTORY_TOKENS = previous;
  }
});

test('§10 budget chain: config override wins, then context window ratio capped at 12000, then default', () => {
  expect(historyTokenBudget({ historyTokens: 800 })).toBe(800);
  expect(historyTokenBudget({ historyTokens: 800, modelCapabilities: { contextWindowTokens: 1048576 } })).toBe(800);
  expect(historyTokenBudget({ modelCapabilities: { contextWindowTokens: 1048576 } })).toBe(12000);
  expect(historyTokenBudget({ modelCapabilities: { contextWindowTokens: 3000 } })).toBe(1000);
  expect(historyTokenBudget({ modelCapabilities: { contextWindowTokens: 900 } })).toBe(500);
  expect(historyTokenBudget({ modelCapabilities: { contextWindowTokens: null } })).toBe(3500);
  expect(historyTokenBudget({ historyTokens: 499 })).toBe(3500);
  expect(historyTokenBudget({ historyTokens: 'junk' })).toBe(3500);
});

test('long history stays within the resolved provider-aware budget', () => {
  const budget = historyTokenBudget({ historyTokens: 600 });
  const big = history(16, index => `问题${index} ${'文'.repeat(150)}`, index => `答复${index} ${'文'.repeat(120)}`);
  const result = selectBudgetedHistory(big, { budget });
  expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
  expect(result.truncated).toBe(true);
  expect(result.turns.at(-1).turnId).toBe('turn_15');
});

test('summary merges deterministic user excerpts without assistant content, references or evidence indices', () => {
  const prior = { version: 1, items: [{ text: '之前要饼图', sourceDate: date, status: 'completed' }], truncated: false };
  const omitted = [{ user: '银行卡数量应该用张数 SECRET', answer: '助手曾说9999元', sourceDate: date, status: 'failed',
    turnId: 'private_turn', sourceTurn: 5 }];
  const summary = buildContextSummary(prior, omitted, text => text.replace('SECRET', '[已隐藏]'));
  expect(summary.items).toEqual([...prior.items, { text: '银行卡数量应该用张数 [已隐藏]', sourceDate: date, status: 'failed' }]);
  expect(JSON.stringify(summary)).not.toMatch(/9999|private_turn|sourceTurn|SECRET/);
  expect(buildContextSummary(summary, omitted, text => text.replace('SECRET', '[已隐藏]')).items).toHaveLength(2);
});

test('summary sanitization uses the persisted schema, bounds excerpts, and rejects invalid dates and statuses', () => {
  const summary = sanitizeContextSummary({ version: 1, truncated: false, items: [
    { text: '有效'.repeat(200), sourceDate: date, status: 'completed', ref: 'old-ref' },
    { text: '非法日期', sourceDate: '2026-02-30', status: 'completed' },
    { text: '非法状态', sourceDate: date, status: 'executed' },
  ] });
  expect(summary.items).toEqual([{ text: '有效'.repeat(160), sourceDate: date, status: 'completed' }]);
  expect(sanitizeContextSummary({ version: 1, items: [], truncated: false })).toEqual({ version: 1, items: [], truncated: false });
});
test('summary excerpts preserve whole Unicode characters at the 320-character boundary', () => {
  const original = '字'.repeat(319) + '🙂';
  const summary = buildContextSummary(null, [{ user: original + '后续文本', sourceDate: date, status: 'completed' }]);
  expect(summary.items[0].text).toBe(original);
  expect(Array.from(summary.items[0].text)).toHaveLength(320);
  expect(JSON.stringify(summary)).not.toMatch(/\\ud[89ab][0-9a-f]{2}|\\ud[cdef][0-9a-f]{2}|�/i);
});

test('structured redaction keeps JSON valid and evidence indices unchanged even for long nested context', () => {
  const original = { conversationId: 'private_conversation', userId: 'private_owner', currentTurn: 15,
    pending: { turnId: 'private_turn', evidence: { sourceTurn: 12, dateSourceTurn: 15, quote: 'SECRET' } },
    userTurns: ['SECRET', '字'.repeat(6000)], count: 79, enabled: true, empty: null };
  const result = redactContextData(original, text => text.replaceAll('SECRET', '[已隐藏]'));
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(result.pending.evidence).toEqual({ sourceTurn: 12, dateSourceTurn: 15, quote: '[已隐藏]' });
  expect(result.userTurns[1]).toHaveLength(6000);
  expect(JSON.stringify(result)).not.toMatch(/private_conversation|private_owner|private_turn|SECRET/);
  expect(original.pending.evidence.quote).toBe('SECRET');
});
test('generated query metadata keeps its exact identifier while the same digits in prose remain scrubbed', () => {
  const queryId = `q_${'12345678'.repeat(3)}`;
  const result = redactContextData({ queryId, quote: `用户原话 ${queryId}`, invalid: { queryId: 'q_12345678' } },
    text => text.replace(/\d{8}/g, '[号码已隐藏]'));
  expect(result.queryId).toBe(queryId);
  expect(result.quote).toContain('[号码已隐藏]');
  expect(result.invalid.queryId).toContain('[号码已隐藏]');
});
