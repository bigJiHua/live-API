const { todayShanghai } = require('./validation');
const { sanitizeContextSummary } = require('./modelContext');
const { validateHistoryTool } = require('./historyTools');
const { AiError } = require('./errors');
const parseMeta = value => typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch (_) { return {}; } })() : value || {};
const historyExcerpt = value => {
  const original = String(value || ''), text = original.slice(0, 4000);
  return /[\uD800-\uDBFF]$/.test(text) && /^[\uDC00-\uDFFF]/.test(original.slice(4000, 4001)) ? text.slice(0, -1) : text;
};
const validateOwner = (userId, conversationId) => {
  if ([userId, conversationId].some(value => typeof value !== 'string' || !value.trim() || value.length > 64))
    throw new AiError('历史查询所属聊天无效', 400, 'AI_REQUEST_INVALID');
};
function createHistoryReader({ executor }) {
  return {
    async search(userId, conversationId, input) {
      validateOwner(userId, conversationId);
      const { query, limit, order, role, status } = validateHistoryTool('history_search', input);
      // Escape LIKE metacharacters using an explicit constant escape character.
      const literal = query.replace(/[!%_]/g, char => `!${char}`);
      // Only fixed SQL fragments are selected; all text and scope stay bound.
      const filters = [], params = [userId, conversationId, `%${literal}%`];
      if (role) { filters.push('role = ?'); params.push(role); }
      if (status) {
        filters.push("role = 'assistant'");
        filters.push(`JSON_EXTRACT(meta, '$.failure') IS ${status === 'failed' ? 'NOT ' : ''}NULL`);
      }
      params.push(limit);
      const [rows] = await executor.execute(`SELECT id, role, content, created_at, meta FROM ai_message
        WHERE user_id = ? AND conversation_id = ? AND content LIKE ? ESCAPE '!'
          AND (meta IS NULL OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.standalone')), 'false') <> 'true')
          ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
        ORDER BY id ${order === 'oldest' ? 'ASC' : 'DESC'} LIMIT ?`, params);
      return rows.map(row => {
        const meta = parseMeta(row.meta), date = new Date(row.created_at);
        return { role: row.role, text: historyExcerpt(row.content),
          sourceDate: row.created_at != null && Number.isFinite(date.getTime()) ? todayShanghai(date) : null,
          ...(row.created_at != null && Number.isFinite(date.getTime()) ? { sourceTime: date.toISOString() } : {}),
          status: meta.failure ? 'failed' : row.role === 'assistant' ? 'completed' : 'original' };
      });
    },
    async loadSummary(userId, conversationId) {
      validateOwner(userId, conversationId);
      const [rows] = await executor.execute(`SELECT meta FROM ai_message
        WHERE user_id = ? AND conversation_id = ? AND role = 'assistant'
          AND (meta IS NULL OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.standalone')), 'false') <> 'true')
          AND JSON_EXTRACT(meta, '$.contextSummary') IS NOT NULL ORDER BY id DESC LIMIT 20`, [userId, conversationId]);
      for (const row of rows) {
        const summary = sanitizeContextSummary(parseMeta(row.meta).contextSummary);
        if (summary) return summary;
      }
      return null;
    },
  };
}
module.exports = { createHistoryReader };
