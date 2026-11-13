jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Database forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Database forbidden'); }) }));
const { sanitizeHistoryToolsSummary, buildHistoryToolsSummary } = require('../../src/modules/ai/service/historyToolsSummary');
const { selectHistoryTurns, buildHistoryContext } = require('../../src/modules/ai/service/historyContext');
const { selectBudgetedHistory, estimateTokens } = require('../../src/modules/ai/service/modelContext');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const date = '2026-11-12';
const querySummary = { version: 1, tools: [{ name: 'query_data', datasetId: 'card-monthlyConsumption' }],
  chart: { type: 'line', datasetId: 'card-monthlyConsumption' } };

test('summary copies only observed names, valid datasets and chart type while discarding private and numeric fields', () => {
  const value = buildHistoryToolsSummary({ business: { toolTrace: [{ tool: 'query_data', datasetId: 'card-monthlyConsumption',
    queryId: 'private-query', previewId: 'private-preview', records: 5, amount: '203.32', args: { filter: 'private-filter' },
    digest: 'private-digest', rows: [{ amount: '203.32', ref: 'private-ref' }] }],
  chart: { type: 'line', datasetId: 'card-monthlyConsumption', queryId: 'private-query', xKey: 'month', yKeys: ['amountCNY'], title: 'private-title' } } });
  expect(value).toEqual(querySummary);
  expect(JSON.stringify(value)).not.toMatch(/private|203\.32|records|args|digest|xKey|yKeys|title/);
});

test('the summary allowlist rejects fabricated tool and dataset names and caps deduplicated entries', () => {
  const tools = [{ name: 'query_data', datasetId: 'not-a-dataset' }, { name: 'curl', datasetId: 'finance-monthly' },
    ...Array.from({ length: 20 }, () => ({ name: 'memory_read', path: 'private.md' })),
    ...['finance-monthly', 'finance-daily', 'finance-categories', 'finance-transactions', 'card-cards', 'card-counts', 'card-bills', 'card-pools']
      .map(datasetId => ({ name: 'query_data', datasetId }))];
  const result = sanitizeHistoryToolsSummary({ version: 1, tools, chart: { type: 'javascript', datasetId: 'finance-monthly' } });
  expect(result.tools).toHaveLength(8);
  expect(result.tools[0]).toEqual({ name: 'query_data' });
  expect(result.tools.filter(tool => tool.name === 'memory_read')).toHaveLength(1);
  expect(result.chart).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/curl|not-a-dataset|private\.md|javascript/);
});

test('legacy evidence may identify its known tool without fabricating a dataset or chart', () => {
  expect(buildHistoryToolsSummary({ evidence: [{ tool: 'query_finance_summary', expense: '20.00' }] }))
    .toEqual({ version: 1, tools: [{ name: 'query_finance_summary' }], chart: null });
  expect(buildHistoryToolsSummary({ content: '用了 query_data 生成图表' })).toBeNull();
  expect(buildHistoryToolsSummary({ business: { datasets: [{ datasetId: 'finance-monthly' }] } })).toBeNull();
  expect(buildHistoryToolsSummary({ business: { toolTrace: [] } })).toBeNull();
  expect(sanitizeHistoryToolsSummary({ version: 2, tools: [] })).toBeNull();
});

test('tool provenance follows its own turn identity across equal text and interleaved replies', () => {
  const memorySummary = { version: 1, tools: [{ name: 'memory_write' }], chart: null };
  const history = [{ role: 'user', turnId: 'first', content: '再来一次', sourceDate: date },
    { role: 'user', turnId: 'second', content: '再来一次', sourceDate: date },
    { role: 'assistant', turnId: 'second', content: '保存偏好', historyToolsSummary: memorySummary },
    { role: 'assistant', turnId: 'first', content: '图表完成', historyToolsSummary: querySummary },
    { role: 'assistant', turnId: 'first', standalone: true, content: '卡片操作', historyToolsSummary: memorySummary }];
  expect(selectHistoryTurns(history).map(turn => turn.historyToolsSummary)).toEqual([querySummary, memorySummary]);
  const input = buildHistoryContext({ history, userTurns: ['再来一次', '再来一次', '你用了什么工具？'],
    userTurnDates: [date, date, date], userTurnIds: ['first', 'second', 'current'] });
  expect(input.turns.map(turn => turn.historyToolsSummary)).toEqual([querySummary, memorySummary]);
  expect(input.priorAnswers).toEqual(['图表完成', '保存偏好']);
});

test('missing metadata remains explicitly unknown instead of borrowing prose or another turn', () => {
  const history = [{ role: 'user', turnId: 'one', content: '查收支', sourceDate: date },
    { role: 'assistant', turnId: 'one', content: 'query_data查询完成' },
    { role: 'user', turnId: 'two', content: '保存记忆', sourceDate: date },
    { role: 'assistant', turnId: 'two', content: '失败', failure: { code: 'AI_PROVIDER_TIMEOUT' } }];
  expect(selectHistoryTurns(history).map(turn => turn.historyToolsSummary)).toEqual([null, null]);
  expect(buildHistoryContext({ history, userTurns: ['窗口外原话', '查收支', '现在'],
    userTurnDates: [date, date, date], userTurnIds: ['outside', 'one', 'current'] }).turns[0].historyToolsSummary).toBeNull();
});

test('history token selection accounts for the structured tool summary', () => {
  const history = [{ role: 'user', turnId: 'one', content: '查', sourceDate: date },
    { role: 'assistant', turnId: 'one', content: '好', historyToolsSummary: querySummary }];
  const textCost = estimateTokens(['查', '好']) * 2;
  expect(selectBudgetedHistory(history, { budget: textCost }).turns).toEqual([]);
  expect(selectBudgetedHistory(history, { budget: textCost + estimateTokens(querySummary) }).turns).toHaveLength(1);
});

test('reopening durable V3 history exposes a sanitized observed summary without changing visible reply metadata', async () => {
  const messages = [], executor = { execute: jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT id, latest_draft_id') || sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: 'conversation', latest_draft_id: null }]];
    if (sql.startsWith('INSERT INTO ai_message')) {
      const assistant = sql.includes("'assistant'"), withDraft = sql.includes('draft_id');
      messages.push({ id: messages.length + 1, role: assistant ? 'assistant' : 'user', content: params[2],
        meta: JSON.parse(params[assistant && withDraft ? 4 : 3]), created_at: new Date(date) }); return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
    if (sql.startsWith('SELECT id, role') && sql.includes('AS topic_boundary')) return [messages.slice().reverse()];
    if (sql.startsWith('SELECT id, role')) return [messages];
    throw new Error('Unexpected offline SQL');
  }) };
  const business = { contractVersion: 3, toolTrace: [{ tool: 'query_data', datasetId: 'card-monthlyConsumption',
    queryId: 'private-query', previewId: 'private-preview', records: 5, bytes: 123, digest: 'private-digest' }],
  chart: { type: 'line', datasetId: 'card-monthlyConsumption', queryId: 'private-query', xKey: 'month', yKeys: ['amountCNY'], title: '月消费' } };
  await createConversationStore({ executor }).append('owner', 'conversation', { message: '月消费', answer: '图表完成', requestId: 'chart_turn', business });
  const reopened = await createConversationStore({ executor }).open('owner', 'conversation');
  expect(reopened.history[1].historyToolsSummary).toEqual(querySummary);
  expect(selectHistoryTurns(reopened.history)[0].historyToolsSummary).toEqual(querySummary);
  expect((await createConversationStore({ executor }).messages('owner', 'conversation'))[1].toolTrace).toEqual(business.toolTrace);
});
