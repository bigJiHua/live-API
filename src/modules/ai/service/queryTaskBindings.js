const { buildTaskContext, inferTaskSubject } = require('./taskContext');
const { buildQueryContext, explicitPeriod, isQueryRequestText, isNewTransactionStatement } = require('./queryContext');
const { selectTaskContext } = require('./contextState');
const { getDatasetCapability } = require('./datasetCapabilities');
const { classifyCurrentTurn } = require('./currentTurnIntent');

// Literal filter/tool text must not create clauses, dates or subjects. Equal
// length masking keeps every binding's user text intact for downstream filters.
function semanticMessage(message) {
  const blank = text => text.replace(/[\s\S]/g, ' ');
  return String(message || '').replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"(?:\\.|[^"\\\n])*(?:"|$)|'(?:\\.|[^'\\\n])*(?:'|$)|`[^`\n]*(?:`|$)/g, blank);
}
function queryClauses(message) {
  const text = String(message || ''), semantic = semanticMessage(text), clauses = [];
  const separator = /[;；\n。]|(?:同时|另外|以及|并且)(?:再|也|帮我)?/g;
  let start = 0;
  for (const match of semantic.matchAll(separator)) {
    const end = match.index + (match[0] === '。' ? match[0].length : 0);
    clauses.push({ text: text.slice(start, end).trim(), semantic: semantic.slice(start, end).trim() });
    start = match.index + match[0].length;
  }
  clauses.push({ text: text.slice(start).trim(), semantic: semantic.slice(start).trim() });
  return clauses.filter(clause => clause.semantic);
}
const isChartClause = text => /^(?:请|帮我|请帮我)?\s*(?:给|画|绘制|生成|展示)\s*[^。！？]{0,60}(?:图表|饼图|柱状图|折线图|曲线图)/.test(text);
const isPresentationClause = text => /^(?:每部分|各部分|每个部分|各个部分|所有部分|所有结果|每项结果|各项结果)[^。！？]{0,80}(?:保留|说明|注明|不要|别)/.test(text);
function isNegatedQueryClause(text) {
  let denied = false;
  for (const match of text.matchAll(/查询|查看|读取|统计|分析|列出|查|看/g)) {
    const prefix = text.slice(0, match.index).split(/[，,；;。！？!?\n]|但是|但|而是/).at(-1);
    if (/(?:不|不要|不用|无需|不需要|不得|(?<!分)别)(?:再|改|另外|同时|继续|帮我)?\s*$/.test(prefix)) denied = true;
    else return false;
  }
  return denied;
}
const isWriteClause = text => isNewTransactionStatement(text)
  || /^(?:(?:请|帮我|请帮我|再|然后|接着)\s*)*(?:记一笔|记录|录入|新增|添加|删除|修改|更新|取消|完成|执行|入账|支付|还款)[^。！？]/.test(text);

// Independent clauses with different subjects need independent scopes. Keep
// single-subject comparisons and ordinary conjunctions in the existing path.
function buildQueryTaskBindings({ message, today, tasks } = {}) {
  const intent = classifyCurrentTurn(message);
  if (intent.businessSuppressed) return [];
  message = intent.businessMessage;
  if (intent.topicReset) tasks = { version: 1, tasks: [] };
  const sharedQuery = /^(?:请|帮我|请帮我)?\s*(?:分别|依次|逐项)\s*(?:查询|查看|统计|分析|读取|列出)/.test(semanticMessage(message).trim());
  const all = queryClauses(message);
  const clauses = all.filter(clause => !isChartClause(clause.semantic) && !isPresentationClause(clause.semantic)
    && !isNegatedQueryClause(clause.semantic));
  const subjects = clauses.map(clause => inferTaskSubject(clause.semantic));
  // Preserve the positive clause even when a denied second read was removed.
  // Otherwise whole-message parsing can revive its subject or chart words.
  if (!clauses.length || (clauses.length < 2 || new Set(subjects.filter(Boolean)).size < 2)
    && !all.some(clause => isNegatedQueryClause(clause.semantic))) return [];
  const bindings = clauses.slice(0, 6).map(clause => {
    let semantic = clause.semantic;
    if (sharedQuery && inferTaskSubject(semantic) && !isQueryRequestText(semantic) && !isWriteClause(semantic)) semantic = '查询 ' + semantic;
    const previous = selectTaskContext(tasks, { message: semantic });
    const queryContext = buildQueryContext({ message: semantic, today });
    const taskContext = buildTaskContext({ message: semantic, today, previous, queryContext });
    return { text: clause.text, taskContext, queryContext, semantic };
  }).filter(binding => binding.taskContext?.mode === 'query');
  for (const chart of all.filter(clause => isChartClause(clause.semantic))) {
    const subject = inferTaskSubject(chart.semantic), period = explicitPeriod(chart.semantic, today);
    const matches = bindings.filter(binding => (!subject || binding.taskContext.subject === subject)
      && (!period || binding.taskContext.scope?.startDate === period.startDate && binding.taskContext.scope?.endDate === period.endDate));
    // Ambiguous presentation requests cannot select the last unrelated task.
    if (matches.length !== 1) continue;
    const binding = matches[0], semantic = binding.semantic + '。' + chart.semantic;
    const queryContext = buildQueryContext({ message: semantic, today });
    binding.taskContext = buildTaskContext({ message: semantic, today, previous: binding.taskContext, queryContext });
    binding.queryContext = queryContext;
    binding.text += '。' + chart.text;
    binding.semantic = semantic;
  }
  return bindings.map(({ semantic, ...binding }) => binding);
}
function selectQueryTaskBinding(bindings, datasetId) {
  const domain = getDatasetCapability(datasetId)?.domain;
  const subject = domain === 'card' ? 'cards' : domain;
  const matches = bindings.filter(binding => binding.taskContext.subject === subject);
  return matches.length === 1 ? matches[0] : null;
}
module.exports = { buildQueryTaskBindings, selectQueryTaskBinding };
