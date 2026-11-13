const { AiError } = require('./errors');
const business = require('./v3Tools');
const memory = require('./memoryTools');
const deletion = require('./memoryDeleteTools');
const history = require('./historyTools');
const calc = require('./calcTools');
const search = require('./webSearchTools');
const { buildModelToolDefinitions } = require('./modelToolDefinitions');

const authorizationDefinition = { type: 'function', function: { name: 'request_authorization',
  description: '需要使用数据读取或草稿操作能力时请求用户授权。应用推送授权卡，用户选择同意或拒绝以及有效期；获准后在本会话继续，不按日期或业务域分割授权。授权已有效则返回状态。operate表示切换操作模式并允许准备草稿，正式提交仍须用户确认。',
  parameters: { type: 'object', properties: { access: { type: 'string', enum: ['read', 'operate'] },
    reason: { type: 'string', maxLength: 200, description: '自然说明当前问题为什么需要该能力，不含真实ID或数据。' } },
  required: ['access', 'reason'], additionalProperties: false } } };

function validateAuthorization(name, args) {
  if (name !== 'request_authorization' || !args || !['read', 'operate'].includes(args.access)
    || typeof args.reason !== 'string' || args.reason.length > 200
    || Object.keys(args).some(key => !['access', 'reason'].includes(key)))
    throw new AiError('授权请求参数无效', 400, 'AI_TOOL_ARGUMENT_INVALID');
  return args;
}

// Bind published definitions to actual classifier/validator/dispatch families.
// Execution families retain their authorization, budget, egress and audit gates;
// this registry proves wiring, not the semantic correctness of a handler.
function createToolRegistry(families) {
  const entries = new Map();
  for (const family of families) {
    if (!family.id || typeof family.matches !== 'function' || typeof family.validate !== 'function'
      || !Array.isArray(family.definitions) || !family.access || !family.effect)
      throw new Error('AI tool family requires definitions, classifier, validator and policy');
    for (const definition of family.definitions) {
      const name = definition?.function?.name;
      if (definition?.type !== 'function' || !name || entries.has(name)
        || definition.function.parameters?.additionalProperties !== false)
        throw new Error(`AI tool definition invalid or duplicated: ${name}`);
      const owners = families.filter(candidate => candidate.matches?.(name));
      if (owners.length !== 1 || owners[0] !== family)
        throw new Error(`AI tool classifier mismatch: ${name}`);
      entries.set(name, Object.freeze({ name, family: family.id, validate: family.validate,
        access: family.access, effect: family.effect, definition }));
    }
  }
  function resolve(name, { open = false, searchEnabled = false } = {}) {
    const entry = entries.get(name);
    if (!entry || entry.family === 'authorization' && !open || entry.family === 'search' && !searchEnabled)
      throw new AiError('本轮未开放该工具', 403, 'AI_TOOL_DENIED');
    return entry;
  }
  function definitions({ open = false, searchEnabled = false } = {}) {
    return buildModelToolDefinitions([...entries.values()]
      .filter(entry => (open || entry.family !== 'authorization') && (searchEnabled || entry.family !== 'search'))
      .map(entry => entry.definition));
  }
  function dispatcher(handlers, options) {
    for (const entry of entries.values()) if (typeof handlers[entry.family] !== 'function')
      throw new Error(`AI tool execution family missing: ${entry.family}`);
    return (name, args, call) => handlers[resolve(name, options).family](name, args, call);
  }
  return Object.freeze({ resolve, definitions, dispatcher, entries: () => [...entries.values()] });
}

const toolRegistry = createToolRegistry([
  { id: 'business', definitions: business.definitions, matches: name => ['query_data', 'list_choices'].includes(name), validate: business.validateTool, access: 'read', effect: 'read' },
  { id: 'context', definitions: memory.memoryDefinitions, matches: memory.isMemoryTool, validate: memory.validateMemoryTool, access: 'read-or-operate', effect: 'memory' },
  { id: 'context', definitions: deletion.memoryDeleteDefinitions, matches: deletion.isMemoryDeleteTool, validate: deletion.validateMemoryDeleteTool, access: 'operate', effect: 'memory-delete' },
  { id: 'context', definitions: history.historyDefinitions, matches: history.isHistoryTool, validate: history.validateHistoryTool, access: 'read', effect: 'read' },
  { id: 'calculate', definitions: calc.calcDefinitions, matches: calc.isCalcTool, validate: calc.validateCalcTool, access: 'local', effect: 'pure' },
  { id: 'authorization', definitions: [authorizationDefinition], matches: name => name === 'request_authorization', validate: validateAuthorization, access: 'requested', effect: 'authorization' },
  { id: 'search', definitions: search.webSearchDefinitions, matches: search.isWebSearchTool, validate: search.validateWebSearchTool, access: 'web_search', effect: 'paid-search' },
]);

module.exports = { createToolRegistry, toolRegistry, validateAuthorization };
