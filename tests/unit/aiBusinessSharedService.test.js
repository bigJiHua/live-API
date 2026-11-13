jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Public database forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Public database forbidden'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Public read pool forbidden'); }) }));
const { createBusinessService } = require('../../src/modules/ai/service/businessService');
const { AiError } = require('../../src/modules/ai/service/errors');

function fixture() {
  const stored = { id: 'proposal', kind: 'todo.complete', fields: { targetId: 'owned-todo', status: '已完成' }, previewId: 'preview' };
  const state = { config: { mode: 'deepseek', dataSource: 'user-readonly' },
    businessPolicy: { enabled: true, actions: ['todo.complete', 'card.metadata'] },
    conversationStore: { session: jest.fn(async () => ({ id: 'conversation', sessionKind: 'manual', sessionDay: '2026-11-11' })),
      messages: jest.fn(async () => [{ proposal: { ...stored, status: 'pending' } }]) } };
  const snapshot = { choices: { cards: [{ ref: 'normal', name: '生活卡', type: 'debit' },
    { ref: 'unresolved', name: '未知卡', type: 'debit' }, { ref: 'cash', name: '现金', type: 'virtual_cash' }],
    todos: [{ ref: 'todo', name: '读书' }], moods: ['平静'] },
    datasets: [{ datasetId: 'card-cards', domain: 'card', rows: [
      { cardRef: 'inactive', name: '挂失卡', type: 'credit', status: '挂失' },
      { cardRef: 'cash', name: '现金', type: 'virtual_cash', status: '正常' }] }] };
  const previews = { get: jest.fn(async () => ({ snapshot, refMap: {
    normal: { id: 'owned-normal' }, inactive: { id: 'owned-inactive' }, cash: { id: 'owned-cash' }, todo: { id: 'owned-todo' },
  } })) };
  const proposals = Object.fromEntries(['get', 'edit', 'act', 'execute'].map(method => [method, jest.fn(async () => ({ ...stored }))]));
  const service = createBusinessService({ legacyService: { getRuntime: jest.fn(() => state) }, previews, proposals });
  return { service, state, stored, previews, proposals };
}

afterEach(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
});

test('deployed shared service exposes no retired preview/chat entry or prompt', () => {
  const f = fixture();
  expect(Object.keys(f.service).sort()).toEqual(['actOnProposal', 'close', 'editProposal', 'executeProposal', 'getProposal', 'session']);
  expect(Object.keys(require('../../src/modules/ai/service/businessService'))).toEqual(['createBusinessService']);
});

test('session restores owner-bound proposal state and marks only missing/expired proposals unavailable', async () => {
  const f = fixture();
  const session = await f.service.session('owner', 'manual');
  expect(f.state.conversationStore.session).toHaveBeenCalledWith('owner', 'manual');
  expect(f.state.conversationStore.messages).toHaveBeenCalledWith('owner', 'conversation');
  expect(f.proposals.get).toHaveBeenCalledWith('owner', 'proposal');
  expect(session.messages[0].proposal).toMatchObject({ id: 'proposal', choices: { todos: [{ id: 'owned-todo' }] } });
  f.proposals.get.mockRejectedValueOnce(new AiError('gone', 404));
  expect((await f.service.session('owner')).messages[0].proposal).toMatchObject({ status: 'expired', actionUnavailable: true });
  f.proposals.get.mockRejectedValueOnce(new AiError('store unavailable', 503, 'AI_STORAGE_FAILED'));
  await expect(f.service.session('owner')).rejects.toMatchObject({ code: 'AI_STORAGE_FAILED' });
});

test.each([
  { mode: 'mock', dataSource: 'user-readonly' },
  { mode: 'deepseek', dataSource: 'synthetic' },
])('non-production data sources cannot access shared session/proposals', async config => {
  const f = fixture(); f.state.config = config;
  await expect(f.service.session('owner')).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' });
  await expect(f.service.getProposal('owner', 'proposal')).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' });
  expect(f.state.conversationStore.session).not.toHaveBeenCalled(); expect(f.proposals.get).not.toHaveBeenCalled();
});

test('closed business capability blocks all shared operations before store work', async () => {
  const f = fixture(); f.state.businessPolicy.enabled = false;
  for (const call of [() => f.service.session('owner'), () => f.service.getProposal('owner', 'proposal'),
    () => f.service.editProposal('owner', 'proposal', { version: 1, fields: {} }),
    () => f.service.actOnProposal('owner', 'proposal', { version: 1, action: 'discard' }),
    () => f.service.executeProposal('owner', 'proposal', { version: 1 })]) {
    await expect(call()).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' });
  }
  for (const method of Object.values(f.proposals)) expect(method).not.toHaveBeenCalled();
});

test('card metadata restoration keeps owned inactive cards and excludes virtual/unresolved targets', async () => {
  const f = fixture(); f.stored.kind = 'card.metadata';
  const result = await f.service.getProposal('owner', 'proposal');
  expect(f.previews.get).toHaveBeenCalledWith('owner', 'preview');
  expect(result.choices.cards.map(card => card.id)).toEqual(['owned-normal', 'owned-inactive']);
  expect(result.choices.moods).toEqual(['平静']);
});

test('expired preview does not hide a saved proposal but storage errors remain visible', async () => {
  const f = fixture(); f.previews.get.mockRejectedValueOnce(new AiError('preview expired', 410));
  await expect(f.service.getProposal('owner', 'proposal')).resolves.toEqual(f.stored);
  f.previews.get.mockRejectedValueOnce(new AiError('preview failed', 503, 'AI_STORAGE_FAILED'));
  await expect(f.service.getProposal('owner', 'proposal')).rejects.toMatchObject({ code: 'AI_STORAGE_FAILED' });
});

test('edits/actions preserve authenticated ownership and reject invalid versions or extra fields', async () => {
  const f = fixture();
  await f.service.editProposal('owner', 'proposal', { version: 2, fields: { status: '已完成' } });
  expect(f.proposals.edit).toHaveBeenCalledWith('owner', 'proposal', 2, { status: '已完成' });
  await f.service.actOnProposal('owner', 'proposal', { version: 3, action: 'review' });
  expect(f.proposals.act).toHaveBeenCalledWith('owner', 'proposal', 3, 'review');
  f.proposals.edit.mockClear(); f.proposals.act.mockClear();
  for (const input of [{ version: 0, fields: {} }, { version: 1, fields: {}, owner: 'other' }]) {
    await expect(f.service.editProposal('owner', 'proposal', input)).rejects.toThrow();
  }
  await expect(f.service.actOnProposal('owner', 'proposal', { version: 1, action: 'execute' })).rejects.toThrow();
  expect(f.proposals.edit).not.toHaveBeenCalled(); expect(f.proposals.act).not.toHaveBeenCalled();
});

test('execution enforces current action policy and executes only the stored version', async () => {
  const f = fixture(); f.state.businessPolicy.actions = [];
  await expect(f.service.executeProposal('owner', 'proposal', { version: 1 })).rejects.toMatchObject({ code: 'AI_ACTION_NOT_ALLOWED' });
  expect(f.proposals.execute).not.toHaveBeenCalled();
  f.state.businessPolicy.actions = ['todo.complete'];
  await expect(f.service.executeProposal('owner', 'proposal', { version: 1, fields: { targetId: 'other' } })).rejects.toThrow();
  expect(f.proposals.execute).not.toHaveBeenCalled();
  await f.service.executeProposal('owner', 'proposal', { version: 4 });
  expect(f.proposals.execute).toHaveBeenCalledWith('owner', 'proposal', 4);
});
