const { canonical } = require('./v3Evidence');
const LABEL_FIELDS = Object.freeze({ 待入账: 'pending', 已入账: 'entered', 入账中: 'entering', 中止: 'void', 作废: 'void', 已作废: 'void', 未知: 'unknown' });
const labels = '(?:待入账|已入账|入账中|中止|已作废|作废|未知)';
const stateCounts = new RegExp(`(${labels}(?:状态)?(?:[ \t]*[/／、][ \t]*${labels}(?:状态)?)*)[ \t]*(?:均为|都为|均|为|[：:])?[ \t]*(\\d+)[ \t]*(期|条|笔)?(?=[ \t]*(?:[，,、。；;！!？?\\n]|$))`, 'g');
const explicitExecution = /(?:本轮|本次|这次|刚才)[^，,。；;\n]{0,14}(?:已|已经|完成)[^，,。；;\n]{0,14}入账|(?:我|我们)[^，,。；;\n]{0,20}(?:已|已经|成功)[^，,。；;\n]{0,16}入账|已(?:经)?(?:为你|帮你|替你)[^，,。；;\n]{0,20}入账|(?:完成入账|入账成功|入账完成)|(?:我|我们|本轮|本次|这次)[^，,。；;\n]{0,14}(?:已(?:经)?|成功)[^，,。；;\n]{0,10}(?:完成|执行)(?:了)?(?:本次|本轮|这次)?(?:的)?操作/;
const aggregate = /(?:全部|所有|全范围|合计|总计|总共)[^，,。；;\n]{0,20}(?:计划|期次|已入账)/;
const hasField = (dataset, row, key, value) => dataset.columns?.some(column => column.key === key && column.type === 'number')
  && Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] === value;
function configurationMatches(row, line) {
  if (/已停用|停用中|已关闭/.test(line) && row.active !== 0) return false;
  if (/启用中|已启用|启用状态[：:]?\s*1/.test(line) && row.active !== 1) return false;
  const periods = /共\s*(\d+)\s*期/.exec(line);
  if (periods && Number(periods[1]) !== Number(row.periods)) return false;
  return true;
}
function rowForLine(dataset, line, continuation) {
  const ordinal = /^\s*(?:[-*•]\s*)?(?:[（(](\d{1,3})[）)]|(\d{1,3})(?:[.．](?!\d)|[)）、]))\s*/.exec(line);
  if (ordinal) {
    const row = dataset.rows[Number(ordinal[1] || ordinal[2]) - 1];
    return row?.name && line.includes(row.name) && configurationMatches(row, line) ? row : null;
  }
  const named = dataset.rows.filter(row => row.name && line.includes(row.name) && configurationMatches(row, line));
  if (named.length === 1) return named[0];
  if (named.length) return null;
  // Only a typed state continuation can inherit the immediately prior named
  // row. Free-standing execution or aggregate paragraphs cannot borrow it.
  return continuation && /^\s*(?:[-*•]\s*)?(?:范围内|已保存(?:的)?期次状态|状态[：:])/.test(line) ? continuation : null;
}
function cardRange(line) {
  const match = /^\s*(?:[-*•]\s*)?(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(20\d{2}-)?(\d{2}-\d{2})\s*期间[：:]/.exec(line);
  return match ? { startDate: match[1], endDate: (match[2] || match[1].slice(0, 5)) + match[3] } : null;
}
function matchingCardField(row, line) {
  const field = /^\s*(?:[-*•]\s*)?(每期金额|每期计划金额|总期数|下次计划日期|计划下次日期)[：:]\s*([^。；;\n]+)/.exec(line);
  if (!field) return false;
  if (/^每期/.test(field[1])) {
    const amount = /^(\d+(?:\.\d+)?)(?:\s*(?:元|CNY))?(?:\s*$|\s*[（(])/.exec(field[2]);
    return amount && canonical(row.amount) != null && canonical(amount[1]) === canonical(row.amount);
  }
  if (field[1] === '总期数') return /^\d+\s*期/.test(field[2]) && Number.parseInt(field[2], 10) === row.periods;
  return field[2].startsWith(row.nextDate) && /^20\d{2}-\d{2}-\d{2}(?:$|[（(\s])/.test(field[2]);
}
const sameScope = (left, right) => left?.startDate === right?.startDate && left?.endDate === right?.endDate;
const completeSinglePlan = dataset => dataset.rows.length === 1 && dataset.queryMeta.rowsComplete === true
  && dataset.queryMeta.matchedRowCount === 1 && dataset.queryMeta.returnedRowCount === 1
  && /^20\d{2}-\d{2}-\d{2}$/.test(dataset.queryMeta.effectiveScope?.startDate || '')
  && /^20\d{2}-\d{2}-\d{2}$/.test(dataset.queryMeta.effectiveScope?.endDate || '')
  && dataset.queryMeta.effectiveScope.startDate <= dataset.queryMeta.effectiveScope.endDate;
function consistentWindows(sources, selected) {
  const row = selected.rows[0], counters = ['pending', 'entered', 'void', 'entering', 'unknown'];
  return sources.every(dataset => {
    const other = dataset.rows[0];
    return completeSinglePlan(dataset) && other.name === row.name
      && canonical(row.amount) != null && canonical(other.amount) === canonical(row.amount)
      && other.periods === row.periods && other.active === row.active && other.nextDate === row.nextDate
      && counters.every(key => hasField(selected, row, key, row[key]) && hasField(dataset, other, key, row[key]));
  });
}
function compactPlanFieldLine(dataset, line) {
  if (!completeSinglePlan(dataset) || explicitExecution.test(line)) return null;
  const row = dataset.rows[0], name = String(row.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!name || !new RegExp(`^\\s*(?:[-*•]\\s*)?${name}[：:]`).test(line)) return null;
  const amount = /每期\s*(\d+(?:\.\d+)?)\s*(?:元|CNY)/.exec(line);
  const periods = /(?:总共|总期数|共)\s*(\d+)\s*期/.exec(line);
  const next = /(?:下次计划日期|计划下次日期)[^\d。；;\n]{0,20}(20\d{2}-\d{2}-\d{2})(?!\d)/.exec(line);
  if (!amount || canonical(row.amount) == null || canonical(amount[1]) !== canonical(row.amount)
    || !periods || Number(periods[1]) !== row.periods || !next || next[1] !== row.nextDate
    || !/启用状态|启用中/.test(line) || /停用|关闭/.test(line) || !hasField(dataset, row, 'active', 1)) return null;
  return row;
}
function normalizeProvenZeroCounts(original, sources) {
  const dataset = sources[0], row = dataset?.rows?.[0];
  const configuration = [['name', 'text'], ['amount', 'money'], ['periods', 'number'], ['active', 'number'], ['nextDate', 'date']];
  if (!row || !consistentWindows(sources, dataset) || !hasField(dataset, row, 'entered', 0)
    || !sources.every(source => configuration.every(([key, type]) => source.columns?.some(column => column.key === key && column.type === type)))
    || typeof row.name !== 'string' || !row.name || !original.includes(row.name)
    || !Number.isSafeInteger(row.periods) || row.periods < 1 || ![0, 1].includes(row.active)
    || !/^20\d{2}-\d{2}-\d{2}$/.test(row.nextDate || '')) return original;
  const plain = original.replace(/\*\*/g, '');
  if (plain.split('\n').some(line => /^\s*(?:[-*•]\s*)?(?:计划|计划名称|分期名称|名称)[：:]/.test(line) && !line.includes(row.name))) return original;
  const amounts = [...plain.matchAll(/(?:每期(?:计划)?金额\s*[：:]?\s*|每期\s*)(\d+(?:\.\d+)?)/g)];
  const periods = [...plain.matchAll(/(?:总共|总期数|共)\s*[：:]?\s*(\d+)\s*期/g)];
  const nextDates = [...plain.matchAll(/下次[^。；;\n]{0,12}日期[：:]?[^\d。；;\n]{0,20}(20\d{2}-\d{2}-\d{2})/g)];
  if (amounts.some(match => canonical(match[1]) !== canonical(row.amount)) || periods.some(match => Number(match[1]) !== row.periods)
    || nextDates.some(match => match[1] !== row.nextDate)) return original;
  const ranges = plain.split('\n').map(cardRange).filter(Boolean);
  for (const match of plain.matchAll(/(?:数据范围|查询范围|期次状态范围|状态计数范围)\s*[：:]?\s*(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(20\d{2}-\d{2}-\d{2})/g))
    ranges.push({ startDate: match[1], endDate: match[2] });
  if (ranges.some(range => !sources.some(source => sameScope(source.queryMeta.effectiveScope, range)))) return original;
  const label = '已入账状态：0期（仅指各已返回查询窗口的已保存计数）';
  const queryPrefix = /(?:本轮|本次|这次)(?:全范围)?(?:查询|读取|取数)(?:结果|范围)?(?:显示|表明|返回)/g;
  return original.split('\n').map(line => {
    const comparable = line.replace(queryPrefix, '保存状态查询显示');
    if (explicitExecution.test(comparable)) return line;
    const tokens = [...line.matchAll(stateCounts)];
    if (tokens.some(token => token[1].split(/[/／、]/).map(value => value.trim().replace(/状态$/, ''))
      .some(value => !hasField(dataset, row, LABEL_FIELDS[value], Number(token[2]))))) return line;
    const typed = line.replace(/已入账\s*0(?![\d.])\s*期/g, label)
      .replace(/(?<![\d.])0\s*期\s*已入账(?!状态|记录|数据|历史|计数)/g, label);
    return typed === line ? line : typed.replace(queryPrefix, '已返回查询的保存状态显示');
  }).join('\n');
}
function normalizeInstallmentSavedStateClaims(text, datasets = []) {
  const original = String(text || '');
  const sources = datasets.filter(dataset => dataset.datasetId === 'installment-plans'
    && /^q_[a-f0-9]{24}$/.test(dataset.queryMeta?.queryId || '') && Array.isArray(dataset.rows) && dataset.rows.length);
  if (!sources.length || sources.length !== datasets.filter(dataset => dataset.datasetId === 'installment-plans').length) return original;
  // A zero count is a published saved-state field, never a current execution
  // receipt. Strong single-plan consensus does not need a prose-card template.
  const provenZero = normalizeProvenZeroCounts(original, sources);
  if (provenZero !== original) return provenZero;
  // An explicit dated card may bind one scope. A full matching configuration
  // and unanimous returned-window counters only support a typed count noun;
  // they must not pick an arbitrary scope or imply full repayment history.
  let dataset = sources[0];
  if (sources.length > 1) {
    const ranges = original.split('\n').map(line => cardRange(line.replace(/\*\*/g, ''))).filter(Boolean);
    if (ranges.length === 1) {
      const matching = sources.filter(source => sameScope(source.queryMeta.effectiveScope, ranges[0]));
      if (matching.length !== 1 || !completeSinglePlan(matching[0])) return original;
      dataset = matching[0];
    } else if (ranges.length || !consistentWindows(sources, dataset)
      || !original.split('\n').some(line => compactPlanFieldLine(dataset, line.replace(/\*\*/g, '')))) return original;
  }
  const scope = dataset.queryMeta.effectiveScope;
  if (!scope?.startDate || !scope?.endDate) return original;
  const scopes = [...original.matchAll(/(?:数据范围|查询范围|期次状态范围|状态计数范围)\s*[：:]?\s*(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|～)\s*(20\d{2}-\d{2}-\d{2})/g)];
  if (scopes.some(match => !sources.some(source => sameScope(source.queryMeta.effectiveScope,
    { startDate: match[1], endDate: match[2] })))) return original;
  const readConsensus = sources.length === 1 || consistentWindows(sources, dataset);
  const completeConsensus = consistentWindows(sources, dataset);
  let previous = null, card = null, compactAnchor = null;
  return original.split('\n').map(line => {
    if (!line.trim()) return line;
    const plain = line.replace(/\*\*/g, '');
    const priorCompact = compactAnchor;
    compactAnchor = completeConsensus ? compactPlanFieldLine(dataset, plain) : null;
    const typedConsensus = priorCompact && completeConsensus
      && /^\s*(?:[-*•]\s*)?期次状态计数(?:里|中)?[：:,，]/.test(plain);
    const cardHeading = /^\s*(?:[-*•]\s*)?计划[：:]/.test(plain);
    const namedCard = cardHeading && rowForLine(dataset, plain, null);
    if (cardHeading) card = namedCard ? { row: namedCard, scoped: false, valid: true } : null;
    const fieldCard = card?.valid && /^\s*(?:[-*•]\s*)?(?:每期金额|每期计划金额|总期数|下次计划日期|计划下次日期)[：:]/.test(plain);
    if (fieldCard && !matchingCardField(card.row, plain)) card.valid = false;
    const range = cardRange(plain);
    if (range && card?.valid) card.scoped = range.startDate === scope.startDate && range.endDate === scope.endDate;
    const scopedCard = card?.valid && card.scoped && dataset.queryMeta.rowsComplete === true
      && dataset.rows.length === 1 && dataset.queryMeta.matchedRowCount === 1 && dataset.queryMeta.returnedRowCount === 1;
    const readReport = scopedCard && readConsensus && /分期登记[^。！？;；\n]{0,40}已保存的?期次状态/.test(plain)
      && /(?:本轮|本次|这次)(?:全范围)?查询显示已入账\s*\d+\s*期/.test(plain);
    const row = rowForLine(dataset, plain, previous) || (typedConsensus ? priorCompact
      : fieldCard && card.valid || range && scopedCard || readReport ? card.row : null);
    previous = row;
    const reportLine = readReport ? plain.replace(/(?:本轮|本次|这次)(?:全范围)?查询显示(?=已入账\s*\d+\s*期)/g, '已保存的期次状态显示') : plain;
    if (!row || explicitExecution.test(reportLine) || aggregate.test(reportLine)) return line;
    const tokens = [...line.matchAll(stateCounts)];
    if (!tokens.length || tokens.some(token => {
      const value = Number(token[2]), namedLabels = token[1].split(/[/／、]/).map(label => label.trim().replace(/状态$/, ''));
      return !Number.isSafeInteger(value) || namedLabels.some(label => !hasField(dataset, row, LABEL_FIELDS[label], value));
    })) return line;
    const typed = line.replace(stateCounts, (whole, group) => group.includes('已入账')
      ? whole.replace(/已入账(?!状态)/g, /[/／、]/.test(group) ? '「已入账」' : '已入账状态：') : whole);
    if (typedConsensus) return typed.replace(/期次状态计数(?:里|中)?[：:,，]/,
      '各已返回查询窗口的已保存期次状态计数：');
    if (!readReport) return typed;
    return sources.length > 1 ? typed.replace(/(?:本轮|本次|这次)(?:全范围)?查询显示已入账状态[：:]?\s*(\d+)\s*期/g,
      '各已返回查询窗口中已保存的入账状态计数均为$1期')
      : typed.replace(/(?:本轮|本次|这次)(?:全范围)?查询显示(?=已入账状态[：:]?\s*\d+\s*期)/g,
        '本次查询范围内的已保存期次状态显示');
  }).join('\n');
}
// Published periods is the plan's total, not a remaining-period count. This
// handles the captured prose formats only; callers must check execution claims
// against the original answer before applying any text normalization here.
function normalizeInstallmentRemainingClaims(text, datasets = []) {
  const original = String(text || '');
  const sources = datasets.filter(dataset => dataset.datasetId === 'installment-plans'
    && /^q_[a-f0-9]{24}$/.test(dataset.queryMeta?.queryId || '')
    && dataset.columns?.some(column => column.key === 'periods' && column.type === 'number')
    && dataset.rows?.some(row => Number.isSafeInteger(row.periods) && row.periods > 0));
  if (!sources.length || sources.some(dataset => dataset.columns.some(column =>
    ['remaining', 'remainingPeriods'].includes(column.key) && column.type === 'number')
    && dataset.rows.some(row => ['remaining', 'remainingPeriods'].some(key => Number.isSafeInteger(row[key]) && row[key] >= 0)))) return original;
  const count = '(?:\\d+|[零〇一二两三四五六七八九十百千万]+)';
  const remaining = new RegExp(`(?:还剩|剩余|剩下)(?:期数)?\\s*(?:为|是|[：:])?\\s*${count}\\s*期|${count}\\s*期\\s*(?:都|全都|全部|均)\\s*(?:还|尚)?\\s*(?:未|没(?:有)?)\\s*入账`, 'g');
  const fenced = [], masked = original.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g,
    value => { let key = `@@SAVEDPERIODPROSE${String.fromCharCode(65 + fenced.length)}@@`;
      while (original.includes(key)) key += '_';
      fenced.push({ key, value }); return key; });
  let inserted = false, prefix = '';
  let output = (masked.match(/[^，,。；;！？\n]+[，,。；;！？]?|\n+/g) || []).map(chunk => {
    const earlier = prefix; prefix += chunk;
    if (explicitExecution.test(chunk)) return chunk;
    const unknown = [...chunk.matchAll(remaining)].some(match => {
      const before = chunk.slice(0, match.index), after = chunk.slice(match.index + match[0].length);
      const referenced = /(?:你|用户)(?:问|提到|说)|原话|问题|是否|是不是|能否|难道/.test(before)
        || /^\s*(?:[“”‘’「」『』"'*]+\s*)?(?:吗|么|呢)?[？?]/.test(after);
      const negative = /(?:不代表|不等于|不意味着|不是|并非|未必|不一定|无法确认|尚不确定)[^，,。；;！？\n]{0,12}$/.test(before)
        || /(?:不能|无法|不可|难以)[^，,。；;！？\n]{0,18}(?:确认|确定|说|判断|认定|断言|推断)[^，,。；;！？\n]{0,10}$/.test(before)
        || /不能[^。；;！？\n]{0,60}(?:断言|推断|说|认为)[^。；;！？\n]{0,8}$/.test(earlier + before);
      const hypothetical = /(?:如果|假设|假如|若|举例|例如|示例)/.test(before);
      return !referenced && !negative && !hypothetical;
    });
    if (!unknown) return chunk;
    if (inserted) return '';
    inserted = true;
    return '无法仅凭已保存的计划配置和窗口状态计数确认实际剩余期数。';
  }).join('');
  for (const { key, value } of fenced) output = output.split(key).join(value);
  return output;
}
module.exports = { normalizeInstallmentSavedStateClaims, normalizeInstallmentRemainingClaims };
