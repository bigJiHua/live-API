const { createCallLogStore } = require('../../src/modules/ai/service/callLog');
const flush = () => new Promise(resolve => setImmediate(resolve));
test('large audit request remains valid bounded JSON with useful round metadata', async () => {
  const rows = [], executor = { execute: jest.fn(async (_sql, params) => { rows.push(params); return [{ affectedRows: 1 }]; }) };
  const store = createCallLogStore({ executor });
  store.record({ userId: 'fixture-owner', phase: 'provider', request: { round: 3, finalRound: false, maxTokens: 4096,
    messages: [{ role: 'system', content: 'fixed' }, { role: 'tool', content: '中'.repeat(50000) }], tools: [],
    apiKey: 'synthetic-secret' }, response: { diagnostics: { responseBytes: 262145, finishReason: null, streamStage: 'receiving' } } });
  await flush();
  const request = JSON.parse(rows[0][9]);
  expect(Buffer.byteLength(rows[0][9])).toBeLessThanOrEqual(64 * 1024);
  expect(request).toMatchObject({ truncated: true, summary: { round: 3, finalRound: false, maxTokens: 4096,
    messageCount: 2, roles: { system: 1, tool: 1 } } });
  expect(rows[0][9]).not.toContain('synthetic-secret');
  expect(JSON.parse(rows[0][10]).diagnostics.responseBytes).toBe(262145);
});
