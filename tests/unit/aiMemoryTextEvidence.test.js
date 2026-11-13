const { memoryLineSnippet, memoryReadPage } = require('../../src/modules/ai/service/memoryTextEvidence');

test('ME03 authoritative line length stays 307 while the full body is 404 characters', () => {
  const line = '超长验收关键字' + '汉'.repeat(300);
  const content = [line, ...Array.from({ length: 8 }, (_, i) => `超长验收关键字 第${i + 1}行`)].join('\n') + '\n';
  const page = memoryReadPage(content);
  expect(page).toMatchObject({ contentLength: 404, returnedCharCount: 404, truncated: false, nextOffset: null,
    characterUnit: 'unicode-code-point' });
  expect(page.lines[0]).toEqual({ line: 1, bodyOffset: 0, lineCharLength: 307, returnedCharCount: 307,
    returnedRange: { start: 1, endExclusive: 308 }, textTruncated: false });
  expect(memoryLineSnippet(line, 240)).toMatchObject({ lineCharLength: 307, returnedCharCount: 240,
    returnedRange: { start: 1, endExclusive: 241 }, textTruncated: true });
});

test('read ranges count Unicode code points and retain CRLF body offsets', () => {
  const page = memoryReadPage('甲😀乙\r\nEnglish\r\n', { offset: 1, limit: 6 });
  expect(page).toMatchObject({ content: '😀乙\r\nEn', contentLength: 14, offset: 1, returnedCharCount: 6,
    truncated: true, nextOffset: 7 });
  expect(page.lines).toEqual([
    { line: 1, bodyOffset: 0, lineCharLength: 3, returnedCharCount: 2,
      returnedRange: { start: 2, endExclusive: 4 }, textTruncated: true },
    { line: 2, bodyOffset: 5, lineCharLength: 7, returnedCharCount: 2,
      returnedRange: { start: 1, endExclusive: 3 }, textTruncated: true }
  ]);
});

test('a page confined to a CRLF reports zero returned line characters', () => {
  const page = memoryReadPage('甲😀乙\r\nEnglish', { offset: 3, limit: 2 });
  expect(page.content).toBe('\r\n');
  expect(page.lines).toEqual([{ line: 1, bodyOffset: 0, lineCharLength: 3, returnedCharCount: 0,
    returnedRange: { start: 4, endExclusive: 4 }, textTruncated: true }]);
});

test('empty lines use an empty column range and trailing separators do not invent returned text', () => {
  const page = memoryReadPage('A\n\nB\n');
  expect(page.lines).toEqual([
    { line: 1, bodyOffset: 0, lineCharLength: 1, returnedCharCount: 1,
      returnedRange: { start: 1, endExclusive: 2 }, textTruncated: false },
    { line: 2, bodyOffset: 2, lineCharLength: 0, returnedCharCount: 0,
      returnedRange: { start: 1, endExclusive: 1 }, textTruncated: false },
    { line: 3, bodyOffset: 3, lineCharLength: 1, returnedCharCount: 1,
      returnedRange: { start: 1, endExclusive: 2 }, textTruncated: false }
  ]);
  expect(memoryLineSnippet('', 240)).toEqual({ text: '', lineCharLength: 0, returnedCharCount: 0,
    returnedRange: { start: 1, endExclusive: 1 }, textTruncated: false });
});

test.each([3, 10])('offset at or beyond EOF (%i) returns no false line coverage', offset => {
  expect(memoryReadPage('甲😀乙', { offset, limit: 2 })).toEqual({ content: '', characterUnit: 'unicode-code-point',
    contentLength: 3, offset, returnedCharCount: 0, truncated: false, nextOffset: null, lines: [],
    lineEvidenceTruncated: false, nextLineEvidenceOffset: null });
});

test('an exact page ending before the newline can still contain a complete line', () => {
  const page = memoryReadPage('甲😀乙\nNext', { limit: 3 });
  expect(page).toMatchObject({ truncated: true, nextOffset: 3 });
  expect(page.lines[0]).toMatchObject({ lineCharLength: 3, returnedCharCount: 3,
    returnedRange: { start: 1, endExclusive: 4 }, textTruncated: false });
});

test('line metadata stays bounded and exposes a continuation distinct from text pagination', () => {
  const content = 'A\n'.repeat(60), page = memoryReadPage(content);
  expect(page.lines).toHaveLength(50);
  expect(page).toMatchObject({ truncated: false, nextOffset: null,
    lineEvidenceTruncated: true, nextLineEvidenceOffset: 100 });
  const rest = memoryReadPage(content, { offset: page.nextLineEvidenceOffset });
  expect(rest.lines).toHaveLength(10);
  expect(rest.lines[0]).toMatchObject({ line: 51, bodyOffset: 100, lineCharLength: 1, returnedCharCount: 1 });
  expect(rest).toMatchObject({ lineEvidenceTruncated: false, nextLineEvidenceOffset: null });
});
