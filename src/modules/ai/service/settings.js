const Joi = require('joi');
const crypto = require('crypto');
const { validate } = require('./validation');
const { AiError } = require('./errors');
const { encryptField, decryptField, isEncrypted } = require('../../../common/utils/fieldCrypto');

// 追加163 扩展（2026-11-06）：多供应商（OpenAI 兼容协议）。
// - apiUrl 放开为任意 https（本机 http 仅限 localhost/127.0.0.1，给 Ollama/LM Studio 类）
//   —— 拒绝凭据内嵌、查询串、锚点；Key 只发给用户自己填写的地址（SSRF 面收敛：无重定向、maxRedirects=0）。
// - 模型不再白名单：自由输入 + 动态获取（POST /ai/models 打厂商 /models）。
// D-028（2026-11-07 负责人指示）：连接设置（Key+模型）**加密落库、跟账号走**——
// PC 与手机（局域网同账号）共享同一 provider 配置，重启不丢、废除 60 分钟 TTL。
// 2026-11-08（负责人指示）：同一账号可保存多家接入商；Key/地址/模型只从数据库读，
// .env 的 AI_API_KEY / AI_BASE_URL / AI_MODEL 凭据模式停用（服务端不再回退）。
// 结构：L1 = 进程内 Map（get() 保持同步）；L2 = ai_provider_profile 表
// （encryptField AES-256-GCM，与预览快照/请求回执同路）。L2 成功后才更新 L1 并返回成功；
// 首请求须等待 warmup，失败可重试。executor 显式注入才启用持久化，单元测试默认纯内存。
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const MAX_PROFILES = 20;

function normalizeApiUrl(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw new AiError('请输入正确的 API 地址', 400, 'AI_ENDPOINT_DENIED'); }
  const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new AiError('API 地址必须是 https（本机调试可用 http://localhost）', 400, 'AI_ENDPOINT_DENIED');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiError('API 地址不能包含凭据、查询串或锚点', 400, 'AI_ENDPOINT_DENIED');
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

const schema = Joi.object({
  name: Joi.string().trim().min(1).max(60).pattern(/^[^\u0000-\u001f\u007f]+$/),
  apiUrl: Joi.string().max(200).required(),
  apiKey: Joi.string().min(8).max(256).pattern(/^[A-Za-z0-9_\-\.]+$/),
  model: Joi.string().min(1).max(120).pattern(/^[A-Za-z0-9._\-\/:]+$/).required(),
  // 快捷切模型（PUT /settings 带 connectionId 命中已保存接入商）时路由层会传该字段，schema 需放行
  connectionId: Joi.string().max(64).pattern(/^[A-Za-z0-9\-]+$/),
}).unknown(false);

function keyFingerprint(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
}

function defaultName(apiUrl) {
  try { return new URL(apiUrl).host.slice(0, 60) || 'AI 接入商'; } catch (_) { return 'AI 接入商'; }
}

function createPersistRepo({ executor }) {
  const normalize = value => { try { return normalizeApiUrl(value); } catch (_) { return null; } };
  return {
    async loadAll() {
      const result = await executor.execute(
        'SELECT user_id, connection_id, name, provider_host, model, api_key_cipher, key_fingerprint, is_active, updated_at FROM ai_provider_profile');
      return (result?.[0] || []).map(row => {
        let apiKey = null;
        try { apiKey = isEncrypted(row.api_key_cipher) ? decryptField(row.api_key_cipher) : null; } catch (_) { apiKey = null; }
        const apiUrl = normalize(row.provider_host);
        if (!apiKey || !apiUrl || !row.connection_id) return null;
        return { userId: row.user_id, connectionId: row.connection_id, name: String(row.name || defaultName(apiUrl)).slice(0, 60),
          apiUrl, model: row.model, apiKey, keyFingerprint: row.key_fingerprint || keyFingerprint(apiKey),
          active: Number(row.is_active) === 1, updatedAt: Number(row.updated_at) || 0 };
      }).filter(Boolean);
    },
    async insert(userId, record, stamp, queryExecutor = executor) {
      return queryExecutor.execute(
        `INSERT INTO ai_provider_profile (user_id, connection_id, name, provider_host, model, api_key_cipher, key_fingerprint, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [userId, record.connectionId, record.name, record.apiUrl, record.model,
          encryptField(String(record.apiKey)), keyFingerprint(record.apiKey), stamp, stamp]);
    },
    // connectionId 可能轮换：WHERE 必须用旧 ID 定位，否则 UPDATE 命中 0 行却仍被当成保存成功。
    async update(userId, previousConnectionId, record, stamp, queryExecutor = executor) {
      return queryExecutor.execute(
        `UPDATE ai_provider_profile SET connection_id=?, name=?, provider_host=?, model=?, api_key_cipher=?, key_fingerprint=?, updated_at=?
         WHERE user_id=? AND connection_id=?`,
        [record.connectionId, record.name, record.apiUrl, record.model, encryptField(String(record.apiKey)),
          keyFingerprint(record.apiKey), stamp, userId, previousConnectionId]);
    },
    async activate(userId, connectionId, queryExecutor = executor) {
      return queryExecutor.execute(
        'UPDATE ai_provider_profile SET is_active = IF(connection_id = ?, 1, 0) WHERE user_id = ?', [connectionId, userId]);
    },
    async remove(userId, connectionId) {
      await executor.execute('DELETE FROM ai_provider_profile WHERE user_id = ? AND connection_id = ?', [userId, connectionId]);
    },
    async removeAll(userId) {
      await executor.execute('DELETE FROM ai_provider_profile WHERE user_id = ?', [userId]);
    },
  };
}

function createSettingsStore({ now = Date.now, ttl, maxEntries = 500, maxProfiles = MAX_PROFILES,
  executor = null, logError = () => {} } = {}) {
  // ttl 形参已废弃（D-028 持久化）：保留仅为兼容旧测试注入，不再产生过期行为。
  const records = new Map(); // userId -> Map(connectionId -> record)
  const activeIds = new Map();
  const repo = executor ? createPersistRepo({ executor }) : null;
  let ready = !repo, warming = null;
  const failed = () => new AiError('AI 连接设置未保存或恢复，请稍后重试', 503, 'AI_SETTINGS_UNAVAILABLE');
  const profileLimit = () => new AiError(`最多保存 ${maxProfiles} 个 AI 接入商`, 429, 'AI_PROVIDER_LIMIT');
  function userRecords(userId) {
    if (!records.has(userId)) records.set(userId, new Map());
    return records.get(userId);
  }
  function copy(record) { return record ? { ...record } : null; }
  function sorted(map) {
    return [...(map?.values() || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function activateFallback(userId, map) {
    const fallback = sorted(map)[0];
    if (!fallback) return null;
    activeIds.set(userId, fallback.connectionId);
    map.set(fallback.connectionId, { ...fallback, active: true });
    return fallback;
  }
  function warmup() {
    if (ready) return Promise.resolve();
    if (!warming) {
      warming = repo.loadAll().then(rows => {
        for (const row of rows) {
          const map = userRecords(row.userId);
          if (!map.has(row.connectionId)) {
            map.set(row.connectionId, { connectionId: row.connectionId, name: row.name, apiUrl: row.apiUrl,
              model: row.model, apiKey: row.apiKey, keyFingerprint: row.keyFingerprint,
              active: false, updatedAt: row.updatedAt });
          }
          if (row.active && !activeIds.has(row.userId)) activeIds.set(row.userId, row.connectionId);
        }
        // 数据库里一条生效标记都没有（手工改表/旧数据）时，选最近更新的一家兜底，避免整站显示未配置。
        for (const [userId, map] of records) {
          if (activeIds.has(userId)) continue;
          activateFallback(userId, map);
        }
        ready = true;
      }).catch(error => {
        warming = null;
        logError(error);
        throw failed();
      });
    }
    return warming;
  }
  const store = {
    isReady: () => ready,
    get(userId) {
      const id = activeIds.get(userId);
      return id ? copy(records.get(userId)?.get(id)) : null;
    },
    list(userId) { return sorted(records.get(userId)).map(copy); },
    getByConnection(userId, connectionId) {
      if (typeof connectionId !== 'string' || !connectionId) return null;
      return copy(records.get(userId)?.get(connectionId));
    },
    findByUrl(userId, apiUrl) {
      let target;
      try { target = normalizeApiUrl(apiUrl); } catch (_) { return null; }
      return sorted(records.get(userId)).find(item => item.apiUrl === target) || null;
    },
    validate(input, current) {
      const fields = validate(schema, input);
      const apiUrl = normalizeApiUrl(fields.apiUrl);
      let apiKey = fields.apiKey;
      // 省略 Key 仅表示复用同一目标的旧 Key，不能把旧供应商凭据带到新地址。
      if (!apiKey && current?.apiKey && typeof current.apiUrl === 'string' &&
          apiUrl === normalizeApiUrl(current.apiUrl)) {
        apiKey = current.apiKey;
      }
      if (!apiKey) {
        throw new AiError(current?.apiKey ? '更换 API 地址时请填写该地址的 API Key' : '请填写 API Key',
          400, 'AI_KEY_REQUIRED');
      }
      return { name: fields.name || current?.name || defaultName(apiUrl), apiUrl, apiKey, model: fields.model };
    },
    save(userId, fields, options = {}) {
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      if (!records.has(userId) && records.size >= maxEntries) throw new AiError('连接设置容量已满，请稍后重试', 429);
      const requestedId = typeof options.connectionId === 'string' ? options.connectionId : null;
      const existing = requestedId ? store.getByConnection(userId, requestedId) : null;
      if (requestedId && !existing) throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
      // 旧客户端不带 name 时按地址更新同一接入商；显式命名则视为新增，允许同地址多账号共存。
      const target = existing || (!fields?.name && fields?.apiUrl ? store.findByUrl(userId, fields.apiUrl) : null);
      const value = store.validate(fields, target);
      const map = userRecords(userId);
      if (!target && map.size >= maxProfiles) throw profileLimit();
      // 名称唯一性与数据库 utf8mb4_unicode_ci 对齐（大小写不敏感），避免预检通过后落库才报错。
      const nameKey = value.name.toLowerCase();
      if (sorted(map).some(item => item.name.toLowerCase() === nameKey && item.connectionId !== target?.connectionId)) {
        throw new AiError('接入商名称已存在，请换一个名称', 409, 'AI_PROVIDER_NAME_TAKEN');
      }
      const changed = !target || target.apiUrl !== value.apiUrl || target.model !== value.model || target.apiKey !== value.apiKey;
      const record = { connectionId: target && !changed ? target.connectionId : crypto.randomUUID(),
        name: value.name, apiUrl: value.apiUrl, model: value.model, apiKey: value.apiKey,
        keyFingerprint: keyFingerprint(value.apiKey), active: true, updatedAt: now() };
      const activate = !target || activeIds.get(userId) === target.connectionId;
      const apply = () => {
        // 轮换后旧 ID 必须从内存移除，否则 list() 会出现两条同一接入商。
        if (target && target.connectionId !== record.connectionId) map.delete(target.connectionId);
        map.set(record.connectionId, { ...record, active: activate });
        if (activate) activeIds.set(userId, record.connectionId);
      };
      if (!repo) { apply(); return; }
      return warmup().then(async () => {
        const persist = async queryExecutor => {
          if (target) {
            const result = await repo.update(userId, target.connectionId, record, record.updatedAt, queryExecutor);
            if (result?.[0]?.affectedRows !== 1) {
              throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
            }
          } else await repo.insert(userId, record, record.updatedAt, queryExecutor);
          if (activate) await repo.activate(userId, record.connectionId, queryExecutor);
        };
        try {
          if (typeof executor.getConnection === 'function') {
            // 轮换 + 激活必须原子：任一失败都回滚，内存保持旧配置。
            const conn = await executor.getConnection();
            try {
              await conn.beginTransaction();
              await persist(conn);
              await conn.commit();
            } catch (error) {
              await conn.rollback().catch(() => {});
              throw error;
            } finally { conn.release(); }
          } else {
            await persist(executor);
          }
        } catch (error) {
          if (error?.code === 'AI_PROVIDER_NOT_FOUND') throw error;
          logError(error);
          throw failed();
        }
        // 数据库全部成功后才更新内存。
        apply();
      });
    },
    activate(userId, connectionId) {
      if (!store.getByConnection(userId, connectionId)) throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
      const apply = () => activeIds.set(userId, connectionId);
      if (!repo) { apply(); return; }
      return warmup().then(async () => {
        try { await repo.activate(userId, connectionId); }
        catch (error) { logError(error); throw failed(); }
        apply();
      });
    },
    remove(userId, connectionId) {
      if (!store.getByConnection(userId, connectionId)) throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
      const apply = () => {
        const map = records.get(userId);
        map?.delete(connectionId);
        if (activeIds.get(userId) !== connectionId) return;
        activeIds.delete(userId);
        activateFallback(userId, map);
      };
      if (!repo) { apply(); return; }
      return warmup().then(async () => {
        try { await repo.remove(userId, connectionId); }
        catch (error) { logError(error); throw failed(); }
        apply();
        // 删除的是生效接入商时，把最近更新的一条同步为生效，避免重启后状态分叉。
        const fallbackId = activeIds.get(userId);
        if (fallbackId) {
          try { await repo.activate(userId, fallbackId); }
          catch (error) { logError(error); }
        }
      });
    },
    clear(userId) {
      if (!repo) { records.delete(userId); activeIds.delete(userId); return; }
      return warmup().then(async () => {
        try { await repo.removeAll(userId); }
        catch (error) { logError(error); throw failed(); }
        records.delete(userId); activeIds.delete(userId);
      });
    },
    // 启动/重建时从 ai_provider_profile 恢复全部账号的接入商（Key 解密进内存，等效于用户刚配置完）
    warmup,
    close() { records.clear(); activeIds.clear(); ready = !repo; warming = null; },
  };
  return store;
}
module.exports = { createSettingsStore, DEEPSEEK_BASE_URL, MAX_PROFILES, normalizeApiUrl, keyFingerprint };
