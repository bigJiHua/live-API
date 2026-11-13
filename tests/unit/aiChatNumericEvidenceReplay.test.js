jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('axios', () => ({ post: jest.fn(() => { throw new Error('Paid endpoint forbidden'); }) }));
const { fixture, calls, id } = require('../fixtures/aiV3MemoryFixture');
const { DATASETS, createEvalFixture } = require('../eval/offlineHarness');
const { createWebSearchTools } = require('../../src/modules/ai/service/webSearchTools');
const publicDb = require('../../src/common/config/db');
const prose = answer => ({ role: 'assistant', content: answer });
const memoryStore = () => ({ list: jest.fn(async () => ({ files: [], warnings: [], totalBytes: 0 })) });

function replay(script, datasetIds = [], mode = 'chat') {
  const f = fixture(script, { memoryStore: memoryStore() });
  f.raw.datasets = datasetIds.map(name => structuredClone(DATASETS[name]));
  f.state.businessPolicy.domains = ['finance', 'account', 'card', 'todo', 'asset', 'fund', 'budget', 'work', 'installment'];
  const send = (message = '请看看已保存的资产情况') => f.service.chat('offline-memory-owner', {
    requestId: id(), conversationId: f.conversationId, message, consent: true, mode,
  });
  return { ...f, send };
}
const assetRead = () => calls('query_data', { datasetId: 'asset-composition' });
const fundRead = () => calls('query_data', { datasetId: 'fund-holdings' });
const calcBatch = count => ({ role: 'assistant', content: null, tool_calls: Array.from({ length: count }, (_, index) =>
  calls('calculate', { expression: `52000+${index}`, mode: 'money' }).tool_calls[0]) });
const amount = (text, value) => new RegExp(value.replace(/\./g, '\\.')).test(String(text).replace(/,/g, ''));
const persistedAnswers = f => f.state.conversationStore.append.mock.calls.map(call => call[2].answer);

afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled();
  expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(require('axios').post).not.toHaveBeenCalled();
});

test.each(['chat', 'analysis'])('mode %s never publishes or persists the captured unsupported net-asset total', async mode => {
  const captured = '目前保存的资产需要综合看。\n\n净资产约 71,370 元，正资产合计 79,870 元。\n\n借记卡保存余额 52,000 元，微信零钱 320 元。';
  const f = replay([assetRead(), fundRead(), prose(captured)], ['asset-composition', 'fund-holdings'], mode);
  const result = await f.send();
  expect(amount(result.answer, '71370')).toBe(false);
  expect(amount(result.answer, '79870')).toBe(false);
  expect(result.answer).toContain('需要综合看');
  expect(amount(result.answer, '52000')).toBe(true);
  expect(amount(result.answer, '320')).toBe(true);
  expect(f.provider.mock.calls.length).toBeLessThanOrEqual(4);
  expect(persistedAnswers(f)).toEqual([result.answer]);
  expect(f.history.filter(turn => turn.role === 'assistant').every(turn => !amount(turn.content, '71370'))).toBe(true);
});

test('a corrected net-asset total survives only after the actual calculate tool returns it', async () => {
  const calculated = calls('calculate', { expression: '52000+12850+5200+320-8500', mode: 'money' });
  const f = replay([assetRead(), fundRead(), prose('净资产 71,370 元。'), calculated,
    prose('当前已保存净资产为 61,870.00 元。')], ['asset-composition', 'fund-holdings']);
  const result = await f.send();
  expect(result.answer).toContain('61,870.00');
  expect(amount(result.answer, '71370')).toBe(false);
  expect(result.toolTrace.map(trace => trace.tool)).toEqual(['query_data', 'query_data', 'calculate']);
  const calculation = f.audits.find(entry => entry.toolName === 'calculate' && entry.phase === 'tool');
  expect(calculation.response.result).toMatchObject({ mode: 'money', value: '61870.00' });
  expect(result.datasets.every(dataset => dataset.datasetId !== 'calculate')).toBe(true);
  expect(f.provider).toHaveBeenCalledTimes(5);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('budget daily spending advice cannot introduce an uncalculated amount', async () => {
  const f = replay([calls('query_data', { datasetId: 'budget-plans' }), prose(
    '预算计划已保存。\n\n预算 2,000 元，已登记使用 1,450 元。\n\n接下来平均每天只能花约 30 元。')], ['budget-plans']);
  const result = await f.send('看看我的已保存预算');
  expect(amount(result.answer, '2000')).toBe(true);
  expect(amount(result.answer, '1450')).toBe(true);
  expect(result.answer).not.toMatch(/(?:每天|日均)[^。\n]*\b30\s*元/);
  expect(result.toolTrace.some(trace => trace.tool === 'calculate')).toBe(false);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('work examples do not acquire evidence from the source hourly wage alone', async () => {
  const f = replay([calls('query_data', { datasetId: 'work-rules' }), prose(
    '已保存的加班时薪为 50 元/小时。\n\n加班 2 小时能拿 100 元，加班 4 小时能拿 200 元。')], ['work-rules']);
  const result = await f.send('看看我的加班工资规则');
  expect(result.answer).toContain('50');
  expect(amount(result.answer, '100')).toBe(false);
  expect(amount(result.answer, '200')).toBe(false);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('the last permitted provider call still returns verified facts when an invented total cannot be retried', async () => {
  const f = replay([assetRead(), fundRead(), calls('query_data', { datasetId: 'work-rules' }),
    calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-10-01', endDate: '2026-10-31' }),
    prose('保存余额可供核对。\n\n净资产 71,370 元。\n\n借记卡保存余额 52,000 元。')],
  ['asset-composition', 'fund-holdings', 'work-rules', 'finance-monthly']);
  const result = await f.send();
  expect(f.provider).toHaveBeenCalledTimes(5);
  expect(amount(result.answer, '71370')).toBe(false);
  expect(amount(result.answer, '52000')).toBe(true);
  expect(result.request.providerCalls).toBe(5);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('pure chat code and numeric Mermaid remain unchanged before any business read', async () => {
  const answer = '这里是一个演示。\n\n```js\nconsole.log(100 + 200);\n```\n\n```mermaid\npie title 示例比例\n  "A" : 17\n  "B" : 23\n```';
  const f = replay([prose(answer)]);
  const result = await f.send('帮我演示代码和一个饼图');
  expect(result.answer).toBe(answer);
  expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('a structural Mermaid diagram remains intact while an unsupported numeric chart is withheld', async () => {
  const structure = '```mermaid\nflowchart LR\n  A1[查看余额] --> B2[核对保存记录]\n```';
  const misleading = '```mermaid\npie title 正资产合计79870元\n  "借记卡" : 52000\n  "基金" : 18050\n  "零钱" : 320\n```';
  const f = replay([assetRead(), fundRead(), prose(`保存余额 52,000 元。\n\n${structure}\n\n${misleading}`)],
    ['asset-composition', 'fund-holdings']);
  const result = await f.send('请用图说明资产组成与核对流程');
  expect(result.answer).toContain(structure);
  expect(result.answer).not.toContain('79870');
  expect(result.answer).not.toContain('pie title 正资产');
  expect(amount(result.answer, '52000')).toBe(true);
});

test('a financial amount in a structural Mermaid label cannot bypass the number guard', async () => {
  const f = replay([assetRead(), fundRead(), prose('保存余额可以核对。\n\n```mermaid\nflowchart LR\n  A[当前净资产71370元] --> B[检查保存记录]\n```')],
    ['asset-composition', 'fund-holdings']);
  const result = await f.send('用流程图说明资产核对');
  expect(result.answer).not.toContain('71370');
  expect(result.answer).toContain('保存余额可以核对');
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('a failed calculate receipt cannot authorize its requested inputs as output facts', async () => {
  const f = replay([assetRead(), calls('calculate', { expression: '71370/0', mode: 'money' }),
    prose('借记卡保存余额 52,000 元。\n\n净资产为 71,370 元。')], ['asset-composition']);
  const result = await f.send();
  expect(result.toolTrace.find(trace => trace.tool === 'calculate').records).toBe(0);
  expect(amount(result.answer, '71370')).toBe(false);
  expect(amount(result.answer, '52000')).toBe(true);
});

test('web results cannot supply a missing ledger number in a mixed business turn', async () => {
  const url = 'https://example.com/public-news';
  const config = { searchEnabled: true, searchBaseUrl: 'https://api.deepseek.com', searchApiKey: 'offline-search-key',
    searchProvider: 'deepseek', searchTimeoutMs: 10000, searchDailyLimit: 50 };
  const client = jest.fn(async () => ({ results: [{ title: '外部公开报价', url,
    snippet: '公开报价为999999.99元。', date: '2026-11-07' }] }));
  const f = createEvalFixture({ mode: 'chat', message: '查询账本并查找公开资讯', datasets: ['finance-monthly'],
    toolScript: [['web_search', { query: 'public news' }], ['query_data', {
      datasetId: 'finance-monthly', startDate: '2026-10-01', endDate: '2026-10-31',
    }]], final: { answer: `我的账本支出为999999.99元。\n\n公开资讯来源 ${url} 。` } },
  { config, webSearchTools: createWebSearchTools({ client }), searchBudget: { reserve: async () => true } });
  const result = await f.send();
  expect(client).toHaveBeenCalledTimes(1);
  expect(amount(result.answer, '999999.99')).toBe(false);
  expect(result.answer).toContain(url);
  expect(result.datasets.map(dataset => dataset.datasetId)).toEqual(['finance-monthly']);
  expect(f.history.filter(turn => turn.role === 'assistant').every(turn => !amount(turn.content, '999999.99'))).toBe(true);
});

test('an external-only search turn can quote its public result without becoming a ledger claim', async () => {
  const url = 'https://example.com/public-news';
  const f = createEvalFixture({ mode: 'chat', message: '查找公开报价资讯', datasets: [],
    toolScript: [['web_search', { query: 'public price' }]],
    final: { answer: `外部公开报价为999999.99元。来源 ${url} 。` } }, {
    config: { searchEnabled: true, searchBaseUrl: 'https://api.deepseek.com', searchApiKey: 'offline-search-key',
      searchProvider: 'deepseek', searchTimeoutMs: 10000, searchDailyLimit: 50 },
    webSearchTools: createWebSearchTools({ client: async () => ({ results: [{ title: '公开报价', url,
      snippet: '公开报价999999.99元。', date: '2026-11-07' }] }) }),
    searchBudget: { reserve: async () => true },
  });
  const result = await f.send();
  expect(amount(result.answer, '999999.99')).toBe(true);
  expect(result.datasets).toEqual([]);
  expect(result.answer).toContain(url);
  expect(f.provider).toHaveBeenCalledTimes(2);
});

test('numeric correction cannot reopen business reads or bypass the allowed calculate-only tool set', async () => {
  const f = replay([assetRead(), fundRead(), prose('净资产为71,370元。'), assetRead()],
    ['asset-composition', 'fund-holdings']);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_TOOL_DENIED' });
  expect(f.provider.mock.calls[3][2].map(definition => definition.function.name)).toEqual(['calculate']);
  expect(f.repository.query).toHaveBeenCalledTimes(2);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
  expect(f.history.filter(turn => turn.role === 'assistant').every(turn => !amount(turn.content, '71370'))).toBe(true);
});

test('a calculate expression cannot launder an unsupported model-invented numeric literal', async () => {
  const f = replay([assetRead(), fundRead(), prose('净资产71,370元。'),
    calls('calculate', { expression: '71370', mode: 'money' }), prose('净资产71,370元。')],
  ['asset-composition', 'fund-holdings']);
  const result = await f.send();
  expect(amount(result.answer, '71370')).toBe(false);
  // Pure arithmetic may succeed, but an unsupported input is not ledger evidence.
  expect(result.toolTrace.find(trace => trace.tool === 'calculate').records).toBe(1);
  expect(f.audits.find(entry => entry.phase === 'tool' && entry.toolName === 'calculate').response.result.value).toBe('71370.00');
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test.each(['净资产七万一千三百七十元。', '净资产7.137万元。'])('an unsupported financial amount cannot bypass evidence through alternate notation: %s', async unsupported => {
  const f = replay([assetRead(), fundRead(), prose(`保存余额可以核对。\n\n${unsupported}`)],
    ['asset-composition', 'fund-holdings']);
  const result = await f.send();
  expect(result.answer).not.toContain(unsupported);
  expect(result.answer).toContain('保存余额可以核对');
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('numeric recovery cannot launder an unsupported execution claim into a successful saved reply', async () => {
  const f = replay([assetRead(), prose('本次已完成入账，净资产71370元。'),
    prose('未入账，借记卡保存余额52000元。')], ['asset-composition']);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
  expect(f.audits.filter(entry => entry.phase === 'numeric-recovery')).toEqual([]);
  expect(f.history.filter(turn => turn.role === 'assistant').every(turn => !amount(turn.content, '71370'))).toBe(true);
});

test('numeric Mermaid validates plotted values while preserving a harmless axis layout range', async () => {
  const graph = '```mermaid\nxychart-beta\n  title "已保存账户资产"\n  x-axis ["借记卡", "微信"]\n  y-axis "元" 0 --> 60000\n  bar [52000, 320]\n```';
  const f = replay([assetRead(), prose(`已保存余额可以核对。\n\n${graph}`)], ['asset-composition']);
  const result = await f.send('请画图说明已保存的账户资产');
  expect(result.answer).toContain(graph);
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('an oversized correction calculation batch executes none and pairs all calls before a tool-free final answer', async () => {
  const batch = calcBatch(7);
  const f = replay([assetRead(), fundRead(), prose('净资产71370元。'), batch,
    prose('借记卡已保存余额52000元。')], ['asset-composition', 'fund-holdings']);
  const result = await f.send();
  expect(f.provider).toHaveBeenCalledTimes(5);
  expect(result.request.providerCalls).toBe(5);
  expect(result.toolTrace.map(trace => trace.tool)).toEqual(['query_data', 'query_data']);
  expect(f.audits.filter(entry => entry.phase === 'tool' && entry.toolName === 'calculate')).toEqual([]);
  expect(f.audits.find(entry => entry.phase === 'numeric-tool-limit')).toMatchObject({
    request: { requested: 7, remaining: 6 }, response: { executed: 0 }, errorCode: 'AI_TOOL_BUDGET_EXCEEDED',
  });
  const [, finalMessages, finalTools, finalOptions] = f.provider.mock.calls[4];
  expect(finalTools).toEqual([]);
  expect(finalOptions.toolChoice).toBe('none');
  const requestedIds = new Set(batch.tool_calls.map(call => call.id));
  const paired = finalMessages.filter(message => message.role === 'tool' && requestedIds.has(message.tool_call_id));
  expect(paired).toHaveLength(7);
  expect(paired.map(message => JSON.parse(message.content))).toEqual(Array.from({ length: 7 }, () =>
    expect.objectContaining({ status: 'error', code: 'AI_TOOL_BUDGET_EXCEEDED' })));
  expect(result.answer).toContain('52000');
  expect(amount(result.answer, '71370')).toBe(false);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('a data-reading chat safely finalizes when a normal calculate-only batch exceeds its remaining tool budget', async () => {
  const batch = calcBatch(8);
  const f = replay([assetRead(), batch, prose('借记卡已保存余额52000元。')], ['asset-composition']);
  const result = await f.send();
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(result.toolTrace.map(trace => trace.tool)).toEqual(['query_data']);
  expect(f.audits.filter(entry => entry.phase === 'tool' && entry.toolName === 'calculate')).toEqual([]);
  expect(f.audits.find(entry => entry.phase === 'numeric-tool-limit')).toMatchObject({
    request: { requested: 8, remaining: 7 }, response: { executed: 0 },
  });
  const [, messages, tools, options] = f.provider.mock.calls[2];
  expect(tools).toEqual([]); expect(options.toolChoice).toBe('none');
  const ids = new Set(batch.tool_calls.map(call => call.id));
  expect(messages.filter(message => message.role === 'tool' && ids.has(message.tool_call_id))).toHaveLength(8);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('an oversized pure-calculate batch without any business read retains the original fail-closed tool limit', async () => {
  const f = replay([calcBatch(9), prose('这是计算结果。')]);
  await expect(f.send('计算这些数字')).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED' });
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.audits.filter(entry => entry.phase === 'numeric-tool-limit')).toEqual([]);
  expect(f.audits.filter(entry => entry.phase === 'tool' && entry.toolName === 'calculate')).toEqual([]);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test('an oversized mixed tool batch cannot use calculate-only finalization to bypass a business-read budget', async () => {
  const batch = calcBatch(7);
  batch.tool_calls.push(fundRead().tool_calls[0]);
  const f = replay([assetRead(), batch, prose('这是结果。')], ['asset-composition', 'fund-holdings']);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED' });
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.audits.filter(entry => entry.phase === 'numeric-tool-limit')).toEqual([]);
  expect(f.audits.filter(entry => entry.phase === 'tool' && entry.toolName === 'calculate')).toEqual([]);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test('pseudo tool-call prose is never executed and a protocol-only reply falls back to published asset facts', async () => {
  const protocol = '<tool_call>calculate<arg_key>expression</arg_key><arg_value>52000+320-8500</arg_value>' +
    '<arg_key>mode</arg_key><arg_value>money</arg_value></tool_call>';
  const f = replay([assetRead(), prose(protocol)], ['asset-composition']);
  const result = await f.send('看看我的资产构成');
  expect(result.toolTrace.map(trace => trace.tool)).toEqual(['query_data']);
  expect(f.audits.filter(entry => entry.phase === 'tool' && entry.toolName === 'calculate')).toEqual([]);
  expect(result.answer).not.toMatch(/tool_call|arg_key|arg_value|<\/?.*calculate/);
  expect(amount(result.answer, '52000')).toBe(true);
  expect(amount(result.answer, '8500')).toBe(true);
  expect(amount(result.answer, '320')).toBe(true);
  expect(persistedAnswers(f)).toEqual([result.answer]);
});

test('an empty model answer after a real work-rule read publishes the actual hourly wage instead of scope alone', async () => {
  const f = replay([calls('query_data', { datasetId: 'work-rules' }), prose('')], ['work-rules']);
  const result = await f.send('我保存的加班时薪是多少');
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(result.toolTrace.map(trace => trace.tool)).toEqual(['query_data']);
  expect(result.answer).toContain('时薪');
  expect(amount(result.answer, '50')).toBe(true);
  expect(result.datasets.find(dataset => dataset.datasetId === 'work-rules').rows[0].hourlyWage).toBe('50.00');
  expect(persistedAnswers(f)).toEqual([result.answer]);
});
