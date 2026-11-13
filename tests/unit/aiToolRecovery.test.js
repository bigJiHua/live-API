const { AiError } = require('../../src/modules/ai/service/errors');
const { markToolParameterError, isToolParameterError, hasInvalidUserDates, toolErrorFeedback } = require('../../src/modules/ai/service/toolRecovery');
const { prepareFinanceDatasetQuery } = require('../../src/modules/ai/service/financeDatasetRead');
test('only marked parameter-boundary errors can be corrected', () => {
  const databaseError = new AiError('SQL or preview failure', 400, 'AI_TOOL_ARGUMENT_INVALID');
  expect(isToolParameterError(databaseError)).toBe(false);
  expect(isToolParameterError(markToolParameterError(new AiError('denied', 403, 'AI_SCOPE_DENIED')))).toBe(false);
  expect(isToolParameterError(markToolParameterError(new AiError('bad args', 400, 'AI_INVALID_INPUT')))).toBe(true);
});
test.each(['userId', 'ownerId', 'user_id', 'owner_id', 'SQL_query', 'query_id', 'sql', 'database', 'connectionId', 'apiKey', 'authorization', 'password', 'token'])
  ('reserved %s fields cannot trigger model correction', path => {
    const error = markToolParameterError(new AiError('bad args', 400, 'AI_INVALID_INPUT'), [{ path, rule: 'object.unknown' }]);
    expect(isToolParameterError(error)).toBe(false);
  });
test('feedback only discloses approved field names and allowed enums', () => {
  const error = markToolParameterError(new AiError('private SQL and identity', 400, 'AI_TOOL_ARGUMENT_INVALID'),
    [{ path: 'sort', rule: 'dataset.reader', message: 'private SQL', actual: 'credential' }]);
  const feedback = toolErrorFeedback(error, { datasetId: 'finance-transactions', filter: 'secret-owner' }, true);
  expect(feedback).toMatchObject({ status: 'error', retryAllowed: true,
    issues: [{ path: 'sort', allowedValues: ['dateDesc', 'amountDesc'] }] });
  expect(JSON.stringify(feedback)).not.toMatch(/private SQL|identity|credential|secret-owner/);
});
test('a finance reader capability error is marked, an internal query identity error is not', () => {
  let error;
  try { prepareFinanceDatasetQuery({ datasetId: 'finance-monthly', sort: 'amountDesc' }); } catch (caught) { error = caught; }
  expect(isToolParameterError(error)).toBe(true);
  try { prepareFinanceDatasetQuery({ datasetId: 'finance-monthly', queryId: 'invalid-server-id' }); } catch (caught) { error = caught; }
  expect(isToolParameterError(error)).toBe(false);
});
test('invalid original user dates do not become a model correction opportunity', () => {
  expect(hasInvalidUserDates('查询2026-02-30的支出')).toBe(true);
  expect(hasInvalidUserDates('查询2026-06-30到2026-06-01')).toBe(true);
  expect(hasInvalidUserDates('查询2026-06-01到2026-06-30')).toBe(false);
});
