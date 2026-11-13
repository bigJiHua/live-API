const Joi = require('joi');
const { AiError } = require('./errors');
const { validateMemoryPath, validateMemoryText } = require('./memoryStore');

const schema = Joi.object({
  path: Joi.string().min(1).max(80).required(),
  expectedRevision: Joi.string().pattern(/^[a-f0-9]{64}$/).required(),
  evidence: Joi.object({ sourceTurn: Joi.number().integer().min(0).max(15).required(),
    quote: Joi.string().min(1).max(1500).required() }).unknown(false).required(),
  reason: Joi.string().min(1).max(500).required(),
}).unknown(false);

const memoryDeleteDefinitions = [{ type: 'function', function: {
  name: 'memory_delete',
  description: '仅在本轮用户明确要求删除或忘掉长期记忆时，删除本人单个已读取的记忆文件。先 memory_list/search 确认目标，再 memory_read 获取当前 revision，使用 expectedRevision。evidence.sourceTurn 必须是 TASK_INPUT.currentTurn，quote逐字引用本轮删除要求；不能用历史用户原话、记忆正文或助手答复授权删除。若用户只要求删除文件中的一项，先核对全文并使用 memory_write.patch，不能删掉其它信息；目标不唯一时先澄清。仅工具返回 deleted:true 才能说已删除；失败或没有调用不能声称已忘记。删除不修改账本、用户画像、规则或历史对话，可在前端记忆管理的修改记录中恢复。',
  parameters: { type: 'object', additionalProperties: false,
    required: ['path', 'expectedRevision', 'evidence', 'reason'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^/\\\\\\r\\n]+\\.md$',
        description: '已由本轮 memory_list/search/read 返回的单层 .md 文件名，不能猜路径、使用目录或绝对路径。' },
      expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '本轮 memory_read 实际返回的当前文件 revision。' },
      evidence: { type: 'object', additionalProperties: false, required: ['sourceTurn', 'quote'], properties: {
        sourceTurn: { type: 'integer', minimum: 0, maximum: 15, description: '必须是 TASK_INPUT.currentTurn，删除只接受本轮明确请求。' },
        quote: { type: 'string', minLength: 1, maxLength: 1500, description: '逐字引用本轮用户的明确删除或忘掉记忆要求，保留否定和限定语。' },
      } },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
    } },
} }];

const invalid = (message, code = 'AI_MEMORY_DELETE_NOT_REQUESTED', status = 400) => new AiError(message, status, code);
const maskQuoted = text => String(text).replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  value => value.replace(/[^\n]/g, ' '));

function explicitMemoryDeleteRequest(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 1500) return false;
  const masked = maskQuoted(source);
  const clauses = masked.split(/[。；;！？!?\n]+|但是|而是|\bbut\b/iu);
  for (const clause of clauses) {
    const action = /删除|删掉|删去|删了|移除|清除|清空|忘掉|忘记|\b(?:delete|remove|erase|clear|forget)\b/giu;
    for (const match of clause.matchAll(action)) {
      const prefix = clause.slice(0, match.index).split(/[，,]|但是|而是|\bbut\b/iu).at(-1);
      const local = clause.slice(Math.max(0, match.index - 50), match.index + match[0].length + 120);
      const after = clause.slice(match.index + match[0].length);
      if (/^(?:我(?:已经|已)|已经|之前|上次|此前|曾经|原来|过去)|(?:说过|说了|提到|举例|表示|告诉我|解释|介绍|说明|讨论|不知道)[^，,]{0,30}$/u.test(prefix) ||
        /\b(?:previously|earlier|last time|already|said|mentioned|explain|describe|tell me|whether)(?:\s+\w+){0,5}\s*$/iu.test(prefix) ||
        /^(?:是否|能否|支持)/u.test(after) || /是否|怎么|如何|怎样|什么作用|什么意思/u.test(clause)) continue;
      if (/忘掉|忘记|\bforget\b/iu.test(match[0]) &&
        /话题|对话|任务|请求|问题|上面|上一轮|之前的内容|\b(?:topic|conversation|task|request|question|asked|above|previous)\b/iu.test(after)) continue;
      if (/\b(?:asked|request(?:ed)?)\b/iu.test(clause.slice(0, match.index))) continue;
      if (/(?:如果|假如|假设|例如|比如|示例|\b(?:if|when|example|suppose)\b)/iu.test(clause.slice(0, match.index))) continue;
      if (/(?:不要|不用|无需|不必|不得|不能|不会|别|不是|未|没有)[^，,]{0,16}$/u.test(prefix) ||
        /\b(?:do not|don't|not|never|cannot|can't|shouldn't|mustn't|without)(?:\s+\w+){0,4}\s*$/iu.test(prefix)) continue;
      if (/(?:如果|假如|假设|例如|比如|示例|如何|怎么|怎样|是否|能否|可以吗|支持)[^，,]{0,45}$/u.test(prefix) ||
        /\b(?:if|when|example|suppose|how to|whether|can you|could you|would you)(?:\s+\w+){0,5}\s*$/iu.test(prefix)) {
        // "can/could/would you delete my memory" is a concrete polite request.
        if (!/^\s*(?:please\s+)?(?:can|could|would)\s+you\s*$/iu.test(prefix)) continue;
      }
      if (/(?:能|可以|支持)[^，,]{0,12}$/u.test(prefix) && /(?:吗|么)\s*$/u.test(clause)) continue;
      if (/^(?:你|AI|助手|系统)[^，,]{0,20}(?:能|可以|支持)[^，,]{0,20}$/u.test(prefix) && /(?:吗|么)\s*$/u.test(clause)) continue;
      if (/记忆|长期偏好|(?:已保存|记住|记录)(?:的)?[^，,]{0,35}(?:偏好|信息)|\bmemor(?:y|ies)\b|\b(?:saved|remembered|stored)\s+(?:preferences?|information|facts?)\b/iu.test(local)) return true;
      if (/忘掉|忘记|\bforget\b/iu.test(match[0])) {
        if (!after.trim() && /[“「『"']/.test(source)) {
          const quoted = [...source.matchAll(/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"\n]*)"|'([^'\n]*)'/gu)]
            .map(item => item.slice(1, 6).find(value => value !== undefined));
          if (quoted.some(value => /我|喜欢|不喜欢|偏好|习惯|\b(?:my|me|I|prefer|like|dislike)\b/iu.test(value)
            && !/话题|对话|任务|请求|\b(?:topic|conversation|task|request)\b/iu.test(value))) return true;
        }
        if (/我|本人|我的|喜欢|不喜欢|习惯|偏好|这件事|这一点|\b(?:that|my|me|I|prefer|like|dislike)\b/iu.test(after)) return true;
      }
    }
  }
  return false;
}

function isMemoryDeleteTool(name) { return name === 'memory_delete'; }
function validateMemoryDeleteTool(name, args) {
  if (!isMemoryDeleteTool(name)) throw invalid('模型选择了未开放记忆删除能力', 'AI_TOOL_DENIED', 403);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('记忆删除参数必须是对象', 'AI_MEMORY_ARGUMENT_INVALID');
  const { value, error } = schema.validate(args, { convert: false, abortEarly: false });
  if (error) throw invalid('记忆删除参数不符合开放协议', 'AI_MEMORY_ARGUMENT_INVALID');
  validateMemoryPath(value.path);
  validateMemoryText(value.evidence.quote, { name: '记忆删除来源原话', maxBytes: 6000 });
  validateMemoryText(value.reason, { name: '记忆删除原因', maxBytes: 2000 });
  return value;
}

function validateMemoryDeleteEvidence(args, { userTurns = [], currentTurn, sourceText = null, readReceipts = [], before = null } = {}) {
  const input = validateMemoryDeleteTool('memory_delete', args);
  if (!Array.isArray(userTurns) || !Number.isInteger(currentTurn) || currentTurn < 0 || currentTurn >= userTurns.length ||
    input.evidence.sourceTurn !== currentTurn || typeof userTurns[currentTurn] !== 'string')
    throw invalid('删除记忆须由本轮用户明确要求，不能引用旧对话');
  const source = userTurns[currentTurn];
  if (sourceText != null && sourceText !== source || !source.includes(input.evidence.quote) ||
    !explicitMemoryDeleteRequest(source) || !explicitMemoryDeleteRequest(input.evidence.quote))
    throw invalid('本轮没有可核对的明确记忆删除要求，记忆未删除');
  const reads = [...(Array.isArray(readReceipts) ? readReceipts : []), ...(before ? [before] : [])];
  if (!reads.some(item => item && item.status !== 'error' && item.path === input.path && item.revision === input.expectedRevision))
    throw invalid('删除前须在本轮读取目标记忆的当前版本', 'AI_MEMORY_REVISION_REQUIRED', 409);
  const namedFiles = [...source.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_ .-]{0,75}\.md/gu)].map(item => item[0].trim());
  if (namedFiles.length && !namedFiles.some(name => name === input.path || name.endsWith(` ${input.path}`) || name.endsWith(`记忆${input.path}`)))
    throw invalid('删除目标与本轮指定记忆文件不一致，记忆未删除');
  return { sourceText: source, quote: input.evidence.quote };
}

module.exports = { memoryDeleteDefinitions, isMemoryDeleteTool, validateMemoryDeleteTool,
  explicitMemoryDeleteRequest, validateMemoryDeleteEvidence };
