const { createResponseValidation, limitAnswer } = require('../../src/modules/ai/service/responseValidation');

test.each(['chat', 'analysis'])('open scene begins as prose and cannot accept model routing flags: %s', mode => {
  const policy = createResponseValidation(mode);
  expect(policy.forResult({ requires_data: true, claimsScope: 'business' })).toMatchObject({
    route: 'prose', claimsScope: 'prose', privateSources: false, memoryExplicitOnly: true,
  });
  expect(Object.isFrozen(policy.forResult())).toBe(true);
});

test.each([undefined, 'operate'])('legacy and operation scenes remain strict: %s', mode => {
  expect(createResponseValidation(mode).forResult()).toMatchObject({
    route: 'business', claimsScope: 'business', privateSources: true, memoryExplicitOnly: false,
  });
});

test.each(['query_data', 'list_choices', 'invented_tool', null])('business/unknown dispatch attempts stay latched after empty or failed results: %s', tool => {
  const policy = createResponseValidation('chat'); policy.recordTool(tool);
  expect(policy.forResult({ claimsScope: 'prose', requires_data: false })).toMatchObject({
    route: 'business', claimsScope: 'business', privateSources: true,
  });
  expect(policy.forResult()).toMatchObject({ route: 'business', privateSources: true });
});

test.each(['memory_list', 'memory_read', 'memory_search', 'history_search', 'history_read'])('context reads select private-text and corresponding evidence checks: %s', tool => {
  const policy = createResponseValidation('analysis'); policy.recordTool(tool);
  expect(policy.forResult()).toMatchObject({ route: 'context', claimsScope: 'prose', privateSources: true, memoryExplicitOnly: true });
});

test('memory write enables generic memory-effect evidence without claiming a business read', () => {
  const policy = createResponseValidation('chat'); policy.recordTool('memory_write');
  expect(policy.forResult()).toMatchObject({ route: 'context', claimsScope: 'prose', privateSources: true, memoryExplicitOnly: false });
});

test('authorization alone does not claim actual data disclosure', () => {
  const policy = createResponseValidation('analysis'); policy.recordTool('request_authorization');
  expect(policy.forResult()).toMatchObject({ route: 'prose', authorization: true, businessRead: false, privateSources: false });
});

test.each([{ artifacts: [{}] }, { datasets: [{}] }])('actual business results always select strict checks: %j', facts => {
  expect(createResponseValidation('chat').forResult(facts)).toMatchObject({ route: 'business', claimsScope: 'business', privateSources: true });
});

test.each([{ memoryReadReceipts: [{}] }, { memorySearchReceipts: [{}] }, { memoryErrors: [{}] }])('context evidence selects private sources: %j', facts => {
  expect(createResponseValidation('chat').forResult(facts)).toMatchObject({ route: 'context', privateSources: true });
});

test('memory saved receipts independently enable strict memory effects', () => {
  expect(createResponseValidation('chat').forResult({ memoryReceipts: [{}] })).toMatchObject({ route: 'context', memoryExplicitOnly: false, privateSources: true });
});

test('invalid server scenes fail closed', () => {
  expect(() => createResponseValidation('model-chosen')).toThrow(expect.objectContaining({ code: 'AI_INVALID_RESULT' }));
});

test('prose length accepts the boundary and rejects overflow without truncation', () => {
  const boundary = '文'.repeat(12000); expect(limitAnswer(boundary)).toBe(boundary);
  expect(() => limitAnswer(boundary + '末')).toThrow(expect.objectContaining({ code: 'AI_ANSWER_TOO_LONG' }));
});
