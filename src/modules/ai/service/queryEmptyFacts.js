// A zero match establishes an empty selected query, not its cause.
const { getDatasetCapability } = require('./datasetCapabilities');
const { fundQueryFacts } = require('./queryFundProse');
const FUND_IDS = new Set(['fund-holdings', 'fund-history']);
const CONTEXT_REQUEST = /记忆|记住|牢记|偏好|(?:我)?(?:说过|问过)什么|(?:历史|之前|以前|过去|更早)[^。！？\n]{0,20}(?:对话|聊天|消息|原话|说过|问过|告诉(?:我|你))|(?:对话|聊天)(?:历史|记录)|\b(?:memory|preferences?|remember|memorize|conversation\s+history|chat\s+history)\b/i;
function validDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validScope(scope) {
  return scope && validDate(scope.startDate) && validDate(scope.endDate) && scope.startDate <= scope.endDate;
}
function isProvenEmptyDataset(dataset) {
  const meta = dataset?.queryMeta, capability = getDatasetCapability(dataset?.datasetId);
  return !!(capability && dataset.domain === capability.domain && typeof dataset.title === 'string' && dataset.title.trim()
    && meta?.version === 1 && meta.datasetId === dataset.datasetId && /^q_[a-f0-9]{24}$/.test(meta.queryId || '')
    && validScope(meta.requestedScope) && validScope(meta.effectiveScope)
    && meta.rowsComplete === true && meta.matchedRowCount === 0 && meta.returnedRowCount === 0
    && meta.returnedDateRange === null && dataset.truncated !== true
    && Array.isArray(dataset.rows) && dataset.rows.length === 0
    && ['count', 'totalCount', 'incomeCount', 'expenseCount', 'unpricedCount', 'income', 'expense', 'net', 'surplus', 'deficit'].every(key =>
      dataset.summary?.[key] == null || dataset.summary[key] === 0 || typeof dataset.summary[key] === 'string' && /^[+-]?0(?:\.0+)?$/.test(dataset.summary[key])));
}
function buildProvenEmptyQueryFacts(datasets = [], { message = '', toolTrace = [], activeMetric = '' } = {}) {
  // Context answers and write receipts remain on their established reconciliation
  // path. Even a failed context call is enough to decline this presentation.
  if (CONTEXT_REQUEST.test(String(message)) || toolTrace.some(item => /^(?:memory|history)_/.test(item.tool || ''))
    || !datasets.length || !datasets.every(isProvenEmptyDataset)) return '';
  // Keep the existing server-authored no-comparable-ranking response.
  const dedicated = datasets.filter(dataset => activeMetric === 'transaction-max' && dataset.datasetId === 'finance-transactions'
    && dataset.queryMeta.sort === 'amountDesc' && ['expense', 'income'].includes(dataset.queryMeta.filters?.direction)
    || activeMetric === 'daily-max' && dataset.datasetId === 'finance-daily'
      && (dataset.queryMeta.sort === 'expenseDesc' && dataset.queryMeta.filters?.direction === 'expense'
        || dataset.queryMeta.sort === 'incomeDesc' && dataset.queryMeta.filters?.direction === 'income'));
  if (dedicated.length === 1) return '';
  const ordinary = datasets.filter(dataset => !FUND_IDS.has(dataset.datasetId)), parts = [];
  if (ordinary.length) parts.push('本轮范围及筛选条件下没有匹配记录。');
  if (ordinary.some(dataset => dataset.datasetId === 'work-salary'))
    parts.push('没有工资记录不等于零工资，工资登记也不代表银行到账。');
  if (ordinary.some(dataset => ['account-balances', 'card-bills', 'asset-snapshots', 'asset-registers', 'asset-composition', 'asset-comparison', 'fixedAsset-saved'].includes(dataset.datasetId)))
    parts.push('没有匹配记录不能据此认定余额、资产或欠款为零。');
  const savedTitles = [...new Set(ordinary.filter(dataset => getDatasetCapability(dataset.datasetId).datePolicy.semantics === 'saved-state').map(dataset => dataset.title))];
  for (const title of savedTitles) parts.push(`${title}读取目前已保存状态，不按查询起止日期筛选；无法凭该数据集证明历史时点。`);
  if (ordinary.some(dataset => dataset.datasetId === 'installment-plans'))
    parts.push('分期计划读取目前保存配置，日期范围仅限定期次状态。');
  // Preserve the dedicated fund statement and unknown-versus-zero contract.
  const funds = fundQueryFacts(datasets.filter(dataset => FUND_IDS.has(dataset.datasetId)));
  if (funds) parts.push(funds);
  return parts.join('\n\n');
}
module.exports = { buildProvenEmptyQueryFacts, isProvenEmptyDataset };
