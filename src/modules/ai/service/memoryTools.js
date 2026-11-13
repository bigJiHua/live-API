const Joi = require('joi');
const { AiError } = require('./errors');

const OPERATIONS = ['create', 'replace', 'append', 'patch'];
const TYPES = ['preference', 'profile', 'workflow', 'note'];
const pathSchema = Joi.string().min(1).max(80).required();
const revisionSchema = Joi.string().pattern(/^[a-f0-9]{64}$/);
const schemas = Object.freeze({
  memory_list: Joi.object({ offset: Joi.number().integer().min(0).max(50).default(0),
    limit: Joi.number().integer().min(1).max(20).default(20) }).unknown(false),
  memory_read: Joi.object({ path: pathSchema, offset: Joi.number().integer().min(0).max(65536).default(0),
    limit: Joi.number().integer().min(1).max(3000).default(3000) }).unknown(false),
  memory_search: Joi.object({ pattern: Joi.string().min(1).max(200).required(),
    mode: Joi.string().valid('literal', 'regex').default('literal'),
    limit: Joi.number().integer().min(1).max(20).default(10) }).unknown(false),
  memory_write: Joi.object({ path: pathSchema, operation: Joi.string().valid(...OPERATIONS).required(),
    title: Joi.string().min(1).max(80).required(), type: Joi.string().valid(...TYPES).required(),
    content: Joi.string().max(6000).allow('').required(),
    expectedRevision: Joi.when('operation', { is: Joi.valid('replace', 'patch'),
      then: revisionSchema.required(), otherwise: revisionSchema.allow(null) }),
    oldText: Joi.when('operation', { is: 'patch', then: Joi.string().min(1).max(6000).required(), otherwise: Joi.valid(null) }),
    evidence: Joi.object({ sourceTurn: Joi.number().integer().min(0).max(15).allow(null),
      historyRef: Joi.string().pattern(/^h_[a-f0-9]{32}$/).allow(null),
      quote: Joi.string().min(1).max(1500).required() }).unknown(false).custom((value, helpers) =>
      Number.isInteger(value.sourceTurn) || typeof value.historyRef === 'string' ? value : helpers.error('any.custom')).required(),
    reason: Joi.string().min(1).max(500).required(),
  }).unknown(false),
});
const definition = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const memoryPathDefinition = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^/\\\\\\r\\n]+\\.md$',
  description: '仅单个 .md 文件名，例如 preferences.md 或 偏好.md；不含目录，不用 preferences/color.md、斜杠、反斜杠或绝对路径。已有文件路径从 memory_list 取得。' };
const memoryDefinitions = [
  definition('memory_list', '分页列出本人自主记忆文件的标题、类型和版本，每次最多20项。记忆可跨会话读取；不能把记忆当作本轮账本事实或业务执行回执。',
    { offset: { type: 'integer', minimum: 0, maximum: 50, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 20 } }, []),
  definition('memory_read', '读取 memory_list 返回的本人记忆相对路径及当前版本。offset/limit按Unicode码点分页，查看truncated/nextOffset后继续读取；lines给出正文行号、原始lineCharLength和本页returnedRange（行内从1开始，endExclusive不含末位置）、returnedCharCount、textTruncated，最多50行。lineEvidenceTruncated为true时按nextLineEvidenceOffset继续读取行证据。bodyOffset从0开始。单行长度不含CR/LF；contentLength是整个正文字符数含换行，bytes是含元信息的整个文件UTF-8字节数，不能当作行长。字符计数直接引用服务端字段，不手数重复文本；脱敏标记为true时不声称可见文本是完整原文。修改旧记忆时先读，不猜路径或版本。',
    { path: { ...memoryPathDefinition }, offset: { type: 'integer', minimum: 0, maximum: 65536, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 3000, default: 3000 } }, ['path']),
  definition('memory_search', '搜索本人记忆。默认 literal 字面搜索；regex 为受限正则搜索。只匹配记忆文件，不是文件系统、SQL或HTTP检索。结果最多20条；matches是行级匹配并绑定文件revision。lineCharLength是原始整行Unicode码点数，不含换行；returnedCharCount和returnedRange给出已返回字符范围（从1开始，endExclusive不含末位置），最多240字符。textTruncated标记该行是否截短，truncated标记搜索覆盖是否截断，两者分别判断。直接引用服务端计数，不手数重复文本；脱敏标记为true时不声称可见文本是完整原文。原文完整且满足当前搜索问题时直接答复，不必再读整个文件。',
    { pattern: { type: 'string', minLength: 1, maxLength: 200 }, mode: { type: 'string', enum: ['literal', 'regex'], default: 'literal' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }, ['pattern']),
  definition('memory_write', '根据用户原话自主保存或修改本人记忆，无需再请求确认。content必须逐字保留完整userTurns[sourceTurn]或history_read返回的完整用户原话，包括否定、例外和跨行列表；不要把我不喜欢蓝色改写为喜欢蓝色，也不要只摘取quote片段当正文。可使用不改原文的blockquote包装。create新建，replace替换正文，append追加完整原话记录（记录间留空行），patch替换oldText完整原话记录；不能用片段替换截断句意。修改旧文件先read取得expectedRevision。evidence.quote仍须逐字引用真实用户原话，说明reason。工具status=saved才可声称已保存；失败应说明原因。记忆不会写账本或执行业务。',
    { path: { ...memoryPathDefinition }, operation: { type: 'string', enum: OPERATIONS },
      title: { type: 'string', minLength: 1, maxLength: 80 }, type: { type: 'string', enum: TYPES },
      content: { type: 'string', maxLength: 6000,
        description: '直接复制完整 userTurns[sourceTurn] 或 history_read 的完整用户原话作为正文。不要添加“用户原话：”、额外包裹引号、标题、摘要或分析；标题只放 title。原话自身的引号、否定、例外和换行原样保留。可仅在每行前加 Markdown >，不得再加其它文字。仅本轮用户明确要求删除或忘掉完整记录，且已由本轮 memory_read 取得匹配 revision 时，patch content 才可为空；删除 evidence.sourceTurn 必须为 TASK_INPUT.currentTurn，不能使用 historyRef。' }, expectedRevision: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$',
        description: 'memory_read返回的SHA-256 revision；replace/patch必须提供，其他操作可省略或null。' },
      oldText: { type: ['string', 'null'], minLength: 1, maxLength: 6000, description: 'patch必须给出原正文中的逐字片段；其他操作省略或null。' },
      evidence: { type: 'object', properties: { sourceTurn: { type: ['integer', 'null'], minimum: 0, maximum: 15 },
        historyRef: { type: ['string', 'null'], pattern: '^h_[a-f0-9]{32}$', description: '仅本轮history工具返回的用户原话引用；不能引用assistant或旧memory。' },
        quote: { type: 'string', minLength: 1, maxLength: 1500 } }, required: ['quote'], additionalProperties: false,
        anyOf: [{ properties: { sourceTurn: { type: 'integer' } }, required: ['sourceTurn'] },
          { properties: { historyRef: { type: 'string' } }, required: ['historyRef'] }] },
      reason: { type: 'string', minLength: 1, maxLength: 500 } }, ['path', 'operation', 'title', 'type', 'content', 'evidence', 'reason']),
];

function isMemoryTool(name) { return typeof name === 'string' && Object.hasOwn(schemas, name); }
function validateMemoryTool(name, args) {
  if (!isMemoryTool(name)) throw new AiError('模型选择了未开放记忆能力', 403, 'AI_TOOL_DENIED');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AiError('记忆工具参数必须是对象', 400, 'AI_MEMORY_ARGUMENT_INVALID');
  const { value, error } = schemas[name].validate(args, { convert: false, abortEarly: false });
  if (error) throw new AiError('记忆工具参数不符合开放协议', 400, 'AI_MEMORY_ARGUMENT_INVALID');
  return value;
}
module.exports = { memoryDefinitions, validateMemoryTool, isMemoryTool };
