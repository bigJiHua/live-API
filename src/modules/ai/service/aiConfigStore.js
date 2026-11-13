// 2026-11-13：AI 站点默认配置（ai_config 单行表）。预算/超时五项覆盖 env，
// 改值免重启。结构仿 settings.js 两级：L1 进程内缓存（get() 同步——providerEnv 是
// 同步函数，禁止每请求异步查表）+ L2 表 warmup 加载；刷新=惰性 SWR，≤refreshMs 生效。
// 列 NULL=跟随 env 缺省（槽位不下发）；无行/表未建=与现状逐字节一致（纯 env 模式）。
// 本表存站点默认值；本人可通过 budget-settings 在 ai_user_preference 覆盖五项。
const SLOTS = [
  ['daily_provider_calls', 'AI_V3_DAILY_PROVIDER_CALLS'],
  ['max_usage_tokens', 'AI_V3_MAX_USAGE_TOKENS'],
  ['max_output_tokens', 'AI_V3_MAX_OUTPUT_TOKENS'],
  ['provider_timeout_ms', 'AI_PROVIDER_TIMEOUT_MS'],
  ['turn_timeout_ms', 'AI_V3_TURN_TIMEOUT_MS'],
  ['history_tokens', 'AI_CONTEXT_HISTORY_TOKENS'],
  ['search_daily_calls', 'AI_WEB_SEARCH_DAILY_CALLS'],
];

function createAiConfigStore({ executor, refreshMs = 60000 } = {}) {
  let cached = {};        // 仅含非 NULL 列映射出的 env 槽位（字符串值，env 语义）
  let loadedAt = 0, ready = false, refreshing = null;
  // 无 executor = 纯内存模式（单测「不碰公共库」铁律）：warmup 即就绪、恒为空覆盖。
  if (!executor) return { warmup: async () => { cached = {}; loadedAt = Date.now(); ready = true; },
    get: () => cached, isReady: () => ready };

  async function load() {
    const columns = SLOTS.map(([column]) => column).join(', ');
    let rows;
    try { [rows] = await executor.execute(`SELECT ${columns} FROM ai_config WHERE id = 1`); }
    catch (error) {
      // 增量部署尚未迁移搜索列时，仍保留已有六项预算覆盖。
      if (error.code !== 'ER_BAD_FIELD_ERROR') throw error;
      [rows] = await executor.execute(`SELECT ${SLOTS.slice(0, -1).map(([column]) => column).join(', ')} FROM ai_config WHERE id = 1`);
    }
    const row = rows?.[0];
    const next = {};
    if (row) for (const [column, slot] of SLOTS) {
      if (row[column] !== null && row[column] !== undefined) next[slot] = String(row[column]);
    }
    cached = next;
    loadedAt = Date.now();
    ready = true;
  }

  // 启动降级：表未建或暂不可达时按纯 env 模式运行（与现状逐字节一致），不阻断 AI 服务。
  function warmup() {
    return load().catch(() => { cached = {}; loadedAt = Date.now(); ready = true; });
  }

  function get() {
    if (ready && !refreshing && Date.now() - loadedAt >= refreshMs) {
      // 惰性 SWR：本次仍返回旧缓存，后台刷新供后续请求生效。
      refreshing = load().catch(() => {}).finally(() => { refreshing = null; });
    }
    return cached;
  }

  return { warmup, get, isReady: () => ready };
}

module.exports = { createAiConfigStore, AI_CONFIG_SLOTS: SLOTS };
