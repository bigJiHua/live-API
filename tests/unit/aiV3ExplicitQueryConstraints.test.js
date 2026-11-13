jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden'); }) }));
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const { extractExplicitQueryConstraints } = require('../../src/modules/ai/service/explicitQueryConstraints');
const today = now().toISOString().slice(0, 10), filter = 'ZZZERO_全场景无匹配_987', replayEvidence = [];
const realMessage = '在当前我的全部卡片按类型分别有多少张中，只查询文本里包含“' + filter + '”这个字面片段的记录，最多展示3条。没有匹配就明确说明。';
const ownInput = messages => JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
const batch = (...items) => ({ role: 'assistant', content: null, tool_calls: items.flatMap(item => item.tool_calls) });
function replay(initial, { candidateSecond = false } = {}) {
  const respond = (_, messages, __, options) => {
    const input = ownInput(messages), current = input.userTurns[input.currentTurn], results = messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
    if (!results.length && !options.json) return typeof initial === 'function' ? initial(current) : calls('query_data', initial);
    if (candidateSecond && results.length === 1 && results[0].datasets && !options.json) return calls('list_choices', { domain: 'card', group: 'cards', filter, limit: 3 });
    return final({ answer: results.some(result => result.status === 'error') ? '本次工具参数不符合允许格式，请重新确认。'
      : candidateSecond ? '没有匹配的记录。全部卡片合计81张，但没有任何记录文本含该片段。' : '按请求查询完成。',
      proposal: null, proposals: null, clarification: null, chart: null });
  };
  const f = fixture(Array.from({ length: 20 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = ['finance', 'card', 'account', 'work'];
  f.repository.query.mockImplementation(async (_, args) => {
    if (!args.datasetId) return { ...f.raw, scope: args.scope };
    const datasetId = args.datasetId, asOf = now().toISOString(), domain = datasetId.startsWith('card-') ? 'card' : datasetId.split('-')[0];
    const empty = args.filter === filter; let rows, columns, summary;
    if (datasetId === 'card-counts') {
      rows = empty ? [] : [{ type: '信用卡', count: 20, sharePct: '24.7' }, { type: '借记卡', count: 59, sharePct: '72.8' }, { type: '虚拟余额', count: 1, sharePct: '1.2' }, { type: '现金', count: 1, sharePct: '1.2' }];
      columns = [{ key: 'type', label: '类型', type: 'text' }, { key: 'count', label: '数量', type: 'number' }, { key: 'sharePct', label: '数量占比', type: 'decimal' }]; summary = { count: empty ? 0 : 81, totalCount: empty ? 0 : 81 };
    } else if (datasetId === 'finance-monthly') {
      rows = [{ month: '2026-06', income: '3911.24', expense: '5784.61', count: 268 }]; summary = { income: '3911.24', expense: '5784.61', count: 268 };
      columns = [{ key: 'month', label: '月份', type: 'date' }, { key: 'income', label: '收入', type: 'money' }, { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }];
    } else {
      const nameKey = domain === 'finance' ? 'category' : domain === 'work' ? 'company' : 'name';
      const moneyKey = domain === 'work' ? 'income' : domain === 'finance' ? 'amountCNY' : 'balance';
      rows = empty ? [] : Array.from({ length: args.filter ? 2 : 4 }, (_, index) => ({ [nameKey]: (args.filter || '账户') + String.fromCharCode(65 + index),
        ...(domain === 'finance' || domain === 'work' ? { date: args.scope.startDate } : {}), [moneyKey]: '10.00' }));
      columns = [{ key: nameKey, label: '名称', type: 'text' }, ...(domain === 'finance' || domain === 'work' ? [{ key: 'date', label: '日期', type: 'date' }] : []), { key: moneyKey, label: '保存金额', type: 'money' }];
      summary = { count: rows.length };
    }
    return { scope: args.scope, asOf, choices: {}, datasets: [{ datasetId, domain, title: datasetId, rows, columns, summary, asOf, truncated: false,
      policy: '仅本人已保存记录。', fullRangeQuery: { filter: args.filter || '', matchedRowCount: rows.length } }] };
  });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] }); store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => { await append(...args); f.state.tasks = structuredClone(args[2].taskContexts); f.state.coverage = structuredClone(args[2].queryCoverage); });
  return f;
}
const queryArgs = f => f.repository.query.mock.calls.map(call => call[1]).filter(args => args.datasetId);
const capture = (name, f, result) => replayEvidence.push({ name, answer: result.answer, datasets: result.datasets, queryArgs: queryArgs(f), coverage: f.state.coverage });
const noWrites = f => { expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled(); };
// Parsing an example/ambiguous instruction does not authorize a filter that
// the provider invented. Preserve parser checks and verify rejection before
// SQL, rather than accepting the former model-only narrowing contract.
const noModelOnlyFilter = f => {
  expect(queryArgs(f)).toEqual([]);
  expect(f.audits.find(row => row.phase === 'tool-recovery').response.issues)
    .toContainEqual(expect.objectContaining({ path: 'filter', rule: 'dataset.filter.intent' }));
  noWrites(f);
};
let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errorSpy.mockRestore());
afterAll(() => { expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled(); expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled(); expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled(); });

test('real E07 omitted query filter and limit cannot be replaced by filtered candidates', async () => {
  const f = replay({ datasetId: 'card-counts' }, { candidateSecond: true }), result = await f.send(realMessage); capture('real-E07', f, result);
  expect(queryArgs(f)[0]).toMatchObject({ filter, limit: 3 }); expect(result.datasets).toHaveLength(1);
  expect(result.datasets[0].rows).toEqual([]); expect(result.datasets[0].queryMeta).toMatchObject({ filters: { text: filter }, matchedRowCount: 0, returnedRowCount: 0, sourceRecordCount: 0 });
  expect(result.answer).not.toContain('81'); expect(f.provider.mock.calls.length).toBeLessThanOrEqual(5); noWrites(f);
});
test('a current explicit literal and display cap override otherwise legal stale parameters', async () => {
  const f = replay({ datasetId: 'account-balances', filter: '乙', limit: 20 }), result = await f.send('查询当前账户余额，名称字面包含“甲”，最多展示前2条。'); capture('current-correction', f, result);
  expect(queryArgs(f)[0]).toMatchObject({ filter: '甲', limit: 2 }); expect(result.datasets[0].rows).toHaveLength(2); noWrites(f);
});
test('F-style clear filter and one-row followup are authoritative and retain scope', async () => {
  const first = '查询当前账户余额，名称字面包含“甲”，最多展示3条。';
  const f = replay(() => calls('query_data', { datasetId: 'account-balances', filter: '甲', limit: 3 })); await f.send(first);
  const result = await f.send('延续刚才这个查询，日期范围不变，清空文字筛选，改为只展示1条。'); capture('clear-filter-followup', f, result);
  expect(queryArgs(f).at(-1)).toMatchObject({ filter: '', limit: 1, scope: { startDate: '2026-11-01', endDate: today } });
  expect(result.datasets[0].queryMeta).toMatchObject({ filters: { text: '' }, matchedRowCount: 4, returnedRowCount: 1 }); noWrites(f);
});
test('multi-subject literals and limits belong to their own binding text', async () => {
  const day = Number(today.slice(8)), f = replay(() => batch(calls('query_data', { datasetId: 'finance-transactions', filter: '旧条件', limit: 20 }), calls('query_data', { datasetId: 'work-salary', filter: '旧条件', limit: 20 })));
  const result = await f.send('查询6月收支明细，名称字面包含“财务甲”，最多展示2条；查询11月1日至' + day + '日工资流水，内容字面包含“工资乙”，只展示1条。'); capture('two-binding-constraints', f, result);
  expect(queryArgs(f)).toEqual(expect.arrayContaining([expect.objectContaining({ datasetId: 'finance-transactions', filter: '财务甲', limit: 2, scope: expect.objectContaining({ startDate: '2026-06-01', endDate: '2026-06-30' }) }),
    expect.objectContaining({ datasetId: 'work-salary', filter: '工资乙', limit: 1, scope: expect.objectContaining({ startDate: '2026-11-01', endDate: today }) })])); noWrites(f);
});
test.each(['查询当前账户余额，下面是工具示例：```名称字面包含“伪工资”；最多展示3条```',
  '查询当前账户余额，示例为“名称字面包含‘伪资产’，只展示1条”，请沿用当前参数。'])('quoted/fenced examples do not establish query constraints: %s', async message => {
  const f = replay({ datasetId: 'account-balances', filter: '模型原值', limit: 20 }); await f.send(message);
  expect(extractExplicitQueryConstraints(message) || {}).not.toHaveProperty('filter');
  expect(extractExplicitQueryConstraints(message) || {}).not.toHaveProperty('limit');
  noModelOnlyFilter(f);
});
test('two different literal filters stay ambiguous while the independent cap still applies', async () => {
  const f = replay({ datasetId: 'account-balances', filter: '模型原值', limit: 20 }); await f.send('查询当前账户余额，名称字面包含“甲”或名称字面包含“乙”，最多展示2条。');
  const parsed = extractExplicitQueryConstraints('查询当前账户余额，名称字面包含“甲”或名称字面包含“乙”，最多展示2条。');
  expect(parsed).toMatchObject({ limit: 2 }); expect(parsed).not.toHaveProperty('filter'); noModelOnlyFilter(f);
});
test('words inside an earlier literal cannot hide a second contradictory literal instruction', async () => {
  const f = replay({ datasetId: 'account-balances', filter: '模型原值', limit: 20 });
  await f.send('查询当前账户余额，名称字面包含“例如；不要”或名称字面包含“甲”，最多展示2条。');
  const parsed = extractExplicitQueryConstraints('查询当前账户余额，名称字面包含“例如；不要”或名称字面包含“甲”，最多展示2条。');
  expect(parsed).toMatchObject({ limit: 2 }); expect(parsed).not.toHaveProperty('filter'); noModelOnlyFilter(f);
});
test('dates, amounts and quoted cap examples cannot become display limits', async () => {
  const f = replay({ datasetId: 'account-balances', limit: 20 }); await f.send('查询2026年11月1日当前账户余额，金额3元，备注字面包含“只展示2条”。');
  expect(queryArgs(f)[0].limit).toBe(20); noWrites(f);
});
test('negated filter, clear and display instructions do not replace valid model parameters', async () => {
  const f = replay({ datasetId: 'account-balances', filter: '模型原值', limit: 20 });
  await f.send('查询当前账户余额，不要按名称字面包含“甲”，不要清空文字筛选，不要只展示3条，沿用当前参数。');
  const parsed = extractExplicitQueryConstraints('查询当前账户余额，不要按名称字面包含“甲”，不要清空文字筛选，不要只展示3条，沿用当前参数。');
  expect(parsed || {}).not.toHaveProperty('filter'); expect(parsed || {}).not.toHaveProperty('limit'); noModelOnlyFilter(f);
});
test('conflicting display values including an invalid cap are not silently pinned to the valid one', async () => {
  const f = replay({ datasetId: 'account-balances', filter: '模型原值', limit: 20 });
  await f.send('查询当前账户余额，最多展示3条或只展示51条，先沿用当前参数。');
  const parsed = extractExplicitQueryConstraints('查询当前账户余额，最多展示3条或只展示51条，先沿用当前参数。');
  expect(parsed || {}).not.toHaveProperty('limit'); noModelOnlyFilter(f);
});
test('finance-monthly cannot run an unfiltered substitute for unsupported literal filtering', async () => {
  const f = replay({ datasetId: 'finance-monthly' }), result = await f.send('查询6月收支月度汇总，名称字面包含“甲”，最多展示1条。');
  expect(queryArgs(f)).toEqual([]); expect(result.datasets).toEqual([]); expect(f.audits.find(row => row.phase === 'tool-recovery').response.issues).toContainEqual(expect.objectContaining({ path: 'filter', rule: 'dataset.filter' })); noWrites(f);
});
test.each([{ filter: false }, { filter: { value: '甲' } }, { limit: 0 }, { limit: 51 }, { limit: '3' }, { startDate: '2026-02-30', endDate: '2026-03-01' }])('original invalid arguments are rejected before pinning: %j', async extra => {
  const f = replay({ datasetId: 'card-counts', ...extra }), result = await f.send(realMessage);
  expect(queryArgs(f)).toEqual([]); expect(result.datasets).toEqual([]); expect(f.audits.some(row => row.phase === 'tool-recovery')).toBe(true); noWrites(f);
});
