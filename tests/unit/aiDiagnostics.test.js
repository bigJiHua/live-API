const { PassThrough } = require('stream');
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const { deepseekChat, deepseekChatStream } = require('../../src/modules/ai/service/deepseek');
const { redactSecretText, sanitizeDiagnosticValue, withAiDiagnosticContext, reportAiError, logProviderReasoning, logModelValidationFailure, logToolValidationFailure } = require('../../src/modules/ai/service/diagnostics');
const { createCallLogStore } = require('../../src/modules/ai/service/callLog');
const config = { baseUrl: 'https://provider.invalid/v1', apiKey: 'private-fixture-key', model: 'fixture-model', providerTimeoutMs: 60000 };

describe('AI provider diagnostics', () => {
  let log, warn, error;
  beforeEach(() => { jest.clearAllMocks(); log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); error = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); warn.mockRestore(); error.mockRestore(); });

  test('console reasoning preserves readable lines and request identity while hiding credentials and excluding the response envelope', () => {
    const message = { reasoning: '第一步核对金额。\n第二步选账户。private-fixture-key',
      reasoning_content: '引用原话，再检查账户。Bearer private-token', content: 'FINAL_PAYLOAD_NOT_FOR_CONSOLE',
      tool_calls: [{ function: { arguments: 'PRIVATE_ARGUMENTS' } }] };
    withAiDiagnosticContext({ traceId: 'console-trace' }, () => logProviderReasoning(message,
      { requestId: 'console-request', round: 3, stage: 'finalizing', model: config.model }, [config.apiKey]));
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('第一步核对金额。\n第二步选账户。');
    expect(output).toContain('引用原话，再检查账户。');
    expect(output).toContain('\x1b[33m[AI Say] ');
    expect(log.mock.calls.every(([line]) => line.endsWith('\x1b[0m'))).toBe(true);
    expect(output).toContain('console-request'); expect(output).toContain('console-trace');
    expect(output).toContain('"round":3'); expect(output).toContain('"stage":"finalizing"');
    for (const secret of [config.apiKey, 'private-token', 'FINAL_PAYLOAD_NOT_FOR_CONSOLE', 'PRIVATE_ARGUMENTS'])
      expect(output).not.toContain(secret);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejected model JSON prints field rules and readable Chinese while keeping diagnostics out of the public error', () => {
    const { validateOutput } = require('../../src/modules/ai/service/v3Schema');
    const payload = { clarification: { items: [{ kind: 'transaction.create', fields: { amount: '89.00' } }],
      question: '要重新记录这笔金额吗？' } };
    let failure;
    try { validateOutput(payload); } catch (caught) { failure = caught; }
    withAiDiagnosticContext({ traceId: 'validation-trace', conversationId: 'validation-conversation' }, () =>
      logModelValidationFailure(failure, { requestId: 'validation-request', round: 2, stage: 'output-schema',
        model: config.model, content: JSON.stringify(payload) }, [config.apiKey]));
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('[AI Check]'); expect(output).toContain('[AI Result]');
    expect(output).toContain('"path":"answer","rule":"any.required"');
    expect(output).toContain('"path":"clarification.question","rule":"object.unknown"');
    expect(output).toContain('要重新记录这笔金额吗？');
    for (const value of ['validation-trace', 'validation-request', 'validation-conversation', '"round":2']) expect(output).toContain(value);
    expect(output).toContain('\n  "clarification": {');
    const publicError = reportAiError(failure);
    expect(JSON.stringify(publicError)).not.toMatch(/validationDiagnostic|any.required|object.unknown|要重新记录/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test.each([true, false])('model JSON credentials stay hidden when valid JSON=%s', valid => {
    const content = JSON.stringify({ answer: '中文 English password=embedded-private-password',
      password: 'quoted-private-password', authorization: 'Bearer private-access-token',
      token: 'quoted-private-token', nested: { apiKey: config.apiKey, secret: 'quoted-private-secret' } });
    logModelValidationFailure(new Error('格式错误'), { stage: valid ? 'output-schema' : 'json-parse',
      content: valid ? content : content.slice(0, -1) }, [config.apiKey]);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain(valid ? '"stage":"output-schema"' : '"stage":"json-parse"');
    expect(output).toContain('中文 English'); expect(output).toContain('[redacted]');
    for (const value of [config.apiKey, 'embedded-private-password', 'quoted-private-password',
      'private-access-token', 'quoted-private-token', 'quoted-private-secret']) expect(output).not.toContain(value);
  });

  test('missing provider content is distinguished from invalid JSON without dumping the response envelope', () => {
    logModelValidationFailure(new Error('模型返回角色无效'), { stage: 'provider-envelope',
      content: { password: 'never-print-object', tool_calls: ['never-print-tools'] } });
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('"stage":"provider-envelope"');
    expect(output).toContain('[未返回字符串正文]');
    expect(output).not.toMatch(/never-print-object|never-print-tools/);
  });

  test('invalid tool arguments show the exact tool, field and normalized scope while credentials stay hidden', () => {
    const { validateTool } = require('../../src/modules/ai/service/v3Tools');
    const args = { datasetId: 'card-monthlyConsumption', direction: 'income' };
    let failure;
    try { validateTool('query_data', args, '2026-11-08'); } catch (caught) { failure = caught; }
    logToolValidationFailure(failure, { requestId: 'tool-check-request', round: 1, tool: 'query_data',
      content: JSON.stringify({ ...args, password: 'private-tool-password' }),
      effectiveContent: JSON.stringify({ ...args, groupBy: 'card', startDate: '2026-09-01', token: 'private-tool-token' }) });
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('[AI Tool Check]'); expect(output).toContain('[AI Tool Args]'); expect(output).toContain('[AI Effective Args]');
    expect(output).toContain('"tool":"query_data"'); expect(output).toContain('"path":"direction","rule":"dataset.direction"');
    expect(output).toContain('"stage":"tool-arguments"'); expect(output).toContain('2026-09-01');
    expect(output).not.toMatch(/private-tool-password|private-tool-token/);
    expect(JSON.stringify(reportAiError(failure))).not.toContain('dataset.direction');
  });

  test('console failure cannot interrupt the original validation rejection', () => {
    error.mockImplementation(() => { throw new Error('console unavailable'); });
    expect(() => logModelValidationFailure(new Error('原校验失败'), { content: '{"answer":"你好"}' })).not.toThrow();
  });

  test('long model output is bounded without splitting a Unicode character', () => {
    logModelValidationFailure(new Error('格式错误'), { stage: 'json-parse', content: '😀'.repeat(12001) });
    const output = error.mock.calls[0][0];
    expect(output).toContain('"responseTruncated":true'); expect(output).toContain('[正文已截断]');
    expect(output.match(/😀/gu)).toHaveLength(12000);
    expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  test('timeout is distinguished and retains cause without leaking key', async () => {
    axios.post.mockRejectedValue(Object.assign(new Error('timeout for private-fixture-key'), { code: 'ECONNABORTED' }));
    await expect(deepseekChat(config, [])).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', status: 504, causeCode: 'ECONNABORTED' });
    expect(error.mock.calls.flat().join(' ')).toContain('provider.error');
    expect(error.mock.calls.flat().join(' ')).not.toContain(config.apiKey);
  });

  test('status/code/message and request context survive mapping', async () => {
    axios.post.mockRejectedValue(Object.assign(new Error('HTTP 429'), { code: 'ERR_BAD_RESPONSE',
      response: { status: 429, data: { error: { code: 'overloaded', message: 'busy; private-fixture-key' } } } }));
    await withAiDiagnosticContext({ requestId: 'fixture-request', traceId: 'fixture-trace' }, async () => {
      await expect(deepseekChat(config, [])).rejects.toMatchObject({ code: 'AI_PROVIDER_RATE_LIMIT', providerStatus: 429,
        diagnostics: { providerStatus: 429, providerCode: 'overloaded', providerMessage: 'busy; [redacted]' } });
    });
    const lines = error.mock.calls.flat().join(' ');
    expect(lines).toContain('fixture-request'); expect(lines).toContain('fixture-trace'); expect(lines).not.toContain(config.apiKey);
  });

  test('Chinese bytes split across chunks remain intact in final content', async () => {
    const stream = new PassThrough(); axios.post.mockResolvedValue({ data: stream });
    const pending = deepseekChatStream(config, []); await Promise.resolve();
    const content = '中文金额39.91';
    const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
    const boundary = bytes.indexOf(Buffer.from('中')) + 1;
    stream.write(bytes.subarray(0, boundary)); stream.write(bytes.subarray(boundary));
    stream.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    await expect(pending).resolves.toMatchObject({ message: { content } });
    expect(log.mock.calls.flat().join(' ')).toContain('provider.first_byte');
  });

  test('nested credentials are scrubbed before audit serialization', () => {
    const value = sanitizeDiagnosticValue({ apiKey: 'secret-value', content: 'Bearer abcdef123456 sk-fixture-credential' });
    expect(value.apiKey).toBe('[redacted]'); expect(value.content).not.toContain('abcdef123456');
    expect(value.content).not.toContain('sk-fixture-credential');
    expect(redactSecretText('arbitrary-private-key', ['arbitrary-private-key'])).toBe('[redacted]');
  });

  test('database diagnostics retain SQL state without serializing SQL/config', () => {
    const failure = Object.assign(new Error('Unknown column amount'), { code: 'ER_BAD_FIELD_ERROR', sqlState: '42S22',
      sql: 'SELECT private data', config: { headers: { Authorization: 'Bearer private-fixture-key' } } });
    const row = reportAiError(failure, { phase: 'http' });
    expect(row).toMatchObject({ code: 'ER_BAD_FIELD_ERROR', sqlState: '42S22', phase: 'http' });
    expect(JSON.stringify(row)).not.toContain('SELECT private data'); expect(JSON.stringify(row)).not.toContain(config.apiKey);
  });

  test('provider error echoes cannot leak uploaded image bytes', () => {
    const imageText = 'data:image/jpeg;base64,U3ludGhldGljUHJpdmF0ZUltYWdl';
    const row = reportAiError(Object.assign(new Error('invalid image ' + imageText), {
      code: 'ERR_BAD_RESPONSE', response: { status: 400, data: { error: { message: imageText } } },
    }));
    expect(JSON.stringify(row)).not.toContain(imageText);
    expect(row).toMatchObject({ providerStatus: 400, causeCode: 'ERR_BAD_RESPONSE', providerMessage: '[redacted-image]' });
  });

  test.each([false, true])('audit storage failure (synchronous=%s) correlates request and trace without logging payload or SQL echo', async synchronous => {
    const failure = () => {
      throw Object.assign(new Error('SQL private-remark private-fixture-key'), { code: 'ER_BAD_FIELD_ERROR', sqlState: '42S22', errno: 1054,
        sql: 'INSERT full private payload' });
    };
    const store = createCallLogStore({ executor: { execute: synchronous ? failure : async () => failure() } });
    await withAiDiagnosticContext({ traceId: 'audit-trace', requestId: 'context-request' }, async () => {
      store.record({ userId: 'owner', requestId: 'audit-request', conversationId: 'audit-conversation',
        lane: 'ocr', phase: 'provider', providerHost: 'provider.invalid', request: { private: 'private-remark private-fixture-key' } });
      await new Promise(resolve => setImmediate(resolve));
    });
    const lines = error.mock.calls.flat().join(' ');
    expect(lines).toContain('audit-write'); expect(lines).toContain('audit-trace'); expect(lines).toContain('audit-request');
    expect(lines).toContain('audit-conversation'); expect(lines).toContain('42S22'); expect(lines).toContain('ER_BAD_FIELD_ERROR');
    for (const secret of ['private-remark', 'private-fixture-key', 'INSERT full private payload']) expect(lines).not.toContain(secret);
  });
});
