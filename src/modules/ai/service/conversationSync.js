const crypto = require('crypto');
const db = require('../../../common/config/db');
const { AiError } = require('./errors');
const { encryptField, decryptField } = require('../../../common/utils/fieldCrypto');
const { createConversationStore } = require('./conversations');

function createConversationSyncStore({ executor = db, clock = Date.now, conversations = createConversationStore({ executor }) } = {}) {
  async function owned(userId, conversationId, conn = executor, lock = false) {
    const [rows] = await conn.execute('SELECT id FROM ai_conversation WHERE id=? AND user_id=? LIMIT 1' + (lock ? ' FOR UPDATE' : ''), [conversationId, userId]);
    if (rows.length !== 1) throw new AiError('这段聊天已被删除或不再可用', 404, 'AI_CONVERSATION_EXPIRED');
  }
  async function begin(userId, conversationId, requestId, message, timeoutMs, { signal } = {}) {
    const checkCancelled = () => {
      if (signal?.aborted) throw Object.assign(new AiError('本轮准备已中止，没有调用 AI', 499, 'AI_REQUEST_CANCELLED'), { requestId, providerCalls: 0 });
    };
    checkCancelled();
    const token = crypto.randomUUID(), stamp = clock();
    const conn = executor.getConnection ? await executor.getConnection() : executor;
    const lock = Boolean(executor.getConnection);
    try {
      checkCancelled();
      if (lock) await conn.beginTransaction();
      checkCancelled();
      // Share the conversation lock with deletion: an activity cannot appear
      // after the delete transaction has already removed its parent.
      await owned(userId, conversationId, conn, lock);
      checkCancelled();
      // Only an unreceipted temporary refusal (busy/rate limit) may take the
      // execution back. In-flight, completed, admitted failures and cancellation
      // tombstones all own an ai_request_run row and must never be re-queued.
      const [existing] = await conn.execute('SELECT status FROM ai_chat_activity WHERE user_id=? AND request_id=? LIMIT 1'
        + (lock ? ' FOR UPDATE' : ''), [userId, requestId]);
      checkCancelled();
      let requeued = false;
      if (existing.length === 1 && existing[0].status === 'failed') {
        const [runs] = await conn.execute('SELECT 1 FROM ai_request_run WHERE user_id=? AND id=? LIMIT 1', [userId, requestId]);
        checkCancelled();
        if (runs.length === 0) {
          const [claimed] = await conn.execute(`UPDATE ai_chat_activity SET conversation_id=?,execution_token=?,message_payload=?,
            status='queued',stage='queued',error_code=NULL,notice=NULL,updated_at=?,deadline_at=?
            WHERE user_id=? AND request_id=? AND status='failed'`,
          [conversationId, token, encryptField(message), stamp, stamp + timeoutMs, userId, requestId]);
          requeued = claimed.affectedRows === 1;
        }
      }
      checkCancelled();
      if (!requeued) await conn.execute(`INSERT INTO ai_chat_activity
        (user_id,request_id,conversation_id,execution_token,message_payload,status,stage,created_at,updated_at,deadline_at)
        VALUES (?,?,?,?,?,'queued','queued',?,?,?) ON DUPLICATE KEY UPDATE request_id=request_id`,
      [userId, requestId, conversationId, token, encryptField(message), stamp, stamp, stamp + timeoutMs]);
      checkCancelled();
      if (lock) await conn.commit();
    } catch (error) {
      if (executor.getConnection) await conn.rollback().catch(() => {});
      throw error;
    } finally { if (executor.getConnection) conn.release(); }
    return { userId, conversationId, requestId, token };
  }
  const remove = (userId, conversationId, conn = executor) => conn.execute(
    'DELETE FROM ai_chat_activity WHERE user_id=? AND conversation_id=?', [userId, conversationId]);
  const pruneOrphans = userId => executor.execute(`DELETE a FROM ai_chat_activity a
    LEFT JOIN ai_conversation c ON c.id=a.conversation_id COLLATE utf8mb4_general_ci
      AND c.user_id=a.user_id COLLATE utf8mb4_general_ci
    WHERE a.user_id=? AND c.id IS NULL`, [userId]);
  async function update(handle, status, stage, failure) {
    if (!handle) return;
    await executor.execute(`UPDATE ai_chat_activity SET status=?,stage=?,error_code=?,notice=?,updated_at=?
      WHERE user_id=? AND request_id=? AND execution_token=? AND status IN ('queued','running')`,
    [status, stage, failure?.code || null, failure?.message ? String(failure.message).slice(0, 1000) : null,
      clock(), handle.userId, handle.requestId, handle.token]);
  }
  async function snapshot(userId, conversationId, since) {
    await owned(userId, conversationId);
    // Existing persisted messages and entity versions are the replay source.
    // Reconnection always sends a fresh state snapshot even if no message was added.
    const messages = await conversations.messagesSince(userId, conversationId, since);
    // Parent claims update metadata below the message cursor. Send their links
    // in every snapshot, including while the continuation has no final message.
    const retryLinks = typeof conversations.retryLinks === 'function' ? await conversations.retryLinks(userId, conversationId) : [];
    const [activities] = await executor.execute(`SELECT request_id,message_payload,status,stage,error_code,notice,created_at,updated_at,deadline_at
      FROM ai_chat_activity WHERE user_id=? AND conversation_id=? AND
      ((status IN ('queued','running')) OR updated_at>?) ORDER BY created_at DESC LIMIT 100`,
    [userId, conversationId, clock() - 60000]);
    // 2026-11-10：排队/进行中的活动不再独立判生死——以请求回执行（ai_request_run）为真。
    // 进程死亡（重启/崩溃/断电）时 run 行先被租约 reap 或停机标记，镜像跟随真实终态；
    // run 行缺失（排队未准入）时才回退到活动自身的死线熔断。
    const pending = activities.filter(row => ['queued','running'].includes(row.status));
    // A failed authority read is unavailable evidence, not an absent run. Let
    // the client reconnect instead of inventing a timeout from stale activity.
    const [runRows] = pending.length ? await executor.execute(
      `SELECT id,status,error_code,deadline_at FROM ai_request_run WHERE user_id=? AND id IN (${pending.map(() => '?').join(',')})`,
      [userId, ...pending.map(row => row.request_id)]) : [[]];
    const runById = new Map((runRows || []).map(runRow => [runRow.id, runRow]));
    const [drafts] = await executor.execute('SELECT id,status,version,expires_at FROM bus_ai_draft WHERE user_id=? AND conversation_id=? ORDER BY expires_at DESC LIMIT 200', [userId, conversationId]);
    const [proposals] = await executor.execute('SELECT id,status,version,expires_at FROM ai_business_proposal WHERE user_id=? AND conversation_id=? ORDER BY expires_at DESC LIMIT 200', [userId, conversationId]);
    const [candidates] = await executor.execute('SELECT id,status,draft_id,input_digest,expires_at FROM ai_transaction_candidate WHERE user_id=? AND conversation_id=? ORDER BY expires_at DESC LIMIT 200', [userId, conversationId]);
    const entity = row => ({ id: row.id, status: Number(row.expires_at) <= clock() && !['committed','consumed','discarded'].includes(row.status) ? 'expired' : row.status,
      ...(row.version != null ? { version: Number(row.version) } : {}), expiresAt: Number(row.expires_at),
      ...(row.draft_id ? { draftId: row.draft_id } : {}), ...(row.input_digest ? { revision: row.input_digest } : {}) });
    const state = {
      conversationId, ...messages, retryLinks,
      activities: activities.sort((a, b) => Number(a.created_at) - Number(b.created_at)).map(row => {
        const pendingRow = ['queued','running'].includes(row.status);
        const runRow = pendingRow ? runById.get(row.request_id) : null;
        // run 行已失败，或仍在 running 但活性租约已过期 = 进程死亡，镜像为中断终态。
        const deadRun = runRow && (runRow.status === 'failed' ||
          (runRow.status === 'running' && Number(runRow.deadline_at) <= clock())) ? runRow : null;
        // 已准入请求以回执行为准；活动死线仅兜底尚无回执的排队请求。
        const completed = runRow?.status === 'completed';
        const expired = pendingRow && !runRow && Number(row.deadline_at) <= clock();
        const failed = Boolean(expired || deadRun);
        let message = ''; try { message = decryptField(row.message_payload); } catch (_) { /* Never expose unreadable ciphertext. */ }
        return { requestId: row.request_id, message, status: failed ? 'failed' : completed ? 'completed' : row.status,
          stage: failed ? 'failed' : completed ? 'completed' : row.stage,
          createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
          ...(!completed && (failed || row.error_code) ? { errorCode: deadRun ? (deadRun.error_code || 'AI_TURN_INTERRUPTED')
            : expired ? 'AI_TURN_TIMEOUT' : row.error_code } : {}),
          ...(failed ? { notice: expired && !deadRun ? '本轮处理已超时，请查看回执。' : '服务中断或已重启，本轮处理未完成，请查看回执。' }
            : !completed && row.notice ? { notice: row.notice } : {}) };
      }),
      entities: { drafts: drafts.map(entity), proposals: proposals.map(entity), candidates: candidates.map(entity) },
    };
    await owned(userId, conversationId); // A deletion during the reads wins over a stale snapshot.
    state.revision = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
    return state;
  }
  return { begin, update, snapshot, remove, pruneOrphans };
}
module.exports = { createConversationSyncStore };
