jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
const { createInterruptedTurnRecovery } = require('../../src/modules/ai/service/interruptedTurnRecovery');
const { createRequestGuard, digestInput } = require('../../src/modules/ai/service/requestGuard');
const { createConversationStore } = require('../../src/modules/ai/service/conversations');
const { createAiService } = require('../../src/modules/ai/service');
const { encryptField } = require('../../src/common/utils/fieldCrypto');

const requestId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000001';
const childId = '30000000-0000-4000-8000-000000000001';
const stamp = 1900000000000;

function fixture({ mode = 'chat', status = 'running', deadline = stamp - 1, message = '原问题',
  activityMessage = message, owner = 'owner', activityConversation = conversationId,
  retryOf, recoveryResult, errorCode = 'AI_TURN_INTERRUPTED' } = {}) {
  const input = { requestId, conversationId, message, consent: true, ...(mode ? { mode } : {}), ...(retryOf ? { retryOf } : {}) };
  const row = { id: requestId, user_id: owner, lane: 'v3-chat', status, error_code: errorCode,
    input_digest: digestInput({ lane: 'v3-chat', input }), provider_calls: 1, max_provider_calls: 5,
    created_at: stamp - 60000, deadline_at: deadline, expires_at: stamp + 86400000,
    result_payload: recoveryResult ? encryptField(JSON.stringify(recoveryResult)) : null };
  const messages = [], links = retryOf ? [{ requestId, retryOf }] : [];
  const execute = jest.fn(async (sql, args) => {
    if (sql.includes('FROM ai_request_run')) return [args[0] === owner && args[1] === requestId ? [{ ...row }] : []];
    if (sql.startsWith('UPDATE ai_request_run')) {
      if (row.status !== 'running' || row.deadline_at > args[2]) return [{ affectedRows: 0 }];
      row.status = 'failed'; row.error_code = 'AI_TURN_INTERRUPTED'; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_request_lane')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM ai_chat_activity')) return [[{ conversation_id: activityConversation,
      message_payload: encryptField(activityMessage), created_at: stamp - 60000 }]];
    if (sql.includes('FROM ai_conversation') && sql.startsWith('SELECT'))
      return [args[0] === conversationId && args[1] === owner ? [{ id: conversationId }] : []];
    if (sql.includes('FROM ai_message')) {
      if (sql.includes('AS retry_of')) return [links.map(link => ({ request_id: link.requestId, retry_of: link.retryOf }))];
      return [structuredClone(messages.filter(item => item.user_id === args[1] && item.conversation_id === args[0]
        && [item.meta.requestId, item.meta.failure?.requestId, item.meta.turnId].includes(args[2])
        && (!sql.includes("role = 'assistant'") || item.role === 'assistant')))];
    }
    if (sql.startsWith('INSERT INTO ai_message')) {
      messages.push({ id: messages.length + 1, conversation_id: args[0], user_id: args[1],
        role: sql.includes("'user'") ? 'user' : 'assistant', content: args[2], meta: JSON.parse(args[3]) });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_message')) {
      const parent = messages.find(item => item.id === args[1]);
      if (!parent || parent.meta.continuedBy) return [{ affectedRows: 0 }];
      parent.meta.continuedBy = args[0]; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE ai_conversation')) return [{ affectedRows: 1 }];
    throw Error('Unexpected SQL: ' + sql);
  });
  const executor = { execute, getConnection: async () => ({ execute, beginTransaction: async () => {},
    commit: async () => {}, rollback: async () => {}, release() {} }) };
  const requestGuard = createRequestGuard({ executor, clock: () => stamp });
  const conversations = createConversationStore({ executor });
  const recover = createInterruptedTurnRecovery({ executor, requestGuard, conversations });
  return { input, row, messages, execute, executor, requestGuard, conversations, recover };
}

test.each([undefined, 'chat', 'analysis', 'operate'])('hard restart: expired lease reconstructs mode=%s failure once and enables one continuation', async mode => {
  const f = fixture({ mode: mode || null });
  const receipt = await f.requestGuard.get('owner', requestId);
  expect(receipt).toMatchObject({ status: 'failed', error: { code: 'AI_TURN_INTERRUPTED' } });
  await f.recover('owner', requestId, receipt);
  await f.recover('owner', requestId, receipt);
  expect(f.messages).toHaveLength(2);
  expect(f.messages[0]).toMatchObject({ role: 'user', content: '原问题' });
  expect(f.messages[1].meta.failure).toMatchObject({ requestId, status: 'failed', code: 'AI_TURN_INTERRUPTED' });
  await f.conversations.claimRetry('owner', conversationId, { retryOf: requestId, requestId: childId, message: '原问题' });
  expect(f.messages[1].meta.continuedBy).toBe(childId);
  await expect(f.conversations.claimRetry('owner', conversationId, {
    retryOf: requestId, requestId: '40000000-0000-4000-8000-000000000001', message: '原问题',
  })).rejects.toMatchObject({ code: 'AI_RETRY_CONSUMED' });
});

test.each([
  ['live lease', { deadline: stamp + 45000 }],
  ['wrong original text', { activityMessage: '替换问题' }],
  ['wrong conversation', { activityConversation: childId }],
  ['ordinary provider failure', { status: 'failed', errorCode: 'AI_INVALID_RESULT' }],
])('%s cannot fabricate retry history', async (_, options) => {
  const f = fixture(options);
  await f.recover('owner', requestId, await f.requestGuard.get('owner', requestId));
  expect(f.messages).toHaveLength(0);
});

test('another owner cannot read or reconstruct the request', async () => {
  const f = fixture();
  await expect(f.requestGuard.get('stranger', requestId)).rejects.toMatchObject({ code: 'AI_REQUEST_NOT_FOUND' });
  await f.recover('stranger', requestId, { contractVersion: 3, status: 'failed', error: { code: 'AI_TURN_INTERRUPTED' } });
  expect(f.messages).toHaveLength(0);
});

test('a crashed continuation restores its own retryOf rather than starting an unrelated turn', async () => {
  const f = fixture({ retryOf: childId });
  await f.recover('owner', requestId, await f.requestGuard.get('owner', requestId));
  expect(f.messages).toHaveLength(2);
  expect(f.messages.every(item => item.meta.retryOf === childId)).toBe(true);
});

test('a committed result survives restart and is never reconstructed as failure', async () => {
  const result = { contractVersion: 3, conversationId, answer: '已保存的完整答复',
    request: { requestId, providerCalls: 1, maxProviderCalls: 5 } };
  const f = fixture({ recoveryResult: result });
  const receipt = await f.requestGuard.get('owner', requestId);
  expect(receipt).toMatchObject({ status: 'completed', result });
  await f.recover('owner', requestId, receipt);
  expect(f.messages).toHaveLength(0);
});

test('service reads durable receipts even when model settings cannot warm up', async () => {
  const f = fixture();
  const warmup = jest.fn(async () => { throw Error('settings unavailable during restart'); });
  const service = createAiService({ requestGuard: f.requestGuard, writeDb: f.executor,
    conversationStore: f.conversations, settingsStore: { warmup } });
  await expect(service.getRequestReceipt('owner', requestId)).resolves.toMatchObject({
    status: 'failed', error: { code: 'AI_TURN_INTERRUPTED' },
  });
  expect(warmup).not.toHaveBeenCalled();
  expect(f.messages).toHaveLength(2);
});

test('plain completed text is readable while settings are unavailable', async () => {
  const warmup = jest.fn(async () => { throw Error('settings unavailable'); });
  const result = { contractVersion: 3, conversationId, answer: '原答复', datasets: [],
    request: { requestId, providerCalls: 1, maxProviderCalls: 5 } };
  const receipt = { contractVersion: 3, status: 'completed', result };
  const service = createAiService({ settingsStore: { warmup }, requestGuard: { get: async () => receipt } });
  await expect(service.getRequestReceipt('owner', requestId)).resolves.toMatchObject({ status: 'completed', result });
  expect(warmup).not.toHaveBeenCalled();
});

test('hung failure-history repair does not prevent returning the durable receipt', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    f.executor.execute = async sql => {
      if (sql.includes('FROM ai_chat_activity')) return new Promise(() => {});
      throw Error('unexpected repair SQL');
    };
    const receipt = { contractVersion: 3, status: 'failed', error: { code: 'AI_TURN_INTERRUPTED' } };
    const service = createAiService({ writeDb: f.executor, conversationStore: f.conversations,
      requestGuard: { get: async () => receipt, failureForInput: async () => receipt } });
    const pending = service.getRequestReceipt('owner', requestId);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual(receipt);
  } finally { jest.useRealTimers(); }
});
