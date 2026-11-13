const { memoryDeleteDefinitions, isMemoryDeleteTool, validateMemoryDeleteTool,
  explicitMemoryDeleteRequest, validateMemoryDeleteEvidence } = require('../../src/modules/ai/service/memoryDeleteTools');
const revision = 'a'.repeat(64);
const args = overrides => ({ path: 'preferences.md', expectedRevision: revision,
  evidence: { sourceTurn: 1, quote: '请删除关于颜色的记忆。' }, reason: '本轮明确要求删除颜色记忆', ...overrides });

test('delete is a separate bounded tool with no owner/root/SQL/HTTP or historical authorization parameters', () => {
  expect(memoryDeleteDefinitions.map(item => item.function.name)).toEqual(['memory_delete']);
  const tool = memoryDeleteDefinitions[0].function;
  expect(tool.parameters.additionalProperties).toBe(false);
  expect(tool.parameters.properties.evidence.additionalProperties).toBe(false);
  expect(isMemoryDeleteTool('memory_delete')).toBe(true);
  expect(isMemoryDeleteTool('__proto__')).toBe(false);
  expect(() => validateMemoryDeleteTool('memory_write', args())).toThrow(expect.objectContaining({ code: 'AI_TOOL_DENIED' }));
  for (const key of ['userId', 'owner', 'root', 'url', 'http', 'sql', 'content', 'operation'])
    expect(() => validateMemoryDeleteTool('memory_delete', args({ [key]: 'forbidden' }))).toThrow();
  expect(() => validateMemoryDeleteTool('memory_delete', args({ evidence: { historyRef: `h_${'a'.repeat(32)}`, quote: '删除记忆' } }))).toThrow();
});

test('delete protocol preserves quote and reason while requiring a safe path and exact current revision', () => {
  const input = args({ path: '中文 English.md', evidence: { sourceTurn: 15, quote: '请删除记忆，保留其它内容。' } });
  expect(validateMemoryDeleteTool('memory_delete', input)).toEqual(input);
  const modelPath = new RegExp(memoryDeleteDefinitions[0].function.parameters.properties.path.pattern);
  expect(modelPath.test('中文 English.md')).toBe(true);
  for (const path of ['../escape.md', 'C:\\secret.md', '/other.md', 'folder/note.md', 'note.txt', 'nul.md', 'x'.repeat(81)])
    expect(() => validateMemoryDeleteTool('memory_delete', args({ path }))).toThrow();
  for (const expectedRevision of [null, 1, '', 'guessed', 'A'.repeat(64)])
    expect(() => validateMemoryDeleteTool('memory_delete', args({ expectedRevision }))).toThrow();
  for (const sourceTurn of ['1', -1, 16, null])
    expect(() => validateMemoryDeleteTool('memory_delete', args({ evidence: { sourceTurn, quote: '删除记忆' } }))).toThrow();
  for (const reason of ['', '字'.repeat(501), 'password=abc12345', 'sk-proj-1234567890abcdef'])
    expect(() => validateMemoryDeleteTool('memory_delete', args({ reason }))).toThrow();
});

test.each(['请删除关于颜色的记忆。', '删掉这条长期记忆。', '把记忆 preferences.md 删了。',
  '忘掉我喜欢蓝色这件事。', '请忘掉“我喜欢蓝色”', 'Delete my memory about colors.',
  'Please remove the saved preferences.', 'Could you delete my memory about colors?', 'Forget that I like blue.'])
  ('explicit latest user deletion request is recognized: %s', text => expect(explicitMemoryDeleteRequest(text)).toBe(true));

test.each(['不要删除我的记忆。', '不用清空记忆。', '你能删除记忆吗？', '如何删除记忆？',
  '如果我要求你，删除记忆。', '例如用户说删除记忆。', '“删除记忆”只是示例。',
  '忘掉之前的任务。', '请忘掉“之前的任务”', '忘记上面的对话。', '删除账本。',
  '忘掉我刚才的问题', '我之前说过删除记忆，现在解释一下', '我已经删除记忆', '告诉我删除记忆是否有效',
  "Don't delete my memory.", 'How to delete my memory?', 'If I ask you, delete my memory.',
  'I wonder whether to delete my memory.', 'Forget the previous topic.', 'Forget that I asked you to delete my memory', '忘记是一个什么概念？'])
  ('negated, hypothetical, quoted, capability and topic reset do not authorize deletion: %s', text => expect(explicitMemoryDeleteRequest(text)).toBe(false));

test('deletion evidence binds only the latest user turn and a matching current read revision', () => {
  const source = '请删除关于颜色的记忆。', options = { userTurns: ['过去请删除记忆', source], currentTurn: 1,
    readReceipts: [{ path: 'preferences.md', revision }] };
  expect(validateMemoryDeleteEvidence(args(), options)).toEqual({ sourceText: source, quote: source });
  expect(() => validateMemoryDeleteEvidence(args({ evidence: { sourceTurn: 0, quote: '过去请删除记忆' } }), options))
    .toThrow(expect.objectContaining({ code: 'AI_MEMORY_DELETE_NOT_REQUESTED' }));
  expect(() => validateMemoryDeleteEvidence(args(), { ...options, sourceText: '不同原文' })).toThrow();
  expect(() => validateMemoryDeleteEvidence(args(), { ...options, readReceipts: [] }))
    .toThrow(expect.objectContaining({ code: 'AI_MEMORY_REVISION_REQUIRED' }));
  expect(() => validateMemoryDeleteEvidence(args(), { ...options, readReceipts: [{ path: 'other.md', revision }] })).toThrow();
  expect(() => validateMemoryDeleteEvidence(args(), { ...options, readReceipts: [{ path: 'preferences.md', revision: 'b'.repeat(64) }] })).toThrow();
});

test('a quote stripped of source negation cannot authorize deletion and an explicitly named different file is rejected', () => {
  const input = args({ evidence: { sourceTurn: 0, quote: '删除记忆' } });
  expect(() => validateMemoryDeleteEvidence(input, { userTurns: ['不要删除记忆'], currentTurn: 0,
    readReceipts: [{ path: 'preferences.md', revision }] })).toThrow();
  expect(() => validateMemoryDeleteEvidence(args({ evidence: { sourceTurn: 0, quote: '删除记忆 other.md' } }), {
    userTurns: ['删除记忆 other.md'], currentTurn: 0, readReceipts: [{ path: 'preferences.md', revision }] })).toThrow();
});
