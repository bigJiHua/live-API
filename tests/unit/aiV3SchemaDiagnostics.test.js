const { AiError } = require('../../src/modules/ai/service/errors');
const { validateOutput } = require('../../src/modules/ai/service/v3Schema');

const proposal = (kind = 'transaction.create', fields = { amount: '89.00' }) => ({ kind, fields });
const getError = input => {
  try { validateOutput(input); }
  catch (error) { return error; }
  throw new Error('Expected output validation to fail');
};
const issue = (path, rule, actualType) => expect.objectContaining({ path, rule, actualType, message: expect.any(String) });

describe('V3 console-only output schema diagnostics', () => {
  test('reports the actual missing answer and unexpected clarification.question without exposing the question', () => {
    const input = { clarification: { items: [{ ...proposal(), evidence: { sourceTurn: 12, quote: '改成89元' } }], question: '请问这笔交易是哪天的？' } };
    const error = getError(input);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ status: 502, code: 'AI_INVALID_RESULT',
      message: '模型生成的答复或草稿结构不符合允许格式，本轮没有生成可执行草稿' });
    expect(error.validationDiagnostic).toEqual({ stage: 'output-schema', issues: [
      issue('answer', 'any.required', 'undefined'), issue('clarification.question', 'object.unknown', 'string'),
    ], truncated: false });
    expect(JSON.stringify(error.validationDiagnostic)).not.toContain(input.clarification.question);
  });

  test('keeps diagnostics non-enumerable and outside public/persisted diagnostics', () => {
    const error = getError({ answer: 123, privateValue: 'private-financial-value' });
    expect(Object.keys(error)).toEqual(['status', 'code']);
    expect(Object.getOwnPropertyDescriptor(error, 'validationDiagnostic').enumerable).toBe(false);
    expect(error.diagnostics).toBeUndefined();
    expect(JSON.stringify(error)).toBe('{"status":502,"code":"AI_INVALID_RESULT"}');
    expect(JSON.stringify(error.validationDiagnostic)).not.toContain('private-financial-value');
    for (const item of error.validationDiagnostic.issues) expect(Object.keys(item)).toEqual(['path', 'rule', 'message', 'actualType']);
  });

  test.each([
    ['number answer', { answer: 12 }, 'answer', 'string.base', 'number'],
    ['null answer', { answer: null }, 'answer', 'string.base', 'null'],
    ['too long answer', { answer: 'a'.repeat(4001) }, 'answer', 'string.max', 'string'],
    ['array proposal', { answer: '', proposal: [] }, 'proposal', 'object.base', 'array'],
    ['unknown kind', { answer: '', proposal: proposal('transaction.delete') }, 'proposal.kind', 'any.only', 'string'],
    ['array fields', { answer: '', proposal: proposal('transaction.create', []) }, 'proposal.fields', 'object.base', 'array'],
    ['absent fields', { answer: '', proposal: { kind: 'transaction.create' } }, 'proposal.fields', 'any.required', 'undefined'],
    ['too few proposals', { answer: '', proposals: [proposal()] }, 'proposals', 'array.min', 'array'],
    ['missing clarification items', { answer: '', clarification: {} }, 'clarification.items', 'any.required', 'undefined'],
    ['string source turn', { answer: '', proposal: { ...proposal(), evidence: { sourceTurn: '12', quote: '89元' } } }, 'proposal.evidence.sourceTurn', 'number.base', 'string'],
    ['non-integer source turn', { answer: '', proposal: { ...proposal(), evidence: { sourceTurn: 1.2, quote: '89元' } } }, 'proposal.evidence.sourceTurn', 'number.integer', 'number'],
    ['source turn out of range', { answer: '', proposal: { ...proposal(), evidence: { sourceTurn: 16, quote: '89元' } } }, 'proposal.evidence.sourceTurn', 'number.max', 'number'],
    ['nested array item', { answer: '', clarification: { items: [{ ...proposal(), evidence: { sourceTurn: 12 } }] } }, 'clarification.items[0].evidence.quote', 'any.required', 'undefined'],
  ])('identifies %s with its path, rule and type', (_name, input, path, rule, actualType) => {
    expect(getError(input).validationDiagnostic.issues).toEqual(expect.arrayContaining([issue(path, rule, actualType)]));
  });

  test('never includes bad queryId values or Joi pattern context in diagnostics', () => {
    const credential = 'sk-secret-test-credential-123456';
    const error = getError({ answer: '', chart: { datasetId: 'finance-monthly', type: 'bar', queryId: credential,
      xKey: 'month', yKeys: ['expense'], title: '支出' } });
    expect(error.validationDiagnostic.issues).toEqual([issue('chart.queryId', 'string.pattern.base', 'string')]);
    const serialized = JSON.stringify(error.validationDiagnostic);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('context');
  });

  test('limits issues to 20 and marks omitted issues', () => {
    const input = { answer: '', ...Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`extra${index}`, 'private-value'])) };
    const diagnostic = getError(input).validationDiagnostic;
    expect(diagnostic.issues).toHaveLength(20);
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.issues[19]).toEqual(issue('extra19', 'object.unknown', 'string'));
    expect(JSON.stringify(diagnostic)).not.toContain('private-value');
  });

  test.each([
    ['single and multiple proposals', { answer: '', proposal: proposal(), proposals: [proposal(), proposal()] },
      502, 'AI_INVALID_RESULT', '模型不能同时返回单笔与多笔提案', 'proposals', 'intent.exclusive', 'array'],
    ['clarification and proposal', { answer: '', proposal: proposal(), clarification: { items: [proposal()] } },
      502, 'AI_INVALID_RESULT', '待补充意图与草稿必须择一', 'clarification', 'intent.exclusive', 'object'],
    ['unsupported clarification kind', { answer: '', clarification: { items: [proposal('todo.create', { content: '吃饭' })] } },
      502, 'AI_INVALID_RESULT', '待补充协议仅支持普通收支', 'clarification.items[0].kind', 'kind.clarification', 'string'],
    ['mixed multiple kinds', { answer: '', proposals: [proposal(), proposal('todo.create', { content: '吃饭' })] },
      400, 'AI_INVALID_RESULT', '混合业务须分别核对，本轮多卡只支持普通收支', 'proposals[1].kind', 'kind.multiple', 'string'],
    ['unopened single field', { answer: '', proposal: proposal('transaction.create', { userId: 'private-id' }) },
      403, 'AI_REF_INVALID', '模型返回了未开放字段或真实ID', 'proposal.fields.userId', 'fields.allowlist', 'string'],
    ['unopened multiple field', { answer: '', proposals: [proposal(), proposal('transaction.create', { accountId: 'private-id' })] },
      403, 'AI_REF_INVALID', '模型返回了未开放字段或真实ID', 'proposals[1].fields.accountId', 'fields.allowlist', 'string'],
  ])('reports %s while preserving its original public error', (_name, input, status, code, message, path, rule, actualType) => {
    const error = getError(input);
    expect(error).toMatchObject({ status, code, message });
    expect(error.validationDiagnostic.issues).toEqual([issue(path, rule, actualType)]);
    expect(error.validationDiagnostic.truncated).toBe(false);
    expect(JSON.stringify(error.validationDiagnostic)).not.toContain('private-id');
  });

  test('preserves accepted output variants and does not impose field value validation', () => {
    const values = [
      { answer: '晚上好' },
      { answer: '', proposal: null, proposals: null, clarification: null, chart: null },
      { answer: '', proposal: proposal('transaction.create', { amount: 89, direction: 'unchanged-value-type' }) },
      { answer: '请选择日期', clarification: { items: [proposal()] } },
      { answer: '', proposals: [proposal(), proposal()] },
      { answer: '', proposal: proposal('system.backup', {}) },
      { answer: '', chart: { datasetId: 'finance-monthly', type: 'bar', queryId: 'q_0123456789abcdef01234567', xKey: 'month', yKeys: ['expense'], title: '支出' } },
    ];
    for (const input of values) expect(validateOutput(input)).toEqual(input);
  });
});
