const { AiError } = require('./errors');

// 追加164（2026-11-07 负责人点名）：思考能力开关的用户偏好存储。
// 与 Key 连接配置（ai_provider_setting）刻意解耦：env 级供应商（当前商汤）同样生效。
// 结构与 settingsStore 同款：L1 进程内 Map（get 同步零开销）+ L2 ai_user_preference 表
// 写库确认后更新 L1。executor 为空 = 纯内存（单测默认，无 DB 副作用）。
// 语义：Map 里没有该用户 = 未设置 → 回落 env.AI_THINKING / env 缺省；显式 true/false 都会覆盖。
// 2026-11-12：新增 webSearchEnabled（§3b 用户级联网开关，默认关——收费能力须显式开启）。

function createPreferenceStore({ executor = null, logError = () => {} } = {}) {
  const records = new Map();
  const repo = executor ? {
    async loadAll() {
      const [rows] = await executor.execute('SELECT user_id, thinking_enabled, web_search_enabled FROM ai_user_preference');
      return rows.map(row => ({ userId: row.user_id, thinkingEnabled: row.thinking_enabled === 1,
        webSearchEnabled: row.web_search_enabled === 1 }));
    },
    async persist(userId, thinkingEnabled, webSearchEnabled) {
      await executor.execute(
        `INSERT INTO ai_user_preference (user_id, thinking_enabled, web_search_enabled) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE thinking_enabled = VALUES(thinking_enabled), web_search_enabled = VALUES(web_search_enabled)`,
        [userId, thinkingEnabled ? 1 : 0, webSearchEnabled ? 1 : 0]);
    }
  } : null;
  let ready = !repo, warming = null;
  function warmup() {
    if (ready) return Promise.resolve();
    if (!warming) {
      warming = repo.loadAll().then(rows => {
        for (const row of rows) if (!records.has(row.userId)) records.set(row.userId, row);
        ready = true;
      }).catch(error => {
        warming = null;
        logError(error);
        throw new AiError('AI 偏好尚未恢复，请稍后重试', 503, 'AI_PREFERENCE_UNAVAILABLE');
      });
    }
    return warming;
  }
  return {
    warmup,
    isReady: () => ready,
    // 未设置返回 undefined（区别于显式 false）；thinking 兼容旧布尔语义
    get(userId) { return records.get(userId)?.thinkingEnabled; },
    // §3b：双旗标读取（undefined=未设置）
    getFlags(userId) {
      const record = records.get(userId);
      return { thinking: record?.thinkingEnabled, webSearch: record?.webSearchEnabled };
    },
    async set(userId, thinkingEnabled, webSearchEnabled) {
      if (!userId || typeof userId !== 'string') throw new Error('登录身份无效');
      const current = records.get(userId) || {};
      const next = { thinkingEnabled: thinkingEnabled === undefined ? current.thinkingEnabled === true : thinkingEnabled === true,
        webSearchEnabled: webSearchEnabled === undefined ? current.webSearchEnabled === true : webSearchEnabled === true };
      if (repo) {
        await warmup();
        try { await repo.persist(userId, next.thinkingEnabled, next.webSearchEnabled); }
        catch (error) {
          logError(error);
          throw new AiError('AI 偏好未保存，请稍后重试', 503, 'AI_PREFERENCE_UNAVAILABLE');
        }
      }
      records.set(userId, next);
    }
  };
}

module.exports = { createPreferenceStore };
