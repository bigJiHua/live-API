'use strict';

const { clearOrphanQueryHeadings } = require('./queryCoverageProse');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

// This is a presentation for an already validated, query-bound transaction
// chart. It must never select a different dataset or infer counts from prose.
function transactionChartDataset(chart, datasets) {
  if (!chart || chart.datasetId !== 'finance-transactions' || chart.type !== 'bar'
    || chart.xKey !== 'date' || !Array.isArray(chart.yKeys) || chart.yKeys.length !== 1
    || chart.yKeys[0] !== 'amountCNY' || !/^q_[a-f0-9]{24}$/.test(chart.queryId || '')) return null;
  const matching = datasets.filter(dataset => dataset?.datasetId === chart.datasetId
    && dataset.queryMeta?.queryId === chart.queryId);
  if (matching.length !== 1) return null;
  const dataset = matching[0], meta = dataset.queryMeta, scope = meta.effectiveScope;
  if (!Array.isArray(dataset.rows) || !dataset.rows.length || !Array.isArray(dataset.columns)
    || !dataset.columns.some(column => column.key === 'date' && column.type === 'date')
    || !dataset.columns.some(column => column.key === 'amountCNY' && ['money', 'decimal', 'number'].includes(column.type))
    || !date(scope?.startDate) || !date(scope?.endDate) || scope.startDate > scope.endDate
    || !Number.isInteger(meta.returnedRowCount) || meta.returnedRowCount !== dataset.rows.length
    || meta.matchedRowCount !== null && (!Number.isInteger(meta.matchedRowCount) || meta.matchedRowCount < meta.returnedRowCount)
    || typeof meta.rowsComplete !== 'boolean'
    || meta.rowsComplete && meta.matchedRowCount !== null && meta.matchedRowCount !== meta.returnedRowCount) return null;
  return dataset;
}

function requestsWrittenRows(message) {
  const clauses = String(message || '').split(/[。；;！？\n]/u);
  return clauses.some(clause => {
    const match = /列出|罗列|抄出|逐(?:条|笔)列|原文|\b(?:list|quote|verbatim)\b/iu.exec(clause);
    return match && !/(?:不要|无需|不必|不用|别|勿|don't|do not|without)[^，,。；;！？\n]{0,20}$/iu.test(clause.slice(0, match.index));
  });
}

function isCopiedRow(line, row, columns) {
  // Date plus amount binds the line to one returned record. Any remaining
  // explanation prevents removal, including numbered analysis and suggestions.
  const listed = /^\s*(?:\d+(?:[.．](?!\d)|[)）、])|[（(]\d+[）)])\s*(.*)$/u.exec(line);
  if (!listed || !date(row?.date) || row.amountCNY === null || row.amountCNY === undefined
    || !Number.isFinite(Number(row.amountCNY))) return false;
  let rest = listed[1];
  if (!rest.includes(row.date)) return false;
  rest = rest.replace(row.date, ' ');
  // Only the returned text cells are removable labels, never invented prose.
  for (const key of ['category', 'remark']) if (typeof row[key] === 'string' && row[key]) rest = rest.replace(row[key], ' ');
  const direction = row.direction === 0 || row.direction === 'expense' ? ['支出', 'expense']
    : row.direction === 1 || row.direction === 'income' ? ['收入', 'income'] : [];
  for (const token of direction) rest = rest.replace(new RegExp(token, 'iu'), ' ');
  for (const column of columns) if (['date', 'amountCNY', 'category', 'remark', 'direction'].includes(column.key)
    && typeof column.label === 'string' && column.label) rest = rest.replace(column.label, ' ');
  rest = rest.replace(/\bCNY\b|人民币|元/giu, ' ');
  const numbers = [...rest.matchAll(/[-+]?\d[\d,]*(?:\.\d+)?/g)];
  if (numbers.length !== 1 || Number(numbers[0][0].replace(/,/g, '')) !== Number(row.amountCNY)) return false;
  rest = rest.slice(0, numbers[0].index) + ' ' + rest.slice(numbers[0].index + numbers[0][0].length);
  return !rest.replace(/[\s:：|,，;；()（）［］\[\]「」“”'".。—-]/gu, '');
}

function queryChartPresentation({ prose = '', chart, datasets = [], message = '', language = 'zh' } = {}) {
  const original = String(prose || ''), dataset = transactionChartDataset(chart, datasets);
  if (!dataset) return { prose: original, notice: '' };
  const meta = dataset.queryMeta, scope = meta.effectiveScope, returned = meta.returnedRowCount;
  const english = language === 'en';
  const kind = { expense: '支出', income: '收入', both: '收支' }[meta.filters?.direction] || '收支';
  const matched = meta.matchedRowCount === null
    ? english ? 'The total number of matching transactions is unknown.' : '全范围匹配笔数尚未确定。'
    : english ? `The query matched ${meta.matchedRowCount} transactions.` : `全范围匹配 ${meta.matchedRowCount} 笔。`;
  const completion = meta.matchedRowCount === null ? '' : meta.rowsComplete
    ? english ? 'All matching transactions in this range were returned.' : '该范围的匹配明细已全部返回。'
    : meta.matchedRowCount > returned
      ? english ? 'Other matching transactions are not shown in this chart.' : '图中未展示其余匹配明细。'
      : english ? 'Full detail coverage has not been confirmed.' : '明细覆盖完整性尚未确认。';
  const summary = !meta.rowsComplete && meta.summaryComplete === true
    && (dataset.summary?.income != null || dataset.summary?.expense != null)
    ? english ? 'Full-range summary totals are separate from the transactions plotted here.' : '全范围汇总金额与图中这些明细的合计分别看待。' : '';
  const notice = english
    ? [`This chart shows only the ${returned} returned transactions, from ${scope.startDate} to ${scope.endDate}.`, matched, completion,
      'Each bar represents one transaction; transactions on the same date remain separate bars.', summary].filter(Boolean).join(' ')
    : [`这张图仅展示本次返回的 ${returned} 笔${kind}明细，查询范围 ${scope.startDate} 至 ${scope.endDate}。`, matched, completion,
      '每根柱子对应一笔交易，同日多笔交易分别绘制。', summary].filter(Boolean).join('');
  // With multiple datasets, an identical row may belong to another subject.
  // Keep its prose unless this turn has only the bound transaction dataset.
  if (datasets.length !== 1 || requestsWrittenRows(message)) return { prose: original, notice };
  const lines = original.split(/\r?\n/), kept = lines.filter(line => !dataset.rows.some(row => isCopiedRow(line, row, dataset.columns)));
  const cleaned = kept.length === lines.length ? original : clearOrphanQueryHeadings(kept.join('\n'));
  return { prose: cleaned, notice };
}

module.exports = { queryChartPresentation };
