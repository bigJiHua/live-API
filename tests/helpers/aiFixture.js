const crypto = require('crypto');
const { createAiService } = require('../../src/modules/ai/service');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const { AiError } = require('../../src/modules/ai/service/errors');
const { createMemoryRequestGuard } = require('./aiRequestFixture');
const { digestInput } = require('../../src/modules/ai/service/requestGuard');
const { preflightTransaction } = require('../../src/common/services/financialPreflight');

function testEnv(extra = {}) {
  return { NODE_ENV: 'test', AI_MODE: 'deepseek', AI_SYNTHETIC_DATA: 'false',
    DEEPSEEK_API_KEY: 'fixture-key', AI_DB_HOST: 'fixture.invalid', AI_DB_NAME: 'fixture',
    AI_DB_USER: 'fixture_reader', AI_DB_PASSWORD: 'fixture-password', ...extra };
}
function createTestRepository() {
  return {
    async summary(_, range) {
      return { ...range, currency: 'CNY', income: '95.00', expense: '51.20', count: 2,
        categories: [{ direction: 0, category: '餐饮', amount: '51.20', count: 1 }], policy: '测试查询口径' };
    },
    async transactions(_, range) { return { ...range, rows: [], total: 0, hasMore: false }; },
    async choices() {
      return { accounts: [{ id: 'fixture_balance', name: '余额账户', type: 'virtual_balance' },
        { id: 'fixture_cash', name: '现金账户', type: 'virtual_cash' }],
      categories: [{ id: 'fixture_food', name: '餐饮', type: 'expense' },
        { id: 'fixture_salary', name: '工资', type: 'income' }] };
    },
  };
}
function createMemoryDraftStore({ now = Date.now } = {}) {
  const records = new Map();
  const key = (userId, id) => `${userId}|${id}`;
  const conflict = () => new AiError('草稿版本已变化，请重新核对', 409, 'AI_DRAFT_CONFLICT');
  return {
    async save(userId, input) {
      const draft = { ...structuredClone(input), id: crypto.randomUUID(), version: 1, status: 'pending',
        expiresAt: new Date(now()).getTime() + 15 * 60 * 1000 };
      records.set(key(userId, draft.id), draft);
      return structuredClone(draft);
    },
    async get(userId, id) {
      const draft = records.get(key(userId, id));
      if (!draft) throw new AiError('草稿不存在或已过期', 404);
      return structuredClone(draft);
    },
    async update(userId, id, version, fields) {
      const draft = await this.get(userId, id);
      if (draft.status === 'discarded') throw new AiError('草稿已取消', 409, 'AI_DRAFT_DISCARDED');
      if (draft.status === 'committed' || draft.version !== version) throw conflict();
      const next = { ...draft, ...structuredClone(fields), version: version + 1, status: 'pending' };
      records.set(key(userId, id), next);
      return structuredClone(next);
    },
    async act(userId, id, version, action, financialReview = null) {
      const draft = await this.get(userId, id);
      if (['discarded', 'committed'].includes(draft.status) || draft.version !== version) throw conflict();
      if (action === 'review' && draft.missingFields.length) throw new AiError('请先补齐草稿');
      draft.status = action === 'review' ? 'reviewed' : 'discarded'; draft.version++;
      draft.trace = [...(draft.trace || []).filter(item => item.tool !== 'financial_review'),
        ...(action === 'review' && financialReview ? [{ tool: 'financial_review', result: structuredClone(financialReview) }] : [])];
      records.set(key(userId, id), draft);
      return structuredClone(draft);
    },
  };
}
function createMemoryCandidateStore({ now = Date.now, ttl = 15 * 60 * 1000 } = {}) {
  const records = new Map(), requests = new Map(), fingerprints = new Map();
  const clone = value => JSON.parse(JSON.stringify(value));
  const key = (userId, id) => `${userId}|${id}`;
  const stamp = () => new Date(now()).getTime();
  const invalid = () => new AiError('候选来源或字段不合法', 400, 'AI_CANDIDATE_INVALID');
  const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
  return {
    snapshot: () => structuredClone({ records, requests, fingerprints }),
    restore(snapshot) {
      for (const [target, source] of [[records, snapshot.records], [requests, snapshot.requests], [fingerprints, snapshot.fingerprints]]) {
        target.clear(); for (const [id, value] of source) target.set(id, value);
      }
    },
    async save(userId, input) {
      const { requestId = null, sourceFingerprint = null, ...payload } = input;
      if (!userId || !['user-readonly', 'image-ocr'].includes(payload.source) || !payload.fields ||
        requestId != null && !uuid(requestId) || sourceFingerprint != null && !/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw invalid();
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > 64 * 1024 || /data:image\/|"dataUrl"\s*:/.test(serialized)) throw invalid();
      const inputDigest = digestInput(payload);
      const priorId = requestId && requests.get(key(userId, requestId)) || sourceFingerprint && fingerprints.get(key(userId, sourceFingerprint));
      if (priorId) {
        const prior = records.get(key(userId, priorId));
        if (requestId && prior.inputDigest !== inputDigest) throw new AiError('同一请求编号不能改变交易内容', 409, 'AI_CANDIDATE_CONFLICT');
        return this.get(userId, priorId);
      }
      const id = crypto.randomUUID();
      const value = { ...clone(payload), id, sourceCandidateId: id, status: 'pending', draftId: null, expiresAt: stamp() + ttl, inputDigest };
      records.set(key(userId, id), value);
      if (requestId) requests.set(key(userId, requestId), id);
      if (sourceFingerprint) fingerprints.set(key(userId, sourceFingerprint), id);
      return clone(value);
    },
    async get(userId, id, _conn, { allowEnded = false } = {}) {
      if (!userId || !uuid(id)) throw invalid();
      const value = records.get(key(userId, id));
      if (!value) throw new AiError('候选不存在或已过期', 404, 'AI_CANDIDATE_EXPIRED');
      if (value.status !== 'consumed' && value.expiresAt <= stamp()) {
        if (allowEnded) return { ...clone(value), status: 'expired' };
        throw new AiError('候选已过期，请重新核查', 410, 'AI_CANDIDATE_EXPIRED');
      }
      if (!allowEnded && ['failed', 'discarded'].includes(value.status)) throw new AiError('本次候选已结束，不会重新生成草稿', 409, 'AI_CANDIDATE_ENDED');
      return clone(value);
    },
    async findByFingerprint(userId, fingerprint) {
      const id = fingerprints.get(key(userId, fingerprint));
      return id ? clone(records.get(key(userId, id))) : null;
    },
    async consume(userId, id, draftId) {
      const value = await this.get(userId, id);
      if (value.status !== 'pending') throw new AiError('候选已使用或过期，请读取原卡片', 409, 'AI_CANDIDATE_CONFLICT');
      records.set(key(userId, id), { ...value, status: 'consumed', draftId });
    },
    async supplement(userId,id,expectedDigest,fields,entry) {
      const value=await this.get(userId,id);
      if(value.status!=='pending'||value.draftId||value.inputDigest!==expectedDigest)
        throw new AiError('候选已变化',409,'AI_CANDIDATE_CONFLICT');
      const {id:_id,sourceCandidateId,status,draftId,expiresAt,inputDigest,...payload}=value;
      payload.fields=clone(fields);payload.trace=[...(value.trace||[]).slice(-19),clone(entry)];
      const next={...payload,id,sourceCandidateId:id,status,draftId,expiresAt,inputDigest:digestInput(payload)};
      records.set(key(userId,id),next);return clone(next);
    },
    async discard(userId, id) {
      const value = await this.get(userId, id);
      if (value.status === 'consumed') throw new AiError('此候选已生成草稿，请取消原草稿', 409, 'AI_CANDIDATE_CONSUMED');
      records.set(key(userId, id), { ...value, status: 'discarded' });
      return { sourceCandidateId: id, cancelled: true };
    },
  };
}
// Pure financial preflight runs over explicit fake SELECT evidence; no DB or provider fallback.
function createMemoryFinancialRepository({ now = () => new Date('2026-11-05T08:00:00Z'), accounts,
  ledger, duplicateRows = [], historyRows = [] } = {}) {
  const cards = accounts || [{ id: 'fixture_balance', card_type: 'virtual_balance', currency: 'CNY', status: '正常' },
    { id: 'fixture_cash', card_type: 'virtual_cash', currency: 'CNY', status: '正常' }];
  const select = async (input, params) => {
    const sql = typeof input === 'string' ? input : input.sql;
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error('Financial fixture accepts SELECT only');
    if (sql.includes('FROM card_base')) return [structuredClone(cards.filter(card => card.id === params[1]))];
    if (sql.includes('FROM account') && sql.includes('ORDER BY id LIMIT 5001')) return [structuredClone(ledger || [{
      id: 'fixture-opening-income', card_id: params[1], currency: 'CNY', direction: 1, amount: '100000.00',
      trans_date: new Date(new Date(now()).getTime() + 8 * 3600000).toISOString().slice(0, 10), category_id: 'fixture_salary', reversed_id: null,
    }])];
    if (sql.includes('FROM account') && sql.includes('LIMIT 21')) return [structuredClone(duplicateRows)];
    if (sql.includes('FROM account') && sql.includes('LIMIT 501')) return [structuredClone(historyRows)];
    throw new Error('Unexpected financial fixture SQL: ' + sql);
  };
  const executor = { execute: select };
  return { executor, check: (userId, fields) => preflightTransaction(executor, userId, fields, { now: now() }),
    read: work => work(async (sql, params) => (await select(sql, params))[0]) };
}
function createMemoryWriteDb(executor, infrastructureExecutor) {
  let tail = Promise.resolve();
  return { async getConnection() {
    let unlock;
    const infrastructure = infrastructureExecutor ? await infrastructureExecutor.getConnection() : null;
    return { async beginTransaction() {
      if (infrastructure) return infrastructure.beginTransaction();
      const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    },
      async query(sql) { if (!/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/i.test(sql.trim())) throw new Error('Unexpected fixture statement'); return [[]]; },
      async execute(sql, params) {
        if (typeof sql === 'string' && sql.startsWith('UPDATE ai_request_run SET result_payload=?')) {
          if (!infrastructure) throw new Error('Local recovery requires the shared request infrastructure fixture');
          return infrastructure.execute(sql, params);
        }
        return executor.execute(sql, params);
      },
      async commit() { if (infrastructure) await infrastructure.commit(); },
      async rollback() { if (infrastructure) await infrastructure.rollback(); },
      release() { if (infrastructure) infrastructure.release(); else if (unlock) unlock(); } };
  } };
}
function createMemoryConversationStore() {
  const records = new Map();
  return {
    snapshot: () => structuredClone(records),
    restore(snapshot) { records.clear(); for (const [id, value] of snapshot) records.set(id, value); },
    async open(userId, id) {
      if (id) {
        const record = records.get(id);
        if (!record || record.userId !== userId) throw new AiError('对话不存在或已过期', 404, 'AI_CONVERSATION_EXPIRED');
        return structuredClone(record);
      }
      const record = { id: crypto.randomUUID(), userId, history: [], latestDraftId: null };
      records.set(record.id, record);
      return structuredClone(record);
    },
    async append(userId, id, { message, answer, draft }) {
      await this.open(userId, id);
      const record = records.get(id);
      record.history.push({ role: 'user', content: message }, { role: 'assistant', content: answer });
      record.history = record.history.slice(-10);
      if (draft) record.latestDraftId = draft.id;
    },
    async list(userId) {
      return [...records.values()].filter(record => record.userId === userId).map(record => ({
        id: record.id, title: record.history[0]?.content || '新对话', messageCount: record.history.length,
      }));
    },
    async messages(userId, id) { return (await this.open(userId, id)).history; },
    async remove(userId, id) { await this.open(userId, id); records.delete(id); },
    async clearUser(userId) {
      for (const [id, record] of records) if (record.userId === userId) records.delete(id);
    },
  };
}
const call = (name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ type: 'function', id: crypto.randomUUID(), function: { name, arguments: JSON.stringify(args) } }] });
function createFixtureChat(today = '2026-11-05') {
  return async messages => {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') {
      const result = JSON.parse(last.content);
      if (result.accounts && result.categories) {
        const text = messages.filter(item => item.role === 'user').at(-1).content;
        const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
        return call('propose_transaction', { direction: 0, amount: '32', currency: 'CNY', transDate: yesterday,
          categoryId: result.categories.find(item => item.name === '餐饮').id,
          accountId: result.accounts.find(item => item.name === '余额账户').id, payMethod: '支付宝', remark: '午饭' });
      }
      return { role: 'assistant', content: result.amount ? '请核对聊天中的草稿。' : `支出${result.expense || '0.00'}元。` };
    }
    if (last.content.includes('草稿多少钱')) {
      const snapshot = messages.find(message => message.content?.startsWith('[应用提供的最近草稿状态'));
      const draft = snapshot ? JSON.parse(snapshot.content.slice(snapshot.content.indexOf('{'))) : null;
      return { role: 'assistant', content: draft ? `这份草稿是${draft.amount}元。` : '请先生成草稿。' };
    }
    if (last.content.includes('明细')) return call('query_transactions', { startDate: today.slice(0, 8) + '01', endDate: today });
    if (last.content.includes('收支')) return call('query_finance_summary', { startDate: today.slice(0, 8) + '01', endDate: today });
    if (last.content.includes('午饭') || last.content.includes('记账35元')) {
      const incomplete = last.content.includes('记账35元');
      if (!incomplete) return call('list_record_choices', {});
      const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
      return call('propose_transaction', { direction: 0, amount: incomplete ? '35' : '32', currency: 'CNY',
        transDate: yesterday, categoryId: incomplete ? null : 'fixture_food',
        accountId: incomplete ? null : 'fixture_balance', payMethod: incomplete ? null : '支付宝', remark: '午饭' });
    }
    return { role: 'assistant', content: '你好，可以查询账本和整理草稿。' };
  };
}
// 2026-11-08：生产已停用 .env 凭据。单元测试仍沿用 fixture env 的 Key/地址/模型，
// 但通过内存 settingsStore 注入（等价于数据库里已有一条接入商），不再走 env 回退。
function createSeededSettingsStore(env) {
  const store = createSettingsStore();
  const apiKey = env.AI_API_KEY || env.DEEPSEEK_API_KEY;
  if (env.AI_MODE !== 'deepseek' || !apiKey) return store;
  const seed = { name: 'fixture-provider', apiUrl: env.AI_BASE_URL || 'https://api.deepseek.com',
    apiKey, model: env.AI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash' };
  const seeded = new Set();
  const ensure = userId => {
    if (typeof userId !== 'string' || seeded.has(userId) || store.list(userId).length) return;
    seeded.add(userId);
    store.save(userId, seed);
  };
  return new Proxy(store, {
    get(target, prop) {
      if (['get', 'list', 'findByUrl', 'getByConnection'].includes(prop)) {
        return (...args) => { ensure(args[0]); return target[prop](...args); };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function createTestServiceOptions(options = {}) {
  const env = options.env || testEnv();
  const now = options.now || (() => new Date('2026-11-05T08:00:00Z'));
  const financialRepository = options.financialRepository || createMemoryFinancialRepository({ now });
  const requestGuard = options.requestGuard || createMemoryRequestGuard();
  return { env, repository: createTestRepository(), chat: createFixtureChat(),
    draftStore: createMemoryDraftStore({ now }), conversationStore: createMemoryConversationStore(),
    financialRepository, candidateStore: createMemoryCandidateStore({ now }), writeDb: createMemoryWriteDb(financialRepository.executor, requestGuard.fixtureExecutor),
    requestGuard,
    // 未注入 settingsStore 时用纯内存版（无持久化 executor），单元测试不触碰真实 DB
    ...(options.settingsStore !== undefined ? {} : { settingsStore: createSeededSettingsStore(env) }),
    checkConnection: async () => { throw new Error('Test must inject connection check'); },
    now, ...options };
}
function createTestService(options = {}) {
  return createAiService(createTestServiceOptions(options));
}
function createLegacyTestService(options = {}) {
  const inputs = createTestServiceOptions(options);
  const { withLegacyAiService } = require('./legacyAiService');
  return withLegacyAiService(createAiService(inputs), inputs);
}
module.exports = { testEnv, createTestRepository, createMemoryDraftStore, createMemoryConversationStore,
  createMemoryCandidateStore, createMemoryFinancialRepository, createMemoryWriteDb,
  createFixtureChat, createTestService, createLegacyTestService, createMemoryRequestGuard, call };
