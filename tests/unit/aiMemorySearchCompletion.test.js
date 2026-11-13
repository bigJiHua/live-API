const { explicitMemorySearchGoal, memorySearchCompletion } = require('../../src/modules/ai/service/memorySearchCompletion');

const message = 'Search my saved memory for the literal text "English" and show me the matching original text.';
const search = overrides => ({ args: { pattern: 'English', mode: 'literal' }, result: {
  matches: [{ path: 'preferences.md', line: 2, text: 'I prefer English and red; I do not prefer blue.', textTruncated: false }],
  count: 1, truncated: false, warnings: [], ...overrides } });
const complete = (context = {}, searches = [search()]) => memorySearchCompletion({ message, ...context, searches });

test('the actual M06 request completes from its full line result without claiming a full file read', () => {
  const result = complete();
  expect(result).toMatchObject({ pattern: 'English', mode: 'literal' });
  expect(result.finalizationInstruction).toContain('行级匹配结果');
  expect(result.finalizationInstruction).toContain('不声称已读取文件全文');
});

test('the actual Chinese single literal search target remains explicit', () => {
  expect(explicitMemorySearchGoal({ message: '请在我的长期记忆中按字面搜索“红色”，告诉我匹配的文件和原文内容。' }))
    .toEqual({ pattern: '红色', mode: 'literal' });
});

test('a complete regex result can finish without evaluating the user expression on the API event loop', () => {
  const regex = '^(a+)+$';
  const context = { message: `Search my saved memory using regex "${regex}" and show me the matching original text.` };
  const searches = [{ args: { pattern: regex, mode: 'regex' }, result: { ...search().result,
    matches: [{ path: 'note.md', line: 1, text: 'aaa', textTruncated: false }] } }];
  expect(complete(context, searches)).toMatchObject({ pattern: regex, mode: 'regex' });
});

test('an empty complete search is enough for an honest no-match finalization', () => {
  expect(complete({}, [search({ count: 0, matches: [] })])).toMatchObject({ pattern: 'English', mode: 'literal' });
});

test.each([
  'Search my saved memory for "English" and "红色".',
  'Search my saved memory for "English" and update that file.',
  'Search my saved memory for "English" and show June expenses.',
  'Search my saved memory for "English" then read all files in full.',
  '请在我的长期记忆中按字面搜索“红色”，同时查六月支出。',
  '请在我的长期记忆中按字面搜索“红色”，然后替换为蓝色。',
  'What programming language do I prefer? Read my saved memory.',
  'Search my saved memory for an unspecified preference.'
])('mixed, writing, full-read or unknown tasks do not force a search-only completion: %s', text => {
  expect(complete({ message: text })).toBeNull();
});

test.each([
  { hasBusinessTask: true },
  { currentQueryGoals: [{ subject: 'finance' }] },
  { taskContext: { mode: 'query', subject: 'finance' } },
  { taskContext: { mode: 'record' } },
  { taskContext: { mode: 'pending-supplement' } }
])('current business or write tasks keep the original tool path: %j', context => {
  expect(complete(context)).toBeNull();
});

test.each([
  { status: 'error' }, { status: 'failed' }, { truncated: true }, { warnings: [{ code: 'AI_MEMORY_READ_FAILED' }] },
  { warnings: undefined }, { count: 2 },
  { matches: [{ ...search().result.matches[0], textTruncated: true }] },
  { matches: [{ ...search().result.matches[0], textTruncated: undefined }] },
  { matches: [null] },
  { matches: [{ ...search().result.matches[0], text: 'The requested needle is absent.' }] }
])('error, unknown, truncated or incomplete line evidence does not terminate further reading: %j', result => {
  expect(complete({}, [search(result)])).toBeNull();
});

test.each([{ pattern: 'Chinese', mode: 'literal' }, { pattern: 'English', mode: 'regex' }])('a successful search of other args is not evidence for this target: %j', args => {
  expect(complete({}, [{ ...search(), args }])).toBeNull();
});

test('old successful search fixtures without line completeness metadata stay on the ordinary path', () => {
  const old = search(); delete old.result.matches[0].textTruncated;
  expect(complete({}, [old])).toBeNull();
});
