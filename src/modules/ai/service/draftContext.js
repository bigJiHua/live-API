const STATUSES = new Set(['pending', 'reviewed', 'committed', 'discarded']);
async function loadDraftContext({ legacyService, userId, conversation, history = [], scrub = value => value }) {
  const ids = [...new Set([conversation.latestDraftId, ...history.filter(turn => turn.role === 'assistant')
    .slice(-10).reverse().flatMap(turn => [turn.draftId, ...(turn.draftIds || []), ...(turn.business?.draftIds || [])])].filter(Boolean))].slice(0, 3);
  if (!ids.length) return [];
  const read = legacyService.getDraftState || legacyService.getDraft;
  return Promise.all(ids.map(async id => {
    if (typeof read !== 'function') return { status: 'unknown', sourceText: null };
    let draft;
    try { draft = await read.call(legacyService, userId, id); }
    catch (error) { if (![404, 410].includes(error.status)) throw error; return { status: 'unknown', sourceText: null }; }
    if (draft?.conversationId !== conversation.id) return { status: 'unknown', sourceText: null };
    return { status: STATUSES.has(draft.status) ? draft.status : 'unknown',
      sourceText: draft.originalText ? scrub(String(draft.originalText).slice(0, 1500)) : null };
  }));
}
module.exports = { loadDraftContext };
