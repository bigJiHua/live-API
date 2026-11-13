const { redactSecretText } = require('./diagnostics');

// 供应商真实错误摘要：只保留 HTTP 状态、供应商错误码和截断脱敏后的一句原话。
// 永不携带请求体、Authorization、用户数据或完整响应。
const CODE_LIMIT = 80, MESSAGE_LIMIT = 240;

function clean(value, limit) {
  if (typeof value !== 'string') return null;
  const text = redactSecretText(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function sanitizeProviderDetail(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = {};
  if (Number.isFinite(value.status)) detail.status = value.status;
  const code = clean(typeof value.code === 'number' ? String(value.code) : value.code, CODE_LIMIT);
  if (code) detail.code = code;
  const message = clean(value.message, MESSAGE_LIMIT);
  if (message) detail.message = message;
  const cause = clean(value.cause, CODE_LIMIT);
  if (cause) detail.cause = cause;
  return Object.keys(detail).length ? detail : null;
}

function providerDetailFromDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const hasStatus = Number.isFinite(diagnostics.providerStatus);
  return sanitizeProviderDetail({
    status: hasStatus ? diagnostics.providerStatus : null,
    code: diagnostics.providerCode,
    message: diagnostics.providerMessage,
    // HTTP 200 does not mean its response stream completed. Retain the cause
    // even when headers arrived, so framing/size/connection failures stay distinct.
    cause: diagnostics.causeCode,
  });
}

module.exports = { sanitizeProviderDetail, providerDetailFromDiagnostics };
