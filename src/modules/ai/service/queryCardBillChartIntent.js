const chartWords = /图表|柱状|折线|曲线|chart/i;
function explicitCardAxis(message) {
  const text = String(message || '').replace(/“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/g, ' ');
  return text.split(/[。！？\n]/).some(clause => chartWords.test(clause) && [...clause.matchAll(/逐卡|按(?:每张)?(?:信用)?卡(?:片)?|每张(?:信用)?卡(?:片)?|各张?(?:信用)?卡(?:片)?/g)]
    .some(match => !/(?:不(?:要|用|按|需要|想(?:要)?)?|别|禁止|取消)\s*(?:(?:再|给|看|我们|我)\s*)*$/.test(clause.slice(0, match.index))));
}
function pinCardBillChartAxis(chart, datasets = [], { message, tasks = [] } = {}) {
  if (!explicitCardAxis(message)) return chart;
  const requested = tasks.filter(task => task.mode === 'query' && task.subject === 'cards' && task.metric === 'card-bills'
    && ['bar', 'line'].includes(task.chartRequest?.type));
  if (requested.length !== 1) return chart;
  const eligible = datasets.filter(dataset => dataset.datasetId === 'card-bills' && dataset.domain === 'card'
    && dataset.queryMeta?.datasetId === dataset.datasetId && /^q_[a-f\d]{24}$/.test(dataset.queryMeta.queryId || '')
    && Array.isArray(dataset.rows) && dataset.rows.length > 0 && dataset.queryMeta.returnedRowCount === dataset.rows.length
    && Array.isArray(dataset.columns)
    && dataset.columns.some(column => column.key === 'name' && column.type === 'text')
    && dataset.columns.some(column => column.key === 'month' && column.type === 'date'));
  if (eligible.length !== 1) return chart;
  const dataset = eligible[0];
  if (chart) {
    // Do not rescue an unauthorized query or an invented derived column. Only
    // a real month/name axis can be pinned to the user's explicit card intent.
    if (chart.datasetId !== dataset.datasetId || chart.queryId != null && chart.queryId !== dataset.queryMeta.queryId
      || !['name', 'month'].includes(chart.xKey) || chart.type !== requested[0].chartRequest.type
      || !Array.isArray(chart.yKeys) || !chart.yKeys.length
      || !chart.yKeys.every(key => dataset.columns.some(column => column.key === key && column.type === 'money'))) return chart;
    return { ...chart, queryId: dataset.queryMeta.queryId, xKey: 'name' };
  }
  const keys = [/(?:本期)?账单/.test(message) && 'billAmount', /待还/.test(message) && 'needRepay'].filter(Boolean);
  if (!keys.length || !keys.every(key => dataset.columns.some(column => column.key === key && column.type === 'money'))) return chart;
  return { datasetId: dataset.datasetId, queryId: dataset.queryMeta.queryId, type: requested[0].chartRequest.type,
    xKey: 'name', yKeys: keys, title: dataset.title };
}
module.exports = { explicitCardAxis, pinCardBillChartAxis };
