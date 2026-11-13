jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }), getConnection: jest.fn() }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('MySQL forbidden'); }) }));
const { createRequestGuard, digestInput } = require('../../src/modules/ai/service/requestGuard');
const { AiError } = require('../../src/modules/ai/service/errors');
const NOW = Date.parse('2026-11-06T04:00:00Z');
const request = (id, extra = {}) => ({ requestId: id,lane: 'business-chat',input: { previewId: 'preview-a',consent: true },...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise,resolve }; }

function fixture() {
  const runs = {}, lanes = {}, operations = [], connections = [];
  let clock = NOW, tail = Promise.resolve(), failAt;
  const key = (u,id) => u + ':' + id;
  function execute(sql,p = [],inTx = false) {
    operations.push({ sql,p,inTx });
    if (sql.startsWith('INSERT INTO ai_request_lane')) { lanes[p[0]] ||= { active_request_id: null,locked_until: 0,request_count: 0,window_start: p[1] }; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT active_request_id')) return [lanes[p[0]] ? [structuredClone(lanes[p[0]])] : []];
    if (sql.startsWith('SELECT user_id FROM ai_request_lane')) return [lanes[p[0]] ? [{ user_id: p[0] }] : []];
    if (sql.startsWith('SELECT COALESCE(SUM(provider_calls)')) {
      const calls = Object.values(runs).filter(row => row.user_id === p[0] && row.lane === 'v3-chat' &&
        row.created_at >= p[1] && row.created_at < p[2]).reduce((sum,row) => sum + row.provider_calls,0);
      return [[{ calls }]];
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM ai_request_run')) {
      const total = Object.values(runs).filter(row => row.user_id === p[0] && row.status === 'running' && row.deadline_at > p[1] && row.lane !== 'local-draft').length;
      return [[{ total }]];
    }
    if (sql.includes(' FROM ai_request_run WHERE')) return [runs[key(p[0],p[1])] ? [structuredClone(runs[key(p[0],p[1])])] : []];
    if (sql.startsWith('INSERT INTO ai_request_run')) {
      const [id,user_id,lane,input_digest,status,error_code,max_provider_calls,created_at,deadline_at,expires_at] = p;
      if (runs[key(user_id,id)]) throw Object.assign(new Error('duplicate'),{ code: 'ER_DUP_ENTRY' });
      runs[key(user_id,id)] = { id,user_id,lane,input_digest,status,error_code,max_provider_calls,created_at,deadline_at,expires_at,provider_calls: 0,result_payload: null };
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_lane')) {
      if (sql.includes('SET active_request_id=NULL')) {
        const lane = lanes[p[1]]; if (!lane || lane.active_request_id !== p[2]) return [{ affectedRows: 0 }];
        lane.active_request_id = null; lane.locked_until = 0;
      } else { Object.assign(lanes[p[5]],{ active_request_id: p[0],locked_until: p[1],request_count: p[2],window_start: p[3] }); }
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SET provider_calls=provider_calls+1')) {
      const row = runs[key(p[0],p[1])];
      if (!row || row.status !== 'running' || row.provider_calls >= row.max_provider_calls || row.deadline_at <= p[2]) return [{ affectedRows: 0 }];
      row.provider_calls++;
      if (failAt === 'providerUnknown') throw new Error('lost reservation acknowledgement');
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET status='completed'")) {
      const row = runs[key(p[1],p[2])];
      if (!row || row.status !== 'running' || row.deadline_at <= p[3]) return [{ affectedRows: 0 }];
      if (failAt === 'receipt') throw new Error('receipt write failed');
      row.status = 'completed'; row.result_payload = p[0];
      if (failAt === 'receiptUnknown') throw new Error('lost receipt acknowledgement');
      return [{ affectedRows: 1 }];
    }
    if(sql.startsWith('UPDATE ai_request_run SET result_payload=?')) {
      const row=runs[key(p[1],p[2])];
      const business = sql.includes("lane='business-chat'");
      const ocr = sql.includes("lane='ocr'");
      const v3 = sql.includes("lane='v3-chat'");
      const allowance = v3 ? 5 : business || ocr ? 1 : 0, providerCalls = ocr || v3 ? p[3] : allowance, deadline = ocr || v3 ? p[4] : p[3];
      if(!row||row.lane!==(v3?'v3-chat':ocr?'ocr':business?'business-chat':'local-draft')||row.status!=='running'||
        row.max_provider_calls!==allowance||row.provider_calls!==providerCalls||row.deadline_at<=deadline)return [{affectedRows:0}];
      row.result_payload=p[0];return [{affectedRows:1}];
    }
    if (sql.includes("SET deadline_at=? WHERE user_id=? AND id=?")) {
      // 2026-11-10：活性租约心跳续期（leaseMs/heartbeatMs 注入后为真实定时器）。
      const row = runs[key(p[1],p[2])];
      if (!row || row.status !== 'running') return [{ affectedRows: 0 }];
      row.deadline_at = p[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET status='failed'")) {
      // 三种失败形状：停机标记（字面 INTERRUPTED、无死线条件）、租约 reap（deadline_at<=?）、
      // fail() 参数式（error_code=?,result_payload=COALESCE(...)）。
      const leaseReap = sql.includes("deadline_at<=?");
      const shutdownMark = sql.includes("error_code='AI_TURN_INTERRUPTED'");
      const row = runs[key(p[leaseReap || shutdownMark ? 0 : 2], p[leaseReap || shutdownMark ? 1 : 3])];
      if (!row || row.status !== 'running' || (leaseReap && row.deadline_at > p[2])) return [{ affectedRows: 0 }];
      row.status = 'failed'; row.error_code = leaseReap || shutdownMark ? 'AI_TURN_INTERRUPTED' : p[0];
      if (!leaseReap && !shutdownMark && p[1] != null && row.result_payload == null) row.result_payload = p[1];
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_run SET result_payload=NULL')) {
      let total = 0; for (const row of Object.values(runs)) if (row.user_id === p[0] && row.expires_at <= p[1] && row.result_payload) { row.result_payload = null; total++; }
      return [{ affectedRows: total }];
    }
    if (sql.startsWith('DELETE FROM ai_request_lane')) { if (lanes[p[0]]?.active_request_id == null && lanes[p[0]]?.window_start < p[1]) delete lanes[p[0]]; return [{ affectedRows: 1 }]; }
    throw new Error('Unexpected SQL: ' + sql);
  }
  const executor = { execute: jest.fn(async (s,p) => execute(s,p)),getConnection: jest.fn(async () => {
    let unlock;
    const conn = { beginTransaction: jest.fn(async () => { const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous; }),
      execute: jest.fn(async (s,p) => execute(s,p,true)),commit: jest.fn(async () => { if (failAt === 'claimUnknown') throw new Error('lost claim acknowledgement'); }),
      rollback: jest.fn(async () => {}),release: jest.fn(() => unlock()) };
    connections.push(conn); return conn;
  }) };
  const make = (options = {}) => createRequestGuard({ executor,clock: () => clock,maxRequests: 6,queueWaitMs: 0,
    // 2026-11-10：deadline_at 语义改为"进程活性租约"（生产默认 45s/心跳 15s）。fixture 用
    // 1000ms 小租约 + 关闭真实心跳定时器，租约过期靠 advance() 推时钟确定性地触发。
    leaseMs: 1000,heartbeatMs: 0,...options });
  return { guard: make(),make,executor,runs,lanes,operations,connections,advance: ms => { clock += ms; },fail: value => { failAt = value; } };
}

test('canonical JSON ignores object key order, keeps array order, and rejects invalid data', () => {
  expect(digestInput({ a: 1,b: { x: 2,y: 3 } })).toBe(digestInput({ b: { y: 3,x: 2 },a: 1 }));
  expect(digestInput([1,2])).not.toBe(digestInput([2,1]));
  expect(digestInput({ a: undefined,b: 1 })).toBe(digestInput({ b: 1 }));
  expect(() => digestInput({ amount: Infinity })).toThrow();
  const circle = {}; circle.self = circle; expect(() => digestInput(circle)).toThrow();
});

test('oversized prose failures persist a clear read-only receipt without a truncated success', async () => {
  const f = fixture();
  await expect(f.guard.run('owner', request('prose-overflow'), async () => {
    throw new AiError('answer overflow', 502, 'AI_ANSWER_TOO_LONG');
  })).rejects.toMatchObject({ code: 'AI_ANSWER_TOO_LONG' });
  const receipt = await f.guard.get('owner', 'prose-overflow');
  expect(receipt).toMatchObject({ status: 'failed', error: { code: 'AI_ANSWER_TOO_LONG' } });
  expect(JSON.stringify(receipt)).toContain('请要求分段输出');
  expect(receipt.result).toBeUndefined();
});

test('external disconnect aborts the provider signal and rejects a late result without later writes or replay', async () => {
  const f = fixture(), disconnect = new AbortController(), started = deferred(), providerResponse = deferred();
  let providerSignal;
  const afterProvider = jest.fn();
  const provider = jest.fn(async signal => { providerSignal = signal; started.resolve(); return providerResponse.promise; });
  const running = f.guard.run('owner', request('external-close', { signal: disconnect.signal }), async budget => {
    const answer = await budget.invoke(provider);
    budget.check(); afterProvider(); return { answer };
  });
  const rejected = expect(running).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED', providerCalls: 1, requestId: 'external-close' });
  await started.promise; disconnect.abort(); await rejected;
  expect(providerSignal.aborted).toBe(true);
  const receipt = await f.guard.get('owner', 'external-close');
  expect(receipt).toMatchObject({ status: 'failed', providerCalls: 1, error: { code: 'AI_REQUEST_CANCELLED' } });
  expect(f.lanes.owner.active_request_id).toBeNull();
  providerResponse.resolve('late paid answer'); await new Promise(resolve => setImmediate(resolve));
  expect(afterProvider).not.toHaveBeenCalled(); expect(f.runs['owner:external-close'].result_payload).toBeNull();
  await expect(f.make().run('owner', request('external-close'), budget => budget.invoke(provider)))
    .rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect(provider).toHaveBeenCalledTimes(1);
});

test('an already-disconnected request retains a zero-call terminal receipt without invoking work', async () => {
  const f = fixture(), disconnect = new AbortController(), work = jest.fn(); disconnect.abort();
  await expect(f.guard.run('owner', request('closed-before-work', { signal: disconnect.signal }), work))
    .rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED', providerCalls: 0 });
  expect(work).not.toHaveBeenCalled();
  expect(await f.guard.get('owner', 'closed-before-work')).toMatchObject({ status: 'failed', providerCalls: 0, error: { code: 'AI_REQUEST_CANCELLED' } });
  expect(f.lanes.owner.active_request_id).toBeNull();
  expect(f.lanes.owner.request_count).toBe(0);
});
test('completed response replays across guard instances without another paid call', async () => {
  const f = fixture(), provider = jest.fn(async () => '回答');
  const first = await f.guard.run('owner',request('req-a'),async b => ({ answer: await b.invoke(provider) }));
  const second = await f.make().run('owner',request('req-a',{ input: { consent: true,previewId: 'preview-a' } }),() => { throw new Error('Replay must not run'); });
  expect(second).toEqual(first); expect(provider).toHaveBeenCalledTimes(1);
  expect((await f.guard.get('owner','req-a')).providerCalls).toBe(1);
  expect(f.runs['owner:req-a'].result_payload).toMatch(/^enc\.v1:/);
  expect(f.runs['owner:req-a'].result_payload).not.toContain('回答');
  expect(f.operations.filter(op => op.sql.startsWith('INSERT INTO ai_request_run')).every(op => op.inTx)).toBe(true);
});
test('same UUID with changed content or a failed result cannot call the model again', async () => {
  const f = fixture(), provider = jest.fn(async () => { throw new Error('upstream down'); });
  await expect(f.guard.run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED',requestId: 'req-a' });
  await expect(f.make().run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ status: 409 });
  await expect(f.guard.run('owner',request('req-a',{ input: { consent: false } }),b => b.invoke(provider))).rejects.toMatchObject({ code: 'AI_REQUEST_CONFLICT' });
  expect(provider).toHaveBeenCalledTimes(1); expect((await f.guard.get('owner','req-a')).status).toBe('failed');
});
test('failureForInput is a read-only owner/lane/canonical-input proof and never exports its digest', async () => {
  const f = fixture(), input = { message: '原问题', consent: true, options: { a: 1, b: 2 } };
  const attempt = request('failure-proof', { lane: 'v3-chat', input, maxProviderCalls: 5 });
  await expect(f.guard.run('owner', attempt, async () => { throw new AiError('未打开会话', 504, 'AI_TURN_TIMEOUT'); })).rejects.toMatchObject({ code: 'AI_TURN_TIMEOUT', providerCalls: 0 });
  const start = f.operations.length;
  const proof = await f.guard.failureForInput('owner', attempt.requestId, { lane: 'v3-chat', input: { options: { b: 2, a: 1 }, consent: true, message: '原问题' } });
  expect(proof).toMatchObject({ requestId: attempt.requestId, status: 'failed', providerCalls: 0, error: { code: 'AI_TURN_TIMEOUT' } });
  expect(proof).not.toHaveProperty('input_digest'); expect(proof).not.toHaveProperty('inputDigest');
  await expect(f.guard.failureForInput('stranger', attempt.requestId, { lane: 'v3-chat', input })).resolves.toBeNull();
  await expect(f.guard.failureForInput('owner', 'missing', { lane: 'v3-chat', input })).resolves.toBeNull();
  await expect(f.guard.failureForInput('owner', attempt.requestId, { lane: 'business-chat', input })).resolves.toBeNull();
  await expect(f.guard.failureForInput('owner', attempt.requestId, { lane: 'v3-chat', input: { ...input, message: '盗用编号的新原话' } })).resolves.toBeNull();
  f.runs['owner:failure-proof'].status = 'running'; f.runs['owner:failure-proof'].deadline_at = NOW - 1;
  await expect(f.guard.failureForInput('owner', attempt.requestId, { lane: 'v3-chat', input })).resolves.toBeNull();
  f.runs['owner:failure-proof'].status = 'completed';
  await expect(f.guard.failureForInput('owner', attempt.requestId, { lane: 'v3-chat', input })).resolves.toBeNull();
  expect(f.operations.slice(start).every(operation => operation.sql.startsWith('SELECT'))).toBe(true);
});

test('failureForInput excludes a failed guard row whose committed V3 recovery is actually completed', async () => {
  const f = fixture(), attempt = request('failure-recovery-proof', { lane: 'v3-chat', input: { message: '原问题', consent: true }, maxProviderCalls: 5 });
  await expect(f.guard.run('owner', attempt, async budget => {
    await budget.invoke(async () => '合成结果');
    await f.guard.saveV3Recovery(f.executor, 'owner', attempt.requestId, { contractVersion: 3, conversationId: 'offline-conversation', answer: '已确认的完整答复', request: { requestId: attempt.requestId, providerCalls: 1, maxProviderCalls: 5 } });
    throw new Error('lost completion acknowledgement');
  })).rejects.toThrow();
  expect(f.runs['owner:failure-recovery-proof'].status).toBe('failed');
  expect(await f.guard.get('owner', attempt.requestId)).toMatchObject({ status: 'completed', recoveredFromV3Transaction: true });
  const start = f.operations.length;
  await expect(f.guard.failureForInput('owner', attempt.requestId, { lane: attempt.lane, input: attempt.input })).resolves.toBeNull();
  expect(f.operations.slice(start).every(operation => operation.sql.startsWith('SELECT'))).toBe(true);
});
test('configured immediate admission distinguishes concurrency from rate limits across instances', async () => {
  const f = fixture(), started = deferred(), hold = deferred(), provider = jest.fn(async () => { started.resolve(); return hold.promise; });
  const first = f.guard.run('owner',request('req-a'),b => b.invoke(provider)); await started.promise;
  await expect(f.make().run('owner',request('req-b',{ lane: 'ocr' }),b => b.invoke(provider))).rejects.toMatchObject({ status: 503,code: 'AI_REQUEST_BUSY',providerCalls: 0 });
  await expect(f.make().run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ status: 409 });
  expect(provider).toHaveBeenCalledTimes(1); hold.resolve('done'); await first;
  expect(f.lanes.owner.active_request_id).toBeNull(); expect(f.runs['owner:req-b']).toBeUndefined();
});
test('concurrent in-flight cap is configurable for debugging', async () => {
  const f = fixture(), starts = [deferred(), deferred()], holds = [deferred(), deferred()];
  const providers = starts.map((start, index) => jest.fn(async () => { start.resolve(); return holds[index].promise; }));
  const first = f.make({ maxConcurrent: 2 }).run('owner', request('conc-a'), b => b.invoke(providers[0]));
  const second = f.make({ maxConcurrent: 2 }).run('owner', request('conc-b'), b => b.invoke(providers[1]));
  await Promise.all(starts.map(start => start.promise));
  const third = jest.fn();
  await expect(f.make({ maxConcurrent: 2 }).run('owner', request('conc-c'), b => b.invoke(third)))
    .rejects.toMatchObject({ status: 503, code: 'AI_REQUEST_BUSY' });
  expect(third).not.toHaveBeenCalled();
  holds[0].resolve('a'); holds[1].resolve('b');
  await expect(first).resolves.toBe('a'); await second;
});
test('concurrent v3-chat requests cannot both reserve the last daily provider call', async () => {
  const f = fixture(), started = deferred(), hold = deferred();
  const provider = jest.fn(async () => { started.resolve(); return hold.promise; });
  const rival = jest.fn(async () => 'rival answer');
  const v3 = (id, message) => ({ requestId: id, lane: 'v3-chat', input: { message }, maxProviderCalls: 1, dailyProviderLimit: 1 });
  const options = { maxConcurrent: 2 };
  const first = f.make(options).run('owner', v3('day-a', 'first'), b => b.invoke(provider));
  await started.promise;
  const second = f.make(options).run('owner', v3('day-b', 'second'), b => b.invoke(rival));
  await expect(second).rejects.toMatchObject({ code: 'AI_DAILY_CALL_LIMIT', status: 429, providerCalls: 0 });
  expect(rival).not.toHaveBeenCalled();
  expect(f.runs['owner:day-b'].provider_calls).toBe(0);
  hold.resolve('first answer');
  await expect(first).resolves.toBe('first answer');
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.runs['owner:day-a'].provider_calls).toBe(1);
  expect((await f.guard.get('owner','day-b')).error.code).toBe('AI_DAILY_CALL_LIMIT');
});

test('configured rate count is durable and a refused ID remains usable after window reset', async () => {
  const f = fixture(), provider = jest.fn(async () => 'done');
  for (let i = 0; i < 6; i++) await f.make().run('owner',request('req-' + i),b => b.invoke(provider));
  await expect(f.make().run('owner',request('req-7'),b => b.invoke(provider))).rejects.toMatchObject({ status: 429 });
  expect(provider).toHaveBeenCalledTimes(6); f.advance(60001);
  await f.make().run('owner',request('req-8'),b => b.invoke(provider)); expect(provider).toHaveBeenCalledTimes(7);
  await f.guard.run('owner',request('req-7'),b => b.invoke(provider));
  expect(provider).toHaveBeenCalledTimes(8);
});
test('rate limit values are configurable without changing the default', async () => {
  const f = fixture(), provider = jest.fn(async () => 'done');
  for (let i = 0; i < 3; i++) await f.make({ maxRequests: 3 }).run('owner', request('custom-' + i), b => b.invoke(provider));
  await expect(f.make({ maxRequests: 3 }).run('owner', request('custom-3'), b => b.invoke(provider)))
    .rejects.toMatchObject({ status: 429, code: 'AI_RATE_LIMIT' });
  f.advance(60001);
  await f.make({ maxRequests: 3 }).run('owner', request('custom-4'), b => b.invoke(provider));
  expect(provider).toHaveBeenCalledTimes(4);
});
test('default admission accepts thirty sequential requests and blocks excess frequency', async () => {
  const f = fixture(), guard = f.make({ maxRequests: undefined }), provider = jest.fn(async () => 'done');
  for (let i = 0; i < 30; i++) await guard.run('owner', request('burst-' + i), b => b.invoke(provider));
  await expect(guard.run('owner', request('burst-30'), b => b.invoke(provider)))
    .rejects.toMatchObject({ code: 'AI_RATE_LIMIT', status: 429, retryAfterSeconds: 60, providerCalls: 0 });
  expect(provider).toHaveBeenCalledTimes(30); expect(f.runs['owner:burst-30']).toBeUndefined();
});

test('busy admission waits across instances without consuming quota or shortening the processing budget', async () => {
  const f = fixture(), started = deferred(), hold = deferred(), waiting = deferred();
  const first = f.guard.run('owner', request('wait-a'), b => b.invoke(async () => { started.resolve(); return hold.promise; }));
  await started.promise;
  const work = jest.fn(async b => ({ deadline: b.deadlineAt }));
  const second = f.make({ queueWaitMs: 1000, queuePollMs: 5 }).run('owner', request('wait-b', { onWait: waiting.resolve }), work);
  expect(await waiting.promise).toMatchObject({ stage: 'queued', requestId: 'wait-b' });
  expect(work).not.toHaveBeenCalled(); expect(f.runs['owner:wait-b']).toBeUndefined(); expect(f.lanes.owner.request_count).toBe(1);
  f.advance(200); hold.resolve('done'); await first;
  await expect(second).resolves.toMatchObject({ deadline: NOW + 200 + 30000 });
  expect(work).toHaveBeenCalledTimes(1); expect(f.lanes.owner.request_count).toBe(2);
});

test('cancelled waiting requests retain zero-call receipts without consuming quota or invoking work', async () => {
  const f = fixture(), started = deferred(), hold = deferred(), waiting = deferred(), controller = new AbortController();
  const first = f.guard.run('owner', request('cancel-a'), b => b.invoke(async () => { started.resolve(); return hold.promise; }));
  await started.promise;
  const work = jest.fn();
  const second = f.make({ queueWaitMs: 1000 }).run('owner', request('cancel-b', { signal: controller.signal, onWait: waiting.resolve }), work);
  const rejected = expect(second).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED', providerCalls: 0 });
  await waiting.promise; controller.abort(); await rejected;
  expect(work).not.toHaveBeenCalled();
  expect(await f.guard.get('owner', 'cancel-b')).toMatchObject({ status: 'failed', providerCalls: 0, error: { code: 'AI_REQUEST_CANCELLED' } });
  expect(f.lanes.owner.request_count).toBe(1); expect(f.lanes.owner.active_request_id).toBe('cancel-a');
  hold.resolve('done'); await first;
});

test('queue capacity is bounded across instances while other users remain available', async () => {
  const f = fixture(), started = deferred(), hold = deferred(), waiting = deferred(), controller = new AbortController();
  const first = f.guard.run('owner', request('capacity-a'), b => b.invoke(async () => { started.resolve(); return hold.promise; }));
  await started.promise;
  const options = { queueWaitMs: 1000, maxQueued: 1, queuePollMs: 5 };
  const second = f.make(options).run('owner', request('capacity-b', { signal: controller.signal, onWait: waiting.resolve }), async () => null);
  const rejected = expect(second).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  await waiting.promise;
  const work = jest.fn();
  await expect(f.make(options).run('owner', request('capacity-c'), work)).rejects.toMatchObject({ code: 'AI_REQUEST_BUSY', status: 503 });
  expect(work).not.toHaveBeenCalled();
  await expect(f.make(options).run('other-owner', request('capacity-c'), async () => 'available')).resolves.toBe('available');
  controller.abort(); await rejected; hold.resolve('done'); await first;
  await expect(f.make(options).run('owner', request('capacity-c'), async () => 'accepted')).resolves.toBe('accepted');
});

test('waiting expires as temporary busy and the same unadmitted ID can be submitted later', async () => {
  const f = fixture(), started = deferred(), hold = deferred(), onWait = jest.fn(), work = jest.fn(async () => 'accepted');
  const first = f.guard.run('owner', request('expiry-a'), b => b.invoke(async () => { started.resolve(); return hold.promise; }));
  await started.promise;
  await expect(f.make({ queueWaitMs: 25, queuePollMs: 5 }).run('owner', request('expiry-b', { onWait }), work))
    .rejects.toMatchObject({ code: 'AI_REQUEST_BUSY', status: 503, retryAfterSeconds: 1, providerCalls: 0 });
  expect(work).not.toHaveBeenCalled(); expect(onWait).toHaveBeenCalledTimes(1); expect(f.runs['owner:expiry-b']).toBeUndefined();
  hold.resolve('done'); await first;
  await expect(f.guard.run('owner', request('expiry-b'), work)).resolves.toBe('accepted');
});

test('duplicate waiting submissions admit only one provider call', async () => {
  const f = fixture(), started = deferred(), hold = deferred(), waits = [deferred(), deferred()], provider = jest.fn(async () => 'one call');
  const first = f.guard.run('owner', request('duplicate-a'), b => b.invoke(async () => { started.resolve(); return hold.promise; }));
  await started.promise;
  const queued = waits.map(wait => f.make({ queueWaitMs: 1000, queuePollMs: 5 }).run('owner', request('duplicate-b', { onWait: wait.resolve }), b => b.invoke(provider)));
  const results = Promise.allSettled(queued);
  await Promise.all(waits.map(wait => wait.promise)); hold.resolve('done'); await first;
  const settled = await results;
  expect(settled.some(item => item.status === 'fulfilled')).toBe(true);
  for (const item of settled) if (item.status === 'rejected') expect(item.reason.status).toBe(409);
  expect(provider).toHaveBeenCalledTimes(1);
});

test('legacy input without requestId gets a durable internal UUID and receipt', async () => {
  const f = fixture(), result = await f.guard.run('owner',{ lane: 'legacy-chat',input: { message: '统计' },maxProviderCalls: 4 },b => b.invoke(async () => ({ answer: 'done' })));
  expect(result.request.requestId).toMatch(/^[a-f0-9-]{36}$/); expect(result.request.providerCalls).toBe(1);
  expect((await f.guard.get('owner',result.request.requestId)).status).toBe('completed');
});
test('provider call budget is a hard cap and recursive/parallel invocation is stopped', async () => {
  const f = fixture(), provider = jest.fn(async () => 'done');
  await expect(f.guard.run('owner',request('req-a'),async b => { await b.invoke(provider); await b.invoke(provider); })).rejects.toMatchObject({ code: 'AI_PROVIDER_CALL_LIMIT' });
  expect(provider).toHaveBeenCalledTimes(1); expect(f.runs['owner:req-a'].provider_calls).toBe(1);
  const hold = deferred();
  await expect(f.guard.run('owner',request('req-b',{lane:'legacy-chat', maxProviderCalls: 4 }),b => Promise.all([b.invoke(() => hold.promise),b.invoke(provider)]))).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED' });
  hold.resolve('done'); expect(provider).toHaveBeenCalledTimes(1);
});
test('canonical repeated tools and different tools beyond the fixed cap end the turn', async () => {
  const f = fixture();
  await expect(f.guard.run('owner',request('req-a'),async b => { b.tool('query',{ x: 1,y: 2 }); b.tool('query',{ y: 2,x: 1 }); })).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED' });
  await expect(f.guard.run('owner',request('req-b'),async b => { for (let i = 0; i < 13; i++) b.tool('query',{ page: i }); })).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED' });
  expect(f.runs['owner:req-a'].provider_calls).toBe(0);
});
test('timed-out provider aborts once and leaves a durable non-replayable failed receipt', async () => {
  const f = fixture(), hold = deferred(), started = deferred(); let signal;
  const provider = jest.fn(async s => { signal = s; started.resolve(); return hold.promise; });
  const pending = f.guard.run('owner',request('req-a',{ timeoutMs: 15 }),async b => { await b.invoke(provider); return b.invoke(provider); });
  await started.promise;
  await expect(pending).rejects.toMatchObject({ code: 'AI_TURN_TIMEOUT' });
  expect(signal.aborted).toBe(true); hold.resolve('late'); await new Promise(resolve => setImmediate(resolve));
  await expect(f.make().run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ status: 409 });
  expect(provider).toHaveBeenCalledTimes(1); expect((await f.guard.get('owner','req-a')).error.code).toBe('AI_TURN_TIMEOUT');
});
test('expired process lease permits a manual new request and old cleanup cannot unlock it', async () => {
  const f = fixture(), firstHold = deferred(), firstStarted = deferred(), secondHold = deferred(), secondStarted = deferred();
  const first = f.guard.run('owner',request('req-a',{ timeoutMs: 1000 }),b => b.invoke(async () => { firstStarted.resolve(); return firstHold.promise; }));
  await firstStarted.promise; f.advance(1001);
  const second = f.make().run('owner',request('req-b'),b => b.invoke(async () => { secondStarted.resolve(); return secondHold.promise; })); await secondStarted.promise;
  firstHold.resolve('late'); await expect(first).rejects.toMatchObject({ code: 'AI_TURN_TIMEOUT' });
  expect(f.lanes.owner.active_request_id).toBe('req-b'); secondHold.resolve('done'); await second;
  expect(f.lanes.owner.active_request_id).toBeNull();
});
test('lost claim/reservation/completion acknowledgements never trigger another provider call', async () => {
  const f = fixture(), provider = jest.fn(async () => ({ answer: 'done' })); f.fail('claimUnknown');
  await expect(f.guard.run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ code: 'AI_GUARD_UNAVAILABLE' });
  f.fail(null); await expect(f.make().run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ status: 409 }); expect(provider).not.toHaveBeenCalled();
  f.advance(30001); await f.guard.get('owner','req-a'); f.fail('providerUnknown');
  await expect(f.guard.run('owner',request('req-b'),b => b.invoke(provider))).rejects.toThrow();
  f.fail(null); await expect(f.make().run('owner',request('req-b'),b => b.invoke(provider))).rejects.toMatchObject({ status: 409 }); expect(provider).not.toHaveBeenCalled();
  f.fail('receiptUnknown'); await expect(f.guard.run('owner',request('req-c'),b => b.invoke(provider))).rejects.toThrow();
  f.fail(null); const replay = await f.make().run('owner',request('req-c'),b => b.invoke(provider));
  expect(replay.answer).toBe('done'); expect(provider).toHaveBeenCalledTimes(1);
});
test('graceful shutdown marks running turns interrupted, aborts in-flight work, and clears the registry', async () => {
  const f = fixture(), started = deferred(), hold = deferred();
  const provider = jest.fn(async () => { started.resolve(); return hold.promise; });
  const pending = f.guard.run('owner',request('req-a'),b => b.invoke(provider));
  await started.promise;
  await expect(f.guard.shutdownAll()).resolves.toBe(1);
  hold.resolve('late'); await expect(pending).rejects.toMatchObject({ code: 'AI_TURN_INTERRUPTED' });
  expect(f.runs['owner:req-a'].status).toBe('failed');
  expect(f.runs['owner:req-a'].error_code).toBe('AI_TURN_INTERRUPTED');
  await expect(f.guard.shutdownAll()).resolves.toBe(0);
  const receipt = await f.guard.get('owner','req-a');
  expect(receipt.error.code).toBe('AI_TURN_INTERRUPTED');
  expect(receipt.error.message).toContain('服务中断或已重启');
});
test('expired process lease reaps the row as interrupted and frees the concurrency slot', async () => {
  const f = fixture(), started = deferred(), hold = deferred();
  const provider = jest.fn(async () => { started.resolve(); return hold.promise; });
  const pending = f.guard.run('owner',request('req-a'),b => b.invoke(provider));
  await started.promise;
  f.advance(1001);
  const receipt = await f.guard.get('owner','req-a');
  expect(receipt.status).toBe('failed');
  expect(receipt.error.code).toBe('AI_TURN_INTERRUPTED');
  hold.resolve('late'); await expect(pending).rejects.toThrow();
  // 僵尸行已翻终态：同用户无需等死线即可再发起请求。
  await expect(f.make().run('owner',request('req-b'),b => b.invoke(async () => 'fresh'))).resolves.toBe('fresh');
});
test('heartbeat renews the process lease while the turn is alive', async () => {
  const f = fixture(), started = deferred(), hold = deferred();
  const guard = f.make({ leaseMs: 1000,heartbeatMs: 20 });
  const provider = jest.fn(async () => { started.resolve(); return hold.promise; });
  const pending = guard.run('owner',request('req-a'),b => b.invoke(provider));
  await started.promise;
  f.advance(1500);                                        // 不续租本应已过期
  await new Promise(resolve => setTimeout(resolve, 80));  // 真实心跳定时器以当前时钟续租
  const receipt = await guard.get('owner','req-a');
  expect(receipt.status).toBe('running');
  hold.resolve('done'); await expect(pending).resolves.toBe('done');
});
test('receipt expiry clears content but retains tombstones and never reopens a used UUID', async () => {
  const f = fixture(), provider = jest.fn(async () => ({ answer: 'private' }));
  await f.guard.run('owner',request('req-a'),b => b.invoke(provider)); f.advance(86400001); await f.guard.prune('owner');
  expect(f.runs['owner:req-a']).toMatchObject({ status: 'completed',result_payload: null });
  await expect(f.make().run('owner',request('req-a'),b => b.invoke(provider))).rejects.toMatchObject({ code: 'AI_REQUEST_EXPIRED' });
  expect(provider).toHaveBeenCalledTimes(1);
});
test('request ownership is isolated and another user may independently use the same UUID', async () => {
  const f = fixture(), provider = jest.fn(async () => ({ answer: 'done' }));
  await f.guard.run('owner',request('req-a'),b => b.invoke(provider));
  await expect(f.guard.get('other','req-a')).rejects.toMatchObject({ status: 404 });
  await f.guard.run('other',request('req-a'),b => b.invoke(provider)); expect(provider).toHaveBeenCalledTimes(2);
});
test('local draft lane has zero model budget and persists a replayable local receipt',async()=>{
  const f=fixture(),provider=jest.fn(),work=jest.fn(async budget=>{
    await expect(budget.invoke(provider)).rejects.toMatchObject({code:'AI_PROVIDER_CALL_LIMIT'});
    return {draft:{id:'draft-local'}};
  });
  const local=request('local-a',{lane:'local-draft',maxProviderCalls:0});
  const result=await f.guard.run('owner',local,work);
  expect(result.request).toMatchObject({providerCalls:0,maxProviderCalls:0});
  expect((await f.make().run('owner',local,work)).draft.id).toBe('draft-local');
  expect(work).toHaveBeenCalledTimes(1);expect(provider).not.toHaveBeenCalled();
});
test('local drafts remain available after paid request quota but never consume or reset it',async()=>{
  const f=fixture();
  for(let n=0;n<6;n++) await f.guard.run('owner',request('paid-'+n),async()=>({done:true}));
  const count=f.lanes.owner.request_count;
  await f.guard.run('owner',request('local-a',{lane:'local-draft',maxProviderCalls:0}),async()=>({draft:{id:'local'}}));
  expect(f.lanes.owner.request_count).toBe(count);
  await expect(f.guard.run('owner',request('paid-7'),async()=>({done:true}))).rejects.toMatchObject({code:'AI_RATE_LIMIT'});
});
test('failed local draft request never repeats its writes and other lanes cannot claim a zero budget',async()=>{
  const f=fixture(),work=jest.fn(async()=>{throw new Error('failed local write');});
  const local=request('local-a',{lane:'local-draft',maxProviderCalls:0});
  await expect(f.guard.run('owner',local,work)).rejects.toMatchObject({code:'AI_REQUEST_FAILED',providerCalls:0});
  await expect(f.make().run('owner',local,work)).rejects.toMatchObject({status:409});
  expect(work).toHaveBeenCalledTimes(1);
  await expect(f.guard.run('owner',request('bad',{maxProviderCalls:0}),async()=>({}))).rejects.toMatchObject({status:400});
});
test.each(['business-chat','ocr'])('%s cannot be wired with a provider budget above one',async lane=>{
  const f=fixture(),provider=jest.fn();
  await expect(f.guard.run('owner',request('bad',{lane,maxProviderCalls:4}),b=>b.invoke(provider))).rejects.toMatchObject({code:'AI_REQUEST_INVALID'});
  expect(provider).not.toHaveBeenCalled();expect(f.operations).toHaveLength(0);
});
test('failed post-commit local history write recovers its transaction receipt without another draft or provider',async()=>{
  const f=fixture(),requestId='local-recover',provider=jest.fn(),work=jest.fn(async()=>{
    await f.guard.saveLocalRecovery(f.executor,'owner',requestId,{contractVersion:2,draft:{id:'known-draft'},
      request:{requestId,providerCalls:0,maxProviderCalls:0}});
    throw new Error('history append failed after local commit');
  });
  const local=request(requestId,{lane:'local-draft',maxProviderCalls:0});
  await expect(f.guard.run('owner',local,work)).rejects.toMatchObject({code:'AI_REQUEST_FAILED'});
  const receipt=await f.make().get('owner',requestId);
  expect(receipt).toMatchObject({status:'completed',guardStatus:'failed',recoveredFromLocalTransaction:true,result:{draft:{id:'known-draft'}}});
  expect((await f.make().run('owner',local,work)).draft.id).toBe('known-draft');
  expect(work).toHaveBeenCalledTimes(1);expect(provider).not.toHaveBeenCalled();
});
test('local recovery expiry does not revive a used request or expose its old private payload',async()=>{
  const f=fixture(),requestId='local-expired';
  await expect(f.guard.run('owner',request(requestId,{lane:'local-draft',maxProviderCalls:0}),async()=>{
    await f.guard.saveLocalRecovery(f.executor,'owner',requestId,{contractVersion:2,draft:{id:'known'},request:{requestId,providerCalls:0,maxProviderCalls:0}});
    throw new Error('late failure');
  })).rejects.toThrow();
  f.advance(86400001);await f.guard.prune('owner');
  expect(await f.guard.get('owner',requestId)).toMatchObject({status:'failed'});
  await expect(f.guard.run('owner',request(requestId,{lane:'local-draft',maxProviderCalls:0}),async()=>({}))).rejects.toMatchObject({status:409});
});

test('a committed batch receipt survives outer completion failure without another provider call', async () => {
  const f = fixture(), requestId = 'batch-recovery', provider = jest.fn(async () => 'synthetic');
  const work = jest.fn(async budget => {
    await budget.invoke(provider);
    const result = { contractVersion: 2, drafts: [{ id: 'first' }], candidates: [{ inputCandidate: { id: 'second' } }],
      request: { requestId, providerCalls: 1, maxProviderCalls: 1 } };
    await f.guard.saveBusinessRecovery(f.executor, 'owner', requestId, result);
    throw Object.assign(new Error('completion response lost'), { code: 'ECONNRESET', sqlState: 'HY000' });
  });
  await expect(f.guard.run('owner', request(requestId), work)).rejects.toMatchObject({
    code: 'AI_REQUEST_FAILED', causeCode: 'ECONNRESET', causeSqlState: 'HY000', requestId, providerCalls: 1,
  });
  const receipt = await f.make().get('owner', requestId);
  expect(receipt).toMatchObject({ status: 'completed', guardStatus: 'failed', recoveredFromBusinessTransaction: true,
    result: { drafts: [{ id: 'first' }], candidates: [{ inputCandidate: { id: 'second' } }] } });
  expect((await f.make().run('owner', request(requestId), work)).drafts[0].id).toBe('first');
  expect(work).toHaveBeenCalledTimes(1); expect(provider).toHaveBeenCalledTimes(1);
});

test('invalid and expired business recovery data cannot revive a paid request', async () => {
  const f = fixture(), requestId = 'batch-expiry';
  await expect(f.guard.run('owner', request(requestId), async budget => {
    await budget.invoke(async () => 'synthetic');
    await expect(f.guard.saveBusinessRecovery(f.executor, 'owner', requestId, { contractVersion: 2,
      drafts: [{ id: 'one' }], request: { requestId, providerCalls: 1, maxProviderCalls: 1 } }))
      .rejects.toMatchObject({ code: 'AI_RECEIPT_UNAVAILABLE' });
    await f.guard.saveBusinessRecovery(f.executor, 'owner', requestId, { contractVersion: 2,
      drafts: [{ id: 'one' }, { id: 'two' }], request: { requestId, providerCalls: 1, maxProviderCalls: 1 } });
    throw new Error('outer completion failed');
  })).rejects.toThrow();
  f.advance(86400001); await f.guard.prune('owner');
  expect(await f.guard.get('owner', requestId)).toMatchObject({ status: 'failed' });
  const replay = jest.fn(); await expect(f.guard.run('owner', request(requestId), replay)).rejects.toMatchObject({ status: 409 });
  expect(replay).not.toHaveBeenCalled();
});

test('provider errors retain safe status and cause diagnostics', async () => {
  const f = fixture();
  await expect(f.guard.run('owner', request('diagnostic-provider'), budget => budget.invoke(async () => {
    throw Object.assign(new Error('synthetic provider failure'), { code: 'PROVIDER_FAILURE', response: { status: 502 } });
  }))).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED', causeCode: 'PROVIDER_FAILURE', providerStatus: 502,
    requestId: 'diagnostic-provider', providerCalls: 1 });
});

test.each([0, 1])('a committed OCR recovery with %s provider calls restores once and expiry retains its tombstone', async providerCalls => {
  const f = fixture(), requestId = 'ocr-recovery-' + providerCalls, provider = jest.fn(async () => 'synthetic');
  const ocrRequest = request(requestId, { lane: 'ocr', maxProviderCalls: 1 });
  const work = jest.fn(async budget => {
    if (providerCalls) await budget.invoke(provider);
    const result = { contractVersion: 1, source: 'image-ocr', conversationId: 'conversation', ocr: { items: [] },
      request: { requestId, providerCalls, maxProviderCalls: 1 } };
    await f.guard.saveOcrRecovery(f.executor, 'owner', requestId, result);
    throw new Error('lost final acknowledgement');
  });
  await expect(f.guard.run('owner', ocrRequest, work)).rejects.toThrow();
  expect(await f.guard.get('owner', requestId)).toMatchObject({ status: 'completed', recoveredFromOcrTransaction: true,
    result: { source: 'image-ocr', request: { providerCalls } } });
  await f.guard.run('owner', ocrRequest, work); expect(work).toHaveBeenCalledTimes(1); expect(provider).toHaveBeenCalledTimes(providerCalls);
  f.advance(86400001); await f.guard.prune('owner');
  expect(await f.guard.get('owner', requestId)).toMatchObject({ status: 'failed' });
  await expect(f.guard.run('owner', ocrRequest, work)).rejects.toMatchObject({ status: 409 }); expect(work).toHaveBeenCalledTimes(1);
});
