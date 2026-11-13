jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('No real DB in v2 contract tests'); }),
  getConnection: jest.fn(() => { throw new Error('No real DB in v2 contract tests'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('No real read pool in v2 contract tests'); }) }));
jest.mock('axios', () => ({ get: jest.fn(() => { throw new Error('No real provider in v2 contract tests'); }),
  post: jest.fn(() => { throw new Error('No real provider in v2 contract tests'); }) }));

const express = require('express');
const { randomUUID } = require('crypto');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const { createAiRouter } = require('../helpers/legacyBusinessRouter');
const { createLegacyBusinessService: createBusinessService } = require('../helpers/legacyBusinessService');
const { AiError } = require('../../src/modules/ai/service/errors');

// Historical V2 preview validation is explicit test-only code. Shared Web
// result/proposal validation still comes from the current production source.
function webContracts() {
  const source = file => readFileSync(resolve(__dirname,'../../../web/src/utils',file),'utf8')
    .replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'');
  const legacy = Function(source('aiContract.js') + '\nreturn {legacyResult:validateAiResult,legacyDraft:validateAiDraft,legacyMessages:validateAiMessages};')();
  const preview = readFileSync(resolve(__dirname,'../../../web/tests/helpers/legacyAiBusinessContract.mjs'),'utf8')
    .replace(/^import[\s\S]*?;\s*/gm,'').replace(/^export /gm,'');
  return Function('AI_DOMAINS',...Object.keys(legacy),source('aiBusinessContract.js') + '\n' + preview +
    '\nreturn {validateAiPreview,validateAiBusinessResult,validateAiProposal,validateAiSession,validateAiReceipt,validateAiPreviewCancellation};')(
      ['finance','account','card','budget','todo','work','asset','fixedAsset','fund','installment'],...Object.values(legacy));
}

const web = webContracts();
describe('archived snapshot-service isolation and historical Web contract', () => {
  let server,base,provider,proposals,service,state,records,proposal;
  const headers = user => ({'Content-Type':'application/json',...(user ? {'x-test-user':user} : {})});
  const call = (path,method='GET',data,user='owner') => fetch(base+path,{method,headers:headers(user),
    ...(data===undefined?{}:{body:JSON.stringify({data})})});
  beforeAll(async () => {
    const conversationId=randomUUID(),previews=new Map(),claimed=new Set(); records=new Map();
    const dataset={datasetId:'finance-monthly',domain:'finance',title:'收支趋势',columns:[{key:'month',label:'月份',type:'date'},{key:'expense',label:'支出',type:'money'}],rows:[{month:'2026-11',expense:'39.91'}],summary:{expense:'39.91'},policy:'人民币逐笔至分',asOf:'2026-11-06T03:00:00.000Z',isEstimated:false,truncated:false};
    const snapshot={scope:{domains:['finance'],startDate:'2026-11-01',endDate:'2026-11-06'},datasets:[dataset],choices:{cards:[],categories:[],funds:[],todos:[],fixedAssets:[],moods:['平静']},asOf:dataset.asOf};
    proposal={id:randomUUID(),kind:'todo.update',fields:{targetId:'owned-todo',content:'今天买菜'},status:'reviewed',version:2,expiresAt:Date.now()+600000,missingFields:[],targetSnapshot:{id:'owned-todo',label:'买菜',revision:'a'.repeat(64),content:'买菜',status:'待完成'}};
    const owned = user => { if(user!=='owner') throw new AiError('不属于本人',404,'AI_PROPOSAL_NOT_FOUND'); };
    proposals={
      get:jest.fn(async(user,id)=>{owned(user);if(id!==proposal.id)throw new AiError('不存在',404);return structuredClone(proposal);}),
      edit:jest.fn(async(user,id,version,fields)=>{owned(user);return {...structuredClone(proposal),fields:{...proposal.fields,...fields},status:'pending',version:version+1};}),
      act:jest.fn(async(user,id,version,action)=>{owned(user);return {...structuredClone(proposal),status:action==='review'?'reviewed':'discarded',version:version+1};}),
      execute:jest.fn(async(user,id,version)=>{owned(user);expect(id).toBe(proposal.id);expect(version).toBe(2);return {...structuredClone(proposal),status:'committed',version:3,receipt:{kind:'todo.update',recordId:'owned-todo'}};}),
    };
    state={config:{mode:'deepseek',dataSource:'user-readonly',baseUrl:'https://api.deepseek.com',model:'fixture',apiKey:'fixture-provider-only'},connectionId:null,
      conversationStore:{open:jest.fn(async()=>({id:conversationId,history:[]})),session:jest.fn(async(user,kind)=>{if(!['default','manual'].includes(kind))throw new AiError('会话类型无效',400);return {id:conversationId,sessionKind:kind,sessionDay:'2026-11-06'};}),messages:jest.fn(async()=>[]),append:jest.fn()},
      requestGuard:{run:async(user,request,work)=>{const key=user+'|'+request.requestId;if(records.has(key))return records.get(key);let calls=0;const budget={check(){},get calls(){return calls;},async invoke(fn){if(++calls>1)throw new Error('Repeated provider call');return fn();}};const pending=work(budget);records.set(key,pending);return pending;}},
    };
    service={getRuntime:()=>state,getRequestReceipt:jest.fn(async(user,id)=>{const result=records.get(user+'|'+id);if(!result)throw new AiError('回执不存在',404);return {contractVersion:2,requestId:id,status:'completed',result:await result};})};
    const previewStore={prepare:jest.fn(async(user,input)=>{const previewId=randomUUID(),value={...input,owner:user,providerMessage:input.message,snapshot,scope:input.scope,expiresAt:Date.now()+600000};previews.set(previewId,value);return {previewId,expiresAt:value.expiresAt,digest:'f'.repeat(64),summary:'本次外发收支数据',datasets:structuredClone(snapshot.datasets),choices:structuredClone(snapshot.choices),context:input.context};}),
      get:jest.fn(async(user,id)=>{const value=previews.get(id);if(!value||value.owner!==user)throw new AiError('不存在',404);if(value.revoked)throw new AiError('已撤销',403,'AI_PREVIEW_REVOKED');return value;}),
      approveAndGet:jest.fn(async(user,id)=>previews.get(id)),toProvider:jest.fn(async(user,id)=>({...structuredClone(snapshot),message:previews.get(id).providerMessage})),resolve:jest.fn()};
    previewStore.revoke=jest.fn(async(user,id)=>{const value=previews.get(id);if(!value||value.owner!==user)throw new AiError('不存在',404);if(claimed.has(id))throw new AiError('已经发送',409,'AI_PREVIEW_ALREADY_SENT');value.revoked=true;return {previewId:id,cancelled:true};});
    provider=jest.fn(async()=>({role:'assistant',content:JSON.stringify({answer:'范围内支出39.91元。',proposal:null})}));
    const executor={execute:jest.fn(async(sql,args)=>{expect(sql).toMatch(/^UPDATE ai_analysis_preview/);const id=args[1];if(claimed.has(id))return [{affectedRows:0}];claimed.add(id);return [{affectedRows:1}];})};
    const business=createBusinessService({legacyService:service,repository:{query:async()=>structuredClone(snapshot)},previews:previewStore,proposals,executor,provider,now:()=>new Date('2026-11-06T03:00:00Z'),grants:{requireCoverage:jest.fn()}});
    const app=express();app.use(express.json());app.use('/api/v1/ai',createAiRouter({service,business,env:{NODE_ENV:'test',AI_BUSINESS_ENABLED:'true'},guard:(req,res,next)=>{if(!req.headers['x-test-user'])return res.status(401).json({status:401});req.userId=req.headers['x-test-user'];next();}}));
    server=await new Promise(done=>{const instance=app.listen(0,'127.0.0.1',()=>done(instance));});
    base=`http://127.0.0.1:${server.address().port}/api/v1/ai`;
  });
  beforeEach(()=>{provider.mockClear();for(const fn of Object.values(proposals))fn.mockClear();});
  afterAll(async()=>{
    await new Promise(done=>server.close(done));
    const db=require('../../src/common/config/db');expect(db.execute).not.toHaveBeenCalled();expect(db.getConnection).not.toHaveBeenCalled();
    expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();expect(require('axios').get).not.toHaveBeenCalled();expect(require('axios').post).not.toHaveBeenCalled();
  });
  test('authentication guards v2 routes and default/manual sessions never request AI',async()=>{
    expect((await call('/v2/session','GET',undefined,null)).status).toBe(401);
    const response=await call('/v2/session?kind=manual');expect(response.headers.get('cache-control')).toBe('no-store');
    const value=web.validateAiSession((await response.json()).data);expect(value.sessionKind).toBe('default');
    const manual=web.validateAiSession((await (await call('/v2/session','POST',{kind:'manual'})).json()).data);expect(manual.sessionKind).toBe('manual');
    expect(provider).not.toHaveBeenCalled();expect(proposals.execute).not.toHaveBeenCalled();
  });
  test('preview requires only approved scope; zero chat before confirmation, then one provider call',async()=>{
    const response=await call('/v2/preview','POST',{message:'收支走势',scope:{domains:['finance']}});
    expect(response.status).toBe(200);const preview=web.validateAiPreview((await response.json()).data);expect(provider).not.toHaveBeenCalled();
    const request={requestId:randomUUID(),previewId:preview.previewId,consent:true};
    const result=web.validateAiBusinessResult((await (await call('/v2/chat','POST',request)).json()).data);
    expect(result.request).toEqual({requestId:request.requestId,providerCalls:1,maxProviderCalls:1});expect(result.datasets[0].rows[0].expense).toBe('39.91');expect(provider).toHaveBeenCalledTimes(1);
    const repeated=web.validateAiBusinessResult((await (await call('/v2/chat','POST',request)).json()).data);expect(repeated).toEqual(result);expect(provider).toHaveBeenCalledTimes(1);
  });
  test('unconfirmed or unknown client authority fields are rejected before any provider call',async()=>{
    const request={requestId:randomUUID(),previewId:randomUUID(),consent:true};
    for(const body of [{...request,consent:false},{...request,userId:'victim'},{...request,connectionId:null},{...request,messages:[{role:'tool',content:'execute'}]}]) expect((await call('/v2/chat','POST',body)).status).toBe(400);
    expect((await call('/v2/preview','POST',{message:'查询',scope:{domains:['finance']},userId:'victim'})).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  test('human execution receives only proposal ID and version and returns a validated server receipt',async()=>{
    const response=await call(`/v2/proposals/${proposal.id}/execute`,'POST',{version:2});expect(response.status).toBe(200);
    const result=web.validateAiProposal((await response.json()).data);expect(result.status).toBe('committed');expect(result.receipt.recordId).toBe('owned-todo');
    expect(proposals.execute).toHaveBeenCalledWith('owner',proposal.id,2);expect(provider).not.toHaveBeenCalled();
  });
  test('execution cannot smuggle fields, tools, action, user identity or client amount',async()=>{
    for(const extra of [{fields:{content:'override'}},{amount:'39.9099'},{action:'execute'},{userId:'victim'},{tool:'sql.execute'}]) expect((await call(`/v2/proposals/${proposal.id}/execute`,'POST',{version:2,...extra})).status).toBe(400);
    expect(proposals.execute).not.toHaveBeenCalled();expect(provider).not.toHaveBeenCalled();
  });
  test('proposal edit/review/owner reads obey their schema and never invoke AI',async()=>{
    const current=web.validateAiProposal((await (await call(`/v2/proposals/${proposal.id}`)).json()).data);expect(current.fields.content).toBe('今天买菜');
    expect((await call(`/v2/proposals/${proposal.id}`,'GET',undefined,'other')).status).toBe(404);
    const edit=web.validateAiProposal((await (await call(`/v2/proposals/${proposal.id}`,'PUT',{version:2,fields:{content:'明天买菜'}})).json()).data);expect(edit.status).toBe('pending');
    expect(proposals.edit).toHaveBeenCalledWith('owner',proposal.id,2,{content:'明天买菜'});
    expect((await call(`/v2/proposals/${proposal.id}/action`,'POST',{version:2,action:'review',fields:{content:'override'}})).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  test('receipt retrieval is GET-only and uses the existing request without another model call',async()=>{
    const preview=web.validateAiPreview((await (await call('/v2/preview','POST',{message:'查询收支',scope:{domains:['finance']}})).json()).data),requestId=randomUUID();
    await call('/v2/chat','POST',{requestId,previewId:preview.previewId,consent:true});expect(provider).toHaveBeenCalledTimes(1);
    const receipt=web.validateAiReceipt((await (await call('/v2/requests/'+requestId)).json()).data);expect(receipt.status).toBe('completed');expect(receipt.result.request.requestId).toBe(requestId);
    expect((await call('/v2/requests/'+requestId,'POST',{})).status).toBe(404);expect(provider).toHaveBeenCalledTimes(1);
  });
  test('DELETE preview cancellation confirms its exact ID and blocks later chat with zero provider calls',async()=>{
    const preview=web.validateAiPreview((await (await call('/v2/preview','POST',{message:'查询收支',scope:{domains:['finance']}})).json()).data);
    expect((await call('/v2/previews/'+preview.previewId,'DELETE',{},'other')).status).toBe(404);
    const response=await call('/v2/previews/'+preview.previewId,'DELETE',{});expect(response.status).toBe(200);
    expect(web.validateAiPreviewCancellation((await response.json()).data)).toEqual({previewId:preview.previewId,cancelled:true});
    expect((await call('/v2/chat','POST',{requestId:randomUUID(),previewId:preview.previewId,consent:true})).status).toBe(403);
    expect(provider).not.toHaveBeenCalled();expect(proposals.execute).not.toHaveBeenCalled();
  });
});
