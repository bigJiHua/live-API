'use strict';
// Remove Markdown tables only when the header and separator have no rows.
// Code fences and ordinary text containing pipes keep their exact content.
function clearEmptyQueryTables(text) {
  const lines = String(text || '').split('\n');
  const cells = line => /^\s*\|/.test(line) && /\|\s*$/.test(line)
    ? line.trim().slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim()) : null;
  const separator = line => { const values = cells(line); return values && values.length > 1 && values.every(value => /^:?-{3,}:?$/.test(value)); };
  let fence = null;
  for (let index = 0; index < lines.length - 1; index++) {
    const marker = /^\s*(```+|~~~+)/.exec(lines[index]);
    if (marker) { fence = fence ? null : marker[1][0]; continue; }
    if (fence) continue;
    const header = cells(lines[index]);
    if (!header || header.length < 2 || !separator(lines[index + 1])) continue;
    const row = cells(lines[index + 2] || '');
    if (row && row.length === header.length && !separator(lines[index + 2])) continue;
    lines[index] = ''; lines[index + 1] = '';
    let previous = index - 1;
    while (previous >= 0 && !lines[previous].trim()) previous--;
    if (previous >= 0 && /(?:如下|下表|这(?:一)?条|(?:本次|当前)?展示|明细|列表|排行|排序)[^。；;！？\n]{0,45}[：:]\s*$/.test(lines[previous].trim())) lines[previous] = '';
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
module.exports = { clearEmptyQueryTables };
