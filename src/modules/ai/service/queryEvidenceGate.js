const { getDatasetCapability } = require('./datasetCapabilities');
const { semanticMessage, filterBasisIssue } = require('./queryDatasetIntent');
const { extractExplicitQueryConstraints } = require('./explicitQueryConstraints');
const { selectTaskContext } = require('./contextState');

function queryGoals({ bindings = [], taskContext, queryContext, message, previousTasks, previousTask, coverage } = {}) {
  return (bindings.length ? bindings : [{ taskContext, queryContext, text: message }])
    .filter(item => item.taskContext?.mode === 'query' && item.taskContext.targetDatasetId)
    .map(item => ({ ...item, constraints: extractExplicitQueryConstraints(item.text), coverage,
      previousTask: selectTaskContext(previousTasks, { message: item.text, previous: previousTask }),
      task: item.taskContext, query: item.queryContext?.activeQuery }));
}
function effectiveGoalScope(goal, today) {
  const scope = goal.task.scope, cap = getDatasetCapability(goal.task.targetDatasetId);
  if (!scope) return null;
  const result = { ...scope };
  if (cap?.datePolicy.historyThroughToday && result.endDate > today) result.endDate = today;
  return result;
}
function goalDataset(goal, datasets, queryInputs, today, requireComplete = true) {
  // A default period is an anchor, not a user-specified date constraint.
  // Keep explicitly requested and inherited periods exact while accepting a
  // fresh validated read for an otherwise open-ended historical query.
  const expectedScope = goal.query?.periodSource === 'default' ? null : effectiveGoalScope(goal, today);
  return (datasets || []).find(dataset => {
    const meta = dataset.queryMeta, args = queryInputs.get(meta?.queryId);
    if (dataset.datasetId !== goal.task.targetDatasetId || !meta || !args || args.datasetId !== dataset.datasetId
      || meta.returnedRowCount !== dataset.rows?.length) return false;
    const expectedScopes = goal.task.comparisonScopes?.length ? goal.task.comparisonScopes : expectedScope ? [expectedScope] : [];
    if (expectedScopes.length && !expectedScopes.some(scope => meta.effectiveScope.startDate === scope.startDate && meta.effectiveScope.endDate === scope.endDate)) return false;
    const expectedDirection = dataset.domain === 'finance' ? goal.query?.direction === 0 ? 'expense' : goal.query?.direction === 1 ? 'income' : 'both'
      : dataset.datasetId === 'card-monthlyConsumption' ? 'expense' : 'both';
    if (meta.filters.direction !== expectedDirection) return false;
    if (goal.task.querySort && meta.sort !== goal.task.querySort) return false;
    if (goal.task.subject === 'cards' && getDatasetCapability(dataset.datasetId).acceptedArgs.cardTypes) {
      if (JSON.stringify(meta.filters.cardTypes || []) !== JSON.stringify(goal.task.cardTypes || [])) return false;
    }
    const constraints = goal.constraints || {};
    if (Object.hasOwn(constraints, 'filter') && meta.filters.text !== constraints.filter) return false;
    if (filterBasisIssue(args, { task: goal.task, message: goal.text, constraints: goal.constraints,
      previousTask: goal.previousTask, coverage: goal.coverage, queryContext: goal.queryContext })) return false;
    if (constraints.limit !== undefined && args.limit !== constraints.limit) return false;
    if (meta.page?.offset > 0 && !args.cursor) return false;
    if (requireComplete && meta.page && meta.resolution !== 'detail' && !meta.rowsComplete
      && constraints.limit === undefined) return false;
    // Display truncation is fulfilled by the requested cap. Source-window
    // truncation or unknown matching coverage cannot establish completion.
    return !requireComplete || meta.rowsComplete === true || Number.isSafeInteger(meta.matchedRowCount)
      && meta.matchedRowCount >= args.limit && meta.returnedRowCount === args.limit;
  });
}
function missingFreshGoals(goals, datasets, queryInputs, today) {
  return goals.filter(goal => goal.task.requireFreshQuery === true && !goalDataset(goal, datasets, queryInputs, today, false));
}
function explicitQueriesComplete({ goals, bindings = [], taskContext, message, datasets, queryInputs, today } = {}) {
  const all = bindings.length ? bindings.map(item => item.taskContext) : taskContext ? [taskContext] : [];
  if (!goals.length || all.some(task => task?.mode !== 'query' || !task.targetDatasetId)
    || /为什么|原因|分析|建议|解释|比较|对比/.test(semanticMessage(message))) return false;
  // Ranking retains its existing stricter completion paths.
  if (all.some(task => /-max$/.test(task.metric || '')
    || task.metric === 'card-consumption' && /最高|最大|第一|排行|排名/.test(semanticMessage(message)))) return false;
  const chartTasks = all.filter(task => task.chartRequest);
  if (chartTasks.length && (chartTasks.length !== 1
    || !knownMonthlyFinanceChart(null, goals, datasets, queryInputs, today))) return false;
  // A single scope equal to the proven monthly chart's own period is an
  // anchor. Genuine comparisons and other charts still need more reasoning.
  if (all.some(task => task.comparisonScopes?.length && (!chartTasks.length || task !== chartTasks[0]
    || task.comparisonScopes.length !== 1 || !task.scope
    || task.comparisonScopes[0].startDate !== task.scope.startDate
    || task.comparisonScopes[0].endDate !== task.scope.endDate))) return false;
  return goals.every(goal => goalDataset(goal, datasets, queryInputs, today));
}
function freshQueryFeedback(missing) {
  return { code: 'AI_QUERY_EVIDENCE_REQUIRED', message: '本轮查询或筛选已变更，必须重新调用query_data读取当前范围；历史空结果和候选不作为本轮查询结果。',
    requiredQueries: missing.map(goal => ({ datasetId: goal.task.targetDatasetId,
      ...(goal.task.scope || {}), ...(goal.task.querySort ? { sort: goal.task.querySort } : {}),
      ...(goal.constraints || {}) })), retryAllowed: true };
}
function knownMonthlyFinanceChart(proposed, goals, datasets, queryInputs, today) {
  if (proposed && (proposed.datasetId !== 'finance-monthly' || proposed.xKey !== 'month'
    || proposed.yKeys.some(key => !['income', 'expense', 'incomeCNY', 'expenseCNY'].includes(key)))) return null;
  const matching = [];
  for (const goal of goals) {
    const text = semanticMessage(goal.text);
    if (goal.task.subject !== 'finance' || goal.task.targetDatasetId !== 'finance-monthly'
      || !['bar', 'line'].includes(goal.task.chartRequest?.type) || goal.task.comparisonScopes?.length > 1
      || !/收支|收入[^。！？;；\n]{0,20}支出|支出[^。！？;；\n]{0,20}收入/.test(text)
      || /(?:只|仅)(?:画|要|看|给|展示)[^。！？;；\n]{0,16}(?:收入|支出)/.test(text)) continue;
    for (const dataset of datasets) if (dataset.datasetId === 'finance-monthly'
      && dataset.rows?.length && dataset.queryMeta?.rowsComplete && dataset.queryMeta?.summaryComplete
      && dataset.queryMeta.filters.direction === 'both'
      && ['income', 'expense'].every(key => dataset.columns.some(column => column.key === key && column.type === 'money'))
      && goalDataset(goal, [dataset], queryInputs, today)) matching.push({ dataset, task: goal.task });
  }
  if (matching.length !== 1) return null;
  const { dataset, task } = matching[0];
  return { datasetId: 'finance-monthly', queryId: dataset.queryMeta.queryId, type: task.chartRequest.type,
    xKey: 'month', yKeys: ['income', 'expense'], title: dataset.title };
}
module.exports = { queryGoals, goalDataset, missingFreshGoals, explicitQueriesComplete, freshQueryFeedback, effectiveGoalScope, knownMonthlyFinanceChart };
