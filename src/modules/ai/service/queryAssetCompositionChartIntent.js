// Complete one explicitly requested CNY composition pie from this turn's approved rows.
const { semanticMessage } = require('./queryDatasetIntent');
const { goalDataset } = require('./queryEvidenceGate');
const NON_CREDIT_TYPES = new Set(['debit', 'virtual_cash', 'virtual_balance', 'virtual_wechat', 'virtual_alipay']);
function explicitCompositionPie(text) {
  const value = semanticMessage(text);
  if (/(?:不(?:要|用)?(?:按|以)|不再按|拒绝按)账户类型|不(?:要|用|使用|采用)(?:已保存(?:的)?)?非信用正资产|(?:横轴|纵轴|[xyXY]轴)[^，,；;。！？!?\n]{0,24}(?:币种|日期|月份|时间|负债|额度)/.test(value)) return false;
  const pattern = /(?:以|按)账户类型(?:和|与|及|×)(?:已保存(?:的)?)?非信用正资产(?:值|金额)?(?:给|作|画|生成|绘制|展示)(?:组成)?饼图/g;
  const matches = [...value.matchAll(pattern)];
  if (matches.length !== 1 || (value.match(/饼图/g) || []).length !== 1) return false;
  return matches.some(match => {
    const prefix = value.slice(0, match.index).split(/[，,；;。！？!?\n]|但是|而是/).at(-1);
    const suffix = value.slice(match.index + match[0].length).split(/[，,；;。！？!?\n]/)[0];
    return !suffix.trim() && !/(?:不要|不用|无需|不需要|不画|不以|不按|取消)[^，,；;。！？!?\n]{0,30}$/.test(prefix);
  });
}
function nonnegativeMoney(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER / 100 ? number : null;
}
function knownAssetCompositionPie(goals, datasets, queryInputs, today) {
  if ((goals || []).filter(goal => goal.task?.chartRequest).length !== 1) return null;
  const matching = [];
  for (const goal of goals || []) {
    const task = goal.task;
    if (task?.mode !== 'query' || task.subject !== 'asset' || task.metric !== 'asset-composition'
      || task.targetDatasetId !== 'asset-composition' || task.chartRequest?.type !== 'pie'
      || task.comparisonScopes?.length || !explicitCompositionPie(goal.text)
      || goal.constraints?.filter !== 'CNY') continue;
    const candidates = (datasets || []).filter(dataset => dataset.datasetId === 'asset-composition');
    if (candidates.length !== 1) continue;
    const dataset = candidates[0], meta = dataset.queryMeta, args = queryInputs?.get(meta?.queryId);
    if (!meta || !args || args.queryId !== meta.queryId || args.datasetId !== dataset.datasetId || args.filter !== 'CNY'
      || dataset.domain !== 'asset' || dataset.coverage !== 'saved-balance-by-type-currency'
      || goalDataset(goal, candidates, queryInputs, today) !== dataset
      || meta.rowsComplete !== true || dataset.truncated === true
      || !dataset.rows?.length || meta.returnedRowCount !== dataset.rows.length || meta.matchedRowCount !== dataset.rows.length
      || !Number.isSafeInteger(meta.sourceRecordCount) || meta.sourceRecordCount <= 0) continue;
    const columns = [['type', 'text'], ['currency', 'text'], ['positiveAssets', 'money'], ['count', 'number'], ['missingSnapshots', 'number']];
    if (!columns.every(([key, type]) => (dataset.columns || []).filter(column => column.key === key && column.type === type).length === 1)) continue;
    const labels = new Set(); let sourceCount = 0, hasPositive = false, usable = true;
    for (const row of dataset.rows) {
      const amount = nonnegativeMoney(row.positiveAssets);
      if (!NON_CREDIT_TYPES.has(row.type) || labels.has(row.type) || row.currency !== 'CNY'
        || amount === null || row.missingSnapshots !== 0 || !Number.isSafeInteger(row.count) || row.count <= 0) { usable = false; break; }
      labels.add(row.type); sourceCount += row.count; hasPositive ||= amount > 0;
    }
    if (!usable || !hasPositive || !Number.isSafeInteger(sourceCount) || sourceCount !== meta.sourceRecordCount) continue;
    matching.push({ dataset, task });
  }
  if (matching.length !== 1) return null;
  const { dataset } = matching[0];
  return { datasetId: dataset.datasetId, queryId: dataset.queryMeta.queryId, type: 'pie', xKey: 'type',
    yKeys: ['positiveAssets'], title: dataset.title };
}
function clearCompletedAssetPieRetry(text) {
  return (String(text || '').match(/[^。；;！？\n]+[。；;！？]?|\n+/g) || [])
    .filter(part => !/^(?:如需|如果需要)(?:我)?再(?:试一次|尝试)(?:生成|绘制|画)(?:组成)?饼图(?:请告知|请告诉我)[。；;！？]?$/.test(part.trim()))
    .join('').replace(/\n{3,}/g, '\n\n');
}
module.exports = { knownAssetCompositionPie, clearCompletedAssetPieRetry };
