const { historyDefinitions, isHistoryTool, validateHistoryTool } = require('../../src/modules/ai/service/historyTools');
const ref = 'h_' + 'a'.repeat(32);

test('only search and current-turn history read are exposed through strict native tool definitions', () => {
  expect(historyDefinitions.map(tool => tool.function.name)).toEqual(['history_search', 'history_read']);
  expect(historyDefinitions.every(tool => tool.function.parameters.additionalProperties === false)).toBe(true);
  expect(isHistoryTool('memory_read')).toBe(false);
  expect(isHistoryTool('__proto__')).toBe(false);
  expect(() => validateHistoryTool('sql', {})).toThrow(expect.objectContaining({ code: 'AI_TOOL_DENIED' }));
});
test('search preserves literal SQL/LIKE/regex-looking text while trimming only surrounding whitespace', () => {
  const args = { query: '  %_! OR 1=1 (a+)+$  ', limit: 10 };
  expect(validateHistoryTool('history_search', args)).toEqual({ query: '%_! OR 1=1 (a+)+$', limit: 10 });
  expect(args.query).toBe('  %_! OR 1=1 (a+)+$  ');
  expect(validateHistoryTool('history_search', { query: '以前的答复' }).limit).toBe(5);
});
test.each([undefined, null, [], 1, 'query'])('non-object arguments cannot bypass the required protocol: %s', args => {
  expect(() => validateHistoryTool('history_search', args)).toThrow();
  expect(() => validateHistoryTool('history_read', args)).toThrow();
});
test.each([{ query: '' }, { query: '   ' }, { query: '字'.repeat(81) }, { query: 1 },
  { query: '中文', limit: 0 }, { query: '中文', limit: 11 }, { query: '中文', limit: '5' },
  { query: '中文', limit: 1.5 }])('search requires bounded original text and an actual integer limit', args => {
  expect(() => validateHistoryTool('history_search', args)).toThrow();
});
test.each(['owner', 'userId', 'conversationId', 'root', 'sort', 'mode', 'regex', 'sql', 'ref', 'path', 'url'])
  ('search refuses caller-controlled scope or unsupported field %s', field => {
    expect(() => validateHistoryTool('history_search', { query: '原话', [field]: 'forbidden' })).toThrow();
  });
test('history read requires the exact native h_ref namespace and rejects other references', () => {
  expect(validateHistoryTool('history_read', { ref })).toEqual({ ref });
  for (const value of ['r_' + 'a'.repeat(32), 'q_' + 'a'.repeat(24), 'h_' + 'A'.repeat(32),
    'h_' + 'a'.repeat(31), ref + '/other', ref + '\n', '../history.md']) {
    expect(() => validateHistoryTool('history_read', { ref: value })).toThrow();
  }
  expect(() => validateHistoryTool('history_read', { ref, conversationId: 'someone-else' })).toThrow();
});

test('history order, role and completion filters are explicit bounded native parameters', () => {
  const input = { query: '文章', limit: 2, order: 'oldest', role: 'assistant', status: 'completed' };
  expect(validateHistoryTool('history_search', input)).toEqual(input);
  const properties = historyDefinitions[0].function.parameters.properties;
  expect(properties.order.enum).toEqual(['latest', 'oldest']);
  expect(properties.role.enum).toEqual(['user', 'assistant']);
  expect(properties.status.enum).toEqual(['completed', 'failed']);
});

test.each([{ order: 'id ASC; DROP TABLE ai_message' }, { role: 'system' }, { status: 'pending' }, { order: 1 }])
  ('history selectors cannot inject SQL or unsupported values: %j', input => {
    expect(() => validateHistoryTool('history_search', { query: '文章', ...input })).toThrow();
  });
