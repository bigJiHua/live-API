jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
const { fixture, calls, id } = require('../fixtures/aiV3MemoryFixture');
const { createMemoryRequestGuard } = require('../helpers/aiRequestFixture');
const { AiError } = require('../../src/modules/ai/service/errors');
const plain = content => ({ role:'assistant', content });
const owner = 'offline-memory-owner';
const request = (f, overrides = {}) => ({ requestId:id(), message:'继续原问题', mode:'analysis',
  conversationId:f.conversationId, consent:true, ...overrides });

test('an admitted retry claims its persisted failure before provider I/O and preserves the relation in success', async () => {
  const parent=id(), f=fixture([plain('可以继续讨论。')]);
  const claimed=jest.fn(async()=>{});f.state.conversationStore.claimRetry=claimed;
  f.provider.mockImplementation(async()=>{ expect(claimed).toHaveBeenCalledTimes(1);return plain('可以继续讨论。'); });
  const input=request(f,{retryOf:parent}), result=await f.service.chat(owner,input);
  expect(claimed).toHaveBeenCalledWith(owner,f.conversationId,{retryOf:parent,requestId:input.requestId,message:input.message});
  expect(result.request.retryOf).toBe(parent);
  expect(f.state.conversationStore.append.mock.calls[0][2]).toMatchObject({retryOf:parent,requestId:input.requestId});
  expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3].request.retryOf).toBe(parent);
});

test.each(['AI_RETRY_INVALID','AI_RETRY_CONSUMED'])('a rejected parent ends before provider calls or a forged child history: %s', async code => {
  const f=fixture([plain('不应调用')]);
  f.state.conversationStore.claimRetry=jest.fn(async()=>{throw new AiError('重试关系无效',409,code);});
  await expect(f.service.chat(owner,request(f,{retryOf:id()}))).rejects.toMatchObject({code});
  expect(f.provider).not.toHaveBeenCalled();expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
});

test('a retry that fails after claiming keeps its parent in failed history for the next explicit retry', async () => {
  const f=fixture([plain('unused')]), parent=id();
  f.state.conversationStore.claimRetry=jest.fn(async()=>{});
  f.provider.mockImplementation(async()=>{throw new AiError('供应商未完成',502,'AI_PROVIDER_FAILED');});
  const input=request(f,{retryOf:parent});
  await expect(f.service.chat(owner,input)).rejects.toMatchObject({code:'AI_PROVIDER_FAILED'});
  expect(f.state.conversationStore.appendFailure.mock.calls[0][2]).toMatchObject({retryOf:parent,requestId:input.requestId,errorCode:'AI_PROVIDER_FAILED'});
});

test.each([
  {retryOf:'invalid'},
  {retryOf:id(),conversationId:undefined},
])('retry relation shape is validated before admission: %j', async overrides => {
  const f=fixture([plain('unused')]);
  await expect(f.service.chat(owner,request(f,overrides))).rejects.toMatchObject({status:400});
  expect(f.state.requestGuard.run).not.toHaveBeenCalled();expect(f.provider).not.toHaveBeenCalled();
});

test('completed retry replay uses the original guard receipt without re-claiming or invoking the provider', async () => {
  const f=fixture([plain('可以继续讨论。')]), parent=id(), guard=createMemoryRequestGuard();
  f.state.requestGuard=guard;guard.saveV3Recovery=jest.fn();
  f.state.conversationStore.claimRetry=jest.fn(async()=>{});
  const input=request(f,{retryOf:parent});
  const first=await f.service.chat(owner,input), second=await f.service.chat(owner,input);
  expect(second).toEqual(first);expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.state.conversationStore.claimRetry).toHaveBeenCalledTimes(1);
  expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);
  await expect(f.service.chat(owner,{...input,retryOf:id()})).rejects.toMatchObject({code:'AI_REQUEST_CONFLICT'});
  expect(f.provider).toHaveBeenCalledTimes(1);
});

test('authorization failure continues once under a new child id and a completed child replays without another model call', async () => {
  let authorized=false;
  const grants={requireCoverage:jest.fn(async()=>{
    if (!authorized) throw Object.assign(new AiError('需要授权',403,'AI_GRANT_REQUIRED'),{
      authorizationRequest:{version:1,conversationId:f.conversationId,providerHost:'fixture.invalid',access:'read',
        reason:'继续使用读取能力',expiresAt:1900000000000},
    });
  })};
  const f=fixture([calls('request_authorization',{access:'read',reason:'继续使用读取能力'}),plain('可以继续讨论。')],{grants});
  const guard=createMemoryRequestGuard();f.state.requestGuard=guard;guard.saveV3Recovery=jest.fn();
  const parent=request(f);
  await expect(f.service.chat(owner,parent)).rejects.toMatchObject({code:'AI_GRANT_REQUIRED'});
  f.state.conversationStore.claimRetry=jest.fn(async(_,__,claim)=>{
    expect(f.state.conversationStore.appendFailure.mock.calls[0][2]).toMatchObject({
      requestId:claim.retryOf,message:claim.message,errorCode:'AI_GRANT_REQUIRED',authorizationRequest:{access:'read'},
    });
  });
  authorized=true;
  const child=request(f,{retryOf:parent.requestId});
  const result=await f.service.chat(owner,child);
  await expect(f.service.chat(owner,child)).resolves.toEqual(result);
  expect(result.request.retryOf).toBe(parent.requestId);
  expect(f.provider).toHaveBeenCalledTimes(2);expect(f.state.conversationStore.claimRetry).toHaveBeenCalledTimes(1);
  expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);expect(f.state.conversationStore.append).toHaveBeenCalledTimes(1);
});
