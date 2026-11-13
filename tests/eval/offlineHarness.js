// §5 C 黄金评测集 · offline 档 harness：脚本化 provider 驱动真实 createV3Service 全链路。
// 不碰库、不碰供应商（「不碰公共库/不碰真库」铁律都成立）；live 档见 live.evaltest.js。
// 用例 JSONL 契约见 cases/golden-cases.jsonl 与 README.md。
const crypto = require('crypto');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createWebSearchTools } = require('../../src/modules/ai/service/webSearchTools');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');

const id = () => crypto.randomUUID();
const now = () => new Date('2026-11-07T04:00:00Z');

// ===== 数据集注册表：数字自洽（各用例期望要点全部能在工具回执中找到）=====
// 口径对齐 house 规则：finance-monthly 全范围汇总、11 月为未结束月份、
// card-counts 全部含虚拟类型、卡消费仅支出、工资是历史登记而非当前规则。
const CHOICES = {
  cards: [
    { id: 'card-cmb-debit', name: '招行储蓄卡', type: 'debit' },
    { id: 'card-cmb-credit', name: '招行信用卡', type: 'credit' },
    { id: 'card-wechat', name: '微信账户', type: 'virtual_wechat' },
  ],
  categories: [
    { id: 'cat-food', name: '餐饮', type: 'expense' },
    { id: 'cat-traffic', name: '交通', type: 'expense' },
    { id: 'cat-shop', name: '购物', type: 'expense' },
    { id: 'cat-salary', name: '工资', type: 'income' },
  ],
  todos: [], funds: [], fixedAssets: [], moods: [],
};
const DATASETS = {
  'finance-monthly': { datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
    columns: [{ key: 'month', label: '月份', type: 'date' }, { key: 'income', label: '收入', type: 'money' }, { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }, { key: 'currency', label: '币种', type: 'text' }],
    rows: [
      { month: '2026-09', income: '8500.00', expense: '3200.00', count: 42, currency: 'CNY' },
      { month: '2026-10', income: '8800.00', expense: '4250.50', count: 57, currency: 'CNY' },
      { month: '2026-11', income: '0.00', expense: '268.40', count: 9, currency: 'CNY' },
    ],
    summary: { income: '17300.00', expense: '7718.90', count: 108, currency: 'CNY' }, policy: '已保存收支', asOf: now().toISOString() },
  'finance-categories': { datasetId: 'finance-categories', domain: 'finance', title: '分类汇总',
    columns: [{ key: 'category', label: '分类', type: 'text' }, { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }, { key: 'sharePct', label: '占比', type: 'decimal' }, { key: 'currency', label: '币种', type: 'text' }],
    rows: [
      { category: '购物', expense: '2300.50', count: 33, sharePct: '29.80', currency: 'CNY' },
      { category: '餐饮', expense: '1450.00', count: 38, sharePct: '18.79', currency: 'CNY' },
      { category: '交通', expense: '620.00', count: 26, sharePct: '8.03', currency: 'CNY' },
    ],
    summary: { expense: '7718.90', currency: 'CNY' }, policy: '全范围分类汇总', asOf: now().toISOString() },
  'finance-transactions': { datasetId: 'finance-transactions', domain: 'finance', title: '收支明细',
    columns: [{ key: 'amount', label: '金额', type: 'money' }, { key: 'remark', label: '备注', type: 'text' }, { key: 'date', label: '日期', type: 'date' }, { key: 'category', label: '分类', type: 'text' }, { key: 'currency', label: '币种', type: 'text' }],
    rows: [
      { id: 'tx-1', amount: '2300.50', remark: '电器', date: '2026-10-18', category: '购物', currency: 'CNY' },
      { id: 'tx-3', amount: '60.00', remark: '午餐', date: '2026-10-18', category: '餐饮', currency: 'CNY' },
    ],
    summary: { currency: 'CNY' }, policy: '明细不是全量统计', asOf: now().toISOString() },
  'finance-daily': { datasetId: 'finance-daily', domain: 'finance', title: '逐日收支',
    columns: [{ key: 'date', label: '日期', type: 'date' }, { key: 'expense', label: '支出', type: 'money' }, { key: 'currency', label: '币种', type: 'text' }],
    rows: [
      { date: '2026-10-18', expense: '2360.50', currency: 'CNY' },
      { date: '2026-10-02', expense: '186.00', currency: 'CNY' },
    ],
    summary: { expense: '7718.90', currency: 'CNY' }, policy: '全范围逐日收支', asOf: now().toISOString() },
  'card-counts': { datasetId: 'card-counts', domain: 'card', title: '卡片数量',
    columns: [{ key: 'cardType', label: '类型', type: 'text' }, { key: 'count', label: '数量', type: 'number' }],
    rows: [
      { cardType: 'credit', count: 2 },
      { cardType: 'debit', count: 3 },
      { cardType: 'virtual', count: 2 },
    ],
    summary: { totalCount: 7 }, policy: '本人卡片数量；cardTypes筛类型', asOf: now().toISOString() },
  'card-monthlyConsumption': { datasetId: 'card-monthlyConsumption', domain: 'card', title: '卡月度消费',
    columns: [{ key: 'name', label: '卡片', type: 'text' }, { key: 'month', label: '月份', type: 'date' }, { key: 'amountCNY', label: '消费', type: 'money' }],
    rows: [
      { name: '招行信用卡', month: '2026-10', amountCNY: '1980.00' },
      { name: '招行信用卡', month: '2026-09', amountCNY: '1650.00' },
      { name: '微信账户', month: '2026-10', amountCNY: '320.40' },
    ],
    summary: { currency: 'CNY' }, policy: '仅消费支出', asOf: now().toISOString() },
  'card-bills': { datasetId: 'card-bills', domain: 'card', title: '卡片账单',
    columns: [{ key: 'name', label: '卡片', type: 'text' }, { key: 'date', label: '账单月', type: 'date' }, { key: 'billAmount', label: '账单额', type: 'money' }, { key: 'repaid', label: '已还', type: 'money' }],
    rows: [
      { name: '招行信用卡', date: '2026-10', billAmount: '1980.00', repaid: '1980.00' },
      { name: '招行信用卡', date: '2026-11', billAmount: '920.00', repaid: '0.00' },
    ],
    summary: { currency: 'CNY' }, policy: '已保存账单快照，不等于消费流水', asOf: now().toISOString() },
  'budget-plans': { datasetId: 'budget-plans', domain: 'budget', title: '预算计划',
    columns: [{ key: 'title', label: '名称', type: 'text' }, { key: 'planned', label: '预算', type: 'money' }, { key: 'registeredUsed', label: '已登记使用', type: 'money' }, { key: 'cycle', label: '期间', type: 'text' }],
    rows: [{ title: '10月餐饮预算', planned: '2000.00', registeredUsed: '1450.00', cycle: '2026-10' }],
    summary: {}, policy: '预算计划及已登记使用情况，不是实际完整消费', asOf: now().toISOString() },
  'todo-events': { datasetId: 'todo-events', domain: 'todo', title: '日程待办',
    columns: [{ key: 'date', label: '日期', type: 'date' }, { key: 'content', label: '事项', type: 'text' }, { key: 'status', label: '状态', type: 'text' }],
    rows: [
      { date: '2026-11-20', content: '缴房租', status: 'pending' },
      { date: '2026-12-01', content: '信用卡还款', status: 'pending' },
    ],
    summary: {}, policy: '本人日程与待办，可查未来日期', asOf: now().toISOString() },
  'asset-composition': { datasetId: 'asset-composition', domain: 'asset', title: '资产组成',
    columns: [{ key: 'type', label: '类型', type: 'text' }, { key: 'positiveAssets', label: '资产', type: 'money' }, { key: 'creditDebt', label: '负债', type: 'money' }, { key: 'currency', label: '币种', type: 'text' }],
    rows: [
      { type: 'bank', positiveAssets: '52000.00', creditDebt: '0.00', currency: 'CNY' },
      { type: 'credit', positiveAssets: '0.00', creditDebt: '8500.00', currency: 'CNY' },
      { type: 'virtual', positiveAssets: '320.00', creditDebt: '0.00', currency: 'CNY' },
    ],
    summary: { positiveAssets: '52320.00', creditDebt: '8500.00', currency: 'CNY' }, policy: '全量已保存账户余额聚合', asOf: now().toISOString() },
  'account-balances': { datasetId: 'account-balances', domain: 'account', title: '账户余额明细',
    columns: [{ key: 'name', label: '账户', type: 'text' }, { key: 'updatedAt', label: '记录日', type: 'date' }, { key: 'balance', label: '余额', type: 'money' }, { key: 'currency', label: '币种', type: 'text' }],
    rows: [
      { name: '招行储蓄卡', updatedAt: '2026-10-31', balance: '32500.00', currency: 'CNY' },
      { name: '微信账户', updatedAt: '2026-10-31', balance: '320.00', currency: 'CNY' },
    ],
    summary: {}, policy: '逐账户已保存余额明细', asOf: now().toISOString() },
  'fund-holdings': { datasetId: 'fund-holdings', domain: 'fund', title: '基金持仓',
    columns: [{ key: 'name', label: '基金', type: 'text' }, { key: 'marketValue', label: '市值', type: 'money' }, { key: 'principal', label: '本金', type: 'money' }, { key: 'profit', label: '收益', type: 'money' }],
    rows: [
      { name: '沪深300指数A', marketValue: '12850.00', principal: '12000.00', profit: '850.00' },
      { name: '债基B', marketValue: '5200.00', principal: '5400.00', profit: '-200.00' },
    ],
    summary: { currency: 'CNY' }, policy: '本人基金持仓', asOf: now().toISOString() },
  'work-salary': { datasetId: 'work-salary', domain: 'work', title: '工资历史',
    columns: [{ key: 'date', label: '月份', type: 'date' }, { key: 'income', label: '实发', type: 'money' }],
    rows: [
      { date: '2026-09-01', income: '8500.00' },
      { date: '2026-10-01', income: '8800.00' },
    ],
    summary: { currency: 'CNY' }, policy: '本人已保存工资历史，按日期范围查询', asOf: now().toISOString() },
  'work-rules': { datasetId: 'work-rules', domain: 'work', title: '工资规则',
    columns: [{ key: 'type', label: '项目', type: 'text' }, { key: 'hourlyWage', label: '时薪', type: 'money' }],
    rows: [{ type: '加班时薪', hourlyWage: '50.00' }],
    summary: {}, policy: '本人工作与薪资规则（当前保存配置）', asOf: now().toISOString() },
  'installment-plans': { datasetId: 'installment-plans', domain: 'installment', title: '分期计划',
    columns: [{ key: 'name', label: '名称', type: 'text' }, { key: 'amount', label: '月供', type: 'money' }, { key: 'periods', label: '总期数', type: 'number' }, { key: 'pending', label: '待入账', type: 'number' }],
    rows: [{ name: '手机分期', amount: '416.67', periods: 6, pending: 1 }],
    summary: {}, policy: '目前保存配置与待入账状态', asOf: now().toISOString() },
};

// ===== 用例执行 fixture（口径与 tests/unit/aiV3Service.test.js 一致）=====
function createEvalFixture(caseDef, { config = {}, webSearchTools, searchBudget, grants: grantsOverride } = {}) {
  if (caseDef.requiresSearch) {
    config = { searchEnabled: true, searchBaseUrl: 'https://api.deepseek.com', searchApiKey: 'offline-search-key',
      searchProvider: 'deepseek', searchTimeoutMs: 10000, searchDailyLimit: 50, ...config };
    webSearchTools ||= createWebSearchTools({ now, client: async () => ({ results: [{ title: '公开发布',
      url: 'https://example.com/news', snippet: '公开消息已发布。', date: '2026-11-07' }] }) });
    searchBudget ||= { reserve: async () => true };
  }
  const conversationId = id(), history = [], previewsById = new Map();
  const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, execute: async () => [{ affectedRows: 1 }] };
  const executor = { getConnection: async () => conn, execute: jest.fn(async (sql, params) => {
    if (sql.startsWith("UPDATE ai_analysis_preview SET payload = 'expired'")) return [{ affectedRows: 0 }];
    if (sql.startsWith('INSERT INTO ai_analysis_preview')) {
      const [pid, user_id, digest, payload, created_at, expires_at] = params;
      previewsById.set(pid, { id: pid, user_id, digest, payload, created_at, expires_at, approved_at: null }); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, user_id, digest')) { const row = previewsById.get(params[0]); return [[...(row && row.user_id === params[1] ? [row] : [])]]; }
    if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at')) { previewsById.get(params[1]).approved_at = params[0]; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE ai_analysis_preview SET request_id')) { const row = previewsById.get(params[1]); if (row.request_id) return [{ affectedRows: 0 }]; row.request_id = params[0]; return [{ affectedRows: 1 }]; }
    throw new Error('Unexpected eval SQL ' + sql.slice(0, 60));
  }) };
  const previews = createPreviewStore({ executor, now: () => now().getTime() });
  const raw = { scope: { domains: [], startDate: '2026-09-01', endDate: '2026-11-07' }, asOf: now().toISOString(),
    choices: CHOICES, datasets: (caseDef.datasets || []).map(key => DATASETS[key]).filter(Boolean) };
  // 仿真实仓库：按 queryMeta.effectiveScope 过滤行（mock 不滤会导致 returnedDateRange 越界）。
  const repository = { query: jest.fn(async (_userId, scope) => {
    if (process.env.DEBUG_CASE) console.log('REPO-SCOPE:', JSON.stringify(scope), 'datasets:', JSON.stringify((caseDef.datasets||[])));
    const datasets = raw.datasets.map(dataset => {
      const range = scope && scope.startDate ? scope : dataset.queryMeta?.effectiveScope;
      if (!range || !range.startDate) return dataset;
      const rows = dataset.rows.filter(row => {
        const date = row.date || row.updatedAt || (row.month ? `${row.month}-01` : null);
        return !date || (date >= range.startDate && date <= range.endDate);
      });
      return rows.length === dataset.rows.length ? dataset : { ...dataset, rows };
    });
    return { ...raw, scope, datasets };
  }) };
  const grants = grantsOverride || { requireCoverage: jest.fn(), requireWebSearch: jest.fn(async () => {}) };
  const proposals = { create: jest.fn(async (_, input, connection) => ({ id: id(), ...input, status: 'pending', version: 1, connection })), get: jest.fn() };
  const legacy = { getRuntime: () => state,
    prepareTransactionProposal: jest.fn(async (_, fields, metadata) => ({ preparedDraft: { ...fields, ...metadata } })),
    persistTransactionBatch: jest.fn(async (_, items, options) => {
      const artifacts = items.map(item => ({ draft: { id: id(), ...item.preparedDraft, status: 'pending', version: 1 } }));
      const built = options.buildResult(artifacts);
      await options.assertAuthorization(conn);
      return built.result;
    }) };
  // 脚本化响应：toolScript 每项一轮单工具调用；final 为终稿；终稿轮（无工具 JSON 阶段）复用终稿材料。
  // draft 用例的终稿由函数动态构造：从 list_choices 回执取运行时 ref 填入 proposal 字段。
  const draftFinal = caseDef.draft ? (_, messages) => {
    const choice = JSON.parse(messages.findLast(message => message.role === 'tool').content);
    const proposal = structuredClone(caseDef.draft.proposal);
    proposal.fields.accountRef = choice.choices.cards.find(card => card.name === proposal.fields.accountName)?.ref;
    proposal.fields.categoryRef = choice.choices.categories.find(category => category.name === proposal.fields.categoryName)?.ref;
    delete proposal.fields.accountName; delete proposal.fields.categoryName;
    return { role: 'assistant', content: JSON.stringify({ answer: caseDef.draft.answer, proposal, clarification: null, chart: null }) };
  } : null;
  const finalResponse = caseDef.draft ? draftFinal : caseDef.mode === 'chat' || caseDef.mode === 'analysis'
    ? { role: 'assistant', content: caseDef.final.answer }
    : { role: 'assistant', content: JSON.stringify({ answer: caseDef.final.answer,
        proposal: caseDef.final.proposal || null, clarification: null, chart: null }) };
  const responses = [...(caseDef.toolScript || []).map(([name, args]) => ({ role: 'assistant', content: null,
    tool_calls: [{ id: 'call_' + Math.random().toString(16).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })),
    finalResponse];
  const all = [...responses, responses.at(-1)];
  const provider = jest.fn(async (...args) => { const response = all[provider.mock.calls.length - 1]; return typeof response === 'function' ? response(...args) : response; });
  const state = { config: { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://api.example.com', model: 'eval-model',
    apiKey: 'eval', dailyProviderLimit: 100, maxUsageTokens: 30000, ...config }, connectionId: id(),
    businessPolicy: { enabled: true, domains: ['finance', 'account', 'todo', 'budget', 'card', 'fund', 'asset', 'fixedAsset', 'work', 'installment'],
      actions: ['transaction.create', 'todo.create', 'todo.update', 'todo.delete', 'budget.create', 'diary.create'] },
    conversationStore: { open: jest.fn(async () => ({ id: conversationId, history, latestDraftId: null })),
      session: jest.fn(async () => ({ id: conversationId })),
      append: jest.fn(async (_, __, payload) => {
        if (payload.message) history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: '2026-11-07' });
        history.push({ role: 'assistant', content: payload.answer, turnId: payload.requestId, ...(payload.queryContext ? { queryContext: payload.queryContext } : {}) });
      }), appendFailure: jest.fn(async (_, __, payload) => history.push({ role: 'user', content: payload.message, turnId: payload.requestId },
        { role: 'assistant', content: payload.notice, turnId: payload.requestId, failure: { requestId: payload.requestId, code: payload.errorCode } })) },
    requestGuard: { run: jest.fn(async (_, request, work) => {
      let count = 0;
      const budget = { requestId: request.requestId, calls: 0, check: () => {}, tool: () => {},
        invoke: async fn => { if (count >= request.maxProviderCalls) throw new AiError('预算', 502, 'AI_PROVIDER_CALL_LIMIT'); budget.calls = ++count; return fn(); } };
      return work(budget);
    }), saveV3Recovery: jest.fn() } };
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor, repository, previews, proposals,
    provider, grants, ...(webSearchTools ? { webSearchTools } : {}), ...(searchBudget ? { searchBudget } : {}),
    callLog: { record: entry => { if (process.env.DEBUG_CASE && entry.phase !== 'provider' && entry.phase !== 'tool') console.log('AUDIT:', entry.phase, entry.errorCode || '', JSON.stringify(entry.request || entry.response || {}).slice(0, 500)); } }, now });
  const send = () => service.chat('owner', { requestId: id(), message: caseDef.message, conversationId, consent: true,
    ...(caseDef.mode ? { mode: caseDef.mode } : {}) });
  return { service, send, provider, repository, history, proposals, legacy, previewsById };
}

// ===== 通用断言 =====
function toolPayloadText(provider) {
  // 终稿轮之前的 messages 含 role:'tool' 内容（上一轮工具回执）。
  return provider.mock.calls.map(call => (call[1] || []).filter(message => message.role === 'tool')
    .map(message => message.content || '').join(' ')).join(' ');
}
function extractAmounts(text) {
  const cleaned = String(text).replace(/\d{4}-\d{2}-\d{2}|\d{4}年|\d{1,2}月|\d{1,2}日|\d{1,2}:\d{2}|\d{4}-\d{2}/g, ' ');
  return [...new Set(cleaned.match(/\d+\.\d{1,2}(?!\d)|\d{2,}(?!\d|\.)/g) || [])];
}
const hasCJK = text => /[\u4e00-\u9fff]/.test(text);
const toolNames = result => (result.toolTrace || []).map(entry => entry.tool);

function assertCase(caseDef, result, fixture, expect, caseLabel) {
  const answer = String(result.answer || '');
  const expectDef = caseDef.expect || {};
  // offline 档按 PLAN §5.2 断言「路由与证据门逻辑」：证据门可把 scripted 答案替换为
  // claims-safe 组合答案（这本身就是门逻辑在起作用），故答案措辞断言仅在 scripted
  // 答案存活时严格生效；grounding（数字必须有回执）/禁止项/语言/工具序列始终严格。
  const scriptedSurvived = answer === (caseDef.draft ? caseDef.draft.answer : caseDef.final?.answer);
  if (expectDef.tools) expect(toolNames(result)).toEqual(expectDef.tools);
  if (scriptedSurvived) for (const needle of expectDef.answerContains || []) expect(answer).toContain(needle);
  for (const needle of expectDef.answerNotContains || []) expect(answer).not.toContain(needle);
  if (expectDef.providerCalls !== undefined) expect(result.request.providerCalls).toBe(expectDef.providerCalls);
  if (expectDef.language === 'en') expect(hasCJK(answer)).toBe(false);
  if (expectDef.language === 'zh') expect(hasCJK(answer)).toBe(true);
  if (expectDef.groundedNumbers || !scriptedSurvived) {
    const haystack = toolPayloadText(fixture.provider) + ' ' + (expectDef.allowedNumbers || []).join(' ');
    for (const amount of extractAmounts(answer)) expect(haystack).toContain(amount);
  }
  if (expectDef.proposalAmount) {
    const fields = result.draft?.fields || result.draft || result.proposal?.fields || {};
    expect(String(fields.amount)).toBe(expectDef.proposalAmount);
  }
  if (expectDef.noDataPrefetch) expect(fixture.repository.query).not.toHaveBeenCalled();
}

module.exports = { createEvalFixture, assertCase, extractAmounts, hasCJK, toolNames, DATASETS, CHOICES, now };
