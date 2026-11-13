// Isolated transactional SQL adapter: these tests cannot open MySQL or invoke AI.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }), getConnection: jest.fn() }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('MySQL forbidden'); }) }));
jest.mock('axios', () => ({ post: jest.fn(() => { throw new Error('AI forbidden'); }) }));
const { createAiBusinessActions, normalizeBusinessFields } = require('../../src/common/services/aiBusinessActions');
const { createBusinessProposalStore } = require('../../src/modules/ai/service/businessProposals');
const NOW = Date.parse('2026-11-06T04:00:00Z'), USER = 'owner';
const budget = { title: '交通预算', budgetType: '行', budgetAmount: '39.91', cycle: '月', planDate: '2026-11-30' };

test('an AI turn expiring during proposal storage rolls back the late artifact', async () => {
  const f = fixture(); let calls = 0;
  const check = () => { if (++calls === 2) throw new Error('AI turn timed out'); };
  await expect(f.store.create(USER, { kind: 'budget.create', fields: budget, check })).rejects.toThrow('AI turn timed out');
  expect(Object.keys(f.state().proposals)).toHaveLength(0); expect(f.state().records).toHaveLength(0);
});

test.each([1, 2, 3])('an asynchronous authorization failure at proposal boundary %s rolls back before commit', async deniedCheck => {
  const f = fixture(); let calls = 0;
  const check = jest.fn(async conn => {
    expect(conn).toBe(f.connections[0]);
    await Promise.resolve();
    if (++calls === deniedCheck) throw Object.assign(new Error('grant revoked'), { code: 'AI_GRANT_REQUIRED' });
  });
  await expect(f.store.create(USER, { kind: 'budget.create', fields: budget, conversationId: 'conversation', check }))
    .rejects.toMatchObject({ code: 'AI_GRANT_REQUIRED' });
  expect(Object.keys(f.state().proposals)).toHaveLength(0); expect(f.state().records).toHaveLength(0);
  expect(f.connections[0].commit).not.toHaveBeenCalled(); expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
  if (deniedCheck === 1) expect(f.operations).toHaveLength(0);
});

function fixture() {
  let state = { proposals: {}, records: [], histories: [], jobs: {}, fund: { id: 'fund-a', user_id: USER, fund_name: '基金A', invest: '1000.00', net_value: '0.0000', market_val: '1000.00', rate: '0.00%', is_deleted: 0 },
    todo: { id: 'todo-a', user_id: USER, content: '日程', status: '待完成', update_time: '1', is_deleted: 0 },
    card: { id: 'card-a', user_id: USER, alias: '日常卡', card_type: 'credit', status: '正常', update_time: '1', is_deleted: 0 },
    asset: { id: 'asset-a', user_id: USER, info: '电脑', tag: '数码', now_val: '99.00', is_deleted: 0 } };
  let clock = NOW, failAt = null, tail = Promise.resolve();
  const operations = [], connections = [], scheduled = [];
  const backupManager = { getRunningTask: jest.fn(() => null), createSystemBackupTask: jest.fn(async () => ({ id: 'worker-a' })), getTaskStatus: jest.fn(() => ({ status: 'completed', result: { filepath: 'secret.sql', password: 'secret' } })) };
  function sql(target, query, params = [], inTx = false) {
    operations.push({ query, params, inTx });
    if (query.includes('FROM ai_business_proposal')) return [[...Object.values(target.proposals)].filter(row => row.id === params[0] && row.user_id === params[1]).map(row => structuredClone(row))];
    if (query.startsWith('INSERT INTO ai_business_proposal')) {
      const [id,user_id,kind,payload,source,conversation_id,preview_id,expires_at,target_snapshot] = params;
      target.proposals[id] = { id,user_id,kind,payload,source,conversation_id,preview_id,expires_at,target_snapshot,status: 'pending',version: 1,receipt: null };
      return [{ affectedRows: 1 }];
    }
    if (query.startsWith('UPDATE ai_business_proposal')) {
      const [id,owner,version,expiry] = params.slice(-4), row = target.proposals[id];
      if (!row || row.user_id !== owner || row.version !== version || row.expires_at <= expiry) return [{ affectedRows: 0 }];
      if (query.includes("SET status='committed'")) {
        if (failAt === 'receipt') throw new Error('receipt failed');
        row.status = 'committed'; row.receipt = params[0];
      } else if (query.includes('SET payload=')) { row.payload = params[0]; row.target_snapshot = params[1]; row.status = 'pending'; }
      else row.status = params[0];
      row.version++; return [{ affectedRows: 1 }];
    }
    if (query.includes('FROM ai_conversation')) return [params[1] === USER ? [{ id: params[0] }] : []];
    if (query.includes('FROM user_info')) return [params[0] === USER ? [{ id: USER, identity: 'admin' }] : []];
    const targetName = query.includes('FROM card_base') ? 'card' : query.includes('FROM fixed_asset') ? 'asset' : query.includes('FROM todo') ? 'todo' : query.includes('FROM fund ') ? 'fund' : null;
    if (targetName && !query.includes('COUNT(')) return [target[targetName]?.id === params[0] && target[targetName]?.user_id === params[1] ? [structuredClone(target[targetName])] : []];
    if (query.includes('COUNT(*) AS total FROM todo')) return [[{ total: 0 }]];
    if (query.startsWith('INSERT INTO budget') || query.startsWith('INSERT INTO todo') || query.startsWith('INSERT INTO moment')) {
      if (!inTx) throw new Error('Business write outside transaction');
      target.records.push({ query, params }); return [{ affectedRows: 1 }];
    }
    if (query.startsWith('UPDATE card_base')) { target.card.alias = params[0]; target.card.update_time = params[1]; return [{ affectedRows: 1 }]; }
    if (query.startsWith('SELECT record_date FROM bus_fund_history')) return [target.histories.filter(row => row.fundId === params[0] && params.slice(1).includes(row.date)).map(row => ({ record_date: row.date }))];
    if (query.startsWith('INSERT INTO bus_fund_history')) {
      if (!inTx) throw new Error('History write outside transaction');
      if (failAt === 'history' && target.histories.length === 1) throw new Error('second history failed');
      target.histories.push({ id: params[0], fundId: params[1], amount: params[2], date: params[3] }); return [{ affectedRows: 1 }];
    }
    if (query.includes('AS profit_sum')) return [[{ profit_sum: '2.2500', capital_sum: '0.0000' }]];
    if (query.startsWith('UPDATE fund')) { Object.assign(target.fund, { net_value: params[0], market_val: params[1], rate: params[2] }); return [{ affectedRows: 1 }]; }
    if (query.startsWith('SELECT id FROM ai_background_job') || query.startsWith('SELECT id,user_id,receipt FROM ai_background_job')) return [Object.values(target.jobs).filter(job => ['queued','running'].includes(job.status)).map(job => structuredClone(job))];
    if (query.startsWith('INSERT INTO ai_background_job')) { const [id,user_id,proposal_id,receipt,created_at,updated_at] = params; target.jobs[id] = { id,user_id,proposal_id,status: 'queued',receipt,created_at,updated_at }; return [{ affectedRows: 1 }]; }
    if (query.startsWith('SELECT id,status,worker_id,receipt,updated_at')) return [target.jobs[params[0]]?.user_id === params[1] ? [structuredClone(target.jobs[params[0]])] : []];
    if (query.startsWith('UPDATE ai_background_job')) {
      if (query.includes("SET status='running'")) { const job = target.jobs[params[1]]; if (!job || job.status !== 'queued') return [{ affectedRows: 0 }]; job.status = 'running'; job.updated_at = params[0]; }
      else if (query.includes('SET worker_id=')) { const job = target.jobs[params[2]]; job.worker_id = params[0]; job.updated_at = params[1]; }
      else if (query.includes("SET status='failed'")) { const job = target.jobs[params[4]]; job.status = 'failed'; job.receipt = params[1]; }
      else { const job = target.jobs[params[4]]; job.status = params[0]; job.receipt = params[1]; }
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unhandled isolated SQL: ' + query);
  }
  const executor = { execute: jest.fn(async (q,p) => sql(state,q,p)), getConnection: jest.fn(async () => {
    let tx, unlock;
    const conn = { beginTransaction: jest.fn(async () => { const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous; tx = structuredClone(state); }),
      execute: jest.fn(async (q,p) => sql(tx,q,p,true)), commit: jest.fn(async () => { state = tx; if (failAt === 'commitUnknown') throw new Error('lost commit response'); }),
      rollback: jest.fn(async () => {}), release: jest.fn(() => unlock()) };
    connections.push(conn); return conn;
  }) };
  const actions = createAiBusinessActions({ now: () => clock, backupManager, schedule: fn => scheduled.push(fn) });
  const store = createBusinessProposalStore({ executor, now: () => clock, actions });
  return { store, actions, executor, operations, connections, backupManager, scheduled,
    state: () => state, fail: value => { failAt = value; }, advance: ms => { clock += ms; } };
}
async function reviewed(f, kind = 'budget.create', fields = budget) {
  const proposal = await f.store.create(USER, { kind, fields });
  return f.store.act(USER, proposal.id, proposal.version, 'review');
}

test.each(['card.repay','account.rebuild','fixedAsset.depreciate','fund.trade','__proto__','constructor'])('precision/arbitrary action %s is closed', kind => {
  expect(() => normalizeBusinessFields(kind, {})).toThrow('没有向 AI 开放');
});
test('unknown fields, excess money precision, future fund date and duplicate dates are rejected before SQL', () => {
  expect(() => normalizeBusinessFields('budget.create', { ...budget, budgetAmount: '39.9099' })).toThrow();
  expect(() => normalizeBusinessFields('card.metadata', { targetId: 'card-a', creditLimit: '5000' })).toThrow();
  expect(() => normalizeBusinessFields('fixedAsset.update', { targetId: 'asset-a', useYears: 10 })).toThrow();
  expect(() => normalizeBusinessFields('fund.returnBatch', { fundId: 'fund-a', entries: [{ date: '2026-11-07', amount: '1' }] }, { now: NOW })).toThrow('未来');
  expect(() => normalizeBusinessFields('fund.returnBatch', { fundId: 'fund-a', entries: [{ date: '2026-11-06', amount: '1' }, { date: '2026-11-06', amount: '-1' }] }, { now: NOW })).toThrow('重复');
});
test('missing fields remain editable, but cannot be reviewed or executed', async () => {
  const f = fixture(), p = await f.store.create(USER, { kind: 'budget.create', fields: { title: '预算' } });
  expect(p.missingFields).toContain('budgetAmount');
  await expect(f.store.act(USER,p.id,p.version,'review')).rejects.toMatchObject({ code: 'AI_PROPOSAL_INCOMPLETE' });
  expect(f.state().records).toHaveLength(0);
  const edited = await f.store.edit(USER,p.id,p.version,budget);
  expect(edited).toMatchObject({ status: 'pending', version: 2, missingFields: [] });
  await expect(f.store.act(USER,p.id,1,'review')).rejects.toMatchObject({ status: 409 });
});
test('cross-user proposal and business target never permit reads or writes', async () => {
  const f = fixture(), p = await reviewed(f);
  await expect(f.store.get('other',p.id)).rejects.toMatchObject({ status: 404 });
  await expect(f.store.execute('other',p.id,p.version)).rejects.toMatchObject({ status: 404 });
  await expect(f.store.create('other',{ kind: 'card.metadata', fields: { targetId: 'card-a', alias: 'changed' } })).rejects.toMatchObject({ status: 404 });
  expect(f.state().records).toHaveLength(0);
});
test('concurrent/repeated execute produces one business row and one committed receipt', async () => {
  const f = fixture(), p = await reviewed(f);
  const results = await Promise.all([f.store.execute(USER,p.id,p.version),f.store.execute(USER,p.id,p.version)]);
  expect(f.state().records).toHaveLength(1);
  expect(results[0].receipt).toEqual(results[1].receipt);
  expect(results[0]).toMatchObject({ status: 'committed', version: 3 });
  expect(f.state().records[0].params).toContain('39.91');
  expect(f.operations.filter(op => op.query.startsWith('INSERT INTO budget')).every(op => op.inTx)).toBe(true);
});
test('receipt failure rolls back all writes; lost commit response replays the stored receipt', async () => {
  const f = fixture(), p = await reviewed(f); f.fail('receipt');
  await expect(f.store.execute(USER,p.id,p.version)).rejects.toThrow('receipt failed');
  expect(f.state().records).toHaveLength(0); expect(f.state().proposals[p.id].status).toBe('reviewed');
  f.fail('commitUnknown'); await expect(f.store.execute(USER,p.id,p.version)).rejects.toThrow('lost commit');
  f.fail(null); const replay = await f.store.execute(USER,p.id,p.version);
  expect(replay.status).toBe('committed'); expect(f.state().records).toHaveLength(1);
});
test('target changes require a new snapshot and re-review; virtual cards cannot be edited', async () => {
  const f = fixture(), p = await reviewed(f,'card.metadata',{ targetId: 'card-a', alias: '新名称' });
  expect(p.targetSnapshot).toMatchObject({ type: 'card',alias: '日常卡',status: '正常' });
  expect(p.targetSnapshot).not.toHaveProperty('credit_limit');
  f.state().card.update_time = '2';
  await expect(f.store.execute(USER,p.id,p.version)).rejects.toMatchObject({ code: 'AI_TARGET_CONFLICT' });
  const edited = await f.store.edit(USER,p.id,p.version,{ alias: '新名称' });
  expect(edited.status).toBe('pending');
  const ready = await f.store.act(USER,p.id,edited.version,'review');
  await f.store.execute(USER,p.id,ready.version); expect(f.state().card.alias).toBe('新名称');
  f.state().card.card_type = 'virtual_cash';
  await expect(f.store.create(USER,{ kind: 'card.metadata', fields: { targetId: 'card-a', alias: '系统' } })).rejects.toMatchObject({ status: 403 });
});
test('MySQL JSON key reordering preserves an unchanged target snapshot', async () => {
  const f = fixture(), p = await f.store.create(USER,{ kind: 'card.metadata',fields: { targetId: 'card-a',alias: '新名称' } });
  const stored = JSON.parse(f.state().proposals[p.id].target_snapshot);
  f.state().proposals[p.id].target_snapshot = Object.fromEntries(Object.keys(stored).sort((a,b) => a.length-b.length || a.localeCompare(b)).map(key => [key,stored[key]]));
  const checked = await f.store.act(USER,p.id,p.version,'review');
  await f.store.execute(USER,p.id,checked.version);
  expect(f.state().card.alias).toBe('新名称');
});
test('escaped diary content cannot overflow TEXT and silently truncate', async () => {
  const f = fixture(), p = await reviewed(f,'diary.create',{ content: '<'.repeat(17000),mood: '平静',date: '2026-11-06' });
  await expect(f.store.execute(USER,p.id,p.version)).rejects.toThrow('存储长度');
  expect(f.state().records).toHaveLength(0);
  expect(f.state().proposals[p.id].status).toBe('reviewed');
});
test('expired/cancelled proposals and prefill-only assets cannot execute', async () => {
  const f = fixture(), p = await reviewed(f); f.advance(16*60000);
  await expect(f.store.execute(USER,p.id,p.version)).rejects.toMatchObject({ code: 'AI_PROPOSAL_EXPIRED' });
  const asset = await f.store.create(USER,{ kind: 'fixedAsset.create', fields: { info: '电脑' } });
  expect(asset.actionUnavailable).toBe(true);
  await expect(f.store.act(USER,asset.id,asset.version,'review')).rejects.toMatchObject({ code: 'AI_ACTION_NOT_ALLOWED' });
  const q = await reviewed(f); const cancelled = await f.store.act(USER,q.id,q.version,'discard');
  await expect(f.store.execute(USER,q.id,cancelled.version)).rejects.toMatchObject({ status: 409 });
});
test('fund batch writes signed daily returns and established summary once, with no principal input', async () => {
  const f = fixture(), p = await reviewed(f,'fund.returnBatch',{ fundId: 'fund-a', entries: [{ date: '2026-11-04', amount: '3.25' },{ date: '2026-11-05', amount: '-1' }] });
  const result = await f.store.execute(USER,p.id,p.version);
  expect(f.state().histories.map(row => row.amount)).toEqual(['3.25','-1']);
  expect(f.state().fund).toMatchObject({ invest: '1000.00', net_value: '2.2500', market_val: '1002.25', rate: '0.23%' });
  expect(result.receipt.count).toBe(2);
  expect(f.operations.filter(op => op.query.startsWith('UPDATE fund'))).toHaveLength(1);
  expect(f.operations.find(op => op.query.includes('AS profit_sum')).query).toContain('CASE WHEN');
});
test('fund existing date rejects entire batch; failure on second insert rolls back first', async () => {
  const f = fixture(), fields = { fundId: 'fund-a', entries: [{ date: '2026-11-04', amount: '3.25' },{ date: '2026-11-05', amount: '-1' }] };
  const p = await reviewed(f,'fund.returnBatch',fields); f.fail('history');
  await expect(f.store.execute(USER,p.id,p.version)).rejects.toThrow('second history');
  expect(f.state().histories).toHaveLength(0); expect(f.state().fund.net_value).toBe('0.0000');
  f.fail(null); f.state().histories.push({ fundId: 'fund-a',date: '2026-11-05',amount: '0' });
  await expect(f.store.execute(USER,p.id,p.version)).rejects.toMatchObject({ code: 'AI_FUND_DATE_CONFLICT' });
  expect(f.state().histories).toHaveLength(1);
});
test('backup starts only after durable commit, never repeats, and hides task paths', async () => {
  const f = fixture(), p = await reviewed(f,'system.backup',{});
  f.fail('receipt'); await expect(f.store.execute(USER,p.id,p.version)).rejects.toThrow();
  expect(Object.values(f.state().jobs)).toHaveLength(0); expect(f.scheduled).toHaveLength(0);
  f.fail(null); const queued = await f.store.execute(USER,p.id,p.version);
  expect(queued.receipt).toMatchObject({ status: 'queued', completed: false }); expect(f.backupManager.createSystemBackupTask).not.toHaveBeenCalled();
  expect(f.scheduled).toHaveLength(1); f.scheduled[0](); await new Promise(resolve => setImmediate(resolve));
  expect(f.backupManager.createSystemBackupTask).toHaveBeenCalledTimes(1);
  await f.store.execute(USER,p.id,p.version);
  const done = await f.store.get(USER,p.id);
  expect(done.receipt).toMatchObject({ status: 'succeeded',completed: true });
  expect(JSON.stringify(done.receipt)).not.toContain('secret'); expect(f.scheduled).toHaveLength(1);
});
test('backup lost process state becomes an explicit failed receipt and never restarts', async () => {
  const f = fixture(), p = await reviewed(f,'system.backup',{}); const queued = await f.store.execute(USER,p.id,p.version);
  f.advance(61000); const current = await f.store.get(USER,p.id);
  expect(current.receipt.status).toBe('failed');
  expect(f.backupManager.createSystemBackupTask).not.toHaveBeenCalled();
  expect(queued.receipt.status).toBe('queued');
});
test('a new manual backup recovers stale jobs without starting or retrying them', async () => {
  const f = fixture(), old = await reviewed(f,'system.backup',{});
  const oldQueued = await f.store.execute(USER,old.id,old.version);
  f.advance(61000);
  const next = await reviewed(f,'system.backup',{}), accepted = await f.store.execute(USER,next.id,next.version);
  expect(f.state().jobs[oldQueued.receipt.jobRef].status).toBe('failed');
  expect(accepted.receipt.status).toBe('queued');
  expect(f.backupManager.createSystemBackupTask).not.toHaveBeenCalled();
  // The old already-scheduled callback cannot claim a failed job later.
  f.scheduled[0](); await new Promise(resolve => setImmediate(resolve));
  expect(f.backupManager.createSystemBackupTask).not.toHaveBeenCalled();
});
