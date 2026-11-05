const crypto = require('crypto');
const { AiError } = require('./errors');

// Only server-produced history is accepted; never take client-supplied model messages.
function createConversationStore({ now = Date.now, ttl = 30 * 60 * 1000, maxEntries = 500 } = {}) {
  const records = new Map();
  function get(userId, id) {
    for (const [key, record] of records) if (record.expiresAt <= now()) records.delete(key);
    if (id) {
      const record = records.get(id);
      if (!record || record.userId !== userId) throw new AiError('对话不存在或已过期，请开始新对话', 404, 'AI_CONVERSATION_EXPIRED');
      return record;
    }
    if (records.size >= maxEntries) throw new AiError('对话容量已满，请稍后重试', 429);
    const record = { id: crypto.randomUUID(), userId, history: [], latestDraftId: null, expiresAt: now() + ttl };
    records.set(record.id, record);
    return record;
  }
  return {
    clearUser(userId) { for (const [id, record] of records) if (record.userId === userId) records.delete(id); },
    open(userId, id) { return structuredClone(get(userId, id)); },
    append(userId, id, { message, answer, draft, trace }) {
      const record = get(userId, id);
      const evidence = trace.map(item => ({ tool: item.tool, startDate: item.result.startDate,
        endDate: item.result.endDate, income: item.result.income, expense: item.result.expense,
        count: item.result.count, total: item.result.total }));
      record.history.push({ role: 'user', content: message },
        { role: 'assistant', content: `${answer.slice(0, 3500)}\n[应用记录的上一轮查询范围，仅供理解追问，金额应重新查询]${JSON.stringify(evidence)}` });
      record.history = record.history.slice(-10);
      if (draft) record.latestDraftId = draft.id;
      record.expiresAt = now() + ttl;
    },
  };
}
module.exports = { createConversationStore };
