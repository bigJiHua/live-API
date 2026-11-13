const { getConfig, capabilities, turnTimeoutMs } = require('./config');
const { createRolloutPolicy } = require('./rolloutPolicy');
const { ocrRequestSchema, validate, todayShanghai, draftEditSchema, draftActionSchema, commitSchema,financialRequestSchema,localDraftRequestSchema } = require('./validation');
const { executeTool } = require('./tools');
const { createReadRepository } = require('./readRepository');
const { createMockRepository } = require('./mock');
const { checkDeepseekConnection, fetchDeepseekBalance, fetchProviderModelList } = require('./deepseek');
const { createModelListCache } = require('./modelListCache');
const { thinkingPreferences } = require('./providerCapabilities');
const { createDraftStore } = require('./drafts');
const { AiError } = require('./errors');
const { prepareOcrImage, recognizePaymentImage, validateOcrResult, ocrModel } = require('./ocr');
const { isSupportedDraftCategory } = require('./draftPolicy');
const { cardNameSql, cardBankJoin } = require('./cardNames');
const COMMIT_CARD_NAME = cardNameSql();
const COMMIT_CARD_BANK_JOIN = cardBankJoin();
const { createConversationStore } = require('./conversations');
const { createSettingsStore, DEEPSEEK_BASE_URL, normalizeApiUrl } = require('./settings');
const db = require('../../../common/config/db');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { createRequestGuard } = require('./requestGuard');
const { createInterruptedTurnRecovery } = require('./interruptedTurnRecovery');
const { businessPolicy } = require('./businessPolicy');
const { createFinancialReadRepository } = require('./financialRead');
const { createFinancialWorkflow } = require('./financialWorkflow');
const { createTransactionCandidateStore } = require('./transactionCandidates');
const { createPendingTransactionRecovery } = require('./pendingTransactionRecovery');
const { clearPendingTransactionContext } = require('./pendingTransactions');
const { createDataGrantStore } = require('./dataGrant');
const { createCallLogStore } = require('./callLog');
const { createPreferenceStore } = require('./preferences');
const { createAiConfigStore } = require('./aiConfigStore');
const { createUserBudgetStore, budgetValues, budgetEnv, BUDGET_FIELDS } = require('./userBudgetSettings');
const { reportGuardDiagnostic, reportAiError } = require('./diagnostics');
const { normalizeTransactionAmount,extractMoneyTokens,containsSpecialFinancialIntent,parseTransactionDate } = require('./transactionInput');
const { digestInput } = require('./requestGuard');

// 正常连续操作使用宽松窗口；同用户默认串行，短时竞争等待空位。
function requestLimits(env = {}) {
  const max = Number(env.AI_RATE_LIMIT_MAX), windowMs = Number(env.AI_RATE_LIMIT_WINDOW_MS);
  const concurrent = Number(env.AI_MAX_CONCURRENT_REQUESTS);
  const wait = Number(env.AI_REQUEST_QUEUE_WAIT_MS), queued = Number(env.AI_REQUEST_QUEUE_MAX);
  return {
    maxRequests: Number.isInteger(max) && max >= 1 && max <= 1000 ? max : env.NODE_ENV === 'production' ? 6 : 30,
    windowMs: Number.isInteger(windowMs) && windowMs >= 1000 && windowMs <= 600000 ? windowMs : 60000,
    maxConcurrent: Number.isInteger(concurrent) && concurrent >= 1 && concurrent <= 100 ? concurrent : 1,
    queueWaitMs: env.AI_REQUEST_QUEUE_WAIT_MS != null && env.AI_REQUEST_QUEUE_WAIT_MS !== '' && Number.isInteger(wait) && wait >= 0 && wait <= 60000 ? wait : 30000,
    maxQueued: Number.isInteger(queued) && queued >= 1 && queued <= 100 ? queued : 8,
  };
}

function createAiService({ env = process.env, repository, draftStore = createDraftStore(),
  conversationStore = createConversationStore(), settingsStore = createSettingsStore({ executor: db }),
  checkConnection = checkDeepseekConnection, recognizeImage = recognizePaymentImage, writeDb = db, now = () => new Date(), requestGuard: injectedRequestGuard,
  financialRepository,candidateStore=createTransactionCandidateStore(), dataGrantStore = createDataGrantStore(),
  callLog = createCallLogStore(), preferenceStore = createPreferenceStore(), conversationSyncStore = null,
  aiConfigStore = createAiConfigStore(), userBudgetStore = createUserBudgetStore() } = {}) {
  const rollout = createRolloutPolicy(env);
  const requestGuard = injectedRequestGuard || createRequestGuard({ diagnose: reportGuardDiagnostic, ...requestLimits(env) });
  const recoverInterruptedTurn = createInterruptedTurnRecovery({ executor: writeDb, requestGuard, conversations: conversationStore });
  let liveRepository,liveFinancialRepository;
  const turnContext = new AsyncLocalStorage();
  // D-028：连接设置（加密 Key+模型）从 ai_provider_setting 恢复。惰性暖机——首次请求触发（幂等），
  // 避免 require 期就打 DB（单测「不碰公共库」断言依赖这一点）。
  const modelListCache = createModelListCache({ clock: () => now().getTime() });
  let settingsWarmup = null;
  function warmupSettings() {
    if (!settingsWarmup) {
      settingsWarmup = Promise.all([
        Promise.resolve().then(() => settingsStore.warmup?.()),
        Promise.resolve().then(() => preferenceStore.warmup?.()),
        Promise.resolve().then(() => aiConfigStore.warmup?.()),
        Promise.resolve().then(() => userBudgetStore.warmup?.()),
      ]).catch(() => {
        settingsWarmup = null;
        throw new AiError('AI 连接配置尚未恢复，请稍后重试', 503, 'AI_SETTINGS_UNAVAILABLE');
      });
    }
    return settingsWarmup;
  }
  function requireWarmupReady() {
    // 正式路由先等待 warmupSettings；直接同步调用也不能临时采用错误的 env 连接。
    warmupSettings().catch(() => {});
    if ((settingsStore.isReady?.() === false) || preferenceStore.isReady?.() === false || userBudgetStore.isReady?.() === false) {
      throw new AiError('AI 连接配置正在恢复，请稍后重试', 503, 'AI_SETTINGS_LOADING');
    }
  }
  const providerHost = config => { try { return new URL(config.baseUrl).host; } catch (_) { return null; } };
  // 余额契约分发的 host 判据（getBalance）：hostname 精确后缀匹配，URL 路径里的域名串不参与判断
  const providerParts = config => { try { const url = new URL(config.baseUrl); return { host: url.host, hostname: url.hostname }; }
    catch (_) { return { host: String(config.baseUrl), hostname: String(config.baseUrl) }; } };
  // 追加164 审计埋点：包装一次 provider/工具/操作，成功失败都落 ai_call_log（fire-and-forget，
  // 审计失败绝不影响业务主链路）。request/response 全量入参出参（凭据由 callLog 统一擦除）。
  async function auditCall(entry, work) {
    const started = Date.now();
    try {
      const value = await work();
      callLog.record({ ...entry, durationMs: Date.now() - started, status: 'ok', response: value, usage: value?.usage || null });
      return value;
    } catch (error) {
      callLog.record({ ...entry, durationMs: Date.now() - started, status: 'error',
        errorCode: error?.code || null, httpStatus: Number.isFinite(error?.status) ? error.status : null,
        response: { message: error?.message, diagnostics: error?.diagnostics || null, causeCode: error?.causeCode || null, providerStatus: error?.providerStatus || null } });
      throw error;
    }
  }
  // 2026-11-08：接入商管理已转正（Key/模型加密落库）。旧 AI_ALLOW_SESSION_SETTINGS 只在
  // 显式设为 'false' 时作为运维熔断；AI_MODE=disabled 仍是站点总开关，用户不能靠新增接入商绕过。
  const aiEnabled = () => env.AI_MODE !== 'disabled';
  const settingsEnabled = () => aiEnabled() && env.AI_ALLOW_SESSION_SETTINGS !== 'false';
  // 追加164 思考开关生效链：会话偏好（显式 true/false）> env.AI_THINKING > disabled。
  // 通过改写 effectiveEnv 的 AI_THINKING 槽位实现——所有 getConfig 调用点自动生效。
  // 2026-11-08 负责人决议：接入商 Key/地址/模型只来自数据库（ai_provider_profile）。
  // 环境变量的 AI_API_KEY/AI_BASE_URL/AI_MODEL（含 DEEPSEEK_* 旧名）凭据模式已停用，这里直接剔除，
  // 避免未配置接入商的账号静默借用运维环境凭据。AI_MODE 等非凭据配置仍走 env。
  // 2026-11-13：本人预算 > ai_config 站点默认 > env；用户可自行提高本人额度。
  function providerEnv(userId) {
    const active = aiEnabled() ? settingsStore.get?.(userId) : null;
    const pref = preferenceStore.getFlags(userId);
    const base = { ...env };
    delete base.AI_API_KEY; delete base.DEEPSEEK_API_KEY;
    delete base.AI_BASE_URL; delete base.AI_MODEL; delete base.DEEPSEEK_MODEL;
    if (pref?.thinking !== undefined) base.AI_THINKING = pref.thinking ? 'enabled' : 'disabled';
    // §3b：用户联网开关（默认关）——仅在显式 true 时注入；关闭=搜索门不满足
    if (pref?.webSearch === true) base.AI_WEB_SEARCH_ENABLED = 'true';
    const budgetOverrides = aiConfigStore.get?.() || {};
    if (Object.keys(budgetOverrides).length) Object.assign(base, budgetOverrides);
    Object.assign(base, budgetEnv(userBudgetStore.get(userId)));
    if (active) Object.assign(base, { AI_MODE: 'deepseek', AI_BASE_URL: active.apiUrl,
      AI_API_KEY: active.apiKey, AI_MODEL: active.model,
      DEEPSEEK_API_KEY: active.apiKey, DEEPSEEK_MODEL: active.model });
    return base;
  }
  function effectiveEnv(userId) {
    requireWarmupReady();
    return providerEnv(userId);
  }
  function settingsProfile(userId) {
    requireWarmupReady();
    const active = aiEnabled() ? (settingsStore.get?.(userId) || null) : null;
    const profiles = settingsStore.list?.(userId) || [];
    const activeConnectionId = active?.connectionId || null;
    return { enabled: settingsEnabled(), configured: !!active,
      apiUrl: active?.apiUrl || DEEPSEEK_BASE_URL,
      model: active?.model || '',
      connectionId: activeConnectionId, expiresAt: null,
      hasKey: !!active, name: active?.name || null,
      keyFingerprint: active?.keyFingerprint || null,
      activeConnectionId,
      profiles: profiles.map(item => ({ connectionId: item.connectionId, name: item.name,
        apiUrl: item.apiUrl, model: item.model, keyFingerprint: item.keyFingerprint || null,
        active: item.connectionId === activeConnectionId })) };
  }
  function requireSettings(userId) {
    if (env.AI_MODE === 'disabled') throw new AiError('站点尚未启用 AI', 403, 'AI_SETTINGS_DISABLED');
    if (!settingsEnabled()) throw new AiError('后端已关闭 AI 接入商设置', 403, 'AI_SETTINGS_DISABLED');
    if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
  }
  function getRepository(config) {
    return repository || (config.dataSource === 'synthetic' ? createMockRepository() : (liveRepository ||= createReadRepository(config.db)));
  }
  function financial(userId) {
    const config=getConfig(effectiveEnv(userId));
    return createFinancialWorkflow({repository:()=>getRepository(config),
      financialRepository:()=>financialRepository||(liveFinancialRepository||=createFinancialReadRepository(config.db,{now})),
      candidateStore,draftStore,now,riskPolicy:{largeAmount:env.AI_LARGE_AMOUNT||'1000',highAmount:env.AI_HIGH_AMOUNT||'10000'}});
  }
  function requireFinancialAccess(userId) {
    if(!userId||typeof userId!=='string') throw new AiError('登录身份无效',401);
    const selected=effectiveEnv(userId),config=getConfig(selected),policy=businessPolicy(selected);
    if(config.mode==='disabled'||selected.AI_FINANCIAL_ENABLED==='false') throw new AiError('财务助手预检暂未启用',503,'AI_FINANCIAL_DISABLED');
    if(!policy.enabled) throw new AiError('新增业务助手暂未启用',503,'AI_BUSINESS_DISABLED');
    if(!policy.domains.includes('finance')) throw new AiError('财务域尚未开放',403,'AI_SCOPE_DENIED');
    if(!policy.actions.includes('transaction.create')) throw new AiError('AI记账草稿暂未开放',403,'AI_ACTION_NOT_ALLOWED');
    return config;
  }
  async function inspectFinancial(userId,input,options={}) {
    const sourceCandidate=input.sourceCandidateId?await candidateStore.get(userId,input.sourceCandidateId,options.executor):options.sourceCandidate||null;
    if(sourceCandidate&&input.conversationId!=null&&input.conversationId!==sourceCandidate.conversationId)
      throw new AiError('候选不属于本次对话，请在原对话继续核查',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
    if(sourceCandidate?.pendingTaskId && input.fields && ['amount','direction','currency','transDate'].some(key=>
      Object.hasOwn(input.fields,key)&&input.fields[key]!==sourceCandidate.fields[key]))
      throw new AiError('本卡仅补充账户、分类和支付方式；金额或日期有误请重新描述完整交易',400,'AI_CONTINUATION_INPUT_INVALID');
    await assertPendingCandidate(userId,sourceCandidate,options.executor);
    const merged=sourceCandidate?{fields:{...sourceCandidate.fields,...(input.fields||{})}}:input;
    const result=await financial(userId).inspect(userId,merged,{...options,sourceCandidate,originalText:options.originalText||input.message});
    return {...result,...(sourceCandidate?{inputCandidate:sourceCandidate}: {})};
  }
  async function assertPendingCandidate(userId,candidate,connection) {
    if(!candidate?.pendingTaskId || candidate.draftId) return;
    const task=await conversationStore.loadPendingTransactionTask?.(userId,candidate.conversationId,connection);
    if(!task || task.status==='cleared' || task.taskId!==candidate.pendingTaskId)
      throw new AiError('原待补任务已结束或被替换，请读取最新卡片',409,'AI_PENDING_ENDED');
    const item=task.items[candidate.pendingTaskIndex];
    if(!item || task.revision!==candidate.pendingTaskRevision ||
        ['direction','currency','transDate'].some(key=>item.fields[key]!==candidate.fields[key]) ||
        normalizeTransactionAmount(item.fields.amount)!==normalizeTransactionAmount(candidate.fields.amount))
      throw new AiError('原待补信息已变化，请重新选择这笔任务',409,'AI_PENDING_CONFLICT');
    return task;
  }
  // 追加163：草稿富字段补全（choices 不落库，读取/操作后实时重建；金额分类名称随之刷新）
  async function enrichDraft(userId, draft) {
    if (!draft) return draft;
    const config = getConfig(effectiveEnv(userId));
    const repo = getRepository(config);
    const choices = await repo.choices(userId);
    const category = choices.categories.find(item => item.id === draft.categoryId);
    const account = choices.accounts.find(item => item.id === draft.accountId);
    const enriched = { ...draft, choices,
      categoryName: category?.name || null, accountName: account?.name || null,
      needsReview: draft.status !== 'committed',
      formalWriteEnabled: false };
    return financial(userId).enrich(userId,enriched);
  }
  const localReceipt=(request,draft,conversationId,financialCheck)=>({contractVersion:2,answer:'',datasets:[],chart:null,draft,
    conversationId,financialCheck,request:{requestId:request.requestId,providerCalls:0,maxProviderCalls:0}});
  async function persistOcrResult(userId, conversationId, budget, build) {
    const conn = await writeDb.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      budget.check();
      const { result, appendPayload } = await build(conn);
      const receipt = { ...result, request: { requestId: budget.requestId, providerCalls: budget.calls, maxProviderCalls: 1 } };
      budget.check();
      await conversationStore.append(userId, conversationId, appendPayload, conn);
      budget.check();
      await requestGuard.saveOcrRecovery(conn, userId, budget.requestId, receipt);
      budget.check();
      await conn.commit();
      return receipt;
    } catch (error) { await conn.rollback().catch(() => {}); throw error; }
    finally { conn.release(); }
  }
  const service = {
    assertGenerationAllowed(userId) { rollout.assertAllowed(userId); },
    // 2026-11-10：优雅停机钩子——app.js 信号处理调用，把在跑轮次落 AI_TURN_INTERRUPTED 终态。
    async shutdown() { return requestGuard.shutdownAll?.(); },
    getRuntime(userId) {
      if (!userId) throw new AiError('登录身份无效', 401);
      const selected = effectiveEnv(userId);
      let config;
      try { config = getConfig(selected); } catch (error) {
        if (error?.code === 'AI_CONFIG_REQUIRED') throw new AiError('请先在 AI 设置中添加接入商并填写 API Key', 503, 'AI_PROVIDER_REQUIRED');
        throw error;
      }
      return { config, turnTimeoutMs: turnTimeoutMs(selected), connectionId: settingsProfile(userId).connectionId,
        assertGenerationAllowed: () => rollout.assertAllowed(userId),
        conversationStore, requestGuard, conversationSyncStore, businessPolicy: businessPolicy(selected) };
    },
    async getRequestReceipt(userId,id) {
      const receipt=await requestGuard.get(userId,id);
      // Failure-history repair must not hold the durable receipt hostage to
      // slow auxiliary SQL. A late repair remains owner-bound and idempotent.
      let repairTimer;
      const repair = Promise.resolve().then(() => recoverInterruptedTurn(userId,id,receipt))
        .catch(error => reportAiError(error, { phase: 'interrupted-turn-recovery', requestId: id }));
      try { await Promise.race([repair, new Promise(resolve => { repairTimer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(repairTimer); }
      if(receipt.status==='completed'&&receipt.maxProviderCalls===0&&receipt.result?.draft?.id) {
        await warmupSettings();
        const draft=await enrichDraft(userId,await draftStore.get(userId,receipt.result.draft.id));
        return {...receipt,result:{...receipt.result,draft,financialCheck:draft.financialCheck}};
      }
      if (receipt.status === 'completed' && receipt.result) {
        const result = { ...receipt.result };
        // Only live card enrichment needs model/data settings; plain durable
        // text and interrupted receipts stay independent of that warmup.
        if (result.draft?.id || result.drafts?.length || result.candidates?.length || result.inputCandidate?.id)
          await warmupSettings();
        if (result.draft?.id) result.draft = await enrichDraft(userId, await draftStore.get(userId, result.draft.id));
        if (Array.isArray(result.drafts)) result.drafts = await Promise.all(result.drafts.map(async draft => enrichDraft(userId, await draftStore.get(userId, draft.id))));
        if (Array.isArray(result.candidates)) {
          result.candidates = await Promise.all(result.candidates.map(async item => {
            const current = await service.getTransactionCandidate(userId, item.inputCandidate.id);
            return { inputCandidate: current.inputCandidate, financialCheck: current.financialCheck,
              financialChoices: current.choices, ...(current.draft ? { draft: current.draft } : {}) };
          }));
        }
        if (result.inputCandidate?.id) {
          const current = await service.getTransactionCandidate(userId, result.inputCandidate.id);
          Object.assign(result, { inputCandidate: current.inputCandidate, financialCheck: current.financialCheck,
            financialChoices: current.choices, ...(current.draft ? { draft: current.draft } : {}) });
        }
        return { ...receipt, result };
      }
      return receipt;
    },
    ...createPendingTransactionRecovery({ conversationStore,candidateStore,executor:writeDb,now,
      requireAccess:requireFinancialAccess,inspect:inspectFinancial,enrichDraft,draftStore }),
    async financialPreflight(userId,input) {
      requireFinancialAccess(userId);
      const request=validate(financialRequestSchema,input);
      const result=await inspectFinancial(userId,request);
      requireFinancialAccess(userId);
      return {contractVersion:2,...result};
    },
    
    
    async getTransactionCandidate(userId,id) {
      const candidate=await candidateStore.get(userId,id,undefined,{allowEnded:true});
      if(candidate.draftId) {const draft=await enrichDraft(userId,await draftStore.get(userId,candidate.draftId));
        return {contractVersion:2,inputCandidate:candidate,draft,financialCheck:draft.financialCheck,choices:draft.choices};}
      if(candidate.status!=='pending') return {contractVersion:2,inputCandidate:candidate,choices:candidate.choices||{},financialCheck:{
        status:'block',reasonCodes:['AI_CANDIDATE_ENDED'],reasons:[{code:'AI_CANDIDATE_ENDED',message:'这份候选已取消或过期',severity:'block'}],
        requestedAmount:candidate.fields?.amount||null,currency:candidate.fields?.currency||null,availableAmount:null,shortfall:null,remainingAmount:null,
        asOf:new Date(now()).toISOString(),expiresAt:new Date(candidate.expiresAt).toISOString(),
        fieldsDigest:digestInput({userId,fields:candidate.fields||{}}),policyVersion:'financial-preflight-v1/transaction-risk-v1',
        riskDigest:digestInput({id:candidate.id,status:candidate.status}),requiresAcknowledgement:false,requiresAmountConfirmation:false,
        reviewValid:false,coverage:'unknown',bankBalanceVerified:false}};
      const result=await inspectFinancial(userId,{sourceCandidateId:id});
      return {contractVersion:2,...result,inputCandidate:{...candidate,choices:result.choices}};
    },
    cancelTransactionCandidate: (userId,id)=>candidateStore.discard(userId,id),
    async createLocalTransactionDraft(userId,input) {
      requireFinancialAccess(userId);
      const request=validate(localDraftRequestSchema,input);
      const receipt=await requestGuard.run(userId,{requestId:request.requestId,lane:'local-draft',input:request,maxProviderCalls:0,timeoutMs:30000},async budget=>{
        const result=await inspectFinancial(userId,request);
        const source=result.inputCandidate;
        if(source&&!source.conversationId)throw new AiError('候选缺少原对话，请重新核查完整交易',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
        if(source?.draftId) {
          const draft=await enrichDraft(userId,await draftStore.get(userId,source.draftId));
          if(draft.conversationId!==source.conversationId)throw new AiError('草稿与候选的原对话不一致，请读取原回执核查',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
          return localReceipt(request,draft,source.conversationId,draft.financialCheck);
        }
        financial(userId).assertUsable(result.financialCheck);
        if(result.missingFields.length) throw new AiError('请补齐分类、资金账户和支付方式',409,'AI_DRAFT_FIELDS_MISSING');
        requireFinancialAccess(userId);
        const config=getConfig(effectiveEnv(userId)),conversation=await conversationStore.open(userId,source?.conversationId||request.conversationId);
        if(source&&conversation.id!==source.conversationId)
          throw new AiError('候选不能移动到另一段对话',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
        const proposed=await auditCall({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'local-draft', phase: 'tool', providerHost: providerHost(config), model: config.model, toolName: 'propose_transaction', origin: 'user', request: result.fields },
          () => executeTool({scene:'draft',userId,repository:getRepository(config),today:todayShanghai(now())},'propose_transaction',result.fields));
        requireFinancialAccess(userId);
        const saved=source||await financial(userId).candidate(userId,result,{source:'user-readonly',conversationId:conversation.id,message:request.message||'',requestId:request.requestId});
        let conn,draft,pendingAppendDone=false;
        try {
          conn=await writeDb.getConnection();await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await conn.beginTransaction();
          if(source?.pendingTaskId) {
            const [owners]=await conn.execute('SELECT id FROM ai_conversation WHERE id=? AND user_id=? FOR UPDATE',[conversation.id,userId]);
            if(!owners.length) throw new AiError('原聊天已删除',404,'AI_CONVERSATION_NOT_FOUND');
          }
          const current=await candidateStore.get(userId,saved.id,conn,{lock:true});
          requireFinancialAccess(userId);
          const pendingTask=await assertPendingCandidate(userId,current,conn);
          if(current.conversationId!==conversation.id)
            throw new AiError('候选的原对话已变化，请重新读取原卡片',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
          if(source&&current.inputDigest!==source.inputDigest)
            throw new AiError('候选字段刚被补充，请读取最新卡片后重新核查',409,'AI_CANDIDATE_CONFLICT');
          if(current.draftId) {
            draft=await draftStore.get(userId,current.draftId,conn);
            if(draft.conversationId!==current.conversationId)throw new AiError('草稿与候选原对话不一致',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
          }
          else {
            budget.check();
            draft=await draftStore.save(userId,{...proposed,source:current.source,originalText:current.originalText||'',conversationId:conversation.id,
              trace:[...(current.trace||[]),{tool:'manual_transaction_fields',readOnly:true,origin:'user',
                result:{fields:financial(userId).pick(proposed),inputDigest:digestInput(request)}}],sourceCandidateId:current.id},conn);
            await candidateStore.consume(userId,current.id,draft.id,conn);
          }
          budget.check();draft=await enrichDraft(userId,draft);
          if(requestGuard.saveLocalRecovery) await requestGuard.saveLocalRecovery(conn,userId,request.requestId,
            localReceipt(request,draft,conversation.id,draft.financialCheck));
          if(pendingTask) {
            const members=await Promise.all(pendingTask.items.map((_,itemIndex)=>candidateStore.findByFingerprint(userId,
              digestInput({pendingTask:pendingTask.taskId,itemIndex}),conn)));
            if(members.every(member=>member?.draftId || member?.status==='discarded')) {
              const ended=clearPendingTransactionContext({conversationId:conversation.id,turnId:request.requestId,previous:pendingTask,now});
              await conversationStore.append(userId,conversation.id,{message:'已补齐待补交易信息',answer:'草稿已生成，请核对后确认入账。',draft,
                business:{contractVersion:3,pendingTransactions:ended}},conn);
              pendingAppendDone=true;
            }
          }
          budget.check();requireFinancialAccess(userId);await conn.commit();
        } catch(error) {if(conn) await conn.rollback().catch(()=>{});throw error;} finally {if(conn)conn.release();}
        budget.check();draft=await enrichDraft(userId,draft);
        if(!pendingAppendDone) await conversationStore.append(userId,conversation.id,{message:request.message||'',answer:'',draft});
        return localReceipt(request,draft,conversation.id,draft.financialCheck);
      });
      // A replayed POST must display the current terminal/version state too.
      const latest=await enrichDraft(userId,await draftStore.get(userId,receipt.draft.id));
      if(request.sourceCandidateId) {
        const source=await candidateStore.get(userId,request.sourceCandidateId);
        if(!source.conversationId||latest.conversationId!==source.conversationId||
          (request.conversationId!=null&&request.conversationId!==source.conversationId))
          throw new AiError('草稿回执不属于候选的原对话，请读取原记录核查',409,'AI_CANDIDATE_CONVERSATION_MISMATCH');
      }
      return {...receipt,draft:latest,financialCheck:latest.financialCheck};
    },
    async prepareTransactionProposal(userId, fields, { message, conversationId, budget }) {
      requireFinancialAccess(userId);
      const config = getConfig(effectiveEnv(userId));
      const proposed = await auditCall({ userId, requestId: budget?.requestId || null, conversationId: conversationId || null, lane: 'business-chat', phase: 'tool', providerHost: providerHost(config), model: config.model, toolName: 'propose_transaction', origin: 'model', request: fields },
        () => executeTool({ scene: 'draft', userId, repository: getRepository(config),
          today: todayShanghai(now()), origin: 'model', message }, 'propose_transaction', fields));
      budget.check();
      const result=await financial(userId).inspect(userId,{fields:proposed});
      requireFinancialAccess(userId);
      if(!financial(userId).usable(result.financialCheck)||result.missingFields.length) {
        return { preparedCandidate: result, metadata: { message, conversationId, source: config.dataSource } };
      }
      return { preparedDraft: { ...proposed, originalText: message, source: config.dataSource,
        conversationId, trace: [] } };
    },
    
    async persistTransactionBatch(userId, preparedItems, { conversationId, budget, buildResult, assertAuthorization }) {
      requireFinancialAccess(userId);
      if (!Array.isArray(preparedItems) || !preparedItems.length || preparedItems.length > 3 ||
          preparedItems.some(item => !item || Boolean(item.preparedDraft) === Boolean(item.preparedCandidate)) ||
          typeof buildResult !== 'function' || !budget?.requestId) {
        throw new AiError('记账提案批次无效', 400, 'AI_INVALID_RESULT');
      }
      const conn = await writeDb.getConnection();
      try {
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conn.beginTransaction();
        await assertAuthorization?.(conn);
        const artifacts = [];
        for (const prepared of preparedItems) {
          budget.check();
          requireFinancialAccess(userId);
          if (prepared.preparedDraft) {
            const draft = await draftStore.save(userId, prepared.preparedDraft, conn);
            artifacts.push({ draft: await enrichDraft(userId, draft) });
          } else {
            const inputCandidate = await financial(userId).candidate(userId, prepared.preparedCandidate, prepared.metadata, conn);
            artifacts.push({ inputCandidate, financialCheck: prepared.preparedCandidate.financialCheck,
              financialChoices: prepared.preparedCandidate.choices });
          }
        }
        const { result, appendPayload } = await buildResult(artifacts);
        budget.check();
        await conversationStore.append(userId, conversationId, appendPayload, conn);
        await requestGuard.saveBusinessRecovery(conn, userId, budget.requestId, result);
        budget.check();
        requireFinancialAccess(userId);
        await assertAuthorization?.(conn);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback().catch(() => {});
        throw error;
      } finally { conn.release(); }
    },
    getCapabilities(userId) {
      requireWarmupReady();
      const selected = effectiveEnv(userId);
      const value = capabilities(selected);
      // 未添加接入商时 getConfig 会因缺少 Key 抛错；能力接口仍要返回统一结构，不能 500。
      let config = null;
      try { config = getConfig(selected); } catch (_) { config = null; }
      const thinking = thinkingPreferences(config);
      const policy = businessPolicy(selected);
      const dailyProviderCalls = config?.dailyProviderLimit ?? budgetValues(selected).dailyProviderCalls;
      const missingProvider = !config && selected.AI_MODE !== 'disabled';
      return { ...value, message: missingProvider ? '请先在 AI 连接设置中添加接入商并填写 API Key' : value.message,
        ...thinking,
        contractVersion: 3, agentVersion: 3,
        businessVersion: value.enabled && value.mode === 'deepseek' && policy.enabled ? 3 : null,
        businessPolicy: { ...policy, modelExecutionEnabled: false },
        requestPolicy: { automaticRetry: false, businessMaxProviderCalls: 5, maxToolCalls: 8,
          turnTimeoutMs: turnTimeoutMs(selected), queueWaitMs: requestLimits(env).queueWaitMs, dailyProviderCalls, legacyChatEnabled: false },
        financialPreflightEnabled:value.enabled&&policy.enabled&&policy.domains.includes('finance')&&policy.actions.includes('transaction.create')&&selected.AI_FINANCIAL_ENABLED!=='false',localDraftMaxProviderCalls:0,
        settingsEnabled: settingsEnabled(), sessionConfigured: settingsProfile(userId).configured,
        ocrEnabled: Boolean(config && value.enabled && value.mode === 'deepseek'), ocrModel: config && value.enabled ? ocrModel(config) : null,
        connectionId: settingsProfile(userId).connectionId,
        dataSource: value.mode === 'mock' || (selected.AI_SYNTHETIC_DATA === 'true' && selected.NODE_ENV === 'test') ? 'synthetic' : 'user-readonly' };
    },
    getSettings: settingsProfile,
    getBudgetSettings(userId) {
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      requireWarmupReady();
      const defaults = budgetValues({ ...env, ...(aiConfigStore.get?.() || {}) });
      const overrides = userBudgetStore.get(userId);
      const values = { ...defaults, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== null)) };
      let effectiveMaxOutputTokens = null;
      try { effectiveMaxOutputTokens = getConfig(effectiveEnv(userId)).maxOutputTokens; } catch (_) {}
      return { contractVersion: 1, defaults, overrides, values, effectiveMaxOutputTokens,
        limits: Object.fromEntries(BUDGET_FIELDS.map(({ key, min, max }) => [key, { min, max }])) };
    },
    async setBudgetSettings(userId, input) {
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      await warmupSettings();
      await userBudgetStore.set(userId, input);
      return service.getBudgetSettings(userId);
    },
    getPreferences(userId) {
      requireWarmupReady();
      let config = null;
      try { config = getConfig(effectiveEnv(userId)); } catch (_) { config = null; }
      const flags = preferenceStore.getFlags(userId);
      return { contractVersion: 1, ...thinkingPreferences(config), webSearch: flags?.webSearch === true,
        webSearchAvailable: config?.searchEnabled === true || config?.searchCapabilityReady === true,
        envDefault: env.AI_THINKING === 'enabled' };
    },
    async setPreference(userId, input) {
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      const hasThinking = typeof input?.thinking === 'boolean';
      const hasWebSearch = typeof input?.webSearch === 'boolean';
      if (!hasThinking && !hasWebSearch) throw new AiError('参数不符合允许的字段或格式', 400, 'AI_REQUEST_INVALID');
      await preferenceStore.set(userId, hasThinking ? input.thinking : undefined, hasWebSearch ? input.webSearch : undefined);
      return service.getPreferences(userId);
    },
    warmupSettings,
    async configure(userId, input) {
      requireSettings(userId);
      await warmupSettings();
      // 不再复用 .env 的 Key：接入商凭据只能是用户本次填写或该接入商已加密保存的 Key。
      const connectionId = typeof input?.connectionId === 'string' ? input.connectionId : null;
      // 未带编号的保存：旧客户端不带 name 时按同一 API 地址命中已保存接入商（快捷换模型）；
      // 带 name 视为新增接入商，即使地址相同也应保留为独立配置（同厂商多账号）。
      const current = connectionId ? settingsStore.getByConnection(userId, connectionId)
        : (typeof input?.apiUrl === 'string' && !input?.name ? settingsStore.findByUrl(userId, input.apiUrl) : null);
      if (connectionId && !current) throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
      // 快捷切模型可能只带 model（未带 apiUrl）：沿用目标接入商存档地址，避免空串被 required 拒绝
      const settings = settingsStore.validate({ ...input, apiUrl: input?.apiUrl || current?.apiUrl }, current);
      getConfig({ ...env, AI_MODE: 'deepseek', AI_BASE_URL: settings.apiUrl,
        AI_API_KEY: settings.apiKey, AI_MODEL: settings.model,
        DEEPSEEK_API_KEY: settings.apiKey, DEEPSEEK_MODEL: settings.model });
      await checkConnection({ ...settings, baseUrl: settings.apiUrl });
      callLog.record({ userId, lane: 'settings', phase: 'meta', providerHost: providerHost({ baseUrl: settings.apiUrl }),
        model: settings.model, request: { apiUrl: settings.apiUrl, model: settings.model, hasKey: true, name: settings.name }, status: 'ok' });
      await settingsStore.save(userId, settings, { connectionId: current?.connectionId });
      return settingsProfile(userId);
    },
    async activateProvider(userId, connectionId) {
      requireSettings(userId);
      await warmupSettings();
      if (typeof connectionId !== 'string' || !connectionId) throw new AiError('接入商编号不正确', 400, 'AI_REQUEST_INVALID');
      await settingsStore.activate(userId, connectionId);
      return settingsProfile(userId);
    },
    async deleteProvider(userId, connectionId) {
      requireSettings(userId);
      await warmupSettings();
      if (typeof connectionId !== 'string' || !connectionId) throw new AiError('接入商编号不正确', 400, 'AI_REQUEST_INVALID');
      await settingsStore.remove(userId, connectionId);
      return settingsProfile(userId);
    },
    clearSettings(userId) {
      requireSettings(userId);
      requireWarmupReady();
      const cleared = settingsStore.clear(userId);
      return cleared?.then ? cleared.then(() => settingsProfile(userId)) : settingsProfile(userId);
    },
    async runOcr(userId, input) {
      requireFinancialAccess(userId);
      if (!userId || typeof userId !== 'string') throw new AiError('登录身份无效', 401);
      const config = getConfig(effectiveEnv(userId));
      if (config.mode !== 'deepseek' || config.dataSource !== 'user-readonly') {
        throw new AiError('图片识别需要真实AI连接和只读账本配置', 503, 'AI_OCR_DISABLED');
      }
      const request = validate(ocrRequestSchema, input);
      if (request.consent !== true) throw new AiError('请先同意将这张图片发送至当前AI供应商识别', 403, 'AI_CONSENT_REQUIRED');
      if (request.connectionId && request.connectionId !== settingsProfile(userId).connectionId) {
        throw new AiError('临时连接已过期或变化，请重新连接', 409, 'AI_CONNECTION_EXPIRED');
      }
      const image = await prepareOcrImage(request.image);
      turnContext.getStore().check();
      const conversation = await conversationStore.open(userId, request.conversationId);
      const imageHash = crypto.createHash('sha256').update(image.dataUrl).digest('hex');
      const originalCandidate=await candidateStore.findByFingerprint(userId,imageHash);
      const originalExtraction=originalCandidate?.trace?.find(item=>item.tool==='recognize_payment_image')?.result;
      if(originalCandidate&&(originalCandidate.status==='expired'||!originalExtraction)) {
        // Expired tombstones keep the fingerprint non-reusable to prevent a
        // second paid recognition of the same image. Report that explicitly
        // instead of pretending an empty card was restored.
        const expiredAnswer='这张图片的原核对已过期，无法再恢复；请重新拍摄或上传新的支付截图。';
        const result={contractVersion:1,mode:config.mode,source:'image-ocr',answer:expiredAnswer,
          conversationId:conversation.id,formalWriteEnabled:false,trace:[],ocr:null,draft:null,
          inputCandidate:null,financialCheck:null,financialChoices:null,expired:true};
        turnContext.getStore().check();
        return persistOcrResult(userId, conversation.id, turnContext.getStore(), async () => ({ result,
          appendPayload: { message:request.message||'再次识别上传图片', answer:expiredAnswer, ocr:null } }));
      }
      if(originalCandidate) {
        const restored=await service.getTransactionCandidate(userId,originalCandidate.id);
        const extraction=originalExtraction;
        const ocr=validateOcrResult(extraction);
        const answer='已恢复这张图片的原核对卡片。';
        const result={contractVersion:1,mode:config.mode,source:'image-ocr',answer,conversationId:conversation.id,
          formalWriteEnabled:false,trace:[],ocr,draft:restored.draft||null,inputCandidate:restored.inputCandidate,
          financialCheck:restored.financialCheck||restored.draft?.financialCheck,financialChoices:restored.choices};
        turnContext.getStore().check();
        return persistOcrResult(userId, conversation.id, turnContext.getStore(), async () => ({ result,
          appendPayload: { message:request.message||'再次识别上传图片', answer, draft:result.draft, ocr,
            business:{inputCandidate:result.inputCandidate,financialCheck:result.financialCheck} } }));
      }
      const prior = draftStore.findByImageHash ? await draftStore.findByImageHash(userId, imageHash) : null;
      if (prior) {
        const saved = prior.trace.find(item => item.tool === 'recognize_payment_image')?.result;
        const ocr = validateOcrResult(saved);
        ocr.warnings = [...ocr.warnings.slice(0, 9), prior.status === 'committed'
          ? '这张图片关联的交易已经入账，已显示原回执，请勿重复记账。' : '这张图片已有待核对草稿，已恢复原卡片。'];
        const draft = await enrichDraft(userId, prior);
        const answer = ocr.warnings[ocr.warnings.length - 1];
        turnContext.getStore().check();
        return persistOcrResult(userId, conversation.id, turnContext.getStore(), async () => ({
          appendPayload: { message: request.message || '再次识别上传图片', answer, draft, trace: [], ocr },
          result: { contractVersion: 1, mode: config.mode, source: 'image-ocr', answer,
            conversationId: conversation.id, formalWriteEnabled: false, trace: [], draft, ocr } }));
      }
      const today = todayShanghai(now());
      const budget = turnContext.getStore();
      requireFinancialAccess(userId);
      if(request.connectionId&&request.connectionId!==settingsProfile(userId).connectionId)
        throw new AiError('临时连接已过期或变化，请重新连接',409,'AI_CONNECTION_EXPIRED');
      // OCR 供应商调用全量审计（图片本身不入日志，只记哈希与说明文字）
      const ocr = validateOcrResult(await auditCall({ userId, requestId: budget.requestId, conversationId: conversation.id, lane: 'ocr', phase: 'provider', providerHost: providerHost(config), model: config.model, request: { message: request.message || '', imageHash } },
        () => budget.invoke(() => recognizeImage(config, image, today, request.message, { signal: budget.signal }))));
      budget.check();
      requireFinancialAccess(userId);
      const first = ocr.items[0];
      const cents = first?.amount && (first.amount.split('.')[1] || '').replace(/0+$/, '').length <= 2;
      const dateParts = first?.evidence?.dateText && /^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(first.evidence.dateText);
      const evidenceDate = dateParts && `${dateParts[1]}-${dateParts[2].padStart(2, '0')}-${dateParts[3].padStart(2, '0')}`;
      const evidenceAmount = first?.evidence?.amountText?.replace(/[^\d.]/g, '');
      const foreignCurrency=/[$€£]|\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD)\b|美元|港币|港元|欧元|日元|英镑/i;
      const currencyMatches = !foreignCurrency.test(first?.evidence?.amountText || '');
      const statusText = first?.evidence?.statusText || '';
      const kindText = first?.evidence?.kindText || '';
      const specialText = /转账|还款|退款|冲正|分期|购汇|结汇|证券|提现|初始化|余额调整|\b(?:transfer|repayment|refund|reversal|installment|investment|withdrawal)\b/i.test(
        [kindText, first?.merchant, first?.remark, first?.categoryHint].join(' '));
      const confirmed = /支付成功|交易成功|付款成功|收款成功|已支付|已收款|已完成/.test(statusText) &&
        !/未|待|失败|取消|退款|关闭/.test(statusText);
      const ordinary = /消费|支付|付款|收款|支出|收入/.test(kindText) && !specialText;
      const directionMatches = first?.direction === 0
        ? /消费|支付|付款|支出/.test(kindText) && !/收款|收入/.test(kindText) && !/\+/.test(first.evidence.amountText || '')
        : first?.direction === 1 && /收款|收入/.test(kindText) && !/消费|付款|支出/.test(kindText) && !/-/.test(first.evidence.amountText || '');
      const declaredDate=/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|今天|昨天|前天|明天|后天/.test(request.message||'')
        ?parseTransactionDate(request.message,today):null;
      const textAllowed=!containsSpecialFinancialIntent(request.message||'')&&!foreignCurrency.test(request.message||'')&&!declaredDate?.error&&
        !/未支付|待支付|未付款|待付款|支付失败|交易失败|交易取消|已取消|not paid|payment failed|pending payment/i.test(request.message||'');
      const eligible = textAllowed&&ocr.documentType === 'payment' && !ocr.truncated && ocr.items.length === 1 &&
        first.confidence === 'high' && first.transactionStatus === 'completed' && first.transactionKind === 'ordinary' &&
        first.currency === 'CNY' && [0, 1].includes(first.direction) && cents && first.transDate && first.transDate <= today &&
        evidenceDate === first.transDate && evidenceAmount && Number(evidenceAmount) === Number(first.amount) && currencyMatches && confirmed && ordinary && directionMatches;
      let draft = null,preparedCandidate=null,financialCheck=null,financialChoices=null;
      const repo = getRepository(config);
      if (eligible) {
        budget.check();
        const choices = await repo.choices(userId);
        const candidates = choices.categories.filter(item => isSupportedDraftCategory(item) &&
          item.type === (first.direction === 0 ? 'expense' : 'income') && item.name === first.categoryHint);
        const proposed = await auditCall({ userId, requestId: budget.requestId, conversationId: conversation.id, lane: 'ocr', phase: 'tool', providerHost: providerHost(config), model: config.model, toolName: 'propose_transaction', origin: 'system', request: {
          direction: first.direction, amount: first.amount, currency: 'CNY', transDate: first.transDate,
          categoryId: candidates.length === 1 ? candidates[0].id : null, accountId: null,
          payMethod: first.payMethod, remark: first.remark || first.merchant || '',
        } }, () => executeTool({ scene: 'draft', userId, repository: repo, today }, 'propose_transaction', {
          direction: first.direction, amount: first.amount, currency: 'CNY', transDate: first.transDate,
          categoryId: candidates.length === 1 ? candidates[0].id : null, accountId: null,
          payMethod: first.payMethod, remark: first.remark || first.merchant || '',
        }));
        budget.check();
        const declared=extractMoneyTokens(request.message||'',{entities:choices.accounts});
        const conflict=declared.length>0&&(declared.length!==1||!declared[0].valid||
          normalizeTransactionAmount(declared[0].amount)!==normalizeTransactionAmount(proposed.amount));
        const saidIncome=/收入|收款|到账|收到|\bincome\b/i.test(request.message||'');
        const saidExpense=/支出|消费|付款|支付|花了|\bexpense\b/i.test(request.message||'');
        const directionConflict=(saidIncome&&saidExpense)||(saidIncome&&proposed.direction!==1)||(saidExpense&&proposed.direction!==0);
        const dateConflict=!!declaredDate&&declaredDate.date!==proposed.transDate;
        const evidence={...(conflict?{amountConflict:true}:{}),...(directionConflict?{directionConflict:true}:{}),...(dateConflict?{dateConflict:true}:{})};
        const selected={...proposed,...(conflict?{amount:null}:{}),...(directionConflict?{direction:null}:{}),...(dateConflict?{transDate:null}:{})};
        const result=await financial(userId).inspect(userId,{fields:selected},{sourceCandidate:{source:'image-ocr',eligible:true,evidence}});
        budget.check();
        requireFinancialAccess(userId);
        result.evidence={...(result.evidence||{}),...evidence};
        if(conflict) {
          // Model-authored warnings cannot be trusted to describe the outcome:
          // "已按图片金额提取" is a paraphrase of the old "以图片为准" wording.
          // Discard all of them, leaving exactly one server-authored verdict.
          ocr.warnings=['图片金额与文字说明冲突，两个金额都未采用，请手工核对。'];
        }
        if(directionConflict||dateConflict) ocr.warnings=[...ocr.warnings.slice(0,9),'图片与文字的方向或日期不一致，请手工核对对应字段。'];
        preparedCandidate = result;
        financialCheck=result.financialCheck;financialChoices=result.choices;
      } else if (ocr.items.length) {
        ocr.warnings = [...ocr.warnings.slice(0, 9), '仅供核对：多笔账单、特殊交易或不完整信息不会自动生成记账草稿。'];
      }
      // A strong source fingerprint survives rejection/cancellation; it never authorizes another paid recognition.
      requireFinancialAccess(userId);
      budget.check();
      return persistOcrResult(userId, conversation.id, budget, async conn => {
        let inputCandidate = null;
        if (preparedCandidate) inputCandidate = await financial(userId).candidate(userId, preparedCandidate, {
          source:'image-ocr', eligible:true, message:('[图片识别] '+(request.message||'')).slice(0,1500),
          conversationId:conversation.id, sourceFingerprint:imageHash,
          trace:[{tool:'recognize_payment_image',readOnly:true,result:ocr,imageHash}] }, conn);
        else await candidateStore.save(userId,{source:'image-ocr',eligible:false,fields:{},
          originalText:'[图片识别]',conversationId:conversation.id,sourceFingerprint:imageHash,
          trace:[{tool:'recognize_payment_image',readOnly:true,result:ocr,imageHash}]}, conn);
        budget.check();
        const answer = inputCandidate ? '图片已识别，请补充资金账户后核查。' : '图片识别结果已列出，请核对原图。';
        return { appendPayload: { message: request.message || '识别上传的支付截图或账单',
          answer, draft, trace: [], ocr, business:inputCandidate?{inputCandidate,financialCheck,financialChoices}:undefined },
          result: { contractVersion: 1, mode: config.mode, source: 'image-ocr', answer,
            conversationId: conversation.id, formalWriteEnabled: false, trace: [], draft, ocr,inputCandidate,financialCheck,financialChoices } };
      });
    },
    
    getDraftState: async (userId, id) => {
      const draft = await draftStore.get(userId, id);
      return { conversationId: draft.conversationId, status: draft.status, originalText: draft.originalText };
    },
    getDraft: async (userId, id) => enrichDraft(userId, await draftStore.get(userId, id)),
    async editDraft(userId, id, input) {
      const config = requireFinancialAccess(userId);
      if (config.mode === 'disabled') throw new AiError('站点尚未启用 AI 测试', 503);
      const { version, fields } = validate(draftEditSchema, input);
      const updated = await auditCall({ userId, requestId: null, lane: 'draft-edit', phase: 'tool', providerHost: providerHost(config), model: config.model, toolName: 'propose_transaction', origin: 'user', request: { draftId: id, version, fields } },
        () => executeTool({ scene: 'draft', userId, repository: getRepository(config),
          today: todayShanghai(now()) }, 'propose_transaction', fields));
      const amount=normalizeTransactionAmount(updated.amount);
      if(!amount) throw new AiError('人民币金额最多到分，请明确修改金额',400,'AI_AMOUNT_INVALID');
      const current=await draftStore.get(userId,id);
      requireFinancialAccess(userId);
      // Edits remain editable proposals; they lose every previous financial acknowledgement.
      return enrichDraft(userId, await draftStore.update(userId, id, version, {...updated,amount,
        trace:(current.trace||[]).filter(item=>item.tool!=='financial_review')}));
    },
    async actOnDraft(userId, id, input) {
      const { version, action,riskAcknowledgement } = validate(draftActionSchema, input);
      if(action==='discard') return enrichDraft(userId,await draftStore.act(userId,id,version,action));
      requireFinancialAccess(userId);
      const current=await draftStore.get(userId,id);
      if(current.version!==version) throw new AiError('草稿版本已变化，请重新核对',409,'AI_DRAFT_CONFLICT');
      const reviewVersion=current.status==='reviewed'?version-1:version;
      let result=await financial(userId).inspect(userId,{fields:current},{version:reviewVersion,originalText:current.originalText});
      financial(userId).checkAcknowledgement(result.financialCheck,riskAcknowledgement);
      if(result.missingFields.length) throw new AiError('请补齐分类、资金账户和支付方式',409,'AI_DRAFT_FIELDS_MISSING');
      if(current.status==='reviewed') {
        result={...result,financialCheck:financial(userId).forReviewVersion(result.financialCheck,version)};
      }
      requireFinancialAccess(userId);
      return enrichDraft(userId,await draftStore.act(userId,id,version,action,{fieldsDigest:result.financialCheck.fieldsDigest,
        riskDigest:result.financialCheck.riskDigest,policyVersion:result.financialCheck.policyVersion,
        reviewedAt:new Date(now()).toISOString(),forVersion:version}));
    },
    // ===== 追加163：草稿入账（唯一写触发端点的实现，见 Docs/docs/ai/boundary.md 铁律1） =====
    // 只收 draftId+version；两种账户的草稿、正式流水和回执均在同一事务中写入。
    async commitDraft(userId, id, input) {
      const { version } = validate(commitSchema, input);
      const draft = await draftStore.get(userId, id); // 404：不存在/过期/非本人
      if(draft.status!=='committed') requireFinancialAccess(userId);
      if (draft.status === 'pending') throw new AiError('请先在卡片上完成核对，再入账', 409, 'AI_DRAFT_NOT_REVIEWED');
      if (draft.status === 'discarded') throw new AiError('这份草稿已取消', 409, 'AI_DRAFT_DISCARDED');
      if (draft.status === 'committed') {
        if(!draft.committedRecordId) throw new AiError('入账回执尚未确认，请刷新后核查',409,'AI_DRAFT_CONFLICT');
        return enrichDraft(userId,draft);
      }
      if (draft.status !== 'reviewed') throw new AiError('草稿状态不允许入账', 409, 'AI_DRAFT_CONFLICT');
      if (draft.version !== version) throw new AiError('草稿版本已变化，请重新核对', 409, 'AI_DRAFT_CONFLICT');
      const config = getConfig(effectiveEnv(userId));
      if (!['user-readonly', 'image-ocr'].includes(draft.source) || config.dataSource !== 'user-readonly') {
        throw new AiError('测试样例草稿不能写入真实账本', 400, 'AI_COMMIT_SOURCE');
      }

      // 库存档也重新检查格式；人民币最多到分，不能默默截断更细的金额。
      if (![0, 1].includes(draft.direction)) throw new AiError('草稿收支方向不合法', 400, 'AI_COMMIT_DIRECTION');
      if (typeof draft.amount !== 'string' || !/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/.test(draft.amount) ||
          (draft.amount.split('.')[1] || '').replace(/0+$/, '').length > 2) {
        throw new AiError('人民币金额最多保留两位小数，请修改后重新核对', 400, 'AI_COMMIT_AMOUNT');
      }
      const amount = Number(draft.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new AiError('草稿金额不合法', 400, 'AI_COMMIT_AMOUNT');
      if (draft.currency !== 'CNY') throw new AiError('仅支持人民币草稿入账', 400, 'AI_COMMIT_CURRENCY');
      const parsedDate = /^20\d{2}-\d{2}-\d{2}$/.test(draft.transDate) ? new Date(`${draft.transDate}T00:00:00Z`) : null;
      if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== draft.transDate ||
          draft.transDate > todayShanghai(now())) throw new AiError('草稿日期不合法或晚于今天', 400, 'AI_COMMIT_DATE');
      if (!['现金', '余额', '支付宝', '微信', '银行卡'].includes(draft.payMethod)) {
        throw new AiError('草稿支付方式不合法，请修改后重新核对', 400, 'AI_COMMIT_PAY_METHOD');
      }
      if (typeof draft.remark !== 'string' || draft.remark.length > 255) throw new AiError('草稿备注不合法', 400, 'AI_COMMIT_REMARK');
      const choices = await getRepository(config).choices(userId);
      let conn;
      try {
        conn = await writeDb.getConnection();
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conn.beginTransaction();
        const priorCommit = await draftStore.commitInTx(conn, userId, id, version);
        if (priorCommit) {
          const receipt = await enrichDraft(userId, priorCommit);
          await conn.commit();
          return receipt;
        }
        // 锁定当前分类与账户再复验，候选查询后发生删除/改类型也不会带病写入。
        const [categories] = await conn.execute(
          'SELECT id, name, type FROM bus_category WHERE id=? AND user_id=? AND is_deleted=0 FOR UPDATE',
          [draft.categoryId, userId]);
        const category = categories[0];
        if (!isSupportedDraftCategory(category) || category.type !== (draft.direction === 0 ? 'expense' : 'income')) {
          throw new AiError('草稿分类不存在、已删除或与收支方向不匹配，请修改后重新核对', 400, 'AI_COMMIT_CATEGORY');
        }
        // Same shared display rule as the read repositories. FOR UPDATE also
        // holds the single bank-category row; it is a shared dimension row and
        // this commit transaction is deliberately short.
        const [accounts] = await conn.execute(
          `SELECT c.id, ${COMMIT_CARD_NAME} AS name, c.card_type AS type, c.share_pool_id FROM card_base c ${COMMIT_CARD_BANK_JOIN} WHERE c.id=? AND c.user_id=? AND c.is_deleted=0 AND c.status='正常' FOR UPDATE`,
          [draft.accountId, userId]);
        const account = accounts[0];
        if (!account || !['credit', 'debit', 'virtual_cash', 'virtual_balance'].includes(account.type)) {
          throw new AiError('草稿账户不存在或已停用，请修改后重新核对', 400, 'AI_COMMIT_ACCOUNT');
        }
        if (draft.direction === 1 && account.type === 'credit') throw new AiError('信用卡不能登记收入', 400, 'AI_COMMIT_ACCOUNT');
        if(account.type==='credit'&&account.share_pool_id) await conn.execute(
          'SELECT id FROM card_credit_pool WHERE id=? AND user_id=? AND is_deleted=0 FOR UPDATE',[account.share_pool_id,userId]);
        const currentCheck=await financial(userId).inspect(userId,{fields:draft},{version:version-1,executor:conn,originalText:draft.originalText});
        financial(userId).assertUsable(currentCheck.financialCheck);
        const reviewed=(draft.trace||[]).find(item=>item.tool==='financial_review')?.result;
        if(!reviewed||reviewed.riskDigest!==currentCheck.financialCheck.riskDigest||reviewed.fieldsDigest!==currentCheck.financialCheck.fieldsDigest)
          throw Object.assign(new AiError('资金或风险情况已变化，请重新核对草稿',409,'AI_RISK_CHANGED'),{financialCheck:currentCheck.financialCheck});
        requireFinancialAccess(userId);
        const model = account.type === 'credit' ? require('../../account/model/credit') : require('../../account/model/debit');
        const record = await model.create({
          userId, direction: draft.direction, categoryId: draft.categoryId,
          payType: category.name, payMethod: draft.payMethod, amount,
          currency: 'CNY', transDate: draft.transDate, remark: draft.remark,
          cardId: draft.accountId,
        }, conn);
        if (!record?.id) throw new AiError('入账未返回记录号', 500, 'AI_COMMIT_FAILED');
        await draftStore.setRecordId(userId, id, record.id, conn);
        // 在提交前准备回执，提交成功后不再执行可能失败的额外数据库读取。
        const committed = await draftStore.get(userId, id, conn);
        const receipt = { ...committed, categoryName: category.name, accountName: account.name,
          needsReview: false, formalWriteEnabled: false, choices, committedRecordId: record.id };
        requireFinancialAccess(userId);
        await conn.commit();
        // 追加164：入账是唯一写路径，成功/失败都留审计行（回执号/金额/分类/账户直接可查）
        callLog.record({ userId, conversationId: draft.conversationId, lane: 'draft-commit', phase: 'commit',
          providerHost: providerHost(config), model: config.model,
          request: { draftId: id, version }, response: { recordId: record.id, amount: draft.amount,
            direction: draft.direction, categoryName: category.name, accountName: account.name,
            payMethod: draft.payMethod, transDate: draft.transDate }, status: 'ok' });
        return receipt;
      } catch (error) {
        callLog.record({ userId, conversationId: draft?.conversationId || null, lane: 'draft-commit', phase: 'commit',
          request: { draftId: id, version }, status: 'error', errorCode: error?.code || null,
          response: { message: error?.message } });
        if (conn) await conn.rollback().catch(() => {});
        if (error instanceof AiError) throw error;
        const { isBusinessError } = require('../../../common/utils/logFields');
        if (isBusinessError(error)) throw new AiError(error.message, 400, 'AI_COMMIT_FAILED');
        throw new AiError('入账未确认，请刷新草稿或流水后再试', 503, 'AI_COMMIT_FAILED');
      } finally {
        if (conn) conn.release();
      }
    },
    getBalance: async (userId, connectionId) => {
      // 追加163：供应商官方账户余额查询（非系统账本余额，负责人指定）。2026-11-10 按各家 API 契约分发——
      // 核实结果：仅 DeepSeek 官方提供 /user/balance；GLM(bigmodel.cn) 官方未开放余额 API（其 FAQ 指引
      // 登录控制台「财务总览」查看）；其余接入商（中转站等）无已知契约。带 connectionId 时查询指定
      // 接入商（设置面板查看哪家查哪家），Key/地址只取自该账号已保存的接入商；不带时查当前生效接入商。
      const config = getConfig(effectiveEnv(userId));
      if (config.mode === 'disabled') throw new AiError('站点尚未启用 AI 测试', 503, 'AI_DISABLED');
      if (config.mode === 'mock') throw new AiError('模拟模式不产生真实用量，无余额可查', 400, 'AI_BALANCE_NA');
      let target = config;
      if (connectionId !== undefined && connectionId !== null && connectionId !== '') {
        if (typeof connectionId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(connectionId)) {
          throw new AiError('接入商编号不正确', 400, 'AI_REQUEST_INVALID');
        }
        const source = settingsStore.getByConnection(userId, connectionId);
        if (!source) throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
        target = { baseUrl: source.apiUrl, apiKey: source.apiKey, model: source.model || config.model,
          providerTimeoutMs: config.providerTimeoutMs };
      }
      const { host, hostname } = providerParts(target);
      if (/(^|\.)deepseek\.com$/i.test(hostname)) {
        return auditCall({ userId, lane: 'balance', phase: 'meta', providerHost: host, model: target.model,
          request: { baseUrl: target.baseUrl, connectionId: connectionId || null } },
          () => fetchDeepseekBalance(target));
      }
      const unsupported = /(^|\.)bigmodel\.cn$/i.test(hostname)
        ? `${host}（智谱 GLM 官方）未提供用量余额查询 API，余额请登录 open.bigmodel.cn 控制台「财务总览」查看`
        : `${host} 未提供用量余额查询（按供应商契约逐家接入，当前仅 DeepSeek 官方支持）`;
      throw new AiError(unsupported, 400, 'AI_BALANCE_UNSUPPORTED');
    },
    // ===== 追加163 扩展：历史聊天记录（负责人需求）=====
    listConversations: async (userId) => {
      const list = await conversationStore.list(userId, 50);
      try { await conversationSyncStore?.pruneOrphans?.(userId); }
      catch (error) { reportAiError(error, { phase: 'conversation-activity-prune' }); }
      return list;
    },
    getConversationMessages: (userId, id) => conversationStore.messages(userId, id),
    getConversationMessagesSince: (userId, id, since) => conversationStore.messagesSince(userId, id, since),
    getConversationSync: (userId, id, since) => {
      if (!conversationSyncStore) throw new AiError('会话同步服务暂不可用', 503, 'AI_SYNC_UNAVAILABLE');
      return conversationSyncStore.snapshot(userId, id, since);
    },
    deleteConversation: (userId, id) => conversationStore.remove(userId, id, conversationSyncStore?.remove),
    // ===== D-027：数据授权白名单（跟账号走，服务端强约束）=====
    getGrant: (userId, conversationId) => dataGrantStore.get(userId, conversationId),
    putGrant: (userId, input) => dataGrantStore.put(userId, { providerHost: input?.providerHost, domains: input?.domains,
      conversationId: input?.conversationId, lifetime: input?.lifetime, access: input?.access }),
    deleteGrant: (userId, conversationId) => dataGrantStore.revoke(userId, conversationId),
    // 获取供应商模型列表（OpenAI 兼容 /models）：Key 只取自本次输入或该账号已保存的接入商，
    // 不再回退 .env 凭据。
    async fetchProviderModels(userId, input) {
      await warmupSettings();
      let source = null;
      if (input?.connectionId !== undefined && input?.connectionId !== null && input?.connectionId !== '') {
        if (typeof input.connectionId !== 'string') throw new AiError('接入商编号不正确', 400, 'AI_REQUEST_INVALID');
        source = settingsStore.getByConnection(userId, input.connectionId);
        if (!source) throw new AiError('接入商不存在或已被删除', 404, 'AI_PROVIDER_NOT_FOUND');
      } else {
        // 未指定接入商时用当前生效的一家；没有生效接入商才回落到默认展示地址（仍需显式 Key）。
        source = settingsStore.get(userId) || null;
      }
      const baseUrl = normalizeApiUrl(input?.apiUrl || source?.apiUrl || DEEPSEEK_BASE_URL);
      const suppliedKey = input?.apiKey;
      const hasSuppliedKey = suppliedKey !== undefined && suppliedKey !== null && suppliedKey !== '';
      if (hasSuppliedKey && (typeof suppliedKey !== 'string' || suppliedKey.length < 8 || suppliedKey.length > 256 ||
          !/^[A-Za-z0-9_\-\.]+$/.test(suppliedKey))) throw new AiError('请填写有效的 API Key', 400, 'AI_KEY_REQUIRED');
      // 已保存的 Key 只能复用于绑定的规范化地址，换目标必须显式提供 Key。
      let apiKey = hasSuppliedKey ? suppliedKey : undefined;
      if (!apiKey && source && normalizeApiUrl(source.apiUrl) === baseUrl) apiKey = source.apiKey;
      if (!apiKey) {
        const matched = (settingsStore.list?.(userId) || []).find(item => item.apiUrl === baseUrl);
        if (matched) apiKey = matched.apiKey;
      }
      if (!apiKey) throw new AiError('此 API 地址没有可复用的 Key，请明确填写 API Key', 400, 'AI_KEY_REQUIRED');
      return modelListCache.get({ userId, baseUrl, apiKey }, () =>
        auditCall({ userId, lane: 'models', phase: 'meta', providerHost: providerHost({ baseUrl }), request: { baseUrl, hasKey: true } },
          () => fetchProviderModelList({ baseUrl, apiKey })));
    },
    close: async () => { modelListCache.clear(); settingsStore.close(); if (liveRepository) await liveRepository.close(); if(liveFinancialRepository) await liveFinancialRepository.close(); },
  };
  // OCR remains a shared, independently budgeted contractVersion:1 path.
  for (const [name, lane, maxProviderCalls, timeoutMs, schema] of [
    ['runOcr', 'ocr', 1, 75000, ocrRequestSchema],
  ]) {
    const method = service[name];
    service[name] = async (userId, input, control = {}) => {
      const request = validate(schema, input);
      await warmupSettings();
      let providerTimeoutMs = 60000;
      try { providerTimeoutMs = getConfig(effectiveEnv(userId)).providerTimeoutMs || 60000; } catch (_) { /* 配置缺失在方法内给出明确错误 */ }
      const turnTimeout = name === 'runOcr' ? Math.min(120000, Math.max(45000, providerTimeoutMs + 15000)) : timeoutMs;
      let activity;
      if (name === 'runOcr' && conversationSyncStore) {
        request.requestId ||= crypto.randomUUID();
        request.conversationId ||= (await conversationStore.session(userId, 'default')).id;
        activity = await conversationSyncStore.begin(userId, request.conversationId, request.requestId,
          request.message || '识别这张图片', turnTimeout + requestLimits(env).queueWaitMs);
      }
      try {
        const result = await requestGuard.run(userId, { requestId: request.requestId, lane, input: request, maxProviderCalls, timeoutMs: turnTimeout, signal: control.signal },
          async budget => {
            if (activity) await conversationSyncStore.update(activity, 'running', 'thinking');
            return turnContext.run(budget, () => method(userId, request));
          });
        if (activity) await conversationSyncStore.update(activity, 'completed', 'completed').catch(() => {});
        return result;
      } catch (error) {
        if (activity) await conversationSyncStore.update(activity, 'failed', 'failed', { code: error.code || 'AI_REQUEST_FAILED',
          message: error instanceof AiError ? error.message : '图片处理未完成，请查看回执。' }).catch(() => {});
        throw error;
      }
    };
  }
  return service;
}
module.exports = { createAiService, requestLimits };
