const crypto = require('crypto');
const { AiError } = require('./errors');
const { encryptField, decryptField, isEncrypted } = require('../../../common/utils/fieldCrypto');
const { validateScope, DOMAINS, ROW_LIMIT } = require('./businessRead');
const { CHOICE_DOMAINS } = require('./datasetCapabilities');
const { normalizeTransactionAmount, PARSER_VERSION } = require('./transactionInput');
const { validateQueryMeta } = require('./queryMetadata');

const TTL = 15 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const REF_KINDS = Object.freeze({ cards: 'card', categories: 'category', funds: 'fund', todos: 'todo', fixedAssets: 'fixedAsset' });
const ID_FIELDS = Object.freeze({ cardId: 'card', card_id: 'card', categoryId: 'category', category_id: 'category',
  fundId: 'fund', fund_id: 'fund', jobId: 'job', job_id: 'job', poolId: 'pool', pool_id: 'pool' });
const DATASET_KINDS = Object.freeze({ 'finance-transactions': 'transaction', 'card-cards': 'card', 'card-bills': 'bill',
  'card-repayments': 'repayment', 'card-pools': 'pool', 'budget-plans': 'budget', 'todo-events': 'todo',
  'work-salary': 'salary', 'work-rules': 'job', 'asset-snapshots': 'assetSnapshot', 'asset-registers': 'assetRegister',
  'fixedAsset-saved': 'fixedAsset', 'fund-holdings': 'fund', 'fund-history': 'fundHistory', 'installment-plans': 'installment' });
const FIELD_ALLOWLIST = Object.freeze({
  finance: ['month', 'income', 'expense', 'count', 'incomeCount', 'expenseCount', 'unpricedCount', 'direction', 'category', 'amountCNY', 'date', 'amount', 'currency', 'remark', 'firstDate', 'lastDate',
    'net', 'surplus', 'deficit', 'sharePct', 'expenseSharePct', 'incomeSharePct', 'difference', 'changeAmt', 'changePct'],
  account: ['name', 'type', 'balance', 'currency', 'updatedAt', 'net', 'surplus', 'deficit', 'sharePct', 'expenseSharePct', 'incomeSharePct', 'difference', 'changeAmt', 'changePct'],
  card: ['name', 'type', 'cardType', 'bankName', 'tail', 'creditLimit', 'tempLimit', 'billDay', 'repayDay', 'expirationMonth', 'nextRepayDate', 'status', 'month', 'billAmount', 'needRepay', 'repaid', 'repayStatus', 'updatedAt', 'amount', 'date', 'method', 'currency', 'amountCNY', 'count', 'unpricedCount', 'sourceCurrencies',
    'net', 'surplus', 'deficit', 'sharePct', 'expenseSharePct', 'incomeSharePct', 'difference', 'changeAmt', 'changePct'],
  budget: ['title', 'type', 'planned', 'registeredUsed', 'remaining', 'cycle', 'date', 'executed', 'count'],
  todo: ['content', 'type', 'date', 'originalDate', 'status', 'priority', 'isRecurring', 'remark', 'count'],
  work: ['date', 'company', 'type', 'hours', 'daySalary', 'subsidy', 'deductions', 'income', 'status', 'baseSalary', 'workDays', 'hourlyWage', 'dailyEstimate', 'count'],
  asset: ['date', 'totalAsset', 'creditDebt', 'netAsset', 'recordedAt', 'type', 'currency', 'positiveAssets', 'creditOverflow', 'otherDebt', 'count', 'missingSnapshots', 'minUpdatedAt', 'maxUpdatedAt', 'manualNetAsset', 'systemNetAsset', 'netDifference', 'reason'],
  fixedAsset: ['name', 'tag', 'buyPrice', 'savedValue', 'secondhandPrice', 'monthlyDepreciation', 'totalDepreciation', 'lastDepreciationDate', 'status', 'isDeleted'],
  fund: ['name', 'principal', 'profit', 'marketValue', 'lastReportDate', 'date', 'capitalDelta', 'count'],
  installment: ['name', 'amount', 'periods', 'active', 'nextDate', 'pending', 'entered', 'void', 'entering', 'unknown'],
});
const SUMMARY_FIELDS = ['income', 'expense', 'count', 'totalCount', 'incomeCount', 'expenseCount', 'unpricedCount', 'currency', 'startDate', 'endDate', 'incomplete',
  'net', 'surplus', 'deficit', 'sharePct', 'expenseSharePct', 'incomeSharePct', 'difference', 'changeAmt', 'changePct',
  'ratio', 'approximateRatio', 'ratioNumeratorType', 'ratioDenominatorType',
  'daySalary', 'subsidy', 'deductions', 'hours', 'profit', 'capitalDelta', 'planned', 'registeredUsed', 'remaining', 'amount'];
const columnTypes = ['text', 'date', 'money', 'decimal', 'number'];
const jsonClone = value => JSON.parse(JSON.stringify(value));
const invalid = () => new AiError('分析预览数据格式无效，请重新选择范围', 400, 'AI_PREVIEW_INVALID');
const computeDigest = data => crypto.createHash('sha256').update(JSON.stringify({ message: data.message,
  providerMessage: data.providerMessage, scope: data.scope, snapshot: data.snapshot, refMap: data.refMap,
  localFinancialInput: data.localFinancialInput, localFinancialInputs: data.localFinancialInputs,
  connectionId: data.connectionId, provider: data.provider, conversationId: data.conversationId })).digest('hex');

function createPreviewStore({ executor, now = () => Date.now() } = {}) {
  // Infrastructure storage is limited to this dedicated AI table, never financial source tables.
  const db = executor || require('../../../common/config/db');
  const timestamp = () => new Date(now()).getTime();

  function safeSnapshot(userId, snapshot, scope, message, context, localFinancialInput, localFinancialInputs) {
    if (!snapshot || !Array.isArray(snapshot.datasets) || snapshot.datasets.length > 40
      || !snapshot.choices || typeof snapshot.choices !== 'object') throw invalid();
    let originalBytes;
    try { originalBytes = Buffer.byteLength(JSON.stringify(snapshot)); } catch (_) { throw invalid(); }
    if (originalBytes > MAX_BYTES) throw new AiError('数据预览超过64KiB，请缩小日期或业务范围', 400, 'AI_PREVIEW_TOO_LARGE');
    const refMap = Object.create(null);
    const byId = new Map();
    const mapRef = (kind, id) => {
      if (id == null || id === '') return null;
      if (typeof id !== 'string' || id.length > 64) throw invalid();
      const key = `${kind}\0${id}`;
      if (!byId.has(key)) {
        const ref = `r_${crypto.randomBytes(16).toString('hex')}`;
        byId.set(key, ref);
        refMap[ref] = { kind, id };
      }
      return byId.get(key);
    };
    const datasetIds = new Set();
    for (const dataset of snapshot.datasets) {
      if (!dataset || !scope.domains.includes(dataset.domain) || !DOMAINS.includes(dataset.domain)
        || typeof dataset.datasetId !== 'string' || !dataset.datasetId.startsWith(`${dataset.domain}-`)
        || dataset.datasetId.length > 64 || datasetIds.has(dataset.queryMeta?.queryId || dataset.datasetId) || !Array.isArray(dataset.rows)
        || dataset.rows.length > ROW_LIMIT || !Array.isArray(dataset.columns) || !dataset.columns.length || dataset.columns.length > 20) throw invalid();
      datasetIds.add(dataset.queryMeta?.queryId || dataset.datasetId);
      if (dataset.queryMeta) validateQueryMeta(dataset.queryMeta, dataset, scope);
      const keys = new Set();
      for (const col of dataset.columns) {
        if (!col || !FIELD_ALLOWLIST[dataset.domain].includes(col.key) || keys.has(col.key)
          || !columnTypes.includes(col.type) || typeof col.label !== 'string' || col.label.length > 80) throw invalid();
        keys.add(col.key);
      }
      for (const row of dataset.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid();
        if (row.id != null) {
          if (!DATASET_KINDS[dataset.datasetId]) throw invalid();
          mapRef(DATASET_KINDS[dataset.datasetId], row.id);
        }
        for (const [key, kind] of Object.entries(ID_FIELDS)) if (Object.hasOwn(row, key)) mapRef(kind, row[key]);
      }
    }
    for (const [key, kind] of Object.entries(REF_KINDS)) {
      const rows = snapshot.choices[key] || [];
      if (!Array.isArray(rows) || rows.length > ROW_LIMIT) throw invalid();
      if (rows.length && !scope.domains.some(domain => CHOICE_DOMAINS[key].includes(domain))) throw invalid();
      for (const row of rows) { if (!row || !row.id) throw invalid(); mapRef(kind, row.id); }
    }
    let normalizedTransaction;
    // 追加165：多笔（≤3）逐笔校验，规则与单笔完全一致；同一账户跨笔映射到同一 ref
    const validateOneInput = input => {
      if (!scope.domains.includes('finance') || !input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['amount', 'direction', 'currency', 'transDate', 'accountId', 'categoryId', 'payMethod', 'remark'].includes(key))) throw invalid();
      const amount = normalizeTransactionAmount(input.amount);
      const date = typeof input.transDate === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(input.transDate)
        ? new Date(`${input.transDate}T00:00:00Z`) : null;
      if (!amount || ![0, 1].includes(input.direction) || input.currency !== 'CNY' || !date
        || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.transDate
        || !(snapshot.choices.cards || []).some(row => row.id === input.accountId)) throw invalid();
      return { amount, direction: input.direction, currency: 'CNY', transDate: input.transDate,
        accountRef: mapRef('card', input.accountId), parserVersion: PARSER_VERSION };
    };
    if (localFinancialInput != null) {
      const input = localFinancialInput.fields;
      if (!localFinancialInput || Object.keys(localFinancialInput).some(key => !['fields', 'evidence'].includes(key))) throw invalid();
      normalizedTransaction = validateOneInput(input);
    }
    let normalizedTransactions;
    if (localFinancialInputs != null) {
      if (!Array.isArray(localFinancialInputs) || localFinancialInputs.length < 2 || localFinancialInputs.length > 3
        || localFinancialInputs.some(item => !item || Object.keys(item).some(key => !['fields', 'evidence', 'financialCheck'].includes(key)))) throw invalid();
      normalizedTransactions = localFinancialInputs.map(item => validateOneInput(item.fields));
    }
    // Free text is data, not instructions. The orchestration prompt handles that distinction.
    // Remove URLs, contact/card numbers and exact internal IDs from all external text.
    const replacements = [...new Set([userId, ...Object.values(refMap).map(entry => entry.id)])].filter(id => id && id.length >= 4)
      .sort((a, b) => b.length - a.length);
    const scrub = value => {
      if (value == null) return null;
      if (typeof value !== 'string') throw invalid();
      let result = value.slice(0, 1500);
      for (const id of replacements) result = result.split(id).join('[内部标识]');
      return result.replace(/https?:\/\/[^\s<>]+/gi, '[链接已隐藏]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[历史标识]')
        .replace(/r_[0-9a-f]{32}/gi, '[历史标识]')
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[密钥已隐藏]')
        .replace(/(?:\d{4}[ -]){2,4}\d{2,4}/g, '[号码已隐藏]')
        .replace(/\d{8,}/g, '[号码已隐藏]');
    };
    const primitive = (value, type) => {
      if (value == null) return null;
      if (type === 'money' || type === 'decimal') {
        if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,4})?$/.test(value)) throw invalid();
        return value;
      }
      if (type === 'number') {
        if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !Number.isFinite(Number(value))) throw invalid();
        return Number(value);
      }
      return scrub(String(value));
    };
    const datasets = snapshot.datasets.map(dataset => {
      const columns = dataset.columns.map(({ key, label, type }) => ({ key, label: scrub(label), type }));
      const rows = dataset.rows.map(row => {
        const safe = {};
        for (const col of columns) safe[col.key] = primitive(row[col.key], col.type);
        if (row.id != null) safe.ref = mapRef(DATASET_KINDS[dataset.datasetId], row.id);
        for (const [key, kind] of Object.entries(ID_FIELDS)) {
          if (Object.hasOwn(row, key) && row[key] != null && row[key] !== '') safe[`${kind}Ref`] = mapRef(kind, row[key]);
        }
        return safe;
      });
      const summary = {};
      for (const key of SUMMARY_FIELDS) {
        const value = dataset.summary && dataset.summary[key];
        if (value == null) continue;
        if (['income', 'expense', 'net', 'surplus', 'deficit', 'difference', 'changeAmt', 'daySalary', 'subsidy', 'deductions', 'planned', 'registeredUsed', 'remaining', 'amount'].includes(key)) summary[key] = primitive(value, 'money');
        else if (['count', 'totalCount', 'incomeCount', 'expenseCount', 'unpricedCount', 'approximateRatio'].includes(key)) summary[key] = primitive(value, 'number');
        else if (['sharePct', 'expenseSharePct', 'incomeSharePct', 'changePct', 'ratio', 'hours', 'profit', 'capitalDelta'].includes(key)) summary[key] = primitive(value, 'decimal');
        else if (key === 'incomplete') summary[key] = value === true;
        else summary[key] = primitive(value, 'text');
      }
      const queryMeta = dataset.queryMeta ? validateQueryMeta(dataset.queryMeta, dataset, scope) : null;
      if (queryMeta) { queryMeta.filters.text = scrub(queryMeta.filters.text); queryMeta.asOf = scrub(queryMeta.asOf); }
      return { datasetId: dataset.datasetId, domain: dataset.domain, title: scrub(dataset.title || dataset.domain),
        columns, rows, summary, policy: scrub(dataset.policy || ''), asOf: scrub(dataset.asOf || snapshot.asOf || ''),
        isEstimated: dataset.isEstimated === true, truncated: dataset.truncated === true,
        ...(queryMeta ? { queryMeta, totalCount: queryMeta.matchedRowCount } : {}),
        ...(typeof dataset.coverage === 'string' ? { coverage: scrub(dataset.coverage) } : {}) };
    });
    const choices = {};
    for (const [key, kind] of Object.entries(REF_KINDS)) {
      choices[key] = (snapshot.choices[key] || []).map(row => {
        const value = { ref: mapRef(kind, row.id), name: scrub(row.name || '') };
        for (const field of ['type', 'status', 'date']) if (row[field] != null) value[field] = scrub(String(row[field]));
        if (key === 'cards') {
          for (const field of ['bankName', 'cardType']) if (row[field] != null) value[field] = scrub(String(row[field]));
          if (typeof row.tail === 'string' && /^\d{1,4}$/.test(row.tail)) value.tail = row.tail;
        }
        return value;
      });
    }
    if (snapshot.choices.moods != null) {
      if (!Array.isArray(snapshot.choices.moods) || snapshot.choices.moods.length > 12) throw invalid();
      choices.moods = snapshot.choices.moods.map(scrub);
    }
    const safe = { scope, datasets, choices, asOf: scrub(snapshot.asOf || ''),
      ...(normalizedTransaction ? { normalizedTransaction } : {}),
      ...(normalizedTransactions ? { normalizedTransactions } : {}),
      context: context.map(item => ({ role: 'user', content: scrub(item.content) })) };
    const providerMessage = scrub(message);
    if (Buffer.byteLength(JSON.stringify({ ...safe, message: providerMessage })) > MAX_BYTES) {
      throw new AiError('数据预览超过64KiB，请缩小日期或业务范围', 400, 'AI_PREVIEW_TOO_LARGE');
    }
    return { snapshot: safe, refMap, providerMessage };
  }

  async function prepare(userId, { message, scope: inputScope, conversationId = null, snapshot, connectionId = null, provider = null, context = [], localFinancialInput, localFinancialInputs } = {}) {
    if (typeof userId !== 'string' || !userId || userId.length > 64 || typeof message !== 'string' || !message.trim() || message.length > 1500) throw invalid();
    if ((conversationId != null && (typeof conversationId !== 'string' || conversationId.length > 64))
      || (connectionId != null && (typeof connectionId !== 'string' || connectionId.length > 128))
      || (provider != null && (typeof provider !== 'string' || provider.length > 128))) throw invalid();
    if (!Array.isArray(context) || context.length > 4 || context.some(item => !item || item.role !== 'user'
      || typeof item.content !== 'string' || item.content.length > 500 || Object.keys(item).some(key => !['role', 'content'].includes(key)))) throw invalid();
    const scope = validateScope(inputScope || (snapshot && snapshot.scope), now());
    if (snapshot && snapshot.scope && JSON.stringify(validateScope(snapshot.scope, now())) !== JSON.stringify(scope)) throw invalid();
    const safe = safeSnapshot(userId, snapshot, scope, message, context, localFinancialInput, localFinancialInputs);
    const records = safe.snapshot.datasets.reduce((sum, dataset) => sum + dataset.rows.length, 0);
    const fields = safe.snapshot.datasets.reduce((sum, dataset) => sum + dataset.columns.length, 0);
    const previewId = crypto.randomUUID();
    const createdAt = timestamp(), expiresAt = createdAt + TTL;
    const data = { ...safe, message, scope, connectionId, provider, conversationId,
      ...(localFinancialInput != null ? { localFinancialInput: jsonClone(localFinancialInput) } : {}),
      ...(localFinancialInputs != null ? { localFinancialInputs: jsonClone(localFinancialInputs) } : {}) };
    const digest = computeDigest(data);
    const summary = `将发送 ${scope.domains.join('、') || '本轮聊天'} 范围内的 ${records} 行数据、${fields} 个展示字段、已列出的候选项和 ${context.length} 条历史用户原话。日期 ${scope.startDate} 至 ${scope.endDate}；内部标识和联系方式已隐藏。`;
    const payload = encryptField(JSON.stringify({ ...data,
      summary, records, fields, digest }));
    // Clear encrypted snapshots and ref maps in bounded owner-scoped batches.
    // Retain id/digest/approval/request binding as evidence, never paid-call eligibility.
    await db.execute(`UPDATE ai_analysis_preview SET payload = 'expired' WHERE user_id = ?
      AND expires_at <= ? AND payload <> 'expired' LIMIT 100`, [userId, createdAt]);
    await db.execute(`INSERT INTO ai_analysis_preview (id, user_id, digest, payload, created_at, expires_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`, [previewId, userId, digest, payload, createdAt, expiresAt]);
    return { previewId, expiresAt, digest, summary, scope, records, fields, datasets: jsonClone(safe.snapshot.datasets), choices: jsonClone(safe.snapshot.choices),
      context: jsonClone(safe.snapshot.context),
      ...(safe.snapshot.normalizedTransaction ? { normalizedTransaction: jsonClone(safe.snapshot.normalizedTransaction) } : {}) };
  }

  async function get(userId, previewId) {
    if (typeof userId !== 'string' || !userId || typeof previewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(previewId)) throw invalid();
    const current = timestamp();
    const [rows] = await db.execute(`SELECT id, user_id, digest, payload, expires_at, approved_at FROM ai_analysis_preview
      WHERE id = ? AND user_id = ? AND expires_at > ? LIMIT 1`, [previewId, userId, current]);
    const row = rows[0];
    if (!row || row.user_id !== userId || !Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= current) throw new AiError('预览不存在或已过期，请重新生成', 404, 'AI_PREVIEW_EXPIRED');
    let data;
    try {
      if (!isEncrypted(row.payload)) throw new Error('Unencrypted preview');
      data = JSON.parse(decryptField(row.payload));
      const digest = computeDigest(data);
      if (digest !== row.digest || digest !== data.digest) throw new Error('Preview digest mismatch');
    } catch (_) { throw new AiError('预览校验失败，请重新生成', 409, 'AI_PREVIEW_INVALID'); }
    return { ...data, previewId: row.id, digest: row.digest, expiresAt: Number(row.expires_at), approvedAt: row.approved_at == null ? null : Number(row.approved_at) };
  }

  async function approveAndGet(userId, previewId, consent) {
    if (consent !== true) throw new AiError('请在预览中明确确认发送数据', 400, 'AI_CONSENT_REQUIRED');
    const before = await get(userId, previewId);
    if (before.approvedAt < 0) throw new AiError('这个预览已取消，请重新生成', 410, 'AI_PREVIEW_CANCELLED');
    const current = timestamp();
    await db.execute(`UPDATE ai_analysis_preview SET approved_at = ? WHERE id = ? AND user_id = ?
      AND expires_at > ? AND approved_at IS NULL`, [current, previewId, userId, current]);
    const value = await get(userId, previewId);
    if (value.approvedAt < 0) throw new AiError('这个预览已取消，请重新生成', 410, 'AI_PREVIEW_CANCELLED');
    if (value.approvedAt == null) throw new AiError('数据预览尚未获准发送', 409, 'AI_CONSENT_REQUIRED');
    return value;
  }

  async function toProvider(userId, previewId) {
    const data = await get(userId, previewId);
    if (data.approvedAt < 0) throw new AiError('这个预览已取消，请重新生成', 410, 'AI_PREVIEW_CANCELLED');
    if (data.approvedAt == null) throw new AiError('数据预览尚未获准发送', 403, 'AI_CONSENT_REQUIRED');
    return { ...jsonClone(data.snapshot), message: data.providerMessage };
  }

  async function resolve(userId, previewId, ref, kind) {
    if (typeof ref !== 'string' || !/^r_[0-9a-f]{32}$/.test(ref) || typeof kind !== 'string') throw new AiError('请选择本次预览中的有效候选项', 400, 'AI_REF_INVALID');
    const data = await get(userId, previewId);
    if (data.approvedAt < 0) throw new AiError('这个预览已取消，请重新生成', 410, 'AI_PREVIEW_CANCELLED');
    if (data.approvedAt == null) throw new AiError('数据预览尚未获准发送', 403, 'AI_CONSENT_REQUIRED');
    const entry = data.refMap && Object.hasOwn(data.refMap, ref) && data.refMap[ref];
    if (!entry || entry.kind !== kind) throw new AiError('候选标识不属于当前预览或业务类型', 400, 'AI_REF_INVALID');
    return entry.id;
  }

  async function revoke(userId, previewId) {
    await get(userId, previewId);
    const [result] = await db.execute(`UPDATE ai_analysis_preview SET approved_at = -1 WHERE id = ? AND user_id = ?
      AND expires_at > ? AND request_id IS NULL`, [previewId, userId, timestamp()]);
    if (result.affectedRows !== 1) throw new AiError('这个预览已发送，不能再取消外发；请读取请求回执', 409, 'AI_PREVIEW_ALREADY_SENT');
    // 2026-11-07 修复：前端 validateAiPreviewCancellation 校验 cancelled 字段， revoked 是从未被消费的旧形状
    return { previewId, cancelled: true };
  }

  return { prepare, get, approveAndGet, toProvider, resolve, revoke };
}

module.exports = { createPreviewStore, TTL, MAX_BYTES };
