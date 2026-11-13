const { classifyCurrentTurn } = require('./currentTurnIntent');
const { sanitizeHistoryToolsSummary, buildHistoryToolsSummary } = require('./historyToolsSummary');
const MAX_USER_CHARS = 1500, MAX_ANSWER_CHARS = 1200;
// Persisted user turns are the authority for a topic boundary. This fallback
// also isolates older chats whose reset turn predates structured metadata.
function historySinceTopicBoundary(history = []) {
  if (!Array.isArray(history)) return [];
  const boundary = history.findLastIndex(message => message.role === 'user'
    && typeof message.content === 'string' && classifyCurrentTurn(message.content).topicReset);
  return boundary >= 0 ? history.slice(boundary) : history;
}
function selectHistoryTurns(history = [], { limit = 4 } = {}) {
  if (!Array.isArray(history)) return [];
  const count = Math.max(0, Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 4, 16));
  if (!count) return [];
  return history.filter(message => message.role === 'user' && typeof message.content === 'string')
    .slice(-count).map(user => {
      const next = history[history.indexOf(user) + 1];
      const reply = user.turnId ? history.find(message => message.role === 'assistant' && !message.standalone && message.turnId === user.turnId)
        : next?.role === 'assistant' && !next.standalone ? next : null;
      return { ...(user.turnId ? { turnId: user.turnId } : {}), user: user.content.slice(0, MAX_USER_CHARS), sourceDate: user.sourceDate || null,
        answer: reply && !reply.failure ? String(reply.content || '').split('\n[')[0].slice(0, MAX_ANSWER_CHARS) : null,
        status: reply?.failure ? 'failed' : reply ? 'completed' : 'unknown', ...(reply?.failure ? { failure: reply.failure } : {}),
        historyToolsSummary: sanitizeHistoryToolsSummary(reply?.historyToolsSummary) || buildHistoryToolsSummary(reply) };
    });
}
function buildHistoryContext({ history = [], userTurns = [], userTurnDates = [], userTurnIds = [], scrub = text => text } = {}) {
  const bound = selectHistoryTurns(history, { limit: 16 });
  const used = new Set();
  const failures = [];
  const turns = userTurns.slice(0, -1).map((text, index) => {
    const identity = userTurnIds[index];
    const position = identity ? bound.findIndex(turn => turn.turnId === identity)
      : bound.findIndex((turn, at) => !used.has(at) && turn.user === text && turn.sourceDate === (userTurnDates[index] || null));
    if (position >= 0) used.add(position);
    const found = position >= 0 ? bound[position] : null;
    if (found?.failure) failures.push({ userText: scrub(text), errorCode: found.failure.code || null });
    return { turn: index, ...(identity ? { turnId: identity } : found?.turnId ? { turnId: found.turnId } : {}),
      user: scrub(text), sourceDate: userTurnDates[index] || found?.sourceDate || null,
      answer: found?.answer ? scrub(found.answer) : null, status: found?.status || 'awaiting_input',
      historyToolsSummary: found?.historyToolsSummary || null };
  });
  return { turns, priorAnswers: turns.map(turn => turn.answer), previousFailures: failures.slice(-2) };
}
module.exports = { selectHistoryTurns, buildHistoryContext, historySinceTopicBoundary, MAX_USER_CHARS, MAX_ANSWER_CHARS };
