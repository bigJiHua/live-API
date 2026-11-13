const { memoryDefinitions, validateMemoryTool, isMemoryTool } = require('../../src/modules/ai/service/memoryTools');
const write = overrides => ({ path: 'preferences.md', operation: 'create', title: '答复偏好', type: 'preference',
  content: '答复简洁，使用中文。', expectedRevision: null, evidence: { sourceTurn: 15, quote: '以后中文简洁回答' },
  reason: '用户明确说明长期答复偏好', ...overrides });

test.each(['memory_read', 'memory_write'])('%s model path contract prevents directory guessing while retaining Chinese and English names', name => {
  const { validateMemoryPath } = require('../../src/modules/ai/service/memoryStore');
  const field = memoryDefinitions.find(tool => tool.function.name === name).function.parameters.properties.path;
  expect(typeof field.pattern).toBe('string');
  const accepts = new RegExp(field.pattern);
  for (const filename of ['preferences.md', '偏好.md', '中文 English.md']) {
    expect(accepts.test(filename)).toBe(true);
    expect(validateMemoryPath(filename)).toBe(filename);
  }
  for (const filename of ['preferences/color-and-language.md', 'preferences\\color.md', '../escape.md', '/absolute.md', 'wrong.txt']) {
    expect(accepts.test(filename)).toBe(false);
    expect(() => validateMemoryPath(filename)).toThrow(expect.objectContaining({ code: 'AI_MEMORY_PATH_INVALID' }));
  }
});

test('only four native memory tools are open and every object rejects unspecified fields', () => {
  expect(memoryDefinitions.map(tool => tool.function.name)).toEqual(['memory_list', 'memory_read', 'memory_search', 'memory_write']);
  for (const tool of memoryDefinitions) expect(tool.function.parameters.additionalProperties).toBe(false);
  expect(memoryDefinitions[3].function.parameters.properties.evidence.additionalProperties).toBe(false);
  expect(isMemoryTool('memory_write')).toBe(true);
  expect(isMemoryTool('query_data')).toBe(false);
  expect(isMemoryTool('__proto__')).toBe(false);
  expect(() => validateMemoryTool('memory_exec', {})).toThrow(expect.objectContaining({ code: 'AI_TOOL_DENIED' }));
});
test('list/read/search expose no owner, root, HTTP or SQL parameters', () => {
  expect(validateMemoryTool('memory_list', {})).toEqual({ offset: 0, limit: 20 });
  expect(validateMemoryTool('memory_read', { path: 'preferences.md' })).toEqual({ path: 'preferences.md', offset: 0, limit: 3000 });
  expect(validateMemoryTool('memory_search', { pattern: '中文' })).toEqual({ pattern: '中文', mode: 'literal', limit: 10 });
  expect(validateMemoryTool('memory_search', { pattern: '^答复', mode: 'regex', limit: 20 })).toMatchObject({ mode: 'regex', limit: 20 });
  for (const key of ['owner', 'userId', 'root', 'sql', 'url', 'http']) {
    expect(() => validateMemoryTool('memory_list', { [key]: 'forbidden' })).toThrow();
    expect(() => validateMemoryTool('memory_read', { path: 'note.md', [key]: 'forbidden' })).toThrow();
    expect(() => validateMemoryTool('memory_write', write({ [key]: 'forbidden' }))).toThrow();
  }
});
test('list and read expose bounded pagination without coercion', () => {
  expect(validateMemoryTool('memory_list', { offset: 50, limit: 1 })).toEqual({ offset: 50, limit: 1 });
  expect(validateMemoryTool('memory_read', { path: 'note.md', offset: 65536, limit: 1 })).toMatchObject({ offset: 65536, limit: 1 });
  for (const args of [{ offset: -1 }, { offset: 51 }, { limit: 21 }, { offset: '1' }]) {
    expect(() => validateMemoryTool('memory_list', args)).toThrow();
  }
  for (const args of [{ offset: -1 }, { offset: 65537 }, { limit: 3001 }, { limit: '100' }]) {
    expect(() => validateMemoryTool('memory_read', { path: 'note.md', ...args })).toThrow();
  }
});
test.each([null, [], 'string', 1])('tool arguments reject non-object protocol values: %s', value => {
  expect(() => validateMemoryTool('memory_list', value)).toThrow();
});
test('write preserves exact content and evidence instead of coercing or rewriting it', () => {
  const original = write({ content: '保留\n完整中文正文。', evidence: { sourceTurn: 0, quote: '保留 原话' } });
  expect(validateMemoryTool('memory_write', original)).toEqual(original);
  expect(() => validateMemoryTool('memory_write', write({ evidence: { sourceTurn: '0', quote: '原话' } }))).toThrow();
  expect(() => validateMemoryTool('memory_write', write({ evidence: { sourceTurn: 16, quote: '原话' } }))).toThrow();
  expect(() => validateMemoryTool('memory_write', write({ evidence: { sourceTurn: 0, quote: '原话', owner: 'x' } }))).toThrow();
});
test('patch requires its literal oldText, while other operations reject an extra patch payload', () => {
  expect(validateMemoryTool('memory_write', write({ operation: 'patch', expectedRevision: 'a'.repeat(64), oldText: '原来的偏好' }))).toMatchObject({ expectedRevision: 'a'.repeat(64) });
  expect(() => validateMemoryTool('memory_write', write({ operation: 'patch' }))).toThrow();
  expect(() => validateMemoryTool('memory_write', write({ oldText: 'extra' }))).toThrow();
  expect(validateMemoryTool('memory_write', write({ operation: 'patch', expectedRevision: 'a'.repeat(64), oldText: '删除片段', content: '' })).content).toBe('');
});
test('a current-turn history ref can source memory, but null or malformed source identities cannot', () => {
  expect(validateMemoryTool('memory_write', write({ evidence: { historyRef: 'h_' + 'a'.repeat(32), quote: '原用户说的话' } })))
    .toMatchObject({ evidence: { historyRef: 'h_' + 'a'.repeat(32) } });
  for (const evidence of [{ quote: '原话' }, { sourceTurn: null, historyRef: null, quote: '原话' },
    { historyRef: 'r_' + 'a'.repeat(32), quote: '原话' }, { historyRef: 'h_old', quote: '原话' }]) {
    expect(() => validateMemoryTool('memory_write', write({ evidence }))).toThrow();
  }
});
test.each([['path', 'x'.repeat(81)], ['title', 'x'.repeat(81)], ['content', '字'.repeat(6001)],
  ['reason', '字'.repeat(501)], ['expectedRevision', 0], ['operation', 'delete'], ['type', 'executable']])
  ('write bounds %s and rejects values outside the memory protocol', (field, value) => {
    expect(() => validateMemoryTool('memory_write', write({ [field]: value }))).toThrow();
  });
test.each([{ pattern: '', limit: 1 }, { pattern: 'x'.repeat(201) }, { pattern: 'x', limit: 21 },
  { pattern: 'x', limit: '10' }, { pattern: 'x', mode: 'javascript' }])('search rejects unsupported limits or modes', args => {
  expect(() => validateMemoryTool('memory_search', args)).toThrow();
});
