const { sanitizeTaskContext, inferTaskSubject, isTaskFollowupText } = require('./taskContext');
const { sanitizeQueryCoverageResult } = require('./queryContext');
const { semanticMessage } = require('./queryDatasetIntent');
const { classifyCurrentTurn } = require('./currentTurnIntent');

const MAX_TASK_CONTEXTS = 6, MAX_QUERY_COVERAGE = 8;

function sanitizeTaskContexts(value) {
  const input = Array.isArray(value) ? value : value?.version === 1 && Array.isArray(value.tasks) ? value.tasks : [];
  const latest = new Map();
  for (const item of input) {
    const task = sanitizeTaskContext(item);
    if (!task?.subject || task.mode === 'chat') continue;
    latest.delete(task.subject);
    latest.set(task.subject, task);
  }
  return { version: 1, tasks: [...latest.values()].slice(-MAX_TASK_CONTEXTS) };
}

function upsertTaskContext(registry, task) {
  const safe = sanitizeTaskContexts(registry), current = sanitizeTaskContext(task);
  if (!current?.subject || current.mode === 'chat') return safe;
  return sanitizeTaskContexts({ version: 1, tasks: [...safe.tasks, current] });
}

// A complete registry is more precise than the single-task compatibility
// mirror from the same turn. A newer standalone task still replaces old state.
function mergeTaskContext(registry, task) {
  const safe = sanitizeTaskContexts(registry), current = sanitizeTaskContext(task);
  const member = safe.tasks.find(item => item.subject === current?.subject);
  return upsertTaskContext(safe, member && member.turnId === current?.turnId ? member : current);
}

function selectTaskContext(registry, { message, previous } = {}) {
  const intent = classifyCurrentTurn(message);
  if (intent.businessSuppressed || intent.topicReset) return null;
  const safe = sanitizeTaskContexts(registry), fallback = sanitizeTaskContext(previous);
  message = semanticMessage(intent.businessMessage);
  const subject = inferTaskSubject(message);
  if (subject) return safe.tasks.findLast(task => task.subject === subject) || (fallback?.subject === subject ? fallback : null);
  if (/图表|饼图|折线|曲线|走势|趋势|柱状|画.*图/.test(message || '')) {
    return safe.tasks.findLast(task => task.chartRequest) || fallback;
  }
  if (/\d{1,2}\s*月|[一二三四五六七八九十]+\s*月/.test(message || '') && isTaskFollowupText(message)) {
    return fallback || safe.tasks.at(-1) || null;
  }
  return fallback || safe.tasks.at(-1) || null;
}

function sanitizeQueryCoverage(value) {
  const input = Array.isArray(value) ? value : value?.version === 1 && Array.isArray(value.results) ? value.results : [];
  const latest = new Map();
  for (const item of input) {
    const result = sanitizeQueryCoverageResult(item);
    if (!result) continue;
    const key = result.queryId || JSON.stringify([result.datasetId, result.effectiveScope, result.filters, result.cardTypes || []]);
    latest.delete(key);
    latest.set(key, result);
  }
  return { version: 1, results: [...latest.values()].slice(-MAX_QUERY_COVERAGE) };
}

// Previous-query facts describe provenance and coverage only. Values and refs
// must come from a fresh authorized read in the current turn.
function attachQueryCoverage(previous, datasets, { turnId, queryInputs, cardTypes } = {}) {
  const safe = sanitizeQueryCoverage(previous);
  if (!Array.isArray(datasets)) return safe;
  const fresh = datasets.filter(dataset => dataset?.queryMeta?.datasetId === dataset.datasetId
    && dataset.queryMeta.returnedRowCount === dataset.rows?.length).map(dataset => {
    const meta = dataset.queryMeta;
    const binding = queryInputs instanceof Map ? queryInputs.get(meta.queryId) : queryInputs?.[meta.queryId];
    const types = meta.cardTypes || meta.filters?.cardTypes || binding?.cardTypes
      || (dataset.datasetId.startsWith('card-') ? cardTypes : undefined);
    return sanitizeQueryCoverageResult({ ...meta, incomeCount: dataset.summary?.incomeCount ?? null,
      expenseCount: dataset.summary?.expenseCount ?? null, ...(types ? { cardTypes: types } : {}), turnId });
  }).filter(Boolean);
  return sanitizeQueryCoverage({ version: 1, results: [...safe.results, ...fresh] });
}

function sanitizeContextSummary(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.items) || typeof value.truncated !== 'boolean') return null;
  const validDate = date => typeof date === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  const items = value.items.slice(-8).filter(item => item && typeof item.text === 'string' && item.text.trim()
    && ['completed', 'failed', 'awaiting_input', 'unknown', 'pending', 'succeeded'].includes(item.status)
    && (item.sourceDate == null || validDate(item.sourceDate))).map(item => ({ text: Array.from(item.text).slice(0, 320).join(''),
    sourceDate: item.sourceDate || null, status: item.status }));
  return { version: 1, items, truncated: value.truncated || value.items.length > 8 };
}

module.exports = { MAX_TASK_CONTEXTS, MAX_QUERY_COVERAGE, sanitizeTaskContexts, upsertTaskContext, mergeTaskContext, selectTaskContext,
  sanitizeQueryCoverage, attachQueryCoverage, sanitizeContextSummary };
