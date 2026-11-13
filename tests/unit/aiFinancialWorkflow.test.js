jest.mock('../../src/common/config/db',()=>({execute:()=>{throw new Error('Public DB forbidden');}}));
jest.mock('mysql2/promise',()=>({createPool:()=>{throw new Error('MySQL forbidden');}}));
const {createFinancialWorkflow}=require('../../src/modules/ai/service/financialWorkflow');
const {createMemoryFinancialRepository,createTestRepository}=require('../helpers/aiFixture');
const now=()=>new Date('2026-11-06T04:00:00Z');
const fields={amount:'39.91',direction:0,currency:'CNY',transDate:'2026-11-06',accountId:'fixture_balance',categoryId:'fixture_food',payMethod:'微信',remark:'午饭'};
function fixture(options={}) {
  const funds=createMemoryFinancialRepository({now,...options});
  const workflow=createFinancialWorkflow({repository:createTestRepository,financialRepository:()=>funds,now,
    candidateStore:{save:async(_,value)=>({...value,id:'candidate'})},...options.workflow});
  return {workflow,funds};
}
test('ordinary amount is canonical and trusted four-place funds are never rounded on comparison',async()=>{
  const {workflow}=fixture();
  const result=await workflow.inspect('owner',{fields:{...fields,amount:'39.9100'}});
  expect(result.fields.amount).toBe('39.91');expect(result.financialCheck.status).toBe('pass');
  expect(result.financialCheck.bankBalanceVerified).toBe(false);
});
test.each(['39.9099','0.001','0','-1','1e3'])('invalid amount %s never causes a financial source query',async amount=>{
  const check=jest.fn();const {workflow}=fixture({workflow:{financialRepository:()=>({check})}});
  const result=await workflow.inspect('owner',{fields:{...fields,amount}});
  expect(result.financialCheck.status).toBe('needs_input');expect(check).not.toHaveBeenCalled();
});
test('unavailable balance fails closed and no zero balance is invented',async()=>{
  const {workflow}=fixture({workflow:{financialRepository:()=>({check:async()=>{throw new Error('offline');}})}});
  const result=await workflow.inspect('owner',{fields});
  expect(result.financialCheck).toMatchObject({status:'needs_input',availableAmount:null,reasonCodes:['FUNDS_READ_UNAVAILABLE']});
  expect(()=>workflow.assertUsable(result.financialCheck)).toThrow();
});

test.each(['repository', 'transaction'])('asynchronous optional history permission failure preserves funds and degrades baseline through %s', async path => {
  const funds = createMemoryFinancialRepository({ now });
  const executor = { execute: jest.fn(async (input, params) => {
    const sql = typeof input === 'string' ? input : input.sql;
    if (sql.includes('LIMIT 501')) throw Object.assign(new Error('baseline column access denied'), { code: 'ER_COLUMNACCESS_DENIED_ERROR' });
    return funds.executor.execute(input, params);
  }) };
  const { workflow } = fixture({ workflow: { financialRepository: () => ({
    check: funds.check, read: work => work(async (sql, params) => (await executor.execute(sql, params))[0]),
  }) } });
  const result = await workflow.inspect('owner', { fields }, path === 'transaction' ? { executor } : {});
  expect(result.financialCheck).toMatchObject({ availableAmount: '100000.00', requestedAmount: '39.91', remainingAmount: '99960.09' });
  expect(result.financialCheck.reasonCodes).toContain('BASELINE_UNAVAILABLE');
  expect(result.financialCheck.reasonCodes).not.toContain('FUNDS_READ_UNAVAILABLE');
  expect(result.baseline).toMatchObject({ available: false, baselineUnavailable: true, reasonCode: 'BASELINE_UNAVAILABLE' });
  expect(result.duplicates).toEqual([]);
});
test('missing account preserves valid cents for local correction; payment channel does not choose an account',async()=>{
  const {workflow}=fixture();const result=await workflow.inspect('owner',{message:'微信支出39.91元'});
  expect(result.fields.amount).toBe('39.91');expect(result.financialCheck.reasonCodes).toEqual(['AI_ACCOUNT_MISSING']);
  expect(result.financialCheck.availableAmount).toBeNull();
});
test('insufficient real ledger blocks candidate and acknowledgement cannot bypass it',async()=>{
  const {workflow}=fixture({ledger:[{id:'seed',currency:'CNY',direction:1,amount:'20.00',trans_date:'2026-11-06'}]});
  const result=await workflow.inspect('owner',{fields});
  expect(result.financialCheck).toMatchObject({status:'block',availableAmount:'20.00',shortfall:'19.91'});
  expect(()=>workflow.checkAcknowledgement(result.financialCheck,{...result.financialCheck})).toThrow();
});
test('large amount requires exact acknowledgement and high amount requires handwritten full amount',async()=>{
  const {workflow}=fixture();const {financialCheck:check}=await workflow.inspect('owner',{fields:{...fields,amount:'10000'}});
  expect(check).toMatchObject({status:'warn',requiresAcknowledgement:true,requiresAmountConfirmation:true});
  const ack={fieldsDigest:check.fieldsDigest,policyVersion:check.policyVersion,riskDigest:check.riskDigest};
  expect(()=>workflow.checkAcknowledgement(check,ack)).toThrow('手工');
  expect(()=>workflow.checkAcknowledgement(check,{...ack,confirmedAmount:'10000.00'})).not.toThrow();
  expect(()=>workflow.checkAcknowledgement(check,{...ack,confirmedAmount:'1000'})).toThrow();
});
test('review digest ignores read timestamps but changes with funds, fields, policy and review version',async()=>{
  const {workflow}=fixture();const first=(await workflow.inspect('owner',{fields},{version:1})).financialCheck;
  expect((await workflow.inspect('owner',{fields},{version:1})).financialCheck.riskDigest).toBe(first.riskDigest);
  expect((await workflow.inspect('owner',{fields},{version:2})).financialCheck.riskDigest).not.toBe(first.riskDigest);
  expect((await workflow.inspect('owner',{fields:{...fields,amount:'40'}},{version:1})).financialCheck.riskDigest).not.toBe(first.riskDigest);
  const changed=fixture({workflow:{riskPolicy:{largeAmount:'20'}}}).workflow;
  expect((await changed.inspect('owner',{fields},{version:1})).financialCheck.riskDigest).not.toBe(first.riskDigest);
});
test('old reviewed draft without authoritative financial acknowledgement becomes noncommittable',async()=>{
  const {workflow}=fixture();const draft={...fields,id:'old',status:'reviewed',version:2,trace:[]};
  expect(await workflow.enrich('owner',draft)).toMatchObject({reviewInvalid:true,financialCheck:{reviewValid:false}});
  const check=(await workflow.inspect('owner',{fields},{version:1})).financialCheck;
  expect(await workflow.enrich('owner',{...draft,trace:[{tool:'financial_review',result:check}]})).toMatchObject({reviewInvalid:false});
});
test('cancelled/failed/multi-payment OCR evidence can never be converted to ordinary draft by supplying an account',async()=>{
  const {workflow}=fixture();const result=await workflow.inspect('owner',{fields},{sourceCandidate:{source:'image-ocr',eligible:false}});
  expect(result.financialCheck).toMatchObject({status:'block',reasonCodes:['AI_OCR_NOT_ELIGIBLE']});
});
test('missing fields travel with candidate while source fields remain local',async()=>{
  const {workflow}=fixture();const result=await workflow.inspect('owner',{fields:{...fields,payMethod:null,categoryId:null}});
  const candidate=await workflow.candidate('owner',result);
  expect(candidate.missingFields).toEqual(['分类','支付方式']);expect(candidate.fields.accountId).toBe('fixture_balance');
});
test.each(['还款','转账','退款','冲正','分期','repayment'])('editing remark to special intent %s cannot retain ordinary eligibility',async remark=>{
  const {workflow}=fixture();const result=await workflow.inspect('owner',{fields:{...fields,remark}});
  expect(result.financialCheck).toMatchObject({status:'block',reasonCodes:['AI_ACTION_NOT_ALLOWED']});
});
