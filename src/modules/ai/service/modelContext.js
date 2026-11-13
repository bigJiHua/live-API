const { selectHistoryTurns } = require('./historyContext');
const { sanitizeContextSummary } = require('./contextState');

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let ascii = 0, other = 0;
  for (const char of text || '') char.codePointAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 3) + other;
}
// §10（2026-11-11）：预算解析链 config.historyTokens（含 ai_config 覆盖，getConfig 合并
// 生效）> env.AI_CONTEXT_HISTORY_TOKENS > contextWindowTokens/3（上限 12000，留系统提示、
// 工具定义与输出余量）> 3500。全部整数有效域 500~12000，非法静默回落（沿用现有容忍语义）。
function historyTokenBudget(config = null) {
  const fromConfig = Number(config?.historyTokens);
  if (Number.isInteger(fromConfig) && fromConfig >= 500 && fromConfig <= 12000) return fromConfig;
  const value = Number(process.env.AI_CONTEXT_HISTORY_TOKENS);
  if (Number.isInteger(value) && value >= 500 && value <= 12000) return value;
  const window = Number(config?.modelCapabilities?.contextWindowTokens);
  if (Number.isFinite(window) && window > 0) return Math.min(12000, Math.max(500, Math.floor(window / 3)));
  return 3500;
}
function selectBudgetedHistory(history, { budget = historyTokenBudget(), limit = 12 } = {}) {
  const selectedBudget = Number.isSafeInteger(budget) && budget >= 0 ? budget : historyTokenBudget();
  const candidates = selectHistoryTurns(history, { limit: Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 12)) : 12 });
  const selected = [], omitted = []; let estimatedTokens = 0;
  for (const turn of [...candidates].reverse()) {
    // Original prose appears in the structured turn and parallel compatibility
    // fields. Count both copies rather than silently under-budgeting Chinese.
    const cost = estimateTokens([turn.user, turn.answer]) * 2 + (turn.historyToolsSummary ? estimateTokens(turn.historyToolsSummary) : 0);
    if (estimatedTokens + cost <= selectedBudget) { selected.unshift(turn); estimatedTokens += cost; }
    else omitted.unshift(turn);
  }
  return { turns: selected, omitted, estimatedTokens, budget: selectedBudget, truncated: omitted.length > 0 };
}
function buildContextSummary(previous, omitted = [], scrub = value => value) {
  const prior = sanitizeContextSummary(previous);
  const items = [...(prior?.items || []), ...omitted.map(turn => ({ text: scrub(Array.from(turn.user).slice(0, 320).join('')),
    sourceDate: turn.sourceDate || null, status: turn.status }))];
  const distinct = [...new Map(items.map(item => [JSON.stringify([item.text, item.sourceDate]), item])).values()];
  return sanitizeContextSummary({ version: 1, items: distinct.slice(-8), truncated: prior?.truncated || omitted.length > 0 || distinct.length > 8 });
}
// Scrub individual strings so a large structured context is never sliced into
// invalid JSON. This also keeps numeric evidence indices unchanged.
function redactContextData(value, scrub) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(item => redactContextData(item, scrub));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['turnId', 'conversationId', 'userId'].includes(key))
    .map(([key, item]) => [key, typeof item === 'string' && (key === 'queryId' && /^q_[a-f0-9]{24}$/.test(item)
      || key === 'nextCursor' && item.length <= 2048 && /^lq1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(item))
      ? item : redactContextData(item, scrub)]));
}
module.exports = { estimateTokens, historyTokenBudget, selectBudgetedHistory, sanitizeContextSummary, buildContextSummary, redactContextData };
