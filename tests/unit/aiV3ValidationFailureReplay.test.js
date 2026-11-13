const crypto = require('crypto');

// Recorded failures run entirely offline, with no provider or database fallback.
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden in validation replay'); }),
}));
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live database forbidden in validation replay'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden in validation replay'); }),
}));

const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const liveDb = require('../../src/common/config/db');
const { reportAiError } = require('../../src/modules/ai/service/diagnostics');

const recordedMessage = '我今天去超市买，那笔记录算错钱了，不是 100 多块钱，好像是 89 块。';
const recordedResult = {
  clarification: {
    items: [{
      kind: 'transaction.create',
      fields: { direction: 0, amount: '89.00', currency: 'CNY', transDate: '2026-11-08',
        categoryRef: null, accountRef: null, payMethod: '银行卡', remark: '超市买生活物品（更正金额）' },
      evidence: { sourceTurn: 12, quote: recordedMessage },
    }],
    question: '已入账的那笔超市记录是 123.60 元，目前我没有直接修改或删除已入账交易的权限。要按 89.00 元重新记一笔更正草稿吗？原 123.60 元那笔需要你在记账入口删除或冲正，确认后我再生成新草稿。',
  },
};
const packet = content => ({ role: 'assistant', content });
function fixture(responses) {
  const conversationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const history = [], audits = [];
  const fail = label => jest.fn(() => { throw new Error(`Unexpected replay ${label}`); });
  const executor = { execute: fail('SQL'), getConnection: fail('connection') };
  const repository = { query: fail('repository read') };
  const proposals = { create: fail('proposal write') };
  const conversationStore = {
    open: jest.fn(async () => ({ id: conversationId, history, latestDraftId: null })),
    append: fail('successful history append'),
    appendFailure: jest.fn(async (_, __, payload) => history.push({ role: 'user', content: payload.message },
      { role: 'assistant', content: payload.notice, failure: { code: payload.errorCode } })),
  };
  const state = {
    config: { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://offline.invalid',
      model: 'recorded-validation-response', apiKey: 'offline-unused-key', dailyProviderLimit: 100 },
    connectionId: crypto.randomUUID(),
    businessPolicy: { enabled: true, domains: ['finance'], actions: ['transaction.create'] },
    conversationStore,
    requestGuard: {
      run: jest.fn(async (_, request, work) => {
        const budget = { requestId: request.requestId, calls: 0, check: jest.fn(), tool: jest.fn(),
          invoke: async fn => {
            if (++budget.calls > request.maxProviderCalls) throw new Error('Replay provider budget exhausted');
            return fn();
          } };
        return work(budget);
      }),
      saveV3Recovery: fail('recovery receipt write'),
    },
  };
  const legacy = { getRuntime: () => state, prepareTransactionProposal: fail('transaction preparation'),
    persistTransactionBatch: fail('transaction persistence') };
  const provider = jest.fn(async () => {
    const next = responses[provider.mock.calls.length - 1];
    if (!next) throw new Error('Unexpected additional provider retry');
    return structuredClone(next);
  });
  const memoryStore = { list: jest.fn(async () => ({ files: [], count: 0, truncated: false, warnings: [] })) };
  const historyReader = { search: fail('history search'), read: fail('history read') };
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor, repository,
    proposals, provider, previews: {}, grants: { requireCoverage: jest.fn(async () => {}) },
    callLog: { record: entry => audits.push(entry) }, memoryStore, historyReader,
    now: () => new Date('2026-11-08T13:30:00Z') });
  const send = () => service.chat('offline-validation-owner', { requestId, conversationId,
    message: recordedMessage, consent: true });
  return { send, requestId, conversationId, state, legacy, provider, executor, repository, proposals, history, audits };
}

let consoleError;
beforeEach(() => { consoleError = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });
afterAll(() => {
  expect(deepseekChat).not.toHaveBeenCalled();
  expect(liveDb.execute).not.toHaveBeenCalled();
  expect(liveDb.getConnection).not.toHaveBeenCalled();
});

function diagnostic() {
  const outputs = consoleError.mock.calls.map(([value]) => value).filter(value => value.startsWith('[AI Check] '));
  expect(outputs).toHaveLength(1);
  const [firstLine] = outputs[0].split('\n');
  return { header: JSON.parse(firstLine.slice('[AI Check] '.length)), text: outputs[0] };
}
function noWritesOrDiagnosticLeak(f, error) {
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(f.proposals.create).not.toHaveBeenCalled();
  expect(f.executor.getConnection).not.toHaveBeenCalled();
  expect(f.executor.execute).not.toHaveBeenCalled();
  expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
  const failurePayload = f.state.conversationStore.appendFailure.mock.calls[0][2];
  expect(failurePayload).toMatchObject({ requestId: f.requestId, errorCode: error.code });
  expect(JSON.stringify({ error, failurePayload, history: f.history })).not.toMatch(/validationDiagnostic|any\.required|object\.unknown|"clarification"|\[AI Result\]/);
  // Existing user-configured provider records may include the raw reply. New
  // console diagnostics must not be added to their metadata or failure records.
  expect(f.audits).toHaveLength(f.provider.mock.calls.length);
  for (const audit of f.audits) {
    expect(audit).toMatchObject({ phase: 'provider', status: 'ok' });
    expect(audit).not.toHaveProperty('validationDiagnostic');
    expect(audit).not.toHaveProperty('diagnostics');
    expect(audit.response).not.toHaveProperty('validationDiagnostic');
  }
}

test('the recorded missing answer and unknown clarification question print exact rules, reject once, and create no transaction', async () => {
  const content = JSON.stringify(recordedResult);
  const f = fixture([packet(content), packet(content)]);
  const error = await f.send().catch(value => value);
  expect(error).toMatchObject({ code: 'AI_INVALID_RESULT', status: 502,
    message: '模型生成的答复或草稿结构不符合允许格式，本轮没有生成可执行草稿' });
  const { header, text } = diagnostic();
  expect(header).toMatchObject({ requestId: f.requestId, conversationId: f.conversationId,
    model: 'recorded-validation-response', round: 2, stage: 'output-schema', code: 'AI_INVALID_RESULT' });
  expect(header.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'answer', rule: 'any.required', actualType: 'undefined' }),
    expect.objectContaining({ path: 'clarification.question', rule: 'object.unknown', actualType: 'string' }),
  ]));
  expect(text).toContain('[AI Result] {');
  expect(text).toContain('"amount": "89.00"');
  expect(text).toContain('"question":');
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.provider.mock.calls[1][2]).toEqual([]);
  noWritesOrDiagnosticLeak(f, error);
  // The ordinary HTTP error logger retains the public message, not the console
  // field diagnostic or response body even when called with the same error.
  const publicDiagnostic = reportAiError(error, { phase: 'v3-http' });
  expect(JSON.stringify(publicDiagnostic)).not.toMatch(/validationDiagnostic|any\.required|object\.unknown|clarification\.question|"amount"/);
});

test('malformed JSON logs json-parse separately without attempting repair or retry', async () => {
  const content = '{"answer":"请核对","clarification":{"question":"缺了右括号"}';
  const f = fixture([packet(content), packet(content)]);
  const error = await f.send().catch(value => value);
  expect(error).toMatchObject({ code: 'AI_INVALID_RESULT', status: 502 });
  const { header, text } = diagnostic();
  expect(header).toMatchObject({ stage: 'json-parse', round: 2, issues: [] });
  expect(text).toContain(`[AI Result] ${content}`);
  expect(f.provider).toHaveBeenCalledTimes(2);
  noWritesOrDiagnosticLeak(f, error);
});

test.each([
  ['invalid role', { role: 'user', content: '{"answer":"角色错误"}' }, '模型返回角色无效'],
  ['non-string content', { role: 'assistant', content: { answer: '错误正文类型' } }, '模型未返回有效结构化答复'],
])('provider envelope %s logs the original phase and stops at the first response', async (_, response, message) => {
  const f = fixture([response]);
  const error = await f.send().catch(value => value);
  expect(error).toMatchObject({ code: 'AI_INVALID_RESULT', status: 502, message });
  expect(diagnostic().header).toMatchObject({ stage: 'provider-envelope', round: 1, issues: [] });
  expect(f.provider).toHaveBeenCalledTimes(1);
  noWritesOrDiagnosticLeak(f, error);
});

test('an unavailable console preserves the validation error and cannot start a retry or write', async () => {
  consoleError.mockImplementation(() => { throw new Error('console unavailable'); });
  const content = JSON.stringify(recordedResult);
  const f = fixture([packet(content), packet(content)]);
  const error = await f.send().catch(value => value);
  expect(error).toMatchObject({ code: 'AI_INVALID_RESULT', status: 502 });
  expect(error.message).not.toContain('console unavailable');
  expect(consoleError).toHaveBeenCalledTimes(1);
  expect(f.provider).toHaveBeenCalledTimes(2);
  noWritesOrDiagnosticLeak(f, error);
});
