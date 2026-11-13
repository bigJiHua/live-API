const { createRequestGuard, digestInput } = require('../../src/modules/ai/service/requestGuard');
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
      const allowance = business || ocr ? 1 : 0, providerCalls = ocr ? p[3] : allowance, deadline = ocr ? p[4] : p[3];
      if(!row||row.lane!==(ocr?'ocr':business?'business-chat':'local-draft')||row.status!=='running'||
        row.max_provider_calls!==allowance||row.provider_calls!==providerCalls||row.deadline_at<=deadline)return [{affectedRows:0}];
      row.result_payload=p[0];return [{affectedRows:1}];
    }
    if (sql.includes("SET status='failed'")) {
      const timeout = sql.includes("error_code='AI_TURN_TIMEOUT'");
      const row = runs[key(p[timeout ? 0 : 2], p[timeout ? 1 : 3])];
      if (!row || row.status !== 'running' || (timeout && row.deadline_at > p[2])) return [{ affectedRows: 0 }];
      row.status = 'failed'; row.error_code = timeout ? 'AI_TURN_TIMEOUT' : p[0];
      if (!timeout && p[1] != null && row.result_payload == null) row.result_payload = p[1];
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
  const make = (options = {}) => createRequestGuard({ executor,clock: () => clock,...options });
  return { guard: make(),make,executor,runs,lanes,operations,connections,advance: ms => { clock += ms; },fail: value => { failAt = value; } };
}


module.exports={fixture,request};
