const db = require('../../../common/config/db');
const { AiError } = require('./errors');

// New UI uses conversation-bound read/operate authorization, with optional TTL.
// The JSON column stores one envelope so domain grants and session grants can
// coexist; legacy domain arrays and v2 session envelopes remain readable.
const DOMAIN_LABELS = {
  finance: '收支', account: '账户', card: '信用卡', budget: '预算', todo: '待办',
  work: '工作日记', asset: '资产', fixedAsset: '固定资产', fund: '基金', installment: '分期',
};
const LIFETIMES = Object.freeze({ conversation: null, '15m': 15 * 60000, '1h': 3600000, '24h': 86400000 });
const conversationIdValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function createDataGrantStore({ now = Date.now, executor = db } = {}) {
  const label = domains => (domains || []).map(key => DOMAIN_LABELS[key] || key).join('、');

  async function loadRow(userId, queryExecutor = executor, lock = false) {
    const result = await queryExecutor.execute(
      'SELECT provider_host, domains, granted_at, revoked_at FROM ai_data_grant WHERE user_id = ? LIMIT 1' + (lock ? ' FOR UPDATE' : ''), [userId]);
    return result?.[0]?.[0] || null;
  }

  // v3 envelope keeps both authorization shapes; v1 arrays and v2 session
  // envelopes are read in place so existing rows never need a backfill.
  function parseStored(row) {
    if (!row) return { revoked: false, providerHost: null, grantedAt: null, domains: [], sessions: [] };
    let stored = null; try { stored = JSON.parse(row.domains || 'null'); } catch { stored = null; }
    const domains = Array.isArray(stored) ? stored
      : stored?.version === 3 && Array.isArray(stored.domains) ? stored.domains : [];
    const sessions = (stored?.version === 2 || stored?.version === 3) && Array.isArray(stored.sessions)
      ? stored.sessions : [];
    return { revoked: row.revoked_at != null, providerHost: row.provider_host || null,
      grantedAt: row.granted_at == null ? null : row.granted_at, domains, sessions };
  }

  function present(row, conversationId) {
    const state = parseStored(row);
    if (conversationId) {
      const ungranted = { contractVersion: 2, granted: false, conversationId, providerHost: null, domains: [], grantedAt: null };
      const session = !state.revoked
        ? state.sessions.find(item => item.conversationId === conversationId) : null;
      if (!session || session.expiresAt != null && session.expiresAt <= now())
        return ungranted;
      const webSearch = session.webSearch && (session.webSearch.expiresAt == null || session.webSearch.expiresAt > now())
        ? session.webSearch : null;
      const access = session.access || (webSearch ? 'web_search' : null);
      if (!access) return ungranted;
      // Web-only sessions keep their authorization metadata in the child grant.
      // Older children omitted lifetime; recover it from the stored TTL without
      // rewriting the row or extending the authorization.
      const authorization = access === 'web_search' ? webSearch : session;
      if (!authorization) return ungranted;
      const lifetime = authorization.lifetime ?? Object.entries(LIFETIMES).find(([, duration]) =>
        authorization.expiresAt == null ? duration == null : duration === authorization.expiresAt - authorization.grantedAt)?.[0];
      return { contractVersion: 2, granted: true, ...session, access, webSearch,
        lifetime, grantedAt: authorization.grantedAt, expiresAt: authorization.expiresAt ?? null,
        domains: Object.keys(DOMAIN_LABELS) };
    }
    if (state.revoked || !state.domains.length)
      return { contractVersion: 1, granted: false, providerHost: null, domains: [], grantedAt: null };
    return { contractVersion: 1, granted: true, providerHost: state.providerHost,
      domains: state.domains, grantedAt: state.grantedAt };
  }

  async function get(userId, conversationId) {
    if (conversationId != null && !conversationIdValid(conversationId)) throw new AiError('授权会话无效', 400, 'AI_GRANT_INVALID');
    return present(await loadRow(userId), conversationId);
  }

  async function saveGrant(connection, userId, { providerHost, domains, sessions, grantedAt, revokedAt }) {
    await connection.execute(`INSERT INTO ai_data_grant (user_id, provider_host, domains, granted_at, revoked_at)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE provider_host = VALUES(provider_host), domains = VALUES(domains),
      granted_at = VALUES(granted_at), revoked_at = VALUES(revoked_at)`,
    [userId, providerHost || '', JSON.stringify({ version: 3, domains, sessions }), grantedAt == null ? now() : grantedAt, revokedAt ?? null]);
  }

  // One row per user; every write locks the row first so merging either shape
  // cannot drop a concurrent grant.
  async function mutateRow(userId, work) {
    const connection = executor.getConnection ? await executor.getConnection() : executor;
    try {
      if (executor.getConnection) await connection.beginTransaction();
      const row = await loadRow(userId, connection, true);
      const result = await work(parseStored(row), connection, row);
      if (executor.getConnection) await connection.commit();
      return result;
    } catch (error) {
      if (executor.getConnection) await connection.rollback().catch(() => {});
      throw error;
    } finally { if (executor.getConnection) connection.release(); }
  }

  async function mutateSessions(userId, conversationId, work) {
    if (!conversationIdValid(conversationId)) throw new AiError('授权会话无效', 400, 'AI_GRANT_INVALID');
    return mutateRow(userId, async (state, connection) => {
      // Match the grant-then-conversation lock order used by result persistence.
      const [owned] = await connection.execute('SELECT id FROM ai_conversation WHERE id = ? AND user_id = ? FOR UPDATE', [conversationId, userId]);
      if (!owned.length) throw new AiError('对话不存在或已过期', 404, 'AI_CONVERSATION_EXPIRED');
      const sessions = state.revoked ? []
        : state.sessions.filter(item => item.expiresAt == null || item.expiresAt > now());
      return work({ ...state, sessions }, connection);
    });
  }

  async function put(userId, { providerHost, domains, conversationId, lifetime, access }) {
    // 追加164：允许 host:port（本地 Ollama/LM Studio 等非 443 端口的合法供应商此前被误拒）
    if (!providerHost || typeof providerHost !== 'string' || providerHost.length > 120 ||
        !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(providerHost)) {
      throw new AiError('授权供应商主机无效', 400, 'AI_GRANT_INVALID');
    }
    if (conversationId != null) {
      if (domains != null || !Object.hasOwn(LIFETIMES, lifetime) || !['read', 'operate', 'web_search'].includes(access))
        throw new AiError('会话授权只接受能力与有效期，不接受日期或业务域限制', 400, 'AI_GRANT_INVALID');
      return mutateSessions(userId, conversationId, async ({ domains: keptDomains, sessions }, connection) => {
        const stamp = now(), expiry = LIFETIMES[lifetime] == null ? null : stamp + LIFETIMES[lifetime];
        if (access === 'web_search') {
          // §3b：联网授权是会话上的独立子授权——不覆盖既有数据访问位；无会话时建 web-only 会话。
          const existing = sessions.find(item => item.conversationId === conversationId);
          const webSearch = { lifetime, grantedAt: stamp, expiresAt: expiry };
          let next;
          if (existing && (existing.expiresAt == null || existing.expiresAt > now())) {
            next = sessions.map(item => item.conversationId === conversationId ? { ...item, webSearch } : item);
          } else {
            if (sessions.length >= 50) throw new AiError('有效授权会话过多，请先撤回不再使用的会话授权', 400, 'AI_GRANT_INVALID');
            next = [...sessions, { conversationId, providerHost, webSearch }];
          }
          await saveGrant(connection, userId, { providerHost, domains: keptDomains, sessions: next,
            grantedAt: stamp, revokedAt: null });
          return { contractVersion: 2, granted: true, conversationId, providerHost, access: 'web_search', lifetime,
            grantedAt: stamp, expiresAt: expiry, webSearch, domains: Object.keys(DOMAIN_LABELS) };
        }
        const session = { conversationId, providerHost, access, lifetime, grantedAt: stamp, expiresAt: expiry };
        const remaining = sessions.filter(item => item.conversationId !== conversationId);
        if (remaining.length >= 50) throw new AiError('有效授权会话过多，请先撤回不再使用的会话授权', 400, 'AI_GRANT_INVALID');
        // 数据会话重建时保留有效 webSearch 子授权；web-only 会话被数据授权升级后同样并入。
        const previous = sessions.find(item => item.conversationId === conversationId);
        const carriedWebSearch = previous?.webSearch && (previous.webSearch.expiresAt == null || previous.webSearch.expiresAt > now())
          ? previous.webSearch : undefined;
        const finalSession = { ...session, ...(carriedWebSearch ? { webSearch: carriedWebSearch } : {}) };
        await saveGrant(connection, userId, { providerHost, domains: keptDomains, sessions: [...remaining, finalSession],
          grantedAt: stamp, revokedAt: null });
        return { contractVersion: 2, granted: true, ...finalSession, domains: Object.keys(DOMAIN_LABELS) };
      });
    }
    if (!Array.isArray(domains) || !domains.length || domains.length > Object.keys(DOMAIN_LABELS).length ||
        domains.some(domain => typeof domain !== 'string' || !Object.hasOwn(DOMAIN_LABELS, domain) || domains.indexOf(domain) !== domains.lastIndexOf(domain))) {
      throw new AiError('授权业务域清单无效', 400, 'AI_GRANT_INVALID');
    }
    const unique = [...new Set(domains)];
    const stamp = now();
    return mutateRow(userId, async ({ sessions }, connection) => {
      await saveGrant(connection, userId, { providerHost, domains: unique, sessions, grantedAt: stamp, revokedAt: null });
      return { contractVersion: 1, granted: true, providerHost, domains: unique, grantedAt: stamp };
    });
  }

  // 撤回：会话授权只移除该会话；业务域授权只清空白名单，另一种形态保留。
  async function revoke(userId, conversationId) {
    if (conversationId != null) return mutateSessions(userId, conversationId, async ({ domains, sessions, providerHost }, connection) => {
      await saveGrant(connection, userId, { providerHost, domains, grantedAt: now(),
        sessions: sessions.filter(item => item.conversationId !== conversationId), revokedAt: null });
      return { contractVersion: 2, granted: false, conversationId, domains: [], providerHost: null, grantedAt: null };
    });
    const stamp = now();
    return mutateRow(userId, async (state, connection) => {
      if (!state.domains.length && !state.sessions.length && !state.providerHost) return { contractVersion: 1, granted: false };
      await saveGrant(connection, userId, { providerHost: state.providerHost, domains: [], sessions: state.sessions,
        grantedAt: state.grantedAt, revokedAt: state.sessions.length ? null : stamp });
      return { contractVersion: 1, granted: false };
    });
  }

  // New callers gate the capability and session; old callers retain domain coverage.
  async function requireCoverage(userId, domains, currentHost, control = {}) {
    if ((!domains || !domains.length) && !control.access) return;
    const grant = present(await loadRow(userId, control.executor || executor, control.lock === true), control.conversationId);
    if (control.conversationId) {
      if (!grant.granted || grant.providerHost !== currentHost || !grant.access || grant.access === 'web_search'
        || control.access === 'operate' && grant.access !== 'operate') {
        const error = new AiError('需要你的授权后才能使用这项能力', 403, 'AI_GRANT_REQUIRED');
        error.authorizationRequest = { version: 1, conversationId: control.conversationId, providerHost: currentHost,
          access: control.access || 'read', reason: control.reason || '读取必要的脱敏数据以回答当前问题',
          expiresAt: now() + 10 * 60000 };
        throw error;
      }
      return;
    }
    if (!grant.granted) throw new AiError('查账前请先完成一次数据授权：白名单决定 AI 能看哪些业务域，可随时撤回', 403, 'AI_GRANT_REQUIRED');
    if (currentHost && grant.providerHost !== currentHost) {
      throw new AiError('AI 连接已更换，请重新确认数据授权白名单', 403, 'AI_GRANT_REQUIRED');
    }
    const missing = domains.filter(domain => !grant.domains.includes(domain));
    if (missing.length) {
      const error = new AiError(`这条消息需要访问「${label(missing)}」数据，当前授权白名单未包含`, 403, 'AI_DOMAIN_NOT_GRANTED');
      error.missingDomains = missing;
      throw error;
    }
  }

  // §3b：联网搜索为付费能力——每次调用都必须落在有效会话授权内（webSearch 子授权）。
  async function requireWebSearch(userId, conversationId, currentHost) {
    if (!conversationId) return;
    const grant = present(await loadRow(userId, executor), conversationId);
    if (!grant.webSearch || grant.providerHost !== currentHost) {
      const error = new AiError('联网搜索为付费能力，需要你的授权后才能使用', 403, 'AI_GRANT_REQUIRED');
      error.authorizationRequest = { version: 1, conversationId, providerHost: currentHost, access: 'web_search',
        reason: '联网搜索为独立计费的付费能力，开启后本次会话的搜索费用计入当前接入商账户',
        expiresAt: now() + 10 * 60000 };
      throw error;
    }
  }
  return { get, put, revoke, requireCoverage, requireWebSearch, present };
}

module.exports = { createDataGrantStore, DOMAIN_LABELS };
