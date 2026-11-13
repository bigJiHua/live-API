const { validateTool } = require('../../src/modules/ai/service/v3Tools');
const { validateQueryMeta } = require('../../src/modules/ai/service/queryMetadata');

const today = '2026-11-08';
const recorded = { datasetId: 'card-monthlyConsumption', cardTypes: ['debit'], startDate: '2026-08-01',
  endDate: today, sort: 'amountDesc', direction: 'expense', limit: 5 };

test('the actual expense-sorted debit-card request now reaches its supported read contract', () => {
  expect(validateTool('query_data', recorded, today)).toMatchObject({ ...recorded, groupBy: 'cardMonth',
    domain: 'card', scope: { domains: ['card'], startDate: '2026-08-01', endDate: today } });
});
test.each([undefined, 'expense', 'both'])('the consumption dataset always reports its actual expense direction for %s', direction => {
  const args = { ...recorded, groupBy: 'card' };
  if (direction === undefined) delete args.direction; else args.direction = direction;
  expect(validateTool('query_data', args, today)).toMatchObject({ direction: 'expense', groupBy: 'card' });
  expect(args.direction).toBe(direction);
});
test('an income request is refused with a precise console-only field diagnostic', () => {
  let failure;
  try { validateTool('query_data', { ...recorded, direction: 'income' }, today); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID', status: 400 });
  expect(failure.validationDiagnostic).toMatchObject({ stage: 'tool-arguments', issues: [{ path: 'direction', rule: 'dataset.direction' }] });
  expect(JSON.stringify(failure)).not.toContain('validationDiagnostic');
});
test.each([
  { datasetId: 'card-cards', direction: 'expense' }, { datasetId: 'card-counts', sort: 'amountDesc' },
  { datasetId: 'card-bills', groupBy: 'card' }, { datasetId: 'finance-transactions', groupBy: 'card' },
  { datasetId: 'card-monthlyConsumption', sort: 'monthAsc' }, { datasetId: 'card-monthlyConsumption', groupBy: 'user' },
])('unrelated datasets and unsupported grouping/sorting stay closed: %j', args => {
  expect(() => validateTool('query_data', args, today)).toThrow();
});
test('card consumption history is clamped through today and cannot start in the future', () => {
  expect(validateTool('query_data', { ...recorded, endDate: '2026-12-08' }, today))
    .toMatchObject({ scope: { endDate: today }, requestedScope: { endDate: '2026-12-08' } });
  expect(() => validateTool('query_data', { ...recorded, startDate: '2026-12-01', endDate: '2026-12-08' }, today)).toThrow();
});
test('unknown tool fields retain a path and rule without dumping their value into error metadata', () => {
  let failure;
  try { validateTool('query_data', { ...recorded, password: 'private-field-value' }, today); } catch (error) { failure = error; }
  expect(failure.validationDiagnostic.issues).toContainEqual(expect.objectContaining({ path: 'password', rule: 'object.unknown' }));
  expect(JSON.stringify(failure.validationDiagnostic)).not.toContain('private-field-value');
});

const scope = { domains: ['card'], startDate: '2026-09-01', endDate: today };
const range = { startDate: scope.startDate, endDate: scope.endDate };
const dataset = { datasetId: 'card-monthlyConsumption', rows: [{ name: '卡 A', amountCNY: '180.00' }] };
const meta = { version: 1, queryId: 'q_0123456789abcdef01234567', datasetId: dataset.datasetId,
  requestedScope: range, effectiveScope: range, filters: { direction: 'expense', text: '', cardTypes: ['debit'] },
  groupBy: 'card', sort: 'amountDesc', matchedRowCount: 2, returnedRowCount: 1, sourceRecordCount: 4,
  rowsComplete: false, summaryComplete: true, rankingComplete: true, returnedDateRange: null, asOf: '2026-11-08T00:00:00Z' };
test('ranked card scope, type and grouping are valid evidence even when rows are limited to one', () => {
  expect(validateQueryMeta(meta, dataset, scope)).toEqual(meta);
});
test.each([
  { groupBy: 'user' }, { datasetId: 'finance-monthly' },
  { filters: { direction: 'expense', text: '', cardTypes: ['debit', 'debit'] } },
  { filters: { direction: 'expense', text: '', cardTypes: ['invalid'] } },
  { filters: { direction: 'expense', text: '', cardTypes: 'debit' } },
  { filters: { direction: 'expense', text: '', password: 'private-field-value' } },
])('invalid card metadata cannot pass the preview contract: %j', patch => {
  expect(() => validateQueryMeta({ ...meta, ...patch }, dataset, scope)).toThrow();
});
