const { getDatasetCapability, DATASETS } = require('./datasetCapabilities');

// Error codes alone are insufficient: only errors produced at a known input
// validation boundary may be returned to a model for one correction.
const parameterErrors = new WeakMap();
const CODES = new Set(['AI_INVALID_INPUT', 'AI_TOOL_ARGUMENT_INVALID', 'AI_SCOPE_INVALID']);
const RESERVED_PATH = /(?:^|\.)(?:sql(?:[_-]?(?:query|statement))?|owner(?:[_-]?Id)?|user(?:[_-]?Id)?|query[_-]?id|database|db|connection(?:[_-]?Id)?|api[_-]?key|authorization|password|token|secret)$/i;
function markToolParameterError(error, issues) {
  if (error && typeof error === 'object' && CODES.has(error.code)) {
    const fields = issues || error.validationDiagnostic?.issues || [{ path: '$', rule: 'arguments.invalid' }];
    if (!fields.some(issue => RESERVED_PATH.test(issue.path))) parameterErrors.set(error, fields);
  }
  return error;
}
function isToolParameterError(error) { return Boolean(error && parameterErrors.has(error)); }
function hasInvalidUserDates(message) {
  const dates = String(message || '').match(/20\d{2}-\d{2}-\d{2}/g) || [];
  return dates.some(date => !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    || dates.length === 2 && dates[0] > dates[1];
}
function toolErrorFeedback(error, input, retryAllowed) {
  const capability = getDatasetCapability(input?.datasetId);
  const allowed = { datasetId: Object.keys(DATASETS),
    direction: capability?.acceptedArgs.directions,
    sort: capability?.acceptedArgs.readerSorts,
    groupBy: capability?.acceptedArgs.groupings };
  const misplacedChart = (parameterErrors.get(error) || []).some(issue => issue.path === 'chart' && issue.rule === 'object.unknown');
  const message = misplacedChart
    ? 'chart是最终答复JSON字段，不能放在query_data工具参数里。' +
      (retryAllowed ? '移除chart并只纠正查询参数。' : '本轮不能继续取数。') +
      '已有足够获准数据时，直接用该次queryMeta.queryId及columns.key输出最终JSON的chart；不要重复查询来生成图。没有可绘制数据则chart为null。'
    : '工具参数不符合该数据集能力，请只纠正标明字段。';
  return { status: 'error', code: error.code,
    message, recoverable: true, retryAllowed,
    issues: (parameterErrors.get(error) || []).slice(0, 8).map(issue => {
      const path = typeof issue.path === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,80}$/.test(issue.path) ? issue.path : '$';
      const rule = typeof issue.rule === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,80}$/.test(issue.rule) ? issue.rule : 'arguments.invalid';
      const allowedValues = Array.isArray(issue.allowedValues) && ['dataset.intent.required', 'dataset.readerSort', 'dataset.filter.intent'].includes(rule)
        ? issue.allowedValues.filter(value => typeof value === 'string' && (path !== 'datasetId' || Object.hasOwn(DATASETS, value)))
        : path === 'datasetId' && rule === 'dataset.assetComposition.required' ? ['asset-composition'] : allowed[path];
      return { path, rule, ...(Array.isArray(allowedValues) ? { allowedValues } : {}) };
    }) };
}
module.exports = { markToolParameterError, isToolParameterError, hasInvalidUserDates, toolErrorFeedback };
