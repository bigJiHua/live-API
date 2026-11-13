const Joi = require('joi');
const { AiError } = require('./errors');

function todayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const date = Joi.string().pattern(/^20\d{2}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? helpers.error('any.invalid') : value;
});
const id = Joi.string().pattern(/^[\w-]{1,64}$/);
const range = { startDate: date.required(), endDate: date.required() };
const requestSchema = Joi.object({ message: Joi.string().trim().min(1).max(1500).required(),
  scene: Joi.string().valid('query', 'draft', 'chat').required(), consent: Joi.boolean().required(),
  conversationId: Joi.string().guid({ version: 'uuidv4' }),
  requestId: Joi.string().guid({ version: 'uuidv4' }),
  connectionId: Joi.string().guid({ version: 'uuidv4' }) }).unknown(false);
const ocrRequestSchema = Joi.object({ image: Joi.object({ dataUrl: Joi.string().max(2 * 1024 * 1024).required() }).unknown(false).required(),
  message: Joi.string().trim().max(1500).allow('').default(''), consent: Joi.boolean().required(),
  conversationId: Joi.string().guid({ version: 'uuidv4' }),
  requestId: Joi.string().guid({ version: 'uuidv4' }),
  connectionId: Joi.string().guid({ version: 'uuidv4' }) }).unknown(false);
const toolSchemas = Object.freeze({
  query_finance_summary: Joi.object(range).unknown(false),
  query_transactions: Joi.object({ ...range, categoryId: id,
    limit: Joi.number().integer().min(1).max(20).default(10),
    offset: Joi.number().integer().min(0).max(100).default(0) }).unknown(false),
  list_record_choices: Joi.object({}).unknown(false),
  propose_transaction: Joi.object({ direction: Joi.number().valid(0, 1).required(),
    amount: Joi.string().pattern(/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/).required()
      .custom((value, helpers) => Number(value) > 0 ? value : helpers.error('any.invalid')),
    currency: Joi.string().valid('CNY').required(), transDate: date.required(),
    categoryId: id.allow(null).required(), accountId: id.allow(null).required(),
    payMethod: Joi.string().valid('现金', '余额', '支付宝', '微信', '银行卡').allow(null).required(),
    remark: Joi.string().max(255).allow('').required() }).unknown(false),
});
function validate(schema, input) {
  const { error, value } = schema.validate(input, { abortEarly: false, convert: false });
  if (error) throw new AiError('参数不符合允许的字段或格式');
  return value;
}
function validateTool(name, input, today = todayShanghai()) {
  if (!Object.hasOwn(toolSchemas, name)) throw new AiError('不允许调用此工具', 403, 'AI_TOOL_DENIED');
  const value = validate(toolSchemas[name], input);
  if (value.startDate && (value.startDate > value.endDate || value.endDate > today ||
      (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000 > 92)) {
    throw new AiError('查询范围必须是过去或今天，且不超过 93 天');
  }
  if (value.transDate && value.transDate > today) throw new AiError('暂不支持未来日期记账草稿');
  return value;
}
const draftEditSchema = Joi.object({ version: Joi.number().integer().min(1).required(),
  fields: toolSchemas.propose_transaction.required() }).unknown(false);
const draftActionSchema = Joi.object({ version: Joi.number().integer().min(1).required(),
  action: Joi.string().valid('review', 'discard').required(),
  riskAcknowledgement: Joi.object({ fieldsDigest: Joi.string().length(64).required(), policyVersion: Joi.string().max(80).required(),
    riskDigest: Joi.string().length(64).required(), confirmedAmount: Joi.string().max(30) }).unknown(false) }).unknown(false);
// 追加163：入账提交只收 ID+版本（铁律1：不收任何业务字段 ⇒ 不构成第二写入口）
const commitSchema = Joi.object({ version: Joi.number().integer().min(1).required() }).unknown(false);
const financialFields = Joi.object({amount:Joi.string().max(40).allow(null),direction:Joi.number().valid(0,1).allow(null),currency:Joi.string().max(3).allow(null),
  transDate:date.allow(null),accountId:id.allow(null),categoryId:id.allow(null),payMethod:Joi.string().max(20).allow(null),remark:Joi.string().max(255).allow('',null)}).unknown(false);
const financialRequestSchema = Joi.object({message:Joi.string().trim().max(1500).allow(''),fields:financialFields,
  conversationId:Joi.string().guid({version:'uuidv4'}),sourceCandidateId:Joi.string().guid({version:'uuidv4'})}).or('fields','message','sourceCandidateId').unknown(false);
const localDraftRequestSchema = financialRequestSchema.keys({requestId:Joi.string().guid({version:'uuidv4'}).required()});
module.exports = { validate, requestSchema, ocrRequestSchema, validateTool, todayShanghai, draftEditSchema, draftActionSchema, commitSchema,
  financialRequestSchema,localDraftRequestSchema };
