const crypto = require('crypto');

// This reproduces a recorded tool request without a model or database fallback.
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden in card ranking replay'); }),
}));
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Live database forbidden in card ranking replay'); }),
  getConnection: jest.fn(() => { throw new Error('Live database forbidden in card ranking replay'); }),
}));

const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const liveDb = require('../../src/common/config/db');

const id = () => crypto.randomUUID();
const now = () => new Date('2026-11-08T14:00:00Z');
const recordedArgs = { datasetId: 'card-monthlyConsumption', cardTypes: ['debit'],
  startDate: '2026-08-01', endDate: '2026-11-08', sort: 'amountDesc', direction: 'expense', limit: 5 };
const cardRows = [
  { cardId: 'private-debit-A', name: '借记卡 A', type: '借记卡', currency: 'CNY', amountCNY: '180.00', count: 3, unpricedCount: 0, sourceCurrencies: 'CNY' },
  { cardId: 'private-debit-B', name: '借记卡 B', type: '借记卡', currency: 'CNY', amountCNY: '100.00', count: 1, unpricedCount: 0, sourceCurrencies: 'CNY' },
];
// Card A spent 60 in each of September, October and November. Card B's single
// month is 100, so ordering card/month rows would give the wrong overall winner.
const monthRows = [
  { ...cardRows[1], month: '2026-11' },
  ...['2026-11', '2026-10', '2026-09'].map(month => ({ ...cardRows[0], month, amountCNY: '60.00', count: 1 })),
];
const moneyColumns = [
  { key: 'name', label: '卡片', type: 'text' }, { key: 'type', label: '类型', type: 'text' },
  { key: 'currency', label: '统计币种', type: 'text' }, { key: 'amountCNY', label: '已定价消费', type: 'money' },
  { key: 'count', label: '消费笔数', type: 'number' }, { key: 'unpricedCount', label: '未定价笔数', type: 'number' },
  { key: 'sourceCurrencies', label: '原币种', type: 'text' },
];
function fixture(toolArgs = recordedArgs) {
  const previewsById = new Map(), history = [], audits = [];
  const conversationId = id();
  const conn = { beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}), release: jest.fn() };
  const executor = { getConnection: jest.fn(async () => conn), execute: jest.fn(async (sql, params) => {
    if (sql.startsWith("UPDATE ai_analysis_preview SET payload = 'expired'")) return [{ affectedRows: 0 }];
    if (sql.startsWith('INSERT INTO ai_analysis_preview')) {
      const [previewId, user_id, digest, payload, created_at, expires_at] = params;
      previewsById.set(previewId, { id: previewId, user_id, digest, payload, created_at, expires_at, approved_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT id, user_id, digest')) {
      const row = previewsById.get(params[0]);
      return [[...(row && row.user_id === params[1] ? [row] : [])]];
    }
    if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at')) {
      previewsById.get(params[1]).approved_at = params[0]; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_analysis_preview SET request_id')) {
      const row = previewsById.get(params[1]);
      if (row.request_id) return [{ affectedRows: 0 }];
      row.request_id = params[0]; return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected replay SQL: ${sql}`);
  }) };
  const state = { config: { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://offline.invalid',
    model: 'recorded-card-ranking', apiKey: 'offline-unused-card-key', dailyProviderLimit: 100 }, connectionId: id(),
    businessPolicy: { enabled: true, domains: ['card'], actions: [] },
    conversationStore: {
      open: jest.fn(async () => ({ id: conversationId, history, latestDraftId: null })),
      append: jest.fn(async (_, __, payload) => history.push({ role: 'user', content: payload.message },
        { role: 'assistant', content: payload.answer, queryCoverage: payload.queryCoverage, taskContext: payload.taskContext })),
      appendFailure: jest.fn(),
    },
    requestGuard: { run: jest.fn(async (_, request, work) => {
      const budget = { requestId: request.requestId, calls: 0, check: jest.fn(), tool: jest.fn(), invoke: async fn => {
        if (++budget.calls > request.maxProviderCalls) throw new Error('Unexpected provider retry');
        return fn();
      } };
      return work(budget);
    }), saveV3Recovery: jest.fn() },
  };
  const repository = { query: jest.fn(async (_, args) => {
    const groupBy = args.groupBy === 'card' ? 'card' : 'cardMonth';
    const rows = groupBy === 'card' ? cardRows : monthRows;
    const summary = { expense: '280.00', count: 4, unpricedCount: 0, currency: 'CNY', incomplete: false };
    return { scope: args.scope, asOf: now().toISOString(), choices: {}, datasets: [{
      datasetId: 'card-monthlyConsumption', domain: 'card', title: groupBy === 'card' ? '按卡区间消费统计（人民币）' : '按卡消费月度统计（人民币）',
      columns: [...(groupBy === 'cardMonth' ? [{ key: 'month', label: '消费月', type: 'date' }] : []), ...moneyColumns],
      rows: structuredClone(rows), summary, policy: '按范围聚合消费流水，金额排序在全量筛选后进行。',
      asOf: now().toISOString(), truncated: false,
      cardMonthlyQuery: { summary, matchedRowCount: rows.length, sort: args.sort || 'dateDesc',
        cardTypes: args.cardTypes || [], filter: args.filter || '', groupBy, direction: 'expense' },
    }] };
  }) };
  const responses = [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_card_ranking', type: 'function',
    function: { name: 'query_data', arguments: JSON.stringify(toolArgs) } }] },
  ...Array.from({ length: 2 }, () => ({ role: 'assistant', content: JSON.stringify({ answer: '', proposal: null,
    proposals: null, clarification: null, chart: null }) }))];
  const provider = jest.fn(async () => {
    const response = responses[provider.mock.calls.length - 1];
    if (!response) throw new Error('Unexpected provider replay call');
    return structuredClone(response);
  });
  const legacy = { getRuntime: () => state, prepareTransactionProposal: jest.fn(), persistTransactionBatch: jest.fn() };
  const previews = createPreviewStore({ executor, now: () => now().getTime() });
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor, repository, previews,
    proposals: { create: jest.fn() }, provider, grants: { requireCoverage: jest.fn(async () => {}) },
    callLog: { record: entry => audits.push(entry) }, memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) },
    historyReader: {}, now });
  const send = message => service.chat('offline-card-owner', { requestId: id(), conversationId, message, consent: true });
  return { send, repository, provider, previewsById, state, legacy, history, audits };
}
afterAll(() => {
  expect(deepseekChat).not.toHaveBeenCalled();
  expect(liveDb.execute).not.toHaveBeenCalled();
  expect(liveDb.getConnection).not.toHaveBeenCalled();
});

test.each(['最近三个月哪张借记卡支出最高？', '最近3个月哪张借记卡支出最高？'])('recorded %s ranks whole cards across the correct three calendar months and publishes the answer without model arithmetic', async message => {
  const f = fixture();
  const result = await f.send(message);
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  const args = f.repository.query.mock.calls[0][1];
  expect(args).toMatchObject({ datasetId: 'card-monthlyConsumption', groupBy: 'card', cardTypes: ['debit'],
    direction: 'expense', sort: 'amountDesc', scope: { domains: ['card'], startDate: '2026-09-01', endDate: '2026-11-08' } });
  expect(result.datasets).toHaveLength(1);
  const dataset = result.datasets[0];
  expect(dataset.rows[0]).toMatchObject({ name: '借记卡 A', amountCNY: '180.00', count: 3 });
  expect(dataset.columns.map(column => column.key)).not.toContain('month');
  expect(dataset.summary).toMatchObject({ expense: '280.00', count: 4, currency: 'CNY' });
  expect(dataset.queryMeta).toMatchObject({ effectiveScope: { startDate: '2026-09-01', endDate: '2026-11-08' },
    groupBy: 'card', filters: { direction: 'expense', cardTypes: ['debit'] }, matchedRowCount: 2, returnedRowCount: 2, sourceRecordCount: 4,
    rowsComplete: true, summaryComplete: true, rankingComplete: true });
  expect(result.answer).toMatch(/借记卡 A.*180\.00/);
  expect(result.answer).toMatch(/最高|最多|最大/);
  expect(result.answer).not.toMatch(/借记卡 B.*(?:最高|最多|最大)/);
  expect(f.previewsById.size).toBe(1);
  expect([...f.previewsById.values()][0].approved_at).not.toBeNull();
  const disclosed = JSON.parse(f.provider.mock.calls[1][1].findLast(turn => turn.role === 'tool').content);
  expect(disclosed.datasets[0].rows[0]).toMatchObject({ name: '借记卡 A', amountCNY: '180.00' });
  expect(JSON.stringify(disclosed)).not.toContain('private-debit');
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

test('a one-row result still gives the full-range winner and preserves full matched card and source counts', async () => {
  const f = fixture({ ...recordedArgs, limit: 1 });
  const result = await f.send('最近三个月哪张借记卡支出最高？');
  const dataset = result.datasets[0];
  expect(dataset.rows).toHaveLength(1);
  expect(dataset.truncated).toBe(true);
  expect(dataset.queryMeta).toMatchObject({ matchedRowCount: 2, returnedRowCount: 1, sourceRecordCount: 4,
    rowsComplete: false, summaryComplete: true, rankingComplete: true, groupBy: 'card',
    filters: { direction: 'expense', cardTypes: ['debit'] } });
  expect(dataset.summary).toMatchObject({ expense: '280.00', count: 4 });
  expect(result.answer).toMatch(/借记卡 A.*180\.00/);
  expect(result.answer).not.toMatch(/无法确定|无法确认/);
});

test('monthly consumption trends keep card/month rows instead of forcing an interval ranking', async () => {
  const f = fixture({ datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: '2026-11-08', cardTypes: ['debit'] });
  const result = await f.send('最近三个月借记卡每月消费趋势，给图表。');
  expect(f.repository.query.mock.calls[0][1].groupBy).not.toBe('card');
  expect(result.datasets[0].columns.map(column => column.key)).toContain('month');
  expect(result.datasets[0].rows.filter(row => row.name === '借记卡 A')).toHaveLength(3);
  expect(result.datasets[0].rows.find(row => row.name === '借记卡 A').amountCNY).toBe('60.00');
  expect(result.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 4, sourceRecordCount: 4, rankingComplete: false,
    groupBy: 'cardMonth', filters: { direction: 'expense', cardTypes: ['debit'] } });
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
});

test.each([
  '查看最近三个月所有卡片逐卡逐月的消费流水金额。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。',
  '查看最近三个月所有卡片逐卡逐月的消费流水金额，只显示第一条。',
])('recorded card consumption display limits preserve card-month grouping: %s', async message => {
  const f = fixture({ datasetId: 'card-monthlyConsumption', groupBy: 'cardMonth', sort: 'dateDesc',
    startDate: '2026-09-01', endDate: '2026-11-08', limit: 10 });
  const result = await f.send(message);
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.repository.query.mock.calls[0][1]).toMatchObject({ datasetId: 'card-monthlyConsumption',
    groupBy: 'cardMonth', sort: 'dateDesc', scope: { startDate: '2026-09-01', endDate: '2026-11-08' } });
  expect(result.datasets[0].queryMeta).toMatchObject({ groupBy: 'cardMonth', sort: 'dateDesc' });
  expect(result.datasets[0].columns.map(column => column.key)).toContain('month');
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
});

test('unsupported income is rejected unchanged, and an empty correction cannot become a successful receipt', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const f = fixture({ ...recordedArgs, direction: 'income' });
    const error = await f.send('最近三个月哪张借记卡支出最高？').catch(value => value);
    expect(error).toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID', status: 400 });
    const outputs = consoleError.mock.calls.map(([value]) => value).filter(value => value.startsWith('[AI Tool Check] '));
    expect(outputs).toHaveLength(1);
    const header = JSON.parse(outputs[0].split('\n')[0].slice('[AI Tool Check] '.length));
    expect(header).toMatchObject({ stage: 'tool-arguments', tool: 'query_data', round: 1, code: 'AI_TOOL_ARGUMENT_INVALID' });
    expect(header.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'direction', rule: 'dataset.direction', actualType: 'string' }),
    ]));
    expect(outputs[0]).toContain('[AI Tool Args] {');
    expect(outputs[0]).toContain('"direction": "income"');
    expect(outputs[0]).not.toContain('"direction": "expense"');
    expect(f.provider).toHaveBeenCalledTimes(3);
    expect(f.audits.filter(entry => entry.phase === 'tool-recovery')).toHaveLength(1);
    expect(f.repository.query).not.toHaveBeenCalled();
    expect(f.previewsById.size).toBe(0);
    expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
    expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
    expect(f.state.conversationStore.append).not.toHaveBeenCalled();
    expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
    expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ error, failure: f.state.conversationStore.appendFailure.mock.calls[0][2] }))
      .not.toMatch(/validationDiagnostic|dataset\.direction|\[AI Tool Args\]|"direction":"income"/);
  } finally { consoleError.mockRestore(); }
});
