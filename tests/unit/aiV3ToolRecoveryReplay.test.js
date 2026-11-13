const crypto = require('crypto');
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Live provider forbidden'); }) }));
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { AiError } = require('../../src/modules/ai/service/errors');
const { createV3Service } = require('../../src/modules/ai/service/v3Service');
const { createPreviewStore } = require('../../src/modules/ai/service/analysisPreviews');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const id = () => crypto.randomUUID();
const today = '2026-11-09', stamp = Date.parse('2026-11-09T01:00:00Z');
const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + id(), type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] });
const batch = (...items) => ({ role: 'assistant', content: null, tool_calls: items.flatMap(item => item.tool_calls) });
const final = (answer = '请查看已查询的日程。') => ({ role: 'assistant', content: JSON.stringify({ answer,
  proposal: null, proposals: null, clarification: null, chart: null }) });

function fixture(responses, options = {}) {
  const guard = createMemoryRequestGuard({ clock: () => stamp });
  const durableExecutor = guard.fixtureExecutor;
  const conversationId = id(), requestId = id(), history = [], audits = [], events = [], previewRows = new Map();
  const state = { config: { mode: 'deepseek', dataSource: 'user-readonly', baseUrl: 'https://offline.invalid',
    model: 'offline-tool-recovery', apiKey: 'fixture-never-use', dailyProviderLimit: 100 }, connectionId: id(),
    businessPolicy: { enabled: true, domains: ['todo', 'finance', 'card'], actions: [] }, requestGuard: guard,
    conversationStore: { open: jest.fn(async () => ({ id: conversationId, history })),
      append: jest.fn(async (_, __, payload) => {
        if (!options.realPreviews) return history.push(payload);
        history.push({ role: 'user', content: payload.message, turnId: payload.requestId, sourceDate: today },
          { role: 'assistant', content: payload.answer, turnId: payload.requestId, business: payload.business,
            queryContext: payload.queryContext, taskContext: payload.taskContext,
            taskContexts: payload.taskContexts, queryCoverage: payload.queryCoverage, contextSummary: payload.contextSummary });
      }),
      appendFailure: jest.fn(async (_, __, payload) => history.push({ failed: payload })) } };
  const executor = { getConnection: () => durableExecutor.getConnection(), execute: jest.fn(async (sql, params) => {
    if (options.realPreviews && sql.includes('ai_analysis_preview')) {
      if (sql.startsWith("UPDATE ai_analysis_preview SET payload = 'expired'")) return [{ affectedRows: 0 }];
      if (sql.startsWith('INSERT INTO ai_analysis_preview')) {
        const [previewId, user_id, digest, payload, created_at, expires_at] = params;
        previewRows.set(previewId, { id: previewId, user_id, digest, payload, created_at, expires_at,
          approved_at: null, request_id: null });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT id, user_id, digest')) {
        const row = previewRows.get(params[0]);
        return [[...(row && row.user_id === params[1] && row.expires_at > params[2] ? [structuredClone(row)] : [])]];
      }
      if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at')) {
        const row = previewRows.get(params[1]);
        if (!row || row.user_id !== params[2] || row.expires_at <= params[3] || row.approved_at !== null) return [{ affectedRows: 0 }];
        row.approved_at = params[0]; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE ai_analysis_preview SET request_id')) {
        const row = previewRows.get(params[1]);
        if (!row || row.user_id !== params[2] || row.expires_at <= params[3] || row.request_id !== null
          || row.approved_at === null || row.approved_at < 0) return [{ affectedRows: 0 }];
        row.request_id = params[0]; return [{ affectedRows: 1 }];
      }
      throw new Error('Unexpected preview infrastructure SQL');
    }
    if (sql.startsWith('UPDATE ai_analysis_preview SET request_id')) return [{ affectedRows: 1 }];
    return durableExecutor.execute(sql, params);
  }) };
  const snapshots = new Map();
  const previews = options.realPreviews ? createPreviewStore({ executor, now: () => stamp }) : { prepare: jest.fn(async (_, args) => {
    const previewId = id(); snapshots.set(previewId, args.snapshot);
    return { previewId, digest: 'offline-preview-digest' };
  }), approveAndGet: jest.fn(async (_, previewId) => ({ snapshot: snapshots.get(previewId), refMap: {} })),
  toProvider: jest.fn(async (_, previewId) => snapshots.get(previewId)) };
  const repository = { query: jest.fn(async (_, args) => ({ scope: args.scope, asOf: new Date(stamp).toISOString(),
    choices: { cards: [], categories: [], todos: [], funds: [], fixedAssets: [], moods: [] },
    datasets: [{ datasetId: 'todo-events', domain: 'todo', title: '日程',
      columns: [{ key: 'content', label: '日程', type: 'text' }, { key: 'date', label: '日期', type: 'date' }],
      rows: [{ content: '参加例会', date: today }], summary: {}, policy: '本人保存日程', truncated: false }] })) };
  const legacy = { getRuntime: () => state, prepareTransactionProposal: jest.fn(() => { throw new Error('Unexpected transaction'); }),
    persistTransactionBatch: jest.fn(() => { throw new Error('Unexpected transaction persistence'); }) };
  const proposals = { create: jest.fn(() => { throw new Error('Unexpected proposal'); }) };
  const memoryStore = options.memoryStore || { list: jest.fn(async () => ({ files: [], count: 0, totalBytes: 0, warnings: [] })) };
  const provider = jest.fn(async (...args) => {
    const step = responses[provider.mock.calls.length - 1];
    if (!step) throw new Error('Unscripted additional model call');
    return typeof step === 'function' ? step(...args) : structuredClone(step);
  });
  const grants = { requireCoverage: jest.fn(async () => {}) };
  const service = createV3Service({ legacyService: legacy, businessService: {}, executor, repository, previews, proposals,
    provider, memoryStore, historyReader: {}, grants, callLog: { record: row => audits.push(row) }, now: () => new Date(stamp) });
  let sends = 0;
  const send = (message = '查看本月日程') => service.chat('offline-recovery-owner', { requestId: sends++ ? id() : requestId, conversationId, message, consent: true },
    (event, data) => events.push({ event, data }));
  return { send, guard, repository, previews, provider, state, executor, legacy, proposals, audits, history, events, grants, previewRows };
}
const payloads = messages => messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
const checkedFinal = (expectedPayloads, answer) => (_, messages, tools, options) => {
  expect(tools).toEqual([]); expect(options).toMatchObject({ json: true, toolChoice: 'none' });
  expect(payloads(messages)).toHaveLength(expectedPayloads);
  expect(payloads(messages).at(-1).datasets[0].datasetId).toBe('todo-events');
  return final(answer);
};
function noBusinessWrites(f) {
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(f.proposals.create).not.toHaveBeenCalled();
}
let errors;
beforeEach(() => { errors = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });
afterAll(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled(); expect(deepseekChat).not.toHaveBeenCalled();
});

test('a supported-tool argument mistake is returned as a paired error, corrected once, and completes through the real guard', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events', sort: 'amountDesc' }), (_, messages) => {
    expect(payloads(messages)).toEqual([expect.objectContaining({ status: 'error', code: 'AI_TOOL_ARGUMENT_INVALID' })]);
    return call('query_data', { datasetId: 'todo-events' });
  }, (_, messages, tools, options) => {
    expect(tools).toEqual([]); expect(options).toMatchObject({ json: true, toolChoice: 'none' });
    expect(payloads(messages)).toHaveLength(2); expect(payloads(messages)[1].datasets[0].rows[0].content).toBe('参加例会');
    return final();
  }]);
  const result = await f.send();
  expect(result.answer).toContain('日程'); expect(result.request.providerCalls).toBe(3);
  expect(f.repository.query).toHaveBeenCalledTimes(1); expect(f.previews.prepare).toHaveBeenCalledTimes(1);
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.provider.mock.calls[2][2]).toEqual([]);
  expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(1);
  noBusinessWrites(f);
});

test.each([
  ['malformed JSON', '{"datasetId":"todo-events"'],
  ['invalid calendar date', { datasetId: 'todo-events', startDate: '2026-02-30', endDate: today }],
])('%s permits a bounded correction without any read for the rejected packet', async (_, args) => {
  const f = fixture([call('query_data', args), (_, messages) => {
    expect(payloads(messages)[0].status).toBe('error');
    return call('query_data', { datasetId: 'todo-events' });
  }, checkedFinal(2)]);
  const result = await f.send();
  expect(result.request.providerCalls).toBe(3); expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.repository.query).toHaveBeenCalledTimes(1); noBusinessWrites(f);
});

test('identical rejected arguments do not consume another SQL read and terminate with their original error', async () => {
  const bad = { datasetId: 'todo-events', sort: 'amountDesc' };
  const f = fixture([call('query_data', bad), call('query_data', bad), final(), final()]);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
  expect(f.provider).toHaveBeenCalledTimes(2); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('an ordinary unknown field can be corrected, and its feedback identifies the field without disclosing a value', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events', foo: 'not-required-for-recovery' }), (_, messages) => {
    const feedback = payloads(messages)[0];
    expect(feedback).toMatchObject({ status: 'error', retryAllowed: true });
    expect(feedback.issues).toContainEqual(expect.objectContaining({ path: 'foo', rule: 'object.unknown' }));
    expect(JSON.stringify(feedback)).not.toContain('not-required-for-recovery');
    return call('query_data', { datasetId: 'todo-events' });
  }, checkedFinal(2)]);
  const result = await f.send();
  expect(result.request.providerCalls).toBe(3); expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.repository.query).toHaveBeenCalledTimes(1); noBusinessWrites(f);
});

test('every item in a mixed success/error batch has a paired response before correction', async () => {
  const mixed = batch(call('query_data', { datasetId: 'todo-events' }), call('query_data', { datasetId: 'todo-events', sort: 'amountDesc' }));
  const f = fixture([mixed, (_, messages) => {
    const tools = messages.filter(message => message.role === 'tool');
    expect(tools.map(item => item.tool_call_id)).toEqual(mixed.tool_calls.map(item => item.id));
    expect(payloads(messages)[0].datasets[0].rows).toHaveLength(1);
    expect(payloads(messages)[1]).toMatchObject({ status: 'error', retryAllowed: true });
    return call('query_data', { datasetId: 'todo-events' });
  }, final()]);
  const result = await f.send();
  expect(result.request.providerCalls).toBe(3); expect(f.repository.query).toHaveBeenCalledTimes(1);
  noBusinessWrites(f);
});

test('multiple distinct parameter errors in one batch all receive feedback and consume bounded tool slots', async () => {
  const many = batch(call('query_data', { datasetId: 'todo-events', sort: 'amountDesc' }),
    call('query_data', { datasetId: 'todo-events', startDate: '2026-02-30', endDate: today }));
  const f = fixture([many, (_, messages) => {
    expect(payloads(messages)).toHaveLength(2);
    expect(payloads(messages).every(item => item.status === 'error' && item.retryAllowed === true)).toBe(true);
    return call('query_data', { datasetId: 'todo-events' });
  }, checkedFinal(3)]);
  const result = await f.send();
  expect(result.request.providerCalls).toBe(3); expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(2);
  expect(f.repository.query).toHaveBeenCalledTimes(1); noBusinessWrites(f);
});

test('a second erroneous batch stops instead of spending a second recovery round', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events', sort: 'amountDesc' }),
    call('query_data', { datasetId: 'todo-events', startDate: '2026-02-30', endDate: today }), final()]);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_SCOPE_INVALID' });
  expect(f.provider).toHaveBeenCalledTimes(2); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('an error occupying the eighth tool slot pairs feedback but skips correction and reserves finalization', async () => {
  const many = batch(...Array.from({ length: 8 }, (_, index) => call('query_data', { datasetId: 'todo-events', sort: 'amountDesc', limit: index + 1 })));
  const f = fixture([many, (_, messages, tools) => {
    expect(tools).toEqual([]); const feedback = payloads(messages);
    expect(feedback).toHaveLength(8); expect(feedback.at(-1)).toMatchObject({ status: 'error', retryAllowed: false });
    return final('这次查询参数不适用，请明确查询日程。');
  }]);
  const result = await f.send();
  expect(result.request.providerCalls).toBe(2); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('a parameter error in provider round four pairs feedback but uses round five only for finalization', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events', filter: '一' }),
    call('query_data', { datasetId: 'todo-events', filter: '二' }),
    call('query_data', { datasetId: 'todo-events', filter: '三' }),
    call('query_data', { datasetId: 'todo-events', sort: 'amountDesc' }), (_, messages, tools) => {
      expect(tools).toEqual([]); expect(payloads(messages).at(-1)).toMatchObject({ status: 'error', retryAllowed: false });
      return final('没有匹配日程。');
    }]);
  // All three named filters have user evidence. Analysis deliberately keeps
  // the reasoning lane open, so the rejected packet actually arrives in round four.
  const result = await f.send('分析本月日程中一、二、三的安排。');
  expect(result.request.providerCalls).toBe(5); expect(f.provider).toHaveBeenCalledTimes(5);
  for (const [, , tools] of f.provider.mock.calls.slice(0, 4)) expect(tools.length).toBeGreaterThan(0);
  expect(f.provider.mock.calls[4][2]).toEqual([]);
  expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.repository.query).toHaveBeenCalledTimes(3); noBusinessWrites(f);
});

test.each([
  ['unknown tool', 'raw_sql', { sql: 'SELECT private' }, 'AI_TOOL_DENIED'],
  ['owner injection', 'query_data', { datasetId: 'todo-events', userId: 'another-owner' }, 'AI_INVALID_INPUT'],
  ['SQL injection field', 'query_data', { datasetId: 'todo-events', sql: 'SELECT private' }, 'AI_INVALID_INPUT'],
])('%s remains terminal and cannot request a model repair call', async (_, name, args, code) => {
  const f = fixture([call(name, args), final()]);
  await expect(f.send()).rejects.toMatchObject({ code });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('permission denial stays terminal before any data read or correction round', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events' }), final()]);
  f.grants.requireCoverage.mockImplementation(async (_, domains) => {
    if (domains.includes('todo')) throw new AiError('未授权读取日程', 403, 'AI_SCOPE_DENIED');
  });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('a data-reader failure with a parameter-like code cannot be mistaken for a recoverable schema error', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events' }), final()]);
  f.repository.query.mockRejectedValue(new AiError('读取器原始失败', 400, 'AI_TOOL_ARGUMENT_INVALID'));
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_TOOL_ARGUMENT_INVALID' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.previews.prepare).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('a connection change after successful reading stops before any recovery or further provider call', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events' }), final()]);
  const read = f.repository.query.getMockImplementation();
  f.repository.query.mockImplementation(async (...args) => {
    const result = await read(...args); f.state.connectionId = id(); return result;
  });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_CONNECTION_EXPIRED' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).toHaveBeenCalledTimes(1); noBusinessWrites(f);
});

test('revoked permission after reading prevents the next provider call even when other arguments were correct', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events' }), final()]);
  const read = f.repository.query.getMockImplementation();
  f.repository.query.mockImplementation(async (...args) => {
    const result = await read(...args); f.state.businessPolicy.domains = []; return result;
  });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).toHaveBeenCalledTimes(1); noBusinessWrites(f);
});

test('malformed finalization stays terminal even after a successful argument correction', async () => {
  const invalid = { role: 'assistant', content: '{"answer":"缺右括号"' };
  const f = fixture([call('query_data', { datasetId: 'todo-events', sort: 'amountDesc' }),
    call('query_data', { datasetId: 'todo-events' }), (_, messages, tools, options) => {
      expect(tools).toEqual([]); expect(options).toMatchObject({ json: true, toolChoice: 'none' });
      expect(payloads(messages)).toHaveLength(2);
      expect(payloads(messages)[1].datasets[0].rows[0].content).toBe('参加例会');
      return invalid;
    }]);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_INVALID_RESULT' });
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(f.provider.mock.calls[2][2]).toEqual([]);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);
  expect(f.history.every(row => !!row.failed)).toBe(true);
  noBusinessWrites(f);
});

test('invalid dates stated by the user remain terminal and are not silently replaced by model-selected dates', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events', startDate: '2026-02-30', endDate: today }), final()]);
  await expect(f.send('查看2026-02-30到2026-11-09的日程')).rejects.toMatchObject({ code: 'AI_SCOPE_INVALID' });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

test('read-write-identical-read returns the current memory revision under the real guard', async () => {
  const source = '记住：请用中文简短回答';
  let entry = { path: '回答偏好.md', title: '回答偏好', type: 'preference', content: '请用English回答。',
    source: '请用English回答', revision: 'a'.repeat(64), bytes: 100, created: new Date(stamp).toISOString(), updated: new Date(stamp).toISOString() };
  const memoryStore = { list: jest.fn(async () => ({ files: [{ ...entry }], warnings: [], totalBytes: 100 })),
    read: jest.fn(async () => ({ ...entry })), write: jest.fn(async (_, args) => {
      expect(args.expectedRevision).toBe('a'.repeat(64));
      entry = { ...entry, content: args.content, revision: 'b'.repeat(64), source: args.sourceText, changed: true };
      return { ...entry };
    }) };
  const sameRead = { path: '回答偏好.md', offset: 0, limit: 3000 };
  const f = fixture([call('memory_read', sameRead), (_, messages) => {
    expect(payloads(messages)[0].revision).toBe('a'.repeat(64));
    return call('memory_write', { path: entry.path, operation: 'replace', title: entry.title, type: entry.type,
      content: source, expectedRevision: 'a'.repeat(64), evidence: { sourceTurn: 0, quote: source }, reason: '更新回答偏好' });
  }, call('memory_read', sameRead), (_, messages) => {
    const seen = payloads(messages); expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ revision: 'b'.repeat(64), content: source });
    return final('已保存回答偏好。');
  }, final('已保存回答偏好。')], { memoryStore });
  const result = await f.send(source);
  expect(result.request.providerCalls).toBe(5); expect(memoryStore.read).toHaveBeenCalledTimes(2);
  expect(memoryStore.write).toHaveBeenCalledTimes(1); expect(f.repository.query).not.toHaveBeenCalled(); noBusinessWrites(f);
});

const money = (key, label) => ({ key, label, type: 'money' });
const textColumn = (key, label) => ({ key, label, type: 'text' });
const numberColumn = (key, label) => ({ key, label, type: 'number' });
const privateCardIds = ['private-owner-debit-card-a', 'private-owner-debit-card-b'];

function scopedFinanceRead(args) {
  const monthly = args.datasetId === 'finance-monthly';
  const rows = monthly ? [{ month: '2026-06', income: '100.00', expense: '60.00', count: 2, unpricedCount: 0 }]
    : [{ date: '2026-06-18', category: '餐饮', amountCNY: '60.00', remark: '聚餐' }];
  const summary = { income: monthly ? '100.00' : '0.00', expense: '60.00', count: monthly ? 2 : 1,
    incomeCount: monthly ? 1 : 0, expenseCount: 1, unpricedCount: 0, currency: 'CNY' };
  return { datasetId: args.datasetId, domain: 'finance', title: monthly ? '收支月度趋势' : '收支明细',
    columns: monthly ? [textColumn('month', '月份'), money('income', '收入'), money('expense', '支出'),
      numberColumn('count', '笔数'), numberColumn('unpricedCount', '未定价笔数')]
      : [{ key: 'date', label: '日期', type: 'date' }, textColumn('category', '分类'),
        money('amountCNY', '人民币金额'), textColumn('remark', '备注')],
    rows, summary, asOf: new Date(stamp).toISOString(), policy: '本人全量范围内的收支汇总', truncated: false,
    queryMeta: { version: 1, queryId: args.queryId, datasetId: args.datasetId,
      requestedScope: args.requestedScope || { startDate: args.scope.startDate, endDate: args.scope.endDate },
      effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate },
      filters: { direction: args.direction, text: args.filter }, sort: monthly ? 'monthAsc' : 'amountDesc',
      matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: summary.count,
      rowsComplete: true, summaryComplete: true, rankingComplete: !monthly,
      returnedDateRange: monthly ? null : { startDate: '2026-06-18', endDate: '2026-06-18' }, asOf: new Date(stamp).toISOString() } };
}
function scopedCardRead(args) {
  const summary = { income: '0.00', expense: '180.00', count: 3, incomeCount: 0, expenseCount: 3,
    unpricedCount: 0, currency: 'CNY' };
  return { datasetId: 'card-monthlyConsumption', domain: 'card', title: '卡片消费汇总',
    columns: [textColumn('name', '卡片'), textColumn('type', '类型'), money('amountCNY', '人民币支出'),
      numberColumn('count', '笔数'), numberColumn('unpricedCount', '未定价笔数')],
    rows: [{ name: '卡 A', type: '借记卡', amountCNY: '140.00', count: 2, unpricedCount: 0, cardId: privateCardIds[0] },
      { name: '卡 B', type: '借记卡', amountCNY: '40.00', count: 1, unpricedCount: 0, cardId: privateCardIds[1] }],
    summary, asOf: new Date(stamp).toISOString(), policy: '所选借记卡全量消费按人民币金额汇总', truncated: false,
    cardMonthlyQuery: { summary, matchedRowCount: 2, sort: args.sort, groupBy: args.groupBy, filter: args.filter } };
}
function taskInput(messages) {
  return JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:\n'))
    .content.slice('TASK_INPUT:\n'.length));
}

test.each(['card-first', 'finance-first'])('a mixed %s replay preserves independent scopes and the June follow-up through real encrypted previews', async order => {
  const utterance = '最近三个月哪张借记卡支出最高？同时看6月收支，给柱状图。';
  const card = call('query_data', { datasetId: 'card-monthlyConsumption', startDate: '2026-08-01', endDate: '2026-11-08',
    cardTypes: ['credit'], groupBy: 'cardMonth', sort: 'dateDesc' });
  const finance = call('query_data', { datasetId: 'finance-monthly', startDate: '2026-09-01', endDate: today });
  let chart;
  const finish = () => ({ role: 'assistant', content: JSON.stringify({ answer: '借记卡累计支出最高的是卡 A，140.00 元。6 月收入 100.00 元，支出 60.00 元。',
    proposal: null, proposals: null, clarification: null, chart }) });
  const f = fixture([order === 'card-first' ? batch(card, finance) : batch(finance, card), (_, messages) => {
    const results = payloads(messages), cardResult = results.find(item => item.datasets[0].domain === 'card');
    const financeResult = results.find(item => item.datasets[0].domain === 'finance');
    expect(cardResult.datasets[0].queryMeta).toMatchObject({ groupBy: 'card', sort: 'amountDesc',
      filters: { direction: 'expense', text: '', cardTypes: ['debit'] },
      effectiveScope: { startDate: '2026-09-01', endDate: today }, matchedRowCount: 2,
      returnedRowCount: 2, sourceRecordCount: 3, rowsComplete: true, rankingComplete: true });
    expect(financeResult.datasets[0].queryMeta).toMatchObject({ effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
      filters: { direction: 'both', text: '' }, sourceRecordCount: 2, returnedRowCount: 1, summaryComplete: true });
    expect(cardResult.datasets[0].rows[0].cardRef).toMatch(/^r_[a-f0-9]{32}$/);
    for (const cardId of privateCardIds) expect(JSON.stringify(results)).not.toContain(cardId);
    chart = { datasetId: 'finance-monthly', queryId: financeResult.datasets[0].queryMeta.queryId,
      type: 'bar', xKey: 'month', yKeys: ['income', 'expense'], title: '6 月收支' };
    return finish();
  }, finish, (_, messages) => {
    const input = taskInput(messages);
    expect(input.userTurns).toEqual([utterance, '支出最大的一笔']);
    expect(input.taskContext).toMatchObject({ subject: 'finance', metric: 'transaction-max',
      scope: { startDate: '2026-06-01', endDate: '2026-06-30' } });
    expect(input.taskContexts.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'cards', scope: { startDate: '2026-09-01', endDate: today }, cardTypes: ['debit'] }),
      expect.objectContaining({ subject: 'finance', scope: { startDate: '2026-06-01', endDate: '2026-06-30' } })]));
    expect(input.previousQueryCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ datasetId: 'card-monthlyConsumption', sourceRecordCount: 3,
        effectiveScope: { startDate: '2026-09-01', endDate: today } }),
      expect.objectContaining({ datasetId: 'finance-monthly', sourceRecordCount: 2,
        effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' } })]));
    expect(JSON.stringify(input)).not.toMatch(/r_[a-f0-9]{32}/);
    return call('query_data', { datasetId: 'finance-monthly', startDate: '2026-09-01', endDate: today });
  }, (_, messages, tools) => {
    // The changed single-transaction intent rejects monthly aggregation before SQL.
    // Correct the actual paired feedback rather than relying on dataset rewriting.
    expect(tools.length).toBeGreaterThan(0);
    const feedback = payloads(messages).at(-1);
    expect(feedback).toMatchObject({ status: 'error', code: 'AI_TOOL_ARGUMENT_INVALID', retryAllowed: true });
    expect(feedback.issues).toContainEqual({ path: 'datasetId', rule: 'dataset.intent.required', allowedValues: ['finance-transactions'] });
    return call('query_data', { datasetId: 'finance-transactions', direction: 'expense', sort: 'amountDesc' });
  }], { realPreviews: true });
  f.repository.query.mockImplementation(async (_, args) => ({ scope: args.scope, asOf: new Date(stamp).toISOString(),
    choices: { cards: [], categories: [], todos: [], funds: [], fixedAssets: [], moods: [] },
    datasets: [args.domain === 'card' ? scopedCardRead(args) : scopedFinanceRead(args)] }));
  const first = await f.send(utterance);
  expect(first.request.providerCalls).toBe(3); expect(first.datasets).toHaveLength(2);
  expect(first.answer).toContain('140.00'); expect(first.answer).toContain('100.00'); expect(first.answer).toContain('60.00');
  expect(first.chart).toMatchObject({ datasetId: 'finance-monthly', type: 'bar', xKey: 'month', yKeys: ['income', 'expense'] });
  expect(first.chart.title).toContain('2026-06-01 至 2026-06-30');
  const firstCard = first.datasets.find(dataset => dataset.domain === 'card');
  const cardTrace = first.toolTrace.find(trace => trace.domain === 'card');
  await expect(f.previews.resolve('offline-recovery-owner', cardTrace.previewId, firstCard.rows[0].cardRef, 'card'))
    .resolves.toBe(privateCardIds[0]);
  const next = await f.send('支出最大的一笔');
  expect(next.request.providerCalls).toBe(2); expect(next.datasets).toHaveLength(1);
  expect(next.datasets[0]).toMatchObject({ datasetId: 'finance-transactions',
    queryMeta: { effectiveScope: { startDate: '2026-06-01', endDate: '2026-06-30' },
      filters: { direction: 'expense', text: '' }, sort: 'amountDesc', rankingComplete: true } });
  expect(next.answer).toContain('2026-06-18'); expect(next.answer).toContain('60.00');
  expect(f.repository.query).toHaveBeenCalledTimes(3); expect(f.provider).toHaveBeenCalledTimes(5);
  expect(f.audits.filter(row => row.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.repository.query.mock.calls.filter(([, args]) => args.datasetId === 'finance-monthly')).toHaveLength(1);
  expect(f.previewRows.size).toBe(3);
  for (const row of f.previewRows.values()) {
    expect(row.payload).toMatch(/^enc\.v1:/); expect(row.approved_at).toBe(stamp); expect(row.request_id).toBeTruthy();
  }
  const cardArgs = f.repository.query.mock.calls.find(([, args]) => args.domain === 'card')[1];
  expect(cardArgs).toMatchObject({ scope: { startDate: '2026-09-01', endDate: today }, cardTypes: ['debit'],
    groupBy: 'card', sort: 'amountDesc', message: '最近三个月哪张借记卡支出最高？' });
  const financeArgs = f.repository.query.mock.calls.filter(([, args]) => args.domain === 'finance').map(([, args]) => args);
  expect(financeArgs[0]).toMatchObject({ scope: { startDate: '2026-06-01', endDate: '2026-06-30' }, message: '看6月收支，给柱状图。' });
  expect(financeArgs[1]).toMatchObject({ datasetId: 'finance-transactions', scope: { startDate: '2026-06-01', endDate: '2026-06-30' },
    direction: 'expense', sort: 'amountDesc', message: '支出最大的一笔' });
  noBusinessWrites(f);
});

test('a real preview allowlist failure remains terminal instead of requesting parameter recovery', async () => {
  const f = fixture([call('query_data', { datasetId: 'todo-events' }), final()], { realPreviews: true });
  const read = f.repository.query.getMockImplementation();
  f.repository.query.mockImplementation(async (...args) => {
    const result = await read(...args); result.datasets[0].columns.push(textColumn('unsafeField', '非白名单字段')); return result;
  });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.previewRows.size).toBe(0); noBusinessWrites(f);
});

test('real preview metadata rejects a dataset scope mismatch before approval or external disclosure', async () => {
  const f = fixture([call('query_data', { datasetId: 'finance-monthly' }), final()], { realPreviews: true });
  f.repository.query.mockImplementation(async (_, args) => {
    const dataset = scopedFinanceRead(args);
    dataset.queryMeta.effectiveScope = { startDate: '2026-09-01', endDate: today };
    return { scope: args.scope, asOf: new Date(stamp).toISOString(),
      choices: { cards: [], categories: [], todos: [], funds: [], fixedAssets: [], moods: [] }, datasets: [dataset] };
  });
  await expect(f.send('看6月收支')).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.previewRows.size).toBe(0); noBusinessWrites(f);
});

test.each(['card-first', 'finance-first'])('a mixed %s replay fills the requested June chart when final JSON has chart:null', async order => {
  const utterance = '最近三个月哪张借记卡支出最高？同时看6月收支，给柱状图。';
  const card = call('query_data', { datasetId: 'card-monthlyConsumption' });
  const finance = call('query_data', { datasetId: 'finance-monthly' });
  const emptyChartFinal = final('查询结果如下。');
  expect(JSON.parse(emptyChartFinal.content).chart).toBeNull();
  const f = fixture([(_, messages) => {
    expect(taskInput(messages).currentTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'cards', chartRequest: null }),
      expect.objectContaining({ subject: 'finance', chartRequest: { type: 'bar', metric: 'amount' },
        scope: { startDate: '2026-06-01', endDate: '2026-06-30' } })]));
    return order === 'card-first' ? batch(card, finance) : batch(finance, card);
  }, emptyChartFinal, emptyChartFinal], { realPreviews: true });
  f.repository.query.mockImplementation(async (_, args) => ({ scope: args.scope, asOf: new Date(stamp).toISOString(),
    choices: { cards: [], categories: [], todos: [], funds: [], fixedAssets: [], moods: [] },
    datasets: [args.domain === 'card' ? scopedCardRead(args) : scopedFinanceRead(args)] }));
  const result = await f.send(utterance);
  expect(result.request.providerCalls).toBe(3); expect(f.provider.mock.calls[2][2]).toEqual([]);
  expect(result.datasets).toHaveLength(2);
  const financeResult = result.datasets.find(dataset => dataset.datasetId === 'finance-monthly');
  expect(result.chart).toMatchObject({ datasetId: 'finance-monthly', queryId: financeResult.queryMeta.queryId,
    type: 'bar', xKey: 'month', yKeys: ['income', 'expense'] });
  expect(result.chart.title).toContain('2026-06-01 至 2026-06-30');
  expect(result.chart.title).not.toContain('2026-09-01');
  expect(result.answer).toContain('140.00'); expect(result.answer).toContain('100.00'); expect(result.answer).toContain('60.00');
  expect(f.repository.query).toHaveBeenCalledTimes(2); expect(f.previewRows.size).toBe(2);
  for (const row of f.previewRows.values()) {
    expect(row.payload).toMatch(/^enc\.v1:/); expect(row.approved_at).toBe(stamp); expect(row.request_id).toBeTruthy();
  }
  noBusinessWrites(f);
});

// Actual paid C03 native calls and successful data are loaded from a read-only snapshot.
const c03Actual=require('../fixtures/aiV3ChartToolRoleReplay.json');
const c03Calls=c03Actual.records.filter(row=>row.phase==='provider').sort((a,b)=>a.round-b.round);
const c03Data=c03Actual.records.find(row=>row.phase==='tool'&&row.tool==='query_data').result;
const c03Native=round=>({role:'assistant',content:c03Calls[round-1].content,tool_calls:structuredClone(c03Calls[round-1].toolCalls)});
const c03ChartFinal=()=>({role:'assistant',content:JSON.stringify({answer:'图仅代表本次返回的10笔收支明细，不代表6月全部流水。',
 proposal:null,proposals:null,clarification:null,chart:{datasetId:'finance-transactions',queryId:c03Data.datasets[0].queryMeta.queryId,type:'bar',xKey:'date',yKeys:['amountCNY'],title:'6月收支流水前10笔'}})});
const c03Message='延续刚才6月份收支流水明细，范围与收支方向不变，只展示前10笔，以每笔日期作横轴、人民币金额作纵轴给柱状图，说明图仅代表这10笔明细。';

test('actual C03 native chart-in-query error gets final-output guidance then completes with one legitimate read',async()=>{
 const f=fixture([c03Native(1),(_,messages)=>{
  const feedback=payloads(messages).at(-1);
  expect(feedback).toMatchObject({code:'AI_INVALID_INPUT',retryAllowed:true,issues:[{path:'chart',rule:'object.unknown'}]});
  expect(feedback.message).toContain('最终答复JSON');expect(feedback.message).toContain('query_data');
  expect(feedback.message).toContain('移除chart');expect(feedback.message).toContain('不要重复查询');
  return c03Native(2);
 },c03ChartFinal(),c03ChartFinal()]);
 f.repository.query.mockImplementation(async()=>structuredClone(c03Data));
 const result=await f.send(c03Message);
 expect(result.chart).toMatchObject({datasetId:'finance-transactions',queryId:c03Data.datasets[0].queryMeta.queryId,type:'bar',xKey:'date',yKeys:['amountCNY']});
 expect(result.datasets.find(d=>d.datasetId==='finance-transactions').rows).toHaveLength(10);
 expect(f.repository.query).toHaveBeenCalledTimes(1);expect(f.audits.filter(row=>row.phase==='tool-recovery')).toHaveLength(1);
 expect(f.provider.mock.calls.length).toBeLessThanOrEqual(4);noBusinessWrites(f);
});

test('actual repeated C03 chart-in-query round remains terminal without schema bypass or second recovery',async()=>{
 const f=fixture([c03Native(1),c03Native(2),c03Native(3),c03ChartFinal()]);
 f.repository.query.mockImplementation(async()=>structuredClone(c03Data));
 await expect(f.send(c03Message)).rejects.toMatchObject({code:'AI_INVALID_INPUT'});
 expect(f.provider).toHaveBeenCalledTimes(3);expect(f.repository.query).toHaveBeenCalledTimes(1);
 expect(f.audits.filter(row=>row.phase==='tool-recovery')).toHaveLength(1);noBusinessWrites(f);
});

test.each(['userId','sql','password'])('chart mixed with reserved %s never obtains recoverable field guidance',async field=>{
 const args=JSON.parse(c03Calls[0].toolCalls[0].function.arguments);args[field]='untrusted-value';
 const f=fixture([call('query_data',args),c03ChartFinal()]);
 await expect(f.send(c03Message)).rejects.toMatchObject({code:'AI_INVALID_INPUT'});
 expect(f.provider).toHaveBeenCalledTimes(1);expect(f.repository.query).not.toHaveBeenCalled();
 expect(f.audits.filter(row=>row.phase==='tool-recovery')).toHaveLength(0);noBusinessWrites(f);
});

test('actual wrong chart key cannot satisfy query/chart evidence and remains terminal',async()=>{
 const wrong=c03ChartFinal(),parsed=JSON.parse(wrong.content);parsed.chart.xKey='transDate';wrong.content=JSON.stringify(parsed);
 const f=fixture([c03Native(2),wrong,wrong,wrong]);f.repository.query.mockImplementation(async()=>structuredClone(c03Data));
 let failure;try{await f.send(c03Message);}catch(error){failure=error;}
 expect(failure).toMatchObject({code:'AI_QUERY_EVIDENCE_REQUIRED'});
 expect(f.repository.query).toHaveBeenCalledTimes(1);noBusinessWrites(f);
});

test('chart role feedback respects retryAllowed false and never repeats raw chart values',()=>{
 const {validateTool}=require('../../src/modules/ai/service/v3Tools');
 const {markToolParameterError,toolErrorFeedback}=require('../../src/modules/ai/service/toolRecovery');
 const args=JSON.parse(c03Calls[0].toolCalls[0].function.arguments);
 let failure;try{validateTool('query_data',args,today);}catch(error){failure=error;}
 markToolParameterError(failure);
 const feedback=toolErrorFeedback(failure,args,false);
 expect(feedback).toMatchObject({retryAllowed:false,issues:[{path:'chart',rule:'object.unknown'}]});
 expect(feedback.message).toContain('本轮不能继续取数');expect(feedback.message).not.toContain('移除chart并只纠正');
 expect(JSON.stringify(feedback)).not.toContain(args.chart.queryId);expect(JSON.stringify(feedback)).not.toContain(args.chart.xKey);
});

test('ordinary unknown-field feedback does not invent a chart correction',()=>{
 const {validateTool}=require('../../src/modules/ai/service/v3Tools');
 const {markToolParameterError,toolErrorFeedback}=require('../../src/modules/ai/service/toolRecovery');
 const args={datasetId:'finance-transactions',foo:'chart is only untrusted text'};
 let failure;try{validateTool('query_data',args,today);}catch(error){failure=error;}
 markToolParameterError(failure);const feedback=toolErrorFeedback(failure,args,true);
 expect(feedback.message).toBe('工具参数不符合该数据集能力，请只纠正标明字段。');
 expect(JSON.stringify(feedback)).not.toContain(args.foo);
});

test('query_data schema and native description keep final chart fields outside accepted tool arguments',()=>{
 const {definitions,validateTool}=require('../../src/modules/ai/service/v3Tools');
 const definition=definitions.find(item=>item.function.name==='query_data');
 expect(definition.function.parameters.additionalProperties).toBe(false);
 expect(definition.function.parameters.properties.chart).toBeUndefined();
 expect(definition.function.description).toContain('最终答复JSON');
 expect(()=>validateTool('query_data',JSON.parse(c03Calls[0].toolCalls[0].function.arguments),today)).toThrow(expect.objectContaining({code:'AI_INVALID_INPUT'}));
 const {SYSTEM_PROMPT}=require('../../src/modules/ai/service/v3Prompt');
 expect(SYSTEM_PROMPT).toContain('chart不是任何取数工具的参数');
 expect(SYSTEM_PROMPT).toContain('卡月走势可在最终答复JSON里填写chart');
});
