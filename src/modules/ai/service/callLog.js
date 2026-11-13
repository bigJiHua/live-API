const { sanitizeDiagnosticValue, redactSecretText, reportAiError } = require('./diagnostics');

// 追加164（2026-11-07 负责人指令）：AI 全链路审计日志——AI 思考/供应商调用/工具执行/门控拒绝
// 尝试异步保存到 ai_call_log；写入失败另记带请求上下文的脱敏诊断，便于排查缺失记录。
// 红线（唯一不放松项）：API Key/凭据永不入表——record 出口统一再擦一遍已知凭据字段。
// 保留期默认 90 天（与聊天历史对齐，AI_LOG_RETENTION_DAYS 可调），每 200 条写入惰性清理一次。
// executor 为空 = 纯 no-op（单测注入默认不产生副作用，既有 732 用例不受影响）。

const PAYLOAD_CAP = 64 * 1024;
const PHASE_LIMIT = 32;
const SWEEP_EVERY = 200;
const CREDENTIAL_PATTERN = /("(?:apiKey|api_key|authorization|password)"\s*:\s*)"[^"]*"/gi;
const RAW_KEY_PATTERN = /("key"\s*:\s*)"[^"]*"/gi;
function scrubAuditKeys(value, parent = '', depth = 0) {
  // Encoded tool JSON adds a nesting layer beyond the surrounding provider
  // messages. Keep bounded data schemas intact while still limiting recursion.
  if (depth > 20) return '[truncated]';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return JSON.stringify(scrubAuditKeys(parsed, '', depth + 1));
    } catch (_) { /* Non-JSON text still receives generic credential-key redaction. */ }
    return value.replace(RAW_KEY_PATTERN, '$1"[已擦除]"');
  }
  if (Array.isArray(value)) return value.map(item => scrubAuditKeys(item, parent, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const column = parent === 'columns' && ['key', 'label', 'type'].every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => ['key', 'label', 'type'].includes(key)) &&
    typeof value.label === 'string' && value.label.length <= 80 &&
    typeof value.key === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value.key) &&
    ['text', 'date', 'money', 'decimal', 'number', 'boolean', 'ref'].includes(value.type);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key.toLowerCase() === 'key' && !column ? '[已擦除]' : scrubAuditKeys(item, key, depth + 1)]));
}

function capPayload(value) {
  let text = typeof value === 'string' ? redactSecretText(value).replace(RAW_KEY_PATTERN, '$1"[已擦除]"')
    : JSON.stringify(scrubAuditKeys(sanitizeDiagnosticValue(value ?? null)));
  if (text === undefined) text = 'null';
  text = text.replace(CREDENTIAL_PATTERN, '$1"[已擦除]"');
  if (Buffer.byteLength(text) <= PAYLOAD_CAP) return text;
  // Keep the stored JSON readable when a multi-tool conversation grows. A
  // character slice used to destroy JSON and hide the very failure metadata.
  const summary = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['round', 'promptVersion', 'finalRound', 'transport', 'maxTokens', 'json', 'thinkingEnabled'])
      if (['string', 'number', 'boolean'].includes(typeof value[key])) summary[key] = value[key];
    if (Array.isArray(value.messages)) {
      summary.messageCount = value.messages.length;
      summary.roles = value.messages.reduce((counts, item) => { const role = ['system', 'user', 'assistant', 'tool'].includes(item?.role) ? item.role : 'other';
        counts[role] = (counts[role] || 0) + 1; return counts; }, {});
      summary.messageBytes = value.messages.reduce((bytes, item) => bytes + Buffer.byteLength(String(item?.content ?? '')), 0);
    }
    if (Array.isArray(value.tools)) summary.toolNames = value.tools.slice(0, 32).map(item => item?.function?.name).filter(name => typeof name === 'string').map(name => name.slice(0, 100));
  }
  return JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(text),
    summary: sanitizeDiagnosticValue(summary), preview: Array.from(text).slice(0, 8000).join('') });
}

function createCallLogStore({ executor = null, now = Date.now, retentionDays = Number(process.env.AI_LOG_RETENTION_DAYS) || 90 } = {}) {
  if (!executor) return { record() {}, list: async () => [], metrics: async () => ({ available: false }) };
  let writes = 0;
  const sweep = () => Promise.resolve().then(() => executor.execute('DELETE FROM ai_call_log WHERE created_at < ?',
    [now() - retentionDays * 86400000])).catch(() => {});
  return {
    // fire-and-forget：审计失败不改变业务结果；诊断保留请求/阶段/SQL错误码，
    // 不带 payload、SQL文本或数据库错误回显。
    record(entry) {
      const stamp = now();
      Promise.resolve().then(() => executor.execute(
        `INSERT INTO ai_call_log (user_id, request_id, conversation_id, lane, phase, provider_host, model,
          thinking_enabled, tool_name, request_payload, response_payload, \`usage\`, duration_ms, status, error_code, http_status, origin, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [entry.userId || '', entry.requestId || null, entry.conversationId || null, entry.lane || 'unknown',
          String(entry.phase || 'provider').slice(0, PHASE_LIMIT), entry.providerHost || null, entry.model || null,
          entry.thinkingEnabled ? 1 : 0, entry.toolName || null,
          capPayload(entry.request), capPayload(entry.response),
          entry.usage ? JSON.stringify(entry.usage) : null,
          Number.isFinite(entry.durationMs) ? entry.durationMs : null,
          entry.status === 'error' ? 'error' : 'ok', entry.errorCode || null,
          Number.isFinite(entry.httpStatus) ? entry.httpStatus : null, entry.origin || null, stamp],
      )).catch(error => reportAiError(Object.assign(new Error('AI 审计写入失败'), {
        code: error?.code || error?.name || 'UNKNOWN', sqlState: error?.sqlState, errno: error?.errno,
      }), { phase: 'audit-write', requestId: entry.requestId || null, conversationId: entry.conversationId || null,
        lane: entry.lane || 'unknown', auditPhase: entry.phase || 'provider',
        providerHost: entry.providerHost || null, ...(entry.traceId ? { traceId: entry.traceId } : {}) }));
      if (++writes % SWEEP_EVERY === 0) sweep();
    },
    async list(userId, limit = 100) {
      const [rows] = await executor.execute(
        `SELECT id, request_id, conversation_id, lane, phase, provider_host, model, thinking_enabled, tool_name,
           request_payload, response_payload, \`usage\`, duration_ms, status, error_code, http_status, origin, created_at
         FROM ai_call_log WHERE user_id = ? ORDER BY id DESC LIMIT ?`, [userId, Math.min(Number(limit) || 100, 200)]);
      return rows.map(row => ({
        id: String(row.id), requestId: row.request_id || null, conversationId: row.conversation_id || null,
        lane: row.lane, phase: row.phase, providerHost: row.provider_host || null, model: row.model || null,
        thinkingEnabled: row.thinking_enabled === 1, toolName: row.tool_name || null,
        request: safeParse(row.request_payload), response: safeParse(row.response_payload),
        usage: row.usage || null, durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        status: row.status, errorCode: row.error_code || null, httpStatus: row.http_status == null ? null : Number(row.http_status),
        origin: row.origin || null, createdAt: Number(row.created_at),
      }));
    },
    async metrics(userId) {
      const dayStart = Math.floor((now() + 28800000) / 86400000) * 86400000 - 28800000;
      const results = await Promise.all([
        executor.execute(`SELECT COUNT(*) AS requests,COALESCE(SUM(provider_calls),0) AS provider_calls,
          COALESCE(SUM(status='failed'),0) AS failed_requests,COALESCE(SUM(status='running'),0) AS running_requests
          FROM ai_request_run WHERE user_id=? AND lane='v3-chat' AND created_at>=? AND created_at<?`, [userId,dayStart,dayStart + 86400000]),
        executor.execute(`SELECT COUNT(*) AS provider_records,COALESCE(SUM(status='error'),0) AS provider_errors,
          COALESCE(SUM(JSON_EXTRACT(\`usage\`,'$.prompt_tokens')),0) AS prompt_tokens,
          COALESCE(SUM(JSON_EXTRACT(\`usage\`,'$.completion_tokens')),0) AS completion_tokens,
          COALESCE(SUM(JSON_EXTRACT(\`usage\`,'$.total_tokens')),0) AS total_tokens,
          AVG(duration_ms) AS average_duration_ms FROM ai_call_log
          WHERE user_id=? AND lane='v3-chat' AND phase='provider' AND created_at>=? AND created_at<?`, [userId,dayStart,dayStart + 86400000]),
      ]);
      const request = results[0][0][0] || {}, provider = results[1][0][0] || {};
      return { available: true, day: new Date(dayStart + 28800000).toISOString().slice(0,10), timezone: 'Asia/Shanghai',
        requests: Number(request.requests || 0), providerCalls: Number(request.provider_calls || 0),
        failedRequests: Number(request.failed_requests || 0), runningRequests: Number(request.running_requests || 0),
        providerRecords: Number(provider.provider_records || 0), providerErrors: Number(provider.provider_errors || 0),
        promptTokens: Number(provider.prompt_tokens || 0), completionTokens: Number(provider.completion_tokens || 0),
        totalTokens: Number(provider.total_tokens || 0), averageProviderMs: provider.average_duration_ms == null ? null : Number(provider.average_duration_ms),
        currencyCost: null, costStatus: 'provider_pricing_not_configured' };
    },
  };
}

function safeParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

module.exports = { createCallLogStore };
