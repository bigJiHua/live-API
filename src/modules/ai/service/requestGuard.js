const crypto = require('crypto');
const db = require('../../../common/config/db');
const { AiError } = require('./errors');
const { encryptField, decryptField } = require('../../../common/utils/fieldCrypto');
const { sanitizeProviderDetail } = require('./providerDetail');
const { AI_BUDGET_LIMITS } = require('./config');

// Canonical JSON prevents key-order changes from bypassing duplicate detection.
function digestInput(value) {
  const seen = new Set();
  function canonical(input) {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (!input || typeof input !== 'object' || seen.has(input)) throw new AiError('请求内容必须为有限的 JSON 数据', 400, 'AI_REQUEST_INVALID');
    seen.add(input);
    let result;
    if (Array.isArray(input)) result = '[' + input.map(item => item === undefined ? 'null' : canonical(item)).join(',') + ']';
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new AiError('请求内容格式不正确', 400, 'AI_REQUEST_INVALID');
      result = '{' + Object.keys(input).filter(key => input[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(input[key])).join(',') + '}';
    }
    seen.delete(input);
    return result;
  }
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
const RUN_COLUMNS = 'id,lane,input_digest,status,result_payload,error_code,provider_calls,max_provider_calls,deadline_at,expires_at';
const RECEIPT_TTL = 86400000, WINDOW = 60000, MAX_REQUESTS = 30;
// Waiting is bounded per executor/user in this process; SQL still owns admission
// across processes. No provider call or durable request is created while waiting.
const admissionQueues = new WeakMap();
const RECEIPT_ERRORS = {
  AI_KEY_INVALID: 'AI 供应商拒绝了当前 Key，请查看连接设置和请求日志。',
  AI_PROVIDER_TIMEOUT: 'AI 供应商响应超时，本次已停止；不会自动重新请求。',
  AI_PROVIDER_FAILED: 'AI 供应商请求失败或返回不完整，请查看本次处理记录。',
  AI_PROVIDER_RESPONSE_LIMIT: 'AI 响应超出安全大小限制，已停止；请缩小问题后手动重试。',
  AI_PROVIDER_INCOMPLETE: 'AI 响应未正常完成，已停止；请查看处理记录后手动重试。',
  AI_PROVIDER_STREAM_INTERRUPTED: 'AI 响应流意外中断，请读取回执后手动重试；不会自动重新请求。',
  AI_PROVIDER_INVALID_RESPONSE: 'AI 响应流格式不完整，已停止；请查看处理记录后手动重试。',
  AI_PROVIDER_RATE_LIMIT: 'AI 供应商限制了本次请求，请稍后手动重试。',
  AI_INVALID_RESULT: 'AI 返回的内容未通过格式校验，本次没有可用草稿，请查看处理记录。',
  AI_ANSWER_TOO_LONG: 'AI 答复超过 12000 字符，未保存截断文章；请要求分段输出。',
  AI_INVALID_INPUT: 'AI 返回的内容或结构不符合本轮允许格式，本次没有产生结果，请调整问法后重试。',
  AI_RESULT_CLAIM_MISMATCH: '本轮没有对应的可核对草稿或入账回执，已停止；请查看实际卡片和回执。',
  AI_AMOUNT_NOT_EXPLICIT: 'AI 草稿金额与用户原话依据不一致，已停止生成，请明确金额。',
  AI_DATE_NOT_EXPLICIT: 'AI 草稿日期缺少明确依据，请补充日期后继续。',
  AI_REF_INVALID: 'AI 选择的账户或目标引用无效，已停止生成，请明确目标。',
  AI_SCOPE_INVALID: 'AI 选择的查询日期范围无效，请明确需要查询的日期。',
  AI_LOOP_BLOCKED: 'AI 重复取数或超过工具预算，本轮已停止，不会继续循环调用。',
  AI_PROVIDER_CALL_LIMIT: '本轮 AI 调用预算已用完，请查看已读取的数据并缩小问题。',
  AI_DAILY_CALL_LIMIT: '今天的 AI 调用预算已用完，请明天继续或调整预算。',
  AI_TURN_TIMEOUT: '本轮 AI 处理超过总时限，已停止继续请求，请查看处理记录。',
  AI_TURN_INTERRUPTED: '服务中断或已重启，本轮 AI 处理未完成，不会重复扣调用。',
};
function diagnostics(cause) {
  const value = {};
  const causeCode = cause?.causeCode || cause?.code;
  const causeSqlState = cause?.causeSqlState || cause?.sqlState;
  const providerStatus = cause?.providerStatus ?? cause?.response?.status;
  if (typeof causeCode === 'string') value.causeCode = causeCode.slice(0, 80);
  if (typeof causeSqlState === 'string') value.causeSqlState = causeSqlState.slice(0, 10);
  if (Number.isFinite(providerStatus)) value.providerStatus = providerStatus;
  return value;
}
function error(message, status, code, requestId, providerCalls = 0, cause) {
  const value = Object.assign(new AiError(message, status, code), { requestId, providerCalls }, diagnostics(cause));
  const detail = sanitizeProviderDetail(cause?.providerDetail);
  if (detail) value.providerDetail = detail;
  return value;
}
function identity(userId, requestId) {
  if (typeof userId !== 'string' || !userId || userId.length > 64) throw new AiError('登录身份无效', 401);
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new AiError('请求编号不正确', 400, 'AI_REQUEST_INVALID');
}

function createRequestGuard({ executor = db, clock = Date.now, diagnose = () => {}, windowMs = WINDOW, maxRequests = MAX_REQUESTS, maxConcurrent = 1,
  queueWaitMs = 30000, maxQueued = 8, queuePollMs = 250, leaseMs = 45000, heartbeatMs = 15000 } = {}) {
  if (!admissionQueues.has(executor)) admissionQueues.set(executor, new Map());
  const queues = admissionQueues.get(executor);
  // 本进程在跑的轮次登记：requestId → {userId, abort}。优雅停机（SIGINT）用它落
  // AI_TURN_INTERRUPTED 终态；硬杀（nodemon 强杀/断电）由心跳租约兜底——行内
  // deadline_at 只表示"进程活性租约"，进程死亡后 ≤leaseMs 内任何回执读取都会翻终态。
  const activeRuns = new Map();
  const report = entry => { try { diagnose(entry); } catch (_) { /* Diagnostics cannot change the request outcome. */ } };
  async function transaction(work) {
    if (typeof executor.getConnection !== 'function') throw new AiError('AI 请求防护必须支持事务', 503, 'AI_TRANSACTION_REQUIRED');
    const conn = await executor.getConnection();
    try {
      await conn.beginTransaction();
      const value = await work(conn);
      await conn.commit();
      return value;
    } catch (cause) { await conn.rollback().catch(() => {}); throw cause; }
    finally { conn.release(); }
  }
  async function release(userId, requestId, queryExecutor = executor) {
    await queryExecutor.execute('UPDATE ai_request_lane SET active_request_id=NULL,locked_until=0,updated_at=? WHERE user_id=? AND active_request_id=?', [String(clock()),userId,requestId]);
  }
  async function fail(userId, requestId, cause) {
    // 供应商真实错误摘要随失败回执落库（加密、已脱敏截断）；已有恢复载荷时不覆盖。
    const detail = sanitizeProviderDetail(cause?.providerDetail);
    const memoryNotice = typeof cause?.memoryFailureNotice === 'string' ? Array.from(cause.memoryFailureNotice).slice(0, 500).join('') : '';
    const payload = detail || memoryNotice ? encryptField(JSON.stringify({ ...(detail ? { failureDetail: detail } : {}),
      ...(memoryNotice ? { memoryFailureNotice: memoryNotice } : {}) })) : null;
    await executor.execute("UPDATE ai_request_run SET status='failed',error_code=?,result_payload=COALESCE(result_payload,?) WHERE user_id=? AND id=? AND status='running'",
      [cause.code || 'AI_REQUEST_FAILED',payload,userId,requestId]);
  }
  async function load(userId, requestId, queryExecutor = executor, lock = false) {
    const [rows] = await queryExecutor.execute('SELECT ' + RUN_COLUMNS + ' FROM ai_request_run WHERE user_id=? AND id=? LIMIT 1' + (lock ? ' FOR UPDATE' : ''), [userId,requestId]);
    return rows[0] || null;
  }
  async function expired(userId, requestId, row, queryExecutor = executor) {
    if (row.status === 'running' && Number(row.deadline_at) <= clock()) {
      const [updated] = await queryExecutor.execute("UPDATE ai_request_run SET status='failed',error_code='AI_TURN_INTERRUPTED' WHERE user_id=? AND id=? AND status='running' AND deadline_at<=?", [userId,requestId,clock()]);
      await release(userId,requestId,queryExecutor);
      if (updated.affectedRows !== 1) return await load(userId,requestId,queryExecutor) || row;
      return { ...row,status: 'failed',error_code: 'AI_TURN_INTERRUPTED' };
    }
    return row;
  }
  function receipt(requestId, row) {
    const isExpired = row.status === 'completed' && (Number(row.expires_at) <= clock() || !row.result_payload);
    const value = { contractVersion: row.lane === 'v3-chat' ? 3 : 2,requestId,status: isExpired ? 'failed' : row.status,providerCalls: Number(row.provider_calls),maxProviderCalls: Number(row.max_provider_calls) };
    if (row.status === 'completed' && !isExpired) {
      try { value.result = JSON.parse(decryptField(row.result_payload)); }
      catch (_) { return { ...value,status: 'failed',error: { code: 'AI_RECEIPT_UNAVAILABLE',message: '回执无法读取，请核对聊天历史；不会再次调用 AI' } }; }
    }
    if(row.status==='failed'&&row.lane==='local-draft'&&Number(row.max_provider_calls)===0&&Number(row.provider_calls)===0&&
      row.result_payload&&Number(row.expires_at)>clock()) {
      try {
        const result=JSON.parse(decryptField(row.result_payload));
        if(result.contractVersion===2&&result.request?.requestId===requestId&&result.request?.maxProviderCalls===0&&result.draft?.id) {
          value.status='completed';value.guardStatus='failed';value.recoveredFromLocalTransaction=true;value.result=result;
        }
      } catch(_) { /* Never retry an unreadable local recovery payload. */ }
    }
    if (row.status === 'failed' && row.lane === 'business-chat' && Number(row.max_provider_calls) === 1 &&
        Number(row.provider_calls) === 1 && row.result_payload && Number(row.expires_at) > clock()) {
      try {
        const result = JSON.parse(decryptField(row.result_payload));
        if (businessRecoveryValid(result, requestId)) {
          value.status = 'completed'; value.guardStatus = 'failed';
          value.recoveredFromBusinessTransaction = true; value.result = result;
        }
      } catch (_) { /* Unreadable recovery data never authorizes another paid call. */ }
    }
    if (row.status === 'failed' && row.lane === 'v3-chat' && row.result_payload && Number(row.expires_at) > clock()) {
      try {
        const result = JSON.parse(decryptField(row.result_payload));
        if (v3RecoveryValid(result, requestId, Number(row.provider_calls), Number(row.max_provider_calls))) {
          value.status = 'completed'; value.guardStatus = 'failed';
          value.recoveredFromV3Transaction = true; value.result = result;
        }
      } catch (_) { /* Recovery never repeats a paid call. */ }
    }
    if (row.status === 'failed' && row.lane === 'ocr' && row.result_payload && Number(row.expires_at) > clock()) {
      try {
        const result = JSON.parse(decryptField(row.result_payload));
        if (ocrRecoveryValid(result, requestId, Number(row.provider_calls))) {
          value.status = 'completed'; value.guardStatus = 'failed'; value.recoveredFromOcrTransaction = true; value.result = result;
        }
      } catch (_) { /* A retained OCR payload never permits another recognition. */ }
    }
    let memoryNotice = '';
    if (value.status === 'failed' && row.status === 'failed' && row.result_payload && Number(row.expires_at) > clock()) {
      try {
        const stored = JSON.parse(decryptField(row.result_payload));
        const detail = sanitizeProviderDetail(stored?.failureDetail);
        if (detail) value.providerDetail = detail;
        if (typeof stored?.memoryFailureNotice === 'string') memoryNotice = Array.from(stored.memoryFailureNotice).slice(0, 500).join('');
      } catch (_) { /* 修复不了的失败载荷不参与展示或重试。 */ }
    }
    if (value.status === 'failed' || isExpired) value.error = {
      code: isExpired ? 'AI_REQUEST_EXPIRED' : row.error_code || 'AI_REQUEST_FAILED',
      message: !isExpired && row.error_code === 'AI_REQUEST_CANCELLED'
        ? '本次请求已取消，未保存结果；不会再次调用 AI。'
        : RECEIPT_ERRORS[row.error_code] || '本次请求已结束，未产生结果；可在聊天里点「重试」或重新发送。',
    };
    if (value.error && memoryNotice) value.error.message += ' ' + memoryNotice;
    return value;
  }
  async function get(userId, requestId) {
    identity(userId,requestId);
    const row = await load(userId,requestId);
    if (!row) throw error('请求回执不存在',404,'AI_REQUEST_NOT_FOUND',requestId);
    return receipt(requestId,await expired(userId,requestId,row));
  }
  // Internal reconstruction gate for a failure that ended before conversation
  // loading. Never disclose the digest or turn a recovered transaction into a
  // failed parent. Missing, live, foreign, or different-input rows are no proof.
  async function failureForInput(userId, requestId, { lane, input }) {
    identity(userId,requestId);
    const digest = digestInput({ lane,input });
    const row = await load(userId,requestId);
    if (!row || row.lane !== lane || row.input_digest !== digest || row.status !== 'failed') return null;
    const current = receipt(requestId,row);
    return current.status === 'failed' ? current : null;
  }
  async function prune(userId) {
    identity(userId,'cleanup');
    // Keep id/digest tombstones indefinitely. Deleting them would make a
    // replayed UUID eligible for another paid call after retention ends.
    const [purged] = await executor.execute('UPDATE ai_request_run SET result_payload=NULL WHERE user_id=? AND expires_at<=? AND result_payload IS NOT NULL LIMIT 500', [userId,clock()]);
    await executor.execute('DELETE FROM ai_request_lane WHERE user_id=? AND active_request_id IS NULL AND window_start<?', [userId,clock() - RECEIPT_TTL]);
    return { purgedReceipts: purged.affectedRows || 0 };
  }
  async function claim(userId, requestId, lane, digest, maxProviderCalls, deadline) {
    return transaction(async conn => {
      // Serialize a user's chat/OCR/business requests across processes. Release
      // SQL locks before any provider I/O, retaining a durable bounded lease.
      await conn.execute('INSERT INTO ai_request_lane (user_id,active_request_id,locked_until,request_count,window_start,updated_at) VALUES (?,NULL,0,0,?,?) ON DUPLICATE KEY UPDATE user_id=user_id', [userId,clock(),String(clock())]);
      const [lanes] = await conn.execute('SELECT active_request_id,locked_until,request_count,window_start FROM ai_request_lane WHERE user_id=? FOR UPDATE', [userId]);
      if (lanes.length !== 1) throw new AiError('AI 请求防护不可用',503,'AI_GUARD_UNAVAILABLE');
      const prior = await load(userId,requestId,conn,true);
      if (prior) {
        if (prior.input_digest !== digest) throw error('相同请求编号不能用于不同内容',409,'AI_REQUEST_CONFLICT',requestId,Number(prior.provider_calls));
        return { prior: await expired(userId,requestId,prior,conn) };
      }
      const entry = lanes[0], stamp = clock();
      if (entry.active_request_id && Number(entry.locked_until) <= stamp) await conn.execute("UPDATE ai_request_run SET status='failed',error_code='AI_TURN_INTERRUPTED' WHERE user_id=? AND id=? AND status='running' AND deadline_at<=?", [userId,entry.active_request_id,stamp]);
      const reset = Number(entry.window_start) + windowMs <= stamp;
      const windowStart = reset ? stamp : Number(entry.window_start), count = reset ? 0 : Number(entry.request_count);
      const localOnly = lane === 'local-draft';
      // 并发上限按该用户尚未超时的 running 请求计算；本地草稿不调用模型，不受此限。
      const [active] = await conn.execute("SELECT COUNT(*) AS total FROM ai_request_run WHERE user_id=? AND status='running' AND deadline_at>? AND lane<>'local-draft'", [userId,stamp]);
      // Only admitted work consumes the window or requestId. A temporary refusal
      // must not leave a failed tombstone that prevents a manual submission later.
      if (!localOnly && count >= maxRequests) return { rateLimited: true, retryAfterMs: Math.max(1, windowStart + windowMs - stamp) };
      if (!localOnly && Number(active[0]?.total || 0) >= maxConcurrent) return { busy: true };
      await conn.execute('INSERT INTO ai_request_run (id,user_id,lane,input_digest,status,error_code,provider_calls,max_provider_calls,created_at,deadline_at,expires_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)', [requestId,userId,lane,digest,'running',null,maxProviderCalls,stamp,deadline,stamp + RECEIPT_TTL]);
      await conn.execute('UPDATE ai_request_lane SET active_request_id=?,locked_until=?,request_count=?,window_start=?,updated_at=? WHERE user_id=?', [requestId,deadline,count + (localOnly ? 0 : 1),windowStart,String(stamp),userId]);
      return { started: true };
    });
  }
  async function run(userId, { requestId = crypto.randomUUID(),lane,input,maxProviderCalls = 1,timeoutMs = 30000,signal,dailyProviderLimit = 100,failureNotice,onWait }, work) {
    identity(userId,requestId);
    if (!['legacy-chat','business-chat','v3-chat','ocr','local-draft'].includes(lane) || !Number.isInteger(maxProviderCalls) ||
        (lane === 'local-draft' ? maxProviderCalls !== 0 : maxProviderCalls < 1 || maxProviderCalls > (lane==='v3-chat'?5:lane==='legacy-chat'?4:1)) ||
        !Number.isInteger(dailyProviderLimit) || dailyProviderLimit < AI_BUDGET_LIMITS.dailyProviderCalls.min || dailyProviderLimit > AI_BUDGET_LIMITS.dailyProviderCalls.max ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || typeof work !== 'function' ||
        (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')))
      throw error('AI 请求预算不正确',400,'AI_REQUEST_INVALID',requestId);
    const digest = digestInput({ lane,input });
    let claimed, waiting = false;
    const waitStarted = Date.now();
    const cancelledBeforeAdmission = () => error('本次连接已关闭，已取消等待；没有调用 AI',499,'AI_REQUEST_CANCELLED',requestId);
    try {
      while (true) {
        if (signal?.aborted) throw cancelledBeforeAdmission();
        // 数据库里的 deadline_at 是"进程活性租约"（heartbeatMs 续租），不是轮总时限；
        // 轮总时限（timeoutMs）只活在进程内：定时器 + budget.check。
        claimed = await claim(userId,requestId,lane,digest,maxProviderCalls, clock() + leaseMs);
        if (claimed.rateLimited) {
          const limited = error('AI 请求频率超过当前窗口上限，请稍后再试',429,'AI_RATE_LIMIT',requestId);
          limited.retryAfterSeconds = Math.ceil(claimed.retryAfterMs / 1000);
          throw limited;
        }
        if (!claimed.busy) break;
        if (queueWaitMs <= 0 || Date.now() - waitStarted >= queueWaitMs || (!waiting && (queues.get(userId) || 0) >= maxQueued)) {
          const busy = error('AI 正在处理其他请求，等待已达上限，请稍后再试',503,'AI_REQUEST_BUSY',requestId);
          busy.retryAfterSeconds = 1;
          throw busy;
        }
        if (!waiting) {
          waiting = true; queues.set(userId, (queues.get(userId) || 0) + 1);
          report({ phase: 'admission-wait', userId, requestId, lane, status: 'waiting' });
          try { onWait?.({ stage: 'queued', requestId }); } catch (_) { /* UI progress cannot change admission. */ }
        }
        await new Promise((resolve, reject) => {
          const finish = () => { clearTimeout(waitTimer); signal?.removeEventListener('abort', abort); resolve(); };
          const abort = () => { clearTimeout(waitTimer); signal?.removeEventListener('abort', abort); reject(cancelledBeforeAdmission()); };
          const waitTimer = setTimeout(finish, Math.min(queuePollMs, Math.max(1, queueWaitMs - (Date.now() - waitStarted))));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    }
    catch (cause) {
      if (cause.code === 'AI_REQUEST_CANCELLED') {
        // Keep a zero-call cancellation receipt so an aborted SSE client can
        // confirm the terminal state. Never overwrite a concurrently admitted ID.
        try {
          await transaction(async conn => {
            const stamp = clock();
            await conn.execute('INSERT INTO ai_request_lane (user_id,active_request_id,locked_until,request_count,window_start,updated_at) VALUES (?,NULL,0,0,?,?) ON DUPLICATE KEY UPDATE user_id=user_id', [userId,stamp,String(stamp)]);
            await conn.execute('SELECT active_request_id,locked_until,request_count,window_start FROM ai_request_lane WHERE user_id=? FOR UPDATE', [userId]);
            if (!await load(userId,requestId,conn,true)) await conn.execute('INSERT INTO ai_request_run (id,user_id,lane,input_digest,status,error_code,provider_calls,max_provider_calls,created_at,deadline_at,expires_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)',
              [requestId,userId,lane,digest,'failed','AI_REQUEST_CANCELLED',maxProviderCalls,stamp,stamp,stamp + RECEIPT_TTL]);
          });
        } catch (_) { /* No work was dispatched; cancellation still terminates the connection. */ }
      }
      report({ phase: 'claim', userId, requestId, lane, status: 'error', ...diagnostics(cause) });
      if (cause.code === 'ER_DUP_ENTRY') throw error('请求编号已使用，不能重复调用 AI',409,'AI_REQUEST_ALREADY_USED',requestId);
      if (cause instanceof AiError) { cause.requestId ??= requestId; throw cause; }
      throw error('AI 请求防护不可用，请读取回执；不会自动请求 AI',503,'AI_GUARD_UNAVAILABLE',requestId,0,cause);
    } finally {
      if (waiting) {
        const remaining = (queues.get(userId) || 1) - 1;
        if (remaining) queues.set(userId, remaining); else queues.delete(userId);
      }
    }
    if (claimed.prior) {
      const prior = receipt(requestId,claimed.prior);
      if (prior.status === 'completed') return prior.result;
      throw error(prior.status === 'running' ? '请求正在处理，请读取回执，不要重复发送' : '此请求已结束，不会重复调用 AI',409,prior.error?.code || 'AI_REQUEST_ALREADY_USED',requestId,prior.providerCalls);
    }
    const controller = new AbortController();
    let calls = 0, inFlight = false, timer, cancelled = false, onCancel;
    const turnDeadline = clock() + timeoutMs;
    const interruptedError = () => error('服务中断或已重启，本轮 AI 处理未完成',503,'AI_TURN_INTERRUPTED',requestId,calls);
    activeRuns.set(requestId,{ userId, abort: () => controller.abort(interruptedError()) });
    // 活性租约心跳：进程活着就续租；进程死亡（含强杀）后 ≤leaseMs 内行变为可 reap。
    const heartbeat = heartbeatMs > 0 && leaseMs > 0 ? setInterval(() => {
      executor.execute("UPDATE ai_request_run SET deadline_at=? WHERE user_id=? AND id=? AND status='running'", [clock() + leaseMs,userId,requestId])
        .catch(() => { /* 续租失败由下一次心跳或死线兜底。 */ });
    }, heartbeatMs) : null;
    heartbeat?.unref?.();
    const cancellationError = () => error('本次连接已关闭，已停止后续处理；请读取请求回执',499,'AI_REQUEST_CANCELLED',requestId,calls);
    const seenTools = new Set();
    const budget = {
      requestId,signal: controller.signal,maxProviderCalls,deadlineAt: turnDeadline,
      check() {
        if (cancelled || signal?.aborted) throw cancellationError();
        if (controller.signal.aborted) {
          // 停机标记的中止带 AI_TURN_INTERRUPTED 理由；其余中止（总时限定时器）按超时报。
          if (controller.signal.reason?.code === 'AI_TURN_INTERRUPTED') throw controller.signal.reason;
          throw error('本轮 AI 请求已超时，已停止继续调用',504,'AI_TURN_TIMEOUT',requestId,calls);
        }
        if (clock() >= turnDeadline) throw error('本轮 AI 请求已超时，已停止继续调用',504,'AI_TURN_TIMEOUT',requestId,calls);
      },
      async invoke(fn) {
        this.check();
        if (inFlight) throw error('禁止同时或递归请求 AI，已终止本轮',502,'AI_LOOP_BLOCKED',requestId,calls);
        if (calls >= maxProviderCalls) throw error('已达到本轮 AI 调用上限',502,'AI_PROVIDER_CALL_LIMIT',requestId,calls);
        inFlight = true;
        try {
          if (lane === 'v3-chat') {
            // 每日额度检查与本次预占必须同事务并按用户加锁（lane → run 顺序与 claim 一致），
            // 否则并发请求会同时读到同一剩余额度并各自预占，突破每日上限。
            await transaction(async conn => {
              await conn.execute('INSERT INTO ai_request_lane (user_id,active_request_id,locked_until,request_count,window_start,updated_at) VALUES (?,NULL,0,0,?,?) ON DUPLICATE KEY UPDATE user_id=user_id', [userId,clock(),String(clock())]);
              const [lanes] = await conn.execute('SELECT user_id FROM ai_request_lane WHERE user_id=? FOR UPDATE', [userId]);
              if (lanes.length !== 1) throw new AiError('AI 请求防护不可用',503,'AI_GUARD_UNAVAILABLE');
              const dayStart = Math.floor((clock() + 28800000) / 86400000) * 86400000 - 28800000;
              const [usage] = await conn.execute("SELECT COALESCE(SUM(provider_calls),0) AS calls FROM ai_request_run WHERE user_id=? AND lane='v3-chat' AND created_at>=? AND created_at<?", [userId,dayStart,dayStart + 86400000]);
              if (Number(usage[0]?.calls || 0) >= dailyProviderLimit)
                throw error('今天的 AI 调用预算已用完，请明天继续或调整预算',429,'AI_DAILY_CALL_LIMIT',requestId,calls);
              const [used] = await conn.execute("UPDATE ai_request_run SET provider_calls=provider_calls+1 WHERE user_id=? AND id=? AND status='running' AND provider_calls<max_provider_calls AND deadline_at>?", [userId,requestId,clock()]);
              if (used.affectedRows !== 1) throw error('请求预算已用完或本轮已结束',409,'AI_PROVIDER_CALL_LIMIT',requestId,calls);
            });
          } else {
            const [used] = await executor.execute("UPDATE ai_request_run SET provider_calls=provider_calls+1 WHERE user_id=? AND id=? AND status='running' AND provider_calls<max_provider_calls AND deadline_at>?", [userId,requestId,clock()]);
            if (used.affectedRows !== 1) throw error('请求预算已用完或本轮已结束',409,'AI_PROVIDER_CALL_LIMIT',requestId,calls);
          }
          calls++;
          this.check();
          const response = await fn(controller.signal);
          this.check();
          return response;
        } finally { inFlight = false; }
      },
      tool(name,args) {
        this.check();
        const key = digestInput({ name,args });
        if (seenTools.has(key) || seenTools.size >= 12) throw error('模型重复请求工具或超过工具上限，已终止本轮',502,'AI_LOOP_BLOCKED',requestId,calls);
        seenTools.add(key);
      },
      get calls() { return calls; },
    };
    let workPromise;
    try {
      const cancellation = new Promise((_,reject) => {
        onCancel = () => { cancelled = true; controller.abort(); reject(cancellationError()); };
        if (signal?.aborted) onCancel();
        else signal?.addEventListener('abort',onCancel,{once:true});
      });
      const timeout = new Promise((_,reject) => { timer = setTimeout(() => {
        controller.abort(); reject(error('本轮 AI 处理超时，不会自动重试',504,'AI_TURN_TIMEOUT',requestId,calls));
      },timeoutMs); });
      workPromise = Promise.resolve().then(() => { budget.check(); return work(budget); });
      const value = await Promise.race([workPromise,timeout,cancellation]);
      budget.check();
      const result = value && typeof value === 'object' && !Array.isArray(value) ? { ...value,request: value.request || { requestId,providerCalls: calls,maxProviderCalls } } : value;
      const [saved] = await executor.execute("UPDATE ai_request_run SET status='completed',result_payload=? WHERE user_id=? AND id=? AND status='running' AND deadline_at>?", [encryptField(JSON.stringify(result)),userId,requestId,clock()]);
      if (saved.affectedRows !== 1) throw error('回执未提交，本轮不会重复调用 AI',409,'AI_RECEIPT_UNAVAILABLE',requestId,calls);
      return result;
    } catch (cause) {
      if (cancelled) cause = cancellationError();
      let notice = '';
      if (typeof failureNotice === 'function') {
        try { notice = Array.from(String(failureNotice() || '')).slice(0, 500).join(''); } catch (_) { /* Side-effect diagnostics cannot replace the original error. */ }
      }
      if (notice) {
        cause.memoryFailureNotice = notice;
        if (typeof cause.message === 'string' && !cause.message.includes(notice)) cause.message += ' ' + notice;
      }
      controller.abort();
      report({ phase: 'run', userId, requestId, lane, status: 'error', providerCalls: calls,
        code: cause?.code || 'AI_REQUEST_FAILED', deadlineAt: turnDeadline, timeoutMs, ...diagnostics(cause) });
      // 先落终态失败回执，再等待可能仍在进行的文件 I/O；不能因为副作用等待
      // 让回执长时间停留在 running。
      try { await fail(userId,requestId,cause); } catch (_) { /* Durable claim stays non-replayable if SQL fails. */ }
      if (workPromise) await new Promise(resolve => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; clearTimeout(wait); resolve(); } };
        const wait = setTimeout(finish, 1000);
        workPromise.catch(() => {}).then(finish);
      });
      let late = '';
      if (typeof failureNotice === 'function') {
        try { late = Array.from(String(failureNotice() || '')).slice(0, 500).join(''); } catch (_) { /* Side-effect diagnostics cannot replace the original error. */ }
      }
      if (late && late !== notice) {
        cause.memoryFailureNotice = late;
        if (typeof cause.message === 'string' && !cause.message.includes(late)) cause.message += ' ' + late;
        try {
          await executor.execute("UPDATE ai_request_run SET result_payload=? WHERE user_id=? AND id=? AND status='failed'",
            [encryptField(JSON.stringify({ memoryFailureNotice: late })), userId, requestId]);
        } catch (_) { /* The thrown failure still carries the notice to the caller. */ }
      }
      if (cause instanceof AiError) { cause.requestId ??= requestId; cause.providerCalls ??= calls; throw cause; }
      throw error('本次 AI 请求失败，请核对回执；不会自动重试' + (late || notice ? ' ' + (late || notice) : ''),502,'AI_REQUEST_FAILED',requestId,calls,cause);
    } finally {
      clearInterval(heartbeat);
      activeRuns.delete(requestId);
      clearTimeout(timer);
      if (onCancel) signal?.removeEventListener('abort',onCancel);
      // A slow expired request cannot clear a newer request's active lane.
      try { await release(userId,requestId); } catch (_) { /* Lease expires; no unsafe unlock fallback. */ }
      // Complete SQL cleanup before returning, so an enclosing verification
      // transaction cannot finish while a late cleanup statement is pending.
      try { await prune(userId); } catch (_) { /* A retained encrypted receipt is safe to clean on a later explicit run. */ }
    }
  }
  async function saveLocalRecovery(conn,userId,requestId,value) {
    identity(userId,requestId);
    if(value?.contractVersion!==2||value.request?.requestId!==requestId||value.request?.providerCalls!==0||value.request?.maxProviderCalls!==0||!value.draft?.id)
      throw new AiError('本地草稿恢复回执无效',409,'AI_RECEIPT_UNAVAILABLE');
    const [saved]=await conn.execute(`UPDATE ai_request_run SET result_payload=? WHERE user_id=? AND id=? AND lane='local-draft'
      AND max_provider_calls=0 AND provider_calls=0 AND status='running' AND deadline_at>?`,[encryptField(JSON.stringify(value)),userId,requestId,clock()]);
    if(saved.affectedRows!==1) throw new AiError('本地草稿回执未保存，本次创建已回滚',409,'AI_RECEIPT_UNAVAILABLE');
  }
  function businessRecoveryValid(value, requestId) {
    const drafts = value?.drafts || [], candidates = value?.candidates || [];
    const single = !Object.hasOwn(value || {}, 'drafts') && !Object.hasOwn(value || {}, 'candidates') &&
      ((typeof value?.draft?.id === 'string' && !value.inputCandidate) ||
       (typeof value?.inputCandidate?.id === 'string' && !value.draft));
    const batch = Array.isArray(drafts) && Array.isArray(candidates) && drafts.length + candidates.length >= 2 &&
      drafts.length + candidates.length <= 3 && drafts.every(item => typeof item?.id === 'string') &&
      candidates.every(item => typeof item?.inputCandidate?.id === 'string');
    return value?.contractVersion === 2 && value.request?.requestId === requestId &&
      value.request?.providerCalls === 1 && value.request?.maxProviderCalls === 1 &&
      (single || batch);
  }
  async function saveBusinessRecovery(conn, userId, requestId, value) {
    identity(userId, requestId);
    if (value?.contractVersion === 3) return saveV3Recovery(conn, userId, requestId, value);
    if (!businessRecoveryValid(value, requestId)) throw new AiError('交易草稿恢复回执无效',409,'AI_RECEIPT_UNAVAILABLE');
    const [saved] = await conn.execute(`UPDATE ai_request_run SET result_payload=? WHERE user_id=? AND id=? AND lane='business-chat'
      AND max_provider_calls=1 AND provider_calls=1 AND status='running' AND deadline_at>?`,
    [encryptField(JSON.stringify(value)),userId,requestId,clock()]);
    if (saved.affectedRows !== 1) throw new AiError('交易草稿回执未保存，本次创建已回滚',409,'AI_RECEIPT_UNAVAILABLE');
  }
  function v3RecoveryValid(value, requestId, calls, maximum) {
    return value?.contractVersion === 3 && typeof value.conversationId === 'string' &&
      typeof value.answer === 'string' && value.request?.requestId === requestId &&
      Number.isInteger(calls) && calls >= 1 && calls <= 5 && maximum === 5 &&
      value.request?.providerCalls === calls && value.request?.maxProviderCalls === maximum;
  }
  async function saveV3Recovery(conn, userId, requestId, value) {
    identity(userId, requestId);
    if (!v3RecoveryValid(value, requestId, value?.request?.providerCalls, value?.request?.maxProviderCalls))
      throw new AiError('AI 草稿恢复回执无效',409,'AI_RECEIPT_UNAVAILABLE');
    const [saved] = await conn.execute(`UPDATE ai_request_run SET result_payload=? WHERE user_id=? AND id=? AND lane='v3-chat'
      AND max_provider_calls=5 AND provider_calls=? AND status='running' AND deadline_at>?`,
      [encryptField(JSON.stringify(value)),userId,requestId,value.request.providerCalls,clock()]);
    if (saved.affectedRows !== 1) throw new AiError('AI 草稿回执未保存，本次创建已回滚',409,'AI_RECEIPT_UNAVAILABLE');
  }
  function ocrRecoveryValid(value, requestId, providerCalls) {
    return value?.contractVersion === 1 && value.source === 'image-ocr' && typeof value.conversationId === 'string' &&
      value.request?.requestId === requestId && value.request?.maxProviderCalls === 1 &&
      [0, 1].includes(providerCalls) && value.request?.providerCalls === providerCalls &&
      (typeof value.inputCandidate?.id === 'string' || typeof value.draft?.id === 'string' ||
        (value.ocr && Array.isArray(value.ocr.items)));
  }
  async function saveOcrRecovery(conn, userId, requestId, value) {
    identity(userId, requestId);
    if (!ocrRecoveryValid(value, requestId, value?.request?.providerCalls)) throw new AiError('图片识别恢复回执无效', 409, 'AI_RECEIPT_UNAVAILABLE');
    const [saved] = await conn.execute(`UPDATE ai_request_run SET result_payload=? WHERE user_id=? AND id=? AND lane='ocr'
      AND max_provider_calls=1 AND provider_calls=? AND status='running' AND deadline_at>?`,
    [encryptField(JSON.stringify(value)), userId, requestId, value.request.providerCalls, clock()]);
    if (saved.affectedRows !== 1) throw new AiError('图片识别回执未保存，本次保存已回滚', 409, 'AI_RECEIPT_UNAVAILABLE');
  }
  // 优雅停机（SIGINT/SIGTERM 可达时）：把本进程在跑的轮次立即落 AI_TURN_INTERRUPTED
  // 终态再退出；Windows 强杀没有信号机会，由心跳租约的 ≤leaseMs reap 兜底。
  async function shutdownAll() {
    const entries = [...activeRuns.entries()];
    activeRuns.clear();
    await Promise.all(entries.map(async ([requestId, entry]) => {
      try {
        await executor.execute("UPDATE ai_request_run SET status='failed',error_code='AI_TURN_INTERRUPTED' WHERE user_id=? AND id=? AND status='running'", [entry.userId,requestId]);
      } catch (_) { /* 数据库不可达时由租约到期 reap 兜底。 */ }
      try { entry.abort(); } catch (_) { /* 已结束。 */ }
    }));
    return entries.length;
  }
  return { run,get,failureForInput,prune,saveLocalRecovery,saveBusinessRecovery,saveV3Recovery,saveOcrRecovery,shutdownAll };
}
module.exports = { createRequestGuard,digestInput };
