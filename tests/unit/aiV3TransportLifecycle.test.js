jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live DB forbidden'); }), getConnection: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw Error('Live SQL pool forbidden'); }) }));
jest.mock('../../src/modules/ai/service/config', () => ({ ...jest.requireActual('../../src/modules/ai/service/config'), turnTimeoutMs: jest.fn(() => 120000) }));
const { EventEmitter } = require('events');
const { fixture, id } = require('../fixtures/aiV3MemoryFixture');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const { createRequestGuard } = require('../../src/modules/ai/service/requestGuard');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { createAiRouter } = require('../../src/modules/ai/api');
const { turnTimeoutMs } = require('../../src/modules/ai/service/config');
const { AiError } = require('../../src/modules/ai/service/errors');
const owner = 'offline-memory-owner';
const plain = content => ({ role: 'assistant', content });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => jest.advanceTimersByTimeAsync(0);
const outcome = promise => promise.then(result => ({ result }), error => ({ error }));
function setup() {
  const f = fixture([plain('你好，可以继续交流。')], { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.requestGuard = createMemoryRequestGuard();
  f.state.conversationSyncStore = { begin: jest.fn(async () => ({ token: 'offline-token' })), update: jest.fn(async () => {}) };
  const input = { requestId: id(), conversationId: f.conversationId, message: '你好', mode: 'chat', consent: true };
  return { ...f, input, send: (overrides = {}, emit, options) => f.service.chat(owner, { ...input, ...overrides }, emit, options) };
}
// Shared in-memory message rows exercise the production appendFailure and
// claimRetry transaction paths, instead of asserting against a mocked claim.
function persistentFailures(f) {
  const rows = [], calls = [];
  const executor = { async getConnection() {
    let checkpoint;
    return { beginTransaction: async () => { checkpoint = structuredClone(rows); }, commit: async () => { checkpoint = null; },
      rollback: async () => { if (checkpoint) rows.splice(0, rows.length, ...checkpoint); }, release() {}, execute: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT') && sql.includes('FROM ai_conversation')) return [params.includes(owner) && params.includes(f.conversationId) ? [{ id: f.conversationId }] : []];
        if (sql.startsWith('SELECT') && sql.includes('FROM ai_message')) {
          const [conversationId, userId, requestId] = params;
          return [structuredClone(rows.filter(row => row.conversation_id === conversationId && row.user_id === userId &&
            [row.meta.requestId, row.meta.failure?.requestId, row.meta.turnId].includes(requestId) && (!sql.includes("role = 'assistant'") || row.role === 'assistant')))];
        }
        if (sql.startsWith('INSERT INTO ai_message')) {
          rows.push({ id: rows.length + 1, conversation_id: params[0], user_id: params[1], role: sql.includes("'user'") ? 'user' : 'assistant', content: params[2], meta: JSON.parse(params[3]) });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE ai_message')) {
          const row = rows.find(item => item.id === params[1] && item.conversation_id === params[2] && item.user_id === params[3] && item.role === 'assistant');
          if (!row || row.meta.continuedBy) return [{ affectedRows: 0 }];
          row.meta.continuedBy = params[0]; return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE ai_conversation')) return [{ affectedRows: 1 }];
        throw Error('Unexpected failure fixture SQL: ' + sql);
      } };
  } };
  const store = createConversationStore({ executor });
  f.state.conversationStore.appendFailure = jest.fn(store.appendFailure);
  f.state.conversationStore.claimRetry = jest.fn(store.claimRetry);
  return { rows, calls, store };
}
class Response extends EventEmitter {
  constructor() { super(); this.writableEnded = false; this.destroyed = false; this.headersSent = false; this.headers = {}; this.frames = []; }
  status(value) { this.statusCode = value; return this; }
  set(key, value) { Object.assign(this.headers, typeof key === 'object' ? key : { [key]: value }); return this; }
  flushHeaders() { this.headersSent = true; }
  write(frame) { this.frames.push(frame); return true; }
  end() { this.writableEnded = true; }
  json(value) { this.jsonValue = value; this.headersSent = true; this.end(); }
}
function stream(f) {
  const router = createAiRouter({ guard: (_, __, next) => next(), service: {}, business: {}, agent: f.service });
  const handler = router.stack.find(layer => layer.route?.path === '/v3/chat/stream').route.stack[0].handle;
  const res = new Response(), req = { body: { data: f.input }, userId: owner, aiStartedAt: Date.now(), aiTraceId: 'offline', res };
  return { res, pending: handler(req, res) };
}
beforeEach(() => { jest.useFakeTimers(); turnTimeoutMs.mockReturnValue(120000); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('SSE headers and heartbeat start while sync preparation is pending; disconnect prevents provider admission', async () => {
  const f = setup(), gate = deferred();
  const run = jest.spyOn(f.state.requestGuard, 'run');
  f.state.conversationSyncStore.begin.mockReturnValue(gate.promise);
  const { res, pending } = stream(f);
  await flush();
  expect(res.headersSent).toBe(true);
  expect(res.headers['Content-Type']).toContain('text/event-stream');
  expect(res.frames[0]).toContain('"stage":"queued"');
  await jest.advanceTimersByTimeAsync(15000);
  expect(res.frames).toContain(': ping\n\n');
  res.destroyed = true; res.emit('close'); await pending;
  expect(run).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  expect(f.state.conversationSyncStore.begin.mock.calls[0][5].signal.aborted).toBe(true);
  gate.resolve({ token: 'late-offline-token' }); await flush();
  expect(f.state.conversationSyncStore.update).toHaveBeenCalledWith({ token: 'late-offline-token' }, 'failed', 'failed', expect.objectContaining({ code: 'AI_PREPARATION_CANCELLED' }));
});

test('hanging sync begin consumes the shared turn deadline and late completion cannot invoke a provider', async () => {
  turnTimeoutMs.mockReturnValue(50);
  const f = setup(), gate = deferred(), run = jest.spyOn(f.state.requestGuard, 'run');
  f.state.conversationSyncStore.begin.mockReturnValue(gate.promise);
  const pending = outcome(f.send()); await flush();
  await jest.advanceTimersByTimeAsync(50);
  expect((await pending).error).toMatchObject({ code: 'AI_PREPARATION_TIMEOUT', requestId: f.input.requestId, providerCalls: 0, notAdmitted: true });
  expect(f.state.conversationSyncStore.begin.mock.calls[0][5].signal.aborted).toBe(true);
  gate.resolve({ token: 'late-offline-token' }); await flush();
  expect(run).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  expect(f.state.conversationSyncStore.update).toHaveBeenCalledWith({ token: 'late-offline-token' }, 'failed', 'failed', expect.objectContaining({ code: 'AI_PREPARATION_TIMEOUT' }));
});

test('default session resolution is bounded and an already disconnected caller does no preparation SQL', async () => {
  turnTimeoutMs.mockReturnValue(50);
  const f = setup(), gate = deferred();
  f.state.conversationStore.session.mockReturnValue(gate.promise);
  const pending = outcome(f.send({ conversationId: undefined })); await flush();
  await jest.advanceTimersByTimeAsync(50);
  expect((await pending).error.code).toBe('AI_PREPARATION_TIMEOUT');
  gate.resolve({ id: f.conversationId }); await flush();
  expect(f.state.conversationSyncStore.begin).not.toHaveBeenCalled();
  const disconnected = new AbortController(); disconnected.abort();
  await expect(f.send({}, undefined, { signal: disconnected.signal })).rejects.toMatchObject({ code: 'AI_PREPARATION_CANCELLED', providerCalls: 0, notAdmitted: true });
  expect(f.state.conversationSyncStore.begin).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
});

test('a preparation timeout reaches SSE as an explicit unadmitted failure and a new request needs no failed parent', async () => {
  turnTimeoutMs.mockReturnValue(50);
  const f = setup(), gate = deferred();
  f.state.conversationSyncStore.begin.mockReturnValueOnce(gate.promise);
  const { res, pending } = stream(f); await flush(); await jest.advanceTimersByTimeAsync(50); await pending;
  const frame = res.frames.find(value => value.includes('event: error'));
  expect(JSON.parse(frame.split('data: ')[1])).toMatchObject({ code: 'AI_PREPARATION_TIMEOUT', providerCalls: 0, notAdmitted: true, requestId: f.input.requestId });
  await expect(f.state.requestGuard.get(owner, f.input.requestId)).rejects.toMatchObject({ code: 'AI_REQUEST_NOT_FOUND' });
  expect(f.history).toHaveLength(0); expect(f.provider).not.toHaveBeenCalled();
  f.state.conversationStore.claimRetry = jest.fn();
  const result = await f.send({ requestId: id() });
  expect(result.answer).toBe('你好，可以继续交流。'); expect(result.request).not.toHaveProperty('retryOf');
  expect(f.state.conversationStore.claimRetry).not.toHaveBeenCalled(); expect(f.provider).toHaveBeenCalledTimes(1);
  gate.resolve({ token: 'late-offline-token' }); await flush();
});

test.each([
  ['AI_PREPARATION_TIMEOUT', 0, true, true],
  ['AI_PREPARATION_CANCELLED', 0, true, true],
  ['AI_PREPARATION_TIMEOUT', 0, undefined, false],
  ['AI_PREPARATION_TIMEOUT', 1, true, false],
  ['AI_TURN_TIMEOUT', 0, true, false],
  ['AI_REQUEST_CANCELLED', 0, true, false],
  ['AI_PROVIDER_FAILED', 0, true, false],
])('the HTTP envelope only exposes the strict preparation marker: %s/%s/%s', async (code, providerCalls, notAdmitted, expected) => {
  const error = Object.assign(new AiError('合成错误', 504, code), { providerCalls, notAdmitted, requestId: id() });
  const router = createAiRouter({ guard: (_, __, next) => next(), service: {}, business: {}, agent: { chat: async () => { throw error; } } });
  const handler = router.stack.find(layer => layer.route?.path === '/v3/chat/stream').route.stack[0].handle;
  const res = new Response(), req = { body: {}, userId: owner, aiStartedAt: Date.now(), aiTraceId: 'offline', res };
  await handler(req, res);
  expect(res.jsonValue.notAdmitted).toBe(expected ? true : undefined);
});

test('a real admitted guard timeout keeps its durable failure and never acquires the preparation marker', async () => {
  turnTimeoutMs.mockReturnValue(50);
  const f = setup(), providerGate = deferred();
  f.provider.mockReturnValue(providerGate.promise);
  const pending = outcome(f.send()); await flush(); await jest.advanceTimersByTimeAsync(50);
  expect(await f.state.requestGuard.get(owner, f.input.requestId)).toMatchObject({ status: 'failed', providerCalls: 1, error: { code: 'AI_TURN_TIMEOUT' } });
  providerGate.resolve(plain('迟到内容')); await flush();
  const error = (await pending).error;
  expect(error).toMatchObject({ code: 'AI_TURN_TIMEOUT', providerCalls: 1 }); expect(error).not.toHaveProperty('notAdmitted');
  expect(f.history.find(turn => turn.role === 'assistant')).toMatchObject({ failure: { code: 'AI_TURN_TIMEOUT' } });
});

test('time spent preparing is deducted from guard work rather than granting a second full turn budget', async () => {
  turnTimeoutMs.mockReturnValue(50);
  const f = setup(), gate = deferred(), run = jest.spyOn(f.state.requestGuard, 'run');
  f.state.conversationSyncStore.begin.mockReturnValue(gate.promise);
  const pending = f.send(); await flush(); await jest.advanceTimersByTimeAsync(10);
  gate.resolve({ token: 'offline' }); await pending;
  expect(run.mock.calls[0][1].timeoutMs).toBe(40);
  expect((await f.state.requestGuard.get(owner, f.input.requestId)).status).toBe('completed');
});

test('a stalled progress write cannot delay provider execution or terminal completion', async () => {
  const f = setup(), progress = deferred();
  f.state.conversationSyncStore.update.mockImplementation(async (_, status) => { if (status === 'running') await progress.promise; });
  const result = await f.send();
  expect(result.answer).toBe('你好，可以继续交流。'); expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.state.conversationSyncStore.update.mock.calls.map(call => call[1])).toContain('completed');
  progress.resolve(); await flush();
  const afterTerminal = f.state.conversationSyncStore.update.mock.calls.slice(f.state.conversationSyncStore.update.mock.calls.findIndex(call => call[1] === 'completed') + 1);
  expect(afterTerminal).toEqual([]);
});

test('a stalled completed activity update cannot hold SSE done, alter a durable receipt, or rerun a replay', async () => {
  const f = setup(), completed = deferred();
  f.state.conversationSyncStore.update.mockImplementation(async (_, status) => { if (status === 'completed') await completed.promise; });
  const { res, pending } = stream(f); await pending;
  expect(res.writableEnded).toBe(true); expect(res.frames.some(frame => frame.includes('event: done'))).toBe(true);
  const receipt = await f.state.requestGuard.get(owner, f.input.requestId);
  expect(receipt).toMatchObject({ status: 'completed', providerCalls: 1, result: { request: { requestId: f.input.requestId } } });
  expect(await f.send()).toEqual(receipt.result); expect(f.provider).toHaveBeenCalledTimes(1);
  await expect(f.send({ message: 'Hello' })).rejects.toMatchObject({ code: 'AI_REQUEST_CONFLICT' });
  expect(f.provider).toHaveBeenCalledTimes(1);
  completed.resolve(); await flush();
});

test('failed sync and history share one short delivery window and late history retains the retry chain', async () => {
  const f = setup(), parent = id(), historyGate = deferred(), syncGate = deferred();
  f.state.conversationStore.claimRetry = jest.fn(async () => {});
  const append = f.state.conversationStore.appendFailure.getMockImplementation();
  f.state.conversationStore.appendFailure.mockImplementation(async (...args) => { await historyGate.promise; return append(...args); });
  f.state.conversationSyncStore.update.mockImplementation(async (_, status) => { if (status === 'failed') await syncGate.promise; });
  f.provider.mockRejectedValue(new AiError('合成供应商失败', 502, 'AI_PROVIDER_FAILED'));
  let delivered;
  const pending = outcome(f.send({ retryOf: parent })).then(value => { delivered = value; return value; });
  await flush();
  expect(await f.state.requestGuard.get(owner, f.input.requestId)).toMatchObject({ status: 'failed', error: { code: 'AI_PROVIDER_FAILED' } });
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledWith(owner, f.conversationId, expect.objectContaining({ requestId: f.input.requestId, retryOf: parent, message: f.input.message }));
  await jest.advanceTimersByTimeAsync(999); expect(delivered).toBeUndefined();
  await jest.advanceTimersByTimeAsync(1); expect((await pending).error.code).toBe('AI_PROVIDER_FAILED');
  expect(f.history).toHaveLength(0);
  historyGate.resolve(); syncGate.resolve(); await flush();
  expect(f.history).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', turnId: f.input.requestId }), expect.objectContaining({ role: 'assistant', turnId: f.input.requestId, failure: { code: 'AI_PROVIDER_FAILED' } })]));
  f.provider.mockResolvedValue(plain('继续原问题。'));
  f.state.conversationStore.claimRetry.mockImplementation(async (_, __, claim) => {
    expect(f.history.some(turn => turn.turnId === claim.retryOf && turn.role === 'assistant' && turn.failure)).toBe(true);
  });
  const next = await f.send({ requestId: id(), retryOf: f.input.requestId });
  expect(next.request.retryOf).toBe(f.input.requestId); expect(f.provider).toHaveBeenCalledTimes(2);
});

test('normal failure history is saved before rejection, while disconnect stops waiting for a stalled append', async () => {
  const f = setup();
  f.provider.mockRejectedValue(new AiError('合成供应商失败', 502, 'AI_PROVIDER_FAILED'));
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
  expect(f.history.find(turn => turn.role === 'assistant')).toMatchObject({ turnId: f.input.requestId, failure: { code: 'AI_PROVIDER_FAILED' } });
  const disconnected = new AbortController(), gate = deferred();
  f.state.conversationStore.appendFailure.mockReturnValue(gate.promise);
  const input = { requestId: id() }, pending = outcome(f.send(input, undefined, { signal: disconnected.signal })); await flush();
  disconnected.abort(); await flush();
  expect((await pending).error.code).toBe('AI_PROVIDER_FAILED');
  expect(await f.state.requestGuard.get(owner, input.requestId)).toMatchObject({ status: 'failed', error: { code: 'AI_PROVIDER_FAILED' } });
  gate.resolve(); await flush();
});

test('cancellation during guard SQL admission reconstructs the exact failed parent and a production retry claim succeeds', async () => {
  const f = setup(), saved = persistentFailures(f), reached = deferred(), claimGate = deferred(), disconnected = new AbortController();
  const executor = f.state.requestGuard.fixtureExecutor, getConnection = executor.getConnection;
  let hold = true;
  executor.getConnection = async () => {
    const conn = await getConnection(), execute = conn.execute;
    conn.execute = async (sql, params) => {
      if (hold && sql.startsWith('UPDATE ai_request_lane SET active_request_id=?')) { hold = false; reached.resolve(); await claimGate.promise; }
      return execute(sql, params);
    };
    return conn;
  };
  const proof = jest.spyOn(f.state.requestGuard, 'failureForInput');
  const pending = outcome(f.send({}, undefined, { signal: disconnected.signal }));
  await reached.promise; disconnected.abort(); claimGate.resolve();
  expect((await pending).error).toMatchObject({ code: 'AI_REQUEST_CANCELLED', providerCalls: 0 }); await flush();
  expect(f.state.conversationStore.open).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  expect(proof).toHaveBeenCalledWith(owner, f.input.requestId, { lane: 'v3-chat', input: f.input });
  expect(saved.rows).toHaveLength(2);
  expect(saved.rows[0]).toMatchObject({ role: 'user', content: f.input.message, meta: { requestId: f.input.requestId } });
  expect(saved.rows[1].meta.failure).toMatchObject({ requestId: f.input.requestId, status: 'failed', code: 'AI_REQUEST_CANCELLED' });
  await expect(f.send({ message: '盗用同编号的新原话' })).rejects.toMatchObject({ code: 'AI_REQUEST_CONFLICT' });
  expect(saved.rows).toHaveLength(2); expect(saved.rows[0].content).toBe(f.input.message);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' }); expect(saved.rows).toHaveLength(2);
  const childId = id(), result = await f.send({ requestId: childId, retryOf: f.input.requestId });
  expect(result.request.retryOf).toBe(f.input.requestId); expect(saved.rows[1].meta.continuedBy).toBe(childId);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('a zero-call timeout before open resolves reconstructs a failed parent and late open cannot claim a retry', async () => {
  turnTimeoutMs.mockReturnValue(50);
  const f = setup(), saved = persistentFailures(f), openGate = deferred();
  f.state.conversationStore.open.mockReturnValueOnce(openGate.promise);
  const pending = outcome(f.send({ retryOf: id() })); await flush(); await jest.advanceTimersByTimeAsync(50);
  expect(await f.state.requestGuard.get(owner, f.input.requestId)).toMatchObject({ status: 'failed', providerCalls: 0, error: { code: 'AI_TURN_TIMEOUT' } });
  await jest.advanceTimersByTimeAsync(1000);
  expect((await pending).error).toMatchObject({ code: 'AI_TURN_TIMEOUT', providerCalls: 0 });
  expect(saved.rows).toHaveLength(2); expect(saved.rows[0].content).toBe('你好'); expect(saved.rows[1].meta).not.toHaveProperty('retryOf');
  openGate.resolve({ id: f.conversationId, history: [] }); await flush();
  expect(f.state.conversationStore.claimRetry).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  const childId = id(), child = await f.send({ requestId: childId, retryOf: f.input.requestId });
  expect(child.request.retryOf).toBe(f.input.requestId); expect(saved.rows[1].meta.continuedBy).toBe(childId);
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('slow authoritative failure confirmation shares the existing delivery window and still saves its parent afterward', async () => {
  const f = setup(), saved = persistentFailures(f), gate = deferred();
  f.state.conversationStore.open.mockRejectedValueOnce(new AiError('合成会话读取超时', 504, 'AI_TURN_TIMEOUT'));
  const original = f.state.requestGuard.failureForInput;
  jest.spyOn(f.state.requestGuard, 'failureForInput').mockImplementation(async (...args) => { await gate.promise; return original(...args); });
  let delivered;
  const pending = outcome(f.send()).then(value => { delivered = value; return value; }); await flush();
  await jest.advanceTimersByTimeAsync(999); expect(delivered).toBeUndefined();
  await jest.advanceTimersByTimeAsync(1); expect((await pending).error.code).toBe('AI_TURN_TIMEOUT'); expect(saved.rows).toHaveLength(0);
  gate.resolve(); await flush(); expect(saved.rows).toHaveLength(2);
  expect(saved.rows[1].meta.failure.requestId).toBe(f.input.requestId); expect(f.provider).not.toHaveBeenCalled();
});

test('failure reconstruction binds the default conversation filled before guard admission, not the incomplete caller input', async () => {
  const f = setup(), saved = persistentFailures(f), proof = jest.spyOn(f.state.requestGuard, 'failureForInput');
  f.state.conversationStore.open.mockRejectedValueOnce(new AiError('合成会话读取失败', 504, 'AI_TURN_TIMEOUT'));
  await expect(f.send({ conversationId: undefined })).rejects.toMatchObject({ code: 'AI_TURN_TIMEOUT', providerCalls: 0 });
  expect(f.state.conversationStore.session).toHaveBeenCalledWith(owner, 'default');
  expect(proof).toHaveBeenCalledWith(owner, f.input.requestId, { lane: 'v3-chat', input: f.input });
  expect(saved.rows).toHaveLength(2); expect(saved.rows[0]).toMatchObject({ conversation_id: f.conversationId, content: f.input.message });
  await expect(f.state.requestGuard.failureForInput(owner, f.input.requestId, { lane: 'v3-chat', input: { ...f.input, conversationId: undefined } })).resolves.toBeNull();
  expect(f.provider).not.toHaveBeenCalled();
});

test.each(['AI_REQUEST_BUSY', 'AI_RATE_LIMIT'])('a real temporary guard refusal creates no failed parent: %s', async code => {
  const f = setup(), saved = persistentFailures(f), providerGate = deferred();
  f.state.requestGuard = createRequestGuard({ executor: f.state.requestGuard.fixtureExecutor, queueWaitMs: 0, maxRequests: code === 'AI_RATE_LIMIT' ? 1 : 6 });
  const proof = jest.spyOn(f.state.requestGuard, 'failureForInput');
  if (code === 'AI_REQUEST_BUSY') f.provider.mockReturnValueOnce(providerGate.promise);
  const first = f.send(); await flush();
  if (code === 'AI_RATE_LIMIT') await first;
  await expect(f.send({ requestId: id() })).rejects.toMatchObject({ code, providerCalls: 0 });
  expect(saved.rows).toHaveLength(0); expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled(); expect(proof).not.toHaveBeenCalled();
  providerGate.resolve(plain('合成正常结束')); await first;
});

test.each(['AI_RETRY_INVALID', 'AI_RETRY_CONSUMED', 'AI_RETRY_UNAVAILABLE'])('retry rejection cannot use the fallback to fabricate another failed parent: %s', async code => {
  const f = setup(), saved = persistentFailures(f);
  f.state.conversationStore.claimRetry.mockRejectedValue(new AiError('合成拒绝', 409, code));
  const proof = jest.spyOn(f.state.requestGuard, 'failureForInput');
  await expect(f.send({ retryOf: id() })).rejects.toMatchObject({ code });
  expect(saved.rows).toHaveLength(0); expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled(); expect(proof).not.toHaveBeenCalled();
  expect(f.provider).not.toHaveBeenCalled();
});
