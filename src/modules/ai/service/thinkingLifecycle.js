'use strict';

// Provider lifecycle facts only. Thought/content bytes remain in their existing
// private validation buffers and are never included in these progress events.
function createReasoningLifecycle({ round, requestId, thinkingRequested = false, onEvent, clock = Date.now, minIntervalMs = 750 }) {
  const startedAt = clock();
  let started = false, observed = false, completed = false, lastPublishedAt = -Infinity;
  const publish = state => {
    const at = clock();
    if (typeof onEvent !== 'function') return;
    lastPublishedAt = at;
    try { onEvent('reasoning_status', { requestId, round, state,
      elapsedMs: Math.max(0, Math.min(86400000, Math.round(at - startedAt))), observed }); }
    catch (_) { /* A disconnected UI cannot change the accepted model result. */ }
  };
  const start = () => {
    if (started || completed || !thinkingRequested) return;
    started = true; publish('started');
  };
  const delta = value => {
    if (completed || !value || typeof value.text !== 'string' || !value.text) return;
    if (value.type === 'reasoning' && value.text.trim()) {
      const first = !observed;
      observed = true; started = true;
      if (first || clock() - lastPublishedAt >= minIntervalMs) publish('working');
    } else if (value.type === 'content' && observed) {
      completed = true; publish('completed');
    }
  };
  const finish = message => {
    if (completed) return;
    if (!observed && ['reasoning_content', 'reasoning'].some(field => typeof message?.[field] === 'string' && message[field].trim()))
      observed = true;
    if (!started && !observed) return;
    completed = true; publish('completed');
  };
  return { start, delta, finish };
}

module.exports = { createReasoningLifecycle };
