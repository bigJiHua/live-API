jest.mock('../../src/common/config/db',()=>({}));
jest.mock('../../src/modules/card/model',()=>({findAll:jest.fn()}));
jest.mock('../../src/modules/card/model/pool',()=>({findById:jest.fn()}));
jest.mock('../../src/modules/card/model/bill',()=>({
  getBillMonthByDate:date=>date.slice(0,7),getCurrentBillMonth:()=> '2026-11',
  calculateBillPeriod:month=>({billStartDate:`${month}-01`,billEndDate:`${month}-28`}),
  calculateRepayDate:month=>`${month}-25`,
}));
const Card=require('../../src/modules/card/model');
const Pool=require('../../src/modules/card/model/pool');
const {preflightTransaction}=require('../../src/common/services/financialPreflight');
const now=new Date('2026-11-06T04:00:00Z');
function realCreditFixture({shared=false,limit='1000.00',spent='960.09'}={}) {
  const cards=[{id:'card-A',card_type:'credit',currency:'CNY',status:'正常',alias:'000',credit_limit:limit,temp_limit:'0.00',
    bill_day:15,repay_day:25,share_pool_id:shared?'pool':null,update_time:'1'}];
  if (shared) cards.push({...cards[0],id:'card-B',alias:'111'});
  const ledger=[{id:'flow-A',card_id:'card-A',currency:'CNY',direction:0,amount:spent,exchange_rate:'1.00',
    trans_date:'2026-11-05',category_id:'traffic',reversed_id:null,update_time:'1'}];
  if (shared) ledger.push({...ledger[0],id:'flow-B',card_id:'card-B',amount:'1000.00'});
  const pool={id:'pool',currency:'CNY',bank_name:'Test',total_credit_limit:'5000.00',total_temp_limit:'0.00',update_time:'1'};
  const calls=[];
  const executor={execute:jest.fn(async(input,params)=>{
    const sql=typeof input==='string'?input:input.sql;calls.push(sql);
    if (sql.includes('FROM card_base') && sql.includes('AND id = ?')) return [[cards.find(c=>c.id===params[1])].filter(Boolean)];
    if (sql.includes('FROM card_base')) return [cards];
    if (sql.includes('FROM card_credit_pool')) return [[pool]];
    if (sql.includes('AS net FROM')) return [[{net:'4000.0000'}]];
    if (sql.includes('SUM(registered_rmb)') || sql.includes('SUM(fr.registered_rmb)')) return [[{total:'0.0000'}]];
    if (sql.includes('FROM card_foreign_register')) return [[]];
    if (sql.includes('FROM card_repay')) return [[]];
    if (sql.includes('FROM card_bill')) return [[]];
    if (sql.includes('SELECT reversed_id')) return [[]];
    if (sql.includes('FROM account')) {
      const cardId=sql.includes('WHERE user_id = ?')?params[1]:params[0];
      return [ledger.filter(row=>row.card_id===cardId)];
    }
    throw new Error('UNEXPECTED_READ');
  })};
  Card.findAll.mockImplementation(async(owner,filter,conn)=>{
    expect(owner).toBe('owner');expect(filter).toEqual({cardType:'credit'});expect(conn).toBeDefined();
    await conn.execute("SELECT id FROM card_base WHERE user_id = ? AND card_type = 'credit'",[owner]);
    return cards;
  });
  Pool.findById.mockImplementation(async(id,owner,conn)=> (await conn.execute('SELECT id,total_credit_limit,total_temp_limit,bank_name FROM card_credit_pool WHERE user_id = ? AND id = ?',[owner,id]))[0][0]);
  return {executor,calls};
}
beforeEach(()=>jest.clearAllMocks());
test('actual CreditCore ordinary CNY aggregate keeps 39.91 exact with explicit read executor and no snapshot write',async()=>{
  const {executor,calls}=realCreditFixture();
  const checked=await preflightTransaction(executor,'owner',{accountId:'card-A',direction:0,amount:'39.91',currency:'CNY',transDate:'2026-11-06'},{now});
  expect(checked).toMatchObject({status:'pass',source:'authoritative-credit-core',availableAmount:'39.9100',remainingAmount:'0.0000'});
  expect(Card.findAll).toHaveBeenCalledTimes(1);
  expect(calls.every(sql=>/^SELECT/.test(sql) && !/account_balance|INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
});
test('actual CreditCore shared pool counts both cards debt once and uses authoritative pool limit',async()=>{
  const {executor,calls}=realCreditFixture({shared:true,limit:'5000.00',spent:'3000.00'});
  const checked=await preflightTransaction(executor,'owner',{accountId:'card-A',direction:0,amount:'1000.00',currency:'CNY',transDate:'2026-11-06'},{now});
  expect(checked).toMatchObject({status:'pass',source:'authoritative-credit-core',availableAmount:'1000.0000',remainingAmount:'0.0000'});
  expect(Pool.findById).toHaveBeenCalledTimes(1);
  expect(calls.every(sql=>/^SELECT/.test(sql))).toBe(true);
});
