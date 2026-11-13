// A topic boundary only limits conversational intent. It never changes a
// persisted draft, retry lineage, authorization or long-term memory.
const KIND = 'explicit-reset';
const TURN_ID = /^[\w-]{1,64}$/;
const validSentAt = value => Number.isSafeInteger(value) && value > 0;

// Existing rows use their original database timestamp. New rows preserve the
// server's request receipt time in metadata even when the reply is stored late.
function messageTimeSql(alias = 'ai_message') {
  const value = `JSON_EXTRACT(${alias}.meta, '$.sentAt')`;
  return `COALESCE(CASE WHEN JSON_TYPE(${value}) = 'INTEGER' AND CAST(JSON_UNQUOTE(${value}) AS UNSIGNED) > 0
    AND CAST(JSON_UNQUOTE(${value}) AS UNSIGNED) <= 9007199254740991
    THEN CAST(JSON_UNQUOTE(${value}) AS UNSIGNED) END, UNIX_TIMESTAMP(${alias}.created_at) * 1000, 0)`;
}
function messageSentAt(row) {
  if (validSentAt(row?.meta?.sentAt)) return row.meta.sentAt;
  if (Number.isFinite(Number(row?.turn_sent_at)) && Number(row.turn_sent_at) > 0) return Number(row.turn_sent_at);
  const time = row?.created_at == null ? NaN : new Date(row.created_at).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}
function compareMessageRows(left, right) {
  const first = messageSentAt(left), second = messageSentAt(right);
  return (first && second ? first - second : 0) || Number(left?.id || 0) - Number(right?.id || 0);
}

function sanitizeTopicBoundary(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return null; }
  }
  if (!value || value.version !== 1 || value.kind !== KIND || typeof value.turnId !== 'string' || !TURN_ID.test(value.turnId)) return null;
  const result = { version: 1, kind: KIND, turnId: value.turnId };
  if (Number.isSafeInteger(Number(value.messageId)) && Number(value.messageId) > 0) result.messageId = Number(value.messageId);
  if (validSentAt(value.sentAt)) result.sentAt = value.sentAt;
  return result;
}

// Writers supply the actual, server-admitted user text as well as the marker.
// The semantic classifier is shared with the current-turn router.
function bindTopicBoundary(value, { message, turnId, isExplicitTopicReset } = {}) {
  const safe = sanitizeTopicBoundary(value);
  if (!safe || safe.turnId !== turnId || typeof message !== 'string' || !message.trim()
    || typeof isExplicitTopicReset !== 'function' || !isExplicitTopicReset(message)) return null;
  return { version: 1, kind: KIND, turnId };
}

// Correlation to the outer ai_message keeps every read scoped to both owner
// and conversation without widening or changing its existing parameters.
const TOPIC_BOUNDARY_WHERE = `boundary.conversation_id = ai_message.conversation_id
    AND boundary.user_id = ai_message.user_id AND boundary.role = 'user'
    AND JSON_EXTRACT(boundary.meta, '$.topicBoundary.version') = 1
    AND JSON_UNQUOTE(JSON_EXTRACT(boundary.meta, '$.topicBoundary.kind')) = '${KIND}'
    AND JSON_UNQUOTE(JSON_EXTRACT(boundary.meta, '$.topicBoundary.turnId')) = JSON_UNQUOTE(JSON_EXTRACT(boundary.meta, '$.turnId'))`;
const TOPIC_BOUNDARY_ORDER = `${messageTimeSql('boundary')} DESC, boundary.id DESC`;
const TOPIC_BOUNDARY_CUTOFF = `NOT EXISTS (SELECT 1 FROM ai_message boundary WHERE ${TOPIC_BOUNDARY_WHERE}
    AND (${messageTimeSql('boundary')} > ${messageTimeSql()}
      OR (${messageTimeSql('boundary')} = ${messageTimeSql()} AND boundary.id > ai_message.id)))`;
const TOPIC_BOUNDARY_META = `(SELECT JSON_OBJECT('version', 1, 'kind', '${KIND}',
    'turnId', JSON_UNQUOTE(JSON_EXTRACT(boundary.meta, '$.turnId')), 'messageId', boundary.id,
    'sentAt', ${messageTimeSql('boundary')})
    FROM ai_message boundary WHERE ${TOPIC_BOUNDARY_WHERE} ORDER BY ${TOPIC_BOUNDARY_ORDER} LIMIT 1)`;

module.exports = { sanitizeTopicBoundary, bindTopicBoundary, TOPIC_BOUNDARY_CUTOFF, TOPIC_BOUNDARY_META,
  messageTimeSql, messageSentAt, compareMessageRows };
