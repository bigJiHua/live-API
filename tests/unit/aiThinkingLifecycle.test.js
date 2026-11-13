jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden'); }),
}));
const publicDb = require('../../src/common/config/db');
const { createReasoningLifecycle } = require('../../src/modules/ai/service/thinkingLifecycle');
const { fixture, calls, id } = require('../fixtures/aiV3MemoryFixture');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const memoryStore = () => ({ list: jest.fn(async () => ({ files: [], warnings: [], count: 0, totalBytes: 0 })) });
const lifecycleEvents = events => events.filter(item => item.event === 'reasoning_status').map(item => item.data);
function recorder({ thinkingRequested = true, round = 1, minIntervalMs = 750 } = {}) {
  let time = 1000;
  const events = [];
  const requestId = id();
  const lifecycle = createReasoningLifecycle({ round, requestId, thinkingRequested, minIntervalMs,
    clock: () => time, onEvent: (event, data) => events.push({ event, data }) });
  return { lifecycle, events, requestId, setTime: value => { time = value; } };
}
const send = (f, events, requestId = id(), message = '你好') => f.service.chat('owner', {
  requestId, conversationId: f.conversationId, mode: 'analysis', message, consent: true,
}, (event, data) => events.push({ event, data }));

test('an explicitly requested thinking phase starts once before receiving model text', () => {
  const r = recorder();
  r.lifecycle.start(); r.lifecycle.start();
  expect(r.events).toEqual([{ event: 'reasoning_status', data: {
    requestId: r.requestId, round: 1, state: 'started', elapsedMs: 0, observed: false,
  } }]);
});

test('ordinary providers do not invent a thinking phase when no reasoning was observed', () => {
  const r = recorder({ thinkingRequested: false });
  r.lifecycle.start();
  r.lifecycle.delta({ type: 'content', text: '正文' });
  r.lifecycle.delta({ type: 'reasoning', text: '   ' });
  r.lifecycle.delta({ type: 'reasoning', text: { content: 'bad type' } });
  r.lifecycle.delta({ type: 'usage', text: 'not reasoning' });
  r.lifecycle.finish({ role: 'assistant', content: '正文' });
  expect(r.events).toEqual([]);
});

test('the first reasoning delta is immediate, later working updates are throttled', () => {
  const r = recorder();
  r.lifecycle.start();
  r.setTime(1010); r.lifecycle.delta({ type: 'reasoning', text: 'password=' });
  r.setTime(1740); r.lifecycle.delta({ type: 'reasoning', text: 'synthetic-sensitive-value' });
  r.setTime(1760); r.lifecycle.delta({ type: 'reasoning', text: '更多思考' });
  expect(lifecycleEvents(r.events).map(item => [item.state, item.elapsedMs, item.observed]))
    .toEqual([['started', 0, false], ['working', 10, true], ['working', 760, true]]);
  expect(JSON.stringify(r.events)).not.toMatch(/password|synthetic-sensitive-value|更多思考/);
});

test('the first answer chunk closes the observed phase once and late thought chunks do not reopen it', () => {
  const r = recorder();
  r.lifecycle.start(); r.lifecycle.delta({ type: 'reasoning', text: '思考内容' });
  r.setTime(2000); r.lifecycle.delta({ type: 'content', text: '{"answer":"私有正文"}' });
  r.setTime(3000); r.lifecycle.delta({ type: 'content', text: '后续正文' });
  r.lifecycle.delta({ type: 'reasoning', text: '迟到的推理' });
  r.lifecycle.finish({ reasoning_content: '另一个推理字段', content: '正文' });
  r.lifecycle.finish({}); r.lifecycle.start();
  expect(lifecycleEvents(r.events).map(item => item.state)).toEqual(['started', 'working', 'completed']);
  expect(lifecycleEvents(r.events).at(-1)).toMatchObject({ observed: true, elapsedMs: 1000 });
  expect(JSON.stringify(r.events)).not.toMatch(/私有正文|迟到的推理|另一个推理字段/);
});

test.each(['reasoning_content', 'reasoning'])('non-stream %s completes an actually observed phase without exposing its value', field => {
  const r = recorder({ thinkingRequested: false });
  r.setTime(2400); r.lifecycle.finish({ [field]: 'password=nonstream-private-value' });
  r.lifecycle.finish({ [field]: '重复内容' });
  expect(lifecycleEvents(r.events)).toEqual([{
    requestId: r.requestId, round: 1, state: 'completed', elapsedMs: 1400, observed: true,
  }]);
  expect(JSON.stringify(r.events)).not.toMatch(/password|nonstream-private-value/);
});

test('requested thinking without returned reasoning closes without asserting that reasoning was observed', () => {
  const r = recorder(); r.lifecycle.start();
  r.setTime(4000); r.lifecycle.finish({ content: '普通回答' });
  expect(lifecycleEvents(r.events)).toHaveLength(2);
  expect(lifecycleEvents(r.events).at(-1)).toMatchObject({ state: 'completed', elapsedMs: 3000, observed: false });
});

test('lifecycle elapsed time is bounded and UI delivery errors cannot reject a model result', () => {
  const r = recorder(); r.lifecycle.start();
  r.setTime(-100); r.lifecycle.delta({ type: 'reasoning', text: '第一段' });
  expect(lifecycleEvents(r.events).at(-1).elapsedMs).toBe(0);
  r.setTime(100000000); r.lifecycle.finish({ content: '已结束' });
  expect(lifecycleEvents(r.events).at(-1).elapsedMs).toBeLessThanOrEqual(86400000);
  const disconnected = createReasoningLifecycle({ round: 1, requestId: id(), thinkingRequested: true,
    onEvent: () => { throw new Error('UI disconnected'); } });
  expect(() => { disconnected.start(); disconnected.delta({ type: 'reasoning', text: 'buffer' }); disconnected.finish({}); }).not.toThrow();
});

test('real V3 progress arrives while the provider promise is unresolved, before final result persistence', async () => {
  const entered = deferred(), release = deferred(), events = [];
  let finished = false;
  const f = fixture([async (_config, _messages, _tools, _options, onDelta) => {
    expect(lifecycleEvents(events)[0]).toMatchObject({ state: 'started', round: 1, observed: false });
    onDelta({ type: 'reasoning', text: '正在整理问题。password=provider-private-value' });
    entered.resolve(); await release.promise;
    onDelta({ type: 'content', text: '你好' });
    return { role: 'assistant', content: '你好' };
  }], { userId: 'owner', memoryStore: memoryStore() });
  f.state.config.thinking = true;
  const requestId = id();
  const pending = send(f, events, requestId).then(value => { finished = true; return value; });
  try {
    await entered.promise;
    expect(finished).toBe(false);
    expect(f.state.conversationStore.append).not.toHaveBeenCalled();
    expect(lifecycleEvents(events)).toEqual(expect.arrayContaining([expect.objectContaining({ requestId, state: 'working', observed: true })]));
    expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/provider-private-value|password=/);
  } finally { release.resolve(); }
  await expect(pending).resolves.toMatchObject({ answer: '你好' });
  expect(lifecycleEvents(events).filter(item => item.state === 'completed' && item.round === 1)).toHaveLength(1);
  expect(f.state.conversationStore.append).toHaveBeenCalled();
  expect(JSON.stringify(events)).not.toContain('provider-private-value');
});

test('V3 publishes ordered independent lifecycles for a tool-selection round and the following answer round', async () => {
  const events = [];
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '先查看目录。' });
    return calls('memory_list', {});
  }, (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '根据目录回答。' });
    onDelta({ type: 'content', text: '目录已读取。' });
    return { role: 'assistant', content: '目录已读取。' };
  }], { userId: 'owner', memoryStore: memoryStore() });
  f.state.config.thinking = true;
  await send(f, events, id(), '先查看记忆目录再回答');
  const states = lifecycleEvents(events);
  expect(states.filter(item => item.state === 'started').map(item => item.round)).toEqual([1, 2]);
  expect(states.filter(item => item.state === 'completed').map(item => item.round)).toEqual([1, 2]);
  const endFirst = states.findIndex(item => item.round === 1 && item.state === 'completed');
  const startSecond = states.findIndex(item => item.round === 2 && item.state === 'started');
  expect(endFirst).toBeLessThan(startSecond);
  expect(states.every(item => typeof item.observed === 'boolean' && Number.isFinite(item.elapsedMs) && !('text' in item))).toBe(true);
});

test('a rejected final answer never releases buffered thought text even though the provider phase finished', async () => {
  const events = [];
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: 'password=failed-private-thought' });
    onDelta({ type: 'content', text: '我已经帮你完成入账。' });
    return { role: 'assistant', content: '我已经帮你完成入账。' };
  }], { userId: 'owner', memoryStore: memoryStore() });
  f.state.config.thinking = true;
  await expect(send(f, events)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(lifecycleEvents(events).filter(item => item.state === 'completed')).toHaveLength(1);
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('failed-private-thought');
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test('provider cancellation does not fabricate a completed phase or publish partial reasoning', async () => {
  const events = [];
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: 'cancel-private-thought' });
    throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
  }], { userId: 'owner', memoryStore: memoryStore() });
  f.state.config.thinking = true;
  await expect(send(f, events)).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect(lifecycleEvents(events).filter(item => item.state === 'completed')).toEqual([]);
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('cancel-private-thought');
});

afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled();
  expect(publicDb.getConnection).not.toHaveBeenCalled();
});
