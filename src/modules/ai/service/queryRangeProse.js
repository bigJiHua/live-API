const { getDatasetCapability } = require('./datasetCapabilities');
function queryRangeProse(datasets = []) {
  const seen = new Set(), notes = [];
  for (const dataset of datasets) {
    const meta = dataset.queryMeta, requested = meta?.requestedScope, actual = meta?.effectiveScope;
    if (!requested || !actual || requested.startDate === actual.startDate && requested.endDate === actual.endDate) continue;
    const key = JSON.stringify([dataset.datasetId, requested, actual]);
    if (seen.has(key)) continue; seen.add(key);
    const bounded = requested.startDate !== actual.startDate && (Date.parse(requested.endDate) - Date.parse(requested.startDate)) / 86400000 >= 366;
    const historyEnd = requested.endDate !== actual.endDate && getDatasetCapability(dataset.datasetId)?.datePolicy.historyThroughToday;
    notes.push(`${dataset.title}：原请求范围 ${requested.startDate} 至 ${requested.endDate}，实际读取范围 ${actual.startDate} 至 ${actual.endDate}。`
      + (bounded ? '实际读取范围未覆盖原请求，不能代表原请求的全量记录。' : '')
      + (historyEnd ? `历史记录实际截至 ${actual.endDate}，不代表请求结束日期前的完整期间。` : ''));
  }
  return notes.join('\n');
}
module.exports = { queryRangeProse };
