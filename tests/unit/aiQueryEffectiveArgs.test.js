const { queryEffectiveArgs } = require('../../src/modules/ai/service/queryEffectiveArgs');

const range = { startDate: '2026-06-01', endDate: '2026-06-30' };
const queryId = 'q_0123456789abcdef01234567';
function result(datasetId, patch = {}) {
  return { scope: { domains: ['finance'], ...range }, datasets: [{ datasetId,
    queryMeta: { datasetId, queryId, effectiveScope: range, filters: { direction: 'expense', text: '' },
      sort: 'dateDesc', ...patch } }] };
}

test('approved finance normalization wins over the tool input without exposing internal fields', () => {
  const original = { datasetId: 'finance-categories', sort: 'dateDesc', filter: '购汇', startDate: '2026-06-01' };
  const validated = { ...original, scope: { domains: ['finance'], ...range }, limit: 20,
    queryId, domain: 'finance', userId: 'private-owner', connectionId: 'private-connection', message: 'private-message' };
  const actual = queryEffectiveArgs('query_data', original, validated,
    result('finance-categories', { sort: 'categoryAmountDesc', filters: { direction: 'expense', text: '购汇' } }));
  expect(actual.effectiveArgs).toEqual({ datasetId: 'finance-categories', ...range, filter: '购汇',
    direction: 'expense', sort: 'categoryAmountDesc', limit: 20 });
  expect(actual.argumentAdjustments).toContainEqual({ path: 'sort', reason: 'normalized', requested: 'dateDesc', effective: 'categoryAmountDesc' });
  expect(actual.argumentAdjustments).toContainEqual({ path: 'limit', reason: 'defaulted', effective: 20 });
  expect(JSON.stringify(actual)).not.toMatch(/private-|queryId|userId|connectionId|"message"|"domain"/);
});

test('approved card types, range, grouping and sort report the actual query rather than stale model parameters', () => {
  const original = { datasetId: 'card-monthlyConsumption', cardTypes: ['debit'], groupBy: 'card',
    sort: 'amountDesc', startDate: '2026-08-01', endDate: '2026-11-30', limit: 50 };
  const validated = { ...original, cardTypes: ['credit'], groupBy: 'cardMonth', sort: 'dateDesc', queryId,
    scope: { domains: ['card'], startDate: '2026-09-01', endDate: '2026-11-09' }, filter: '' };
  const actual = queryEffectiveArgs('query_data', original, validated, result('card-monthlyConsumption', {
    effectiveScope: { startDate: '2026-09-01', endDate: '2026-11-09' }, groupBy: 'cardMonth',
    filters: { direction: 'expense', text: '', cardTypes: ['credit'] }, sort: 'dateDesc', returnedRowCount: 2 }));
  expect(actual.effectiveArgs).toEqual({ datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: '2026-11-09',
    filter: '', direction: 'expense', sort: 'dateDesc', groupBy: 'cardMonth', cardTypes: ['credit'], limit: 50 });
  expect(actual.argumentAdjustments).toContainEqual({ path: 'cardTypes', reason: 'normalized', requested: ['debit'], effective: ['credit'] });
  expect(actual.argumentAdjustments).toContainEqual({ path: 'groupBy', reason: 'normalized', requested: 'card', effective: 'cardMonth' });
});

test('feedback uses the matching approved query identity, never an unrelated comparison query', () => {
  const original = { datasetId: 'finance-transactions', direction: 'expense' };
  const validated = { ...original, queryId, scope: range, filter: '', limit: 1 };
  const actualResult = result('finance-transactions', { sort: 'amountDesc' });
  actualResult.datasets.unshift({ datasetId: 'finance-transactions', queryMeta: {
    datasetId: 'finance-transactions', queryId: 'q_aaaaaaaaaaaaaaaaaaaaaaaa', effectiveScope: range,
    sort: 'dateDesc', filters: { direction: 'income', text: 'wrong comparison' } } });
  expect(queryEffectiveArgs('query_data', original, validated, actualResult).effectiveArgs).toMatchObject({
    direction: 'expense', sort: 'amountDesc', filter: '', limit: 1 });
});

test('original free text and unknown raw values never appear in adjustments', () => {
  const original = { datasetId: 'finance-daily', filter: 'apiKey=sk-private-secret', sort: 'secret-sort',
    direction: 'private-direction', groupBy: 'private-group', startDate: 'not-a-date', limit: 1000,
    userId: 'private-owner', cardTypes: ['private-type'] };
  const validated = { datasetId: 'finance-daily', queryId, scope: range, filter: 'safe approved text',
    direction: 'expense', sort: 'expenseDesc', limit: 1 };
  const actual = queryEffectiveArgs('query_data', original, validated, result('finance-daily', {
    sort: 'expenseDesc', filters: { direction: 'expense', text: '获准文本 English' } }));
  expect(actual.effectiveArgs.filter).toBe('获准文本 English');
  expect(actual.argumentAdjustments.find(item => item.path === 'filter')).toEqual({
    path: 'filter', reason: 'normalized', effective: '获准文本 English' });
  expect(JSON.stringify(actual)).not.toMatch(/private-|sk-private|apiKey|not-a-date|secret-sort|1000/);
  expect(actual.argumentAdjustments.find(item => item.path === 'sort')).not.toHaveProperty('requested');
});

test('list choices projects only its public arguments and never repeats requested bank/filter text', () => {
  const original = { domain: 'finance', group: 'cards', bankName: 'private-bank', filter: 'private-filter',
    cardType: 'debit', direction: 'both', limit: 10, owner: 'private-owner' };
  const validated = { ...original, bankName: '农业银行', filter: 'Bearer confidential', cardType: 'credit',
    scope: range, queryId, connection: 'private-connection' };
  const actual = queryEffectiveArgs('list_choices', original, validated, { choices: {}, scope: range });
  expect(actual.effectiveArgs).toEqual({ domain: 'finance', group: 'cards', bankName: '农业银行',
    cardType: 'credit', direction: 'both', filter: 'Bearer [redacted]', limit: 10 });
  expect(actual.argumentAdjustments.find(item => item.path === 'bankName')).toEqual({
    path: 'bankName', reason: 'normalized', effective: '农业银行' });
  expect(JSON.stringify(actual)).not.toMatch(/private-|confidential|queryId|connection/);
});

test('helper does not mutate any input or share returned card type arrays with inputs', () => {
  const original = { datasetId: 'card-monthlyConsumption', cardTypes: ['debit'] };
  const validated = { ...original, cardTypes: ['credit'], queryId, scope: range, limit: 20, groupBy: 'cardMonth' };
  const approved = result('card-monthlyConsumption', { groupBy: 'cardMonth',
    filters: { direction: 'expense', text: '', cardTypes: ['credit'] } });
  const before = structuredClone({ original, validated, approved });
  const actual = queryEffectiveArgs('query_data', original, validated, approved);
  expect({ original, validated, approved }).toEqual(before);
  actual.effectiveArgs.cardTypes.push('debit');
  actual.argumentAdjustments.find(item => item.path === 'cardTypes').requested.push('credit');
  expect({ original, validated, approved }).toEqual(before);
});

test('unsupported tool feedback remains empty and invalid public values are not projected', () => {
  expect(queryEffectiveArgs('memory_write', { content: 'secret' }, { content: 'secret' }, {})).toEqual({
    effectiveArgs: {}, argumentAdjustments: [] });
  expect(queryEffectiveArgs('query_data', {}, { datasetId: 'private-dataset', scope: { startDate: 'bad', endDate: 'bad' },
    direction: 'income-secret', sort: 'bad-sort', groupBy: 'bad-group', cardTypes: ['bad-type'], limit: 51 }, {})).toEqual({
    effectiveArgs: {}, argumentAdjustments: [] });
});
