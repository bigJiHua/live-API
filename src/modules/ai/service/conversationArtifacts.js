const { AiError } = require('./errors');

// A prompt's empty draft window is not evidence that this conversation never
// created a card. Read counts from persisted owner-bound rows, keeping expired
// artifacts in the created total without making them actionable again.
function asksConversationArtifactState(message) {
  const asksPastCreation = /(?:写|生成|创建|整理|准备)(?:过|了|好(?:了)?)[^。！？\n]{0,30}(?:多少|几个|几份|没有|了吗|是否|有没有)/.test(message);
  if (!asksPastCreation && /(?:^|[。！？;；\n])\s*(?:帮我|请(?:你)?|替我|给我)?\s*(?:写|生成|创建|整理|准备|新增)/.test(message)) return false;
  return /(?:草稿|提案)/.test(message) &&
    /(?:状态|多少|几个|几份|数量|有没有|是否|保存|生成过|实际|目前|当前|待核对|待确认|入账|提交|过期|找不到|没看到|看不到|没有|为?零|\b0\b)/.test(message);
}

async function loadConversationArtifactState({ executor, userId, conversationId, now = Date.now }) {
  const stamp = typeof now === 'function' ? Number(now()) : Number(now);
  let drafts, proposals;
  try {
    [drafts] = await executor.execute(`SELECT 'transaction.create' AS kind,status,
    CASE WHEN status IN ('pending','reviewed') AND expires_at<=? THEN 'expired' ELSE status END AS current_status,
    CASE WHEN COALESCE(JSON_LENGTH(missing_fields),0)=0 THEN 1 ELSE 0 END AS ready,COUNT(*) AS count
    FROM bus_ai_draft WHERE user_id=? AND conversation_id=? GROUP BY status,current_status,ready`,
    [stamp, userId, conversationId]);
    [proposals] = await executor.execute(`SELECT kind,status,
    CASE WHEN status IN ('pending','reviewed') AND expires_at<=? THEN 'expired' ELSE status END AS current_status,
    CASE WHEN COALESCE(JSON_LENGTH(JSON_EXTRACT(payload,'$.missingFields')),0)=0
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.actionUnavailable')),'false')<>'true' THEN 1 ELSE 0 END AS ready,COUNT(*) AS count
    FROM ai_business_proposal WHERE user_id=? AND conversation_id=? GROUP BY kind,status,current_status,ready`,
    [stamp, userId, conversationId]);
  } catch (_) {
    throw new AiError('草稿状态暂时无法读取，请稍后再核对；目前不能确认数量', 503, 'AI_ARTIFACT_STATE_UNAVAILABLE');
  }
  const groups = [...drafts.map(row => ({ ...row, type: 'draft' })), ...proposals.map(row => ({ ...row, type: 'proposal' }))]
    .map(row => ({ type: row.type, kind: row.kind, status: row.current_status,
      readyForReview: ['pending', 'reviewed'].includes(row.current_status) && Number(row.ready) === 1, count: Number(row.count) }));
  const createdCount = groups.reduce((total, row) => total + row.count, 0);
  if (!Number.isFinite(stamp) || !Number.isSafeInteger(createdCount) || groups.some(row => !Number.isSafeInteger(row.count) || row.count < 1))
    throw new AiError('草稿状态统计暂时无法确认', 503, 'AI_ARTIFACT_STATE_UNAVAILABLE');
  return { version: 1, scope: 'current-conversation', asOf: stamp, createdCount,
    awaitingConfirmationCount: groups.filter(row => row.readyForReview).reduce((total, row) => total + row.count, 0), groups };
}

function conversationArtifactStateAnswer(state, language = 'zh') {
  if (!state || state.version !== 1) return '';
  const count = predicate => state.groups.filter(predicate).reduce((total, row) => total + row.count, 0);
  const draftCount = count(row => row.type === 'draft'), proposalCount = count(row => row.type === 'proposal');
  const expired = count(row => row.status === 'expired');
  const completed = count(row => ['committed', 'executed'].includes(row.status));
  const discarded = count(row => row.status === 'discarded');
  const needsInput = count(row => ['pending', 'reviewed'].includes(row.status) && !row.readyForReview);
  const failed = count(row => row.status === 'failed');
  if (language === 'en') {
    if (!state.createdCount) return 'No drafts or proposals have been saved in this conversation.';
    const parts = [`This conversation has saved ${state.createdCount} drafts or proposals (${draftCount} transaction drafts and ${proposalCount} business proposals).`,
      `${state.awaitingConfirmationCount} currently await review or confirmation.`];
    if (needsInput) parts.push(`${needsInput} need more information or review in the original entry.`);
    if (expired) parts.push(`${expired} have expired; they were created, but can no longer be submitted.`);
    if (completed) parts.push(`${completed} have completion receipts.`);
    if (discarded) parts.push(`${discarded} were discarded.`);
    if (failed) parts.push(`${failed} failed.`);
    return parts.join(' ');
  }
  if (!state.createdCount) return '本会话目前没有实际保存过草稿或提案。';
  const parts = [`本会话实际保存过 ${state.createdCount} 个草稿或提案：记账草稿 ${draftCount} 个，业务提案 ${proposalCount} 个。`,
    `当前待核对或确认的有 ${state.awaitingConfirmationCount} 个。`];
  if (needsInput) parts.push(`${needsInput} 个仍需补充信息或在原入口核对。`);
  if (expired) parts.push(`${expired} 个已过期，确实曾生成，但现在不能提交。`);
  if (completed) parts.push(`${completed} 个已有正式执行回执。`);
  if (discarded) parts.push(`${discarded} 个已放弃。`);
  if (failed) parts.push(`${failed} 个已失败。`);
  return parts.join('');
}

module.exports = { asksConversationArtifactState, loadConversationArtifactState, conversationArtifactStateAnswer };
