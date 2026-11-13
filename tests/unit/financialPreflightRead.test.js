jest.mock('mysql2/promise',()=>({createPool:jest.fn()}));
const mysql=require('mysql2/promise');
const {createFinancialReadRepository}=require('../../src/modules/ai/service/financialRead');
const now=()=>new Date('2026-11-06T04:00:00Z');
let conn;
beforeEach(()=>{
  jest.clearAllMocks();
  conn={query:jest.fn().mockResolvedValue(),beginTransaction:jest.fn().mockResolvedValue(),rollback:jest.fn().mockResolvedValue(),release:jest.fn(),
    execute:jest.fn().mockResolvedValue([[]])};
  mysql.createPool.mockReturnValue({getConnection:jest.fn().mockResolvedValue(conn),end:jest.fn().mockResolvedValue()});
});
test('funds read uses its own READ ONLY transaction, exact decimals, bounded SQL and no writable fallback',async()=>{
  const repo=createFinancialReadRepository({user:'ai_readonly'},{now});
  const check=await repo.check('owner',{accountId:'card',direction:0,amount:'1000.00',currency:'CNY',transDate:'2026-11-06'});
  expect(check).toMatchObject({status:'block',reasonCodes:['ACCOUNT_UNAVAILABLE']});
  expect(mysql.createPool).toHaveBeenCalledWith(expect.objectContaining({user:'ai_readonly',decimalNumbers:false,multipleStatements:false}));
  expect(conn.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(conn.rollback).toHaveBeenCalledTimes(1);expect(conn.release).toHaveBeenCalledTimes(1);
  for (const [{sql,timeout}] of conn.execute.mock.calls) {expect(sql).toMatch(/^SELECT/);expect(timeout).toBe(5000);}
});
test('read callback rejects mutations and exposes only a guarded executor',async()=>{
  const repo=createFinancialReadRepository({user:'ai_readonly'},{now});
  await expect(repo.read((select,executor)=>executor.execute('DELETE FROM account'))).rejects.toMatchObject({code:'AI_FUNDS_READ_ONLY'});
  expect(conn.execute).not.toHaveBeenCalled();expect(conn.rollback).toHaveBeenCalledTimes(1);expect(conn.release).toHaveBeenCalledTimes(1);
});
test('connection failures have safe structured errors and never reveal credentials',async()=>{
  conn.beginTransaction.mockRejectedValue(new Error('sensitive-connection-detail'));
  const repo=createFinancialReadRepository({user:'ai_readonly'},{now});
  await expect(repo.read(async()=>{})).rejects.toMatchObject({code:'AI_FUNDS_READ_UNAVAILABLE',message:'资金只读查询失败，请在本地复查'});
  expect(conn.rollback).toHaveBeenCalledTimes(1);expect(conn.release).toHaveBeenCalledTimes(1);
});
test('injected fixtures stay explicit and missing configuration does not use application DB',async()=>{
  const injected=createFinancialReadRepository({executor:conn,now});
  await injected.read(select=>select('SELECT id FROM account WHERE user_id = ?',['owner']));
  expect(mysql.createPool).not.toHaveBeenCalled();
  await expect(createFinancialReadRepository().check('owner',{})).rejects.toMatchObject({code:'AI_FUNDS_READ_UNAVAILABLE'});
});
