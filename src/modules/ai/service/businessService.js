// Shared session and reviewed-proposal operations used by V3.
// Retired snapshot/chat orchestration lives only in explicit test fixtures.
const Joi = require('joi');
const db = require('../../../common/config/db');
const { AiError } = require('./errors');
const { validate } = require('./validation');
const { createPreviewStore } = require('./analysisPreviews');
const { createBusinessProposalStore } = require('./businessProposals');

function cardMetadataChoices(snapshot) {
  const byRef = new Map();
  const add = item => {
    if (!item?.ref || /^virtual_/.test(item.type || '')) return;
    byRef.set(item.ref, item);
  };
  for (const item of snapshot.choices.cards || []) add(item);
  // Inactive cards remain owner-bound in this approved dataset. Their cardRef
  // is a metadata target only; normal payment candidates stay unchanged.
  for (const dataset of snapshot.datasets || []) if (dataset.datasetId === 'card-cards' && dataset.domain === 'card') {
    for (const item of dataset.rows || []) add({ ref: item.cardRef || item.ref, name: item.name || '', type: item.type, status: item.status });
  }
  return [...byRef.values()];
}

function createBusinessService({ legacyService, executor = db, previews = createPreviewStore({ executor }),
  proposals = createBusinessProposalStore({ executor }) } = {}) {
  const runtime = userId => {
    const state = legacyService.getRuntime(userId);
    if (state.config.mode !== 'deepseek' || state.config.dataSource !== 'user-readonly' || state.businessPolicy?.enabled === false) throw new AiError('业务助手需要真实AI和独立只读数据连接', 503, 'AI_BUSINESS_DISABLED');
    return state;
  };
  async function session(userId, kind = 'default') {
    const state = runtime(userId);
    const value = await state.conversationStore.session(userId, kind);
    const messages = await state.conversationStore.messages(userId, value.id);
    for (const item of messages) if (item.proposal) {
      try { item.proposal = await getProposal(userId, item.proposal.id); }
      catch (error) { if (![404, 410].includes(error.status)) throw error; item.proposal = { ...item.proposal, status: 'expired', actionUnavailable: true, actionReason: '提案已过期，请重新生成' }; }
    }
    return { contractVersion: 2, conversationId: value.id, sessionKind: value.sessionKind, sessionDay: value.sessionDay, messages };
  }
  async function enrichProposal(userId, proposal) {
    if (!proposal.previewId) return proposal;
    let data;
    try { data = await previews.get(userId, proposal.previewId); }
    catch (error) { if (![404, 410].includes(error.status)) throw error; return proposal; }
    const choices = {};
    for (const [kind, rows] of Object.entries(data.snapshot.choices)) {
      const candidates = kind === 'cards' && proposal.kind === 'card.metadata' ? cardMetadataChoices(data.snapshot) : rows;
      choices[kind] = kind === 'moods' ? candidates : candidates.map(row => ({ ...row, id: data.refMap[row.ref]?.id })).filter(row => row.id);
    }
    return { ...proposal, choices };
  }
  async function getProposal(userId, id) { runtime(userId); return enrichProposal(userId, await proposals.get(userId, id)); }
  return { session, getProposal,
    editProposal: async (userId, id, input) => { runtime(userId); const request = validate(Joi.object({ version: Joi.number().integer().min(1).required(), fields: Joi.object().max(15).required() }).unknown(false), input);
      return enrichProposal(userId, await proposals.edit(userId, id, request.version, request.fields)); },
    actOnProposal: async (userId, id, input) => { runtime(userId); const request = validate(Joi.object({ version: Joi.number().integer().min(1).required(), action: Joi.string().valid('review', 'discard').required() }).unknown(false), input);
      return enrichProposal(userId, await proposals.act(userId, id, request.version, request.action)); },
    executeProposal: async (userId, id, input) => { const state = runtime(userId); const proposal = await proposals.get(userId, id);
      if (state.businessPolicy && !state.businessPolicy.actions.includes(proposal.kind)) throw new AiError('此业务动作尚未开放', 403, 'AI_ACTION_NOT_ALLOWED');
      const request = validate(Joi.object({ version: Joi.number().integer().min(1).required() }).unknown(false), input);
      return enrichProposal(userId, await proposals.execute(userId, id, request.version)); },
    close: async () => {} };
}
module.exports = { createBusinessService };
