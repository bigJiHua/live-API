const { createRequestGuard } = require('../../src/modules/ai/service/requestGuard');

// Explicit in-memory infrastructure executor. Uses the real guard, never public DB config.
function createMemoryRequestGuard({ clock = Date.now } = {}) {
  const lanes = new Map(), runs = new Map();
  const key = (owner, id) => `${owner}\0${id}`;
  async function execute(sql, params) {
    if (sql.startsWith('INSERT INTO ai_request_lane')) {
      const [owner, window, updated] = params;
      if (!lanes.has(owner)) lanes.set(owner, { active_request_id: null, locked_until: 0, request_count: 0, window_start: window, updated_at: updated });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM ai_request_lane')) return [[...(lanes.has(params[0]) ? [structuredClone(lanes.get(params[0]))] : [])]];
    if (sql.startsWith('SELECT COALESCE(SUM(provider_calls)')) {
      const calls = [...runs.values()].filter(row => row.user_id === params[0] && row.lane === 'v3-chat' &&
        row.created_at >= params[1] && row.created_at < params[2]).reduce((sum, row) => sum + row.provider_calls, 0);
      return [[{ calls }]];
    }
    if (sql.startsWith('SELECT COUNT(*) AS total FROM ai_request_run')) {
      const total = [...runs.values()].filter(row => row.user_id === params[0] && row.status === 'running' && row.deadline_at > params[1] && row.lane !== 'local-draft').length;
      return [[{ total }]];
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM ai_request_run')) return [[...(runs.has(key(params[0], params[1])) ? [structuredClone(runs.get(key(params[0], params[1])))] : [])]];
    if (sql.startsWith('INSERT INTO ai_request_run')) {
      const [id, owner, lane, digest, status, error, max, created, deadline, expiry] = params;
      if (runs.has(key(owner, id))) throw Object.assign(new Error('Duplicate fixture request'), { code: 'ER_DUP_ENTRY' });
      runs.set(key(owner, id), { id, user_id: owner, lane, input_digest: digest, status, error_code: error,
        provider_calls: 0, max_provider_calls: max, created_at: created, deadline_at: deadline, expires_at: expiry, result_payload: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_lane SET active_request_id=NULL')) {
      const [updated, owner, id] = params, entry = lanes.get(owner);
      if (!entry || entry.active_request_id !== id) return [{ affectedRows: 0 }];
      Object.assign(entry, { active_request_id: null, locked_until: 0, updated_at: updated }); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_lane SET active_request_id=?')) {
      const [id, until, count, window, updated, owner] = params;
      Object.assign(lanes.get(owner), { active_request_id: id, locked_until: until, request_count: count, window_start: window, updated_at: updated });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_run SET provider_calls')) {
      const [owner, id, stamp] = params, row = runs.get(key(owner, id));
      if (!row || row.status !== 'running' || row.provider_calls >= row.max_provider_calls || row.deadline_at <= stamp) return [{ affectedRows: 0 }];
      row.provider_calls++; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE ai_request_run SET status='completed'")) {
      const [payload, owner, id, stamp] = params, row = runs.get(key(owner, id));
      if (!row || row.status !== 'running' || row.deadline_at <= stamp) return [{ affectedRows: 0 }];
      row.status = 'completed'; row.result_payload = payload; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_run SET result_payload=?')) {
      const [payload, owner, id, stamp] = params, row = runs.get(key(owner, id));
      const business = sql.includes("lane='business-chat'");
      const ocr = sql.includes("lane='ocr'");
      const v3 = sql.includes("lane='v3-chat'");
      const allowance = v3 ? 5 : business || ocr ? 1 : 0, providerCalls = ocr || v3 ? params[3] : allowance, deadline = ocr || v3 ? params[4] : stamp;
      if (!row || row.lane !== (v3 ? 'v3-chat' : ocr ? 'ocr' : business ? 'business-chat' : 'local-draft') ||
        row.max_provider_calls !== allowance || row.provider_calls !== providerCalls ||
        row.status !== 'running' || row.deadline_at <= deadline) return [{ affectedRows: 0 }];
      row.result_payload = payload; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE ai_request_run SET status='failed'")) {
      const timeout = sql.includes("error_code='AI_TURN_TIMEOUT'");
      const [error, payload, owner, id] = timeout ? ['AI_TURN_TIMEOUT', null, params[0], params[1]] : params;
      const row = runs.get(key(owner, id));
      if (!row || row.status !== 'running' || (timeout && row.deadline_at > params[2])) return [{ affectedRows: 0 }];
      row.status = 'failed'; row.error_code = error;
      if (!timeout && payload != null && row.result_payload == null) row.result_payload = payload;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_run SET result_payload=NULL')) {
      let count = 0;
      for (const row of runs.values()) if (row.user_id === params[0] && row.expires_at <= params[1] && row.result_payload != null) { row.result_payload = null; count++; }
      return [{ affectedRows: count }];
    }
    if (sql.startsWith('DELETE FROM ai_request_lane')) {
      const entry = lanes.get(params[0]);
      if (entry && !entry.active_request_id && entry.window_start < params[1]) lanes.delete(params[0]);
      return [{ affectedRows: 0 }];
    }
    throw new Error('Unexpected memory request SQL');
  }
  let tail = Promise.resolve();
  const executor = { execute, async getConnection() {
    let unlock, checkpoint;
    const previous = tail;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    return { execute, async beginTransaction() { checkpoint = { lanes: structuredClone(lanes), runs: structuredClone(runs) }; },
      async commit() { checkpoint = null; }, async rollback() { if (checkpoint) {
        lanes.clear(); runs.clear(); for (const [id, row] of checkpoint.lanes) lanes.set(id, row); for (const [id, row] of checkpoint.runs) runs.set(id, row);
      } }, release() { unlock(); } };
  } };
  const guard = createRequestGuard({ executor, clock });
  // Local draft recovery uses the same request rows inside its explicit write
  // transaction. This test-only handle does not replace or bypass the real guard.
  Object.defineProperty(guard, 'fixtureExecutor', { value: executor });
  return guard;
}

module.exports = { createMemoryRequestGuard };
