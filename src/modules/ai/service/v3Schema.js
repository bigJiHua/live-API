const Joi = require('joi');
const { AiError } = require('./errors');

const KIND_FIELDS = Object.freeze({
  'transaction.create': ['direction', 'amount', 'currency', 'transDate', 'categoryRef', 'accountRef', 'payMethod', 'remark'],
  'budget.create': ['title', 'route', 'budgetType', 'budgetAmount', 'cycle', 'planDate', 'notes'],
  'todo.create': ['content', 'eventType', 'happenDate', 'priority', 'needRemind', 'remindDays', 'isRecurring', 'remark'],
  'todo.update': ['targetRef', 'content', 'eventType', 'happenDate', 'priority', 'needRemind', 'remindDays', 'isRecurring', 'remark'],
  'todo.complete': ['targetRef', 'status'], 'todo.delete': ['targetRef'],
  'diary.create': ['content', 'mood', 'date'], 'card.metadata': ['targetRef', 'alias', 'status'],
  'fixedAsset.create': ['info', 'tag', 'buyPrice', 'useYears', 'residualRate', 'buyDate'],
  'fixedAsset.update': ['targetRef', 'info', 'tag'], 'fixedAsset.delete': ['targetRef'],
  'fixedAsset.restore': ['targetRef'], 'fixedAsset.permanentDelete': ['targetRef'],
  'fund.returnBatch': ['fundRef', 'entries'], 'system.backup': [],
});
const evidence = Joi.object({ sourceTurn: Joi.number().integer().min(0).max(15).required(), quote: Joi.string().min(1).max(1500).required(),
  dateSourceTurn: Joi.number().integer().min(0).max(15).allow(null), dateQuote: Joi.string().min(1).max(500).allow(null) }).unknown(false).allow(null);
const item = Joi.object({ kind: Joi.string().valid(...Object.keys(KIND_FIELDS)).required(), fields: Joi.object().max(15).required(), evidence }).unknown(false);
const chart = Joi.object({ datasetId: Joi.string().max(64).required(), type: Joi.string().valid('bar', 'line', 'pie').required(),
  queryId: Joi.string().pattern(/^q_[a-f0-9]{24}$/).allow(null),
  xKey: Joi.string().max(40).required(), yKeys: Joi.array().items(Joi.string().max(40)).min(1).max(4).unique().required(), title: Joi.string().max(80).required() }).unknown(false).allow(null);
const OUTPUT_SCHEMA = Joi.object({ answer: Joi.string().allow('').max(4000).required(), proposal: item.allow(null),
  proposals: Joi.array().min(2).max(3).items(item).allow(null),
  clarification: Joi.object({ items: Joi.array().min(1).max(3).items(item).required() }).unknown(false).allow(null), chart }).unknown(false);
function parseSingleJsonObject(content) {
  const invalid = (singleObjectEncoding = false) => {
    const error = new AiError('模型未返回唯一有效JSON对象，本轮结束，不自动重试', 502, 'AI_INVALID_RESULT');
    if (singleObjectEncoding) Object.defineProperty(error, 'singleObjectEncoding', { value: true });
    throw error;
  };
  if (typeof content !== 'string' || content.length > 30000) invalid();
  const text = content.trim();
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    invalid();
  } catch (error) { if (error instanceof AiError) throw error; }
  const start = text.indexOf('{');
  if (start < 0) invalid();
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0) invalid();
  // Decode one complete object surrounded by explanatory text/fences. Never repair syntax, choose among multiple objects or execute wrappers.
  const outside = text.slice(0, start) + text.slice(end);
  if (/[{}\[\]]/.test(outside) || (/^\s*"/.test(text.slice(0, start)) && /"\s*$/.test(text.slice(end)))) invalid();
  let value;
  try { value = JSON.parse(text.slice(start, end)); } catch (_) { invalid(true); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
const ISSUE_MESSAGES = Object.freeze({
  'any.required': '缺少必填字段', 'any.only': '值不在允许范围', 'any.invalid': '值不符合要求',
  'object.base': '应为对象', 'object.unknown': '字段未开放', 'object.max': '对象字段数超过上限',
  'string.base': '应为字符串', 'string.empty': '字符串不能为空', 'string.min': '字符串长度不足',
  'string.max': '字符串长度超过上限', 'string.pattern.base': '字符串格式不符合要求',
  'number.base': '应为数值', 'number.integer': '应为整数', 'number.min': '数值小于下限', 'number.max': '数值超过上限',
  'array.base': '应为数组', 'array.min': '数组项数不足', 'array.max': '数组项数超过上限', 'array.unique': '数组项不能重复',
  'intent.exclusive': '互斥意图必须择一', 'kind.clarification': '待补充协议仅支持普通收支',
  'kind.multiple': '多笔提案仅支持普通收支', 'fields.allowlist': '字段未开放或包含真实ID',
});
function outputIssue(input, path, rule) {
  const actual = path.reduce((value, key) => value !== null && value !== undefined ? value[key] : undefined, input);
  return { path: path.reduce((value, key) => typeof key === 'number' ? `${value}[${key}]` : `${value ? `${value}.` : ''}${key}`, '') || '$',
    rule, message: ISSUE_MESSAGES[rule] || '字段不符合允许格式',
    actualType: actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual };
}
function outputError(message, status, code, issues) {
  const error = new AiError(message, status, code);
  // Console-only diagnostic: never enumerate raw Joi context or persist it in the public error payload.
  Object.defineProperty(error, 'validationDiagnostic', { value: {
    stage: 'output-schema', issues: issues.slice(0, 20), truncated: issues.length > 20,
  } });
  return error;
}
function validateOutput(input) {
  const { error, value: output } = OUTPUT_SCHEMA.validate(input, { abortEarly: false, convert: false });
  if (error) throw outputError('模型生成的答复或草稿结构不符合允许格式，本轮没有生成可执行草稿', 502, 'AI_INVALID_RESULT',
    error.details.map(detail => outputIssue(input, detail.path, detail.type)));
  if (output.proposal && output.proposals?.length) throw outputError('模型不能同时返回单笔与多笔提案', 502, 'AI_INVALID_RESULT',
    [outputIssue(input, ['proposals'], 'intent.exclusive')]);
  if (output.clarification && (output.proposal || output.proposals?.length)) throw outputError('待补充意图与草稿必须择一', 502, 'AI_INVALID_RESULT',
    [outputIssue(input, ['clarification'], 'intent.exclusive')]);
  const list = output.clarification?.items || output.proposals || (output.proposal ? [output.proposal] : []);
  const listPath = output.clarification ? ['clarification', 'items'] : output.proposals ? ['proposals'] : ['proposal'];
  const itemPath = index => listPath.concat(output.clarification || output.proposals ? [index] : []);
  if (output.clarification && list.some(proposal => proposal.kind !== 'transaction.create')) throw outputError('待补充协议仅支持普通收支', 502, 'AI_INVALID_RESULT',
    list.flatMap((proposal, index) => proposal.kind === 'transaction.create' ? [] : [outputIssue(input, itemPath(index).concat('kind'), 'kind.clarification')]));
  if (list.length > 1 && list.some(proposal => proposal.kind !== 'transaction.create')) throw outputError('混合业务须分别核对，本轮多卡只支持普通收支', 400, 'AI_INVALID_RESULT',
    list.flatMap((proposal, index) => proposal.kind === 'transaction.create' ? [] : [outputIssue(input, itemPath(index).concat('kind'), 'kind.multiple')]));
  for (const [index, proposal] of list.entries()) {
    const disallowed = Object.keys(proposal.fields).filter(key => !KIND_FIELDS[proposal.kind].includes(key));
    if (disallowed.length) throw outputError('模型返回了未开放字段或真实ID', 403, 'AI_REF_INVALID',
      disallowed.map(key => outputIssue(input, itemPath(index).concat('fields', key), 'fields.allowlist')));
  }
  return output;
}
const nullable = type => ({ type: [type, 'null'] });
const entrySchema = { type: 'object', properties: { date: { type: 'string' }, amount: { type: 'string' } }, required: ['date', 'amount'], additionalProperties: false };
const evidenceJson = { anyOf: [{ type: 'null' }, { type: 'object', properties: { sourceTurn: { type: 'integer', minimum: 0, maximum: 15 }, quote: { type: 'string' },
  dateSourceTurn: { type: ['integer', 'null'], minimum: 0, maximum: 15 }, dateQuote: { type: ['string', 'null'] } }, required: ['sourceTurn', 'quote', 'dateSourceTurn', 'dateQuote'], additionalProperties: false }] };
const proposalJson = { anyOf: Object.entries(KIND_FIELDS).map(([kind, fields]) => ({ type: 'object',
  properties: { kind: { type: 'string', enum: [kind] }, fields: { type: 'object', properties: Object.fromEntries(fields.map(key => [key,
    key === 'entries' ? { type: ['array', 'null'], items: entrySchema } : ['direction', 'priority', 'remindDays', 'useYears', 'residualRate'].includes(key) ? nullable('number')
      : ['needRemind', 'isRecurring'].includes(key) ? nullable('boolean') : nullable('string')])), required: fields, additionalProperties: false }, evidence: evidenceJson },
  required: ['kind', 'fields', 'evidence'], additionalProperties: false })) };
const OUTPUT_JSON_SCHEMA = { type: 'object', properties: { answer: { type: 'string' },
  proposal: { anyOf: [{ type: 'null' }, ...proposalJson.anyOf] }, proposals: { type: ['array', 'null'], items: proposalJson, minItems: 2, maxItems: 3 },
  clarification: { anyOf: [{ type: 'null' }, { type: 'object', properties: { items: { type: 'array', items: proposalJson, minItems: 1, maxItems: 3 } }, required: ['items'], additionalProperties: false }] },
  chart: { anyOf: [{ type: 'null' }, { type: 'object', properties: { datasetId: { type: 'string' }, type: { type: 'string', enum: ['bar', 'line', 'pie'] },
    queryId: { type: ['string', 'null'] }, xKey: { type: 'string' }, yKeys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 }, title: { type: 'string' } }, required: ['datasetId', 'type', 'xKey', 'yKeys', 'title', 'queryId'], additionalProperties: false }] } },
  required: ['answer', 'proposal', 'proposals', 'clarification', 'chart'], additionalProperties: false };
module.exports = { KIND_FIELDS, OUTPUT_JSON_SCHEMA, validateOutput, parseSingleJsonObject };
