const { DATASET_CAPABILITIES, getDatasetCapability } = require('./datasetCapabilities');

// Reader-authored output aliases used for literal text matching. This bridge
// describes intent applicability; readers retain SQL and permission authority.
const FILTER_FIELDS = Object.freeze(Object.fromEntries(Object.entries(DATASET_CAPABILITIES)
  .map(([id, capability]) => [id, capability.acceptedArgs.filter.fields])));
const getFilterFields = datasetId => getDatasetCapability(datasetId)?.acceptedArgs.filter.fields || [];
const ENTITY_FIELDS = new Set(['name', 'company', 'title', 'content', 'remark', 'category', 'tag']);
const TYPE_VALUE = /^(?:credit|debit|virtual_balance|virtual_cash|信用卡|贷记卡|借记卡|储蓄卡|虚拟余额|现金|income|expense|收入|支出)$/i;
const STATUS_VALUE = /^(?:正常|挂失|注销|启用|停用|完成|未完成|待办|已完成|未还|已还|部分还款|active|inactive|pending|paid)$/i;
const CURRENCY_VALUE = /^(?:CNY|RMB|USD|HKD|EUR|GBP|JPY|AUD|CAD|SGD|CHF|NZD|人民币|美元|港币|欧元|日元)$/i;
const TOPIC_ONLY = /^(?:(?:本人|我的|当前|目前|现有|已保存|保存|登记|已登记|历史|系统|流动|净|全部|所有|资产|快照|组成|构成|比较|对比|账户|余额|卡片|银行卡|卡|信用|借记|银行|基金|持仓|收益|本金|市值|资金|变动|预算|计划|分期|日程|待办|工资|薪资|工作|规则|流水|清单|基础|设置|配置|明细|数量|类型|币种|统计|汇总|finance|account|asset|fund|cards?|holdings?|snapshots?|history|salary|todo|budget|installments?)\s*)+$/i;
const TIMESTAMP_FIELDS = new Set(['recordedAt', 'updatedAt', 'minUpdatedAt', 'maxUpdatedAt', 'date']);

function naturalFilterPermitted(datasetId, filter, { prefix = '', quoted = false } = {}) {
  const fields = getFilterFields(datasetId), value = String(filter || '').normalize('NFKC').trim();
  if (!fields.length || !value) return false;
  // Explicit positive text filtering is a predicate, even if its literal value
  // is also a topic word. Quoted/fenced examples and negations are checked by
  // the caller before they can reach this branch.
  if (/(?:筛选|过滤|只筛|仅筛|文本(?:里|中|内)?(?:字面)?包含|文字(?:里|中|内)?(?:字面)?包含)\s*$/.test(prefix)) return true;
  if (fields.some(field => TIMESTAMP_FIELDS.has(field))
    && /(?:保存时间|登记时间|保存日期|登记日期|recordedAt|updatedAt)(?:里|中|内)?\s*(?:(?:字面)?(?:包含|含有|匹配)|为|是)?\s*$/i.test(prefix)) return true;
  if (fields.includes('currency') && CURRENCY_VALUE.test(value)) return true;
  if (fields.includes('displayType') && TYPE_VALUE.test(value)) return true;
  if (fields.includes('type') && TYPE_VALUE.test(value) && /类型\s*(?:为|是|包含|匹配)?\s*$/.test(prefix)) return true;
  if (fields.some(field => ['status', 'repayStatus'].includes(field)) && STATUS_VALUE.test(value)
    && /状态\s*(?:为|是|包含|匹配)?\s*$/.test(prefix)) return true;
  if (!fields.some(field => ENTITY_FIELDS.has(field))) return false;
  // Explicitly named entities may themselves be named “资产” or “流动”. A
  // bare dataset title, date range, amount or structural noun is not an entity.
  if (quoted || /(?:名为|叫作|叫|名称(?:为|是))\s*$/.test(prefix)) return true;
  return !TOPIC_ONLY.test(value) && !/^[\d\s.,:/+%-]+$/.test(value);
}
function filterDescription(datasetId) {
  const fields = getFilterFields(datasetId);
  return fields.length ? `只对${fields.join('/')}列做字面文本匹配。filter只用于当前明确文字筛选、具名实体或合法延续筛选；数据集主题词不能当筛选。${fields.every(field => TIMESTAMP_FIELDS.has(field)) ? '本数据集没有可按名称搜索的字段；普通资产快照/登记查询省略filter。' : ''}` : '本数据集不支持文本筛选。';
}
module.exports = { FILTER_FIELDS, getFilterFields, naturalFilterPermitted, filterDescription };
