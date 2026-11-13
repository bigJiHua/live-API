const { assertResultClaims } = require('./v3Claims');
const { reconcileMemoryClaims } = require('./memoryClaims');

// Reasoning is model output too. Keep one complete, bounded round until the
// result transaction succeeds; split credentials cannot escape chunk redaction.
function createReasoningRound(round, scrub, maxChars = 12000) {
  let text = '', overflow = false;
  return {
    push(value) {
      if (overflow || typeof value !== 'string') return;
      if (text.length + value.length > maxChars) { overflow = true; text = ''; return; }
      text += value;
    },
    finish(response) {
      if (!text && !overflow) for (const field of ['reasoning_content', 'reasoning']) this.push(response?.[field]);
      if (overflow || !text.trim()) return null;
      return { round, text: scrub(text) };
    },
  };
}
function verifiedReasoningEvents(rounds, result, { scope = 'business', memoryClaims = null, scrub = text => text } = {}) {
  const artifacts = result.artifacts || (result.drafts?.length ? result.drafts.map(draft => ({ draft }))
    : [{ draft: result.draft, proposal: result.proposal }]);
  const events = [];
  let length = 0;
  for (const item of rounds) {
    if (!item?.text?.trim() || length + item.text.length > 24000) continue;
    let text;
    try {
      // A tool selected later in this turn can widen the private-data scope.
      // Re-scrub the complete thought using the final server policy before release.
      text = scrub(item.text);
      if (!text?.trim()) continue;
      const memory = memoryClaims ? reconcileMemoryClaims(text, memoryClaims) : null;
      if (memory?.corrected) continue;
      assertResultClaims(memory?.businessClaimsText || text, { artifacts, currentReceipts: [], scope });
    }
    catch (_) { continue; } // Omit unconfirmed thoughts; never fail a valid answer.
    length += text.length;
    events.push({ round: item.round, text, verified: true });
  }
  return events;
}
module.exports = { createReasoningRound, verifiedReasoningEvents };
