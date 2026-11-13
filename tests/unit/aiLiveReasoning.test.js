jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden'); }),
}));
const publicDb = require('../../src/common/config/db');
const { createLiveReasoning } = require('../../src/modules/ai/service/liveReasoning');
const { createEgressPolicy } = require('../../src/modules/ai/service/egressPolicy');
const { fixture, id } = require('../fixtures/aiV3MemoryFixture');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const memoryStore = () => ({ list: jest.fn(async () => ({ files: [], warnings: [], count: 0, totalBytes: 0 })) });
const snapshots = events => events.filter(item => item.event === 'reasoning_delta').map(item => item.data);
const send = (f, events, requestId = id()) => f.service.chat('owner', {
  requestId, conversationId: f.conversationId, mode: 'analysis', message: '你好', consent: true,
}, (event, data) => events.push({ event, data }));
function recorder(options = {}) {
  let time = 1000;
  const events = [], requestId = id();
  const egress = createEgressPolicy({ userId: 'owner', knownIds: ['private-card-id'], extraSecrets: ['synthetic-secret'] });
  const live = createLiveReasoning({ round: 1, requestId, scrub: text => egress.scrub(text),
    clock: () => time, minIntervalMs: 120, onEvent: (event, data) => events.push({ event, data }), ...options });
  return { live, events, requestId, setTime: value => { time = value; } };
}

test('Chinese reasoning reaches a provisional snapshot before a round finishes', () => {
  const r = recorder();
  r.live.push('先整理问题。');
  expect(snapshots(r.events)).toEqual([{ requestId: r.requestId, round: 1, sequence: 1,
    mode: 'snapshot', provisional: true, text: '先整理问题。' }]);
  r.setTime(1200); r.live.push('再核对输入。');
  expect(snapshots(r.events).at(-1)).toMatchObject({ sequence: 2, text: '先整理问题。再核对输入。' });
  expect(snapshots(r.events).every(frame => !Object.hasOwn(frame, 'verified'))).toBe(true);
});

test('frequent chunks stay bounded while round completion flushes the cumulative snapshot', () => {
  const r = recorder();
  r.live.push('甲');
  r.setTime(1010); r.live.push('乙');
  r.setTime(1020); r.live.push('丙');
  expect(snapshots(r.events)).toHaveLength(1);
  r.live.finish({ content: '答复不属于思考' });
  expect(snapshots(r.events).at(-1).text).toBe('甲乙丙');
  const count = snapshots(r.events).length;
  r.live.finish({ reasoning_content: '重复回退字段', content: '另一段正文' });
  expect(snapshots(r.events)).toHaveLength(count);
  expect(JSON.stringify(r.events)).not.toMatch(/答复不属于思考|另一段正文|重复回退字段/);
});

test('a burst flushes after the throttle interval even if the model pauses', () => {
  let callback, scheduled = 0;
  const r = recorder({ schedule: value => { callback = value; return ++scheduled; }, cancelSchedule: () => { callback = null; } });
  r.live.push('先'); r.setTime(1020); r.live.push('核对输入。');
  expect(snapshots(r.events).at(-1).text).toBe('先');
  r.setTime(1130); callback();
  expect(snapshots(r.events).at(-1).text).toBe('先核对输入。');
  r.live.clear();
});

test('clear cancels a scheduled snapshot and prevents late delivery', () => {
  let callback;
  const cancelSchedule = jest.fn();
  const r = recorder({ schedule: value => { callback = value; return 9; }, cancelSchedule });
  r.live.push('先'); r.setTime(1020); r.live.push('继续。');
  r.live.clear(); r.setTime(1300); callback();
  expect(cancelSchedule).toHaveBeenCalledWith(9);
  expect(snapshots(r.events)).toHaveLength(1);
});

test('a credential split across chunks never appears as a partial secret in any snapshot', () => {
  const r = recorder();
  r.live.push('先确认输入。password=synthetic-');
  expect(JSON.stringify(r.events)).not.toContain('synthetic-');
  r.setTime(1300); r.live.push('secret。再继续。');
  r.live.finish({});
  expect(snapshots(r.events).at(-1).text).toContain('[redacted]');
  expect(JSON.stringify(r.events)).not.toMatch(/synthetic-secret|synthetic-/);
});

test.each([
  ['reader@', 'example.org。', /reader@|example\.org/],
  ['https://pri', 'vate.example/path。', /https:\/\/pri|vate\.example/],
  ['Bearer abcdef', '123456789。', /abcdef|123456789/],
  ['private-', 'card-id。', /private-|card-id/],
])('incomplete ASCII identity tokens are withheld until safe redaction: %s', (first, last, secret) => {
  const r = recorder();
  r.live.push('参考输入：' + first);
  expect(JSON.stringify(r.events)).not.toMatch(secret);
  r.setTime(1500); r.live.push(last); r.live.finish({});
  expect(JSON.stringify(r.events)).not.toMatch(secret);
});

test('normal trailing English is eventually displayed without exposing token prefixes while incomplete', () => {
  const r = recorder();
  r.live.push('考虑 plan');
  expect(snapshots(r.events).at(-1)?.text || '').not.toContain('plan');
  r.live.finish({});
  expect(snapshots(r.events).at(-1).text).toContain('plan');
});

test('overflow never displays an over-budget or truncated secret suffix', () => {
  const r = recorder({ maxChars: 16 });
  r.live.push('已有过程。');
  r.setTime(1500); r.live.push('password=synthetic-secret。');
  r.live.finish({ reasoning_content: '不能回退复活超限内容' });
  expect(snapshots(r.events).every(frame => frame.text.length <= 16)).toBe(true);
  expect(JSON.stringify(r.events)).not.toMatch(/synthetic|不能回退/);
});

test('clearing a stream cannot publish old buffered ASCII in a later completion', () => {
  const r = recorder();
  r.live.push('过程。password=synthetic-');
  r.live.clear(); r.live.finish({});
  expect(JSON.stringify(r.events)).not.toContain('synthetic-');
});

test('non-stream reasoning fallback is scrubbed but ordinary response content is never used', () => {
  const r = recorder();
  r.live.finish({ reasoning_content: '核对输入。password=synthetic-secret。', content: '未核验正文内容' });
  expect(snapshots(r.events).at(-1).text).toContain('核对输入');
  expect(JSON.stringify(r.events)).not.toMatch(/synthetic-secret|未核验正文内容/);
  const empty = recorder(); empty.live.finish({ content: '只有正文' });
  expect(empty.events).toEqual([]);
});

test('real V3 publishes provisional reasoning while its provider promise remains unresolved', async () => {
  const entered = deferred(), release = deferred(), events = [];
  const f = fixture([async (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '先整理问题。' });
    entered.resolve(); await release.promise;
    onDelta({ type: 'content', text: '{"answer":"不能提前展示的正文"}' });
    return { role: 'assistant', content: '你好' };
  }], { userId: 'owner', memoryStore: memoryStore() });
  const requestId = id(), pending = send(f, events, requestId);
  try {
    await entered.promise;
    expect(snapshots(events)).toEqual(expect.arrayContaining([expect.objectContaining({ requestId, round: 1, text: '先整理问题。', provisional: true })]));
    expect(events.filter(event => event.event === 'reasoning')).toEqual([]);
    expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  } finally { release.resolve(); }
  await expect(pending).resolves.toMatchObject({ answer: '你好' });
  expect(JSON.stringify(events)).not.toContain('不能提前展示的正文');
  expect(events.filter(event => event.event === 'reasoning').every(event => event.data.verified === true)).toBe(true);
});

test('live V3 reason snapshots redact split provider credentials before final persistence', async () => {
  const events = [];
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '核对输入。password=fixture-' });
    expect(JSON.stringify(events)).not.toContain('fixture-');
    onDelta({ type: 'reasoning', text: 'only。继续整理。reader@' });
    onDelta({ type: 'reasoning', text: 'example.org。' });
    return { role: 'assistant', content: '你好' };
  }], { userId: 'owner', memoryStore: memoryStore() });
  await send(f, events);
  expect(snapshots(events).length).toBeGreaterThan(0);
  expect(JSON.stringify(snapshots(events))).not.toMatch(/fixture-only|fixture-|reader@|example\.org/);
});

test.each([
  ['rejected final answer', (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '我打算核对输入。' });
    return { role: 'assistant', content: '我已经帮你完成入账。' };
  }, 'AI_RESULT_CLAIM_MISMATCH'],
  ['cancelled provider', (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '我打算核对输入。' });
    throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
  }, 'AI_REQUEST_CANCELLED'],
])('a %s may have provisional progress but never publishes it as verified success', async (_, provider, code) => {
  const events = [], f = fixture([provider], { userId: 'owner', memoryStore: memoryStore() });
  await expect(send(f, events)).rejects.toMatchObject({ code });
  expect(snapshots(events).length).toBeGreaterThan(0);
  expect(snapshots(events).every(frame => frame.provisional === true && !Object.hasOwn(frame, 'verified'))).toBe(true);
  expect(events.filter(event => event.event === 'reasoning')).toEqual([]);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled();
  expect(publicDb.getConnection).not.toHaveBeenCalled();
});
