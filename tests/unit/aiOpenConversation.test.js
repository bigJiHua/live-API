jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live DB forbidden'); }) }));
const { fixture, calls, id } = require('../fixtures/aiV3MemoryFixture');
const { AiError } = require('../../src/modules/ai/service/errors');
const { CAPABILITY_CATALOG } = require('../../src/modules/ai/service/openConversation');
const plain = content => ({ role: 'assistant', content });
function setup(responses, { allowed = false, access = 'read', ...options } = {}) {
  const state = { allowed, access };
  const grants = { get: jest.fn(async () => ({ granted: state.allowed, access: state.access, providerHost: 'fixture.invalid' })),
    requireCoverage: jest.fn(async (_, domains, host, control = {}) => {
      if (!control.conversationId) return;
      if (!state.allowed || control.access === 'operate' && state.access !== 'operate') {
        const error = new AiError('需要授权', 403, 'AI_GRANT_REQUIRED');
        error.authorizationRequest = { version: 1, conversationId: control.conversationId, providerHost: host,
          access: control.access, reason: control.reason || '读取脱敏数据进行分析', expiresAt: 1900000000000 };
        throw error;
      }
    }) };
  const memoryStore = { list: jest.fn(async () => ({ files: [], warnings: [] })), write: jest.fn(), read: jest.fn() };
  const f = fixture(responses, { grants, memoryStore, ...options });
  const send = (message = '聊聊收支', mode = 'analysis', emit) => f.service.chat('offline-memory-owner', { requestId: id(), message, mode, conversationId: f.conversationId, consent: true }, emit);
  return { ...f, send, grants, authState: state, memoryStore };
}
test.each(['chat', 'analysis', 'operate'])('every mode advertises the complete capability catalog before data authorization: %s', async mode => {
  const response = mode === 'operate' ? plain(JSON.stringify({ answer: '你好', proposal: null })) : plain('你好，可以一起聊聊。');
  const f = setup([response]); await f.send('你好', mode);
  const input = JSON.parse(f.provider.mock.calls[0][1].find(item => item.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:\n'.length));
  expect(input.capabilityCatalog).toEqual(CAPABILITY_CATALOG); expect(input.authorization.granted).toBe(false);
  expect(f.provider.mock.calls[0][2].map(tool => tool.function.name)).toContain('request_authorization');
  expect(JSON.stringify(f.provider.mock.calls[0][1])).not.toContain(f.conversationId);
  expect(f.memoryStore.list).not.toHaveBeenCalled(); expect(f.repository.query).not.toHaveBeenCalled();
});
test('unapproved provider reads stop before SQL and push a capability request with no month or domain restriction', async () => {
  const f = setup([calls('query_data', { datasetId: 'finance-monthly' })]);
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED', authorizationRequest: { access: 'read', conversationId: f.conversationId } });
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.memoryStore.list).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure.mock.calls[0][2].authorizationRequest).not.toHaveProperty('domains');
});
test('authorized analysis preserves computations and suggestions without fixed summaries or business artifacts', async () => {
  const text = '收入增长值得关注。假设每月留出1000元，三个月可以积累3000元；这是一种规划，不是已经发生的流水。';
  const f = setup([calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-04-01', endDate: '2026-05-31' }), plain(text),
    calls('calculate', { expression: '1000*3', mode: 'money' }), plain(text)], { allowed: true });
  f.raw.datasets = [{ datasetId: 'finance-monthly', domain: 'finance', title: '收支', columns: [{ key: 'month', label: '月份', type: 'date' }, { key: 'income', label: '收入', type: 'money' }, { key: 'expense', label: '支出', type: 'money' }],
    rows: [{ month: '2026-04', income: '200.00', expense: '100.00' }], summary: { income: '200.00', expense: '100.00', currency: 'CNY' }, policy: '合成数据', asOf: '2026-11-08T13:22:14Z' }];
  const result = await f.send('看看四五月的收支并给我建议');
  expect(result.answer).toContain(text); expect(result.mode).toBe('analysis'); expect(result).not.toHaveProperty('draft');
  expect(f.provider.mock.calls[1][3].json).toBe(false);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.memoryStore.write).not.toHaveBeenCalled();
});
test('analysis can request supporting dates outside its initial question without being pinned to that question', async () => {
  const f = setup([calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-04-01', endDate: '2026-05-31' }),
    calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-01-01', endDate: '2026-03-31' }), plain('可以比较两个时段。')], { allowed: true });
  f.raw.datasets = [{ datasetId: 'finance-monthly', domain: 'finance', title: '收支', columns: [{ key: 'month', label: '月份', type: 'date' }], rows: [], summary: {},
    policy: '合成数据', asOf: '2026-11-08T13:22:14Z' }];
  await f.send('分析四五月收支');
  expect(f.repository.query.mock.calls.map(([, args]) => args.scope.startDate)).toEqual(['2026-04-01', '2026-01-01']);
});
test('analysis memory writes request an operation upgrade before touching storage', async () => {
  const f = setup([calls('memory_write', { operation: 'replace', path: 'notes/example.md', title: '示例', type: 'profile', content: '示例', evidence: { sourceTurn: 0, quote: '示例' } })], { allowed: true });
  await expect(f.send('记住这个示例')).rejects.toMatchObject({ authorizationRequest: { access: 'operate' } });
  expect(f.memoryStore.write).not.toHaveBeenCalled();
});
test('a provider can explicitly request authorization, while grant requests never create permissions themselves', async () => {
  const f = setup([calls('request_authorization', { access: 'read', reason: '比较不同月份的收支' })]);
  await expect(f.send()).rejects.toMatchObject({ authorizationRequest: { reason: '比较不同月份的收支' } });
  expect(f.authState.allowed).toBe(false); expect(f.repository.query).not.toHaveBeenCalled();
});
test('read-only output containing a forged proposal cannot create a draft or operation panel', async () => {
  const f = setup([plain(JSON.stringify({ answer: '尝试创建', proposal: { kind: 'todo.create', fields: { content: '伪造' } } }))], { allowed: true });
  const result = await f.send('聊聊待办');
  expect(result).not.toHaveProperty('proposal'); expect(result).not.toHaveProperty('draft');
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});
test('revocation between the data read and the next provider call stops re-disclosure', async () => {
  const f = setup([calls('list_choices', { domain: 'finance' }), plain('不应被调用')], { allowed: true });
  const read = f.repository.query.getMockImplementation();
  f.repository.query.mockImplementation(async (...args) => { const result = await read(...args); f.authState.allowed = false; return result; });
  await expect(f.send()).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(f.provider).toHaveBeenCalledTimes(1);
});
test.each(['chat', 'analysis'])('a fabricated completed-ledger claim in %s mode fails instead of being persisted', async mode => {
  const f = setup([plain('我已经帮你完成入账，账本已更新。')], { allowed: true });
  await expect(f.send('帮我记一笔', mode)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure.mock.calls[0][2]).toMatchObject({ errorCode: 'AI_RESULT_CLAIM_MISMATCH' });
});

test.each(['chat', 'analysis'])('the audited ledger paraphrase cannot be saved as a successful %s conversation', async mode => {
  const f = setup([plain('这笔款项已经写进账簿，余额也变了。')], { allowed: true });
  await expect(f.send('你好', mode)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure.mock.calls[0][2]).toMatchObject({ errorCode: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
});

test.each([
  '昨天这笔款项已经写进账簿，余额也变了。',
  '你昨天已经把这笔款项写进账簿。',
  '这笔款项还没有写进账簿，余额没有变。',
  '如果这笔款项已经写进账簿，就应该查看原回执。',
])('qualified ledger facts retain their wording and server outcome through successful persistence: %s', async text => {
  const f = setup([plain(text)], { allowed: true });
  const result = await f.send('讨论这笔已发生的记录', 'analysis');
  expect(result.answer).toBe(text);
  expect(result.operationOutcome).toMatchObject({ version: 1, state: 'none', formalWriteExecuted: false, artifacts: [] });
  expect(f.state.conversationStore.append.mock.calls[0][2].business.operationOutcome).toEqual(result.operationOutcome);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3].operationOutcome).toEqual(result.operationOutcome);
});
test('analysis keeps conditional, historical and negative ledger wording', async () => {
  const text = '确认后可以入账；此前已有入账记录；本次没有执行入账。';
  const f = setup([plain(text)], { allowed: true });
  const result = await f.send('这笔能入账吗', 'analysis');
  expect(result.answer).toContain(text); expect(result).not.toHaveProperty('draft');
});
test('analysis replaces an unsupported long-term memory claim with the reconciled wording', async () => {
  const f = setup([plain('已保存到长期记忆。')], { allowed: true });
  const result = await f.send('记住我喜欢简洁', 'analysis');
  expect(result.answer).toContain('本轮未保存到长期记忆');
  expect(result.answer).not.toContain('已保存到长期记忆');
});

const markdownArticle = '# 夏天的来信\n\n我记住了那个夏天。\n我已经修改文章。\n\n[参考](https://example.org/essay?q=summer)\n\n联系：writer@example.org\n编号：123456789012345678901234567890\n\n```js\nconst greeting = "hello";\n  console.log(greeting);\n```\n\n末尾。\n';

test.each(['chat', 'analysis'])('no-tool Markdown writing preserves source text through result, archive, receipt and future model context: %s', async mode => {
  const f = setup([plain(markdownArticle), plain('继续写。')]);
  const prompt = '请直接写一篇 MD 散文，参考 https://example.org/essay，联系 writer@example.org，示例编号 123456789012345678901234567890，不查询我的数据。';
  const result = await f.send(prompt, mode);
  expect(result.answer).toBe(markdownArticle);
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(markdownArticle);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3].answer).toBe(markdownArticle);
  expect(f.history.find(item => item.role === 'assistant').content).toBe(markdownArticle);
  expect(result.operationOutcome).toMatchObject({ state: 'none', formalWriteExecuted: false, artifacts: [] });
  expect(result.datasets).toEqual([]); expect(result.toolTrace).toEqual([]);
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.memoryStore.list).not.toHaveBeenCalled();
  expect(f.memoryStore.write).not.toHaveBeenCalled(); expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();
  expect(f.provider).toHaveBeenCalledTimes(1);
  const input = JSON.parse(f.provider.mock.calls[0][1][1].content.slice('TASK_INPUT:\n'.length));
  expect(input.mode).toBe(mode); expect(input.userTurns.at(-1)).toBe(prompt);
  expect(input.responsePolicy).toEqual({ routing: 'choose-tools-from-scene-and-request',
    validation: 'server-observed-tools-and-artifacts', plainText: 'preserve-markdown', dataAccess: 'requires-authorization' });
  await f.send('继续写', mode);
  expect(JSON.stringify(f.provider.mock.calls[1][1])).toContain('writer@example.org');
  expect(JSON.stringify(f.provider.mock.calls[1][1])).toContain('123456789012345678901234567890');
});

test('plain writing still hides configured credentials and the actual owner/conversation IDs', async () => {
  const f = setup([(_config, messages) => {
    const task = JSON.stringify(messages);
    expect(task).not.toContain('fixture-only'); expect(task).not.toContain('offline-memory-owner');
    expect(task).not.toContain(f.conversationId);
    return plain(`# 文章\nfixture-only offline-memory-owner ${f.conversationId}\nwriter@example.org 12345678901234567890`);
  }]);
  const result = await f.send(`写文章 fixture-only offline-memory-owner ${f.conversationId}`, 'chat');
  expect(result.answer).not.toContain('fixture-only'); expect(result.answer).not.toContain('offline-memory-owner');
  expect(result.answer).not.toContain(f.conversationId);
  expect(result.answer).toContain('writer@example.org 12345678901234567890');
});

test('an exactly 12000-character article is saved intact', async () => {
  const text = '文'.repeat(12000), f = setup([plain(text)]);
  const result = await f.send('写文章', 'chat'); expect(result.answer).toBe(text);
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(text);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3].answer).toBe(text);
});

test('an oversized article fails explicitly before successful archive/receipt persistence', async () => {
  const text = '文'.repeat(12000) + '结尾', f = setup([plain(text)]);
  await expect(f.send('写文章', 'chat')).rejects.toMatchObject({ code: 'AI_ANSWER_TOO_LONG' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
  expect(f.state.conversationStore.appendFailure.mock.calls[0][2]).toMatchObject({ errorCode: 'AI_ANSWER_TOO_LONG' });
});

test('a failed business-query attempt cannot downgrade subsequent prose checks', async () => {
  const f = setup([calls('query_data', { datasetId: 'invented-dataset' }), plain('我已经修改文章。')], { allowed: true });
  await expect(f.send('分析一下', 'analysis')).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test.each(['query_data', 'list_choices'])('actual business tool selection activates existing private-text rules: %s', async tool => {
  const text = 'https://example.org writer@example.org 12345678901234567890';
  const args = tool === 'query_data' ? { datasetId: 'finance-monthly' } : { domain: 'finance' };
  const f = setup([calls(tool, args), plain(text)], { allowed: true });
  if (tool === 'query_data') f.raw.datasets = [{ datasetId: 'finance-monthly', domain: 'finance', title: '合成收支',
    columns: [{ key: 'month', label: '月份', type: 'date' }], rows: [{ month: '2026-11' }], summary: {},
    policy: '合成数据', asOf: '2026-11-08T13:22:14Z' }];
  const result = await f.send('分析一下', 'analysis');
  expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(result.answer).not.toMatch(/example\.org|12345678901234567890/);
  expect(result.answer).toContain('[链接已隐藏]');
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3].answer).toBe(result.answer);
});

test.each(['memory_list', 'history_search'])('context reads keep literary expressions but apply private-text rules: %s', async tool => {
  const args = tool === 'memory_list' ? {} : { query: '以前', limit: 5 };
  const text = '我记住了那个夏天。\n我已经修改文章。\nwriter@example.org 12345678901234567890';
  const f = setup([calls(tool, args), plain(text)], { allowed: true });
  const result = await f.send('找找过去的文字', 'chat');
  expect(result.answer).toContain('我记住了那个夏天。\n我已经修改文章。');
  expect(result.answer).not.toMatch(/writer@example\.org|12345678901234567890/);
  expect(f.repository.query).not.toHaveBeenCalled();
});

test('failed context-tool arguments retain private-text rules without pretending data was read', async () => {
  const f = setup([calls('memory_read', { path: 'notes/example.md', offset: -1 }), plain('未读到记忆。\nwriter@example.org 12345678901234567890')], { allowed: true });
  const result = await f.send('读取记忆', 'chat');
  expect(f.memoryStore.read).not.toHaveBeenCalled();
  expect(result.answer).toContain('未读到记忆。'); expect(result.answer).not.toContain('writer@example.org');
});

test('an existing authorization can be acknowledged without treating it as a data read', async () => {
  const text = '# 随笔\nwriter@example.org 12345678901234567890';
  const f = setup([calls('request_authorization', { access: 'read', reason: '读取数据前确认' }), plain(text)], { allowed: true });
  const result = await f.send('写随笔', 'chat'); expect(result.answer).toBe(text);
  expect(f.repository.query).not.toHaveBeenCalled(); expect(f.memoryStore.list).not.toHaveBeenCalled();
});

test('unrecognized tools fail before SQL, successful persistence or reasoning release', async () => {
  const f = setup([calls('invented_tool', {})]), events = [];
  await expect(f.send('聊聊', 'chat', (event, data) => events.push({ event, data }))).rejects.toBeDefined();
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
});

test('model-supplied routing flags cannot suppress formal-effect checks', async () => {
  const f = setup([plain(JSON.stringify({ requires_data: false, claimsScope: 'prose' }) + '\n这笔款项已经写进账簿，余额也变了。')]);
  await expect(f.send('你好', 'chat')).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});

test('private-data answer length cannot expose a split configured credential in result, history or receipt', async () => {
  const secret = 'credentialBoundaryLongSecret0123456789';
  const f = setup([calls('list_choices', { domain: 'finance' }), plain('文'.repeat(11996) + secret + '\nend')], { allowed: true });
  f.state.config.apiKey = secret;
  const result = await f.send('分析一下', 'analysis');
  expect(result.answer).not.toContain(secret.slice(0, 4));
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(result.answer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3].answer).toBe(result.answer);
});

test.each(['我已经支付了高昂的代价。', '我已经转账到他心里的孤岛。'])('literary money metaphors survive the full no-tool writing pipeline: %s', async text => {
  const f = setup([plain(text)]); const result = await f.send('写散文', 'chat'); expect(result.answer).toBe(text);
  expect(f.state.conversationStore.append.mock.calls[0][2].answer).toBe(text);
});

test.each(['我已经转账给张三。', '我已经支付了一百元。', '你的账户余额已经更新。', '我已经删除餐饮分类。'])('a plain scene cannot claim formal effects without actual receipts: %s', async text => {
  const f = setup([plain(text)]);
  await expect(f.send('你好', 'chat')).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(f.state.conversationStore.append).not.toHaveBeenCalled(); expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();
});

test.each(['query_data', 'memory_list', 'request_authorization'])('authorization rejection prevents data access and buffered reasoning publication: %s', async tool => {
  const args = tool === 'query_data' ? { datasetId: 'finance-monthly' }
    : tool === 'request_authorization' ? { access: 'read', reason: '读取数据' } : {};
  const f = setup([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '正在检查数据。' }); return calls(tool, args);
  }]), events = [];
  await expect(f.send('查一下', 'analysis', (event, data) => events.push({ event, data }))).rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(f.provider).toHaveBeenCalledTimes(1); expect(f.repository.query).not.toHaveBeenCalled(); expect(f.memoryStore.list).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled(); expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
});

test('tilde Markdown examples remain literal source while direct prose still checks actual effects', async () => {
  const text = '# 示例\n\n~~~text\n我已入账。\n已保存到长期记忆。\n~~~\n\n这里只是状态文案例子。';
  const f = setup([plain(text)]); const result = await f.send('写MD例子', 'chat'); expect(result.answer).toBe(text);
});

// 追加172：闲聊/分析模式放开服务端派生 chart（wantsChart relaxed 分支）。模型仍不提交 chart，
// 图表只从真实数据集派生并经 validateChart fail-closed 校验。
const chartQueryId = 'q_' + 'a'.repeat(24);
const monthlyDataset = rows => ({ datasetId: 'finance-monthly', domain: 'finance', title: '收支',
  columns: [{ key: 'month', label: '月份', type: 'date' }, { key: 'income', label: '收入', type: 'money' }, { key: 'expense', label: '支出', type: 'money' }],
  rows, summary: rows.length ? { income: '460.00', expense: '330.00', currency: 'CNY' } : {},
  queryMeta: { version: 1, queryId: chartQueryId, datasetId: 'finance-monthly',
    requestedScope: { startDate: '2026-06-01', endDate: '2026-11-08' }, effectiveScope: { startDate: '2026-06-01', endDate: '2026-11-08' },
    filters: { direction: 'both', text: '' }, sort: 'monthAsc',
    matchedRowCount: rows.length, returnedRowCount: rows.length, sourceRecordCount: rows.length,
    rowsComplete: true, summaryComplete: rows.length > 0, rankingComplete: false, returnedDateRange: null,
    asOf: '2026-11-08T13:22:14Z' },
  policy: '合成数据', asOf: '2026-11-08T13:22:14Z' });

test('chat-mode chart wording derives a server-side bar chart from the real finance-monthly dataset', async () => {
  const f = setup([calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-11-08' }),
    plain('最近几个月收支总体平稳。')], { allowed: true });
  f.raw.datasets = [monthlyDataset([{ month: '2026-09', income: '200.00', expense: '150.00' }, { month: '2026-10', income: '260.00', expense: '180.00' }])];
  const result = await f.send('画个柱状图看看最近六个月的收支', 'chat');
  expect(result.mode).toBe('chat');
  expect(result.chart).toMatchObject({ datasetId: 'finance-monthly', type: 'bar', xKey: 'month', yKeys: ['income', 'expense'], queryId: chartQueryId });
  expect(result.chart.title).toBe('收支（2026-06-01 至 2026-11-08）');
  expect(result.datasets).toHaveLength(1);
  expect(f.state.conversationStore.append.mock.calls[0][2].business.chart).toEqual(result.chart);
});

test('chart wording with no drawable rows keeps the answer and appends the zero-row notice', async () => {
  const f = setup([calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-11-08' }),
    plain('这个范围还没有记录。')], { allowed: true });
  f.raw.datasets = [monthlyDataset([])];
  const result = await f.send('画个柱状图看看最近六个月的收支', 'chat');
  expect(result.chart).toBeNull();
  expect(result.answer).toContain('本轮查询没有可绘制的记录，未生成图表。');
  expect(result.answer).toContain('这个范围还没有记录。');
});

test.each(['chat', 'analysis'])('relaxed turns without chart wording stay chart-free: %s', async mode => {
  const f = setup([calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-11-08' }),
    plain('最近几个月收支总体平稳。')], { allowed: true });
  f.raw.datasets = [monthlyDataset([{ month: '2026-10', income: '260.00', expense: '180.00' }])];
  const result = await f.send('看看最近六个月的收支', mode);
  expect(result.chart).toBeNull();
  expect(result.datasets).toHaveLength(1);
});

const markdownDataCharts = [
  ['xychart-beta', '以下图表使用你提供的示例数字。\n\n```mermaid\nxychart-beta\n  title "示例变化"\n  x-axis ["一月", "二月"]\n  y-axis "数量" 0 --> 20\n  bar [10, 20]\n```'],
  ['pie', '以下图表使用你提供的示例数字。\n\n```mermaid\npie title 示例构成\n  "甲" : 10\n  "乙" : 20\n```'],
];
test.each(['chat', 'analysis'].flatMap(mode => markdownDataCharts.map(([type, answer]) => [mode, type, answer])))
('no-tool %s Markdown %s chart remains model prose through response, archive and recovery', async (mode, type, answer) => {
  const f = setup([plain(answer)]);
  const result = await f.send('使用我给定的示例数字10和20画图，不查询我的数据。', mode);
  expect(result.answer).toBe(answer);
  expect(result.chart).toBeNull();
  expect(result.datasets).toEqual([]);
  expect(result.toolTrace).toEqual([]);
  expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append.mock.calls[0][2]).toMatchObject({ answer, business: { chart: null } });
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toMatchObject({ answer, chart: null });
});

test('verified business chart and model Markdown Mermaid chart coexist without changing dataset references', async () => {
  const answer = '下图依据本轮取数中的两个月收入，属于正文分析图。\n\n```mermaid\npie title 月收入构成\n  "九月" : 200\n  "十月" : 260\n```';
  const f = setup([calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-11-08' }),
    plain(answer)], { allowed: true });
  f.raw.datasets = [monthlyDataset([{ month: '2026-09', income: '200.00', expense: '150.00' }, { month: '2026-10', income: '260.00', expense: '180.00' }])];
  const result = await f.send('画个柱状图看看最近六个月的收支，也在正文用Mermaid说明收入构成。', 'analysis');
  expect(result.answer).toBe(answer);
  expect(result.chart).toMatchObject({ datasetId: 'finance-monthly', queryId: chartQueryId, type: 'bar', xKey: 'month', yKeys: ['income', 'expense'] });
  expect(result.datasets[0].rows).toEqual(f.raw.datasets[0].rows);
  expect(f.state.conversationStore.append.mock.calls[0][2]).toMatchObject({ answer, business: { chart: result.chart } });
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toMatchObject({ answer, chart: result.chart });
});

test('all chart prompts allow model Markdown data charts while retaining the verified business chart contract', () => {
  const { OPEN_SYSTEM_PROMPT, OPEN_FINALIZE_PROMPT } = require('../../src/modules/ai/service/openConversation');
  const { SYSTEM_PROMPT, FINALIZE_PROMPT } = require('../../src/modules/ai/service/v3Prompt');
  const { definitions } = require('../../src/modules/ai/service/v3Tools');
  const queryTool = definitions.find(tool => tool.function.name === 'query_data');
  for (const prompt of [OPEN_SYSTEM_PROMPT, OPEN_FINALIZE_PROMPT, SYSTEM_PROMPT, FINALIZE_PROMPT, queryTool.function.description]) {
    expect(prompt).toContain('xychart-beta');
    expect(prompt).toContain('pie');
    expect(prompt).toContain('模型生成内容');
    expect(prompt).not.toContain('不用mermaid的xychart');
    expect(prompt).not.toContain('不在answer正文里画');
  }
  expect(SYSTEM_PROMPT).toContain('业务chart仍只引用本轮真实取数');
  expect(queryTool.function.description).toContain('queryMeta.queryId和columns.key');
});
