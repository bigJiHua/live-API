const { normalizeTransactionAmount, containsSpecialFinancialIntent } = require('./transactionInput');
const { canonical, moneyLiterals, validateAmountEvidence, validateDateEvidence } = require('./v3Evidence');
const { todayShanghai } = require('./validation');

// This is conversation memory, never a draft, candidate or execution source.
// Original user text is carried separately so the normal evidence checks still
// run when a later reply completes an account, category or payment method.
const VERSION = 1, TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SUPPLEMENT_SOURCES = 6, MAX_CARRY_SOURCES = 16;
const MISSING = ['账户', '分类', '支付方式'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const sourceKey = source => uuid(source.turnId) ? source.turnId : JSON.stringify([source.text, source.sourceDate]);
const sameSource = (left, right) => left.text === right.text && left.sourceDate === right.sourceDate &&
  (!uuid(left.turnId) || !uuid(right.turnId) || left.turnId === right.turnId);
const stamp = now => new Date(typeof now === 'function' ? now() : now ?? Date.now()).getTime();

// Readable task state includes expired memory for an explicit user recovery.
// The execution-facing sanitizer below continues to reject that state.
function readPendingTransactionTask(value, { conversationId, now = Date.now() } = {}) {
  try {
    if (!value || value.version !== VERSION || !uuid(value.conversationId) || !uuid(value.turnId) ||
        conversationId && conversationId !== value.conversationId) return null;
    const time = stamp(now);
    if (!Number.isFinite(time) || !Number.isFinite(value.createdAt) || value.createdAt > time) return null;
    if (value.taskId != null && !uuid(value.taskId) || value.revision != null &&
        (!Number.isSafeInteger(value.revision) || value.revision < 1)) return null;
    const identity = { taskId: value.taskId || value.sources?.[value.items?.[0]?.evidence?.sourceTurn]?.turnId || value.turnId,
      revision: value.revision || 1 };
    if (!uuid(identity.taskId)) return null;
    if (value.status === 'cleared') return { version: VERSION, status: 'cleared', conversationId: value.conversationId,
      turnId: value.turnId, createdAt: value.createdAt, ...identity };
    // Stored expiresAt reflects the TTL at write time: a shorter expiry written
    // by an older build must not kill memory the current TTL still keeps alive,
    // so true expiry is recomputed from createdAt. The stored value only bounds
    // the maximum lifetime accepted from storage.
    if (!['awaiting_input', 'expired'].includes(value.status) || !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= value.createdAt || value.expiresAt > value.createdAt + TTL_MS ||
        !Array.isArray(value.sources) || !value.sources.length ||
        value.sources.length > 3 || !Array.isArray(value.items) || !value.items.length || value.items.length > 3 ||
        !value.items.some(item => item?.missingFields?.length)) return null;
    const today = todayShanghai(new Date(time));
    const readSource = source => {
      const sourceDate = typeof source?.sourceDate === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(source.sourceDate)
        ? new Date(`${source.sourceDate}T00:00:00Z`) : null;
      if (!source || typeof source.text !== 'string' || !source.text.trim() || source.text.length > 1500 ||
          !sourceDate || !Number.isFinite(sourceDate.getTime()) || sourceDate.toISOString().slice(0, 10) !== source.sourceDate ||
          source.sourceDate > today || containsSpecialFinancialIntent(source.text) ||
          /[$€£]|\b(?:USD|HKD|EUR|JPY|GBP)\b|美元|港币|欧元|日元|英镑/i.test(source.text)) throw new Error('source');
      if (source.turnId != null && !uuid(source.turnId)) throw new Error('source-turn');
      if (source.order != null && (!Number.isSafeInteger(source.order) || source.order < 0)) throw new Error('source-order');
      return { text: source.text, sourceDate: source.sourceDate,
        ...(source.turnId ? { turnId: source.turnId } : {}), ...(source.order != null ? { order: source.order } : {}) };
    };
    const sources = value.sources.map(readSource);
    if (value.supplementSources != null && (!Array.isArray(value.supplementSources) || value.supplementSources.length > MAX_SUPPLEMENT_SOURCES)) return null;
    const supplementSources = (value.supplementSources || []).map(readSource);
    const allSources = [...sources, ...supplementSources];
    if (new Set(allSources.map(sourceKey)).size !== allSources.length) return null;
    const texts = sources.map(source => source.text), dates = sources.map(source => source.sourceDate);
    const claims = new Set();
    const items = value.items.map(item => {
      const raw = item?.fields, evidence = item?.evidence;
      if (!raw || ![0, 1].includes(raw.direction) || raw.currency !== 'CNY' ||
          !normalizeTransactionAmount(raw.amount) || typeof raw.remark !== 'string' || raw.remark.length > 255 ||
          containsSpecialFinancialIntent(raw.remark) || !Array.isArray(item.missingFields) ||
          item.missingFields.some(field => !MISSING.includes(field)) || !Number.isInteger(evidence?.sourceTurn) ||
          !sources[evidence.sourceTurn] || typeof evidence.quote !== 'string' || !evidence.quote.trim()) throw new Error('item');
      validateAmountEvidence({ evidence }, raw.amount, texts);
      const claim = JSON.stringify([evidence.sourceTurn, evidence.quote, normalizeTransactionAmount(raw.amount)]);
      if (claims.has(claim)) throw new Error('duplicate');
      claims.add(claim);
      const dateTurn = evidence.dateSourceTurn ?? evidence.sourceTurn;
      const dateText = evidence.dateQuote ?? texts[dateTurn];
      if (!Number.isInteger(dateTurn) || !sources[dateTurn] || typeof dateText !== 'string' ||
          !texts[dateTurn].includes(dateText)) throw new Error('date-source');
      validateDateEvidence(raw.transDate, dateText, dates[dateTurn], today);
      const fields = { amount: raw.amount, direction: raw.direction, currency: 'CNY', transDate: raw.transDate,
        remark: raw.remark, payMethod: ['银行卡', '现金', '余额', '微信', '支付宝'].includes(raw.payMethod) ? raw.payMethod : null };
      return { fields, evidence: { sourceTurn: evidence.sourceTurn, quote: evidence.quote,
        ...(evidence.dateSourceTurn != null ? { dateSourceTurn: dateTurn, dateQuote: dateText } : {}) },
      missingFields: [...new Set(item.missingFields)] };
    });
    return { version: VERSION, status: value.status === 'expired' || time >= value.createdAt + TTL_MS ? 'expired' : 'awaiting_input',
      conversationId: value.conversationId, turnId: value.turnId, ...identity,
      createdAt: value.createdAt, expiresAt: value.createdAt + TTL_MS, sources, items,
      ...(supplementSources.length ? { supplementSources } : {}) };
  } catch (_) { return null; }
}

function sanitizePendingTransactionContext(value, options) {
  const task = readPendingTransactionTask(value, options);
  return task?.status === 'expired' ? null : task;
}

function summarizePendingTransactionTask(value, options) {
  const task = readPendingTransactionTask(value, options);
  if (!task || task.status === 'cleared') return null;
  return { taskId: task.taskId, revision: task.revision, status: task.status, expiresAt: task.expiresAt,
    items: task.items.map((item, index) => ({ index, fields: { ...item.fields }, missingFields: [...item.missingFields] })) };
}

function buildPendingTransactionContext({ transactions = [], userTurns = [], userTurnDates = [], userTurnIds = [], previous, conversationId, turnId,
  now = Date.now() } = {}) {
  if (!transactions.length) return null;
  const sourceTurns = [...new Set(transactions.flatMap(item => [item.evidence?.sourceTurn,
    ...(item.evidence?.dateSourceTurn != null ? [item.evidence.dateSourceTurn] : [])]))].sort((a, b) => a - b);
  const prior = sanitizePendingTransactionContext(previous, { conversationId, now });
  const priorSources = prior?.status === 'awaiting_input' ? [...prior.sources, ...(prior.supplementSources || [])] : [];
  const sourceRows = sourceTurns.map(index => ({ text: userTurns[index], sourceDate: userTurnDates[index],
    ...(uuid(userTurnIds[index]) ? { turnId: userTurnIds[index] } : {}) }));
  const continuesPrior = prior?.status === 'awaiting_input' && transactions.every(item => {
    const source = sourceRows[sourceTurns.indexOf(item.evidence?.sourceTurn)];
    return source && prior.sources.some(row => sameSource(row, source));
  });
  let nextOrder = continuesPrior ? Math.max(-1, ...priorSources.map((source, index) => source.order ?? index)) + 1 : 0;
  const sources = sourceRows.map(source => {
    const matchIndex = continuesPrior ? priorSources.findIndex(row => sameSource(row, source)) : -1;
    return { ...source, order: matchIndex >= 0 ? priorSources[matchIndex].order ?? matchIndex : nextOrder++ };
  });
  const createdAt = continuesPrior ? prior.createdAt : stamp(now);
  const value = { version: VERSION, status: 'awaiting_input', conversationId, turnId, createdAt,
    taskId: continuesPrior ? prior.taskId : turnId,
    revision: continuesPrior ? prior.revision : 1,
    expiresAt: continuesPrior ? prior.expiresAt : createdAt + TTL_MS, sources,
    ...(continuesPrior ? { supplementSources: (prior.supplementSources || []).filter(source => !sources.some(row => sameSource(row, source))) } : {}),
    items: transactions.map(item => ({ fields: { ...item.fields, remark: item.fields?.remark ?? '' },
      missingFields: item.missingFields, evidence: { ...item.evidence,
        sourceTurn: sourceTurns.indexOf(item.evidence?.sourceTurn),
        ...(item.evidence?.dateSourceTurn != null ? { dateSourceTurn: sourceTurns.indexOf(item.evidence.dateSourceTurn) } : {}) } })) };
  const next = sanitizePendingTransactionContext(value, { conversationId, now });
  if (next && continuesPrior && JSON.stringify([next.sources, next.items, next.supplementSources || []]) !==
      JSON.stringify([prior.sources, prior.items, prior.supplementSources || []])) next.revision++;
  return next;
}

function pinPendingTransactionSupplement(context, { message, sourceDate, turnId, conversationId, now = Date.now() } = {}) {
  const pending = sanitizePendingTransactionContext(context, { conversationId, now });
  if (!pending || pending.status !== 'awaiting_input') return pending;
  if (!uuid(turnId)) return pending;
  if (isPendingTransactionCancellation(message)) return clearPendingTransactionContext({ conversationId, turnId, previous: pending, now });
  const source = { text: message, sourceDate, turnId };
  const known = [...pending.sources, ...(pending.supplementSources || [])];
  if (known.some(row => sameSource(row, source))) return pending;
  source.order = Math.max(-1, ...known.map((row, index) => row.order ?? index)) + 1;
  const supplementSources = [...(pending.supplementSources || []), source].slice(-MAX_SUPPLEMENT_SOURCES);
  return sanitizePendingTransactionContext({ ...pending, supplementSources, revision: pending.revision + 1 }, { conversationId, now }) || pending;
}

function clearPendingTransactionContext({ conversationId, turnId, taskId, revision, previous, now = Date.now() } = {}) {
  const prior = readPendingTransactionTask(previous, { conversationId, now });
  return sanitizePendingTransactionContext({ version: VERSION, status: 'cleared', conversationId, turnId,
    taskId: taskId || prior?.taskId || turnId, revision: (revision || prior?.revision || 0) + 1,
    createdAt: stamp(now) }, { conversationId, now });
}

function carryPendingTransactionSources({ userTurns = [], userTurnDates = [], userTurnIds = [], chronologicalSources, context, conversationId,
  now = Date.now() } = {}) {
  const pending = sanitizePendingTransactionContext(context, { conversationId, now });
  const original = userTurns.map((text, index) => ({ text, sourceDate: userTurnDates[index] ?? null,
    ...(uuid(userTurnIds[index]) ? { turnId: userTurnIds[index] } : {}) }));
  if (!pending || pending.status !== 'awaiting_input' || !original.length)
    return { userTurns: [...userTurns], userTurnDates: [...userTurnDates],
      userTurnIds: original.map(source => source.turnId || null), pendingTransactions: null };
  // Only sources outside the recent chronological window are prepended. A
  // source already in history must stay there: moving it ahead of older account
  // prose would make that prose appear to be a later payment clarification.
  const necessary = [...pending.sources, ...(pending.supplementSources || [])]
    .map((source, index) => ({ ...source, order: source.order ?? index })).sort((left, right) => left.order - right.order);
  const missingSources = necessary.filter(source => !original.some(row => sameSource(row, source)));
  let merged = [...missingSources, ...original];
  if (Array.isArray(chronologicalSources) && chronologicalSources.length) {
    // Token selection can omit a middle turn. Full loaded chronology places a
    // pinned correction after its original amount even when the correction was
    // omitted from prose. Only truly older, unloaded sources are prepended.
    const chronology = chronologicalSources.filter(source => source && typeof source.text === 'string');
    const outside = necessary.filter(source => !chronology.some(row => sameSource(row, source)));
    const ordered = chronology.map(source => original.find(row => sameSource(row, source))
      || necessary.find(row => sameSource(row, source))).filter(Boolean);
    const unknown = original.filter(source => !chronology.some(row => sameSource(row, source)));
    merged = [...outside, ...ordered, ...unknown];
  }
  const required = new Set([merged.length - 1]);
  for (const source of necessary) {
    const index = merged.findIndex(row => sameSource(row, source));
    if (index >= 0) {
      required.add(index);
      if (source.turnId && !merged[index].turnId) merged[index] = { ...merged[index], turnId: source.turnId };
    }
  }
  // The public protocol permits sourceTurn 0..15. Keep the pending sources and
  // current turn, then the latest unrelated history that fits that limit.
  for (let index = merged.length - 2; index >= 0 && required.size < MAX_CARRY_SOURCES; index--) required.add(index);
  const carried = merged.filter((_, index) => required.has(index));
  const sourceIndex = index => carried.findIndex(source => sameSource(source, pending.sources[index]));
  return { userTurns: carried.map(source => source.text), userTurnDates: carried.map(source => source.sourceDate),
    userTurnIds: carried.map(source => source.turnId || null),
    pendingTransactions: { status: 'awaiting_input', transactionCount: pending.items.length,
      items: pending.items.map(item => ({ ...item.fields, missingFields: [...item.missingFields],
        evidence: { ...item.evidence, sourceTurn: sourceIndex(item.evidence.sourceTurn),
          ...(item.evidence.dateSourceTurn != null ? { dateSourceTurn: sourceIndex(item.evidence.dateSourceTurn) } : {}) } })) } };
}

// Call only after the current utterance has explicitly continued this pending
// batch. Counts refer to the batch's original transactions, not provider output.
function pendingBatchCoverage(pendingTransactions, transactions = []) {
  const expected = pendingTransactions?.status === 'awaiting_input' && Array.isArray(pendingTransactions.items)
    ? pendingTransactions.items : [];
  const provided = Array.isArray(transactions) ? transactions : [];
  const covered = new Set();
  let duplicateCount = 0, unexpectedCount = 0;
  for (const transaction of provided) {
    const fields = transaction?.fields || transaction, evidence = transaction?.evidence;
    const amount = normalizeTransactionAmount(fields?.amount);
    const amountClaims = expected.flatMap((item, index) => {
      const original = item.fields || item;
      return amount && amount === normalizeTransactionAmount(original.amount) &&
        fields.direction === original.direction && fields.currency === original.currency &&
        evidence?.sourceTurn === item.evidence?.sourceTurn
        ? [index] : [];
    });
    // Service amount validation still requires each quote to be a verbatim
    // substring of its trusted user source. Recovery may pin the whole source,
    // while a later reply quotes only the transaction fragment. A unique amount
    // in this source identifies the same member without requiring equal quote
    // widths. Equal-amount members must additionally identify one original
    // fragment; a broad or bare-amount quote cannot merge those members.
    const matches = amountClaims.filter(index => {
      const originalQuote = expected[index].evidence?.quote;
      if (typeof evidence?.quote !== 'string' || typeof originalQuote !== 'string' ||
          !moneyLiterals(evidence.quote).has(canonical(amount)) || !moneyLiterals(originalQuote).has(canonical(amount))) return false;
      return amountClaims.length === 1 || evidence.quote.includes(originalQuote) || originalQuote.includes(evidence.quote);
    });
    if (matches.length !== 1) { unexpectedCount++; continue; }
    if (covered.has(matches[0])) duplicateCount++;
    else covered.add(matches[0]);
  }
  const result = { expectedCount: expected.length, providedCount: provided.length, matchedCount: covered.size,
    missingCount: expected.length - covered.size, duplicateCount, unexpectedCount };
  return { ...result, complete: expected.length > 0 && result.missingCount === 0 && duplicateCount === 0 &&
    unexpectedCount === 0 && provided.length === expected.length };
}

function isPendingTransactionCancellation(message) {
  if (typeof message !== 'string') return false;
  const text = message.trim().replace(/[，,。.!！?？\s]+$/g, '');
  if (/^(?:算了|不用了|取消|撤销|先?不记了?|不用记了?|不要记了?|别记了?)$/.test(text)) return true;
  return text.split(/[，,。.!！?？；;\n]/).some(clause => {
    if (/(?:不要|不用|别|不|无需)\s*(?:取消|撤销)/.test(clause)) return false;
    if (!/取消|撤销|不记|不要记|不用记|别记|停止记/.test(clause)) return false;
    if (!/记账|记一笔|这笔|这些|那笔|几笔|交易|消费|收入|支出|账目|流水|草稿/.test(clause)) return false;
    return !/提醒|待办|日程|生日|纪念日/.test(clause) || /记账|交易|消费|收入|支出|账目|流水/.test(clause);
  });
}

function accountTail(row) {
  const explicit = [row?.tail, row?.last4, row?.last4_no, row?.cardTail, row?.last4No]
    .find(value => typeof value === 'string' && /^\d{4}$/.test(value));
  if (explicit) return explicit;
  const name = typeof row?.name === 'string' ? row.name.normalize('NFKC') : '';
  return /(?:\s|银行\s*)(\d{4})(?:\(\d+\))?$/.exec(name)?.[1] || null;
}

function isExplicitSelectedAccount(selected, candidates = [], sourceUtterances = [], { allowBareTail = false } = {}) {
  if (!selected?.id || !candidates.some(row => row.id === selected.id)) return false;
  const name = selected.name?.normalize('NFKC');
  const texts = sourceUtterances.filter(text => typeof text === 'string').map(text => text.normalize('NFKC'));
  // Preserve a unique full label while excluding a shorter label that is only
  // a substring of another named card (e.g. 同名卡 / 同名卡(2)).
  if (name && candidates.filter(row => row.name?.normalize('NFKC') === name).length === 1 &&
      texts.some(text => text.includes(name) && !/(?:不要|不用|不(?:是|选|用)|别用|不是用)\s*$/.test(text.slice(0, text.indexOf(name))) &&
        !candidates.some(row => row.id !== selected.id && row.name?.normalize('NFKC').includes(name) &&
          row.name.length > selected.name.length && text.includes(row.name.normalize('NFKC'))))) return true;
  const tail = accountTail(selected);
  if (!tail || candidates.filter(row => accountTail(row) === tail).length !== 1) return false;
  return texts.some(text => {
    if (/不要|不用|取消|不(?:是|选|用)|别用/.test(text)) return false;
    // A bare number is only an account reply when the server already has a
    // pending transaction question. Monetary prose never grants that meaning.
    const bare = new RegExp(`^\\s*(?:用|使用|选|选择|就是|是)?\\s*${tail}\\s*(?:那张|这张|的卡|卡|银行卡|借记卡|信用卡)?\\s*(?:付的|付款|支付)?[\\s，,。.!！]*$`);
    if (allowBareTail && bare.test(text)) return true;
    const labelled = new RegExp(`(?:尾号|卡尾号|末四位|后四位|银行卡|借记卡|信用卡|卡)\\s*(?:是|为|[:：])?\\s*${tail}(?!\\d|\\s*(?:元|块|年|月|日))`);
    if (labelled.test(text)) return true;
    const bank = name?.replace(/\s*\d{4}(?:\(\d+\))?$/, '').replace(/\s/g, '');
    return !!bank && bank.includes('银行') && text.replace(/\s/g, '').includes(`${bank}${tail}`) &&
      !new RegExp(`${tail}\\s*(?:元|块|年|月|日)`).test(text);
  });
}

module.exports = { buildPendingTransactionContext, sanitizePendingTransactionContext, readPendingTransactionTask,
  summarizePendingTransactionTask, clearPendingTransactionContext,
  pinPendingTransactionSupplement, carryPendingTransactionSources, pendingBatchCoverage,
  isPendingTransactionCancellation, isExplicitSelectedAccount, TTL_MS, MAX_SUPPLEMENT_SOURCES, MAX_CARRY_SOURCES };
