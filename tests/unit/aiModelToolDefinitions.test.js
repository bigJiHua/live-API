const { buildModelToolDefinitions, queryDataDefinition } = require('../../src/modules/ai/service/modelToolDefinitions');
const { definitions: business } = require('../../src/modules/ai/service/v3Tools');
const { memoryDefinitions } = require('../../src/modules/ai/service/memoryTools');
const { historyDefinitions } = require('../../src/modules/ai/service/historyTools');

// Interpret the generated standard JSON Schema independently. No expected
// permission or sort value comes from datasetCapabilities.
function accepts(schema, value) {
  if (schema.anyOf && !schema.anyOf.some(branch => accepts(branch, value))) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  const types = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === type;
  if (types.length && !types.some(typeOf)) return false;
  if (typeof value === 'string' && (schema.maxLength != null && value.length > schema.maxLength
    || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (typeof value === 'number' && (schema.minimum != null && value < schema.minimum
    || schema.maximum != null && value > schema.maximum)) return false;
  if (Array.isArray(value) && (schema.minItems != null && value.length < schema.minItems
    || schema.maxItems != null && value.length > schema.maxItems
    || schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length
    || schema.items && value.some(item => !accepts(schema.items, item)))) return false;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties && Object.entries(value).some(([key, item]) =>
      Object.hasOwn(schema.properties, key) ? !accepts(schema.properties[key], item) : schema.additionalProperties === false)) return false;
  }
  return true;
}
const definition = queryDataDefinition();
const schema = definition.function.parameters;
const fixedIds = ['finance-monthly', 'finance-categories', 'finance-transactions', 'finance-daily', 'account-balances',
  'card-cards', 'card-counts', 'card-monthlyConsumption', 'card-bills', 'card-repayments', 'card-pools',
  'budget-plans', 'todo-events', 'work-salary', 'work-rules', 'asset-snapshots', 'asset-registers', 'asset-composition',
  'asset-comparison', 'fixedAsset-saved', 'fund-holdings', 'fund-history', 'installment-plans'];

test('all 8 native names remain available, preserving the other seven definitions exactly', () => {
  const original = [...business, ...memoryDefinitions, ...historyDefinitions], before = JSON.stringify(original);
  const model = buildModelToolDefinitions(original);
  expect(model.map(item => item.function.name)).toEqual(['list_choices', 'query_data', 'memory_list', 'memory_read',
    'memory_search', 'memory_write', 'history_search', 'history_read']);
  for (let i = 0; i < model.length; i++) if (model[i].function.name !== 'query_data') expect(model[i]).toEqual(original[i]);
  expect(JSON.stringify(original)).toBe(before);
  model[0].function.description = 'changed clone';
  expect(JSON.stringify(original)).toBe(before);
});
test('all dataset branches stay available for multiple subjects and new topics', () => {
  expect(schema.properties.datasetId.enum).toEqual(fixedIds);
  expect(schema.anyOf.map(branch => branch.properties.datasetId.enum[0])).toEqual(fixedIds);
  for (const datasetId of fixedIds) expect(accepts(schema, { datasetId })).toBe(true);
});

test('saved-state date parameters cannot be described as historical reconstruction', () => {
  for (const id of ['account-balances', 'card-cards', 'card-counts', 'card-pools', 'work-rules',
    'asset-composition', 'fixedAsset-saved', 'fund-holdings']) {
    const branch = schema.anyOf.find(item => item.properties.datasetId.enum[0] === id);
    expect(branch.description).toMatch(/目前已保存状态/);
    expect(branch.description).toMatch(/不会筛出或重建该历史时点/);
  }
  expect(schema.anyOf.find(item => item.properties.datasetId.enum[0] === 'installment-plans').description)
    .toMatch(/仅筛选计划中的月度入账状态计数/);
});
test.each([
  ['finance-monthly', ['monthAsc']],
  ['finance-categories', ['categoryAmountDesc']],
  ['finance-transactions', ['dateDesc', 'amountDesc']],
  ['finance-daily', ['dateDesc', 'expenseDesc', 'incomeDesc']],
  ['card-monthlyConsumption', ['dateDesc', 'amountDesc']],
])('%s exposes only the independent canonical reader sort matrix %j', (datasetId, allowed) => {
  for (const sort of ['dateDesc', 'amountDesc', 'expenseDesc', 'incomeDesc', 'monthAsc', 'categoryAmountDesc'])
    expect(accepts(schema, { datasetId, sort })).toBe(allowed.includes(sort));
});
test('card consumption does not expose direction, while finance direction stays usable', () => {
  const branch = schema.anyOf.find(item => item.properties.datasetId.enum[0] === 'card-monthlyConsumption');
  expect(branch.properties).not.toHaveProperty('direction');
  for (const direction of ['income', 'expense', 'both']) {
    expect(accepts(schema, { datasetId: 'card-monthlyConsumption', direction })).toBe(false);
    expect(accepts(schema, { datasetId: 'finance-transactions', direction })).toBe(true);
  }
});
test('grouping and card types cannot migrate to unrelated datasets', () => {
  for (const datasetId of fixedIds) {
    expect(accepts(schema, { datasetId, groupBy: 'card' })).toBe(datasetId === 'card-monthlyConsumption');
    expect(accepts(schema, { datasetId, groupBy: 'cardMonth' })).toBe(datasetId === 'card-monthlyConsumption');
    expect(accepts(schema, { datasetId, cardTypes: ['credit', 'debit'] }))
      .toBe(['card-counts', 'card-monthlyConsumption'].includes(datasetId));
  }
});
test('monthly filter is unavailable instead of producing a reader rejection', () => {
  for (const filter of ['购汇', '', null]) expect(accepts(schema, { datasetId: 'finance-monthly', filter })).toBe(false);
  expect(accepts(schema, { datasetId: 'finance-transactions', filter: '购汇' })).toBe(true);
});
test.each([
  {}, { datasetId: 'unknown-dataset' }, { datasetId: 'card-counts', sort: 'dateDesc' },
  { datasetId: 'finance-transactions', sql: 'SELECT * FROM account' },
  { datasetId: 'card-counts', userId: 'another-owner' },
  { datasetId: 'finance-transactions', limit: 0 }, { datasetId: 'finance-transactions', limit: 51 },
  { datasetId: 'finance-transactions', limit: '1' }, { datasetId: 'finance-transactions', filter: '字'.repeat(81) },
  { datasetId: 'card-counts', cardTypes: [] }, { datasetId: 'card-counts', cardTypes: ['debit', 'debit'] },
  { datasetId: 'card-counts', cardTypes: ['unknown'] }, { datasetId: 'card-monthlyConsumption', groupBy: 'user' },
  { datasetId: 'finance-transactions', startDate: 'yesterday' },
])('model schema cannot advertise an unsupported input %j', value => {
  expect(accepts(schema, value)).toBe(false);
});
test('builder requires exactly one query tool and does not depend on current task context', () => {
  expect(() => buildModelToolDefinitions([])).toThrow();
  expect(() => buildModelToolDefinitions([definition, definition])).toThrow();
  expect(() => buildModelToolDefinitions(null)).toThrow();
  expect(queryDataDefinition()).toEqual(queryDataDefinition());
  expect(JSON.stringify(schema)).not.toMatch(/taskContext|owner|queryId|connectionId/);
});
