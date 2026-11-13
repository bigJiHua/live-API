// Render query metadata as user-facing language without rewriting source text cells.
const METADATA_LABELS = {
  requestedScope: '原请求范围', effectiveScope: '实际读取范围',
  matchedRowCount: '匹配数量', returnedRowCount: '本次展示数量',
  sourceRecordCount: '来源记录数量', returnedDateRange: '返回记录日期范围',
  rowsComplete: '明细覆盖状态', summaryComplete: '汇总覆盖状态',
  rankingComplete: '金额排名覆盖状态', queryMeta: '查询信息', resolution: '统计粒度', page: '本次分页',
};
const METADATA_PATTERN = /\b(?:requestedScope|effectiveScope|matchedRowCount|returnedRowCount|sourceRecordCount|returnedDateRange|rowsComplete|summaryComplete|rankingComplete|queryMeta|resolution|page|nextCursor)\b|\b(?:truncated|limit)\b[`"']?\s*[:=：]/;
const keyToken = name => '[`"\']?\\b' + name + '\\b[`"\']?';

function rewriteMetadataSegment(text) {
  let value = text;
  value = value.replace(/lq1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/g, '（续查凭据由系统保存）');
  value = value.replace(new RegExp(keyToken('resolution') + '\\s*[:=：]\\s*["\']?(detail|month|year)["\']?', 'g'),
    (_, resolution) => '统计粒度为' + ({ detail: '明细', month: '月', year: '年' }[resolution]));
  const scope = '(?:' + keyToken('requestedScope') + '\\s*=\\s*' + keyToken('effectiveScope')
    + '|' + keyToken('effectiveScope') + '\\s*=\\s*' + keyToken('requestedScope') + ')';
  value = value.replace(new RegExp(scope, 'g'), '原请求范围与实际读取范围一致');
  const flags = {
    rowsComplete: ['明细尚未全部返回', '已返回全部匹配行'],
    summaryComplete: ['汇总尚未确认覆盖完整范围', '汇总覆盖完整范围'],
    rankingComplete: ['金额排名尚未确认覆盖完整范围', '金额排名覆盖完整范围'],
    truncated: ['本次未截取匹配记录', '仅展示部分匹配记录'],
  };
  for (const [name, labels] of Object.entries(flags)) {
    value = value.replace(new RegExp(keyToken(name) + '\\s*[:=：]\\s*(true|false)\\b', 'g'),
      (_, flag) => labels[Number(flag === 'true')]);
  }
  value = value.replace(new RegExp(keyToken('limit') + '\\s*[:=：]\\s*(\\d+)\\b', 'g'),
    (_, count) => '本次展示上限为 ' + count + ' 行');
  for (const [name, label] of Object.entries(METADATA_LABELS)) {
    value = value.replace(new RegExp(keyToken(name) + '\\s*[:=：]\\s*', 'g'), label + '为 ')
      .replace(new RegExp(keyToken(name), 'g'), label);
  }
  return value.replace(/(匹配数量|本次展示数量|来源记录数量)[：:]\s*\1为\s*/g, '$1：');
}

function normalizeQueryMetadataProse(text, datasets = []) {
  const original = String(text || '');
  if (!METADATA_PATTERN.test(original)) return original;
  const cells = new Set(datasets.flatMap(dataset => {
    const keys = (dataset.columns || []).filter(column => column.type === 'text').map(column => column.key);
    return (dataset.rows || []).flatMap(row => keys.map(key => row[key]))
      .filter(value => typeof value === 'string' && value && METADATA_PATTERN.test(value));
  }));
  // Work with exact spans instead of placeholder tokens that source text could impersonate.
  const spans = [];
  for (const cell of cells) {
    let start = original.indexOf(cell);
    while (start >= 0) {
      spans.push({ start, end: start + cell.length });
      start = original.indexOf(cell, start + 1);
    }
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  let cursor = 0, answer = '';
  for (const span of merged) {
    answer += rewriteMetadataSegment(original.slice(cursor, span.start)) + original.slice(span.start, span.end);
    cursor = span.end;
  }
  return answer + rewriteMetadataSegment(original.slice(cursor));
}

module.exports = { normalizeQueryMetadataProse };
