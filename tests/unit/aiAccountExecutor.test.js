/** AI 确认入账复用外部事务；数据库与外围服务替身禁止真实连接。 */
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(), getPool: jest.fn(), getConnection: jest.fn() }));
jest.mock('../../src/common/utils/idUtils', () => ({ billId: jest.fn(() => 'record-id') }));
jest.mock('../../src/modules/card/core/CreditCore', () => ({ aggregate: jest.fn(), syncCardBills: jest.fn() }));
jest.mock('../../src/modules/card/model/bill', () => ({}));
jest.mock('../../src/modules/card/model/foreignRegister', () => ({ ensurePending: jest.fn(), deleteByAccountId: jest.fn() }));
jest.mock('../../src/modules/asset/model/snapshot', () => ({ autoSaveSnapshot: jest.fn() }));
jest.mock('../../src/modules/account/model/index', () => ({ findById: jest.fn() }));

const db = require('../../src/common/config/db');
const CreditCore = require('../../src/modules/card/core/CreditCore');
const ForeignRegister = require('../../src/modules/card/model/foreignRegister');
const AssetSnapshot = require('../../src/modules/asset/model/snapshot');
const Account = require('../../src/modules/account/model/index');
const Settlement = require('../../src/modules/account/service/settlement');
const CreditAccount = require('../../src/modules/account/model/credit');
const DebitAccount = require('../../src/modules/account/model/debit');

const USER = 'user-id';
const CARD = 'card-id';
const input = { userId: USER, direction: 0, categoryId: 'category-id', payType: '餐饮',
  payMethod: '银行卡', amount: 40, currency: 'CNY', transDate: '2026-11-06', cardId: CARD };

function makeConnection(type = 'credit', { ownsCard = true, balance = 100, cardId = CARD,categoryName='餐饮',ownsCategory=true } = {}) {
  const entry = (direction, amount, id='funding-id') => ({id,card_id:cardId,direction,amount:String(amount),currency:'CNY',
    exchange_rate:'1.00',trans_date:input.transDate,category_id:'category-id',reversed_id:null,create_time:'1',update_time:'1'});
  const ledger = type==='credit'?[]:[entry(1,balance)];
  return {
    query: jest.fn().mockResolvedValue(),
    beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
    execute: jest.fn(async (query, params) => {
      const sql = typeof query === 'string' ? query : query.sql;
      if (/FROM card_base/.test(sql)) {
        return [ownsCard ? [{ id: cardId, card_type: type,currency:'CNY',status:'正常',share_pool_id: null,
          credit_limit:'1000.00',temp_limit:'0.00',bill_day:5,repay_day:25,update_time:'1' }] : []];
      }
      if (/FROM user_info/.test(sql)) return [[{ id: USER }]];
      if (/FROM bus_category/.test(sql)) return [ownsCategory?[{id:'category-id',name:categoryName,type:'expense'}]:[]];
      if (/FROM card_foreign_register|FROM card_repay/.test(sql)) return [[]];
      if (/FROM account_balance/.test(sql)) return [[{ balance: 60 }]];
      if (/FROM account\s/.test(sql)) return [[...ledger]];
      if (/INSERT INTO account\s/.test(sql)) {
        ledger.push({...entry(params[2],params[7],'record-id'),currency:params[8],exchange_rate:params[9]});
      }
      return [{ affectedRows: 1 }];
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.execute.mockImplementation(() => { throw new Error('External transaction must not access the public pool'); });
  CreditCore.aggregate.mockImplementation(async(owner,executor)=>{
    await executor.execute('SELECT id FROM card_base WHERE user_id = ?', [owner]);
    return { cards: [{ shared: false, cardId: CARD, creditLimit: 1000, tempLimit: 0, avail: 1000 }] };
  });
  CreditCore.syncCardBills.mockResolvedValue();
  ForeignRegister.deleteByAccountId.mockResolvedValue();
  ForeignRegister.ensurePending.mockResolvedValue();
  AssetSnapshot.autoSaveSnapshot.mockResolvedValue();
  Account.findById.mockResolvedValue({ id: 'record-id', fullRecord: true });
  jest.spyOn(global, 'setImmediate').mockImplementation(() => 1);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function expectCallerOwnsTransaction(conn) {
  expect(conn.beginTransaction).not.toHaveBeenCalled();
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).not.toHaveBeenCalled();
  expect(db.getPool).not.toHaveBeenCalled();
  expect(db.execute).not.toHaveBeenCalled();
  expect(Account.findById).not.toHaveBeenCalled();
  expect(global.setImmediate).not.toHaveBeenCalled();
  expect(AssetSnapshot.autoSaveSnapshot).not.toHaveBeenCalled();
}

test('credit external executor locks the owner card and keeps record, registration and bills in that connection', async () => {
  const conn = makeConnection();
  const record = await CreditAccount.create(input, conn);
  expect(record).toMatchObject({ id: 'record-id', user_id: USER, card_id: CARD, amount: 40 });
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('user_id = ? AND is_deleted = 0 FOR UPDATE'), [CARD, USER]);
  expect(CreditCore.aggregate).toHaveBeenCalledWith(USER, expect.objectContaining({execute:expect.any(Function)}));
  expect(conn.execute).toHaveBeenCalledWith(expect.objectContaining({sql:'SELECT id FROM card_base WHERE user_id = ?'}),[USER]);
  expect(ForeignRegister.deleteByAccountId).toHaveBeenCalledWith('record-id', USER, conn);
  expect(CreditCore.syncCardBills).toHaveBeenCalledWith(CARD, USER, conn);
  expectCallerOwnsTransaction(conn);
});

test('credit external failure leaves rollback and connection lifecycle to the caller', async () => {
  const conn = makeConnection();
  CreditCore.syncCardBills.mockRejectedValueOnce(new Error('bill sync failed'));
  await expect(CreditAccount.create(input, conn)).rejects.toThrow('bill sync failed');
  expectCallerOwnsTransaction(conn);
});

test('credit external foreign registration also uses the caller connection', async () => {
  const conn = makeConnection();
  await CreditAccount.create({ ...input, currency: 'USD', exchangeRate: 700 }, conn);
  expect(ForeignRegister.ensurePending).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'record-id', currency: 'USD' }), conn);
  expectCallerOwnsTransaction(conn);
});

test('credit ordinary create still commits, releases, then reads the complete record', async () => {
  const conn = makeConnection();
  db.getPool.mockReturnValue({ getConnection: async () => conn });
  db.execute.mockResolvedValue([[{ card_type: 'credit' }]]);
  const record = await CreditAccount.create(input);
  expect(record.fullRecord).toBe(true);
  expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(conn.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  expect(conn.query.mock.invocationCallOrder[0]).toBeLessThan(conn.beginTransaction.mock.invocationCallOrder[0]);
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(Account.findById.mock.invocationCallOrder[0]).toBeGreaterThan(conn.commit.mock.invocationCallOrder[0]);
  expect(global.setImmediate.mock.invocationCallOrder[0]).toBeGreaterThan(conn.commit.mock.invocationCallOrder[0]);
});

test('credit post-commit snapshot and read failures return the known inserted record without rollback', async () => {
  const conn = makeConnection();
  db.getPool.mockReturnValue({ getConnection: async () => conn });
  jest.spyOn(Settlement, 'syncBalanceSnapshot').mockRejectedValue(new Error('snapshot failed'));
  Account.findById.mockRejectedValueOnce(new Error('read failed'));
  await expect(CreditAccount.create(input)).resolves.toMatchObject({ id: 'record-id', amount: 40 });
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
});

test('credit failure before its own commit still rolls back and never schedules a snapshot', async () => {
  const conn = makeConnection();
  db.getPool.mockReturnValue({ getConnection: async () => conn });
  CreditCore.syncCardBills.mockRejectedValueOnce(new Error('bill sync failed'));
  await expect(CreditAccount.create(input)).rejects.toThrow('bill sync failed');
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(global.setImmediate).not.toHaveBeenCalled();
});

test.each([CreditAccount, DebitAccount])('an external create refuses a missing or foreign card before insert', async model => {
  const conn = makeConnection(model === CreditAccount ? 'credit' : 'debit', { ownsCard: false });
  await expect(model.create(input, conn)).rejects.toThrow('卡片不存在');
  expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO account\s/.test(typeof sql==='string'?sql:sql.sql))).toBe(false);
  expectCallerOwnsTransaction(conn);
});

test('debit external executor locks the card before same-connection balance reads and atomic snapshot writes', async () => {
  const conn = makeConnection('debit');
  const calculate = jest.spyOn(Settlement, 'calculateBalance');
  const record = await DebitAccount.create(input, conn);
  expect(record.id).toBe('record-id');
  const queries = conn.execute.mock.calls.map(([sql]) => typeof sql==='string'?sql:sql.sql);
  const lockIndex = queries.findIndex(sql => /card_base.*FOR UPDATE/.test(sql));
  const balanceIndex = queries.findIndex(sql => /FROM account\s/.test(sql));
  const insertIndex = queries.findIndex(sql => /INSERT INTO account\s/.test(sql));
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(balanceIndex).toBeGreaterThan(lockIndex);
  expect(insertIndex).toBeGreaterThan(balanceIndex);
  expect(calculate.mock.calls.every(([, , executor]) => executor === conn)).toBe(true);
  expect(queries.some(sql => /INSERT INTO account_balance/.test(sql))).toBe(true);
  expect(queries.some(sql => /FROM account_balance/.test(sql))).toBe(true);
  expectCallerOwnsTransaction(conn);
});

test('debit external legacy virtual accounts lock the user but cannot treat a missing card as usable funds', async () => {
  const conn = makeConnection('debit', { ownsCard: false });
  await expect(DebitAccount.create({ ...input, cardId: 'xxxx' }, conn)).rejects.toThrow('账户不存在');
  const queries = conn.execute.mock.calls.map(([sql]) => typeof sql==='string'?sql:sql.sql);
  const lockIndex = queries.findIndex(sql => /user_info.*FOR UPDATE/.test(sql));
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(queries.some(sql=>/INSERT INTO account\s|FROM account\s/.test(sql))).toBe(false);
  expectCallerOwnsTransaction(conn);
});

test('debit initialized virtual accounts use the same card row lock as other account writers', async () => {
  const conn = makeConnection('virtual_cash',{cardId:'xxxx'});
  await DebitAccount.create({ ...input, cardId: 'xxxx' }, conn);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['xxxx', USER]);
  expect(conn.execute.mock.calls.some(([sql]) => /FROM user_info/.test(sql))).toBe(false);
  expectCallerOwnsTransaction(conn);
});

test('debit insufficient funds are rejected before the account insert', async () => {
  const conn = makeConnection('debit', { balance: 20 });
  await expect(DebitAccount.create(input, conn)).rejects.toThrow('不足');
  expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO account\s/.test(typeof sql==='string'?sql:sql.sql))).toBe(false);
  expectCallerOwnsTransaction(conn);
});

test('debit ordinary create owns the transaction, keeps snapshot atomic and reads only after commit', async () => {
  const conn = makeConnection('debit');
  db.getConnection.mockResolvedValue(conn);
  await expect(DebitAccount.create(input)).resolves.toMatchObject({ id: 'record-id', fullRecord: true });
  expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(conn.query).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  expect(conn.query.mock.invocationCallOrder[0]).toBeLessThan(conn.beginTransaction.mock.invocationCallOrder[0]);
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [CARD, USER]);
  expect(db.execute).not.toHaveBeenCalled();
  expect(Account.findById.mock.invocationCallOrder[0]).toBeGreaterThan(conn.commit.mock.invocationCallOrder[0]);
  expect(global.setImmediate.mock.invocationCallOrder[0]).toBeGreaterThan(conn.commit.mock.invocationCallOrder[0]);
});

test('debit snapshot failure rolls the ordinary insert back before commit', async () => {
  const conn = makeConnection('debit');
  db.getConnection.mockResolvedValue(conn);
  jest.spyOn(Settlement, 'syncBalanceSnapshot').mockRejectedValueOnce(new Error('snapshot failed'));
  await expect(DebitAccount.create(input)).rejects.toThrow('snapshot failed');
  expect(conn.commit).not.toHaveBeenCalled();
  expect(conn.rollback).toHaveBeenCalledTimes(1);
  expect(conn.release).toHaveBeenCalledTimes(1);
  expect(Account.findById).not.toHaveBeenCalled();
  expect(global.setImmediate).not.toHaveBeenCalled();
});

test('debit post-commit record read failure returns the known inserted record', async () => {
  const conn = makeConnection('debit');
  db.getConnection.mockResolvedValue(conn);
  Account.findById.mockRejectedValueOnce(new Error('read failed'));
  await expect(DebitAccount.create(input)).resolves.toMatchObject({ id: 'record-id', amount: 40 });
  expect(conn.commit).toHaveBeenCalledTimes(1);
  expect(conn.rollback).not.toHaveBeenCalled();
  expect(conn.release).toHaveBeenCalledTimes(1);
});

test('ordinary debit cannot bypass source validation by injecting a transfer group',async()=>{
  const conn=makeConnection('debit');
  await expect(DebitAccount.create({...input,transferGroupId:'forged-group'},conn)).rejects.toThrow('普通收支不允许');
  expect(conn.execute).not.toHaveBeenCalled();expectCallerOwnsTransaction(conn);
});

test.each([{transferGroupId:'forged-group'},{transferGroupId:null}])('caller payType does not create a transfer exception for an ordinary category',async(extra)=>{
  const conn=makeConnection('debit');
  await expect(DebitAccount.create({...input,payType:'转账',...extra},conn)).rejects.toThrow('本人有效的转账分类');
  expect(conn.execute.mock.calls.some(([sql])=>/INSERT INTO account\s/.test(typeof sql==='string'?sql:sql.sql))).toBe(false);
  expectCallerOwnsTransaction(conn);
});

test('a missing/foreign transfer category cannot authorize the legacy transfer path',async()=>{
  const conn=makeConnection('debit',{categoryName:'转账',ownsCategory:false});
  await expect(DebitAccount.create({...input,payType:'转账',transferGroupId:'forged-group'},conn)).rejects.toThrow('本人有效的转账分类');
  expectCallerOwnsTransaction(conn);
});

test.each([null,'legacy-transfer-group'])('verified owner transfer category preserves legacy external and paired-leg semantics',async(transferGroupId)=>{
  const conn=makeConnection('debit',{categoryName:'转账'});
  await expect(DebitAccount.create({...input,payType:'转账',transferGroupId},conn)).resolves.toMatchObject({id:'record-id',amount:40});
  expect(conn.execute).toHaveBeenCalledWith(expect.stringContaining('FROM bus_category WHERE id=? AND user_id=?'),['category-id',USER]);
  expectCallerOwnsTransaction(conn);
});

test('credit creates reject transfer groups before acquiring a writable transaction',async()=>{
  const conn=makeConnection('credit');
  await expect(CreditAccount.create({...input,transferGroupId:'forged-group'},conn)).rejects.toThrow('信用卡普通消费不允许');
  expect(conn.execute).not.toHaveBeenCalled();expectCallerOwnsTransaction(conn);
});
