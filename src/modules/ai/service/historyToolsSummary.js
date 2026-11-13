const { DATASETS } = require('./datasetCapabilities');

// These are server-observed tool names, not arbitrary model prose or tool
// arguments. The bounded summary answers provenance questions without
// turning old financial values, IDs or references into current evidence.
const NAMES = new Set(['query_data', 'list_choices', 'memory_list', 'memory_read', 'memory_search', 'memory_write',
  'history_search', 'history_read', 'calculate', 'query_finance_summary', 'query_transactions', 'list_record_choices', 'propose_transaction']);
const TYPES = new Set(['pie', 'bar', 'line']);
const MAX_TOOLS = 8;

function sanitizeHistoryToolsSummary(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.tools)) return null;
  const tools = [], seen = new Set();
  for (const item of value.tools) {
    if (!item || !NAMES.has(item.name)) continue;
    const datasetId = item.name === 'query_data' && Object.hasOwn(DATASETS, item.datasetId || '') ? item.datasetId : null;
    const key = JSON.stringify([item.name, datasetId]);
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({ name: item.name, ...(datasetId ? { datasetId } : {}) });
    if (tools.length === MAX_TOOLS) break;
  }
  const chart = value.chart && TYPES.has(value.chart.type) && Object.hasOwn(DATASETS, value.chart.datasetId || '')
    ? { type: value.chart.type, datasetId: value.chart.datasetId } : null;
  return tools.length || chart ? { version: 1, tools, chart } : null;
}

function buildHistoryToolsSummary(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const business = meta.business && typeof meta.business === 'object' ? meta.business : null;
  const trace = Array.isArray(business?.toolTrace) ? business.toolTrace
    : Array.isArray(meta.toolTrace) ? meta.toolTrace : Array.isArray(meta.evidence) ? meta.evidence : null;
  return sanitizeHistoryToolsSummary({ version: 1,
    tools: (trace || []).map(item => ({ name: item?.tool, datasetId: item?.datasetId })), chart: business?.chart || meta.chart || null });
}

module.exports = { sanitizeHistoryToolsSummary, buildHistoryToolsSummary };
