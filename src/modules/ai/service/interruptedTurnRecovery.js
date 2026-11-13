const { decryptField } = require('../../../common/utils/fieldCrypto');

const INTERRUPTED = new Set(['AI_TURN_INTERRUPTED', 'AI_TURN_TIMEOUT', 'AI_REQUEST_CANCELLED']);

// A dead process cannot append its failure message. Rebuild only from the
// durable activity's original text AND an exact owner/lane/input digest proof.
// Reading a receipt never dispatches another model call or replays artifacts.
function createInterruptedTurnRecovery({ executor, requestGuard, conversations }) {
  return async function recover(userId, requestId, receipt) {
    if (receipt.contractVersion !== 3 || receipt.status !== 'failed' || !INTERRUPTED.has(receipt.error?.code)
      || typeof requestGuard.failureForInput !== 'function' || typeof conversations.appendFailure !== 'function') return;
    const [rows] = await executor.execute(`SELECT conversation_id,message_payload,created_at FROM ai_chat_activity
      WHERE user_id=? AND request_id=? LIMIT 1`, [userId, requestId]);
    if (rows.length !== 1) return;
    const activity = rows[0], message = decryptField(activity.message_payload);
    if (!message.trim()) return;
    const links = typeof conversations.retryLinks === 'function'
      ? await conversations.retryLinks(userId, activity.conversation_id) : [];
    const parents = [...new Set(links.filter(link => link.requestId === requestId).map(link => link.retryOf))];
    if (parents.length > 1) return;
    const retryOf = parents[0];
    // V3's accepted input consists only of these fields. Try the four accepted
    // modes for legacy activities, which stored text but not mode. A candidate
    // is never accepted without matching the original durable input digest.
    for (const mode of [undefined, 'chat', 'analysis', 'operate']) {
      const input = { requestId, conversationId: activity.conversation_id, message, consent: true,
        ...(mode ? { mode } : {}), ...(retryOf ? { retryOf } : {}) };
      const authority = await requestGuard.failureForInput(userId, requestId, { lane: 'v3-chat', input });
      if (authority?.status !== 'failed' || !INTERRUPTED.has(authority.error?.code)) continue;
      await conversations.appendFailure(userId, activity.conversation_id, {
        requestId, message, notice: authority.error.message, errorCode: authority.error.code,
        sentAt: Number(activity.created_at), ...(mode ? { mode } : {}), ...(retryOf ? { retryOf } : {}),
      });
      return;
    }
  };
}

module.exports = { createInterruptedTurnRecovery };
