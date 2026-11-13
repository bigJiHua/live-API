jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const start = Date.parse('2026-11-07T02:00:00Z');
const input = id => ({ lane: 'v3-chat', requestId: id, maxProviderCalls: 5, input: { message: '合成验收' } });

test('V3 has bounded reasoning, and completed requests replay without paid calls', async () => {
  const guard = createMemoryRequestGuard({ clock: () => start });
  const provider = jest.fn(async () => ({ ok: true }));
  const work = async budget => {
    for (let i = 0; i < 5; i++) await budget.invoke(provider);
    await expect(budget.invoke(provider)).rejects.toMatchObject({ code: 'AI_PROVIDER_CALL_LIMIT' });
    return { contractVersion: 3, answer: '核对草稿', conversationId: 'synthetic-conversation' };
  };
  const first = await guard.run('synthetic-owner', input('bounded-v3'), work);
  expect(first.request.providerCalls).toBe(5);
  expect(await guard.run('synthetic-owner', input('bounded-v3'), work)).toEqual(first);
  expect(provider).toHaveBeenCalledTimes(5);
  expect((await guard.get('synthetic-owner', 'bounded-v3')).contractVersion).toBe(3);
});

test('daily quota uses persistent call totals and the Shanghai day boundary', async () => {
  let now = start;
  const guard = createMemoryRequestGuard({ clock: () => now });
  const provider = jest.fn(async () => null);
  const run = (id, calls = 1) => guard.run('synthetic-owner', { ...input(id), dailyProviderLimit: 2 }, async budget => {
    for (let i = 0; i < calls; i++) await budget.invoke(provider);
    return { contractVersion: 3, answer: '完成', conversationId: 'synthetic-conversation' };
  });
  await run('quota-first', 2);
  await expect(run('quota-blocked')).rejects.toMatchObject({ code: 'AI_DAILY_CALL_LIMIT', providerCalls: 0 });
  expect(provider).toHaveBeenCalledTimes(2);
  now = Date.parse('2026-11-07T16:00:00Z');
  await run('quota-tomorrow');
  expect(provider).toHaveBeenCalledTimes(3);
});

test('V3 transaction recovery prevents model replay after uncertain receipt completion', async () => {
  const guard = createMemoryRequestGuard({ clock: () => start });
  await expect(guard.run('synthetic-owner', input('v3-recovery'), async budget => {
    await budget.invoke(async () => null);
    const result = { contractVersion: 3, answer: '核对草稿', conversationId: 'synthetic-conversation',
      draft: { id: 'synthetic-draft' }, request: { requestId: budget.requestId, providerCalls: budget.calls, maxProviderCalls: 5 } };
    await guard.saveV3Recovery(guard.fixtureExecutor, 'synthetic-owner', budget.requestId, result);
    throw new Error('Lost transaction acknowledgement');
  })).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
  const receipt = await guard.get('synthetic-owner', 'v3-recovery');
  expect(receipt).toMatchObject({ status: 'completed', recoveredFromV3Transaction: true, providerCalls: 1 });
  expect(receipt.result.draft.id).toBe('synthetic-draft');
});

test('forged recovery counts and oversized provider budgets are rejected', async () => {
  const guard = createMemoryRequestGuard({ clock: () => start });
  await expect(guard.run('synthetic-owner', { ...input('too-many'), maxProviderCalls: 6 }, async () => null))
    .rejects.toMatchObject({ code: 'AI_REQUEST_INVALID' });
  await expect(guard.saveV3Recovery(guard.fixtureExecutor, 'synthetic-owner', 'forged', {
    contractVersion: 3, answer: '核对', conversationId: 'synthetic',
    request: { requestId: 'forged', providerCalls: 0, maxProviderCalls: 5 },
  })).rejects.toMatchObject({ code: 'AI_RECEIPT_UNAVAILABLE' });
});

test('claim mismatches retain a friendly terminal receipt without replaying paid calls', async () => {
  const guard = createMemoryRequestGuard({ clock: () => start });
  const provider = jest.fn(async () => null);
  await expect(guard.run('synthetic-owner', input('claim-mismatch-receipt'), async budget => {
    await budget.invoke(provider); await budget.invoke(provider);
    assertResultClaims('已整理8.50元草稿，请确认。', { artifacts: [], currentReceipts: [] });
  })).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH', providerCalls: 2 });
  const receipt = await guard.get('synthetic-owner', 'claim-mismatch-receipt');
  expect(receipt).toMatchObject({ status: 'failed', contractVersion: 3, providerCalls: 2,
    error: { code: 'AI_RESULT_CLAIM_MISMATCH', message: expect.stringContaining('请查看实际卡片和回执') } });
  expect(receipt.error.message).not.toContain('点「重试」');
  await guard.get('synthetic-owner', 'claim-mismatch-receipt'); expect(provider).toHaveBeenCalledTimes(2);
});
