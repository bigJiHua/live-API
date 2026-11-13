// Independent compatibility contracts: expected values are handwritten or
// captured before the refactor, never derived from datasetCapabilities.
const fs = require('fs');
const path = require('path');
const { definitions, DATASETS, validateTool } = require('../../src/modules/ai/service/v3Tools');
const { prepareFinanceDatasetQuery } = require('../../src/modules/ai/service/financeDatasetRead');
const { validateQueryMeta } = require('../../src/modules/ai/service/queryMetadata');
const { sanitizeQueryCoverageResult } = require('../../src/modules/ai/service/queryContext');
const { DATASET_CAPABILITIES, assertDatasetCapabilities } = require('../../src/modules/ai/service/datasetCapabilities');
const before = require('../fixtures/aiDatasetBehaviorBefore.json');

const fixedDatasets = {
  'finance-monthly': 'finance', 'finance-categories': 'finance', 'finance-transactions': 'finance', 'finance-daily': 'finance',
  'account-balances': 'account', 'card-cards': 'card', 'card-counts': 'card', 'card-monthlyConsumption': 'card',
  'card-bills': 'card', 'card-repayments': 'card', 'card-pools': 'card', 'budget-plans': 'budget',
  'todo-events': 'todo', 'work-salary': 'work', 'work-rules': 'work', 'asset-snapshots': 'asset',
  'asset-registers': 'asset', 'asset-composition': 'asset', 'asset-comparison': 'asset',
  'fixedAsset-saved': 'fixedAsset', 'fund-holdings': 'fund', 'fund-history': 'fund', 'installment-plans': 'installment',
};
function resultOf(run) {
  try { return { ok: true, value: run() }; }
  catch (error) {
    return { ok: false, error: { code: error.code, status: error.status, message: error.message,
      ...(error.validationDiagnostic ? { validationDiagnostic: error.validationDiagnostic } : {}) } };
  }
}

test('legacy definitions preserve structure except incomeDesc and the explicit scope guidance', () => {
  const baseline = fs.readFileSync(path.join(__dirname, '../fixtures/aiDatasetDefinitionsBefore.json'), 'utf8');
  const compatible = structuredClone(definitions);
  const query = compatible.find(item => item.function.name === 'query_data').function;
  const oldQuery = JSON.parse(baseline).find(item => item.function.name === 'query_data').function;
  expect(query.description).toContain('work-salary工资登记历史（按日期范围查询）');
  expect(query.description).toContain('work-rules目前保存工资规则（没有历史快照）');
  expect(query.parameters.properties.cardTypes.description).toContain('全部/所有卡片须省略cardTypes以包含虚拟账户');
  query.description = oldQuery.description;
  expect(query.parameters.properties.resolution.enum).toEqual(['auto', 'detail', 'month', 'year']);
  expect(query.parameters.properties.cursor.maxLength).toBe(2048);
  delete query.parameters.properties.resolution;
  delete query.parameters.properties.cursor;
  query.parameters.properties.cardTypes.description = oldQuery.parameters.properties.cardTypes.description;
  const sorts = query.parameters.properties.sort.enum;
  expect(sorts.filter(sort => sort === 'incomeDesc')).toHaveLength(1);
  sorts.splice(sorts.indexOf('incomeDesc'), 1);
  expect(JSON.stringify(compatible)).toBe(baseline);
});
test('all 23 dataset domains and their insertion order retain the independent public contract', () => {
  expect(DATASETS).toEqual(fixedDatasets);
  expect(Object.keys(DATASETS)).toEqual(Object.keys(fixedDatasets));
});

test('date semantics distinguish saved state, windowed plan status and genuine date-range reads', () => {
  const saved = ['account-balances', 'card-cards', 'card-counts', 'card-pools', 'work-rules',
    'asset-composition', 'fixedAsset-saved', 'fund-holdings'];
  for (const [id, capability] of Object.entries(DATASET_CAPABILITIES)) {
    expect(capability.datePolicy.semantics).toBe(saved.includes(id) ? 'saved-state'
      : id === 'installment-plans' ? 'mixed-plan-state' : 'date-range');
  }
});
test('725 pre-refactor tool cases retain result JSON, error code/status/message and diagnostic', () => {
  for (const sample of before.toolCases) {
    const actual = resultOf(() => validateTool(sample.name, sample.args, before.today));
    if (actual.ok) delete actual.value.limitExplicit;
    if (sample.expected.value?.queryNotice?.reason === 'bounded-twelve-month-window') {
      expect(actual.value.scope).toMatchObject({ startDate: sample.args.startDate, endDate: sample.args.endDate });
      expect(actual.value.queryNotice).toBeUndefined();
      continue;
    }
    expect({ title: sample.title, actual }).toEqual({ title: sample.title, actual: sample.expected });
  }
});
test('384 pre-refactor finance reader cases retain result JSON and rejection behavior', () => {
  for (const sample of before.financeCases) {
    const actual = resultOf(() => prepareFinanceDatasetQuery(sample.args));
    if (actual.ok) { delete actual.value.resolution; delete actual.value.limitExplicit; delete actual.value.cursor; }
    expect({ args: sample.args, actual }).toEqual({ args: sample.args, actual: sample.expected });
  }
});
test.each(Object.entries(fixedDatasets))('%s keeps domain %s and tool-level omitted defaults', (datasetId, domain) => {
  const value = validateTool('query_data', { datasetId }, before.today);
  expect(value).toMatchObject({ datasetId, domain, limit: 20, filter: '',
    requestedScope: { startDate: '2026-11-01', endDate: '2026-11-09' },
    scope: { domains: [domain], startDate: '2026-11-01', endDate: '2026-11-09' } });
  expect(value.sort).toBeUndefined();
  if (datasetId === 'card-monthlyConsumption') expect(value).toMatchObject({ direction: 'expense', groupBy: 'cardMonth' });
  else { expect(value.direction).toBeUndefined(); expect(value.groupBy).toBeUndefined(); }
});
test.each([
  ['finance-monthly', ['dateDesc', 'monthAsc'], 'monthAsc'],
  ['finance-categories', ['dateDesc', 'amountDesc', 'categoryAmountDesc'], 'categoryAmountDesc'],
  ['finance-transactions', ['dateDesc', 'amountDesc'], null],
  ['finance-daily', ['dateDesc', 'expenseDesc', 'incomeDesc'], null],
])('%s keeps an independent finance sort matrix and reader-stage normalization', (datasetId, legalSorts, normalized) => {
  for (const sort of ['dateDesc', 'amountDesc', 'expenseDesc', 'incomeDesc', 'monthAsc', 'categoryAmountDesc']) {
    const input = { datasetId, sort, queryId: 'q_0123456789abcdef01234567' };
    // The tool deliberately accepts finance sorts before the reader applies
    // its dataset-specific guard. Stage A must not move this rejection.
    expect(validateTool('query_data', { datasetId, sort }, before.today).sort).toBe(sort);
    const read = resultOf(() => prepareFinanceDatasetQuery(input));
    if (legalSorts.includes(sort)) expect(read).toMatchObject({ ok: true, value: { sort: normalized || sort } });
    else expect(read).toMatchObject({ ok: false, error: { code: 'AI_TOOL_ARGUMENT_INVALID', status: 400,
      message: '查询筛选或排序参数无效' } });
  }
});
test('monthly nonempty text is still rejected in the reader rather than silently ignored or rejected early', () => {
  const args = validateTool('query_data', { datasetId: 'finance-monthly', filter: '购汇' }, before.today);
  expect(args.filter).toBe('购汇');
  expect(resultOf(() => prepareFinanceDatasetQuery(args))).toMatchObject({ ok: false,
    error: { code: 'AI_TOOL_ARGUMENT_INVALID', status: 400 } });
});
test.each(['direction', 'sort', 'groupBy', 'cardTypes'])('%s null retains its existing Joi error code and field diagnostic', field => {
  const actual = resultOf(() => validateTool('query_data', { datasetId: 'finance-monthly', [field]: null }, before.today));
  expect(actual).toMatchObject({ ok: false, error: { code: 'AI_INVALID_INPUT', status: 400,
    validationDiagnostic: { issues: expect.arrayContaining([expect.objectContaining({ path: field })]) } } });
});

const scope = { domains: ['card'], startDate: '2026-11-01', endDate: '2026-11-09' };
const range = { startDate: scope.startDate, endDate: scope.endDate };
const metaFor = datasetId => ({ version: 1, queryId: 'q_0123456789abcdef01234567', datasetId,
  requestedScope: range, effectiveScope: range, filters: { direction: 'both', text: '' }, sort: 'dateDesc',
  matchedRowCount: 0, returnedRowCount: 0, sourceRecordCount: 0, rowsComplete: true,
  summaryComplete: true, rankingComplete: false, returnedDateRange: null, asOf: '2026-11-09T00:00:00.000Z' });
test('card-counts input sort stays denied while its effective dateDesc metadata remains valid', () => {
  expect(resultOf(() => validateTool('query_data', { datasetId: 'card-counts', sort: 'dateDesc' }, before.today)))
    .toMatchObject({ ok: false, error: { code: 'AI_TOOL_ARGUMENT_INVALID' } });
  const meta = metaFor('card-counts');
  expect(validateQueryMeta(meta, { datasetId: 'card-counts', rows: [] }, scope)).toEqual(meta);
  expect(sanitizeQueryCoverageResult(meta)).toMatchObject({ datasetId: 'card-counts', sort: 'dateDesc' });
});
test('metadata and history retain their old global-sort compatibility independently of request allowlists', () => {
  for (const datasetId of ['card-counts', 'legacy-unregistered']) {
    for (const sort of ['dateDesc', 'amountDesc', 'expenseDesc', 'monthAsc', 'categoryAmountDesc']) {
      const meta = { ...metaFor(datasetId), sort };
      expect(validateQueryMeta(meta, { datasetId, rows: [] }, scope)).toEqual(meta);
      expect(sanitizeQueryCoverageResult(meta)).toMatchObject({ datasetId, sort });
    }
  }
});
test('empty historical cardTypes keeps coverage compatibility but cannot enter a new approved preview', () => {
  const meta = { ...metaFor('card-counts'), filters: { direction: 'both', text: '', cardTypes: [] } };
  expect(sanitizeQueryCoverageResult(meta)).toMatchObject({ filters: { cardTypes: [] } });
  expect(() => validateQueryMeta(meta, { datasetId: 'card-counts', rows: [] }, scope))
    .toThrow('查询范围或覆盖数量无效');
});
test('static self-check rejects malformed declarations instead of warning or reading runtime configuration', () => {
  const makeRegistry = () => structuredClone(DATASET_CAPABILITIES);
  const mutations = [
    registry => { delete registry['finance-monthly']; },
    registry => { registry['finance-monthly'].domain = 'wrong-domain'; },
    registry => { registry['finance-monthly'].acceptedArgs.sorts.push('unsupported-sort'); },
    registry => { registry['finance-monthly'].effectiveMeta.sorts.push('unsupported-sort'); },
    registry => { registry['card-monthlyConsumption'].acceptedArgs.groupings.push('user'); },
    registry => { registry['card-monthlyConsumption'].normalization.direction = 'invalid'; },
    registry => { registry['finance-monthly'].normalization.sort = 'amountDesc'; },
    registry => { registry['card-monthlyConsumption'].defaults.groupBy = 'user'; },
    registry => { registry['card-counts'].acceptedArgs.filter.coverage = 'unknown-window'; },
  ];
  for (const mutate of mutations) {
    const registry = makeRegistry(); mutate(registry);
    expect(() => assertDatasetCapabilities({ registry, datasets: fixedDatasets })).toThrow('AI dataset contract inconsistent');
  }
  expect(() => assertDatasetCapabilities({ choiceGroups: {}, datasets: fixedDatasets })).toThrow();
  expect(assertDatasetCapabilities({ datasets: fixedDatasets })).toBe(true);
});
