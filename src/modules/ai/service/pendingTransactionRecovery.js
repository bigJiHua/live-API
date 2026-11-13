const Joi = require('joi');
const { AiError } = require('./errors');
const { validate } = require('./validation');
const { digestInput } = require('./requestGuard');
const { summarizePendingTransactionTask } = require('./pendingTransactions');

const conversationId = Joi.string().guid({ version: 'uuidv4' }).required();
const readSchema = Joi.object({ conversationId }).unknown(false);
const resumeSchema = Joi.object({ conversationId,
  taskId: Joi.string().guid({ version: 'uuidv4' }).required(),
  revision: Joi.number().integer().min(1).required(), itemIndex: Joi.number().integer().min(0).max(2).required(),
}).unknown(false);

// Explicit recovery uses the latest owner-bound task, never client-supplied
// amounts or model output. Candidate identity survives expiry and retries.
function createPendingTransactionRecovery({ conversationStore, candidateStore, executor, now=Date.now,
  requireAccess, inspect, enrichDraft, draftStore }) {
  async function load(userId, id, connection) {
    if (typeof conversationStore.loadPendingTransactionTask !== 'function')
      throw new AiError('待补任务暂时无法读取，请重新打开聊天', 503, 'AI_PENDING_UNAVAILABLE');
    return conversationStore.loadPendingTransactionTask(userId, id, connection);
  }
  async function read(userId, input) {
    requireAccess(userId);
    const request = validate(readSchema, input);
    const task = await load(userId, request.conversationId);
    return { contractVersion: 2, pendingTask: summarizePendingTransactionTask(task,{conversationId:request.conversationId,now}) };
  }
  async function resume(userId, input) {
    requireAccess(userId);
    const request = validate(resumeSchema, input);
    if (typeof executor.getConnection !== 'function')
      throw new AiError('待补恢复需要事务支持', 503, 'AI_TRANSACTION_REQUIRED');
    const conn = await executor.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute('SELECT id FROM ai_conversation WHERE id=? AND user_id=? FOR UPDATE',
        [request.conversationId, userId]);
      if (!rows.length) throw new AiError('聊天不存在或已删除', 404, 'AI_CONVERSATION_NOT_FOUND');
      const task = await load(userId, request.conversationId, conn);
      if (!task || task.status === 'cleared' || task.taskId !== request.taskId)
        throw new AiError('这份待补任务已结束或被替换，请读取最新卡片', 409, 'AI_PENDING_ENDED');
      if (task.revision !== request.revision)
        throw new AiError('待补信息已变化，请读取最新卡片后继续', 409, 'AI_PENDING_CONFLICT');
      const item = task.items[request.itemIndex];
      if (!item) throw new AiError('待补交易不存在', 409, 'AI_PENDING_CONFLICT');
      const source = task.sources[item.evidence.sourceTurn];
      const sourceFingerprint = digestInput({ pendingTask: task.taskId, itemIndex: request.itemIndex });
      const fields = { ...item.fields, accountId: null, categoryId: null };
      const checked = await inspect(userId, { fields }, { originalText: source.text, executor: conn });
      const candidate = await candidateStore.restorePending(userId, {
        source: 'user-readonly', eligible: true, conversationId: request.conversationId,
        pendingTaskId: task.taskId, pendingTaskIndex: request.itemIndex,
        pendingTaskRevision: task.revision,
        originalText: source.text, evidence: item.evidence, fields: checked.fields,
        trace: [{ tool: 'pending_transaction_resume', readOnly: true, origin: 'user',
          result: { taskId: task.taskId, revision: task.revision, itemIndex: request.itemIndex } }],
        sourceFingerprint,
      }, conn);
      requireAccess(userId);
      if (candidate.draftId) {
        const draft = await enrichDraft(userId, await draftStore.get(userId, candidate.draftId));
        if(draft.conversationId!==request.conversationId)
          throw new AiError('草稿与原待补聊天不一致，请读取原回执',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
        await conn.commit();
        return { contractVersion: 2, pendingTask: summarizePendingTransactionTask(task,{conversationId:request.conversationId,now}), inputCandidate: candidate,
          draft, fields: candidate.fields, choices: draft.choices, financialCheck: draft.financialCheck };
      }
      const result = await inspect(userId, { fields: candidate.fields }, { sourceCandidate: candidate,
        originalText: source.text, executor: conn });
      requireAccess(userId);
      await conn.commit();
      return { contractVersion: 2, ...result, pendingTask: summarizePendingTransactionTask(task,{conversationId:request.conversationId,now}),
        inputCandidate: { ...candidate, choices: result.choices } };
    } catch (error) { await conn.rollback().catch(() => {}); throw error; }
    finally { conn.release(); }
  }
  return { readPendingTransaction: read, resumePendingTransaction: resume };
}
module.exports = { createPendingTransactionRecovery };
