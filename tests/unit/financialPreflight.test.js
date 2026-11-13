const {preflightTransaction,decimalUnits,moneyString,MAX_SOURCE_ROWS,isOrdinaryRecord,validateOrdinaryRecord}
  =require('../../src/common/services/financialPreflight');
const now=new Date('2026-11-06T04:00:00Z');
const fields={accountId:'card-000',direction:0,amount:'1000.00',currency:'CNY',transDate:'2026-11-06'};
const card={id:'card-000',card_type:'debit',currency:'CNY',status:'正常',share_pool_id:null,update_time:'1'};
const entry=(amount='1500.0000',direction=1,extra={})=>({id:`row-${direction}`,card_id:'card-000',currency:'CNY',direction,
  amount,exchange_rate:'1.0000',trans_date:'2026-11-05',category_id:'category',reversed_id:null,create_time:'1',update_time:'1',...extra});
function fixture({cardRow=card,ledger=[entry()],cards,registers=[],repayments=[],pool}={}) {
  const calls=[];
  const executor={execute:jest.fn(async(input,params)=>{
    const sql=typeof input==='string'?input:input.sql;calls.push({sql,params});
    if (sql.includes('FROM card_base') && sql.includes('AND id = ?')) return [[...(cardRow?[cardRow]:[])]];
    if (sql.includes('FROM card_base')) return [[...(cards || [cardRow])]];
    if (sql.includes('FROM card_credit_pool')) return [[...(pool?[pool]:[])]];
    if (sql.includes('FROM card_foreign_register')) return [[...registers]];
    if (sql.includes('FROM card_repay')) return [[...repayments]];
    if (sql.includes('FROM account')) return [[...ledger]];
    throw new Error('UNEXPECTED_SQL');
  })};
  return {executor,calls};
}
test.each([
 ['1500.00','pass','1500.00',null,'500.00'],
 ['1000.00','pass','1000.00',null,'0.00'],
 ['999.99','block','999.99','0.01','-0.01'],
 ['500.00','block','500.00','500.00','-500.00'],
])('strict ledger %s versus 1000 has exact monetary result',async(amount,status,available,shortfall,remaining)=>{
  const {executor,calls}=fixture({ledger:[entry(amount)]});
  const check=await preflightTransaction(executor,'owner',fields,{now});
  expect(check).toMatchObject({status,availableAmount:available,shortfall,remainingAmount:remaining,bankBalanceVerified:false,coverage:'complete'});
  if (status==='block') expect(check.reasonCodes).toContain('INSUFFICIENT_FUNDS');
  for (const {sql,params} of calls) {expect(sql).toMatch(/^SELECT/);expect(sql).not.toMatch(/account_balance|INSERT|FOR UPDATE/);expect(params[0]).toBe('owner');}
});
test('one-cent and 39.91 stay exact while legacy fractional CNY is not silently corrected',async()=>{
  const f=fixture({ledger:[entry('0.0100')]});
  expect(await preflightTransaction(f.executor,'owner',{...fields,amount:'0.01'},{now})).toMatchObject({status:'pass',remainingAmount:'0.00'});
  const cents=fixture({ledger:[entry('40.0000'),entry('0.09',0)]});
  expect(await preflightTransaction(cents.executor,'owner',{...fields,amount:'39.9100'},{now})).toMatchObject({status:'pass',remainingAmount:'0.00',requestedAmount:'39.91'});
  const dirty=fixture({ledger:[entry('39.9099')]});
  expect(await preflightTransaction(dirty.executor,'owner',{...fields,amount:'0.01'},{now})).toMatchObject({status:'block',reasonCodes:['SOURCE_INVALID_AMOUNT'],availableAmount:null});
});
test('invalid/ambiguous request fields stop before source access',async()=>{
  const {executor}=fixture();
  for (const input of [{accountId:null},{amount:'0'},{amount:'0.001'},{amount:'1e3'},{amount:'NaN'},{currency:'HKD'},
    {direction:3},{transDate:'2026-02-30'},{transDate:'2026-11-07'},{amount:'10000000000.00'}]) {
    const check=await preflightTransaction(executor,'owner',{...fields,...input},{now});
    expect(['block','needs_input']).toContain(check.status);
  }
  expect(executor.execute).not.toHaveBeenCalled();
});
test.each([
 [null,'ACCOUNT_UNAVAILABLE'],[{...card,status:'挂失'},'ACCOUNT_INACTIVE'],[{...card,currency:null},'ACCOUNT_CURRENCY_MISMATCH'],
 [{...card,card_type:'unknown'},'ACCOUNT_INACTIVE'],
])('invalid card cannot disclose balance or access ledger',async(cardRow,reason)=>{
  const {executor,calls}=fixture({cardRow});
  expect(await preflightTransaction(executor,'owner',fields,{now})).toMatchObject({status:'block',reasonCodes:[reason],availableAmount:null});
  expect(calls).toHaveLength(1);
});
test.each([
 [{amount:'oops'},'SOURCE_INVALID_AMOUNT'],[{direction:2},'SOURCE_INVALID_DIRECTION'],[{currency:null},'SOURCE_CURRENCY_MISSING'],
 [{currency:'USD',amount:'100.00',exchange_rate:'700.00'},'SOURCE_CURRENCY_MISMATCH'],
 [{trans_date:'2026-11-07'},'SOURCE_INVALID_DATE'],[{trans_date:'2026-11-05bad'},'SOURCE_INVALID_DATE'],
])('dirty source never becomes zero or a usable estimate',async(extra,reason)=>{
  const {executor}=fixture({ledger:[entry('1500.00',1,extra)]});
  expect(await preflightTransaction(executor,'owner',fields,{now})).toMatchObject({status:'block',reasonCodes:[reason],availableAmount:null});
});
test('no snapshot is needed, no ledger is unknown for expense, explicit income can initialize accounting',async()=>{
  const {executor,calls}=fixture({ledger:[]});
  expect(await preflightTransaction(executor,'owner',fields,{now})).toMatchObject({status:'needs_input',reasonCodes:['FUNDS_NOT_REGISTERED'],availableAmount:null});
  expect(await preflightTransaction(executor,'owner',{...fields,direction:1},{now})).toMatchObject({status:'pass',availableAmount:'0.00',remainingAmount:'1000.00'});
  expect(calls.every(call=>!call.sql.includes('account_balance'))).toBe(true);
});

test.each([
  ['debit', '现金'], ['credit', '余额'], ['virtual_cash', '银行卡'], ['virtual_balance', '现金'],
])('funding identity conflict %s / %s blocks before reading funds', async (type, payMethod) => {
  const { executor, calls } = fixture({ cardRow: { ...card, card_type: type } });
  expect(await preflightTransaction(executor, 'owner', { ...fields, payMethod }, { now }))
    .toMatchObject({ status: 'block', reasonCodes: ['ACCOUNT_PAYMENT_CONFLICT'], availableAmount: null });
  expect(calls).toHaveLength(1);
});

test.each(['微信', '支付宝', '银行卡', '借记卡'])(
  'a linked-bank channel remains valid for ordinary debit accounting: %s', async payMethod => {
    const { executor } = fixture();
    expect(await preflightTransaction(executor, 'owner', { ...fields, payMethod }, { now })).toMatchObject({ status: 'pass', availableAmount: '1500.00' });
  });
test('historic input retains current ledger semantics and insufficient history is not bypassed',async()=>{
  const {executor}=fixture({ledger:[entry('600.00')]});
  expect(await preflightTransaction(executor,'owner',{...fields,transDate:'2026-10-01'},{now})).toMatchObject({status:'block',isHistorical:true,reasonCodes:['INSUFFICIENT_FUNDS']});
});
test('truncation and read failure close the gate with no confident balance',async()=>{
  const tooMany=fixture({ledger:Array.from({length:MAX_SOURCE_ROWS+1},(_,i)=>entry('1.00',1,{id:String(i)}))});
  expect(await preflightTransaction(tooMany.executor,'owner',fields,{now})).toMatchObject({status:'block',reasonCodes:['SOURCE_TOO_LARGE'],availableAmount:null});
  const failed={execute:jest.fn().mockRejectedValue(new Error('credentials must not escape'))};
  const check=await preflightTransaction(failed,'owner',fields,{now});
  expect(check).toMatchObject({status:'needs_input',reasonCodes:['FUNDS_READ_UNAVAILABLE'],availableAmount:null});
  expect(JSON.stringify(check)).not.toContain('credentials');
});
test('stable source and fields digests are independent of checkedAt, changes invalidate them',async()=>{
  const {executor}=fixture();
  const a=await preflightTransaction(executor,'owner',fields,{now});
  const b=await preflightTransaction(executor,'owner',fields,{now:new Date(now.getTime()+1000)});
  expect(a.sourceDigest).toBe(b.sourceDigest);expect(a.fieldsDigest).toBe(b.fieldsDigest);expect(a.asOf).not.toBe(b.asOf);
  const changed=await preflightTransaction(executor,'owner',{...fields,amount:'999.00'},{now});
  expect(changed.fieldsDigest).not.toBe(a.fieldsDigest);
});
test('explicit ordinary scope cannot be bypassed through payType; dedicated structural services remain separate',async()=>{
  const record={strictOrdinary:true,user_id:'owner',card_id:'card-000',direction:0,amount:'1000.00',currency:'CNY',trans_date:'2026-11-06',pay_type:'转账'};
  expect(isOrdinaryRecord(record)).toBe(true);
  const {executor}=fixture();
  expect(await validateOrdinaryRecord(record,executor,{now})).toMatchObject({valid:false,financialCheck:{reasonCodes:['SPECIAL_TRANSACTION_FORBIDDEN']}});
  expect(executor.execute).not.toHaveBeenCalled();
  expect(isOrdinaryRecord({...record,transfer_group_id:'trusted-generated-group'})).toBe(false);
  expect(isOrdinaryRecord({...record,category_id:'CATEGORY_REPAY'})).toBe(false);
  expect(isOrdinaryRecord({...record,strictOrdinary:false})).toBe(false);
});
const creditCard={...card,card_type:'credit',credit_limit:'5000.00',temp_limit:'0.00',bill_day:15,repay_day:25};
test('credit uses only explicitly supplied CreditCore aggregate after complete source validation',async()=>{
  const {executor}=fixture({cardRow:creditCard,ledger:[entry('3500.00',0)]});
  const creditAggregate=jest.fn(async(owner,conn)=>{
    expect(owner).toBe('owner');expect(conn).not.toBe(executor);
    await expect(conn.execute('UPDATE account SET amount=0',[])).rejects.toThrow('READ_ONLY_REQUIRED');
    return {cards:[{shared:false,cardId:'card-000',avail:'1500.0000'}]};
  });
  expect(await preflightTransaction(executor,'owner',fields,{now,creditAggregate})).toMatchObject({status:'pass',source:'authoritative-credit-core',availableAmount:'1500.0000',remainingAmount:'500.0000'});
  expect(creditAggregate).toHaveBeenCalledTimes(1);
});
test('missing pool or aggregate group never falls back to static total credit',async()=>{
  const poolCard={...creditCard,share_pool_id:'pool'};
  const missing=fixture({cardRow:poolCard,ledger:[]});const aggregate=jest.fn();
  expect(await preflightTransaction(missing.executor,'owner',fields,{now,creditAggregate:aggregate})).toMatchObject({status:'block',reasonCodes:['CREDIT_POOL_MISSING'],availableAmount:null});
  expect(aggregate).not.toHaveBeenCalled();
  const standalone=fixture({cardRow:creditCard,ledger:[]});
  expect(await preflightTransaction(standalone.executor,'owner',fields,{now,creditAggregate:async()=>({cards:[]})})).toMatchObject({status:'block',reasonCodes:['CREDIT_GROUP_MISSING'],availableAmount:null});
});
test('credit with missing FX evidence cannot obtain a green light from aggregation',async()=>{
  const {executor}=fixture({cardRow:creditCard,ledger:[entry('100.0000',0,{currency:'USD',exchange_rate:'700.0000'})]});
  const aggregate=jest.fn();
  expect(await preflightTransaction(executor,'owner',fields,{now,creditAggregate:aggregate})).toMatchObject({status:'block',reasonCodes:['FOREIGN_SOURCE_MISSING']});
  expect(aggregate).not.toHaveBeenCalled();
});
test('credit comparisons preserve sub-cent availability and never use epsilon to overspend',async()=>{
  const {executor}=fixture({cardRow:creditCard,ledger:[]});
  expect(await preflightTransaction(executor,'owner',fields,{now,creditAggregate:async()=>({cards:[{shared:false,cardId:'card-000',avail:'999.9999'}]})}))
    .toMatchObject({status:'block',shortfall:'0.0001',reasonCodes:['INSUFFICIENT_FUNDS']});
});
test('decimal parser does not tolerate NaN/Infinity/exponent/extra cents or convert failures to zero',()=>{
  for (const value of [null,undefined,NaN,Infinity,'1e3','39.9099','oops']) expect(decimalUnits(value)).toBeNull();
  expect(decimalUnits('39.9100')).toBe(3991n);expect(moneyString(3991n)).toBe('39.91');
});

test('the whole financial read has a deadline and never starts a later query after expiry',async()=>{
  const executor={execute:jest.fn(async()=>{
    await new Promise(resolve=>setTimeout(resolve,12));
    return [[card]];
  })};
  const checked=await preflightTransaction(executor,'owner',fields,{now,timeoutMs:5});
  expect(checked).toMatchObject({status:'needs_input',reasonCodes:['FUNDS_READ_TIMEOUT'],availableAmount:null});
  expect(executor.execute).toHaveBeenCalledTimes(1);
  expect(executor.execute.mock.calls[0][0].timeout).toBeLessThanOrEqual(5);
});

test('credit source bound is across all cards and stops before aggregate instead of partial totals',async()=>{
  const cards=[creditCard,{...creditCard,id:'card-001'}];
  const ledger=Array.from({length:2501},(_,i)=>entry('1.00',0,{id:String(i)}));
  const {executor}=fixture({cardRow:creditCard,cards,ledger});
  const creditAggregate=jest.fn();
  const checked=await preflightTransaction(executor,'owner',fields,{now,creditAggregate});
  expect(checked).toMatchObject({status:'block',reasonCodes:['SOURCE_TOO_LARGE'],availableAmount:null});
  expect(creditAggregate).not.toHaveBeenCalled();
});
