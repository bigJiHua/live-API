const { AiError } = require('./errors');

// 站点级付费搜索额度在 ai_config 单行原子预占；失败也保留预占。
// 不依赖异步审计计数或进程 Map（重启/多实例均不能重置额度）。
function createWebSearchBudget({ executor = null, now = Date.now } = {}) {
  return {
    async reserve({ day, limit }) {
      if (!executor || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new AiError('搜索预算暂不可用', 503, 'AI_WEB_SEARCH_BUDGET_UNAVAILABLE');
      try {
        await executor.execute('INSERT IGNORE INTO ai_config (id,updated_at) VALUES (1,?)', [now()]);
        const [result] = await executor.execute(`UPDATE ai_config
          SET search_calls_used=IF(search_usage_day=?,search_calls_used+1,1),search_usage_day=?
          WHERE id=1 AND (search_usage_day IS NULL OR search_usage_day<=?)
            AND (search_daily_calls IS NULL OR search_daily_calls BETWEEN 1 AND 1000)
            AND IF(search_usage_day=?,search_calls_used,0)<COALESCE(search_daily_calls,?)`,
        [day, day, day, day, limit]);
        return result.affectedRows === 1;
      } catch (_) {
        throw new AiError('搜索预算暂不可用，未调用搜索源', 503, 'AI_WEB_SEARCH_BUDGET_UNAVAILABLE');
      }
    },
  };
}

module.exports = { createWebSearchBudget };
