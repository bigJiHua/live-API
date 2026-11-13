const { buildOperationOutcome } = require('../../src/modules/ai/service/operationOutcome');

test('a source-free chat cannot report formal writes or fabricate an artifact', () => {
  expect(buildOperationOutcome()).toEqual({ version: 1, state: 'none', formalWriteExecuted: false,
    artifacts: [], notice: '本轮未提交正式业务操作。' });
});

test('server draft and proposal identifiers produce an awaiting-confirmation outcome', () => {
  const result = buildOperationOutcome([{ draft: { id: 'saved-draft', status: 'pending', missingFields: [] } },
    { proposal: { id: 'saved-proposal', kind: 'todo.delete', status: 'reviewed', missingFields: [] } }]);
  expect(result).toMatchObject({ version: 1, state: 'awaiting_confirmation', formalWriteExecuted: false,
    artifacts: [{ type: 'draft', id: 'saved-draft', kind: 'transaction.create', status: 'pending', readyForReview: true },
      { type: 'proposal', id: 'saved-proposal', kind: 'todo.delete', status: 'reviewed', readyForReview: true }] });
  expect(result.notice).toContain('仍需你确认提交');
});

test.each([
  { inputCandidate: { id: 'saved-candidate', status: 'pending' } },
  { proposal: { id: 'saved-prefill', status: 'pending', kind: 'fixedAsset.create', missingFields: [], actionUnavailable: true } },
  { proposal: { id: 'saved-incomplete', status: 'pending', kind: 'budget.create', missingFields: ['date'] } },
])('candidate, prefill-only and incomplete artifacts remain needs-input', artifact => {
  expect(buildOperationOutcome([artifact])).toMatchObject({ state: 'needs_input', formalWriteExecuted: false,
    artifacts: [{ readyForReview: false }] });
});

test('a mixed batch cannot claim every item is ready', () => {
  const result = buildOperationOutcome([{ draft: { id: 'saved-draft', status: 'pending', missingFields: [] } },
    { inputCandidate: { id: 'saved-candidate', status: 'pending' } }]);
  expect(result.state).toBe('needs_input');
  expect(result.artifacts.map(item => item.readyForReview)).toEqual([true, false]);
  expect(result.formalWriteExecuted).toBe(false);
});

test('model-like fields and old completed artifacts do not authorize a current business write', () => {
  const result = buildOperationOutcome([{ formalWriteExecuted: true, answer: '已经入账',
    proposal: { id: 'saved-proposal', kind: 'todo.complete', status: 'executed', missingFields: [] } }]);
  expect(result.formalWriteExecuted).toBe(false);
  expect(result.state).toBe('needs_input');
});

test.each([null, {}, [{ draft: { status: 'pending' } }]])('invalid artifacts cannot become an authoritative outcome', artifacts => {
  expect(() => buildOperationOutcome(artifacts)).toThrow(expect.objectContaining({ code: 'AI_INVALID_RESULT' }));
});
