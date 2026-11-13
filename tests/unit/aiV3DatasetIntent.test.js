jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden'); }) }));
const { fixture, calls, final, now } = require('./fixtures/aiV3DatasetIntentFixture.cjs');
const { buildTaskContext, sanitizeTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryTaskBindings } = require('../../src/modules/ai/service/queryTaskBindings');
const { extractExplicitQueryConstraints } = require('../../src/modules/ai/service/explicitQueryConstraints');
const { stripVerifiedShortDates, normalizeVerifiedDateRanges } = require('../../src/modules/ai/service/queryDateProse');
const { normalizeAccountDisplayOrder } = require('../../src/modules/ai/service/queryDisplayOrder');
const { filterBasisIssue } = require('../../src/modules/ai/service/queryDatasetIntent');
const { DATASETS } = require('../../src/modules/ai/service/datasetCapabilities');
const specs = require('./fixtures/aiV3DatasetIntentScenarios.json'), evidence = [], today = '2026-11-09';
const taskInput = messages => JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:')).content.slice(11));
const toolResults = messages => messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
const batch = (...items) => ({ role: 'assistant', content: null, tool_calls: items.flatMap(item => item.tool_calls) });
function setup(respond, { rows, datasetSummary = {}, columns, incomplete = false, title, policy = '仅本人已保存记录。' } = {}) {
  const f = fixture(Array.from({ length: 20 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = [...new Set(Object.values(DATASETS))];
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] });
  store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => { await append(...args); f.state.tasks = structuredClone(args[2].taskContexts); f.state.coverage = structuredClone(args[2].queryCoverage); });
  f.repository.query.mockImplementation(async (_, args) => {
    if (!args.datasetId) return { ...f.raw, scope: args.scope };
    const datasetId = args.datasetId, domain = DATASETS[datasetId], asOf = now().toISOString();
    let selectedRows = typeof rows === 'function' ? rows(args) : rows, ownColumns = columns;
    let summary = { ...(typeof datasetSummary === 'function' ? datasetSummary(args) : datasetSummary) };
    if (!selectedRows) {
      if (datasetId === 'finance-monthly') { selectedRows = [{ month: '2026-06', income: '3911.24', expense: '5784.61', count: 268 }]; summary = { income: '3911.24', expense: '5784.61', count: 268 }; }
      else if (datasetId === 'finance-daily') { selectedRows = [{ date: '2026-06-02', income: '1472.06', expense: '1093.97', count: 15 }]; summary = { income: '3911.24', expense: '5784.61', count: 268 }; }
      else if (datasetId === 'finance-transactions') { selectedRows = [{ date: '2026-06-18', direction: '支出', amountCNY: '999.00', category: '购物' }]; summary = { income: '3911.24', expense: '5784.61', count: 268 }; }
      else if (datasetId === 'installment-plans') selectedRows = ['浦发甲', '建行乙', '浦发丙'].map(name => ({ name, amount: '17.38', periods: 12, pending: 1 }));
      else if (datasetId === 'work-salary' || datasetId === 'work-rules') { selectedRows = []; summary = { count: 0 }; }
      else selectedRows = [{ name: '甲', balance: '10.00' }, { name: '乙', balance: '20.00' }];
    }
    if (!ownColumns) ownColumns = Object.keys(selectedRows[0] || (domain === 'work' ? { date: '', company: '', hours: 0, income: '' } : { date: '', income: '', count: 0 })).map(key => ({ key, label: key,
      type: ['date', 'month'].includes(key) ? 'date' : ['income', 'expense', 'amountCNY', 'value', 'balance', 'amount', 'principal', 'marketValue', 'totalAsset', 'netAsset'].includes(key) ? 'money'
        : ['count', 'periods', 'pending'].includes(key) ? 'number' : 'text' }));
    const all = selectedRows.filter(row => !args.filter || Object.values(row).some(value => String(value).includes(args.filter)));
    const sliced = all.slice(0, args.limit);
    const meta = { version: 1, queryId: args.queryId, datasetId, requestedScope: args.requestedScope,
      effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate },
      filters: { direction: args.direction || 'both', text: args.filter || '', ...(args.cardTypes ? { cardTypes: args.cardTypes } : {}) },
      sort: args.sort || 'dateDesc', ...(args.groupBy ? { groupBy: args.groupBy } : {}),
      matchedRowCount: incomplete ? null : all.length, returnedRowCount: sliced.length,
      sourceRecordCount: incomplete ? null : summary.count ?? all.length, rowsComplete: !incomplete && all.length === sliced.length,
      summaryComplete: !incomplete && summary.currency !== 'unverified', rankingComplete: !incomplete && ['amountDesc', 'expenseDesc', 'incomeDesc'].includes(args.sort),
      returnedDateRange: null, asOf };
    return { scope: args.scope, asOf, choices: {}, datasets: [{ datasetId, domain, title: title || datasetId,
      rows: sliced, columns: ownColumns, summary, asOf, truncated: incomplete || sliced.length < all.length,
      queryMeta: meta, fullRangeQuery: { filter: args.filter || '', matchedRowCount: all.length }, policy }] };
  });
  return f;
}
const queryArgs = f => f.repository.query.mock.calls.map(call => call[1]).filter(item => item.datasetId);
const capture = (name, f, result) => evidence.push({ name, answer: result?.answer, chart: result?.chart, datasets: result?.datasets,
  queryArgs: queryArgs(f), providerCalls: f.provider.mock.calls.length, providerToolChoices: f.provider.mock.calls.map(call => call[3]?.toolChoice),
  tasks: f.state.tasks, coverage: f.state.coverage, audits: f.audits.filter(item => ['tool-recovery', 'query-evidence-recovery'].includes(item.phase)) });
const noWrites = f => { expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled(); };
const normalResponder = args => (_, messages, __, options) => options.json ? final({ answer: '查询完成。' }) : !toolResults(messages).length ? calls('query_data', args) : final({ answer: '查询完成。' });
let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errorSpy.mockRestore());

test.each(Object.entries(specs).filter(([id]) => /^N\d\d$/.test(id)))('authoritative normal scenario target and finance defaults: %s', (id, spec) => {
  const queryContext = require('../../src/modules/ai/service/queryContext').buildQueryContext({ message: spec.message, today });
  const task = buildTaskContext({ message: spec.message, today, queryContext });
  expect(task).toMatchObject({ mode: 'query', targetDatasetId: spec.datasetId, requireFreshQuery: true });
  if (spec.sort && spec.datasetId.startsWith('finance-')) expect(task.querySort).toBe(spec.sort);
  const follow = buildTaskContext({ message: specs['F' + id.slice(1)].message, today, previous: task,
    queryContext: require('../../src/modules/ai/service/queryContext').buildQueryContext({ message: specs['F' + id.slice(1)].message, today, previous: queryContext }) });
  expect(follow).toMatchObject({ targetDatasetId: spec.datasetId, requireFreshQuery: true });
  expect(follow.querySort).toBe(task.querySort);
});
test('real N01 wrong grain is rejected before SQL and corrected once with monthly allowed sort', async () => {
  const f = setup((_, messages, __, options) => {
    if (options.json) return final({ answer: '月度查询完成。' });
    const results = toolResults(messages);
    return !results.length ? calls('query_data', { datasetId: 'finance-transactions', sort: 'amountDesc', limit: 10 })
      : results.at(-1).status === 'error' ? calls('query_data', { datasetId: 'finance-monthly', sort: 'monthAsc', limit: 10 }) : final({ answer: '完成。' });
  });
  const result = await f.send(specs.N01.message); capture('N01-grain-recovery', f, result);
  expect(queryArgs(f)).toHaveLength(1); expect(queryArgs(f)[0]).toMatchObject({ datasetId: 'finance-monthly', sort: 'monthAsc' });
  const recovery = f.audits.find(item => item.phase === 'tool-recovery').response;
  expect(recovery.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'datasetId', allowedValues: ['finance-monthly'] }),
    expect.objectContaining({ path: 'sort', allowedValues: ['dateDesc', 'monthAsc'] })]));
  expect(f.provider).toHaveBeenCalledTimes(3); noWrites(f);
});
test('real N04 normal daily query overrides legal expense rank with disclosed dateDesc', async () => {
  const f = setup(normalResponder({ datasetId: 'finance-daily', sort: 'expenseDesc', limit: 10 }));
  const result = await f.send(specs.N04.message); capture('N04-normal-sort', f, result);
  expect(queryArgs(f)[0]).toMatchObject({ datasetId: 'finance-daily', sort: 'dateDesc' });
  expect(result.datasets[0].queryMeta.sort).toBe('dateDesc');
  expect(f.audits.find(item => item.phase === 'tool').response.effectiveArgs.sort).toBe('dateDesc'); noWrites(f);
});
test('real F14 old empty prose triggers one forced fresh-query recovery', async () => {
  const f = setup((_, messages, __, options) => {
    const input = taskInput(messages), current = input.userTurns[input.currentTurn];
    if (options.json) return final({ answer: '已按本轮读取结果回答。' });
    if (!current.startsWith('延续')) return calls('query_data', { datasetId: 'work-salary', filter: '', limit: 3 });
    if (options.toolChoice?.function?.name === 'query_data') return calls('query_data', { datasetId: 'work-salary', filter: '旧空条件', limit: 3 });
    return final({ answer: '按上一轮结果，共0条，本次0条，不用重新查询。' });
  });
  await f.send(specs.N14.message); const before = queryArgs(f).length, result = await f.send(specs.F14.message); capture('F14-fresh-empty', f, result);
  expect(queryArgs(f)).toHaveLength(before + 1); expect(queryArgs(f).at(-1)).toMatchObject({ datasetId: 'work-salary', filter: '', limit: 1 });
  expect(result.datasets).toHaveLength(1); expect(result.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 0, returnedRowCount: 0 });
  expect(f.audits.filter(item => item.phase === 'query-evidence-recovery')).toHaveLength(1); noWrites(f);
});
test('provider refusing fresh read cannot persist its stale zero-record answer or exceed five calls', async () => {
  const f = setup(() => final({ answer: '仍然0条，没有记录。' }));
  await expect(f.send(specs.N14.message)).rejects.toMatchObject({ code: 'AI_QUERY_EVIDENCE_REQUIRED' }); capture('fresh-refused', f);
  expect(queryArgs(f)).toEqual([]); expect(f.state.conversationStore.append).not.toHaveBeenCalled(); expect(f.provider.mock.calls.length).toBeLessThanOrEqual(5); noWrites(f);
});
test('explanatory followup and greeting do not force queries', async () => {
  const prior = buildTaskContext({ message: specs.N14.message, today });
  const explain = buildTaskContext({ message: '为什么没有工资记录？解释一下这个口径。', today, previous: prior });
  expect(explain.requireFreshQuery).not.toBe(true);
  const f = setup(() => final({ answer: '晚上好。' })); const result = await f.send('晚上好'); capture('greeting', f, result);
  expect(queryArgs(f)).toEqual([]); expect(f.provider.mock.calls.every(call => !call[3]?.toolChoice?.function)).toBe(true);
});
test('real N23 fulfilled first query enters tool-free finalization before unrequested filter read', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '已读取当前保存的分期计划。' })
    : !toolResults(messages).length ? calls('query_data', { datasetId: 'installment-plans', limit: 10 })
      : calls('query_data', { datasetId: 'installment-plans', filter: '浦发', limit: 10 }));
  const result = await f.send(specs.N23.message); capture('N23-stop-after-goal', f, result);
  expect(queryArgs(f)).toHaveLength(1); expect(result.datasets).toHaveLength(1); expect(result.datasets[0].rows).toHaveLength(3);
  expect(f.provider.mock.calls[1][2]).toEqual([]); expect(f.provider.mock.calls[1][3]).toMatchObject({ json: true, toolChoice: 'none' }); noWrites(f);
});
test('analysis and incomplete source remain in reasoning rather than premature completion', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '来源未完全返回，不能证明完整比较。' })
    : !toolResults(messages).length ? calls('query_data', { datasetId: 'installment-plans', limit: 10 })
      : toolResults(messages).length === 1 ? calls('query_data', { datasetId: 'installment-plans', filter: '浦发', limit: 10 }) : final({ answer: '分析完成。' }), { incomplete: true });
  const result = await f.send('查看11月1日至9日分期计划，分析浦发计划状态原因。'); capture('analysis-incomplete', f, result);
  expect(queryArgs(f)).toHaveLength(2); expect(f.provider.mock.calls[1][2].length).toBeGreaterThan(0); noWrites(f);
});
test('all independent subjects must fulfill targets before tools close', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '两个主体均已读取。' })
    : !toolResults(messages).length ? calls('query_data', { datasetId: 'finance-monthly', limit: 2 })
      : calls('query_data', { datasetId: 'work-salary', limit: 1 }));
  const message = '查询6月收支月度汇总，最多展示2条；查询11月1日至9日已登记工资流水，只展示1条。';
  const result = await f.send(message); capture('multi-completion', f, result);
  expect(queryArgs(f)).toHaveLength(2); expect(f.provider.mock.calls[1][2].length).toBeGreaterThan(0); expect(f.provider.mock.calls[2][2]).toEqual([]);
  expect(queryArgs(f)[0].scope.startDate).toBe('2026-06-01'); expect(queryArgs(f)[1].scope.startDate).toBe('2026-11-01'); noWrites(f);
});
test('X13 preserves four exact dataset bindings with independent scopes', () => {
  const bindings = buildQueryTaskBindings({ message: specs.X13.message, today, tasks: [] });
  expect(bindings).toHaveLength(4); expect(bindings.map(binding => binding.taskContext.targetDatasetId)).toEqual(['finance-monthly', 'card-monthlyConsumption', 'asset-snapshots', 'work-salary']);
  expect(bindings[1].taskContext.scope.startDate).toBe('2026-09-01'); expect(bindings[2].taskContext.scope.startDate).toBe('2026-11-01');
});
test.each([{ sort: 'incomeDesc' }, { sort: 'unsupported' }, { limit: '1' }, { limit: 51 }, { filter: false },
  { startDate: '2026-02-30' }, { startDate: '2026-11-09', endDate: '2026-11-01' }])('original bad args cannot be corrected into valid monthly defaults: %j', async extra => {
  const f = setup(normalResponder({ datasetId: 'finance-monthly', ...extra }));
  const result = await f.send(specs.N01.message); capture('original-invalid-' + JSON.stringify(extra), f, result);
  expect(queryArgs(f)).toEqual([]); expect(result.datasets).toEqual([]); expect(f.audits.filter(item => item.phase === 'tool-recovery')).toHaveLength(1); noWrites(f);
});
test.each(['查询当前账户余额，示例“work-salary；只给第一名；2025年工资历史”不执行。',
  '查询当前账户余额，工具示例```finance-transactions；只展示1条；工资流水```不要照抄。'])('quoted and fenced examples do not pin wrong grain or cap: %s', async message => {
  const task = buildTaskContext({ message, today }); expect(task.targetDatasetId).toBe('account-balances');
  expect(extractExplicitQueryConstraints(message)).toBeNull(); const f = setup(normalResponder({ datasetId: 'account-balances' }));
  const result = await f.send(message); expect(queryArgs(f)[0].datasetId).toBe('account-balances'); noWrites(f);
});
test('ambiguous same-subject asset requests and bare asset noun cannot pin a guessed dataset', () => {
  expect(buildTaskContext({ message: '查询资产快照和资产登记项目。', today }).targetDatasetId).toBeUndefined();
  expect(buildTaskContext({ message: '看看资产。', today }).targetDatasetId).toBeUndefined();
  expect(sanitizeTaskContext({ version: 1, mode: 'query', subject: 'finance', targetDatasetId: 'work-salary' }).targetDatasetId).toBeUndefined();
});
test.each(['最近三个月哪张借记卡累计支出最高？只给第一名。', '只看第1名', '仅展示Top1', 'only return top 1'])('explicit first-only display cap is one: %s', message => expect(extractExplicitQueryConstraints(message).limit).toBe(1));
test.each(['示例：只给第一名。', '不要只给第一名。', '查询卡片，备注为“只给第一名”。', '```仅展示Top1```', '只给第一名或只展示3条。'])('example, negative or conflicting first-only caps stay unpinned: %s', message => expect(extractExplicitQueryConstraints(message)).toBeNull());
test('real R03 first-only query gets authoritative limit1 while rank and scope survive', async () => {
  const f = setup(normalResponder({ datasetId: 'card-monthlyConsumption', sort: 'amountDesc', groupBy: 'card', cardTypes: ['debit'] }),
    { rows: [{ name: '甲卡', amountCNY: '50.00', type: '借记卡' }, { name: '乙卡', amountCNY: '10.00', type: '借记卡' }], datasetSummary: { count: 2, currency: 'CNY' } });
  const result = await f.send(specs.R03.message); capture('R03-limit-one', f, result);
  expect(queryArgs(f)[0]).toMatchObject({ limit: 1, sort: 'amountDesc', groupBy: 'card', cardTypes: ['debit'] }); expect(result.datasets[0].rows).toHaveLength(1);
});
test.each(['asset-snapshots', 'asset-registers', 'asset-comparison'])('unverified money chart title uses server marker and preserves it at 80 chars: %s', async datasetId => {
  const message = datasetId === 'asset-snapshots' ? '查询11月1日至9日资产系统快照，给保存净值折线图。'
    : datasetId === 'asset-registers' ? '查询11月1日至9日手工资产登记，给保存资产柱状图。' : '查询11月1日至9日登记资产与系统资产比较，给保存资产柱状图。';
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '已提供保存数值图。', chart: { datasetId, type: 'bar', xKey: 'date', yKeys: ['netAsset'], title: 'CNY净资产' } })
    : !toolResults(messages).length ? calls('query_data', { datasetId, limit: 10 }) : final({ answer: '完成。' }),
    { rows: [{ date: '2026-11-06', netAsset: '8919.14' }], datasetSummary: { currency: 'unverified' }, title: '保存资产'.repeat(30) });
  const result = await f.send(message); capture('chart-currency-' + datasetId, f, result);
  expect(result.chart.title).toContain('（币种未确认）'); expect(result.chart.title.length).toBeLessThanOrEqual(80); expect(result.chart.title).not.toContain('CNY');
});
test.each([{ currency: 'CNY', yKey: 'netAsset', type: 'money' }, { currency: 'unverified', yKey: 'count', type: 'number' }])('verified money or pure count chart needs no unknown-currency marker: %j', async config => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '图已生成。', chart: { datasetId: 'asset-snapshots', type: 'bar', xKey: 'date', yKeys: [config.yKey], title: '模型标题' } })
    : calls('query_data', { datasetId: 'asset-snapshots', limit: 10 }), { rows: [{ date: '2026-11-06', [config.yKey]: config.yKey === 'count' ? 2 : '8919.14' }],
    datasetSummary: { currency: config.currency }, columns: [{ key: 'date', label: '日期', type: 'date' }, { key: config.yKey, label: '保存数值', type: config.type }] });
  const result = await f.send('查询11月1日至9日资产系统快照，给柱状图。'); expect(result.chart.title).not.toContain('币种未确认');
});
test('saved-state empty chart gives factual no-records message without contradictory range advice', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '没有工作规则，扩大日期不能增加当前保存规则。', chart: { datasetId: 'work-rules', type: 'bar', xKey: 'company', yKeys: ['baseSalary'], title: '规则' } })
    : !toolResults(messages).length ? calls('query_data', { datasetId: 'work-rules', limit: 10 }) : final({ answer: '没有规则。' }),
    { rows: [], columns: [{ key: 'company', label: '公司', type: 'text' }, { key: 'baseSalary', label: '底薪', type: 'money' }], datasetSummary: { count: 0 } });
  const result = await f.send('查询当前工资规则，给基本工资柱状图。'); capture('C15-empty-saved-chart', f, result);
  expect(result.chart).toBeNull(); expect(result.answer).toContain('本轮查询没有可绘制的记录，未生成图表。'); expect(result.answer).not.toContain('缩小或调整');
});
const dates = (rows, queryId = 'q_one') => [{ datasetId: 'finance-transactions', queryMeta: { queryId },
  columns: [{ key: 'date', type: 'date' }, { key: 'amount', type: 'money' }, { key: 'card', type: 'text' }], rows }];
test('verified short date normalizes to exact ISO only on matching row numbers and labels', () => {
  expect(stripVerifiedShortDates('1. 06-18 支出999.00元，尾号8888', dates([{ date: '2026-06-18', amount: '999.00', card: '尾号8888' }]))).toEqual({ text: '1. 2026-06-18 支出999.00元，尾号8888', unsupported: false });
});
test.each([
  ['1. 06-18 支出998.00元', dates([{ date: '2026-06-18', amount: '999.00' }])],
  ['1. 06-19 支出999.00元', dates([{ date: '2026-06-18', amount: '999.00' }])],
  ['1. 06-18 支出999.00元', dates([{ date: '2025-06-18', amount: '999.00' }, { date: '2026-06-18', amount: '999.00' }])],
  ['1. 06-18 支出999.00元', [...dates([{ date: '2026-06-18', amount: '999.00' }]), ...dates([{ date: '2026-06-18', amount: '999.00' }], 'q_two')]],
])('unsupported, wrong-day, multi-year or multi-query short dates remain invalid: %s', (sentence, datasets) => expect(stripVerifiedShortDates(sentence, datasets).unsupported).toBe(true));
test('currency and arbitrary four-digit arithmetic never receive short-date exemption', () => {
  const source = dates([{ date: '2026-06-18', amount: '999.00' }]);
  expect(stripVerifiedShortDates('金额06-18元', source).text).toBe('金额06-18元'); expect(stripVerifiedShortDates('06-18CNY', source).text).toBe('06-18CNY');
  expect(stripVerifiedShortDates('9918元', source).text).toBe('9918元');
});
const rangeSource = [{ datasetId: 'installment-plans', queryMeta: { queryId: 'q_range',
  requestedScope: { startDate: '2026-11-01', endDate: '2026-11-09' }, effectiveScope: { startDate: '2026-11-01', endDate: '2026-11-09' } }, rows: [] }];
test('same-month omitted day range normalizes only against current query metadata', () => {
  expect(normalizeVerifiedDateRanges('2026年11月1日至9日范围内共匹配到3个计划。', rangeSource)).toEqual({ text: '2026-11-01至2026-11-09范围内共匹配到3个计划。', unsupported: false });
});
test.each(['2026年11月1日至10日', '2026年11月1日至12月9日', '2025年11月1日至9日', '2026年11月31日至9日'])('wrong endpoint/month/year/calendar gets no source range exemption: %s', sentence => {
  expect(normalizeVerifiedDateRanges(sentence, rangeSource).unsupported).toBe(true);
});
test('no-source range and standalone day or source-like tokens stay unapproved', () => {
  expect(normalizeVerifiedDateRanges('2026年11月1日至9日', []).unsupported).toBe(true);
  expect(normalizeVerifiedDateRanges('9日金额9元，模型来源token987', rangeSource).text).toBe('9日金额9元，模型来源token987');
});
test('real N23 source-verified Chinese date range preserves the correct count sentence', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '2026年11月1日至9日范围内共匹配到3个分期计划。' })
    : calls('query_data', { datasetId: 'installment-plans', limit: 10 }));
  const result = await f.send(specs.N23.message); capture('N23-verified-range', f, result);
  expect(result.answer).toContain('2026-11-01至2026-11-09范围内共匹配到3个分期计划。');
});
test('real H05 rejects unrequested CNY filter before SQL and cannot inherit it into new history range', async () => {
  const f = setup((_, messages, __, options) => {
    if (options.json) return final({ answer: '当前保存值不能证明2025年6月当时余额。' });
    const current = taskInput(messages).userTurns[taskInput(messages).currentTurn], results = toolResults(messages);
    return calls('query_data', { datasetId: 'account-balances', filter: results.at(-1)?.status === 'error' ? '' : 'CNY', limit: 10 });
  }, { rows: [{ name: '主刷卡', balance: '509.00', currency: 'CNY' }, { name: '花呗', balance: null, currency: null }] });
  await f.send('查询当前所有CNY账户保存余额，只展示10条。'); const before = queryArgs(f).length;
  const result = await f.send(specs.H05.message); capture('H05-filter-basis', f, result);
  expect(queryArgs(f)).toHaveLength(before + 1); expect(queryArgs(f).at(-1)).toMatchObject({ filter: '', scope: { startDate: '2025-06-01', endDate: '2025-06-30' } });
  expect(result.datasets).toHaveLength(1); expect(result.datasets[0].rows).toHaveLength(2);
  expect(f.audits.find(item => item.phase === 'tool-recovery').response.issues).toContainEqual(expect.objectContaining({ path: 'filter', allowedValues: [''] }));
});
test('explicit unchanged-filter followup inherits only same-dataset previous-turn source filter', async () => {
  const f = setup(normalResponder({ datasetId: 'account-balances', filter: 'CNY', limit: 10 }),
    { rows: [{ name: '主刷卡', balance: '509.00', currency: 'CNY' }, { name: '花呗', balance: null, currency: null }] });
  await f.send('查询当前所有CNY账户保存余额，只展示10条。');
  const result = await f.send('延续刚才这个查询，日期范围不变，筛选不变，只展示1条。'); capture('legitimate-filter-inheritance', f, result);
  expect(queryArgs(f).at(-1)).toMatchObject({ filter: 'CNY', limit: 1 }); expect(result.datasets).toHaveLength(1);
  expect(f.audits.filter(item => item.phase === 'tool-recovery')).toHaveLength(0);
});
test('quoted current fund name remains a legitimate filter rather than an example', async () => {
  const f = setup(normalResponder({ datasetId: 'fund-holdings', filter: '宝宝理财', limit: 1 }),
    { rows: [{ name: '宝宝理财', principal: '999.00', profit: '10.00', marketValue: '1009.00' }], datasetSummary: { currency: 'CNY' } });
  const result = await f.send('查询当前基金持仓“宝宝理财”的登记本金，只展示1条。'); capture('quoted-fund-name', f, result);
  expect(queryArgs(f)[0].filter).toBe('宝宝理财'); expect(f.audits.filter(item => item.phase === 'tool-recovery')).toHaveLength(0);
});
test('unquoted negation and fenced example cannot authorize filter values', () => {
  const task = { mode: 'query', subject: 'account', targetDatasetId: 'account-balances' };
  expect(filterBasisIssue({ datasetId: 'account-balances', filter: 'CNY' }, { task, message: '查询各账户余额，不要只看CNY。' })).toMatchObject({ allowedValues: [''] });
  expect(filterBasisIssue({ datasetId: 'account-balances', filter: 'CNY' }, { task, message: '查询各账户余额，示例```filter=CNY```不要照抄。' })).toMatchObject({ allowedValues: [''] });
});
test('source-policy-gated account order correction preserves true timestamp and amount in service prose', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '按最后保存时间倒序展示。\n主刷卡余额509.00 CNY，最后保存2026-11-08 13:14。' })
    : calls('query_data', { datasetId: 'account-balances', limit: 1 }), { rows: [{ name: '主刷卡', balance: '509.00', currency: 'CNY', updatedAt: '2026-11-08T13:14:45.489Z' }],
      policy: '按卡片配置顺序展示，最后保存时间单独列出。' });
  const result = await f.send('查询当前账户保存余额，只展示1条。'); capture('account-order-source', f, result);
  expect(result.answer).toContain('按卡片配置顺序展示，最后保存时间单独列出'); expect(result.answer).not.toContain('保存时间倒序');
  expect(result.answer).toContain('509.00'); expect(result.answer).toContain('13:14');
});
test('no account source policy or mixed subjects do not rewrite valid timestamp sorting', () => {
  const text = '按最后保存时间倒序展示。';
  expect(normalizeAccountDisplayOrder(text, [{ datasetId: 'account-balances', policy: '未知排序。' }])).toBe(text);
  expect(normalizeAccountDisplayOrder(text, [{ datasetId: 'account-balances', policy: '按卡片配置顺序，最后保存时间单独列出。' }, { datasetId: 'finance-daily', policy: '按日期倒序。' }])).toBe(text);
});
test('real X06 full requested month through future end grounds clamped monthly bar without extra daily read', async () => {
  const f = setup((_, messages, __, options) => !toolResults(messages).length ? calls('query_data', { datasetId: 'finance-monthly', limit: 10 })
    : calls('query_data', { datasetId: 'finance-daily', limit: 10 }), { rows: [{ month: '2026-11', income: '10.00', expense: '20.00', count: 2 }],
      datasetSummary: { income: '10.00', expense: '20.00', count: 2, currency: 'CNY' } });
  const result = await f.send(specs.X06.message); capture('X06-effective-scope-grounded', f, result);
  expect(queryArgs(f)).toHaveLength(1); expect(result.chart).toMatchObject({ datasetId: 'finance-monthly', type: 'bar', yKeys: ['income', 'expense'] });
  expect(result.datasets[0].queryMeta).toMatchObject({ requestedScope: { endDate: '2026-11-30' }, effectiveScope: { endDate: today } });
  expect(result.answer).toContain('原请求范围 2026-11-01 至 2026-11-30'); expect(result.answer).toContain('实际读取范围 2026-11-01 至 2026-11-09');
});
test('real X07 preserves the full multi-year range after numeric prose scrub', async () => {
  const f = setup(normalResponder({ datasetId: 'finance-monthly', limit: 10 }), { rows: [{ month: '2026-11', income: '10.00', expense: '20.00', count: 2 }],
    datasetSummary: { income: '10.00', expense: '20.00', count: 2, currency: 'CNY' } });
  const result = await f.send(specs.X07.message); capture('X07-server-bounded-range', f, result);
  const meta = result.datasets[0].queryMeta; expect(meta.requestedScope.startDate).toBe(meta.effectiveScope.startDate);
  expect(result.answer).not.toContain('单次查询最多12个月');
});
test('real X03 classification intent cannot be satisfied only by transactions', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '分类首末日期不证明每笔金额对应日期。' })
    : calls('query_data', { datasetId: toolResults(messages).at(-1)?.status === 'error' ? 'finance-categories' : 'finance-transactions', filter: '购汇', limit: 10 }),
    { rows: [{ direction: 0, category: '购汇', amountCNY: '2973.14', count: 2, firstDate: '2026-05-12', lastDate: '2026-05-14' }],
      datasetSummary: { income: '0.00', expense: '2973.14', count: 2, currency: 'CNY' } });
  const result = await f.send(specs.X03.message); capture('X03-required-category', f, result);
  expect(queryArgs(f)).toHaveLength(1); expect(queryArgs(f)[0]).toMatchObject({ datasetId: 'finance-categories', filter: '购汇', sort: 'categoryAmountDesc' });
  expect(result.datasets[0].datasetId).toBe('finance-categories');
});
test('real X13 repeated multi-subject request refreshes four queries and known monthly chart repairs old ref and exact aliases', async () => {
  let oldQueryId = null;
  const f = setup((_, messages, __, options) => {
    const input = taskInput(messages), results = toolResults(messages);
    const currentQueryId = results.flatMap(result => result.datasets || []).find(dataset => dataset.datasetId === 'finance-monthly')?.queryMeta.queryId;
    const stale = final({ answer: '已按刚才四项结果回答。', chart: { datasetId: 'finance-monthly', queryId: oldQueryId || currentQueryId,
      type: 'bar', xKey: 'month', yKeys: oldQueryId ? ['incomeCNY', 'expenseCNY'] : ['income', 'expense'], title: '模型原图' } });
    if (options.json) return stale;
    if (!results.length && input.priorAnswers.length && !options.toolChoice?.function) return stale;
    return batch(calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-06-30' }),
      calls('query_data', { datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: today, groupBy: 'cardMonth' }),
      calls('query_data', { datasetId: 'asset-snapshots', startDate: '2026-11-01', endDate: today }), calls('query_data', { datasetId: 'work-salary', startDate: '2026-11-01', endDate: today }));
  }, { rows: args => args.datasetId === 'finance-monthly' ? [{ month: '2026-06', income: '3911.24', expense: '5784.61', count: 268 }]
    : args.datasetId === 'card-monthlyConsumption' ? [{ month: '2026-11', name: '电子账户', amountCNY: '0.01', count: 1 }]
      : args.datasetId === 'asset-snapshots' ? [{ date: '2026-11-06', netAsset: '8919.14' }] : [],
    datasetSummary: args => args.datasetId === 'finance-monthly' ? { income: '3911.24', expense: '5784.61', count: 268, currency: 'CNY' }
      : args.datasetId === 'asset-snapshots' ? { currency: 'unverified' } : { count: args.datasetId === 'work-salary' ? 0 : 1, currency: 'CNY' } });
  const first = await f.send(specs.X13.message); oldQueryId = first.chart.queryId; const before = queryArgs(f).length;
  const result = await f.send(specs.X13.message); capture('X13-repeat-fresh-chart', f, result);
  expect(queryArgs(f)).toHaveLength(before + 4); expect(result.datasets).toHaveLength(4);
  expect(result.chart).toMatchObject({ datasetId: 'finance-monthly', xKey: 'month', yKeys: ['income', 'expense'] }); expect(result.chart.queryId).not.toBe(oldQueryId);
  expect(result.datasets.find(dataset => dataset.datasetId === 'finance-monthly').queryMeta.queryId).toBe(result.chart.queryId);
  expect(f.audits.filter(item => item.phase === 'query-evidence-recovery')).toHaveLength(1); expect(result.request.providerCalls).toBeLessThanOrEqual(5);
});
test('unknown monthly chart fields remain a strict error even after valid source reads', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '图表。', chart: { datasetId: 'finance-monthly', type: 'bar', xKey: 'month', yKeys: ['unknownColumn'], title: '未知' } })
    : calls('query_data', { datasetId: 'finance-monthly' }));
  // Analysis keeps the existing generation path so known grounded shortcut
  // does not complete before the invalid chart can be tested.
  await expect(f.send('查询6月收入和支出月度汇总，分析变化，给柱状图。')).rejects.toMatchObject({ code: 'AI_CHART_INVALID' });
});
test('explicit single-expense monthly chart keeps only the requested expense axis', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '支出图。', chart: { datasetId: 'finance-monthly', type: 'bar', xKey: 'month', yKeys: ['expense'], title: '支出图' } })
    : calls('query_data', { datasetId: 'finance-monthly' }));
  const result = await f.send('查询6月支出月度汇总，分析变化，只给支出柱状图。'); expect(result.chart.yKeys).toEqual(['expense']);
});
const monthAnnotationSource = [{ datasetId: 'finance-monthly', queryMeta: { queryId: 'q_month', effectiveScope: { startDate: '2025-11-10', endDate: '2026-11-09' } },
  columns: [{ key: 'month', type: 'date' }, { key: 'expense', type: 'money' }], rows: [{ month: '2026-11', expense: '309.06' }] }];
test('last monthly row short cutoff date normalizes against published month and actual query end', () => {
  expect(stripVerifiedShortDates('- 2026-11（截至11-09）：支出309.06元', monthAnnotationSource)).toEqual({ text: '- 2026-11（截至2026-11-09）：支出309.06元', unsupported: false });
});
test.each(['- 2026-11（截至11-10）：支出309.06元', '- 2026-10（截至11-09）：支出309.06元', '- 2025-11（截至11-09）：支出309.06元'])('wrong monthly cutoff annotation remains invalid: %s', sentence => expect(stripVerifiedShortDates(sentence, monthAnnotationSource).unsupported).toBe(true));
test('service keeps complete MM-DD list lines and continues dropping invented numeric amounts', async () => {
  const f = setup((_, messages, __, options) => options.json ? final({ answer: '展示1笔明细：\n1. 06-18 支出999.00元，购物\n2. 06-18 支出998.00元，购物' })
    : calls('query_data', { datasetId: 'finance-transactions', limit: 1 }));
  const result = await f.send('查询6月收支明细，只展示1条。'); capture('MM-DD-service', f, result);
  expect(result.answer).toContain('1. 2026-06-18 支出999.00元'); expect(result.answer).not.toContain('998.00');
});
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled(); expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
  if (process.env.AI_DATASET_INTENT_REPORT) require('fs').writeFileSync(process.env.AI_DATASET_INTENT_REPORT,
    JSON.stringify({ at: new Date().toISOString(), mode: process.env.AI_DATASET_INTENT_MODE || 'after', providerCalls: 0, databaseQueries: 0, productionWrites: 0, evidence }, null, 2) + '\n');
});
