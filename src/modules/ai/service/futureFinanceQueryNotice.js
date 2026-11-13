const { semanticMessage } = require('./queryDatasetIntent');
const { explicitPeriod } = require('./queryContext');
const FINANCE_HISTORY = new Set(['finance-monthly', 'finance-daily', 'finance-categories', 'finance-transactions']);
function validDay(day) {
  if (typeof day !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(day + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
function futureFinanceQueryNotice({ message, today, goals = [], bindings = [], queryContext, datasets = [], queryInputs,
  failures = [], successfulQueries = 0 } = {}) {
  if (!validDay(today) || !Array.isArray(goals) || !Array.isArray(bindings) || !Array.isArray(datasets) || !Array.isArray(failures)
    || datasets.length || queryInputs?.size !== 0 || successfulQueries !== 0
    || !failures.length || failures.some(error => error?.code !== 'AI_SCOPE_INVALID') || goals.length !== 1
    || bindings.length > 1 || bindings.some(binding => binding?.taskContext?.subject !== 'finance')) return null;
  const task = goals[0]?.task, active = queryContext?.activeQuery;
  if (task?.mode !== 'query' || task.subject !== 'finance' || !FINANCE_HISTORY.has(task.targetDatasetId)
    || task.comparisonScopes?.length || active?.periodSource !== 'current' || active.explicit?.period !== true) return null;
  const text = semanticMessage(message);
  if (!/收支|收入|支出|账本|流水/.test(text) || /预算|分期|计划|预计|预期|预测|对比|比较|分别|同时|以及|另外|还有/.test(text)
    || /(?:不要|不用|不必|取消|停止)[^。；;！？\n]{0,30}(?:查询|查看|统计)/.test(text)
    || !/20\d{2}\s*年\s*\d{1,2}\s*月|20\d{2}-\d{2}-\d{2}/.test(text)) return null;
  const isoDays = [...text.matchAll(/20\d{2}-\d{2}-\d{2}/g)];
  const months = [...text.matchAll(/(?:(20\d{2})\s*年\s*)?\d{1,2}\s*月(?:份)?/g)];
  const dayParts = [...text.matchAll(/\d{1,2}\s*(?:日|号)/g)];
  const chineseDays = [...text.matchAll(/(?:(20\d{2})\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)/g)];
  const rangeConnector = /^\s*(?:至|到|—|–|-|~|～)\s*$/;
  if (isoDays.length > 2 || chineseDays.length > 2 || months.length > 2 || dayParts.length > 2
    || isoDays.length && (months.length || dayParts.length)
    || !isoDays.length && !months[0]?.[1]) return null;
  if (isoDays.length === 2 && !rangeConnector.test(text.slice(isoDays[0].index + isoDays[0][0].length, isoDays[1].index))) return null;
  if (months.length === 2 && !/^\s*(?:\d{1,2}\s*(?:日|号))?\s*(?:至|到|—|–|-|~|～)\s*$/.test(
    text.slice(months[0].index + months[0][0].length, months[1].index))) return null;
  if (dayParts.length === 2 && months.length === 1 && !rangeConnector.test(
    text.slice(dayParts[0].index + dayParts[0][0].length, dayParts[1].index))) return null;
  let scope; try { scope = explicitPeriod(text, today, null); } catch (_) { return null; }
  if (!scope || !validDay(scope.startDate) || !validDay(scope.endDate) || scope.startDate <= today || scope.startDate > scope.endDate
    || scope.startDate !== active.startDate || scope.endDate !== active.endDate
    || scope.startDate !== task.scope?.startDate || scope.endDate !== task.scope?.endDate) return null;
  return `${scope.startDate} 至 ${scope.endDate} 属于未来时段，当前（${today}）该范围尚未开始，无法统计这段期间已发生的收支。本轮保留原请求日期，没有读取账本记录，也没有改用本月数据。`;
}
module.exports = { futureFinanceQueryNotice };
