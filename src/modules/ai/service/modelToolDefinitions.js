const { DATASET_CAPABILITIES } = require('./datasetCapabilities');
const { CARD_TYPES } = require('./candidateSelection');
const { filterDescription } = require('./queryFilterSemantics');
const { TEMPORAL_DATASETS } = require('./largeQuery');

// These labels explain dataset meaning. Parameter permission and normalization
// come only from the capability registry; readers retain execution authority.
const DATASET_DESCRIPTIONS = Object.freeze({
  'finance-monthly': '全范围收支与逐月汇总；收支总额和月图使用month/income/expense/count，不用明细拼合计。',
  'finance-categories': '全范围分类汇总；首末日期只说明分类发生范围，不能代表最大单笔日期。',
  'finance-transactions': '有限逐笔明细；SQL先筛选全范围再计数排序。最大单笔用direction=expense、sort=amountDesc。',
  'finance-daily': '全范围逐日收支；支出最多一天用direction=expense、sort=expenseDesc；收入最多一天用direction=income、sort=incomeDesc。',
  'account-balances': '逐账户已保存余额明细；全量按账户类型与币种的资产组成汇总使用asset-composition。',
  'card-cards': '卡片清单、别名和基础设置；信用卡按下次配置还款日排序，不代表实际欠款。',
  'card-counts': '本人卡片数量；cardTypes筛类型，totalCount/sharePct/ratio是服务端派生数量事实。',
  'card-monthlyConsumption': '仅消费支出。区间累计排名用groupBy=card、sort=amountDesc；逐卡月走势用cardMonth/dateDesc。类型用cardTypes。',
  'card-bills': '已保存账单、待还与已还快照；不等于消费流水。',
  'card-repayments': '本人信用卡还款历史。',
  'card-pools': '信用卡共享额度池；不可逐卡相加共享额度。',
  'budget-plans': '预算计划及已登记使用情况，不是实际完整消费。',
  'todo-events': '本人日程与待办，可查未来日期。',
  'work-salary': '本人已保存工资历史。',
  'work-rules': '本人工作与薪资规则。',
  'asset-snapshots': '本人已保存资产历史快照。',
  'asset-registers': '本人资产登记项目。',
  'asset-composition': '全量已保存账户余额按账户类型与币种聚合；返回type/currency/positiveAssets/creditDebt/creditOverflow/otherDebt/count/missingSnapshots。账户类型及币种的资产组成、构成和组成图使用此数据集；结果行是分组，count是该组账户数，不能从limit后的账户余额明细拼全量组成。',
  'asset-comparison': '本人登记资产与系统计算资产的比较。',
  'fixedAsset-saved': '本人固定资产保存值与折旧登记。',
  'fund-holdings': '本人基金持仓。',
  'fund-history': '本人基金历史收益与资金变动。',
  'installment-plans': '本人已保存分期计划与待入账状态。',
});
const copy = value => JSON.parse(JSON.stringify(value));
const values = enumValues => ({ type: 'string', enum: [...enumValues] });
const date = () => ({ type: 'string', pattern: '^20\\d{2}-\\d{2}-\\d{2}$',
  description: 'YYYY-MM-DD；保留完整请求范围，最多十年。finance/work/fund及卡消费历史截至今天；待办、预算等可查询未来日期。' });
const text = () => ({ type: ['string', 'null'], maxLength: 80, description: '名称或备注的字面子串；不是SQL或语义搜索。' });

function modelSorts(entry) {
  const allowed = entry.acceptedArgs.readerSorts.length ? entry.acceptedArgs.readerSorts : entry.acceptedArgs.sorts;
  // amountDesc and expenseDesc are aliases for card consumption. Expose one
  // canonical alias there while preserving expenseDesc for daily expenses.
  return entry.effectiveMeta.canonicalSorts.filter(sort => allowed.includes(sort)
    && !(sort === 'expenseDesc' && allowed.includes('amountDesc')));
}
function datasetBranch(datasetId, entry) {
  // Common value constraints live in the outer object. Empty schemas here
  // declare a field's applicability without repeating dates/text/limits 23 times.
  const properties = { datasetId: values([datasetId]), startDate: {}, endDate: {}, limit: {}, cursor: {} };
  properties.resolution = values(TEMPORAL_DATASETS.includes(datasetId) ? ['auto', 'detail', 'month', 'year'] : ['auto', 'detail']);
  if (entry.acceptedArgs.filter.reader) properties.filter = { description: filterDescription(datasetId) };
  // The server fixes card consumption to expense. No direction field is
  // published in that branch, although finance branches retain direction.
  if (!entry.normalization.direction && entry.acceptedArgs.directions.length)
    properties.direction = values(entry.acceptedArgs.directions);
  const sorts = modelSorts(entry);
  if (sorts.length) properties.sort = values(sorts);
  if (entry.acceptedArgs.groupings.length) properties.groupBy = { ...values(entry.acceptedArgs.groupings),
    description: 'card为整段日期每卡合计；cardMonth为每卡每月，月图用cardMonth。' };
  if (entry.acceptedArgs.cardTypes) properties.cardTypes = {};
  const datePolicy = entry.datePolicy.semantics === 'saved-state'
    ? '读取目前已保存状态；startDate/endDate不会筛出或重建该历史时点的余额、配置、清单或持仓。若问过去当时状态，须明确无法凭此证明。'
    : entry.datePolicy.semantics === 'mixed-plan-state'
      ? '计划清单为目前保存状态，不重建历史计划；startDate/endDate仅筛选计划中的月度入账状态计数。'
      : entry.datePolicy.historyThroughToday ? '历史查询截至今天。' : '按所请求日期范围读取，可包括未来保存日程或计划。';
  return { type: 'object', description: `${DATASET_DESCRIPTIONS[datasetId]}${datePolicy}`, properties,
    required: ['datasetId'], additionalProperties: false };
}

// Preserve all dataset branches across subjects and followups. taskContext is
// a semantic hint, not permission to hide unrelated domains or a new topic.
function queryDataDefinition() {
  const anyOf = Object.entries(DATASET_CAPABILITIES).map(([id, entry]) => datasetBranch(id, entry));
  const properties = { datasetId: { ...values(Object.keys(DATASET_CAPABILITIES)), description: '本次只取一个数据集，按下方匹配分支使用参数。' },
    startDate: date(), endDate: date(), filter: text(),
    direction: { ...values(['income', 'expense', 'both']), description: '仅finance-*分支；卡消费省略direction。' },
    sort: { ...values([...new Set(anyOf.flatMap(branch => branch.properties.sort?.enum || []))]),
      description: '参数组合由datasetId分支限定；不要将其它数据集的排序带入当前查询。' },
    groupBy: { ...values(['card', 'cardMonth']), description: '仅card-monthlyConsumption分支。' },
    cardTypes: { type: 'array', items: values(CARD_TYPES), minItems: 1, maxItems: CARD_TYPES.length, uniqueItems: true,
      description: '仅card-counts与card-monthlyConsumption。' },
    resolution: { ...values(['auto', 'detail', 'month', 'year']), description: '统计/趋势使用auto，服务端选择月或年聚合；用户明确要原始明细或逐日极值用detail，明确月/年粒度用month/year。以返回queryMeta.resolution为准。' },
    cursor: { type: 'string', maxLength: 2048, description: '仅续查时复制上一结果queryMeta.page.nextCursor，同时保持原数据集、日期、筛选、排序和返回的resolution；不能编造或改写。' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: '只约束展示行，不限制全范围汇总；统计查询通常省略，服务端按聚合粒度选择容量。' } };
  return { type: 'function', function: { name: 'query_data',
    description: '只读本人一个数据集。datasetId决定允许参数，必须匹配parameters.anyOf中的一个分支；未在分支声明的参数省略。查询全范围汇总与排名以queryMeta为准，matchedRowCount/returnedRowCount/sourceRecordCount各有不同粒度；不足可补查，不重复取数或分页拼合计。',
    parameters: { type: 'object', properties, required: ['datasetId'], additionalProperties: false, anyOf } } };
}

function buildModelToolDefinitions(existingDefinitions) {
  if (!Array.isArray(existingDefinitions)) throw new TypeError('AI tool definitions must be an array');
  const queryCount = existingDefinitions.filter(definition => definition?.function?.name === 'query_data').length;
  if (queryCount !== 1) throw new Error('AI query_data definition must occur exactly once');
  return existingDefinitions.map(definition => definition?.function?.name === 'query_data' ? queryDataDefinition() : copy(definition));
}

module.exports = { buildModelToolDefinitions, queryDataDefinition };
