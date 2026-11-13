const crypto = require('crypto');
const db = require('../../../common/config/db');
const { AiError } = require('./errors');

// 追加163（2026-11-06）：草稿从进程内存迁移到 bus_ai_draft 表。
// 仅使用公共连接池（基础设施）操作 AI 自己的表，不 import 任何业务 model/service。
// choices 不落库：读取时由 service 层实时重建（候选始终最新，且省行宽）。
// 追溯字段：original_text / trace_snapshot / source / conversation_id / committed_record_id。
function createDraftStore({ now = Date.now, ttl = 15 * 60 * 1000, executor = db } = {}) {
  // DATE 是日历值，交由数据库格式化，不能经本地午夜 Date 转 UTC 后取日。
  const CORE_FIELDS = "id, user_id, direction, amount, currency, DATE_FORMAT(trans_date, '%Y-%m-%d') AS trans_date, category_id, account_id, pay_method, remark, status, version, missing_fields, trace_snapshot, source, original_text, conversation_id, committed_record_id, expires_at, committed_at";
  function prune() { /* 惰性过期：读取时按 expires_at 判定，不删行 */ }

  function rowToDraft(row) {
    if (!row) return null;
    return {
      id: row.id, direction: row.direction, amount: String(row.amount), currency: row.currency,
      transDate: String(row.trans_date).slice(0, 10),
      categoryId: row.category_id, accountId: row.account_id, payMethod: row.pay_method,
      remark: row.remark || '', status: row.status, version: row.version,
      missingFields: row.missing_fields || [], trace: row.trace_snapshot || [],
      source: row.source, originalText: row.original_text || '', conversationId: row.conversation_id,
      committedRecordId: row.committed_record_id || null, committedAt: row.committed_at,
      expiresAt: Number(row.expires_at),
    };
  }

  async function find(userId, id, queryExecutor = executor) {
    const [rows] = await queryExecutor.execute(
      `SELECT ${CORE_FIELDS} FROM bus_ai_draft WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
    const row = rows[0];
    if (!row) throw new AiError('草稿不存在或已过期', 404);
    // 已入账记录永久保留回执；过期只阻断尚未入账的提案。
    if (row.status !== 'committed' && row.expires_at <= now()) throw new AiError('草稿不存在或已过期', 404);
    return rowToDraft(row);
  }

  return {
    prune,
    async save(userId, input, queryExecutor = executor) {
      const id = crypto.randomUUID();
      const expiresAt = now() + ttl;
      const { originalText, source, conversationId, trace, ...core } = input;
      await queryExecutor.execute(
        `INSERT INTO bus_ai_draft
         (id, user_id, direction, amount, currency, trans_date, category_id, account_id, pay_method, remark,
          status, version, missing_fields, trace_snapshot, source, original_text, conversation_id, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'pending',1,?,?,?,?,?,?)`,
        [id, userId, core.direction, String(core.amount), core.currency, core.transDate,
         core.categoryId, core.accountId, core.payMethod, core.remark || '',
         JSON.stringify(core.missingFields || []), JSON.stringify(trace || []),
         source || 'user-readonly', originalText || '', conversationId || null, expiresAt]);
      // 返回值带全量富字段（choices/名称等由入参原样带回，接口语义与内存版一致）
      return { ...structuredClone(input), id, version: 1, status: 'pending', expiresAt };
    },
    async get(userId, id, queryExecutor = executor) { prune(); return find(userId, id, queryExecutor); },
    async findByImageHash(userId, imageHash) {
      const [rows] = await executor.execute(`SELECT ${CORE_FIELDS} FROM bus_ai_draft
        WHERE user_id = ? AND source='image-ocr'
          AND JSON_UNQUOTE(JSON_EXTRACT(trace_snapshot, '$[0].imageHash')) = ?
          AND (status='committed' OR (status IN ('pending','reviewed') AND expires_at > ?))
        ORDER BY created_at DESC LIMIT 1`, [userId, imageHash, now()]);
      return rows[0] ? rowToDraft(rows[0]) : null;
    },
    async update(userId, id, version, fields) {
      const current = await find(userId, id);
      if (current.status === 'discarded') throw new AiError('这份草稿已取消', 409, 'AI_DRAFT_DISCARDED');
      if (current.status === 'committed') throw new AiError('这份草稿已入账', 409, 'AI_DRAFT_COMMITTED');
      const [result] = await executor.execute(
        `UPDATE bus_ai_draft SET direction=?, amount=?, currency=?, trans_date=?, category_id=?, account_id=?,
         pay_method=?, remark=?, missing_fields=?, trace_snapshot=?, status='pending', version=version+1
         WHERE id=? AND user_id=? AND version=? AND status IN ('pending','reviewed')
           AND expires_at > ? AND expires_at > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000`,
        [fields.direction, String(fields.amount), fields.currency, fields.transDate, fields.categoryId,
         fields.accountId, fields.payMethod, fields.remark || '',
         JSON.stringify(fields.missingFields || current.missingFields),
         JSON.stringify(fields.trace || current.trace || []),
         id, userId, version, now()]);
      if (result.affectedRows === 0) throw new AiError('草稿版本已变化，请重新核对', 409, 'AI_DRAFT_CONFLICT');
      const draft = await find(userId, id);
      return { ...structuredClone(fields), ...draft,
        categoryName: fields.categoryName ?? current.categoryName ?? null,
        accountName: fields.accountName ?? current.accountName ?? null,
        choices: fields.choices || [], needsReview: true, formalWriteEnabled: false };
    },
    async act(userId, id, version, action, financialReview = null) {
      const current = await find(userId, id);
      if (action === 'review' && current.missingFields.length) {
        throw new AiError('请先补齐草稿中的分类、账户和支付方式');
      }
      const target = action === 'review' ? 'reviewed' : 'discarded';
      const [result] = await executor.execute(
        `UPDATE bus_ai_draft SET status=?, trace_snapshot=?, version=version+1
         WHERE id=? AND user_id=? AND version=? AND status IN ('pending','reviewed')
           AND expires_at > ? AND expires_at > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000`,
        [target, JSON.stringify([...(current.trace || []).filter(item=>item.tool!=='financial_review'),
          ...(action==='review'&&financialReview?[{tool:'financial_review',result:financialReview}]:[])]), id, userId, version, now()]);
      if (result.affectedRows === 0) throw new AiError('草稿版本已变化，请重新核对', 409, 'AI_DRAFT_CONFLICT');
      const draft = await find(userId, id);
      return draft;
    },
    // ===== 追加163：入账支持 =====
    // 两类账户都与正式流水、回执在同一外部事务内提交。
    async commitInTx(conn, userId, id, version) {
      const [result] = await conn.execute(
        `UPDATE bus_ai_draft SET status='committed', committed_at=NOW(), version=version+1
         WHERE id=? AND user_id=? AND version=? AND status='reviewed' AND source IN ('user-readonly','image-ocr')
           AND expires_at > ? AND expires_at > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000`,
        [id, userId, version, now()]);
      if (result.affectedRows === 0) {
        // UPDATE 等待另一事务提交后，用当前锁定读恢复其唯一回执。
        // 未完成/取消/版本变化仍是冲突，不能把它们当作一次成功提交。
        const [rows] = await conn.execute(
          `SELECT ${CORE_FIELDS} FROM bus_ai_draft WHERE id=? AND user_id=? LIMIT 1 FOR UPDATE`, [id, userId]);
        const committed = rows[0];
        if (committed?.status === 'committed' && committed.committed_record_id) return rowToDraft(committed);
        throw new AiError('草稿版本已变化或状态不允许入账', 409, 'AI_DRAFT_CONFLICT');
      }
      return null;
    },
    async setRecordId(userId, id, recordId, queryExecutor = executor) {
      const [result] = await queryExecutor.execute(
        `UPDATE bus_ai_draft SET committed_record_id=?
         WHERE id=? AND user_id=? AND status='committed' AND committed_record_id IS NULL`,
        [recordId, id, userId]);
      if (result.affectedRows !== 1) throw new AiError('草稿入账回执冲突', 409, 'AI_DRAFT_CONFLICT');
    },
  };
}
module.exports = { createDraftStore };
