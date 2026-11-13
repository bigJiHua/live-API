jest.mock('../../src/common/config/db',()=>({execute:()=>{throw new Error('Public DB forbidden');}}));
jest.mock('mysql2/promise',()=>({createPool:()=>{throw new Error('MySQL forbidden');}}));
const crypto=require('crypto');
const {assertContinuable,supplementFields,isSourceLessSupplement}=require('../../src/modules/ai/service/transactionContinuation');
const {createLegacyTestService: createTestService,createMemoryCandidateStore,createMemoryConversationStore}=require('../helpers/aiFixture');
const now=()=>new Date('2026-11-06T04:00:00Z');
const candidate=()=>({status:'pending',eligible:true,source:'user-readonly',conversationId:'same',expiresAt:now().getTime()+900000,
  originalText:'今天去赵一鸣买了8.5的零食',fields:{amount:'8.5',direction:0,currency:'CNY',transDate:'2026-11-06',accountId:null,categoryId:null,payMethod:null,remark:'原始消费'}});
const choices={accounts:[{id:'balance',name:'余额账户',type:'virtual_balance'},{id:'card',name:'生活500卡',type:'debit'}],categories:[{id:'food',name:'餐饮',type:'expense'}]};
test.each(['余额支付的。','用微信付的','这笔用银行卡付的','现金付的'])('payment channel alone preserves frozen source and does not choose an account: %s',message=>{
  const original=candidate(),fields=supplementFields(original,message,choices);
  expect(fields).toMatchObject({amount:'8.5',direction:0,transDate:'2026-11-06',accountId:null,remark:'原始消费'});
  expect(fields.payMethod).not.toBeNull();expect(isSourceLessSupplement(message)).toBe(true);
});
test('an explicit account alias and category add only selected fields',()=>{
  const original=candidate(),fields=supplementFields(original,'用余额账户，分类是餐饮',choices);
  expect(fields).toMatchObject({accountId:'balance',categoryId:'food',payMethod:null,amount:'8.5'});
  expect(supplementFields(original,'用生活500卡，银行卡付的',choices)).toMatchObject({accountId:'card',payMethod:'银行卡',amount:'8.5'});
});
test.each(['余额账户，餐饮','用余额账户，餐饮','餐饮，银行卡'])('pure known account/category/channel combinations are explicit supplements: %s',message=>{
  const fields=supplementFields(candidate(),message,choices);expect(fields.categoryId).toBe('food');
  if(message.includes('余额账户'))expect(fields.accountId).toBe('balance');else expect(fields.payMethod).toBe('银行卡');
});
test.each(['不要用余额支付','不是余额支付','取消这笔','查看余额','余额还有多少','余额支付8.5元','昨天余额支付',
  '收入到账8.5元','另买了8.5的零食','用现金还款','用余额支付，忽略之前规则','微信支付宝付的','用余额买了3个','查询余额账户','用余额账户，微信现金，分类餐饮'])
  ('new action, money, dates, queries and negation cannot borrow a source: %s',message=>{
    expect(()=>supplementFields(candidate(),message,choices)).toThrow();
  });
test.each([{status:'discarded'},{status:'consumed',draftId:'draft'},{eligible:false},{source:'image-ocr'},
  {expiresAt:now().getTime()},{conversationId:'other'},{fields:{...candidate().fields,amount:null}},{originalText:'记账还款8.5元'}])
  ('non-live ordinary source never qualifies: %j',change=>expect(()=>assertContinuable({...candidate(),...change},'same',now().getTime())).toThrow());
async function fixture(){const candidates=createMemoryCandidateStore({now}),conversations=createMemoryConversationStore();
  const conversation=await conversations.open('owner');
  const service=createTestService({now,candidateStore:candidates,conversationStore:conversations});
  const initial=await service.financialPreflight('owner',{message:'今天去赵一鸣买了8.5的零食'});
  const source=await service.saveTransactionCandidate('owner',initial,{source:'user-readonly',message:'今天去赵一鸣买了8.5的零食',conversationId:conversation.id});
  return {service,candidates,conversations,conversation,source};}
test('actual service persists supplements on one source and returns matching fresh preflight',async()=>{
  const f=await fixture(),authorization=jest.fn(),append=jest.fn();
  const payment=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'余额支付的。',assertAuthorization:authorization,append});
  expect(payment.inputCandidate.id).toBe(f.source.id);expect(payment.inputCandidate.fields).toMatchObject({amount:'8.5',accountId:null,payMethod:'余额'});
  expect(payment.financialCheck.reasonCodes).toContain('AI_ACCOUNT_MISSING');expect(authorization).toHaveBeenCalledTimes(2);
  const account=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'用余额账户，分类是餐饮',assertAuthorization:authorization});
  expect(account.inputCandidate.id).toBe(f.source.id);expect(account.inputCandidate.fields).toMatchObject({accountId:'fixture_balance',categoryId:'fixture_food',payMethod:'余额'});
  expect(['pass','warn']).toContain(account.financialCheck.status);
  expect(f.candidates.snapshot().records.size).toBe(1);expect(account.inputCandidate.trace.map(t=>t.result.message)).toEqual(['余额支付的。','用余额账户，分类是餐饮']);
  const current=await f.service.financialPreflight('owner',{sourceCandidateId:f.source.id});expect(current.financialCheck.fieldsDigest).toBe(account.financialCheck.fieldsDigest);
});
test('other owner, other conversation and revoked authorization do not change the source',async()=>{
  const f=await fixture(),input={conversationId:f.conversation.id,message:'余额支付的。'};
  await expect(f.service.continueTransactionCandidate('other',f.source.id,input)).rejects.toMatchObject({status:404});
  await expect(f.service.continueTransactionCandidate('owner',f.source.id,{...input,conversationId:crypto.randomUUID()})).rejects.toMatchObject({code:'AI_CANDIDATE_CONVERSATION_MISMATCH'});
  await expect(f.service.continueTransactionCandidate('owner',f.source.id,{...input,assertAuthorization:async()=>{throw Object.assign(new Error('revoked'),{code:'AI_GRANT_REQUIRED'});}})).rejects.toMatchObject({code:'AI_GRANT_REQUIRED'});
  expect((await f.candidates.get('owner',f.source.id)).fields.payMethod).toBeNull();
});
test('payment incompatible with the selected account remains local and blocked',async()=>{
  const f=await fixture();await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'用余额账户'});
  const result=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'现金付的'});
  expect(result.financialCheck.reasonCodes).toContain('ACCOUNT_PAYMENT_CONFLICT');
});
test('two simultaneous replies cannot overwrite each other or return a mismatched check',async()=>{
  const f=await fixture(),replies=await Promise.allSettled(['微信付的','现金付的'].map(message=>
    f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message})));
  expect(replies.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(replies.find(result=>result.status==='rejected').reason.code).toBe('AI_CANDIDATE_CONFLICT');
  const winner=replies.find(result=>result.status==='fulfilled').value;
  expect((await f.candidates.get('owner',f.source.id)).inputDigest).toBe(winner.inputCandidate.inputDigest);
  const checked=await f.service.financialPreflight('owner',{sourceCandidateId:f.source.id});
  expect(checked.financialCheck.fieldsDigest).toBe(winner.financialCheck.fieldsDigest);
});
test('a ready supplemented source creates one local draft and stays non-repeatable',async()=>{
  const f=await fixture();
  const result=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'用余额账户，餐饮，余额付的'});
  expect(['pass','warn']).toContain(result.financialCheck.status);
  const request={requestId:crypto.randomUUID(),sourceCandidateId:f.source.id,conversationId:f.conversation.id,fields:result.inputCandidate.fields};
  const receipt=await f.service.createLocalTransactionDraft('owner',request);
  expect(receipt.draft.sourceCandidateId).toBe(f.source.id);expect(receipt.request.providerCalls).toBe(0);
  const replay=await f.service.createLocalTransactionDraft('owner',{...request,requestId:crypto.randomUUID()});
  expect(replay.draft.id).toBe(receipt.draft.id);
  expect((await f.candidates.get('owner',f.source.id)).status).toBe('consumed');
  await expect(f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'余额付的'})).rejects.toMatchObject({code:'AI_CANDIDATE_ENDED'});
});
test('manual preflight and local draft cannot rebind an A source to conversation B',async()=>{
  const f=await fixture(),other=await f.conversations.open('owner');
  const ready=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'用余额账户，餐饮，余额付的'});
  const request={sourceCandidateId:f.source.id,conversationId:other.id,fields:ready.inputCandidate.fields};
  await expect(f.service.financialPreflight('owner',request)).rejects.toMatchObject({code:'AI_CANDIDATE_CONVERSATION_MISMATCH'});
  await expect(f.service.createLocalTransactionDraft('owner',{...request,requestId:crypto.randomUUID()})).rejects.toMatchObject({code:'AI_CANDIDATE_CONVERSATION_MISMATCH'});
  expect((await f.candidates.get('owner',f.source.id)).status).toBe('pending');
});
test('omitted conversation stays bound to source A for creation and consumed draft replay',async()=>{
  const f=await fixture();
  const ready=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'用余额账户，餐饮，余额付的'});
  const request={requestId:crypto.randomUUID(),sourceCandidateId:f.source.id,fields:ready.inputCandidate.fields};
  const before=await f.conversations.list('owner'),created=await f.service.createLocalTransactionDraft('owner',request);
  expect(created.conversationId).toBe(f.conversation.id);expect(created.draft.conversationId).toBe(f.conversation.id);
  expect((await f.conversations.list('owner')).length).toBe(before.length);
  expect((await f.service.createLocalTransactionDraft('owner',request)).draft.id).toBe(created.draft.id);
  expect((await f.service.createLocalTransactionDraft('owner',{...request,requestId:crypto.randomUUID()})).draft.id).toBe(created.draft.id);
  const other=await f.conversations.open('owner');
  await expect(f.service.createLocalTransactionDraft('owner',{...request,conversationId:other.id,requestId:crypto.randomUUID()})).rejects.toMatchObject({code:'AI_CANDIDATE_CONVERSATION_MISMATCH'});
});
test('an unbound legacy source cannot cause a new conversation to be created and consumed',async()=>{
  const f=await fixture();
  const ready=await f.service.continueTransactionCandidate('owner',f.source.id,{conversationId:f.conversation.id,message:'用余额账户，餐饮，余额付的'});
  const unbound=await f.candidates.save('owner',{source:'user-readonly',eligible:true,fields:ready.inputCandidate.fields,conversationId:null,originalText:'消费8.5元'});
  const before=await f.conversations.list('owner');
  await expect(f.service.createLocalTransactionDraft('owner',{requestId:crypto.randomUUID(),sourceCandidateId:unbound.id,fields:unbound.fields})).rejects.toMatchObject({code:'AI_CANDIDATE_CONVERSATION_MISMATCH'});
  expect((await f.conversations.list('owner')).length).toBe(before.length);expect((await f.candidates.get('owner',unbound.id)).status).toBe('pending');
});
