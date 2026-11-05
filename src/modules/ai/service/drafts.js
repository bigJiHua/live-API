const crypto = require('crypto');
const { AiError } = require('./errors');
// Expiring process-memory proposals, separate from every business database table.
function createDraftStore({ now = Date.now, maxEntries = 500, ttl = 15 * 60 * 1000 } = {}) {
  const records = new Map();
  function prune() { for (const [id, record] of records) if (record.expiresAt <= now()) records.delete(id); }
  return {
    save(userId, input) {
      prune();
      if (records.size >= maxEntries) throw new AiError('草稿容量已满，请稍后重试', 429);
      const id = crypto.randomUUID();
      const draft = { ...structuredClone(input), id, version: 1, expiresAt: now() + ttl };
      records.set(id, { userId, draft, expiresAt: draft.expiresAt });
      return structuredClone(draft);
    },
    get(userId, id) {
      prune();
      const record = records.get(id);
      if (!record || record.userId !== userId) throw new AiError('草稿不存在或已过期', 404);
      return structuredClone(record.draft);
    },
  };
}
module.exports = { createDraftStore };
