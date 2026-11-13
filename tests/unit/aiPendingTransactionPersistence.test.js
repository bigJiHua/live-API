jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getConnection: jest.fn() }));
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { buildPendingTransactionContext, clearPendingTransactionContext, TTL_MS } = require('../../src/modules/ai/service/pendingTransactions');
const recorded = require('../helpers/aiAmountFailureRecorded.json');
const conversationId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-11-08T12:54:06Z').getTime();
function pending() {
  const proposals = JSON.parse(recorded.packets[2].content).proposals;
  return buildPendingTransactionContext({ conversationId, turnId, now,
    userTurns: recorded.userTurns, userTurnDates: recorded.userTurns.map(() => recorded.sourceDate),
    transactions: proposals.map(item => ({ fields: item.fields,
      evidence: { sourceTurn: 2, quote: recorded.userTurns[2] }, missingFields: ['账户'] })) });
}

test('pending intent survives persisted conversation restoration without creating a draft link', async () => {
  let savedMeta;
  const conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    execute: jest.fn(async (sql, params) => {
      if (sql.startsWith('SELECT id FROM ai_conversation')) return [[{ id: conversationId }]];
      if (sql.includes("'assistant'")) savedMeta = JSON.parse(params[4]);
      return [{ affectedRows: 1 }];
    }) };
  const executor = { getConnection: jest.fn(async () => conn), execute: jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT id, latest_draft_id')) return [[{ id: conversationId, latest_draft_id: null }]];
    if (sql.startsWith('SELECT id, role')) return [[{ id: 20, role: 'assistant', content: '请确认账户',
      meta: savedMeta, created_at: new Date(now) }]];
    if (sql.startsWith('SELECT id, meta')) {
      expect(params).toEqual([conversationId, 'owner']);
      expect(sql).toContain('user_id = ?');
      expect(sql).toContain("'$.sentAt'");
      expect(sql).toContain('DESC, id DESC LIMIT 1');
      return [[{ id: 20, meta: savedMeta }]];
    }
    throw new Error('Unexpected offline persistence SQL');
  }) };
  await createConversationStore({ executor, now: () => now }).append('owner', conversationId, {
    message: recorded.userTurns[2], answer: '请确认账户', requestId: turnId, business: { pendingTransactions: pending() },
  });
  expect(savedMeta.business.pendingTransactions.items).toHaveLength(3);
  expect(JSON.stringify(savedMeta.business.pendingTransactions)).not.toMatch(/fixture-category|accountRef|categoryRef/);
  const updates = conn.execute.mock.calls.filter(([sql]) => sql.startsWith('UPDATE ai_conversation'));
  expect(updates[0][1][0]).toBeNull();
  // A fresh store instance reads durable metadata, including when original prose has left the history window.
  const restoredStore = createConversationStore({ executor, now: () => now + 1000 });
  const reopened = await restoredStore.open('owner', conversationId);
  expect(reopened.history[0].pendingTransactions.items.map(item => item.fields.amount)).toEqual(['30.82', '20.40', '123.60']);
  const restored = await restoredStore.loadPendingTransactionContext('owner', conversationId);
  expect(restored.sources[0]).toEqual({ text: recorded.userTurns[2], sourceDate: '2026-11-08', order: 0 });
});

test.each(['cleared', 'expired', 'other-conversation'])('the newest %s marker cannot revive an older pending batch', async status => {
  const marker = status === 'cleared' ? clearPendingTransactionContext({ conversationId, turnId, now }) : pending();
  if (status === 'other-conversation') marker.conversationId = turnId;
  const executor = { execute: jest.fn(async () => [[{ id: 30, meta: { business: { pendingTransactions: marker } } }]]) };
  const store = createConversationStore({ executor, now: () => status === 'expired' ? now + TTL_MS : now });
  const value = await store.loadPendingTransactionContext('owner', conversationId);
  expect(value?.status || null).toBe(status === 'cleared' ? 'cleared' : null);
  expect(executor.execute).toHaveBeenCalledTimes(1);
});
test('task inspection reads the latest marker through the caller transaction and preserves expired state', async () => {
  const marker = pending(), connection = { execute: jest.fn(async (sql, params) => {
    expect(sql).toContain('DESC, id DESC LIMIT 1');
    expect(sql).toContain('user_id = ?');
    expect(sql).toContain('topicBoundary');
    expect(params).toEqual([conversationId, 'owner']);
    return [[{ id: 30, meta: { business: { pendingTransactions: marker } } }]];
  }) };
  const executor = { execute: jest.fn(() => { throw new Error('Must use caller transaction'); }) };
  const store = createConversationStore({ executor, now: () => now + TTL_MS });
  expect(await store.loadPendingTransactionTask('owner', conversationId, connection))
    .toMatchObject({ taskId: turnId, revision: 1, status: 'expired' });
  expect(connection.execute).toHaveBeenCalledTimes(1);
  expect(executor.execute).not.toHaveBeenCalled();
});
