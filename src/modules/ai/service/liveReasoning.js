'use strict';

// A live display snapshot is provisional model text, never an execution
// receipt. Redact the accumulated text, not individual token chunks: a key or
// email can span chunks. Hold an unfinished ASCII token until its boundary.
function createLiveReasoning({ round, requestId, scrub = text => text, onEvent, clock = Date.now,
  minIntervalMs = 120, maxChars = 12000, consumeBudget = () => true,
  schedule = setTimeout, cancelSchedule = clearTimeout }) {
  let text = '', sequence = 0, lastText = '', lastPublished = -Infinity, overflow = false, closed = false;
  let timer = null;
  const stopTimer = () => { if (timer !== null) cancelSchedule(timer); timer = null; };
  const publish = force => {
    if (closed || overflow || typeof onEvent !== 'function' || !text) return;
    const at = clock();
    if (!force && at - lastPublished < minIntervalMs) return;
    // Include token context (password:/Bearer/etc.) when redacting. The full
    // unfinished suffix is then withheld from display until completed.
    const incomplete = /[A-Za-z0-9_@./:+\-=]+$/.exec(text);
    const boundary = !force && incomplete ? incomplete.index : text.length;
    let safe;
    try { safe = scrub(text); } catch (_) { return; }
    if (typeof safe !== 'string') return;
    if (!force && boundary < text.length) {
      // Scrub the same prefix separately only to locate the withheld suffix;
      // complete-text redaction may already have replaced its entire token.
      let prefix;
      try { prefix = scrub(text.slice(0, boundary)); } catch (_) { return; }
      if (safe.startsWith(prefix)) safe = prefix;
      else return;
    }
    safe = safe.slice(0, maxChars);
    if (!safe.trim() || safe === lastText) return;
    lastText = safe; lastPublished = at;
    try { onEvent('reasoning_delta', { requestId, round, sequence: ++sequence,
      mode: 'snapshot', provisional: true, text: safe }); }
    catch (_) { /* Progress delivery never changes the accepted result. */ }
  };
  const push = value => {
    if (closed || overflow || typeof value !== 'string' || !value) return;
    if (text.length + value.length > maxChars || !consumeBudget(value.length)) { overflow = true; text = ''; stopTimer(); return; }
    text += value;
    publish(false);
    // A short burst followed by a model pause must still reach the UI without
    // waiting for another provider chunk or the whole round to finish.
    if (!timer && !closed && !overflow) {
      const wait = Math.max(1, minIntervalMs - (clock() - lastPublished));
      timer = schedule(() => { timer = null; publish(false); }, wait); timer?.unref?.();
    }
  };
  const finish = message => {
    if (closed) return;
    if (!text && !overflow) for (const field of ['reasoning_content', 'reasoning']) {
      if (typeof message?.[field] === 'string' && message[field]) { push(message[field]); break; }
    }
    stopTimer(); publish(true); closed = true; text = '';
  };
  const clear = () => { closed = true; text = ''; stopTimer(); };
  return { push, finish, clear };
}

module.exports = { createLiveReasoning };
