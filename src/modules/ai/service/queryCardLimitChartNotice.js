// Preserve the user's requested fixed-limit chart basis after strict prose scrubbing.
const { semanticMessage } = require('./queryDatasetIntent');
const { goalDataset, effectiveGoalScope } = require('./queryEvidenceGate');
const NOTICE = '图中固定额度是逐卡登记的配置值，不代表当前可用额度；共享池额度不能逐卡相加当作可用额度，实时可用额度需要另有可核对的数据。';
function explicitLimitBasis(message) {
  const text = semanticMessage(message);
  const graph = text.split(/[，,。；;！？!?\n]/).some(clause => /固定额度|creditLimit|fixed\s+(?:credit\s+)?limits?/i.test(clause)
    && /柱(?:状)?图|bar\s+chart/i.test(clause)
    && !/例如|比如|示例|样例|假设|演示|工具参数/.test(clause)
    && !/(?:不要|不用|无需|不需要|不想(?:要)?|不画|不绘制|不生成|取消|禁止|不许|不允许|别(?:再)?)[^。；;！？!?\n]{0,40}(?:柱(?:状)?图|bar\s+chart)/i.test(clause));
  if (!graph || !/卡片清单|卡片(?:基础)?设置|逐卡|前\s*\d+\s*张卡|card-cards|\bcards?\b/i.test(text)) return false;
  if (!/(?:说明|解释|口径|提醒|注明|标注|提示)/.test(text)
    || /(?:不要|不用|无需|不需要|不想(?:要)?|取消|禁止|不许|不允许|别)(?:再)?\s*(?:说明|解释|提醒|注明|标注|提示)[^。；;！？!?\n]{0,60}(?:逐卡|配置|共享)/.test(text)) return false;
  return /(?:共享(?:额度)?池|shared\s+(?:credit\s+)?(?:limit\s+)?pools?)[^。；;！？!?\n]{0,30}(?:不能|不可|不得|不应|不要)[^。；;！？!?\n]{0,16}(?:相加|加总|合计|累加|叠加)[^。；;！？!?\n]{0,16}可用额度/.test(text);
}
const sameScope = (left, right) => !!left && !!right && left.startDate === right.startDate && left.endDate === right.endDate;
function cardLimitChartNotice({ message, answer = '', chart, datasets = [], goals = [], queryInputs, today } = {}) {
  if (!explicitLimitBasis(message) || !chart || chart.datasetId !== 'card-cards' || chart.type !== 'bar'
    || chart.xKey !== 'name' || !Array.isArray(chart.yKeys) || chart.yKeys.length !== 1 || chart.yKeys[0] !== 'creditLimit'
    || !/^q_[a-f\d]{24}$/.test(chart.queryId || '') || typeof queryInputs?.get !== 'function') return '';
  const selected = datasets.filter(dataset => dataset.datasetId === 'card-cards');
  if (selected.length !== 1) return '';
  const dataset = selected[0], meta = dataset.queryMeta, args = queryInputs.get(chart.queryId);
  if (dataset.domain !== 'card' || meta?.datasetId !== 'card-cards' || meta.queryId !== chart.queryId
    || !args || args.datasetId !== 'card-cards' || args.queryId !== chart.queryId
    || !Array.isArray(dataset.rows) || !dataset.rows.some(row => row.creditLimit != null && Number.isFinite(Number(row.creditLimit))) || meta.returnedRowCount !== dataset.rows.length
    || !Number.isSafeInteger(meta.matchedRowCount) || meta.matchedRowCount < meta.returnedRowCount
    || !Array.isArray(dataset.columns)
    || ![['name', 'text'], ['creditLimit', 'money']].every(([key, type]) => dataset.columns.filter(column => column.key === key && column.type === type).length === 1)) return '';
  const inputScope = args.scope || { startDate: args.startDate, endDate: args.endDate };
  if (!sameScope(meta.requestedScope, inputScope) || !sameScope(meta.effectiveScope, inputScope)) return '';
  const own = goals.filter(goal => goal.task?.mode === 'query' && goal.task.subject === 'cards'
    && goal.task.targetDatasetId === 'card-cards' && goal.task.chartRequest?.type === 'bar'
    && !goal.task.comparisonScopes?.length && explicitLimitBasis(goal.text));
  if (own.length !== 1 || goalDataset(own[0], selected, queryInputs, today, false) !== dataset) return '';
  const goal = own[0], explicitScope = effectiveGoalScope(goal, today);
  const inheritScope = /范围不变|日期不变|同(?:一|样)(?:日期|范围)|(?:延续|沿用|保持)[^。；;！？!?\n]{0,24}(?:查询|范围)/.test(semanticMessage(goal.text));
  const prior = goal.coverage?.results?.filter(item => item.datasetId === 'card-cards').at(-1);
  const expectedScope = explicitScope || (inheritScope ? prior?.effectiveScope : null);
  if (inheritScope && !expectedScope || expectedScope && !sameScope(meta.effectiveScope, expectedScope)) return '';
  // General basis only: never infer particular pool membership, pool sums,
  // available balances, or coverage of cards outside the returned window.
  if (String(answer).includes(NOTICE)) return '';
  return NOTICE;
}
// Call only after cardLimitChartNotice proves the requested chart binding.
// Replace model-written general basis sentences with the canonical notice;
// never guess whether an arbitrary positive or negative paraphrase is true.
function cardLimitChartExplanation(answer) {
  const generalBasis = text => /逐卡/.test(text) && /配置|参数|登记/.test(text)
      || /(?:固定额度|图中(?:的)?额度)/.test(text) && /(?:配置|逐卡|可用额度)/.test(text)
      || /共享(?:额度)?池|shared\s+(?:credit\s+)?(?:limit\s+)?pools?/i.test(text) && /可用额度|available\s+(?:credit\s+)?limits?/i.test(text);
  return String(answer || '').split(/(?<=[。；;！？])|\n+/).map(part => {
    if (!generalBasis(semanticMessage(part))) return part;
    return part.split(/，|(?<!\d),|,(?!\d)/).filter(clause => {
      const text = semanticMessage(clause);
      return !generalBasis(text) && !(!/\d/.test(text) && /可用额度|available\s+(?:credit\s+)?limits?/i.test(text));
    }).join('，');
  }).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
module.exports = { cardLimitChartNotice, cardLimitChartExplanation, explicitLimitBasis, NOTICE };
