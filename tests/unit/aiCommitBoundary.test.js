/** Real service/store code against an isolated transactional adapter; never opens MySQL. */
jest.mock('../../src/common/config/db', () => ({
  execute: jest.fn(() => { throw new Error('Public DB must not be used'); }),
  getConnection: jest.fn(() => { throw new Error('Public DB must not be used'); }),
}));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Tests must not open MySQL'); }) }));
jest.mock('axios', () => ({
  get: jest.fn(() => { throw new Error('Commit tests must not call a provider'); }),
  post: jest.fn(() => { throw new Error('Commit tests must not call a provider'); }),
}));
jest.mock('../../src/modules/account/model/debit', () => ({ create: jest.fn() }));
jest.mock('../../src/modules/account/model/credit', () => ({ create: jest.fn() }));

const { createAiService } = require('../../src/modules/ai/service');
const { createDraftStore } = require('../../src/modules/ai/service/drafts');
const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const debit = require('../../src/modules/account/model/debit');
const credit = require('../../src/modules/account/model/credit');
const { preflightTransaction } = require('../../src/common/services/financialPreflight');
const { createFinancialWorkflow } = require('../../src/modules/ai/service/financialWorkflow');
const { createMemoryCandidateStore } = require('../helpers/aiFixture');

const USER = 'owner-a';
const ID = 'draft-a';
const NOW = Date.parse('2026-11-06T04:00:00Z');
const env = { AI_MODE: 'deepseek', DEEPSEEK_API_KEY: 'synthetic-test-key',
  AI_DB_HOST: 'test.invalid', AI_DB_NAME: 'isolated', AI_DB_USER: 'readonly', AI_DB_PASSWORD: 'synthetic' };
const fields = { direction: 0, amount: '12.34', currency: 'CNY', transDate: '2026-11-06',
  categoryId: 'food', accountId: 'card-a', payMethod: '银行卡', remark: '午餐', missingFields: [] };

function fixture(type = 'debit', overrides = {}) {
  const state = {
    row: { id: ID, user_id: USER, direction: 0, amount: '12.34', currency: 'CNY',
      trans_date: '2026-11-06', category_id: 'food', account_id: 'card-a', pay_method: '银行卡',
      remark: '午餐', status: 'reviewed', version: 2, missing_fields: [], trace_snapshot: [],
      source: 'user-readonly', expires_at: NOW + 60000, committed_record_id: null, ...overrides },
    records: [], clock: NOW, failAt: null, categoryPresent: true, categoryName: '餐饮', accountPresent: true, balance: '100000.00',
  };
  let tail = Promise.resolve();
  const operations = [];
  function execute(target, sql, params, inTransaction) {
    sql = typeof sql === 'string' ? sql : sql.sql;
    operations.push({ sql, params, inTransaction });
    if (/SELECT .*FROM bus_ai_draft/s.test(sql)) {
      if (state.failAt === 'receipt' && inTransaction && target.row.committed_record_id) throw new Error('synthetic receipt failure');
      if (params[0] !== target.row.id || params[1] !== target.row.user_id) return [[]];
      const row = structuredClone(target.row);
      // mysql2 DATE normally becomes a local midnight Date; DATE_FORMAT returns text instead.
      if (!sql.includes('DATE_FORMAT')) row.trans_date = new Date(`${row.trans_date}T00:00:00+08:00`);
      return [[row]];
    }
    if (/SELECT .*FROM bus_category/.test(sql)) {
      return [state.categoryPresent && params[0] === target.row.category_id && params[1] === USER
        ? [{ id: target.row.category_id, name: state.categoryName, type: 'expense' }] : []];
    }
    if (/SELECT .*FROM card_base/s.test(sql)) {
      const lock = sql.includes('FOR UPDATE'), allCards = !/AND id\s*=\s*\?/.test(sql) && !lock;
      const owns = allCards ? params[0] === USER : lock ? params[0] === 'card-a' && params[1] === USER : params[0] === USER && params[1] === 'card-a';
      return [state.accountPresent && owns
        ? [{ id: 'card-a', name: '日常账户', alias: '日常账户', type, card_type: type, currency: 'CNY', status: '正常',
          share_pool_id: null, credit_limit: state.balance, temp_limit: '0.00', bill_day: 15, repay_day: 25, update_time: 'stable-fixture' }] : []];
    }
    if (/SELECT .*FROM card_foreign_register/s.test(sql)) {
      return [sql.includes('SUM(') ? [{ total: '0.0000' }] : []];
    }
    if (/SELECT .*FROM card_repay/s.test(sql) || /SELECT .*FROM card_bill/s.test(sql)) return [[]];
    if (/SELECT .*FROM account/s.test(sql)) {
      if (sql.includes('SELECT reversed_id') || sql.includes('LIMIT 21') || sql.includes('LIMIT 501')) return [[]];
      return [type === 'credit' ? [] : [{ id: 'opening-income', card_id: 'card-a', currency: 'CNY', direction: 1, amount: state.balance,
        exchange_rate: '1.00', trans_date: '2026-11-06', category_id: 'salary', reversed_id: null, create_time: 'stable', update_time: 'stable' }]];
    }
    if (/INSERT INTO account/.test(sql)) {
      if (!inTransaction) throw new Error('Formal write outside transaction');
      target.records.push(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE bus_ai_draft SET committed_record_id/.test(sql)) {
      if (state.failAt === 'recordId') throw new Error('synthetic record-id failure');
      const [recordId, id, owner] = params;
      if (target.row.id !== id || target.row.user_id !== owner || target.row.status !== 'committed' || target.row.committed_record_id) {
        return [{ affectedRows: 0 }];
      }
      target.row.committed_record_id = recordId;
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE bus_ai_draft/.test(sql)) {
      const [id, owner, version, expiryCheck] = params.slice(-4);
      if (target.row.id !== id || target.row.user_id !== owner || target.row.version !== version ||
          (sql.includes('expires_at > ?') && target.row.expires_at <= expiryCheck) ||
          (sql.includes('CURRENT_TIMESTAMP(3)') && target.row.expires_at <= state.clock)) return [{ affectedRows: 0 }];
      if (sql.includes("SET status='committed'")) {
        const sourceList = sql.match(/source\s+IN\s*\(([^)]+)\)/i);
        const allowedSources = sourceList ? [...sourceList[1].matchAll(/'([^']+)'/g)].map(match => match[1]) : [];
        if (target.row.status !== 'reviewed' || !allowedSources.includes(target.row.source)) return [{ affectedRows: 0 }];
        target.row.status = 'committed'; target.row.committed_at = new Date(state.clock);
      } else if (sql.includes('SET direction=')) {
        if (!['pending', 'reviewed'].includes(target.row.status)) return [{ affectedRows: 0 }];
        const [direction, amount, currency, trans_date, category_id, account_id, pay_method, remark, missing, trace] = params;
        Object.assign(target.row, { direction, amount, currency, trans_date, category_id, account_id, pay_method, remark,
          missing_fields: JSON.parse(missing), trace_snapshot: JSON.parse(trace) });
        if (sql.includes("status='pending'")) target.row.status = 'pending';
      } else {
        if (!['pending', 'reviewed'].includes(target.row.status)) return [{ affectedRows: 0 }];
        target.row.status = params[0];
        target.row.trace_snapshot = JSON.parse(params[1]);
      }
      target.row.version++;
      return [{ affectedRows: 1 }];
    }
    throw new Error('Unexpected test SQL: ' + sql);
  }
  const executor = { execute: jest.fn(async (sql, params) => execute(state, sql, params, false)) };
  const connections = [];
  const writeDb = { getConnection: jest.fn(async () => {
    let transaction, unlock;
    const conn = {
      query: jest.fn(async sql => {
        expect(sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); return [[]];
      }),
      beginTransaction: jest.fn(async () => {
        const previous = tail;
        tail = new Promise(resolve => { unlock = resolve; });
        await previous;
        transaction = { row: structuredClone(state.row), records: structuredClone(state.records) };
        if (state.failAt === 'expire') state.clock = state.row.expires_at;
      }),
      execute: jest.fn(async (sql, params) => execute(transaction, sql, params, true)),
      commit: jest.fn(async () => {
        state.row = transaction.row; state.records = transaction.records;
        transaction = null;
        if (state.failAt === 'commitUnknown') throw Object.assign(new Error('synthetic lost commit acknowledgement'), { code: 'ECONNRESET' });
      }),
      rollback: jest.fn(async () => { transaction = null; }),
      release: jest.fn(() => { if (unlock) unlock(); }),
    };
    connections.push(conn);
    return conn;
  }) };
  const store = createDraftStore({ executor, now: () => state.clock });
  const repository = { choices: jest.fn(async () => ({
    categories: [{ id: 'food', name: '餐饮', type: 'expense' }],
    accounts: [{ id: 'card-a', name: '日常账户', type }],
  })) };
  const financialRepository = { check: (userId, input) => preflightTransaction(executor, userId, input, { now: new Date(state.clock) }),
    read: work => work(async (sql, params) => (await executor.execute(sql, params))[0]) };
  const settingsStore = createSettingsStore();
  settingsStore.save(USER, { apiUrl: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY, model: 'deepseek-flash' });
  const service = createAiService({ env, repository, draftStore: store, writeDb, financialRepository,
    candidateStore: createMemoryCandidateStore({ now: () => state.clock }),
    conversationStore: {}, settingsStore, now: () => new Date(state.clock) });
  // Build the prior review from the real workflow over isolated source rows.
  // Tests then mutate state and exercise the current transaction checks normally.
  const original = structuredClone(state.row);
  const workflow = createFinancialWorkflow({ repository: () => repository, financialRepository: () => financialRepository, draftStore: store,
    now: () => new Date(state.clock) });
  const ready = workflow.inspect(USER, { fields: { amount: original.amount, direction: original.direction, currency: original.currency,
    transDate: original.trans_date, categoryId: original.category_id, accountId: original.account_id, payMethod: original.pay_method, remark: original.remark } },
  { version: original.version - 1 }).then(result => {
    state.row.trace_snapshot = [...original.trace_snapshot, { tool: 'financial_review', result: {
      fieldsDigest: result.financialCheck.fieldsDigest, riskDigest: result.financialCheck.riskDigest,
      policyVersion: result.financialCheck.policyVersion, forVersion: original.version - 1,
    } }];
    operations.length = 0;
  });
  const commit = service.commitDraft.bind(service);
  service.commitDraft = async (...args) => { await ready; return commit(...args); };
  const create = async (payload, conn) => {
    const record = { id: 'record-a', ...payload };
    await conn.execute('INSERT INTO account (id) VALUES (?)', [record]);
    return record;
  };
  debit.create.mockImplementation(create); credit.create.mockImplementation(create);
  return { state, operations, executor, writeDb, connections, store, service, ready };
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  const db = require('../../src/common/config/db');
  expect(db.execute).not.toHaveBeenCalled();
  expect(db.getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
  expect(require('axios').get).not.toHaveBeenCalled();
  expect(require('axios').post).not.toHaveBeenCalled();
});

describe.each(['debit', 'credit'])('%s AI commit transaction boundary', type => {
  test.each(['after-account-lock', 'after-model-return'])('finance switch closing %s rolls back the complete transaction', async stage => {
    const f = fixture(type); await f.ready;
    let resolveStarted, resolveRelease;
    const started = new Promise(resolve => { resolveStarted = resolve; }), release = new Promise(resolve => { resolveRelease = resolve; });
    const previousEnabled = env.AI_BUSINESS_ENABLED;
    env.AI_BUSINESS_ENABLED = 'true';
    const model = type === 'credit' ? credit : debit;
    if (stage === 'after-account-lock') {
      const getConnection = f.writeDb.getConnection.getMockImplementation();
      f.writeDb.getConnection.mockImplementation(async () => {
        const conn = await getConnection(), execute = conn.execute.getMockImplementation();
        conn.execute.mockImplementation(async (sql, params) => {
          const result = await execute(sql, params);
          if (typeof sql === 'string' && sql.includes('FROM card_base') && sql.includes('FOR UPDATE')) {
            resolveStarted(); await release;
          }
          return result;
        });
        return conn;
      });
    } else {
      const create = model.create.getMockImplementation();
      model.create.mockImplementation(async (...args) => { const record = await create(...args); resolveStarted(); await release; return record; });
    }
    try {
      const pending = f.service.commitDraft(USER, ID, { version: 2 });
      await started; env.AI_BUSINESS_ENABLED = 'false'; resolveRelease();
      await expect(pending).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' });
      expect(model.create).toHaveBeenCalledTimes(stage === 'after-account-lock' ? 0 : 1);
      expect(f.state.records).toHaveLength(0);
      expect(f.state.row).toMatchObject({ status: 'reviewed', version: 2, committed_record_id: null });
      expect(f.connections[0].commit).not.toHaveBeenCalled(); expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
    } finally {
      resolveRelease();
      if (previousEnabled === undefined) delete env.AI_BUSINESS_ENABLED; else env.AI_BUSINESS_ENABLED = previousEnabled;
    }
  });

  test('draft, formal record and receipt use one transaction, with owner-bound current locks', async () => {
    const f = fixture(type);
    const receipt = await f.service.commitDraft(USER, ID, { version: 2 });
    const conn = f.connections[0];
    expect((type === 'credit' ? credit : debit).create).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, amount: 12.34, transDate: '2026-11-06', categoryId: 'food', cardId: 'card-a',
    }), conn);
    expect(f.state.records).toHaveLength(1);
    expect(f.state.row).toMatchObject({ status: 'committed', version: 3, committed_record_id: 'record-a' });
    expect(receipt).toMatchObject({ status: 'committed', committedRecordId: 'record-a', needsReview: false, transDate: '2026-11-06' });
    for (const table of ['bus_category', 'card_base']) {
      const op = f.operations.find(item => item.sql.includes('FROM ' + table));
      expect(op.inTransaction).toBe(true);
      expect(op.sql).toContain('FOR UPDATE');
      expect(op.params[1]).toBe(USER);
    }
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    const readsBefore = f.executor.execute.mock.calls.length;
    f.state.clock += 120000;
    await expect(f.store.get(USER, ID)).resolves.toMatchObject({ status: 'committed' });
    expect(f.executor.execute.mock.calls.length).toBe(readsBefore + 1);
  });

  test.each(['recordId', 'receipt'])('%s failure rolls back both rows; retry creates only one formal record', async failAt => {
    const f = fixture(type); f.state.failAt = failAt;
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_COMMIT_FAILED', status: 503 });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row).toMatchObject({ status: 'reviewed', version: 2, committed_record_id: null });
    expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
    f.state.failAt = null;
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).resolves.toMatchObject({ committedRecordId: 'record-a' });
    expect(f.state.records).toHaveLength(1);
  });

  test('two simultaneous submissions recover the same receipt and produce exactly one record', async () => {
    const f = fixture(type);
    const results = await Promise.allSettled([
      f.service.commitDraft(USER, ID, { version: 2 }), f.service.commitDraft(USER, ID, { version: 2 }),
    ]);
    const fulfilled = results.filter(item => item.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);
    for (const receipt of fulfilled) expect(receipt.value.committedRecordId).toBe('record-a');
    expect(f.state.records).toHaveLength(1);
    expect(f.operations.filter(item => /SELECT .*FROM bus_ai_draft.*FOR UPDATE/s.test(item.sql))).toHaveLength(1);
  });

  test('lost commit acknowledgement never restores a committed draft or duplicates the record', async () => {
    const f = fixture(type); f.state.failAt = 'commitUnknown';
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ status: 503 });
    expect(f.state.records).toHaveLength(1);
    expect(f.state.row.status).toBe('committed');
    f.state.failAt = null;
    await expect(f.service.commitDraft(USER, ID, { version: 3 })).resolves.toMatchObject({ committedRecordId: 'record-a' });
    expect(f.state.records).toHaveLength(1);
  });

  test.each(['categoryPresent', 'accountPresent'])('deletion after the choices read (%s) prevents formal write', async field => {
    const f = fixture(type); f.state[field] = false;
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ status: 400 });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row.status).toBe('reviewed');
  });

  test('expiration while waiting for transaction prevents formal write', async () => {
    const f = fixture(type); f.state.failAt = 'expire';
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_DRAFT_CONFLICT' });
    expect(f.state.records).toHaveLength(0);
  });
});

describe.each(['debit', 'credit'])('%s image OCR commit boundary', type => {
  test('a reviewed image proposal, formal write and receipt share exactly one connection and transaction', async () => {
    const f = fixture(type, { source: 'image-ocr', trace_snapshot: [{ tool: 'recognize_payment_image', imageHash: 'a'.repeat(64) }] });
    const receipt = await f.service.commitDraft(USER, ID, { version: 2 });
    const conn = f.connections[0];
    expect(f.writeDb.getConnection).toHaveBeenCalledTimes(1);
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect((type === 'credit' ? credit : debit).create).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, amount: 12.34, transDate: '2026-11-06', cardId: 'card-a',
    }), conn);
    expect(receipt).toMatchObject({ source: 'image-ocr', status: 'committed', committedRecordId: 'record-a', needsReview: false });
    expect(f.state.records).toHaveLength(1);
    const writes = f.operations.filter(operation => /^(UPDATE bus_ai_draft|INSERT INTO account)/.test(operation.sql));
    expect(writes).toHaveLength(3);
    expect(writes.every(operation => operation.inTransaction)).toBe(true);
    expect(writes[0].sql).toContain("status='reviewed'");
    expect(writes[0].sql).toContain("source IN ('user-readonly','image-ocr')");
    expect(writes[0].params.slice(0, 3)).toEqual([ID, USER, 2]);
    expect(writes[2].params).toEqual(['record-a', ID, USER]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  test('image proposal receipt failure rolls back the formal record and leaves the draft review intact', async () => {
    const f = fixture(type, { source: 'image-ocr' }); f.state.failAt = 'recordId';
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_COMMIT_FAILED', status: 503 });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row).toMatchObject({ source: 'image-ocr', status: 'reviewed', version: 2, committed_record_id: null });
    expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
    expect(f.connections[0].commit).not.toHaveBeenCalled();
  });

  test.each([
    ['pending', { status: 'pending' }, 'AI_DRAFT_NOT_REVIEWED'],
    ['unknown owner', { user_id: 'other-owner' }, undefined],
    ['missing account', { account_id: null }, 'AI_COMMIT_ACCOUNT'],
    ['stale version', { version: 3 }, 'AI_DRAFT_CONFLICT'],
  ])('%s image draft cannot bypass existing review, ownership or account checks', async (_, overrides, code) => {
    const f = fixture(type, { source: 'image-ocr', ...overrides });
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject(code ? { code } : { status: 404 });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row.committed_record_id).toBeNull();
  });
});

describe('persistent draft review and validation boundary', () => {
  test.each(['user-readonly', 'image-ocr'])('%s changing to a synthetic source before the write is rejected inside the transaction', async source => {
    const f = fixture('debit', { source });
    const obtainConnection = f.writeDb.getConnection.getMockImplementation();
    f.writeDb.getConnection.mockImplementation(async () => {
      f.state.row.source = 'synthetic';
      return obtainConnection();
    });
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_DRAFT_CONFLICT' });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row).toMatchObject({ status: 'reviewed', version: 2, committed_record_id: null });
    expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
    expect(f.connections[0].commit).not.toHaveBeenCalled();
  });

  test('editing a reviewed draft requires a new review before commit', async () => {
    const f = fixture();
    await f.ready;
    const updated = await f.store.update(USER, ID, 2, { ...fields, amount: '25.00' });
    expect(updated).toMatchObject({ amount: '25.00', status: 'pending', version: 3 });
    await expect(f.service.commitDraft(USER, ID, { version: 3 })).rejects.toMatchObject({ code: 'AI_DRAFT_NOT_REVIEWED' });
    expect(f.state.records).toHaveLength(0);
    const reviewed = await f.service.actOnDraft(USER, ID, { version: 3, action: 'review' });
    await expect(f.service.commitDraft(USER, ID, { version: reviewed.version })).resolves.toMatchObject({ status: 'committed' });
  });

  test.each(['update', 'review'])('%s cannot mutate a draft that expires between read and write', async action => {
    const f = fixture();
    const originalExecute = f.executor.execute.getMockImplementation();
    f.executor.execute.mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE')) f.state.clock = f.state.row.expires_at;
      return originalExecute(sql, params);
    });
    const operation = action === 'update' ? f.store.update(USER, ID, 2, fields) : f.store.act(USER, ID, 2, 'review');
    await expect(operation).rejects.toMatchObject({ code: 'AI_DRAFT_CONFLICT' });
    expect(f.state.row.version).toBe(2);
  });

  test.each([
    ['synthetic source', { source: 'synthetic' }, 'AI_COMMIT_SOURCE'],
    ['extra precision', { amount: '12.3456' }, 'AI_COMMIT_AMOUNT'],
    ['zero amount', { amount: '0.00' }, 'AI_COMMIT_AMOUNT'],
    ['invalid direction', { direction: 9 }, 'AI_COMMIT_DIRECTION'],
    ['invalid calendar date', { trans_date: '2026-02-30' }, 'AI_COMMIT_DATE'],
    ['invalid pay method', { pay_method: '转账' }, 'AI_COMMIT_PAY_METHOD'],
  ])('%s is rejected before obtaining a write connection', async (_, overrides, code) => {
    const f = fixture('debit', overrides);
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code });
    expect(f.writeDb.getConnection).not.toHaveBeenCalled();
    expect(f.state.records).toHaveLength(0);
  });

  test('another user cannot fetch or commit the draft', async () => {
    const f = fixture();
    await expect(f.store.get('owner-b', ID)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.commitDraft('owner-b', ID, { version: 2 })).rejects.toMatchObject({ status: 404 });
    expect(f.writeDb.getConnection).not.toHaveBeenCalled();
  });

  test('existing decimal formatting with trailing zeros keeps its exact cent amount', async () => {
    const f = fixture('debit', { amount: '12.3400' });
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).resolves.toMatchObject({ amount: '12.3400' });
    expect(f.state.records[0].amount).toBe(12.34);
  });

  test.each(['转账', 'installment', '信用卡分期', '初始化余额'])('renaming a reviewed category to %s cannot bypass commit policy', async name => {
    const f = fixture(); f.state.categoryName = name;
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_COMMIT_CATEGORY' });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row.status).toBe('reviewed');
  });

  test.each(['CATEGORY_REPAY', 'installment'])('renamed reserved ID %s cannot be committed as an ordinary record', async category_id => {
    const f = fixture('debit', { category_id });
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_COMMIT_CATEGORY' });
    expect(f.state.records).toHaveLength(0);
    expect(f.state.row.status).toBe('reviewed');
  });

  test('real CreditCore to Card read path cannot initialize cards through the public pool', async () => {
    const Card = require('../../src/modules/card/model');
    const CreditCore = require('../../src/modules/card/core/CreditCore');
    const initialize = jest.spyOn(Card, 'initVirtualCards').mockRejectedValue(new Error('Forbidden transaction escape'));
    const conn = { execute: jest.fn().mockResolvedValue([[]]) };
    try {
      await expect(CreditCore.aggregate(USER, conn)).resolves.toMatchObject({ cards: [] });
      expect(initialize).not.toHaveBeenCalled();
      expect(conn.execute).toHaveBeenCalled();
    } finally { initialize.mockRestore(); }
  });
  test.each(['debit', 'credit'])('%s funds changing after review invalidates the proof even when the amount still fits', async type => {
    const f = fixture(type); await f.ready; f.state.balance = '99999.00';
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_RISK_CHANGED' });
    expect(f.state.records).toHaveLength(0); expect(f.state.row.status).toBe('reviewed');
    const reviewed = await f.service.actOnDraft(USER, ID, { version: 2, action: 'review' });
    await expect(f.service.commitDraft(USER, ID, { version: reviewed.version })).resolves.toMatchObject({ committedRecordId: 'record-a' });
    expect(f.state.records).toHaveLength(1);
  });
  test.each(['debit', 'credit'])('%s insufficient current funds block the transaction with no formal rows', async type => {
    const f = fixture(type); await f.ready; f.state.balance = '1.00';
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED',
      financialCheck: { reasonCodes: expect.arrayContaining(['INSUFFICIENT_FUNDS']) } });
    expect(f.state.records).toHaveLength(0); expect(f.state.row.committed_record_id).toBeNull();
  });
  test('a legacy reviewed flag without a financial review proof never authorizes the formal insert', async () => {
    const f = fixture(); await f.ready; f.state.row.trace_snapshot = [];
    await expect(f.service.commitDraft(USER, ID, { version: 2 })).rejects.toMatchObject({ code: 'AI_RISK_CHANGED' });
    expect(f.state.records).toHaveLength(0); expect(f.connections[0].rollback).toHaveBeenCalledTimes(1);
  });
});
