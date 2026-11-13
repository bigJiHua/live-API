jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Public DB forbidden');}),getConnection:jest.fn(()=>{throw new Error('Public DB forbidden');})}));
jest.mock('mysql2/promise',()=>({createPool:jest.fn(()=>{throw new Error('MySQL forbidden');})}));
const express=require('express');const crypto=require('crypto');
const {createAiRouter}=require('../../src/modules/ai/api');
const {createTestService,testEnv,createMemoryCandidateStore}=require('../helpers/aiFixture');
const {createFinancialWorkflow}=require('../../src/modules/ai/service/financialWorkflow');
const fields={amount:'39.91',direction:0,currency:'CNY',transDate:'2026-11-05',accountId:'fixture_balance',categoryId:'fixture_food',payMethod:'微信',remark:'午饭'};
let server,base,service,provider,saveCandidate;
beforeAll(async()=>{
  const candidateStore=createMemoryCandidateStore({now:()=>new Date('2026-11-05T08:00:00Z')});
  saveCandidate=createFinancialWorkflow({candidateStore}).candidate;
  provider=jest.fn(()=>{throw new Error('Local flow must never invoke provider');});service=createTestService({chat:provider,candidateStore});
  const app=express();app.use(express.json());
  app.use('/api/v1/ai',createAiRouter({service,env:testEnv(),guard:(req,res,next)=>{
    if(!req.headers['x-test-user'])return res.status(401).json({status:401});req.userId=req.headers['x-test-user'];next();
  }}));
  server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});base=`http://127.0.0.1:${server.address().port}/api/v1/ai`;
});
afterAll(async()=>{
  await new Promise(resolve=>server.close(resolve));await service.close();
  expect(provider).not.toHaveBeenCalled();expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
});
const call=async(path,body,user='owner',method='POST')=>{
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(user?{'x-test-user':user}:{})},
    ...(body?{body:JSON.stringify({data:body})}:{})});return {httpStatus:response.status,...await response.json()};
};
test('all local finance routes require identity and preflight is pure without provider consent',async()=>{
  expect((await call('/v3/transaction/preflight',{fields},null)).httpStatus).toBe(401);
  const result=await call('/v3/transaction/preflight',{fields});
  expect(result.data).toMatchObject({contractVersion:2,financialCheck:{status:'pass',direction:0,bankBalanceVerified:false}});
  expect(result.data.draft).toBeUndefined();
});
test('invalid amount returns actionable financial DTO without creating a draft',async()=>{
  const result=await call('/v3/transaction/preflight',{fields:{...fields,amount:'39.9099'}});
  expect(result.data.financialCheck).toMatchObject({status:'needs_input',availableAmount:null,reasonCodes:['AI_AMOUNT_INVALID']});
  const create=await call('/v3/transaction/draft',{fields:{...fields,amount:'39.9099'},requestId:crypto.randomUUID()});
  expect(create).toMatchObject({httpStatus:409,code:'AI_FINANCIAL_CHECK_BLOCKED',financialCheck:{status:'needs_input'}});
});
test('local create requires stable request UUID, replays one draft and GET receipt without paid budget',async()=>{
  expect((await call('/v3/transaction/draft',{fields})).httpStatus).toBe(400);
  const requestId=crypto.randomUUID(),input={fields,requestId};
  const created=await call('/v3/transaction/draft',input,'local');
  expect(created.data).toMatchObject({contractVersion:2,draft:{status:'pending'},request:{requestId,providerCalls:0,maxProviderCalls:0}});
  expect((await call('/v3/transaction/draft',input,'local')).data.draft.id).toBe(created.data.draft.id);
  const receipt=await call('/v3/requests/'+requestId,null,'local','GET');
  expect(receipt.data).toMatchObject({status:'completed',providerCalls:0,maxProviderCalls:0});
});
test('candidate GET/DELETE are owner-bound; cancellation remains ended across reload',async()=>{
  const checked=await service.financialPreflight('candidate-owner',{fields:{...fields,accountId:null}});
  const candidate=await saveCandidate('candidate-owner',checked,{source:'user-readonly'});
  const url='/v3/transaction/candidates/'+candidate.id;
  expect((await call(url,null,'other','GET')).httpStatus).toBe(404);
  expect((await call(url,null,'candidate-owner','GET')).data.inputCandidate.id).toBe(candidate.id);
  expect((await call(url,null,'candidate-owner','DELETE')).data.cancelled).toBe(true);
  const ended=await call(url,null,'candidate-owner','GET');
  expect(ended.data.financialCheck).toMatchObject({status:'block',reviewValid:false,requiresAcknowledgement:false});
  expect((await call('/v3/transaction/draft',{sourceCandidateId:candidate.id,fields,requestId:crypto.randomUUID()},'candidate-owner')).httpStatus).toBe(409);
});
test('unknown identity, SQL and arbitrary risk pass fields are rejected at local input boundary',async()=>{
  for(const extra of [{userId:'other'},{sql:'SELECT * FROM user_info'},{financialCheck:{status:'pass'}},{riskAcknowledgement:{acknowledged:true}}])
    expect((await call('/v3/transaction/preflight',{fields,...extra},'schema')).httpStatus).toBe(400);
});
