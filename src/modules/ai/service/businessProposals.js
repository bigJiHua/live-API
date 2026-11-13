const crypto = require('crypto');
const db = require('../../../common/config/db');
const { AiError } = require('./errors');
const { createAiBusinessActions } = require('../../../common/services/aiBusinessActions');

const COLUMNS = 'id,user_id,kind,payload,source,conversation_id,preview_id,status,version,expires_at,receipt,target_snapshot';
const TTL = 15 * 60 * 1000;
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => value == null ? value : structuredClone(value);
// MySQL JSON reorders keys; snapshots contain only primitive metadata plus the
// dependency hash, so compare sorted key/value pairs rather than wire order.
const snapshotKey = value => JSON.stringify(value == null ? null : Object.keys(value).sort().map(key => [key,value[key]]));
function conflict(message = '提案版本或状态已变化，请重新核对') { throw new AiError(message, 409, 'AI_PROPOSAL_CONFLICT'); }
function checkId(id) { if (typeof id !== 'string' || !id.trim() || id.length > 50) throw new AiError('提案编号不正确'); }
function checkVersion(version) { if (!Number.isInteger(version) || version < 1) throw new AiError('提案版本不正确'); }

function createBusinessProposalStore({ executor = db, now = Date.now, actions = createAiBusinessActions({ now }) } = {}) {
  async function transaction(work, check = () => {}) {
    // There is deliberately no fallback to the pool: business rows and their
    // committed receipt must use one connection or the operation is refused.
    if (typeof executor.getConnection !== 'function') throw new AiError('业务执行器必须支持事务', 503, 'AI_TRANSACTION_REQUIRED');
    const conn = await executor.getConnection();
    let committed = false;
    try {
      await conn.beginTransaction();
      const outcome = await work(conn);
      await check(conn);
      await conn.commit();
      committed = true;
      return outcome;
    } catch (error) {
      if (!committed) await conn.rollback().catch(() => {});
      throw error;
    } finally { conn.release(); }
  }
  function toProposal(row) {
    const payload = json(row.payload) || {};
    return {
      id: row.id, kind: row.kind, fields: clone(payload.fields || {}), status: row.status,
      version: Number(row.version), expiresAt: Number(row.expires_at), missingFields: clone(payload.missingFields || []),
      source: row.source, conversationId: row.conversation_id || null, previewId: row.preview_id || null,
      schemaVersion: payload.schemaVersion || 2, policyVersion: payload.policyVersion || 1, sourceDigest: payload.sourceDigest || null,
      ...(payload.actionUnavailable ? { actionUnavailable: true, actionReason: payload.actionReason } : {}),
      targetSnapshot: clone(json(row.target_snapshot)), receipt: clone(json(row.receipt)),
    };
  }
  async function find(conn, userId, id, lock = false) {
    checkId(id);
    const [rows] = await conn.execute(`SELECT ${COLUMNS} FROM ai_business_proposal WHERE id=? AND user_id=?${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
    if (rows.length !== 1) throw new AiError('提案不存在或不属于当前用户', 404, 'AI_PROPOSAL_NOT_FOUND');
    const proposal = toProposal(rows[0]);
    if (!['committed', 'discarded'].includes(proposal.status) && proposal.expiresAt <= now()) throw new AiError('提案已过期，请重新生成', 410, 'AI_PROPOSAL_EXPIRED');
    return proposal;
  }
  async function get(userId, id) {
    const proposal = await find(executor, userId, id);
    if (proposal.receipt) proposal.receipt = await actions.getReceipt(executor, userId, proposal.receipt);
    return proposal;
  }
  function editable(proposal, version) {
    checkVersion(version);
    if (proposal.version !== version) conflict();
    if (!['pending', 'reviewed'].includes(proposal.status)) conflict(proposal.status === 'discarded' ? '这份提案已取消' : '这份提案已执行');
  }
  function ready(proposal, normalized) {
    if (normalized.actionUnavailable) throw new AiError(normalized.actionReason, 403, 'AI_ACTION_NOT_ALLOWED');
    if (normalized.missingFields.length) throw new AiError('请先补齐提案中的必填字段', 400, 'AI_PROPOSAL_INCOMPLETE');
    if (proposal.status === 'discarded') conflict('这份提案已取消');
  }
  async function assertSnapshot(conn, userId, proposal) {
    const target = await actions.prepare(conn, userId, proposal.kind, proposal.fields, true);
    if (snapshotKey(target.targetSnapshot) !== snapshotKey(proposal.targetSnapshot)) throw new AiError('目标已发生变化，请重新编辑并核对提案', 409, 'AI_TARGET_CONFLICT');
    return target;
  }
  return {
    async create(userId, { kind, fields, source = 'user-readonly', conversationId = null, previewId = null, sourceDigest = null, check = () => {} }, externalConnection = null) {
      if (!['user-readonly', 'image-ocr'].includes(source)) throw new AiError('提案来源不允许执行', 403, 'AI_ACTION_FORBIDDEN');
      if ((conversationId != null && (typeof conversationId !== 'string' || conversationId.length > 50)) ||
          (previewId != null && (typeof previewId !== 'string' || previewId.length > 50))) throw new AiError('提案溯源编号不正确');
      if (sourceDigest != null && (typeof sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(sourceDigest))) throw new AiError('提案来源摘要格式无效');
      const normalized = { ...actions.normalize(kind, fields), schemaVersion: 2, policyVersion: 1, sourceDigest };
      const id = crypto.randomUUID(), expiresAt = now() + TTL, stamp = String(now());
      const createOnConnection = async conn => {
        await check(conn);
        if (conversationId) {
          const [owned] = await conn.execute('SELECT id FROM ai_conversation WHERE id=? AND user_id=? FOR UPDATE', [conversationId, userId]);
          if (owned.length !== 1) throw new AiError('对话不存在或不属于当前用户', 404, 'AI_CONVERSATION_EXPIRED');
        }
        const target = await actions.prepare(conn, userId, kind, normalized.fields);
        await check(conn);
        await conn.execute(`INSERT INTO ai_business_proposal (id,user_id,kind,payload,source,conversation_id,preview_id,status,version,expires_at,target_snapshot,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'pending',1,?,?,?,?)`, [id, userId, kind, JSON.stringify(normalized), source, conversationId, previewId,
          expiresAt, target.targetSnapshot ? JSON.stringify(target.targetSnapshot) : null, stamp, stamp]);
        await check(conn);
      };
      if (externalConnection) {
        if (typeof externalConnection.execute !== 'function') throw new AiError('提案事务连接无效', 503, 'AI_TRANSACTION_REQUIRED');
        await createOnConnection(externalConnection);
        return find(externalConnection, userId, id);
      }
      await transaction(createOnConnection, check);
      return get(userId, id);
    },
    get,
    async edit(userId, id, version, fields) {
      checkVersion(version);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new AiError('提案编辑字段格式不正确');
      await transaction(async conn => {
        const proposal = await find(conn, userId, id, true); editable(proposal, version);
        // Edits are patches over the stored whitelist fields. A changed target
        // gets a fresh snapshot and always loses its reviewed status.
        const normalized = { ...actions.normalize(proposal.kind, { ...proposal.fields, ...fields }),
          schemaVersion: proposal.schemaVersion, policyVersion: proposal.policyVersion, sourceDigest: proposal.sourceDigest };
        const target = await actions.prepare(conn, userId, proposal.kind, normalized.fields, true);
        const [result] = await conn.execute(`UPDATE ai_business_proposal SET payload=?,target_snapshot=?,status='pending',version=version+1,updated_at=?
          WHERE id=? AND user_id=? AND version=? AND status IN ('pending','reviewed') AND expires_at>?`,
        [JSON.stringify(normalized), target.targetSnapshot ? JSON.stringify(target.targetSnapshot) : null, String(now()), id, userId, version, now()]);
        if (result.affectedRows !== 1) conflict();
      });
      return get(userId, id);
    },
    async act(userId, id, version, action) {
      checkVersion(version);
      if (!['review', 'discard'].includes(action)) throw new AiError('提案操作不正确');
      await transaction(async conn => {
        const proposal = await find(conn, userId, id, true); editable(proposal, version);
        if (action === 'review') {
          ready(proposal, actions.normalize(proposal.kind, proposal.fields));
          await assertSnapshot(conn, userId, proposal);
        }
        const [result] = await conn.execute(`UPDATE ai_business_proposal SET status=?,version=version+1,updated_at=?
          WHERE id=? AND user_id=? AND version=? AND status IN ('pending','reviewed') AND expires_at>?`,
        [action === 'review' ? 'reviewed' : 'discarded', String(now()), id, userId, version, now()]);
        if (result.affectedRows !== 1) conflict();
      });
      return get(userId, id);
    },
    async execute(userId, id, version) {
      checkVersion(version);
      const outcome = await transaction(async conn => {
        const proposal = await find(conn, userId, id, true);
        // Concurrent clicks and transport replays return the durable receipt.
        // They never invoke the business executor or its backup worker again.
        if (proposal.status === 'committed') {
          if (version !== proposal.version && version !== proposal.version - 1) conflict();
          return {};
        }
        editable(proposal, version);
        if (proposal.status !== 'reviewed') conflict('请先核对提案再执行');
        if (!['user-readonly', 'image-ocr'].includes(proposal.source)) throw new AiError('提案来源不允许执行', 403, 'AI_ACTION_FORBIDDEN');
        ready(proposal, actions.normalize(proposal.kind, proposal.fields));
        const target = await assertSnapshot(conn, userId, proposal);
        const result = await actions.execute(conn, userId, proposal, target.row, { executor });
        if (!result?.receipt) throw new AiError('业务执行缺少回执', 500, 'AI_RECEIPT_REQUIRED');
        const [saved] = await conn.execute(`UPDATE ai_business_proposal SET status='committed',version=version+1,receipt=?,updated_at=?
          WHERE id=? AND user_id=? AND version=? AND status='reviewed' AND expires_at>?`, [JSON.stringify(result.receipt), String(now()), id, userId, version, now()]);
        if (saved.affectedRows !== 1) conflict();
        return { afterCommit: result.afterCommit };
      });
      // A file backup cannot participate in SQL rollback. Its durable queued
      // job is committed first; only this successful transition may start it.
      if (outcome.afterCommit) outcome.afterCommit();
      return get(userId, id);
    },
  };
}

module.exports = { createBusinessProposalStore };
