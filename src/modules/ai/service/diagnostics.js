const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const contextStore = new AsyncLocalStorage();
const SENSITIVE_NAMES = /^(?:api_?key|authorization|password|token|access_?token|secret)$/i;

function redactSecretText(value, extraSecrets = []) {
  let text = String(value ?? '');
  const secrets = [...extraSecrets, process.env.AI_API_KEY, process.env.DEEPSEEK_API_KEY,
    process.env.DB_PASSWORD, process.env.AI_DB_PASSWORD, process.env.JWT_SECRET,
    process.env.FIELD_ENCRYPT_KEY, process.env.SHARE_TOKEN_SECRET].filter(item => typeof item === 'string' && item.length >= 4);
  for (const secret of new Set(secrets)) text = text.split(secret).join('[redacted]');
  return text.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[redacted-image]')
    .replace(/Bearer\s+[^\s"'\\,}；，。！？、：]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_.-]{6,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/((?:api[_ -]?key|authorization|password|access[_ -]?token|secret)\s*[=:]\s*)[^\s,;}；，。！？、]+/gi, '$1[redacted]');
}

function sanitizeDiagnosticValue(value, extraSecrets = [], depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactSecretText(value, extraSecrets);
  if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticValue(item, extraSecrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, SENSITIVE_NAMES.test(key) ? '[redacted]' : sanitizeDiagnosticValue(item, extraSecrets, depth + 1)]));
  return value;
}

function withAiDiagnosticContext(context, work) { return contextStore.run(context, work); }

function writeDiagnostic(event, fields, level = 'log') {
  const context = contextStore.getStore() || {};
  const row = sanitizeDiagnosticValue({ at: new Date().toISOString(), event,
    requestId: context.requestId || null, traceId: context.traceId || null,
    conversationId: context.conversationId || null, path: context.path || null,
    ...(context.userId ? { userScope: crypto.createHash('sha256').update(String(context.userId)).digest('hex').slice(0, 12) } : {}), ...fields });
  console[level](`[AI] ${JSON.stringify(row)}`);
  return row;
}

function logProviderReasoning(message, fields = {}, extraSecrets = []) {
  const context = contextStore.getStore() || {};
  for (const field of ['reasoning', 'reasoning_content']) {
    if (typeof message?.[field] !== 'string' || !message[field].trim()) continue;
    const header = sanitizeDiagnosticValue({ at: new Date().toISOString(), event: 'provider.reasoning',
      requestId: fields.requestId || context.requestId || null, traceId: context.traceId || null,
      conversationId: fields.conversationId || context.conversationId || null,
      model: fields.model || null, round: fields.round, stage: fields.stage, field }, extraSecrets);
    // Console only: keep the returned text readable without dumping config or requests.
    try { console.log(`[AI reasoning] ${JSON.stringify(header)}\n\x1b[33m[AI Say] ${redactSecretText(message[field], extraSecrets)}\x1b[0m`); }
    catch (_) { /* Console output must not interrupt the financial workflow. */ }
  }
}

function debugModelContent(value, extraSecrets) {
  let content = '[未返回字符串正文]';
  if (typeof value === 'string') {
    try { content = JSON.stringify(sanitizeDiagnosticValue(JSON.parse(value), extraSecrets), null, 2); }
    catch (_) {
      // Invalid JSON stays readable, including a missing closing brace. Hide
      // quoted credential fields even when parsing cannot reach sanitization.
      content = redactSecretText(value, extraSecrets).replace(
        /("(?:api_?key|authorization|password|token|access_?token|secret)"\s*:\s*)("(?:\\.|[^"\\])*"|[^\s,}\]]+)/gi, '$1"[redacted]"');
    }
  }
  const chars = Array.from(content), truncated = chars.length > 12000;
  return { text: chars.slice(0, 12000).join('') + (truncated ? '\n[正文已截断]' : ''), truncated };
}
function logModelValidationFailure(error, fields = {}, extraSecrets = []) {
  const context = contextStore.getStore() || {};
  const body = debugModelContent(fields.content, extraSecrets), tool = typeof fields.tool === 'string' ? fields.tool : null;
  const header = sanitizeDiagnosticValue({ at: new Date().toISOString(), event: tool ? 'model.tool_validation_failed' : 'model.validation_failed',
    requestId: fields.requestId || context.requestId || null, traceId: context.traceId || null,
    conversationId: fields.conversationId || context.conversationId || null, model: fields.model || null,
    round: fields.round, stage: error?.validationDiagnostic?.stage || fields.stage || 'output-schema',
    ...(tool ? { tool } : {}),
    code: error?.code || 'AI_INVALID_RESULT', message: error?.message || '模型结果校验失败',
    issues: error?.validationDiagnostic?.issues || [], issuesTruncated: error?.validationDiagnostic?.truncated === true,
    responseChars: typeof fields.content === 'string' ? fields.content.length : null, responseTruncated: body.truncated }, extraSecrets);
  // Debug output only. Do not attach the final payload or field details to HTTP,
  // recovery receipts, persisted history or the call-log diagnostic envelope.
  const effective = tool && typeof fields.effectiveContent === 'string' && fields.effectiveContent !== fields.content
    ? `\n[AI Effective Args] ${debugModelContent(fields.effectiveContent, extraSecrets).text}` : '';
  try { console.error(`${tool ? '[AI Tool Check]' : '[AI Check]'} ${JSON.stringify(header)}\n${tool ? '[AI Tool Args]' : '[AI Result]'} ${body.text}${effective}`); }
  catch (_) { /* A broken console must not replace the original validation error. */ }
}
function logToolValidationFailure(error, fields = {}, extraSecrets = []) {
  logModelValidationFailure(error, { ...fields, stage: 'tool-arguments', tool: fields.tool || 'unknown' }, extraSecrets);
}

function safeErrorDetails(error, context = {}) {
  const authorization = error?.config?.headers?.Authorization || error?.config?.headers?.authorization;
  const secrets = [context.apiKey, typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : null];
  const response = error?.response?.data;
  // Only the provider's error fields are retained. Never serialize axios config,
  // request bodies, SQL text, image data or successful provider responses here.
  const providerError = response && !response.on && typeof response === 'object' ? response.error : null;
  const providerMessage = typeof providerError === 'string' ? providerError
    : providerError?.message || (response && typeof response === 'object' && !response.on ? response.message : null);
  const diagnostic = error?.diagnostics || {};
  return sanitizeDiagnosticValue({
    code: error?.code || error?.name || 'UNKNOWN',
    causeCode: error?.causeCode || error?.cause?.code || diagnostic.causeCode ||
      (typeof error?.code === 'string' && !error.code.startsWith('AI_') ? error.code : null),
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
    providerStatus: error?.response?.status || error?.providerStatus || diagnostic.providerStatus || null,
    providerCode: typeof providerError?.code === 'string' || typeof providerError?.code === 'number' ? providerError.code : diagnostic.providerCode || null,
    message: redactSecretText(error?.message || 'AI operation failed', secrets).slice(0, 600),
    providerMessage: providerMessage ? redactSecretText(providerMessage, secrets).slice(0, 600) : diagnostic.providerMessage || null,
    sqlState: error?.sqlState || error?.causeSqlState || null,
    errno: Number.isFinite(error?.errno) ? error.errno : null,
    ...Object.fromEntries(Object.entries(diagnostic).filter(([key]) => !['apiKey', 'message', 'providerMessage'].includes(key))),
    ...Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'apiKey')),
  }, secrets);
}

function reportAiError(error, context = {}) {
  return writeDiagnostic('error', safeErrorDetails(error, context), 'error');
}

function reportGuardDiagnostic(entry) {
  const { userId, ...fields } = entry;
  return writeDiagnostic('guard.error', fields, 'error');
}

function startProviderTrace(config, endpoint, timeoutMs) {
  const started = Date.now();
  let firstByteMs = null, ended = false;
  let providerHost = 'unknown';
  try { providerHost = new URL(config.baseUrl).host; } catch (_) {}
  const fields = () => ({ providerHost, model: config.model || null, endpoint, timeoutMs,
    elapsedMs: Date.now() - started, firstByteMs });
  writeDiagnostic('provider.start', fields());
  const timer = setInterval(() => writeDiagnostic('provider.waiting', fields(), 'warn'), 15000);
  timer.unref?.();
  return {
    firstByte() { if (firstByteMs == null) { firstByteMs = Date.now() - started; writeDiagnostic('provider.first_byte', fields()); } },
    finish(usage = null) {
      if (ended) return;
      ended = true; clearInterval(timer);
      writeDiagnostic('provider.done', { ...fields(), ...(usage ? { usage: {
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } } : {}) });
    },
    fail(error) {
      if (ended) return error.diagnostics || {};
      ended = true; clearInterval(timer);
      const details = safeErrorDetails(error, { ...fields(), apiKey: config.apiKey });
      writeDiagnostic('provider.error', details, 'error');
      return details;
    },
  };
}

module.exports = { redactSecretText, sanitizeDiagnosticValue, withAiDiagnosticContext, reportAiError, reportGuardDiagnostic, startProviderTrace, logProviderReasoning, logModelValidationFailure, logToolValidationFailure };
