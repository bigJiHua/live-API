const crypto = require('crypto');
const { AiError } = require('./errors');
// Expiring process-memory proposals, separate from every business database table.
function createDraftStore({ now = Date.now, maxEntries = 500, ttl = 15 * 60 * 1000 } = {}) {
  const records = new Map();
  function prune() { for (const [id, record] of records) if (record.expiresAt <= now()) records.delete(id); }
  function find(userId, id) {
    prune();
    const record = records.get(id);
    if (!record || record.userId !== userId) throw new AiError('草稿不存在或已过期', 404);
    return record;
  }
  function checkVersion(record, version) {
    if (record.draft.version !== version) throw new AiError('草稿版本已变化，请重新核对', 409, 'AI_DRAFT_CONFLICT');
    if (record.draft.status === 'discarded') throw new AiError('这份草稿已取消', 409, 'AI_DRAFT_DISCARDED');
  }
  return {
    save(userId, input) {
      prune();
      if (records.size >= maxEntries) throw new AiError('草稿容量已满，请稍后重试', 429);
      const id = crypto.randomUUID();
      const draft = { ...structuredClone(input), id, version: 1, status: 'pending', expiresAt: now() + ttl };
      records.set(id, { userId, draft, expiresAt: draft.expiresAt });
      return structuredClone(draft);
    },
    get(userId, id) {
      return structuredClone(find(userId, id).draft);
    },
    update(userId, id, version, fields) {
      const record = find(userId, id);
      checkVersion(record, version);
      record.draft = { ...record.draft, ...structuredClone(fields), id,
        version: version + 1, status: 'pending', expiresAt: record.expiresAt };
      return structuredClone(record.draft);
    },
    act(userId, id, version, action) {
      const record = find(userId, id);
      checkVersion(record, version);
      if (action === 'review' && record.draft.missingFields.length) throw new AiError('请先补齐草稿中的分类、账户和支付方式');
      record.draft.status = action === 'review' ? 'reviewed' : 'discarded';
      record.draft.version++;
      return structuredClone(record.draft);
    },
  };
}
module.exports = { createDraftStore };
