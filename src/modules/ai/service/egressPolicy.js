const crypto = require('crypto');
const { AiError } = require('./errors');
const { redactSecretText } = require('./diagnostics');

const ID_KINDS = Object.freeze({ accountId: 'card', account_id: 'card', cardId: 'card', card_id: 'card',
  categoryId: 'category', category_id: 'category', fundId: 'fund', fund_id: 'fund', draftId: 'draft', draft_id: 'draft',
  conversationId: 'conversation', conversation_id: 'conversation', committedRecordId: 'transaction', recordId: 'transaction' });
const BLOCKED_FIELDS = /^(?:user_?id|password|api_?key|authorization|aes_?key|token|secret|full_?card_?no|card_?no|card_?bin|last4_no|fund_account|trade_account|image|dataUrl|imageHash)$/i;
// A 1-4 digit card tail is a server-built display token, not a full card
// number: the shared name rule uses it as "<bank name> <last4>". The raw
// last4_no column stays blocked above; only a vetted `tail` field may leave.
const CARD_TAIL_FIELDS = /^(?:tail|cardTail)$/i;
const VALID_CARD_TAIL = /^[0-9]{1,4}$/;
const MONEY_FIELDS = /^(?:amount|amountCNY|income|expense|balance|invest|market_val|marketValue|profit|net_value|creditLimit|credit_limit|tempLimit|temp_limit|needRepay|repaid|billAmount|exchange_rate)$/;

// A per-turn mapper: no cache, database dependency, HTTP request, retry or provider call.
// Legacy field names are retained, while their values become random opaque references.
function createEgressPolicy({ userId, knownIds = [], extraSecrets = [] } = {}) {
  const references = new Map();
  const byId = new Map();
  const hidden = new Set([userId, ...knownIds].filter(value => typeof value === 'string' && value.length >= 4));
  function reference(kind, id) {
    if (id == null) return null;
    if (typeof id !== 'string' || !id || id.length > 64) throw new AiError('候选标识无效', 502, 'AI_EGRESS_INVALID');
    if (/^r_[0-9a-f]{32}$/.test(id) && references.get(id)?.kind === kind) return id;
    hidden.add(id);
    const key = `${kind}\0${id}`;
    if (!byId.has(key)) {
      const ref = `r_${crypto.randomBytes(16).toString('hex')}`;
      byId.set(key, ref); references.set(ref, { kind, id });
    }
    return byId.get(key);
  }
  function scrubText(value, allowedRefs = []) {
    // Free conversation keeps public text and layout; the caller owns its length limit.
    // Preview allowances stay local to this call and never create resolvable references.
    const permittedRefs = new Set(Array.isArray(allowedRefs) ? allowedRefs.filter(ref => typeof ref === 'string' && /^r_[0-9a-f]{32}$/.test(ref)) : []);
    let text = redactSecretText(String(value), extraSecrets);
    for (const id of [...hidden].sort((a, b) => b.length - a.length)) text = text.split(id).join('[内部标识]');
    return text.replace(/r_[0-9a-f]{32}/gi, ref => references.has(ref) || permittedRefs.has(ref) ? ref : '[历史标识]');
  }
  function scrub(value, allowedRefs = []) {
    // Only a caller-owned per-turn preview map may supply additional opaque references.
    // This allowance is temporary and never registers IDs or bypasses credential redaction.
    const permittedRefs = new Set(Array.isArray(allowedRefs) ? allowedRefs.filter(ref => typeof ref === 'string' && /^r_[0-9a-f]{32}$/.test(ref)) : []);
    let text = redactSecretText(String(value), extraSecrets);
    for (const id of [...hidden].sort((a, b) => b.length - a.length)) text = text.split(id).join('[内部标识]');
    // Redact full credentials/identities before the legacy display budget can
    // split one across its boundary and leave a recognizable prefix.
    text = text.slice(0, 12000);
    const kept = [];
    const protect = value => { kept.push(value); return `@@KEPT_${kept.length - 1}@@`; };
    text = text.replace(/r_[0-9a-f]{32}/gi, ref => references.has(ref) || permittedRefs.has(ref) ? protect(ref) : '[历史标识]');
    text = text.replace(/[¥￥]\s*-?\d+(?:\.\d{1,4})?|-?\d+(?:\.\d{1,4})?\s*元/g, protect);
    // Server-authored summaries use "<currency code> <amount>"; protect it
    // before the 8+ digit phone-number rule can split the integer part.
    text = text.replace(/\b(?:CNY|USD|HKD|EUR|JPY|GBP|AUD|CAD)\s*-?\d+(?:\.\d{1,4})?/g, protect);
    text = text.replace(/"(?:amount|amountCNY|income|expense|balance|invest|market_val|marketValue|profit|net_value|creditLimit|credit_limit|tempLimit|temp_limit|needRepay|repaid|billAmount|exchange_rate)"\s*:\s*(?:"-?\d+(?:\.\d{1,4})?"|-?\d+(?:\.\d{1,4})?)/g, protect);
    return text.replace(/https?:\/\/[^\s<>]+/gi, '[链接已隐藏]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[历史标识]')
      .replace(/(?:\d{4}[ -]){2,4}\d{2,4}/g, '[号码已隐藏]')
      .replace(/\d{8,}/g, '[号码已隐藏]')
      .replace(/@@KEPT_(\d+)@@/g, (_, index) => kept[Number(index)]);
  }
  function project(value, kind = 'entity', depth = 0, field = '') {
    if (depth > 12) throw new AiError('外发数据层级超出限制', 502, 'AI_EGRESS_INVALID');
    if (value == null) return null;
    if (typeof value === 'string') return MONEY_FIELDS.test(field) && /^-?\d+(?:\.\d{1,4})?$/.test(value) ? value : scrub(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      if (value.length > 100) throw new AiError('外发数据条数超出限制', 502, 'AI_EGRESS_INVALID');
      return value.map(item => project(item, kind, depth + 1));
    }
    if (typeof value !== 'object') throw new AiError('外发数据格式无效', 502, 'AI_EGRESS_INVALID');
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || BLOCKED_FIELDS.test(key)) continue;
      if (CARD_TAIL_FIELDS.test(key)) { if (typeof item === 'string' && VALID_CARD_TAIL.test(item)) safe[key] = item; continue; }
      if (key === 'id') safe.id = reference(kind, item);
      else if (Object.hasOwn(ID_KINDS, key)) safe[key] = reference(ID_KINDS[key], item);
      else if (/^(?:.*_id|.*Id)$/.test(key) && item != null) safe[key] = reference(key, item);
      else safe[key] = project(item, key === 'accounts' || key === 'cards' ? 'card' : key === 'categories' ? 'category'
        : key === 'funds' ? 'fund' : key === 'draft' ? 'draft' : kind, depth + 1, key);
    }
    return safe;
  }
  function messages(history) {
    // Protocol tool-call IDs originate at the provider and must stay paired with tool responses.
    // Only message content and function arguments carry application/user data.
    return history.map(message => ({ role: message.role, content: message.content == null ? null : scrub(message.content),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.reasoning_content ? { reasoning_content: scrub(message.reasoning_content) } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ id: call.id, type: call.type,
        function: { name: call.function.name, arguments: scrub(call.function.arguments) } })) } : {}) }));
  }
  function resolve(ref, kind) {
    if (ref == null) return null;
    const entry = typeof ref === 'string' && /^r_[0-9a-f]{32}$/.test(ref) && references.get(ref);
    if (!entry || entry.kind !== kind) throw new AiError('模型须选择本轮返回的候选标识', 400, 'AI_REF_INVALID');
    return entry.id;
  }
  function decodeArguments(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const decoded = { ...args };
    if (name === 'propose_transaction' || name === 'query_transactions') {
      if (Object.hasOwn(decoded, 'categoryId')) decoded.categoryId = resolve(decoded.categoryId, 'category');
    }
    if (name === 'propose_transaction' && Object.hasOwn(decoded, 'accountId')) decoded.accountId = resolve(decoded.accountId, 'card');
    return decoded;
  }
  return { project, messages, scrub, scrubText, decodeArguments };
}

module.exports = { createEgressPolicy };
