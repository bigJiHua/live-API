const express = require('express');
const authGuard = require('../../../common/middleware/authGuard');
const db = require('../../../common/config/db');
const { capabilities } = require('../service/config');
const { createAiService } = require('../service');
const { AiError } = require('../service/errors');
const { createBusinessService } = require('../service/businessService');
const { createV3Service } = require('../service/v3Service');
const { createCallLogStore } = require('../service/callLog');
const { createPreferenceStore } = require('../service/preferences');
const { createMemoryStore } = require('../service/memoryStore');
const { createPersonalizationStore } = require('../service/personalizationStore');
const { createMemoryManagementService } = require('../service/memoryManagement');
const { createProfileGenerationService } = require('../service/profileGeneration');
const { createContextMemoryStore } = require('../service/personalizationContext');
const { createAiConfigStore } = require('../service/aiConfigStore');
const { createUserBudgetStore } = require('../service/userBudgetSettings');
const crypto = require('crypto');
const { withAiDiagnosticContext, reportAiError } = require('../service/diagnostics');
const { sanitizeProviderDetail } = require('../service/providerDetail');
const { createConversationSyncStore } = require('../service/conversationSync');
const { createRolloutPolicy } = require('../service/rolloutPolicy');

// 追加164：审计日志/用户偏好真实写库（生产组合根）；单测注入替身或依赖 createAiService 默认 no-op
const defaultCallLog = createCallLogStore({ executor: db });
const defaultPreferences = createPreferenceStore({ executor: db });
const defaultAiConfig = createAiConfigStore({ executor: db });
const defaultUserBudget = createUserBudgetStore({ executor: db });

function createAiRouter({ guard = authGuard, service = createAiService({ callLog: defaultCallLog, preferenceStore: defaultPreferences,
  aiConfigStore: defaultAiConfig, userBudgetStore: defaultUserBudget, conversationSyncStore: createConversationSyncStore() }), business, agent,
  memoryStore = createMemoryStore(), personalizationStore = createPersonalizationStore(), memoryManagement,
  profileGeneration, env = process.env, clock = Date.now, syncIntervalMs = 2000, syncLifetimeMs = 55000 } = {}) {
  const router = express.Router();
  const rollout = createRolloutPolicy(env);
  const limits = new Map();
  const draftLimits = new Map();
  const settingsLimits = new Map();
  const balanceLimits = new Map();
  const financialLimits = new Map();
  const personalizationLimits = new Map();
  const callLog = defaultCallLog;
  router.use(guard);
  // Gate paid generation before warmup/admission. Receipt/history reads stay
  // available after a user leaves the trial; no new request is sent to recover.
  router.use((req, res, next) => {
    if (req.method !== 'POST' || !['/v3/chat', '/v3/chat/stream', '/v3/ocr', '/personalization/profile/generate'].includes(req.path)) return next();
    try { rollout.assertAllowed(req.userId); next(); }
    catch (error) { res.status(error.status || 403).json({ status: error.status || 403, code: error.code, message: error.message }); }
  });
  router.use((req, res, next) => {
    const input = req.body?.data ?? req.body ?? {};
    req.aiTraceId = crypto.randomUUID();
    req.aiStartedAt = Date.now();
    res.set('X-AI-Trace-Id', req.aiTraceId);
    withAiDiagnosticContext({ traceId: req.aiTraceId, requestId: input.requestId || null,
      conversationId: input.conversationId || null, userId: req.userId, path: req.originalUrl?.split('?')[0] || req.path }, next);
  });
  // D-028：首个 /ai 请求触发连接设置暖机（从 ai_provider_setting 恢复加密 Key/模型，幂等）
  router.use(async (req, res, next) => {
    // Durable receipts remain readable while model settings are warming up.
    if (req.method === 'GET' && /^\/v3\/requests\/[^/]+$/.test(req.path)) return next();
    try { await service.warmupSettings?.(); next(); }
    catch (error) {
      reportAiError(error, { phase: 'settings-warmup' });
      res.status(503).json({ status: 503, code: 'AI_SETTINGS_LOAD_FAILED', message: 'AI 配置暂无法读取，请稍后重试', traceId: req.aiTraceId });
    }
  });
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const businessService = business || createBusinessService({ legacyService: service, callLog });
  const memories = memoryManagement || createMemoryManagementService({ memoryStore, personalizationStore });
  const profiles = profileGeneration || createProfileGenerationService({ executor: db,
    getRuntime: userId => service.getRuntime(userId), personalizationStore, memoryStore, callLog });
  const contextMemory = createContextMemoryStore({ memoryStore, personalizationStore, memoryManagement: memories });
  const agentService = agent || createV3Service({ legacyService: service, businessService, callLog,
    memoryStore: contextMemory, personalizationStore, profileGeneration: profiles,
    memoryDeletion: (...args) => memories.remove(...args) });
  // 2026-11-10：优雅停机钩子（app.js SIGINT/SIGTERM/SIGUSR2 调用）；单测注入的 service 无 shutdown 时为 no-op。
  router.shutdownAI = () => service.shutdown?.();
  // Only V3 can start a new text/OCR turn. Historical cards use the shared
  // owner-bound stores and executors through the V3 routes below.
  router.use((req, res, next) => {
    if (/^\/v2(?:\/|$)/.test(req.path) || ['/chat', '/ocr'].includes(req.path))
      return res.status(410).json({ status: 410, code: 'AI_VERSION_RETIRED',
        message: '旧版 AI 入口已停用，请刷新页面使用新的聊天入口', traceId: req.aiTraceId });
    next();
  });
  function agentError(req, error) {
    reportAiError(error, { phase: 'v3-http', elapsedMs: Date.now() - req.aiStartedAt });
    const safe = error instanceof AiError ? error : new AiError('AI 处理未得到确认，请读取回执', 503, 'AI_AGENT_FAILED');
    if (!req.res.headersSent && Number.isInteger(safe.retryAfterSeconds)) req.res.set('Retry-After', String(safe.retryAfterSeconds));
    const providerDetail = sanitizeProviderDetail(safe.providerDetail);
    return { status: safe.status, code: safe.code, message: safe.message, traceId: req.aiTraceId,
      ...(safe.requestId ? { requestId: safe.requestId } : {}),
      ...(Number.isInteger(safe.providerCalls) ? { providerCalls: safe.providerCalls } : {}),
      ...(safe.notAdmitted === true && safe.providerCalls === 0 && ['AI_PREPARATION_TIMEOUT', 'AI_PREPARATION_CANCELLED'].includes(safe.code) ? { notAdmitted: true } : {}),
      ...(Number.isInteger(safe.retryAfterSeconds) ? { retryAfterSeconds: safe.retryAfterSeconds } : {}),
      ...(Array.isArray(safe.missingDomains) ? { missingDomains: safe.missingDomains } : {}),
      ...(safe.authorizationRequest ? { authorizationRequest: safe.authorizationRequest } : {}),
      ...(safe.financialCheck ? { financialCheck: safe.financialCheck } : {}),
      ...(providerDetail ? { providerDetail } : {}) };
  }
  const personalizationHandler = action => async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const input = req.body?.data ?? req.body;
      if (req.method !== 'GET') {
        const key = req.userId, at = clock(), recent = (personalizationLimits.get(key) || []).filter(time => at - time < 60000);
        if (recent.length >= 30) throw new AiError('个性化修改过于频繁，请稍后重试', 429, 'AI_PERSONALIZATION_RATE_LIMIT');
        recent.push(at); personalizationLimits.set(key, recent);
      }
      let data;
      if (action === 'get') data = await personalizationStore.get(req.userId);
      else if (action === 'update') data = await personalizationStore.update(req.userId, input, { signal: controller.signal });
      else if (action === 'generate') {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['expectedRevision', 'mode'].includes(key)))
          throw new AiError('画像整理参数无效', 400, 'AI_PROFILE_INPUT_INVALID');
        data = await profiles.generate(req.userId, { ...input, requestId: crypto.randomUUID(), signal: controller.signal });
      } else if (action === 'list') data = await memories.list(req.userId);
      else if (action === 'history') data = await memories.history(req.userId, req.query.path ?? null);
      else if (action === 'read') data = await memories.read(req.userId, { path: req.params.path });
      else if (action === 'create') data = await memories.create(req.userId, input, { signal: controller.signal });
      else if (action === 'edit') data = await memories.update(req.userId, req.params.path, input, { signal: controller.signal });
      else if (action === 'delete') data = await memories.remove(req.userId, req.params.path, input, { signal: controller.signal });
      else if (action === 'restore') data = await memories.restore(req.userId, req.params.path, input, { signal: controller.signal });
      res.json({ status: 200, data, traceId: req.aiTraceId });
    } catch (error) {
      const payload = agentError(req, error);
      if (!res.destroyed) res.status(payload.status).json(payload);
    } finally { res.removeListener('close', onClose); }
  };
  router.get('/personalization', personalizationHandler('get'));
  router.put('/personalization', personalizationHandler('update'));
  router.post('/personalization/profile/generate', personalizationHandler('generate'));
  router.get('/memories', personalizationHandler('list'));
  router.get('/memories/history', personalizationHandler('history'));
  router.post('/memories', personalizationHandler('create'));
  router.get('/memories/:path', personalizationHandler('read'));
  router.put('/memories/:path', personalizationHandler('edit'));
  router.delete('/memories/:path', personalizationHandler('delete'));
  router.post('/memories/:path/restore', personalizationHandler('restore'));
  const agentHandler = method => async (req, res) => {
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.on('close', onClose);
    try {
      const input = req.body?.data ?? req.body;
      let result;
      if (method === 'getRequestReceipt') result = await service.getRequestReceipt(req.userId, req.params.requestId);
      else if (method === 'session') {
        if (req.method === 'POST' && (!input || input.kind !== 'manual' || Object.keys(input).some(key => key !== 'kind')))
          throw new AiError('新会话只接受手动会话类型');
        result = await agentService.session(req.userId, req.method === 'POST' ? 'manual' : 'default');
      } else if (method === 'getProposal') result = await agentService.getProposal(req.userId, req.params.id);
      else if (['editProposal', 'actOnProposal', 'executeProposal'].includes(method))
        result = await agentService[method](req.userId, req.params.id, input);
      else result = await agentService.chat(req.userId, input, null, { signal: disconnected.signal });
      res.json({ status: 200, data: result, traceId: req.aiTraceId });
    } catch (error) {
      const payload = agentError(req, error);
      if (!res.destroyed) res.status(payload.status).json(payload);
    } finally { res.removeListener('close', onClose); }
  };
  router.post('/v3/chat', agentHandler('chat'));
  router.post('/v3/chat/stream', async (req, res) => {
    let started = false;
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.on('close', onClose);
    // SSE 注释帧保活：单次 provider 调用最长 60s 无字节，直连无碍，
    // 但 nginx/CDN 的 idle 超时会先掐断连接。: ping 帧被解析器忽略。
    let heartbeat = null;
    const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
    const startHeartbeat = () => {
      if (heartbeat) return;
      heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) { stopHeartbeat(); return; }
        res.write(': ping\n\n');
      }, 15000);
      heartbeat.unref?.();
    };
    const send = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      if (!started) {
        started = true;
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders?.();
        startHeartbeat();
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.on('error', () => {});
    try {
      const result = await agentService.chat(req.userId, req.body?.data ?? req.body,
        send, { signal: disconnected.signal });
      send('done', { status: 200, data: result, traceId: req.aiTraceId });
      res.end();
    } catch (error) {
      const payload = agentError(req, error);
      if (!res.destroyed) {
        if (started) { send('error', payload); res.end(); }
        else res.status(payload.status).json(payload);
      }
    } finally { stopHeartbeat(); res.removeListener('close', onClose); }
  });
  router.get('/v3/requests/:requestId', agentHandler('getRequestReceipt'));
  router.get('/v3/metrics', async (req, res) => {
    try {
      const capability = service.getCapabilities(req.userId);
      const { PROMPT_VERSION, PROMPT_DIGEST } = require('../service/v3Prompt');
      const data = await callLog.metrics(req.userId);
      res.json({ status: 200, data: { ...data, contractVersion: 3, promptVersion: PROMPT_VERSION, promptDigest: PROMPT_DIGEST,
        dailyProviderLimit: capability.requestPolicy.dailyProviderCalls,
        remainingProviderCalls: Math.max(0, capability.requestPolicy.dailyProviderCalls - (data.providerCalls || 0)) }, traceId: req.aiTraceId });
    } catch (error) { const payload = agentError(req, error); res.status(payload.status).json(payload); }
  });
  router.get('/v3/session', agentHandler('session'));
  router.post('/v3/session', agentHandler('session'));
  router.get('/v3/proposals/:id', agentHandler('getProposal'));
  router.put('/v3/proposals/:id', agentHandler('editProposal'));
  router.post('/v3/proposals/:id/action', agentHandler('actOnProposal'));
  router.post('/v3/proposals/:id/execute', agentHandler('executeProposal'));
  const financialHandler=(method,byId=false)=>async(req,res)=>{
    const now=clock();
    for(const [id,entry] of financialLimits) if(entry.until<=now&&!entry.active) financialLimits.delete(id);
    const entry=financialLimits.get(req.userId)||{until:now+60000,count:0,active:false};
    if(entry.active||entry.count>=30||(!financialLimits.has(req.userId)&&financialLimits.size>=1000))
      return res.status(429).json({status:429,code:'AI_RATE_LIMIT',message:'本地财务核查过于频繁，请稍后重试'});
    entry.active=true;entry.count++;financialLimits.set(req.userId,entry);
    try {
      const result=await service[method](req.userId,byId?req.params.id:(req.method==='GET'?req.query:req.body?.data??req.body));
      res.json({status:200,data:result});
    } catch(error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe=error instanceof AiError?error:new AiError('财务核查尚未确认，请本地重检',503,'AI_FINANCIAL_FAILED');
      res.status(safe.status).json({status:safe.status,code:safe.code,message:safe.message,
        ...(safe.financialCheck?{financialCheck:safe.financialCheck}:{}),...(safe.requestId?{requestId:safe.requestId}:{})});
    } finally {entry.active=false;}
  };
  router.post('/v3/transaction/preflight',financialHandler('financialPreflight'));
  router.get('/v3/transaction/pending',financialHandler('readPendingTransaction'));
  router.post('/v3/transaction/pending/resume',financialHandler('resumePendingTransaction'));
  router.post('/v3/transaction/draft',financialHandler('createLocalTransactionDraft'));
  router.get('/v3/transaction/candidates/:id',financialHandler('getTransactionCandidate',true));
  router.delete('/v3/transaction/candidates/:id',financialHandler('cancelTransactionCandidate',true));
  // 追加163：DeepSeek 官方账户余额查询（非系统账本余额）
  router.get('/balance', async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [id, entry] of balanceLimits) if (entry.until <= now && !entry.active) balanceLimits.delete(id);
    const entry = balanceLimits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 10 || (!balanceLimits.has(userId) && balanceLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '余额查询过于频繁，请稍后重试' });
    }
    entry.active = true; entry.count++; balanceLimits.set(userId, entry);
    try { res.json({ status: 200, data: await service.getBalance(userId, req.query.connectionId) }); }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('余额查询失败，请稍后重试', 502);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message, ...(safe.requestId ? { requestId: safe.requestId } : {}) });
    } finally { entry.active = false; }
  });
  router.get('/capabilities', (req, res) => res.json({ status: 200, data: service.getCapabilities?.(req.userId) || capabilities(env) }));
  router.get('/settings', (req, res) => res.json({ status: 200, data: service.getSettings(req.userId) }));
  // ===== D-027：数据授权白名单端点（跟账号走，10次/分/人）=====
  const grantLimits = new Map();
  const grantHandler = method => async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [id, entry] of grantLimits) if (entry.until <= now && !entry.active) grantLimits.delete(id);
    const entry = grantLimits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 10 || (!grantLimits.has(userId) && grantLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '授权操作过于频繁，请稍后重试' });
    }
    entry.count++; entry.active = true; grantLimits.set(userId, entry);
    try {
      const result = method === 'get' ? await service.getGrant(userId, req.query?.conversationId)
        : method === 'put' ? await service.putGrant(userId, req.body?.data ?? req.body)
        : await service.deleteGrant(userId, req.query?.conversationId);
      res.json({ status: 200, data: result });
    } catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('授权操作失败，请重试', 500, 'AI_GRANT_FAILED');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message,
        ...(Array.isArray(safe.missingDomains) ? { missingDomains: safe.missingDomains } : {}) });
    } finally { entry.active = false; }
  };
  router.get('/grant', grantHandler('get'));
  router.put('/grant', grantHandler('put'));
  router.delete('/grant', grantHandler('revoke'));
  // ===== 追加164：全链路审计日志查看（本人 scoped，10次/分/人）=====
  const logLimits = new Map();
  router.get('/logs', async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [id, entry] of logLimits) if (entry.until <= now && !entry.active) logLimits.delete(id);
    const entry = logLimits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 10 || (!logLimits.has(userId) && logLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '日志读取过于频繁，请稍后重试' });
    }
    entry.active = true; entry.count++; logLimits.set(userId, entry);
    try { res.json({ status: 200, data: await callLog.list(userId, Number(req.query?.limit) || 100) }); }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('日志读取失败，请稍后重试', 500, 'AI_LOG_READ_FAILED');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  });
  // ===== 追加164：思考能力开关（用户偏好，10次/分/人）=====
  const prefLimits = new Map();
  const prefHandler = method => async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [id, entry] of prefLimits) if (entry.until <= now && !entry.active) prefLimits.delete(id);
    const entry = prefLimits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 10 || (!prefLimits.has(userId) && prefLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '偏好操作过于频繁，请稍后重试' });
    }
    entry.active = true; entry.count++; prefLimits.set(userId, entry);
    try {
      const result = method === 'get' ? service.getPreferences(userId) : await service.setPreference(userId, req.body?.data ?? req.body);
      res.json({ status: 200, data: result });
    } catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('偏好保存失败，请重试', 500, 'AI_PREFERENCE_FAILED');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  };
  router.get('/preferences', prefHandler('get'));
  router.put('/preferences', prefHandler('put'));
  const budgetSettingsHandler = method => async (req, res) => {
    try {
      await service.warmupSettings();
      const data = method === 'get' ? service.getBudgetSettings(req.userId)
        : await service.setBudgetSettings(req.userId, req.body?.data ?? req.body);
      res.json({ status: 200, data });
    } catch (error) {
      reportAiError(error, { phase: 'http', elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('额度与超时设置操作失败，请稍后重试', 503, 'AI_BUDGET_SETTINGS_UNAVAILABLE');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  };
  router.get('/budget-settings', budgetSettingsHandler('get'));
  router.put('/budget-settings', budgetSettingsHandler('put'));
  const settingsHandler = action => async (req, res) => {
    const now = clock();
    for (const [id, entry] of settingsLimits) if (entry.until <= now && !entry.active) settingsLimits.delete(id);
    const entry = settingsLimits.get(req.userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 5 || (!settingsLimits.has(req.userId) && settingsLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '连接设置操作过于频繁，请稍后重试' });
    }
    entry.count++; entry.active = true; settingsLimits.set(req.userId, entry);
    try {
      const data = action === 'put' ? await service.configure(req.userId, req.body?.data ?? req.body)
        : action === 'clear' ? await service.clearSettings(req.userId)
        : action === 'activate' ? await service.activateProvider(req.userId, req.params.connectionId)
        : await service.deleteProvider(req.userId, req.params.connectionId);
      res.json({ status: 200, ismessage: true, data });
    } catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('连接设置失败，请重试', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message,
        ...(safe.financialCheck?{financialCheck:safe.financialCheck}:{}) });
    } finally { entry.active = false; }
  };
  router.put('/settings', settingsHandler('put'));
  router.delete('/settings', settingsHandler('clear'));
  router.post('/settings/:connectionId/activate', settingsHandler('activate'));
  router.delete('/settings/:connectionId', settingsHandler('delete'));
  const chatHandler = method => async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [key, entry] of limits) if (entry.until <= now && !entry.active) limits.delete(key);
    const entry = limits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 6 || (!limits.has(userId) && limits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: 'AI 请求过于频繁，请稍后重试' });
    }
    entry.active = true;
    entry.count++;
    limits.set(userId, entry);
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.on('close', onClose);
    try {
      const result = await service[method](userId, req.body?.data ?? req.body, { signal: disconnected.signal });
      res.json({ status: 200, ismessage: true, message: 'AI 测试完成', data: result });
    } catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('AI 测试失败，请稍后重试', 500, 'AI_INTERNAL_ERROR');
      if (!res.destroyed) res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message,
        traceId: req.aiTraceId, ...(safe.requestId ? { requestId: safe.requestId } : {}) });
    } finally { res.removeListener('close', onClose); entry.active = false; }
  };
  // Chat and OCR share the same per-user rate and concurrency budget.


  router.post('/v3/ocr', chatHandler('runOcr'));
  router.get(['/drafts/:id', '/v3/drafts/:id'], async (req, res) => {
    try { res.json({ status: 200, data: await service.getDraft(req.userId, req.params.id) }); }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('草稿暂时无法读取，请稍后重试', 503, 'AI_DRAFT_READ_FAILED');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  const draftHandler = method => async (req, res) => {
    const now = clock();
    for (const [key, entry] of draftLimits) if (entry.until <= now) draftLimits.delete(key);
    const entry = draftLimits.get(req.userId) || { until: now + 60000, count: 0 };
    if (entry.count >= 30 || (!draftLimits.has(req.userId) && draftLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '草稿操作过于频繁，请稍后重试' });
    }
    entry.count++;
    draftLimits.set(req.userId, entry);
    try {
      const draft = await service[method](req.userId, req.params.id, req.body?.data ?? req.body);
      res.json({ status: 200, ismessage: true, data: draft });
    } catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('草稿操作失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message,
        ...(safe.financialCheck?{financialCheck:safe.financialCheck}:{}) });
    }
  };
  router.put(['/drafts/:id', '/v3/drafts/:id'], draftHandler('editDraft'));
  router.post(['/drafts/:id/action', '/v3/drafts/:id/action'], draftHandler('actOnDraft'));
  // 追加163：入账确认——只收 ID+version（不收业务字段），入账内容全部取自库存档草稿。
  // ===== 追加163 扩展：历史聊天记录 =====
  router.get('/conversations', async (req, res) => {
    try { res.json({ status: 200, data: await service.listConversations(req.userId) }); }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('历史读取失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  router.get('/conversations/:id/messages', async (req, res) => {
    try {
      // 追加166：带 ?since=<消息编号> 时返回增量 { messages, lastId }，供多端同步轮询。
      const since = req.query.since == null || req.query.since === '' ? null : Number(req.query.since);
      if (since != null && (!Number.isInteger(since) || since < 0))
        throw new AiError('增量参数不正确', 400, 'AI_CONVERSATION_SINCE_INVALID');
      res.json({ status: 200, data: since == null
        ? await service.getConversationMessages(req.userId, req.params.id)
        : await service.getConversationMessagesSince(req.userId, req.params.id, since) });
    }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('历史读取失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  const syncSince = req => {
    const since = req.query.since == null ? 0 : Number(req.query.since);
    if (!Number.isSafeInteger(since) || since < 0) throw new AiError('同步游标不正确', 400, 'AI_CONVERSATION_SINCE_INVALID');
    return since;
  };
  router.get('/conversations/:id/sync', async (req, res) => {
    try { res.json({ status: 200, data: await service.getConversationSync(req.userId, req.params.id, syncSince(req)) }); }
    catch (error) { const payload = agentError(req, error); res.status(payload.status).json(payload); }
  });
  router.get('/conversations/:id/events', async (req, res) => {
    let tickTimer, lifetime, heartbeat, closed = false;
    const cleanup = () => { closed = true; clearTimeout(tickTimer); clearTimeout(lifetime); clearInterval(heartbeat); };
    res.on('close', cleanup);
    const send = (event, data) => { if (!closed && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      let since = syncSince(req), state = await service.getConversationSync(req.userId, req.params.id, since);
      if (closed) return;
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      let revision = state.revision;
      send('sync', state); since = state.lastId;
      heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
      lifetime = setTimeout(() => { cleanup(); res.end(); }, syncLifetimeMs);
      const tick = async () => {
        try {
          state = await service.getConversationSync(req.userId, req.params.id, since);
          if (closed) return;
          if (state.messages.length || state.revision !== revision) { send('sync', state); since = state.lastId; revision = state.revision; }
          tickTimer = setTimeout(tick, state.messages.length >= 200 ? 0 : syncIntervalMs);
        } catch (error) {
          if (!closed) {
            send(error.code === 'AI_CONVERSATION_EXPIRED' ? 'deleted' : 'error', { conversationId: req.params.id, code: error.code || 'AI_SYNC_UNAVAILABLE' });
            cleanup(); res.end();
          }
        }
      };
      tickTimer = setTimeout(tick, state.messages.length >= 200 ? 0 : syncIntervalMs);
    } catch (error) {
      if (!closed) { const payload = agentError(req, error); res.status(payload.status).json(payload); }
      cleanup();
    }
  });
  router.delete('/conversations/:id', async (req, res) => {
    try { res.json({ status: 200, data: await service.deleteConversation(req.userId, req.params.id) }); }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('删除失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  // 多供应商：拉取厂商模型列表（Key 只取传入或该账号已保存的接入商，不回退 .env）
  router.post('/models', async (req, res) => {
    const userId = req.userId;
    // Cache hits and coalesced reads do not consume settings mutations or
    // provider refresh quota. The service limits only actual /models fetches.
    try { res.json({ status: 200, data: await service.fetchProviderModels(userId, req.body?.data ?? req.body) }); }
    catch (error) {
      reportAiError(error, { phase: "http", elapsedMs: Date.now() - req.aiStartedAt });
      const safe = error instanceof AiError ? error : new AiError('模型列表获取失败', 502);
      if (Number.isInteger(safe.retryAfterSeconds)) res.set('Retry-After', String(safe.retryAfterSeconds));
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  // Review/cancel only mutate isolated proposals; formal commit requires the reviewed draft ID/version.
  router.post(['/drafts/:id/commit', '/v3/drafts/:id/commit'], draftHandler('commitDraft'));
  return router;
}
module.exports = createAiRouter();
module.exports.createAiRouter = createAiRouter;
