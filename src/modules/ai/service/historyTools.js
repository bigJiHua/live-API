const Joi = require('joi');
const { AiError } = require('./errors');
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const historyDefinitions = [
  tool('history_search', '按原话关键词回查本人当前聊天更早的对话。用于近期窗口之外的指代、遗漏偏好或明确历史原话；历史答复不是新金额证据。默认从最新匹配开始；查第一篇或最早内容用order=oldest，已完成文章可用role=assistant和status=completed排除提问及失败通知。返回准确sourceTime和本轮h_ref，memory_write可引用其中user原话。query是字面文本，不是SQL或正则。',
    { query: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 10 },
      order: { type: 'string', enum: ['latest', 'oldest'] }, role: { type: 'string', enum: ['user', 'assistant'] },
      status: { type: 'string', enum: ['completed', 'failed'] } }, ['query']),
  tool('history_read', '读取history_search本轮返回h_ref对应的对话原文。只能读取本人当前聊天，不能用历史ref代替本轮交易金额来源或业务候选ref。',
    { ref: { type: 'string', pattern: '^h_[a-f0-9]{32}$' } }, ['ref']),
];
const schemas = {
  history_search: Joi.object({ query: Joi.string().trim().min(1).max(80).required(), limit: Joi.number().integer().min(1).max(10).default(5),
    order: Joi.string().valid('latest', 'oldest'), role: Joi.string().valid('user', 'assistant'),
    status: Joi.string().valid('completed', 'failed') }).unknown(false),
  history_read: Joi.object({ ref: Joi.string().pattern(/^h_[a-f0-9]{32}$/).required() }).unknown(false),
};
function isHistoryTool(name) { return typeof name === 'string' && Object.hasOwn(schemas, name); }
function validateHistoryTool(name, args) {
  if (!isHistoryTool(name)) throw new AiError('历史工具尚未开放', 403, 'AI_TOOL_DENIED');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AiError('历史工具参数必须是对象', 400, 'AI_TOOL_ARGUMENT_INVALID');
  const input = typeof args.query === 'string' ? { ...args, query: args.query.trim() } : args;
  const result = schemas[name].validate(input, { convert: false });
  if (result.error) throw new AiError('历史工具参数无效', 400, 'AI_TOOL_ARGUMENT_INVALID');
  return result.value;
}
module.exports = { historyDefinitions, isHistoryTool, validateHistoryTool };
