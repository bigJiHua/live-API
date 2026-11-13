'use strict';

const CHARACTER_UNIT = 'unicode-code-point';
const LINE_EVIDENCE_LIMIT = 50;

// Line columns are 1-based, endExclusive excludes the last column. Lengths
// exclude CR/LF; body offsets and body lengths include the original newlines.
function memoryLineSnippet(text, snippetChars) {
  const chars = Array.from(text), returnedCharCount = Math.min(chars.length, snippetChars);
  return { text: chars.slice(0, returnedCharCount).join(''), lineCharLength: chars.length,
    returnedCharCount, returnedRange: { start: 1, endExclusive: returnedCharCount + 1 },
    textTruncated: returnedCharCount < chars.length };
}

function memoryReadPage(content, { offset = 0, limit = 3000 } = {}) {
  if (typeof content !== 'string' || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
    throw new TypeError('Invalid memory read page');
  const chars = Array.from(content), start = Math.min(offset, chars.length), end = Math.min(chars.length, offset + limit);
  const lines = [];
  let nextLineEvidenceOffset = null;
  let bodyOffset = 0, line = 1;
  for (let index = 0; index <= chars.length; index++) {
    if (index < chars.length && chars[index] !== '\n') continue;
    const hasNewline = index < chars.length;
    const textEnd = hasNewline && index > bodyOffset && chars[index - 1] === '\r' ? index - 1 : index;
    const spanEnd = hasNewline ? index + 1 : index;
    if (bodyOffset < end && spanEnd > start) {
      const lineCharLength = textEnd - bodyOffset;
      const from = Math.max(bodyOffset, Math.min(start, textEnd));
      const to = Math.max(from, Math.min(end, textEnd));
      const returnedCharCount = to - from;
      if (lines.length < LINE_EVIDENCE_LIMIT) {
        lines.push({ line, bodyOffset, lineCharLength, returnedCharCount,
          returnedRange: { start: from - bodyOffset + 1, endExclusive: to - bodyOffset + 1 },
          textTruncated: returnedCharCount < lineCharLength });
      } else if (nextLineEvidenceOffset === null) nextLineEvidenceOffset = bodyOffset;
    }
    bodyOffset = spanEnd;
    line++;
  }
  return { content: chars.slice(start, end).join(''), characterUnit: CHARACTER_UNIT,
    contentLength: chars.length, offset, returnedCharCount: end - start,
    truncated: end < chars.length, nextOffset: end < chars.length ? end : null, lines,
    lineEvidenceTruncated: nextLineEvidenceOffset !== null, nextLineEvidenceOffset };
}

module.exports = { CHARACTER_UNIT, LINE_EVIDENCE_LIMIT, memoryLineSnippet, memoryReadPage };
