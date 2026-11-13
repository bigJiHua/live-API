// Cached business queries cannot produce new evidence. Verify the real V3
// orchestration closes only all-cache business batches, with the real guard.
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Public DB forbidden in cache finalization replay'); }),
  getConnection: jest.fn(() => { throw new Error('Public DB forbidden in cache finalization replay'); }),
}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({
  deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden in cache finalization replay'); }),
}));
const publicDb = require('../../src/common/config/db');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const { fixture, final, calls, now, id } = require('../fixtures/aiV3MemoryFixture');
const batch = (...messages) => ({ role: 'assistant', content: null, tool_calls: messages.flatMap(message => message.tool_calls) });
const choice = args => calls('list_choices', { domain: 'finance', ...args });
const noMemory = () => ({ list: jest.fn(async () => ({ files: [], count: 0, warnings: [] })) });
function guarded(responses, options = {}) {
  const f = fixture(responses, { memoryStore: noMemory(), ...options });
  const guard = createMemoryRequestGuard({ clock: () => now().getTime() });
  f.state.requestGuard = { ...guard,
    saveV3Recovery: async (_connection, userId, requestId, result) => guard.saveV3Recovery(guard.fixtureExecutor, userId, requestId, result) };
  return { ...f, guard };
}
afterEach(() => {
  expect(publicDb.execute).not.toHaveBeenCalled(); expect(publicDb.getConnection).not.toHaveBeenCalled();
  expect(deepseekChat).not.toHaveBeenCalled();
});
test('an all-cache multi-call batch pairs every result before one tool-free finalization', async () => {
  const fresh = batch(choice({ filter: '农业' }), choice({ filter: '示例' }));
  const cached = batch(choice({ filter: '农业' }), choice({ filter: '示例' }));
  const f = guarded([fresh, cached, final({ answer: '候选已读取。' })]);
  const result = await f.send('查看账户候选');
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.repository.query).toHaveBeenCalledTimes(2);
  expect(result.request.providerCalls).toBe(3);
  const [_, sent, tools, options] = f.provider.mock.calls[2];
  expect(tools).toEqual([]); expect(options).toMatchObject({ json: true, toolChoice: 'none' });
  const assistantBatch = sent.findLast(message => message.role === 'assistant' && message.tool_calls);
  const responses = sent.filter(message => message.role === 'tool');
  expect(responses).toHaveLength(4);
  for (const call of assistantBatch.tool_calls) expect(responses.filter(message => message.tool_call_id === call.id)).toHaveLength(1);
  expect(JSON.parse(responses[2].content).choices).toEqual(JSON.parse(responses[0].content).choices);
  expect(JSON.parse(responses[3].content).choices).toEqual(JSON.parse(responses[1].content).choices);
});
test('a cached and fresh batch keeps querying and does not prematurely finalize', async () => {
  const f = guarded([choice({ filter: '农业' }), batch(choice({ filter: '农业' }), choice({ filter: '示例' })),
    choice({ filter: '信用' }), final({ answer: '读取完成。' })]);
  await f.send('查看账户候选');
  expect(f.provider).toHaveBeenCalledTimes(5);
  expect(f.repository.query).toHaveBeenCalledTimes(3);
  expect(f.provider.mock.calls[2][2].length).toBeGreaterThan(0);
  expect(f.provider.mock.calls[2][3].json).toBe(false);
  expect(f.provider.mock.calls[4][2]).toEqual([]);
});
test('a tool call returned during cache-triggered finalization remains rejected', async () => {
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const f = guarded([choice({}), choice({}), choice({ filter: 'new-read' })]);
    await expect(f.send('查看账户候选')).rejects.toMatchObject({ code: 'AI_LOOP_BLOCKED', providerCalls: 3 });
    expect(f.provider).toHaveBeenCalledTimes(3);
    expect(f.repository.query).toHaveBeenCalledTimes(1);
    expect(f.provider.mock.calls[2][2]).toEqual([]);
  } finally { quiet.mockRestore(); }
});
test('revoked domain capability before finalization blocks the next provider call', async () => {
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let f;
    f = guarded([choice({}), () => {
      f.state.businessPolicy.domains = f.state.businessPolicy.domains.filter(domain => domain !== 'finance');
      return choice({});
    }, final({ answer: '不能外发。' })]);
    await expect(f.send('查看账户候选')).rejects.toMatchObject({ code: 'AI_SCOPE_DENIED', providerCalls: 2 });
    expect(f.provider).toHaveBeenCalledTimes(2);
    expect(f.repository.query).toHaveBeenCalledTimes(1);
  } finally { quiet.mockRestore(); }
});
test.each(['memory_list', 'history_search'])('%s cached-only batches preserve native context-tool continuation', async name => {
  const memory = noMemory();
  const historyReader = { loadSummary: jest.fn(async () => null), search: jest.fn(async () => []) };
  const args = name === 'history_search' ? { query: '偏好' } : {};
  const followup = name === 'history_search' ? { query: '背景' } : { offset: 1 };
  const f = guarded([calls(name, args), calls(name, args), calls(name, followup), final({ answer: '已读取。' })],
    { memoryStore: memory, historyReader });
  await f.send('读取我的偏好');
  expect(f.provider).toHaveBeenCalledTimes(5);
  expect(f.provider.mock.calls[2][2].length).toBeGreaterThan(0);
  expect(f.provider.mock.calls[2][3].json).toBe(false);
  expect(f.repository.query).not.toHaveBeenCalled();
});
test('completed cache-finalization receipts replay without more provider calls', async () => {
  const f = guarded([choice({}), choice({}), final({ answer: '候选已读取。' })]);
  const requestId = id();
  const request = { requestId, message: '查看账户候选', conversationId: f.conversationId, consent: true };
  const result = await f.service.chat('offline-memory-owner', request);
  expect((await f.guard.get('offline-memory-owner', requestId)).result.answer).toBe(result.answer);
  const replayed = await f.service.chat('offline-memory-owner', request);
  expect(replayed.answer).toBe(result.answer);
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(f.repository.query).toHaveBeenCalledTimes(1);
});
