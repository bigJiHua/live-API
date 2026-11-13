const Joi = require('joi');
const { AiError } = require('./errors');
const { DOMAINS, validateScope } = require('./businessRead');
const { validate } = require('./validation');
const { RESOLUTIONS, TEMPORAL_DATASETS } = require('./largeQuery');
const { CARD_TYPES, filterCandidateRows } = require('./candidateSelection');
const { DATASETS, SORTS, getDatasetCapability, assertDatasetCapabilities, CHOICE_GROUPS, CHOICE_GROUP_ENUM, CHOICE_SOURCE_DATASETS } = require('./datasetCapabilities');
assertDatasetCapabilities({ choiceGroups: CHOICE_GROUPS, domains: DOMAINS });
const date = Joi.string().pattern(/^20\d{2}-\d{2}-\d{2}$/);
const schemas = {
  list_choices: Joi.object({ domain: Joi.string().valid(...DOMAINS).required(),
    group: Joi.string().valid(...CHOICE_GROUP_ENUM).allow(null),
    bankName: Joi.string().max(80).allow('', null), cardType: Joi.string().valid(...CARD_TYPES).allow(null),
    direction: Joi.string().valid('income', 'expense', 'both').allow(null),
    filter: Joi.string().max(80).allow('', null), limit: Joi.number().integer().min(1).max(50) }).unknown(false),
  query_data: Joi.object({ datasetId: Joi.string().valid(...Object.keys(DATASETS)).required(),
    startDate: date, endDate: date, filter: Joi.string().max(80).allow('', null),
    direction: Joi.string().valid('income', 'expense', 'both'), sort: Joi.string().valid(...SORTS),
    groupBy: Joi.string().valid('card', 'cardMonth'),
    cardTypes: Joi.array().items(Joi.string().valid(...CARD_TYPES)).min(1).max(CARD_TYPES.length).unique(),
    resolution: Joi.string().valid(...RESOLUTIONS), cursor: Joi.string().max(2048).pattern(/^lq1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
    limit: Joi.number().integer().min(1).max(50) }).unknown(false),
};
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const definitions = [
  tool('list_choices', '只读候选，用于语义归类和选择真实引用。记普通收支用finance，含cards与categories。cards保留name、bankName、cardType、tail；按银行用bankName，按信用卡/借记卡用cardType，分类按收支用direction。filter只按名称中的字面片段匹配，不是语义搜索；不要用filter=支出代替分类方向。可用group缩小候选，不查询余额或流水。',
    { domain: { type: 'string', enum: DOMAINS }, group: { type: ['string', 'null'], enum: [...CHOICE_GROUP_ENUM, null] },
      bankName: { type: ['string', 'null'], maxLength: 80 }, cardType: { type: ['string', 'null'], enum: [...CARD_TYPES, null] },
      direction: { type: ['string', 'null'], enum: ['income', 'expense', 'both', null] },
      filter: { type: ['string', 'null'], maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['domain']),
  tool('query_data', '只读获取本人指定一个数据集；本工具不生成图表，不接收chart、xKey、yKeys等绘图字段。数据返回后，查询/操作模式可在最终答复JSON顶层chart引用本次queryMeta.queryId和columns.key生成业务图表；闲聊与分析模式的业务图表由应用按取数结果生成。用户要求正文画图时，所有模式均可在Markdown答复中输出mermaid代码块，数值图使用xychart-beta或pie，明确数字来自本轮取数、用户提供或假设示例；正文图属于模型生成内容，不替代真实业务数据。不要为绘图重复取数。finance-monthly为已有收支总计/逐月汇总，已含绘图所需列（xKey=month，yKeys可选income/expense/count），走势图/折线图/趋势图通常用它即可；同一问题需要其他粒度或比较时允许补查；finance-categories为分类汇总（首笔/末笔日期仅说明发生范围，不能决定最大金额日期）；finance-transactions为有限明细（默认按日期倒序，filter与direction先在SQL筛选，再计数和排序；最大单笔用direction=expense、sort=amountDesc，首行就是全范围已定价最大支出），finance-daily为每日收支汇总（支出最多哪天用direction=expense、sort=expenseDesc），筛选后的全量计数与汇总不受明细limit影响；account-balances仅保存余额；card-cards为卡片清单与基础设置（别名/卡类型/账单日/还款日/额度/共享池，问「有哪些卡」「卡片清单」「别名」也用它，清单与设置同属此数据集；信用卡已按下次配置还款日升序排在前，问「哪张最近到期/快该还款」直接看前几行），card-counts卡片数量（cardTypes可只取credit/debit，服务器给筛选后totalCount、每类sharePct及较大数量/较小数量ratio、approximateRatio和对应类型），card-monthlyConsumption按卡月消费（含信用卡/借记卡/现金类型，问信用卡直接用它，服务端会按用户原话收窄卡类型并重算合计，不要用filter筛类型，有类型信息就不必再取card-cards），card-bills账单快照（含本期账单/待还/已还金额与还款状态，问「哪张有欠款/该还多少/账单金额」用它），card-repayments还款历史，card-pools共享池；budget-plans预算；todo-events日程；work-salary工资登记历史（按日期范围查询）、work-rules目前保存工资规则（没有历史快照）；asset-*资产；fixedAsset-saved固定资产；fund-*基金；installment-plans分期。根据原话选择必要数据；数据充分就停止，不足允许补查；可指定日期和文本filter。不得用明细分页自行合计。每个数据集的queryMeta含requestedScope/effectiveScope、matchedRowCount/returnedRowCount/sourceRecordCount与rowsComplete/summaryComplete/rankingComplete；totalCount兼容字段等于matchedRowCount，未知为null。月份行和分类组不等于流水笔数，expenseCount才是支出笔数。金额排序在SQL全量筛选后进行，rankingComplete=true时明细即使截取仍能确定第一名；未定价记录存在时只限定为已定价范围。',
    { datasetId: { type: 'string', enum: Object.keys(DATASETS) }, startDate: { type: 'string', description: 'YYYY-MM-DD，单次范围最多12个月' },
      endDate: { type: 'string', description: 'YYYY-MM-DD；收支/工资/收益历史不能晚于今天；待办和预算可未来' },
      filter: { type: ['string', 'null'], maxLength: 80 }, direction: { type: 'string', enum: ['income', 'expense', 'both'],
        description: 'finance-*可筛收入/支出；card-monthlyConsumption仅消费支出，可省略或expense，both也仅表示该数据集全部支出；不支持income。其它数据集省略。' },
      groupBy: { type: 'string', enum: ['card', 'cardMonth'],
        description: '仅card-monthlyConsumption：默认cardMonth每行一张卡一个月；跨月问哪张卡累计支出最高/卡片消费占比用card，SQL按整个日期范围每卡合计再排序，sort=amountDesc。月度走势用cardMonth。' },
      cardTypes: { type: 'array', items: { type: 'string', enum: CARD_TYPES }, minItems: 1, maxItems: CARD_TYPES.length, uniqueItems: true,
        description: 'card-counts与card-monthlyConsumption可按卡类型筛选；全部/所有卡片须省略cardTypes以包含虚拟账户。仅明确信用卡和借记卡两类型合计/占比时用[credit,debit]，该分母不包含虚拟账户。' },
      sort: { type: 'string', enum: SORTS,
        description: 'card-monthlyConsumption支持amountDesc/expenseDesc/dateDesc；跨月累计第一名必须搭配groupBy=card。' },
      resolution: { type: 'string', enum: [...RESOLUTIONS] }, cursor: { type: 'string', maxLength: 2048 },
      limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['datasetId']),
];
const emptyChoices = () => ({ cards: [], categories: [], funds: [], todos: [], fixedAssets: [], moods: [] });

function toolArgumentError(message, input, paths, rule) {
  const error = new AiError(message, 400, 'AI_TOOL_ARGUMENT_INVALID');
  Object.defineProperty(error, 'validationDiagnostic', { value: { stage: 'tool-arguments', truncated: false,
    issues: paths.map(path => ({ path, rule, message,
      actualType: input?.[path] === null ? 'null' : Array.isArray(input?.[path]) ? 'array' : typeof input?.[path] })) } });
  return error;
}

function validateTool(name, args, today) {
  if (!Object.hasOwn(schemas, name)) throw new AiError('模型选择了未开放能力', 403, 'AI_TOOL_DENIED');
  // A numeric text filter is a transport representation of the same bounded
  // literal (for example a card alias containing 1111), never SQL or an ID.
  const input = args && typeof args === 'object' && !Array.isArray(args) &&
    typeof args.filter === 'number' && Number.isFinite(args.filter) && Math.abs(args.filter) <= Number.MAX_SAFE_INTEGER
    ? { ...args, filter: String(args.filter) } : args;
  let value;
  try { value = { ...validate(schemas[name], input) }; }
  catch (error) {
    const details = schemas[name].validate(input, { abortEarly: false, convert: false }).error?.details || [];
    Object.defineProperty(error, 'validationDiagnostic', { value: { stage: 'tool-arguments', truncated: details.length > 20,
      issues: details.slice(0, 20).map(detail => ({ path: detail.path.join('.') || '$', rule: detail.type,
        message: detail.type === 'object.unknown' ? '工具参数字段未开放' : '工具参数不符合允许格式',
        actualType: typeof detail.path.reduce((current, key) => current?.[key], input) })) } });
    throw error;
  }
  const domain = name === 'query_data' ? DATASETS[value.datasetId] : value.domain;
  const capability = name === 'query_data' ? getDatasetCapability(value.datasetId) : null;
  if (name === 'list_choices' && value.group && !CHOICE_GROUPS[domain].includes(value.group)) throw new AiError('候选类型不属于所选业务域', 400, 'AI_TOOL_ARGUMENT_INVALID');
  if (name === 'list_choices' && (value.bankName || value.cardType) && !CHOICE_GROUPS[domain].includes('cards')) throw new AiError('所选业务域不支持银行或卡类型筛选', 400, 'AI_TOOL_ARGUMENT_INVALID');
  if (name === 'list_choices' && value.direction && !CHOICE_GROUPS[domain].includes('categories')) throw new AiError('所选业务域不支持分类收支方向筛选', 400, 'AI_TOOL_ARGUMENT_INVALID');
  if (capability && value.cardTypes && !capability.acceptedArgs.cardTypes) throw toolArgumentError('此数据集不支持卡类型筛选', value, ['cardTypes'], 'dataset.cardTypes');
  if (capability && value.groupBy && !capability.acceptedArgs.groupings.includes(value.groupBy)) throw toolArgumentError('此数据集不支持指定的统计粒度', value, ['groupBy'], 'dataset.groupBy');
  if (capability?.normalization.direction) {
    if (value.direction && !capability.acceptedArgs.directions.includes(value.direction)) throw toolArgumentError('卡消费数据集只提供支出，收入请查询收支数据集', value, ['direction'], 'dataset.direction');
    value.direction = capability.normalization.direction;
    value.groupBy ||= capability.defaults.groupBy;
  }
  const requestedScope = { domains: [domain], startDate: name === 'query_data' ? value.startDate || `${today.slice(0, 7)}-01` : today,
    endDate: name === 'query_data' ? value.endDate || today : today };
  const validCalendar = text => Number.isFinite(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
  if (!validCalendar(requestedScope.startDate) || !validCalendar(requestedScope.endDate) || requestedScope.startDate > requestedScope.endDate) throw new AiError('查询日期必须真实有效，开始日期不能晚于结束日期', 400, 'AI_SCOPE_INVALID');
  const scopeInput = { ...requestedScope };
  let queryNotice;
  if (capability?.datePolicy.historyThroughToday) {
    if (scopeInput.startDate > today) throw new AiError('历史数据查询不能从未来日期开始', 400, 'AI_SCOPE_INVALID');
    if (scopeInput.endDate > today) {
      queryNotice = { requestedEndDate: scopeInput.endDate, effectiveEndDate: today, reason: 'history-through-today' };
      scopeInput.endDate = today;
    }
  }
  if (name === 'query_data' && ['month', 'year'].includes(value.resolution) && !TEMPORAL_DATASETS.includes(value.datasetId))
    throw toolArgumentError('此数据集不支持时间聚合', value, ['resolution'], 'dataset.resolution');
  const scope = validateScope(scopeInput, new Date(`${today}T00:00:00+08:00`));
  if (name === 'query_data' && domain !== 'finance') {
    const badDirection = value.direction && !capability.acceptedArgs.directions.includes(value.direction);
    const badSort = value.sort && !capability.acceptedArgs.sorts.includes(value.sort);
    if (badDirection || badSort) throw toolArgumentError('此数据集不支持收支方向或金额排序', value,
      [...(badDirection ? ['direction'] : []), ...(badSort ? ['sort'] : [])], 'dataset.capability');
  }
  return { ...value, domain, scope, requestedScope: { startDate: requestedScope.startDate, endDate: requestedScope.endDate },
    limit: value.limit || (name === 'query_data' ? 20 : 30), filter: value.filter || '',
    ...(name === 'query_data' ? { limitExplicit: Object.hasOwn(input, 'limit') } : {}), ...(queryNotice ? { queryNotice } : {}) };
}
// A complete filtered result may still carry a server-authored subtotal; the
// model never sums. Datasets opt in by declaring aggregates in the read layer.
function summarizeFiltered(rows, aggregates) {
  const summary = {};
  for (const [key, spec] of Object.entries(aggregates || {})) {
    if (!spec || typeof spec.column !== 'string') continue;
    if (spec.kind === 'money') {
      const cents = rows.reduce((total, row) => {
        const text = String(row[spec.column] ?? '0'), match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
        if (!match) throw new AiError('金额汇总须使用已定价人民币分值', 503, 'AI_READ_INVALID_AMOUNT');
        return total + (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1n : 1n);
      }, 0n);
      const absolute = (cents < 0n ? -cents : cents).toString().padStart(3, '0');
      summary[key] = `${cents < 0n ? '-' : ''}${absolute.slice(0, -2)}.${absolute.slice(-2)}`;
    }
    else summary[key] = rows.reduce((total, row) => total + Number(row[spec.column] || 0), 0);
  }
  if (rows.some(row => Number(row.unpricedCount || 0) > 0)) summary.incomplete = true;
  return summary;
}
const CARD_TYPE_MENTIONS = [['信用卡', /信用卡|贷记卡/], ['借记卡', /借记卡|储蓄卡/],
  ['虚拟余额', /虚拟余额/], ['现金', /现金/]];
const CARD_TYPE_LABELS = new Set(CARD_TYPE_MENTIONS.map(([label]) => label));
// 用户明确只问一种卡类型时，由服务端收窄数据集并重算合计；
// 同时提到两种类型（信用卡和现金）或点名了具体卡片时保留原查询。
function requestedCardType(message, cards = []) {
  const text = String(message || '');
  if (/(?:不是|非|不含|除了|除去|不包括)\s*(?:信用卡|贷记卡|借记卡|储蓄卡|虚拟余额|现金)/.test(text)) return '';
  const labels = CARD_TYPE_MENTIONS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  if (labels.length !== 1) return '';
  // 具体卡片已在 SQL 层按别名收窄；再叠加类型会把它扩成同类全部卡片。
  if ((cards || []).some(card => card?.name && text.includes(card.name))) return '';
  return labels[0];
}
function selectSnapshot(name, args, raw, options = {}) {
  const choices = emptyChoices();
  if (name === 'list_choices') {
    for (const group of args.group ? [args.group] : CHOICE_GROUPS[args.domain]) {
      const rows = raw.choices?.[group] || [];
      choices[group] = filterCandidateRows(group, rows, args).slice(0, args.limit);
    }
    const selected = { scope: args.scope, datasets: [], choices, asOf: raw.asOf };
    return { ...selected, choiceCoverage: choiceCoverage(args, raw, selected) };
  }
  const original = raw.datasets.find(item => item.datasetId === args.datasetId);
  if (!original) throw new AiError('请求数据集暂不可用', 503, 'AI_DATASET_UNAVAILABLE');
  // Finance's dedicated read path filters/counts/sorts before LIMIT in SQL.
  if (original.queryMeta) return { scope: args.scope, datasets: [queryDisplayDataset(original)], choices, asOf: raw.asOf };
  if (args.datasetId === 'card-counts') return { scope: args.scope, datasets: [cardCountDataset(original, args)], choices, asOf: raw.asOf };
  if (args.datasetId === 'card-monthlyConsumption' && original.cardMonthlyQuery)
    return { scope: args.scope, datasets: [cardMonthlyDataset(original, args)], choices, asOf: raw.asOf };
  // 卡月消费：用户只问一种类型时在服务端截断，模型拿不到其它类型的行和合计。
  const cardType = args.datasetId === 'card-monthlyConsumption' ? (options.cardType || '') : '';
  let baseRows = cardType ? original.rows.filter(row => row.type === cardType) : original.rows;
  if (args.cardTypes?.length) baseRows = baseRows.filter(row => args.cardTypes.some(type => CARD_DISPLAY_TYPES[type] === row.type || type === row.cardType));
  if (args.datasetId === 'card-monthlyConsumption' && getDatasetCapability(args.datasetId).acceptedArgs.rankingSorts.includes(args.sort))
    baseRows = [...baseRows].sort(compareCardAmounts);
  const withCurrency = summary => ({ ...(original.summary?.currency ? { currency: original.summary.currency } : {}), ...summary });
  const baseSummary = (cardType || args.cardTypes?.length) && original.aggregates && !original.truncated
    ? withCurrency(summarizeFiltered(baseRows, original.aggregates)) : original.summary;
  const typePolicy = cardType ? ` 本结果仅统计${cardType}消费。` : '';
  // 类型筛选由服务端按原话决定；模型传入的类型文本 filter 不再二次生效。
  const filterText = cardType && CARD_TYPE_LABELS.has(args.filter) ? '' : args.filter;
  const needle = filterText.toLocaleLowerCase();
  // Filtering narrows already owner-bound server rows; the model never controls SQL text or joins.
  const textColumns = original.columns.filter(column => column.type === 'text').map(column => column.key);
  const fullRange = original.fullRangeQuery;
  const sqlFiltered = fullRange && fullRange.filter === filterText && Number.isSafeInteger(fullRange.matchedRowCount)
    && fullRange.matchedRowCount >= baseRows.length;
  const rows = sqlFiltered ? baseRows : baseRows.filter(row => !needle || textColumns.some(key => String(row[key] || '').toLocaleLowerCase().includes(needle)));
  const limited = rows.length > args.limit;
  const filteredSummary = needle && !limited && !original.truncated && original.aggregates
    ? withCurrency(summarizeFiltered(rows, original.aggregates)) : null;
  const summary = filteredSummary || (needle ? {} : baseSummary);
  const dataset = { ...original, rows: rows.slice(0, args.limit), truncated: original.truncated || limited,
    totalCount: sqlFiltered ? fullRange.matchedRowCount : original.truncated ? null : rows.length,
    ...(needle || cardType || args.cardTypes?.length ? { summary,
      policy: `${original.policy}${typePolicy}${needle ? ` 本结果按文本筛选，仅代表${filteredSummary ? '匹配行，合计为匹配行的合计' : '已返回匹配行，不是全量统计'}。` : ''}`,
      userPolicy: `${original.userPolicy || ''}${needle ? ` 本结果按文本筛选，仅代表${filteredSummary ? '匹配行，合计为匹配行的合计' : '已返回匹配行'}。` : ''}`.trim() } : {}) };
  if (limited || original.truncated) {
    dataset.policy = `${dataset.policy} ${sqlFiltered ? `匹配共 ${fullRange.matchedRowCount}` : original.truncated ? `已读取窗口 ${rows.length}` : `共 ${rows.length}`} 行，本次返回前 ${Math.min(rows.length, args.limit)} 行（单次上限 50 行），不代表全部记录；不要把结果称作「全部流水」。`;
  }
  const dateSemantics = getDatasetCapability(args.datasetId)?.datePolicy.semantics;
  if (dateSemantics === 'saved-state') dataset.policy = `${dataset.policy} 本数据集是目前已保存状态，查询日期不用于历史时点重建；不能将这些值描述为${args.scope.startDate}至${args.scope.endDate}当时的状态。`;
  if (dateSemantics === 'mixed-plan-state') dataset.policy = `${dataset.policy} 计划清单是目前已保存配置；日期仅限定期次状态计数，不证明这段时间历史配置或实际消费。`;
  if (args.queryNotice?.effectiveEndDate) {
    dataset.policy = `${dataset.policy} 历史查询已截至今天${args.queryNotice.effectiveEndDate}，未包含未来日期。`;
    if (dataset.userPolicy) dataset.userPolicy = `${dataset.userPolicy} 历史查询已截至今天${args.queryNotice.effectiveEndDate}，未包含未来日期。`;
  }
  if (args.queryNotice?.rangeIncomplete) {
    dataset.summary = { ...dataset.summary, incomplete: true };
    dataset.policy = `${dataset.policy} 查询范围已缩短为${args.scope.startDate}至${args.scope.endDate}，较早历史未返回，不代表完整历史总额。`;
  }
  // A trend request already has everything it needs in this one dataset.
  // Telling the model that in the tool result prevents repeated/empty
  // query_data calls that end the whole round with AI_LOOP_BLOCKED.
  if (args.datasetId === 'finance-monthly') {
    dataset.policy = `${dataset.policy} 本数据集已含绘图所需列（xKey=month，yKeys 可选 income/expense/count），走势图直接用本数据集即可，不必再取第二个数据集。`;
  }
  if (args.queryId) {
    const matchedRowCount = sqlFiltered ? fullRange.matchedRowCount : original.truncated ? null : rows.length;
    const known = matchedRowCount !== null;
    const summaryHasFacts = ['income', 'expense', 'count', 'totalCount', 'incomeCount', 'expenseCount'].some(key =>
      summary?.[key] != null && /^-?\d+(?:\.\d+)?$/.test(String(summary[key])));
    const dates = dataset.rows.map(row => row.date).filter(value => /^20\d{2}-\d{2}-\d{2}$/.test(value || '')).sort();
    dataset.queryMeta = { version: 1, queryId: args.queryId, datasetId: args.datasetId,
      requestedScope: args.requestedScope || { startDate: args.scope.startDate, endDate: args.scope.endDate },
      effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate },
      filters: { direction: args.direction || 'both', text: filterText,
        ...(args.cardTypes?.length ? { cardTypes: [...args.cardTypes] } : {}) },
      sort: args.sort || getDatasetCapability(args.datasetId)?.defaults.sort || 'dateDesc',
      matchedRowCount, returnedRowCount: dataset.rows.length,
      sourceRecordCount: args.datasetId === 'asset-composition' && sqlFiltered && Number.isSafeInteger(fullRange.sourceRecordCount)
        ? fullRange.sourceRecordCount
        : !needle && Number.isSafeInteger(Number(original.summary?.count)) ? Number(original.summary.count) : null,
      rowsComplete: known && matchedRowCount === dataset.rows.length,
      summaryComplete: summaryHasFacts && summary?.incomplete !== true && summary?.currency !== 'unverified'
        && (!needle || Boolean(filteredSummary)),
      rankingComplete: false, returnedDateRange: dates.length ? { startDate: dates[0], endDate: dates.at(-1) } : null,
      asOf: original.asOf || raw.asOf };
  }
  return { scope: args.scope, datasets: [queryDisplayDataset(dataset)], choices, asOf: raw.asOf };
}
function queryDisplayDataset(dataset) {
  if (dataset.datasetId !== 'finance-transactions') return dataset;
  // Finance detail queries display values; transactions cannot be write targets.
  // Candidate references are obtained through list_choices when making a draft.
  // Avoid sending three unused identity refs per row in a 50-row query.
  return { ...dataset, rows: dataset.rows.map(row => Object.fromEntries(
    dataset.columns.map(column => [column.key, row[column.key]]))) };
}
function choiceCoverage(args, raw, selected) {
  const result = {};
  for (const group of args.group ? [args.group] : CHOICE_GROUPS[args.domain]) {
    const total = filterCandidateRows(group, raw.choices?.[group] || [], args).length;
    const sourceId = CHOICE_SOURCE_DATASETS[group];
    const sourceIncomplete = sourceId && raw.datasets?.some(dataset => dataset.datasetId === sourceId && dataset.truncated === true);
    result[group] = { total: sourceIncomplete ? null : total, returned: selected.choices[group]?.length || 0,
      truncated: Boolean(sourceIncomplete) || total > (selected.choices[group]?.length || 0) };
  }
  return result;
}
const CARD_DISPLAY_TYPES = { credit: '信用卡', debit: '借记卡', virtual_cash: '现金', virtual_balance: '虚拟余额', virtual_wechat: '微信', virtual_alipay: '支付宝' };
function compareCardAmounts(left, right) {
  if (left.amountCNY == null) return right.amountCNY == null ? 0 : 1;
  if (right.amountCNY == null) return -1;
  const value = row => {
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(row.amountCNY));
    if (!match) throw new AiError('卡消费排序须使用已定价人民币金额', 503, 'AI_READ_INVALID_AMOUNT');
    return (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1n : 1n);
  };
  const difference = value(right) - value(left);
  return difference > 0n ? 1 : difference < 0n ? -1 : String(left.month || '').localeCompare(String(right.month || ''));
}
function attachCardQueryMeta(dataset, args, facts) {
  if (!args.queryId) return dataset;
  dataset.queryMeta = { version: 1, queryId: args.queryId, datasetId: dataset.datasetId,
    requestedScope: args.requestedScope || { startDate: args.scope.startDate, endDate: args.scope.endDate },
    effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate },
    filters: { direction: facts.direction || 'both', text: facts.filter || '',
      ...(args.cardTypes?.length ? { cardTypes: [...args.cardTypes] } : {}) }, sort: facts.sort || 'dateDesc',
    ...(facts.groupBy ? { groupBy: facts.groupBy } : {}),
    matchedRowCount: facts.matchedRowCount, returnedRowCount: dataset.rows.length,
    sourceRecordCount: facts.sourceRecordCount, rowsComplete: facts.matchedRowCount === dataset.rows.length,
    summaryComplete: facts.summaryComplete, rankingComplete: facts.rankingComplete,
    returnedDateRange: null, asOf: dataset.asOf };
  dataset.totalCount = facts.matchedRowCount;
  return dataset;
}
function cardCountDataset(original, args) {
  const needle = (args.filter || '').toLocaleLowerCase();
  const filtered = original.rows.filter(row => (!args.cardTypes?.length || args.cardTypes.includes(row.cardType || row.type)) &&
    (!needle || String(row.type || '').toLocaleLowerCase().includes(needle) || (CARD_DISPLAY_TYPES[row.type] || '').includes(needle)));
  const totalCount = filtered.reduce((total, row) => total + Number(row.count || 0), 0);
  const rows = filtered.map(row => {
    const count = BigInt(row.count || 0), denominator = BigInt(totalCount);
    const tenths = denominator ? (count * 1000n + denominator / 2n) / denominator : null;
    return { ...row, type: CARD_DISPLAY_TYPES[row.type] || row.type, cardType: row.cardType || row.type,
      sharePct: tenths == null ? null : `${tenths / 10n}.${tenths % 10n}` };
  });
  const columns = [...original.columns.filter(column => !['cardType', 'sharePct'].includes(column.key)),
    { key: 'sharePct', label: '卡片数量占比(%)', type: 'decimal' }];
  const ratioFacts = {};
  if (!original.truncated && rows.length === 2 && rows.every(row => Number(row.count) > 0)) {
    const ordered = [...rows].sort((left, right) => Number(right.count) - Number(left.count));
    const numerator = BigInt(ordered[0].count), denominator = BigInt(ordered[1].count);
    const hundredths = (numerator * 100n + denominator / 2n) / denominator;
    ratioFacts.ratio = `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
    ratioFacts.approximateRatio = Number((numerator + denominator / 2n) / denominator);
    ratioFacts.ratioNumeratorType = ordered[0].type;
    ratioFacts.ratioDenominatorType = ordered[1].type;
  }
  return attachCardQueryMeta({ ...original, columns, rows: rows.slice(0, args.limit), truncated: original.truncated || rows.length > args.limit,
    summary: { count: totalCount, totalCount, ...ratioFacts },
    policy: `${original.policy} 本次只统计所选卡类型，合计与占比使用筛选后的全部卡片数量。`,
    userPolicy: `${original.userPolicy || ''} 本次只统计所选卡类型，合计与占比使用筛选后的全部卡片数量。`.trim() }, args,
  { matchedRowCount: original.truncated ? null : rows.length, sourceRecordCount: original.truncated ? null : totalCount,
    summaryComplete: !original.truncated, rankingComplete: false, filter: args.filter || '', sort: 'dateDesc' });
}
function cardMonthlyDataset(original, args) {
  const facts = original.cardMonthlyQuery;
  const { cardMonthlyQuery, ...dataset } = original;
  dataset.rows = original.rows.slice(0, args.limit);
  dataset.truncated = facts.matchedRowCount > dataset.rows.length;
  return attachCardQueryMeta(dataset, args, { matchedRowCount: facts.matchedRowCount,
    sourceRecordCount: Number(facts.summary.count), summaryComplete: true,
    rankingComplete: getDatasetCapability(original.datasetId).effectiveMeta.rankingSorts.includes(facts.sort) && !Number(facts.summary.unpricedCount),
    filter: facts.filter, sort: facts.sort, direction: getDatasetCapability(original.datasetId).normalization.direction,
    groupBy: facts.groupBy || getDatasetCapability(original.datasetId).defaults.groupBy });
}
module.exports = { DATASETS, CHOICE_GROUPS, definitions, validateTool, selectSnapshot, choiceCoverage, emptyChoices, requestedCardType };
