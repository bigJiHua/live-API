const { AiError } = require('./errors');

// V3 chat can prepare artifacts, but cannot execute a formal business action.
// This outcome describes only this turn's server-created artifacts. It is not
// inferred from model prose, tool-return text, prior history, or memory writes.
function buildOperationOutcome(artifacts = []) {
  if (!Array.isArray(artifacts)) throw new AiError('本轮操作成果格式无效', 502, 'AI_INVALID_RESULT');
  const entries = [];
  for (const artifact of artifacts) {
    for (const [type, value] of [['draft', artifact?.draft], ['proposal', artifact?.proposal], ['candidate', artifact?.inputCandidate]]) {
      if (!value) continue;
      if (typeof value.id !== 'string' || !value.id.trim()) throw new AiError('本轮操作成果缺少存档标识', 502, 'AI_INVALID_RESULT');
      const readyForReview = type !== 'candidate' && ['pending', 'reviewed'].includes(value.status)
        && value.actionUnavailable !== true
        && (value.missingFields == null || Array.isArray(value.missingFields) && value.missingFields.length === 0);
      entries.push({ type, id: value.id, kind: type === 'proposal' ? value.kind : 'transaction.create',
        status: value.status, readyForReview });
    }
  }
  const state = !entries.length ? 'none' : entries.some(entry => !entry.readyForReview) ? 'needs_input' : 'awaiting_confirmation';
  const notice = state === 'awaiting_confirmation' ? '本轮已准备待核对草稿，仍需你确认提交。'
    : state === 'needs_input' ? '本轮尚有信息需要补充，未提交正式业务操作。'
      : '本轮未提交正式业务操作。';
  return { version: 1, state, formalWriteExecuted: false, artifacts: entries, notice };
}

module.exports = { buildOperationOutcome };
