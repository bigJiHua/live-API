const crypto = require('crypto');
const Joi = require('joi');
const db = require('../../../common/config/db');
const { AiError } = require('./errors');
const { validate, todayShanghai } = require('./validation');
const { createBusinessReadRepository } = require('./businessRead');
const { createPreviewStore } = require('./analysisPreviews');
const { createBusinessProposalStore } = require('./businessProposals');
const { createBusinessService } = require('./businessService');
const { assertV3ProposalIntent } = require('./businessIntent');
const { createDataGrantStore } = require('./dataGrant');
const { createCallLogStore } = require('./callLog');
const { createEgressPolicy } = require('./egressPolicy');
const { createResponseValidation } = require('./responseValidation');
// 2026-11-11：v3 provider 切流式客户端（deepseekChatStream 聚合结果与非流式完全一致），
// 正文完整聚合；思考只在事务成功后按同一证据范围核验并发布。
const { deepseekChatStream } = require('./deepseek');
const { logProviderReasoning, logModelValidationFailure, logToolValidationFailure } = require('./diagnostics');
const { validateTool, selectSnapshot, choiceCoverage, requestedCardType } = require('./v3Tools');
const { validateMemoryTool, isMemoryTool } = require('./memoryTools');
const { isMemoryDeleteTool, validateMemoryDeleteTool, validateMemoryDeleteEvidence } = require('./memoryDeleteTools');
const { memoryDeleteFailureNotice } = require('./memoryDeleteClaims');
const { validateHistoryTool, isHistoryTool } = require('./historyTools');
const { validateCalcTool, isCalcTool, evaluateCalc } = require('./calcTools');
const { validateWebSearchTool, createWebSearchTools } = require('./webSearchTools');
const { createWebSearchBudget } = require('./webSearchBudget');
const { scrubWithCitations } = require('./webSearchCitations');
const { verifyChatNumbers } = require('./chatNumericEvidence');
const { assertResultClaims } = require('./v3Claims');
const { reconcileMemoryClaims } = require('./memoryClaims');
const { normalizeSavedStateClaims } = require('./queryCoverageProse');
const { OPEN_DEFINITIONS, CAPABILITY_CATALOG, OPEN_SYSTEM_PROMPT, OPEN_FINALIZE_PROMPT } = require('./openConversation');
const { createMemoryStore } = require('./memoryStore');
const { PERSONALIZATION_PROMPT, buildPersonalizationContext, resolvePersonalizedLanguage } = require('./personalizationContext');
const { memoryReadPage } = require('./memoryTextEvidence');
const { validateMemoryContentEvidence, memoryFailureNotice } = require('./memoryEvidence');
const { createHistoryReader } = require('./historyReader');
const { sanitizeTaskContexts, upsertTaskContext, selectTaskContext, sanitizeQueryCoverage } = require('./contextState');
const { selectBudgetedHistory, buildContextSummary, redactContextData, historyTokenBudget } = require('./modelContext');
const { validateOutput, OUTPUT_JSON_SCHEMA, parseSingleJsonObject } = require('./v3Schema');
const { SYSTEM_PROMPT, FINALIZE_PROMPT, PROMPT_VERSION, PROMPT_DIGEST, WEB_SEARCH_PROMPT } = require('./v3Prompt');
const { recoverMissingAmountEvidence, validateAmountEvidence, validateDateEvidence } = require('./v3Evidence');
const { buildQueryContext, resolveQueryArgs, finalizeQueryContext, bindQuerySubject, explicitPeriod, stripQueryPresentationText } = require('./queryContext');
const { SORTS } = require('./queryMetadata');
const { getDatasetCapability } = require('./datasetCapabilities');
const { queryEffectiveArgs } = require('./queryEffectiveArgs');
const { fitQueryWindow, resumePageInput } = require('./queryWindow');
const { createReasoningLifecycle } = require('./thinkingLifecycle');
const { createLiveReasoning } = require('./liveReasoning');
const { toolRegistry, validateAuthorization } = require('./toolRegistry');
const { resolveResponseLanguage, languageInstruction, responseLanguageMismatch } = require('./responseLanguage');
const { explicitMemorySearchGoal, memorySearchCompletion } = require('./memorySearchCompletion');
const { requiresAssetCompositionDataset } = require('./assetCompositionIntent');
const { markToolParameterError, isToolParameterError, hasInvalidUserDates, toolErrorFeedback } = require('./toolRecovery');
const { digestInput } = require('./requestGuard');
const { buildQueryTaskBindings, selectQueryTaskBinding } = require('./queryTaskBindings');
const { readerSortIssue, targetDatasetIssue, pinDatasetSort, filterBasisIssue } = require('./queryDatasetIntent');
const { pinCardBillChartAxis } = require('./queryCardBillChartIntent');
const { queryGoals, missingFreshGoals, explicitQueriesComplete, freshQueryFeedback, effectiveGoalScope, knownMonthlyFinanceChart } = require('./queryEvidenceGate');
const { futureFinanceQueryNotice } = require('./futureFinanceQueryNotice');
const { knownAssetCompositionPie, clearCompletedAssetPieRetry } = require('./queryAssetCompositionChartIntent');
const { extractExplicitQueryConstraints, pinExplicitQueryConstraints } = require('./explicitQueryConstraints');
const { buildTaskContext, finalizeTaskContext } = require('./taskContext');
const { selectHistoryTurns, buildHistoryContext, historySinceTopicBoundary } = require('./historyContext');
const { classifyCurrentTurn } = require('./currentTurnIntent');
const { enrichAnalysisDatasets } = require('./analysisFacts');
const { loadDraftContext } = require('./draftContext');
const { asksConversationArtifactState, loadConversationArtifactState } = require('./conversationArtifacts');
const { explicitUniqueAccountSelection, accountSelectionUtterances, isRejectedAccountSelection } = require('./candidateSelection');
const { uniqueBusinessTarget } = require('./businessTargetSelection');
const { buildPendingTransactionContext, sanitizePendingTransactionContext, clearPendingTransactionContext,
  carryPendingTransactionSources, pinPendingTransactionSupplement, isExplicitSelectedAccount, pendingBatchCoverage, isPendingTransactionCancellation } = require('./pendingTransactions');

const isContextMemoryTool = name => isMemoryTool(name) || isMemoryDeleteTool(name);
const isMemoryMutation = name => ['memory_write', 'memory_delete'].includes(name);
const definitions = toolRegistry.definitions();

const MAX_PROVIDER_CALLS = 5, MAX_TOOLS = 8, MAX_TOOL_BYTES = 16 * 1024, MAX_DISCLOSURE_BYTES = 64 * 1024;
const { turnTimeoutMs } = require('./config');
const MAX_USAGE_TOKENS = 30000;
const SPECIAL_ACCOUNTING = /转账|还款|退款|冲正|分期|购汇|结汇|提现|初始化|余额调整|证券买卖|\b(?:transfer|repayment|refund|reversal|installment|withdrawal)\b/i;
const requestSchema = Joi.object({ requestId: Joi.string().guid({ version: 'uuidv4' }).required(),
  message: Joi.string().trim().min(1).max(1500).required(), conversationId: Joi.string().guid({ version: 'uuidv4' }),
  retryOf: Joi.string().guid({ version: 'uuidv4' }),
  mode: Joi.string().valid('chat', 'analysis', 'operate'),
  consent: Joi.boolean().valid(true).required() }).with('retryOf', 'conversationId').unknown(false);
const KIND_DOMAIN = { transaction: 'finance', budget: 'budget', todo: 'todo', card: 'card', fixedAsset: 'fixedAsset', fund: 'fund' };
const fingerprint = config => crypto.createHash('sha256').update(JSON.stringify([config.baseUrl, config.model, config.apiKey])).digest('hex');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONTRACT_DIGEST = hash({ definitions, output: OUTPUT_JSON_SCHEMA, queryMetadataVersion: 1, sorts: SORTS });
// 追加168：答复呈现/校验纯函数群移至 ./v3AnswerPresentation（纯移动，零逻辑变化）。
const { buildFinalizationMessages, validateChart, buildQueryAnswer, withScopePolicy, redactSelectedText } = require('./v3AnswerPresentation');
const { assembleTurnResult } = require('./v3ResultAssembly');
const { createReasoningRound, verifiedReasoningEvents } = require('./verifiedReasoning');

// The model may choose which columns to chart, but never the title or the
// figures in the answer. Both are rebuilt from the approved server dataset.
// A chart request is a server-side fact derived from the user's own utterance,
// not from the model's JSON. When the model correctly returns chart:null for a
// zero-row request, the explanation must still come from the server.
const CHART_INTENT = /图表|走势|趋势|曲线|折线|柱状|饼图|画[个张幅]?图|chart/i;
const AUXILIARY_WAIT_MS = 1000;
// Preparing a sync activity precedes guard admission. It still shares the turn
// budget and disconnect signal, and late completion never starts provider work.
function prepareWithinDeadline(work, { signal, timeoutMs, requestId, onLate }) {
  const controller = new AbortController();
  const failure = (message, status, code) => Object.assign(new AiError(message, status, code), { requestId, providerCalls: 0,
    ...(['AI_PREPARATION_TIMEOUT', 'AI_PREPARATION_CANCELLED'].includes(code) ? { notAdmitted: true } : {}) });
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
    return Promise.reject(failure('AI 请求中止信号无效', 400, 'AI_REQUEST_INVALID'));
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = () => { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const stop = error => { if (settled) return; controller.abort(error); finish(); reject(error); };
    const onAbort = () => stop(failure('本次连接已关闭，已取消准备；没有调用 AI，可重新发送', 499, 'AI_PREPARATION_CANCELLED'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop(failure('本轮准备已超时，没有调用 AI，请稍后重试', 504, 'AI_PREPARATION_TIMEOUT')), timeoutMs);
    timer.unref?.();
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return work(controller.signal);
    }).then(value => {
      if (settled) { try { onLate?.(value, controller.signal.reason); } catch (_) {} return; }
      finish(); resolve(value);
    }, error => { if (!settled) { finish(); reject(error); } });
  });
}
// Auxiliary writes retain their original promise, but a stalled SQL statement
// cannot hold delivery of an already durable terminal receipt indefinitely.
function settleAuxiliary(work, signal) {
  const pending = Promise.resolve(work).catch(() => {});
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let timer, settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    signal?.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, AUXILIARY_WAIT_MS); timer.unref?.();
    pending.then(finish);
  });
}
function createV3Service({ legacyService, businessService, executor = db, repository,
  previews = createPreviewStore({ executor }), proposals = createBusinessProposalStore({ executor }),
  provider = deepseekChatStream, grants = createDataGrantStore({ executor }), callLog = createCallLogStore({ executor }),
  now = () => new Date(), memoryStore = createMemoryStore({ now }), historyReader = createHistoryReader({ executor }),
  personalizationStore = null, profileGeneration = null, memoryDeletion = null,
  webSearchTools = createWebSearchTools({ now }), searchBudget = createWebSearchBudget({ executor, now: () => now().getTime() }) } = {}) {
  if (!legacyService?.getRuntime) throw new Error('V3 requires the shared financial runtime');
  const shared = businessService || createBusinessService({ legacyService, executor, previews, proposals, grants, callLog, now });
  let liveRepository;
  const host = config => new URL(config.baseUrl).host;
  const runtime = userId => {
    const state = legacyService.getRuntime(userId);
    if (state.config.mode !== 'deepseek' || state.config.dataSource !== 'user-readonly' || state.businessPolicy?.enabled === false) throw new AiError('AI 助手需要真实模型和独立只读连接', 503, 'AI_BUSINESS_DISABLED');
    return state;
  };
  const record = entry => { try { callLog.record(entry); } catch (_) { /* Audit cannot disclose secrets via fallback logging. */ } };
  async function chat(userId, input, emit, options = {}) {
    legacyService.assertGenerationAllowed?.(userId);
    const request = validate(requestSchema, input), initial = runtime(userId);
    const privateSecrets = [initial.config.apiKey, ...(initial.config.searchApiKey ? [initial.config.searchApiKey] : [])];
    // Presentation belongs to request arrival, not to when its terminal
    // history write eventually finishes after later turns have succeeded.
    const sentAt = new Date(now()).getTime();
    const currentTurnIntent = classifyCurrentTurn(request.message);
    const businessMessage = currentTurnIntent.businessMessage;
    const topicBoundary = currentTurnIntent.topicReset
      ? { version: 1, kind: 'explicit-reset', turnId: request.requestId } : null;
    const syncStore = initial.conversationSyncStore;
    const turnLimit = initial.turnTimeoutMs ?? turnTimeoutMs(), preparationStarted = Date.now();
    let activity = null, activityWrites = Promise.resolve(), activityRunning = false, activityTerminal = false;
    const queueActivity = (status, stage) => {
      activityWrites = activityWrites.then(() => {
        if (!activityTerminal) return settleAuxiliary(Promise.resolve().then(() => syncStore.update(activity, status, stage)), options.signal);
      }).catch(() => {});
    };
    const terminalActivity = (status, failure) => {
      activityTerminal = true;
      if (!activity) return Promise.resolve();
      // Independent of the progress queue. The store's token and terminal CAS
      // keep late progress writes from overwriting this terminal status.
      return Promise.resolve().then(() => syncStore.update(activity, status, status, failure)).catch(() => {});
    };
    if (syncStore) {
      // Open SSE headers/heartbeats before potentially slow SQL preparation.
      if (typeof emit === 'function') emit('status', { stage: 'queued' });
      const prepared = await prepareWithinDeadline(async signal => {
        const syncConversation = request.conversationId || (await initial.conversationStore.session(userId, 'default')).id;
        if (signal.aborted) throw signal.reason;
        const handle = await syncStore.begin(userId, syncConversation, request.requestId, request.message,
          turnLimit + (legacyService.getCapabilities?.(userId)?.requestPolicy?.queueWaitMs || 0), { signal });
        return { syncConversation, handle };
      }, { signal: options.signal, timeoutMs: turnLimit, requestId: request.requestId,
        onLate: ({ handle }, error) => { void settleAuxiliary(Promise.resolve().then(() => syncStore.update(handle, 'failed', 'failed',
          { code: error.code, message: error.message }))); } });
      const { syncConversation, handle } = prepared;
      activity = handle;
      // Resolve the default conversation once, including requests crossing midnight.
      request.conversationId = syncConversation;
      const forward = emit;
      emit = (event, data) => {
        if (event === 'status' && typeof data?.stage === 'string') {
          const status = activityRunning ? 'running' : 'queued';
          queueActivity(status, data.stage);
        }
        if (typeof forward === 'function') forward(event, data);
      };
    }
    const openMode = Boolean(request.mode), relaxedMode = openMode && request.mode !== 'operate';
    // §3b：联网在闲聊与分析模式均可用（搜新闻正是分析场景）；业务链与操作模式不联网。
    const searchEnabled = ['chat', 'analysis'].includes(request.mode) && initial.config.searchEnabled === true;
    const systemPrompt = (relaxedMode ? OPEN_SYSTEM_PROMPT : SYSTEM_PROMPT + (openMode
      ? '\n本轮为操作模式。所有业务能力均在能力目录中；未授权时先调用request_authorization请求会话或限时授权。操作授权只允许准备待确认草稿和保存用户要求的记忆，不能直接执行入库。' : '')) + (openMode
      ? '\n草稿或提案的保存数量和当前状态以TASK_INPUT.actualArtifacts的本会话存档统计为准，包含记账草稿及日记等业务提案。actualDrafts只是近期交易草稿窗口，空列表或未提供统计不表示没有创建过。过期表示曾生成但目前不能提交，不得说成当时只有说明文字或从未保存。' : '') + (searchEnabled ? WEB_SEARCH_PROMPT : '');
    const promptVersion = openMode ? relaxedMode ? 'life-assistant-open-v1' : PROMPT_VERSION + '-auth-v1' : PROMPT_VERSION;
    const personalSystemPrompt = personalizationStore ? systemPrompt + '\n' + PERSONALIZATION_PROMPT : systemPrompt;
    const promptDigest = personalizationStore || openMode
      ? hash({ systemPrompt: personalSystemPrompt, final: relaxedMode ? OPEN_FINALIZE_PROMPT : FINALIZE_PROMPT }) : PROMPT_DIGEST;
    const openDefinitions = searchEnabled ? toolRegistry.definitions({ open: true, searchEnabled: true }) : OPEN_DEFINITIONS;
    const contractDigest = openMode ? hash({ definitions: openDefinitions, catalog: CAPABILITY_CATALOG, mode: request.mode }) : CONTRACT_DIGEST;
    const initialFingerprint = fingerprint(initial.config), initialConnection = initial.connectionId;
    let conversationRef = null, queryContext = null, taskContext = null, retryClaimed = false;
    let storedTaskContexts = sanitizeTaskContexts(null), storedCoverage = sanitizeQueryCoverage(null), contextSummary = null;
    let lastModelContent = null, lastProviderRound = null, validationStage = 'provider-envelope', validationLogged = false;
    const memoryReceipts = [], memoryReadReceipts = [], memorySearchReceipts = [];
    const reasoningRounds = [];
    let liveReasoningChars = 0;
    const responseValidation = createResponseValidation(request.mode);
    let finalResponseValidation = null, finalMemoryClaims = null, finalReasoningScrub = null;
    const run = initial.requestGuard.run(userId, { requestId: request.requestId, lane: 'v3-chat', input: request,
      maxProviderCalls: MAX_PROVIDER_CALLS, timeoutMs: Math.max(1, turnLimit - (Date.now() - preparationStarted)), dailyProviderLimit: initial.config.dailyProviderLimit, signal: options.signal,
      onWait: data => { if (typeof emit === 'function') emit('status', data); },
      failureNotice: () => [memoryFailureNotice(memoryReceipts), memoryDeleteFailureNotice(memoryReceipts)].filter(Boolean).join('\n') }, async budget => {
      if (activity) { activityRunning = true; queueActivity('running', 'thinking'); }
      const conversation = request.conversationId ? await initial.conversationStore.open(userId, request.conversationId, { historyLimit: 12 })
        : await initial.conversationStore.open(userId, (await initial.conversationStore.session(userId, 'default')).id, { historyLimit: 12 });
      budget.check();
      if (request.retryOf) {
        if (typeof initial.conversationStore.claimRetry !== 'function')
          throw new AiError('重试关系暂时无法确认，请重新打开聊天', 503, 'AI_RETRY_UNAVAILABLE');
        await initial.conversationStore.claimRetry(userId, conversation.id, {
          retryOf: request.retryOf, requestId: request.requestId, message: request.message,
        });
        retryClaimed = true;
      }
      conversationRef = conversation;
      budget.check();
      const egress = createEgressPolicy({ userId, knownIds: [conversation.id, conversation.latestDraftId],
        extraSecrets: privateSecrets });
      const scrubConversationText = text => openMode ? egress.scrubText(text) : egress.scrub(text);
      const history = currentTurnIntent.topicReset ? [] : historySinceTopicBoundary(conversation.history || []);
      // Legacy resets have no persisted SQL cutoff. Rebuild only from the
      // bounded history instead of allowing separate loaders to resurrect it.
      const legacyTopicBoundary = !conversation.topicBoundary && history[0]?.role === 'user'
        && classifyCurrentTurn(history[0].content).topicReset;
      const loadStoredContext = !currentTurnIntent.topicReset && !legacyTopicBoundary;
      let storedQueryContext = currentTurnIntent.topicReset ? null : loadStoredContext && typeof initial.conversationStore.loadQueryContext === 'function'
        ? await initial.conversationStore.loadQueryContext(userId, conversation.id)
        : history.findLast(item => item.queryContext)?.queryContext || null;
      if (!storedQueryContext) for (const turn of history.filter(item => item.role === 'user')) {
        storedQueryContext = buildQueryContext({ message: turn.content, today: turn.sourceDate || todayShanghai(now()), previous: storedQueryContext }) || storedQueryContext;
      }
      queryContext = buildQueryContext({ message: businessMessage, today: todayShanghai(now()), previous: storedQueryContext });
      // §10：历史预算按当前模型解析（ai_config/history_tokens > env > contextWindow/3 > 3500）。
      const historySelection = selectBudgetedHistory(history, { budget: historyTokenBudget(initial.config) });
      const priorUserTurns = historySelection.turns;
      contextSummary = currentTurnIntent.topicReset ? null : buildContextSummary(loadStoredContext && typeof initial.conversationStore.loadContextSummary === 'function'
        ? await initial.conversationStore.loadContextSummary(userId, conversation.id)
        : history.findLast(item => item.contextSummary)?.contextSummary, historySelection.omitted, text => egress.scrub(text));
      const storedPendingTransactions = currentTurnIntent.topicReset ? null : loadStoredContext && typeof initial.conversationStore.loadPendingTransactionContext === 'function'
        ? await initial.conversationStore.loadPendingTransactionContext(userId, conversation.id)
        : history.findLast(item => item.pendingTransactions || item.business?.pendingTransactions)?.pendingTransactions
          || history.findLast(item => item.business?.pendingTransactions)?.business.pendingTransactions || null;
      const pendingContext = relaxedMode ? null : sanitizePendingTransactionContext(storedPendingTransactions, { conversationId: conversation.id, now });
      const { userTurns, userTurnDates, userTurnIds, pendingTransactions } = carryPendingTransactionSources({
        userTurns: [...priorUserTurns.map(item => item.user), request.message],
        userTurnDates: [...priorUserTurns.map(item => item.sourceDate || null), todayShanghai(now())],
        userTurnIds: [...priorUserTurns.map(item => item.turnId || null), request.requestId],
        chronologicalSources: [...selectHistoryTurns(history, { limit: 16 }).map(item => ({ text: item.user,
          sourceDate: item.sourceDate || null, turnId: item.turnId || null })),
        { text: request.message, sourceDate: todayShanghai(now()), turnId: request.requestId }],
        context: pendingContext, conversationId: conversation.id, now });
      // priorAnswers：最近三轮 assistant 上屏正文（落库前已过清洗/对账/claims 校验），
      // 供模型做指代消解（如「花的最多的地方」→ 上一轮谈的月份/主体）。失败占位轮次
      // 无衔接价值不纳入；截掉落库时拼接的 evidence 后缀（以「\n[」开头）与超长尾部。
      const historyContext = buildHistoryContext({ history, userTurns, userTurnDates, userTurnIds, scrub: scrubConversationText });
      let storedTaskContext = currentTurnIntent.topicReset ? null : loadStoredContext && typeof initial.conversationStore.loadTaskContext === 'function'
        ? await initial.conversationStore.loadTaskContext(userId, conversation.id) : history.findLast(item => item.taskContext)?.taskContext || null;
      // Conversations predating structured task memory still carry user intent.
      if (!storedTaskContext) for (const turn of priorUserTurns) storedTaskContext = buildTaskContext({
        message: turn.user, today: turn.sourceDate || todayShanghai(now()), previous: storedTaskContext }) || storedTaskContext;
      storedTaskContexts = sanitizeTaskContexts(currentTurnIntent.topicReset ? null : loadStoredContext && typeof initial.conversationStore.loadTaskContexts === 'function'
        ? await initial.conversationStore.loadTaskContexts(userId, conversation.id)
        : history.findLast(item => item.taskContexts)?.taskContexts || [storedTaskContext]);
      storedCoverage = sanitizeQueryCoverage(currentTurnIntent.topicReset ? null : loadStoredContext && typeof initial.conversationStore.loadQueryCoverage === 'function'
        ? await initial.conversationStore.loadQueryCoverage(userId, conversation.id)
        : history.findLast(item => item.queryCoverage)?.queryCoverage || storedQueryContext?.lastResults);
      storedTaskContext = currentTurnIntent.businessSuppressed ? null
        : selectTaskContext(storedTaskContexts, { message: businessMessage, previous: storedTaskContext });
      if (storedTaskContext?.subject === 'cards' && storedTaskContext.metric === 'card-consumption' && !storedTaskContext.scope) {
        const priorCardQuery = storedCoverage.results.findLast(result => result.datasetId === 'card-monthlyConsumption'
          && (!storedTaskContext.cardTypes.length || storedTaskContext.cardTypes.every(type => result.filters.cardTypes?.includes(type))));
        if (priorCardQuery) storedTaskContext = { ...storedTaskContext, scope: priorCardQuery.effectiveScope };
      }
      taskContext = buildTaskContext({ message: request.message, today: todayShanghai(now()), previous: storedTaskContext,
        pendingContext, queryContext });
      const queryTaskBindings = relaxedMode ? [] : buildQueryTaskBindings({ message: businessMessage, today: todayShanghai(now()), tasks: storedTaskContexts });
      const currentBindings = queryTaskBindings.filter(binding => binding.taskContext.subject === taskContext?.subject);
      if (currentBindings.length === 1) taskContext = currentBindings[0].taskContext;
      const financeBindings = queryTaskBindings.filter(binding => binding.taskContext.subject === 'finance');
      if (financeBindings.length === 1) queryContext = financeBindings[0].queryContext;
      // The scalar query cursor belongs to finance. A named non-finance
      // subtask carries its own task scope and coverage, and must not persist
      // its dates or inherited finance metric into that separate cursor.
      if (taskContext?.mode === 'query' && taskContext.subject !== 'finance' && taskContext.targetDatasetId
        && queryTaskBindings.length <= 1 && !financeBindings.length) queryContext = null;
      const asksDraftStatus = /(?:草稿|这笔|刚才|之前|上一笔).*(?:入账|记好|状态|确认|核对)|(?:入账|记好).*(?:了吗|没有|没|是否)/.test(request.message);
      const draftStateNeeded = conversation.latestDraftId && (asksDraftStatus || /核对|修改|草稿/.test(request.message)
        || ['record', 'pending-supplement'].includes(taskContext?.mode));
      const conversationArtifactStateNeeded = openMode && asksConversationArtifactState(request.message);
      const draftStateAllowed = !openMode && draftStateNeeded && initial.businessPolicy?.domains.includes('finance');
      if (draftStateAllowed || conversationArtifactStateNeeded) {
        await grants.requireCoverage(userId, openMode ? [] : ['finance'], host(initial.config), openMode
          ? { conversationId: conversation.id, access: 'read', reason: '核对这段聊天实际生成的草稿和提案状态' } : {});
        budget.check();
      }
      let actualArtifacts = conversationArtifactStateNeeded
        ? await loadConversationArtifactState({ executor, userId, conversationId: conversation.id, now }) : null;
      const actualDrafts = draftStateAllowed
        ? await loadDraftContext({ legacyService, userId, conversation, history, scrub: text => egress.scrub(text) })
        : actualArtifacts ? actualArtifacts.groups.filter(group => group.type === 'draft')
          .map(group => ({ status: group.status, sourceText: null, count: group.count })) : [];
      budget.check();
      let memoryIndex;
      const personalState = personalizationStore ? await personalizationStore.get(userId) : null;
      const personalContext = personalState ? buildPersonalizationContext(personalState, text => egress.scrub(text)) : null;
      const existingPersonalGrant = openMode && personalState && typeof grants.get === 'function'
        ? await grants.get(userId, conversation.id) : null;
      const mayUsePrivatePersonalization = !openMode || existingPersonalGrant?.granted === true
        && existingPersonalGrant.providerHost === host(initial.config);
      // Explicit response rules do not change the existing business authorization flow.
      if (personalContext && !mayUsePrivatePersonalization) { personalContext.profile = []; personalContext.profileEnabled = false; }
      const personalInformationUsed = personalContext?.profile.length > 0;
      const memorySecrets = [initial.config.apiKey, userId, conversation.id, conversation.latestDraftId]
        .filter(value => typeof value === 'string' && value.length >= 4);
      const safeMemoryPath = path => typeof path === 'string' && !memorySecrets.some(secret => path.includes(secret));
      const memoryMetadata = item => ({ path: item.path, title: egress.scrub(item.title), type: item.type,
        created: item.created, updated: item.updated, revision: item.revision, bytes: item.bytes });
      try {
        // Keep the existing session authorization behavior for private memory indexes.
        const mayLoadIndex = !openMode || personalState && mayUsePrivatePersonalization;
        const index = mayLoadIndex ? await memoryStore.list(userId) : { files: [], warnings: [] };
        const visible = index.files.filter(item => safeMemoryPath(item.path));
        memoryIndex = { files: visible.slice(0, 20).map(item => {
          const { created, revision, ...entry } = memoryMetadata(item); return entry;
        }), count: visible.length, truncated: index.truncated === true || visible.length > 20,
        warnings: redactContextData(index.warnings?.slice(0, 3) || [], text => egress.scrub(text)), untrusted: true };
      } catch (_) { memoryIndex = { files: [], count: null, unavailable: true, untrusted: true }; }
      budget.check();
      const responseLanguage = resolvePersonalizedLanguage(request.message, personalState, resolveResponseLanguage(request.message));
      const activeGrant = openMode && typeof grants.get === 'function' ? await grants.get(userId, conversation.id) : null;
      const messages = [{ role: 'system', content: personalSystemPrompt }, { role: 'user', content: `TASK_INPUT:\n${JSON.stringify({
        ...(openMode ? { mode: request.mode, capabilityCatalog: CAPABILITY_CATALOG,
          responsePolicy: { routing: 'choose-tools-from-scene-and-request', validation: 'server-observed-tools-and-artifacts',
            plainText: 'preserve-markdown', dataAccess: 'requires-authorization' },
          authorization: { granted: activeGrant?.granted === true && activeGrant.providerHost === host(initial.config),
            access: activeGrant?.access || null, lifetime: activeGrant?.lifetime || null, expiresAt: activeGrant?.expiresAt ?? null } } : {}),
        today: todayShanghai(now()), businessTimeZone: 'Asia/Shanghai', timestampTimeZone: 'UTC', responseLanguage, userTurns: userTurns.map(scrubConversationText),
        priorAnswers: historyContext.priorAnswers, userTurnDates, currentTurn: userTurns.length - 1,
        actualDrafts, hasPriorDraft: actualArtifacts ? actualArtifacts.awaitingConfirmationCount > 0
          : actualDrafts.some(draft => ['pending', 'reviewed'].includes(draft.status)),
        ...(actualArtifacts ? { actualArtifacts } : {}),
        taskContext: redactContextData(taskContext, text => egress.scrub(text)),
        currentTasks: queryTaskBindings.map(binding => redactContextData(binding.taskContext, text => egress.scrub(text))),
        taskContexts: redactContextData(currentTurnIntent.businessSuppressed ? sanitizeTaskContexts(null) : storedTaskContexts, text => egress.scrub(text)),
        currentTurnIntent: redactContextData(currentTurnIntent, text => egress.scrub(text)),
        pendingTransactions: redactContextData(pendingTransactions, text => egress.scrub(text)),
        contextSummary, memoryIndex, ...(personalContext ? { personalization: personalContext } : {}),
        historyBudget: { budget: historySelection.budget, estimatedTokens: historySelection.estimatedTokens,
          omittedTurns: historySelection.omitted.length, truncated: historySelection.truncated },
        turns: historyContext.turns.map(({ turnId, ...turn }) => turn),
        activeQuery: queryContext?.activeQuery ? { ...queryContext.activeQuery, category: queryContext.activeQuery.category ? egress.scrub(queryContext.activeQuery.category) : null } : null,
        previousQueryCoverage: redactContextData(storedCoverage.results, text => egress.scrub(text)),
        previousFailures: historyContext.previousFailures,
        availableDomains: initial.businessPolicy?.domains || [], availableActions: initial.businessPolicy?.actions || [],
      })}` }];
      // seen：同一参数只真正查询一次；模型重复调用时回放已取结果，不再额外读库或中断整轮。
      const disclosed = new Set(draftStateAllowed ? ['finance'] : []), snapshots = [], datasets = new Map(), toolTrace = [], seen = new Map(), requiredActions = new Set();
      const historyRefs = new Map(), queryInputs = new Map(), memoryErrors = [], memorySearchEvidence = [], calculations = [], scenarioContexts = [];
      let contextDisclosed = openMode && Boolean(draftStateAllowed || actualArtifacts || personalInformationUsed);
      let operationRequired = false;
      let memoryEpoch = 0;
      let toolAttempts = 0, toolRecoveryUsed = false, numericRecoveryUsed = false;
      const failedTools = new Map();
      let disclosureBytes = 0, totalTokens = 0, usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, output, finalizing = false;
      const status = data => { if (typeof emit === 'function') emit('status', data); };
      async function authorize(domains = [...disclosed], connection, access = 'read', reason) {
        access = operationRequired ? 'operate' : access;
        budget.check();
        const current = runtime(userId);
        if (current.connectionId !== initialConnection || fingerprint(current.config) !== initialFingerprint) throw new AiError('AI 连接已变化，本轮已停止，请重新发送', 409, 'AI_CONNECTION_EXPIRED');
        if (domains.some(domain => !current.businessPolicy?.domains.includes(domain))) throw new AiError('请求能力尚未开放', 403, 'AI_SCOPE_DENIED');
        if ([...requiredActions].some(action => !current.businessPolicy?.actions.includes(action))) throw new AiError('本次提案能力已关闭，未保存结果', 403, 'AI_ACTION_NOT_ALLOWED');
        try {
          await grants.requireCoverage(userId, domains, host(current.config), {
            ...(connection ? { executor: connection, lock: true } : {}),
            ...(openMode && (domains.length || contextDisclosed || access === 'operate')
              ? { conversationId: conversation.id, access, ...(reason ? { reason: egress.scrub(reason).slice(0, 200) } : {}) } : {}),
          });
          if (openMode && access === 'operate' && request.mode !== 'operate') {
            const error = new AiError('需要切换操作模式后才能准备草稿或保存记忆', 403, 'AI_GRANT_REQUIRED');
            error.authorizationRequest = { version: 1, conversationId: conversation.id, providerHost: host(current.config),
              access: 'operate', reason: egress.scrub(reason || '准备待确认的操作草稿或保存记忆').slice(0, 200),
              expiresAt: new Date(now()).getTime() + 600000 };
            throw error;
          }
          if (openMode && access === 'operate') operationRequired = true;
        }
        catch (error) {
          record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'gate',
            providerHost: host(current.config), model: current.config.model, status: 'error', errorCode: error.code,
            request: { domains }, response: { missingDomains: error.missingDomains || [], message: error.message } });
          throw error;
        }
        budget.check();
      }
      const currentQueryGoals = queryGoals({ bindings: queryTaskBindings, taskContext, queryContext, message: businessMessage,
        previousTasks: storedTaskContexts, previousTask: storedTaskContext, coverage: storedCoverage });
      const memorySearchContext = { message: request.message, taskContext, currentQueryGoals,
        hasBusinessTask: queryTaskBindings.length > 0 };
      const memorySearchGoal = explicitMemorySearchGoal(memorySearchContext);
      let requireQueryTool = false, freshQueryRecoveryUsed = false, languageRecoveryUsed = false, memoryTaskRecoveryUsed = false, failedMemoryTool = false;
      const missingQueryEvidence = () => relaxedMode ? [] : missingFreshGoals(currentQueryGoals, [...datasets.values()], queryInputs, todayShanghai(now()));
      const memoryTaskAttempted = () => !currentTurnIntent.memoryOperation || failedMemoryTool || toolTrace.some(item =>
        ({ write: ['memory_write'], delete: ['memory_delete', 'memory_write'], read: ['memory_read'], search: ['memory_search'], list: ['memory_list'] })[currentTurnIntent.memoryOperation]?.includes(item.tool));
      const targetedQueriesComplete = () => memoryTaskAttempted() && explicitQueriesComplete({ goals: currentQueryGoals, bindings: queryTaskBindings, taskContext,
        message: businessMessage, datasets: [...datasets.values()], queryInputs, today: todayShanghai(now()) });
      const dispatchTool = toolRegistry.dispatcher({ business: runBusinessTool, context: runContextTool,
        calculate: runCalcTool, search: runSearchTool, authorization: runAuthorizationTool }, { open: openMode, searchEnabled });
      async function runTool(call) {
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 128 ||
          !call.function || typeof call.function.arguments !== 'string' || call.function.arguments.length > (isContextMemoryTool(call.function.name) ? 18000 : 4000)) throw new AiError('模型工具调用格式无效', 502, 'AI_INVALID_RESULT');
        // Latch attempts before authorization/SQL, including rejected or failed
        // tools. A later model answer cannot turn evidence checks back off.
        responseValidation.recordTool(call.function.name);
        const registeredTool = toolRegistry.resolve(call.function.name, { open: openMode, searchEnabled });
        if (numericRecoveryUsed && !isCalcTool(call.function.name))
          throw new AiError('数字核验纠正只允许确定性计算', 403, 'AI_TOOL_DENIED');
        let inputArgs;
        try { inputArgs = JSON.parse(call.function.arguments); } catch (_) {
          if (['calculate', 'search', 'context'].includes(registeredTool.family)) return dispatchTool(call.function.name, null, call);
          const error = new AiError('模型工具参数不是有效JSON', 502, 'AI_TOOL_ARGUMENT_INVALID');
          logToolValidationFailure(error, { requestId: request.requestId, conversationId: conversation.id, model: initial.config.model,
            round: lastProviderRound, tool: call.function.name, content: call.function.arguments }, privateSecrets);
          validationLogged = true;
          throw markToolParameterError(error, [{ path: '$', rule: 'json.invalid' }]);
        }
        return dispatchTool(call.function.name, inputArgs, call);
      }
      async function runAuthorizationTool(name, inputArgs) {
        validateAuthorization(name, inputArgs);
        if (toolAttempts >= MAX_TOOLS) throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
        toolAttempts++; budget.tool?.(name, inputArgs);
        contextDisclosed = true;
        await authorize([], null, inputArgs.access, inputArgs.reason);
        return { authorized: true, access: inputArgs.access, lifetime: '由当前会话授权有效期决定' };
      }
      async function runBusinessTool(name, inputArgs, call) {
        if (currentTurnIntent.businessSuppressed && ['query_data', 'list_choices'].includes(call.function.name)) {
          throw new AiError('本轮只要求记忆处理或能力说明，没有要求重新读取业务数据', 403, 'AI_TOOL_DENIED');
        }
        const binding = call.function.name === 'query_data' ? selectQueryTaskBinding(queryTaskBindings, inputArgs?.datasetId) : null;
        const ownTask = relaxedMode ? null : queryTaskBindings.length ? binding?.taskContext : taskContext;
        const ownMessage = binding?.text || businessMessage;
        const ownQuery = relaxedMode ? null : queryTaskBindings.length ? binding?.queryContext : queryContext;
        const explicitQueryConstraints = !relaxedMode && call.function.name === 'query_data' ? extractExplicitQueryConstraints(ownMessage) : null;
        let queryInput = inputArgs;
        const queryDomain = getDatasetCapability(inputArgs?.datasetId)?.domain;
        if (call.function.name === 'query_data' && ownTask?.mode === 'query' && ownTask.scope
          && !['finance', 'card'].includes(queryDomain) && getDatasetCapability(inputArgs?.datasetId)?.datePolicy.semantics !== 'saved-state'
          && queryDomain === ownTask.subject && !ownTask.comparisonScopes?.length
          && ['startDate', 'endDate'].every(key => inputArgs[key] === undefined || typeof inputArgs[key] === 'string'
            && /^20\d{2}-\d{2}-\d{2}$/.test(inputArgs[key]) && Number.isFinite(Date.parse(inputArgs[key] + 'T00:00:00Z'))
            && new Date(inputArgs[key] + 'T00:00:00Z').toISOString().slice(0, 10) === inputArgs[key])) {
          queryInput = { ...inputArgs, ...ownTask.scope };
        }
        if (call.function.name === 'query_data' && ownTask?.mode === 'query' && ownTask.subject === 'cards') {
          queryInput = { ...inputArgs };
          if (ownTask.metric === 'card-count' && ['card-cards', 'card-counts', 'card-monthlyConsumption'].includes(inputArgs?.datasetId)) {
            queryInput.datasetId = 'card-counts';
            queryInput.filter = typeof inputArgs.filter === 'string' && ownMessage.includes(inputArgs.filter) ? inputArgs.filter : '';
            delete queryInput.sort;
            delete queryInput.direction;
            delete queryInput.groupBy;
          }
          if (['card-counts', 'card-monthlyConsumption'].includes(queryInput.datasetId) && ownTask.allCardTypes === true) {
            // Explicit all-card intent includes virtual accounts. The model
            // must not silently turn it into only the two bank-card types.
            delete queryInput.cardTypes;
            if (typeof queryInput.filter === 'string' && /^(?:信用卡?|借记卡?|储蓄卡?|现金|微信|支付宝|虚拟余额)$/.test(queryInput.filter)
              && !ownMessage.includes(queryInput.filter)) queryInput.filter = '';
          }
          if (['card-counts', 'card-monthlyConsumption'].includes(queryInput.datasetId) && ownTask.cardTypes.length) {
            queryInput.cardTypes = ownTask.cardTypes;
            // A stale card-type word is not a card-name search. Only remove a
            // known type label that the current utterance did not ask to match;
            // explicit names and all other free-text filters remain intact.
            if (queryInput.datasetId === 'card-monthlyConsumption' && typeof queryInput.filter === 'string'
              && /^(?:信用卡?|借记卡?|储蓄卡?)$/.test(queryInput.filter)
              && !ownMessage.includes(queryInput.filter)) queryInput.filter = '';
          }
          if (ownTask.metric === 'card-consumption' && queryInput.datasetId === 'card-monthlyConsumption') {
            const monthly = /每月|每个月|各月|逐月|按月|走势|趋势/.test(ownMessage);
            const hasMaximum = /最大|最多|最高|第一/.test(stripQueryPresentationText(ownMessage));
            const capability = getDatasetCapability(queryInput.datasetId);
            if (monthly && !hasMaximum
              && (queryInput.groupBy === undefined || capability.acceptedArgs.groupings.includes(queryInput.groupBy))) {
              queryInput.groupBy = capability.defaults.groupBy;
              if (queryInput.sort === undefined || SORTS.includes(queryInput.sort)) queryInput.sort = capability.defaults.sort;
            } else if (hasMaximum) {
              queryInput.sort = 'amountDesc';
              if (!monthly) queryInput.groupBy = 'card';
            } else if (ownTask.chartRequest?.type === 'pie' && !monthly) queryInput.groupBy = 'card';
            const cardScope = explicitPeriod(ownMessage, todayShanghai(now()), ownTask.scope)
              || (storedTaskContext?.subject === 'cards' || binding ? ownTask.scope : null);
            if (cardScope && !ownTask.comparisonScopes.length) Object.assign(queryInput, cardScope);
          }
        }
        if (call.function.name === 'query_data' && typeof inputArgs?.datasetId === 'string' && inputArgs.datasetId.startsWith('finance-') && ownQuery) {
          const boundQuery = bindQuerySubject(ownQuery, { filter: inputArgs.filter, message: ownMessage });
          // The finance cursor follows the finance clause actually read. A
          // later finance follow-up must not inherit another subject's dates.
          queryContext = boundQuery;
          const resolved = resolveQueryArgs(inputArgs, boundQuery);
          const metric = resolved.metric || boundQuery.activeQuery?.metric;
          queryInput = { ...inputArgs, startDate: resolved.startDate, endDate: resolved.endDate,
            direction: resolved.direction === 0 ? 'expense' : resolved.direction === 1 ? 'income' : typeof resolved.direction === 'string' ? resolved.direction : 'both',
            filter: resolved.category || resolved.filter || '' };
          if (metric === 'transaction-max') Object.assign(queryInput, { datasetId: 'finance-transactions', direction: queryInput.direction === 'income' ? 'income' : 'expense', sort: 'amountDesc' });
          if (metric === 'daily-max') Object.assign(queryInput, { datasetId: 'finance-daily',
            direction: queryInput.direction === 'income' ? 'income' : 'expense', sort: queryInput.direction === 'income' ? 'incomeDesc' : 'expenseDesc' });
        }
        let args;
        try {
          // Validate the model's entire original range before any saved-state
          // pinning. Bad calendars, reversed/future ranges and capability
          // restrictions must still follow the existing guard/recovery path.
          if (call.function.name === 'query_data') {
            // Check original types/calendars/capability and reader sorts before
            // correcting any semantic scope or default sort.
            const originalArgs = validateTool(call.function.name, inputArgs, todayShanghai(now()));
            const readerIssue = readerSortIssue(inputArgs);
            let targetIssue = targetDatasetIssue(inputArgs, ownTask, { message: ownMessage });
            if (!targetIssue && queryTaskBindings.length && !binding && currentQueryGoals.length
              && currentQueryGoals.length === queryTaskBindings.length) targetIssue = { path: 'datasetId', rule: 'dataset.intent.required',
                allowedValues: currentQueryGoals.map(goal => goal.task.targetDatasetId) };
            const filterIssue = filterBasisIssue(originalArgs, { task: ownTask, message: ownMessage, constraints: explicitQueryConstraints,
              previousTask: selectTaskContext(storedTaskContexts, { message: ownMessage, previous: storedTaskContext }),
              coverage: storedCoverage, queryContext: ownQuery });
            const issues = [readerIssue, targetIssue, filterIssue].filter(Boolean);
            if (targetIssue?.allowedValues.length === 1 && inputArgs.sort !== undefined) {
              const targetCap = getDatasetCapability(targetIssue.allowedValues[0]);
              const targetSorts = targetCap.acceptedArgs.readerSorts.length ? targetCap.acceptedArgs.readerSorts : targetCap.acceptedArgs.sorts;
              if (!targetSorts.includes(inputArgs.sort) && !readerIssue) issues.push({ path: 'sort', rule: 'dataset.readerSort', allowedValues: targetSorts });
            }
            if (issues.length) {
              await authorize([...new Set([...disclosed, originalArgs.domain, ...((targetIssue?.allowedValues || []).map(id => getDatasetCapability(id)?.domain).filter(Boolean))])]);
              const error = new AiError('工具参数与当前明确的数据集意图或排序能力不一致', 400, 'AI_TOOL_ARGUMENT_INVALID');
              error.validationDiagnostic = { issues };
              throw markToolParameterError(error, issues);
            }
            queryInput = pinDatasetSort(queryInput, ownTask);
          }
          args = validateTool(call.function.name, queryInput, todayShanghai(now()));
          if (explicitQueryConstraints) {
            queryInput = pinExplicitQueryConstraints(queryInput, explicitQueryConstraints);
            args = validateTool(call.function.name, queryInput, todayShanghai(now()));
          }
          if (call.function.name === 'query_data' && args.datasetId === 'account-balances'
            && requiresAssetCompositionDataset({ message: ownMessage, taskContext: ownTask, bindings: queryTaskBindings })) {
            // Validate the original arguments first, then keep permission gates
            // authoritative. The rejected detail packet never reaches SQL.
            await authorize([...new Set([...disclosed, args.domain, 'asset'])]);
            const issues = [{ path: 'datasetId', rule: 'dataset.assetComposition.required' }];
            const error = new AiError('按账户类型及币种的资产组成须读取全量组成汇总，请改用 asset-composition', 400, 'AI_TOOL_ARGUMENT_INVALID');
            error.validationDiagnostic = { issues };
            throw markToolParameterError(error, issues);
          }
          const cardHistoryMetric = { 'card-bills': 'card-bills', 'card-repayments': 'card-repayments' }[args.datasetId];
          if (call.function.name === 'query_data' && cardHistoryMetric && ownTask?.mode === 'query'
            && ownTask.subject === 'cards' && ownTask.metric === cardHistoryMetric && ownTask.scope
            && !ownTask.comparisonScopes?.length) {
            // Original model dates have already passed the unchanged validation above.
            // A legal different month must not replace a user's explicit/inherited card-history scope.
            queryInput = { ...queryInput, ...ownTask.scope };
            args = validateTool(call.function.name, queryInput, todayShanghai(now()));
          }
          if (call.function.name === 'query_data' && getDatasetCapability(args.datasetId)?.datePolicy.semantics === 'saved-state') {
            const savedScope = ownTask?.scope || explicitPeriod(ownMessage, todayShanghai(now()), ownQuery?.activeQuery) || initial.scope;
            const pinned = validateTool('query_data', { datasetId: args.datasetId,
              ...(savedScope ? { startDate: savedScope.startDate, endDate: savedScope.endDate } : {}) }, todayShanghai(now())).scope;
            queryInput = { ...queryInput, startDate: pinned.startDate, endDate: pinned.endDate };
            args = validateTool(call.function.name, queryInput, todayShanghai(now()));
          }
        }
        catch (error) {
          logToolValidationFailure(error, { requestId: request.requestId, conversationId: conversation.id, model: initial.config.model,
            round: lastProviderRound, tool: call.function.name, content: call.function.arguments,
            effectiveContent: JSON.stringify(queryInput) }, privateSecrets);
          validationLogged = true;
          if (error.code !== 'AI_SCOPE_INVALID' || !hasInvalidUserDates(request.message)) markToolParameterError(error,
            error.code === 'AI_SCOPE_INVALID' ? [{ path: 'startDate', rule: 'scope.calendar' }, { path: 'endDate', rule: 'scope.calendar' }] : undefined);
          throw error;
        }
        if (call.function.name === 'query_data') {
          queryInput = resumePageInput(ownMessage, queryInput, storedCoverage, queryContext);
          args = validateTool(call.function.name, queryInput, todayShanghai(now()));
        }
        const key = hash({ name: call.function.name, scope: args.scope, requestedScope: args.requestedScope,
          datasetId: args.datasetId, group: args.group, filter: args.filter,
          direction: args.direction, sort: args.sort, groupBy: args.groupBy, limit: args.limit, bankName: args.bankName, cardType: args.cardType, cardTypes: args.cardTypes,
          resolution: args.resolution || 'auto', cursor: args.cursor || null });
        if (seen.has(key)) {
          const cached = seen.get(key);
          const replay = { ...cached, ...queryEffectiveArgs(call.function.name, inputArgs,
            redactContextData(args, text => egress.scrub(text)), cached) };
          const bytes = Buffer.byteLength(JSON.stringify(replay));
          if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES) throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
          disclosureBytes += bytes;
          return replay;
        }
        if (toolAttempts >= MAX_TOOLS) throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
        toolAttempts++;
        budget.tool?.(call.function.name, args);
        await authorize([...new Set([...disclosed, args.domain])]);
        status({ stage: 'reading', tool: call.function.name, domain: args.domain, datasetId: args.datasetId || null });
        const repo = repository || (liveRepository ||= createBusinessReadRepository({ dbConfig: initial.config.db, now }));
        // businessRead's fixedAsset snapshot uses the original utterance to
        // decide whether recycle-bin rows are in scope (restore/permanentDelete).
        // Passing the message keeps that existing switch reachable from V3.
        args.queryId = `q_${crypto.randomBytes(12).toString('hex')}`;
        queryInputs.set(args.queryId, args);
        const raw = call.function.name === 'query_data' && args.domain === 'finance' && typeof repo.queryDataset === 'function'
          ? await repo.queryDataset(userId, { ...args, message: ownMessage })
          : await repo.query(userId, { ...args, ...args.scope, message: ownMessage,
            ...(call.function.name === 'list_choices' ? { candidateOnly: true } : {}) });
        budget.check();
        const selected = redactSelectedText(selectSnapshot(call.function.name, args, raw,
          { cardType: requestedCardType(ownMessage, raw.choices?.cards || []) }), raw, userId, privateSecrets);
        selected.datasets = enrichAnalysisDatasets(selected.datasets, {
          comparisonScopes: ownTask?.comparisonScopes, comparisonDatasets: [...datasets.values()],
          comparisonDirection: ownQuery?.activeQuery?.direction === 1 ? 'income' : 'expense' });
        if (call.function.name === 'query_data') {
          if (args.cursor && !selected.datasets[0]?.queryMeta?.page?.offset)
            throw new AiError('此结果没有应用续查凭据，请重新查询第一页', 400, 'AI_QUERY_CURSOR_INVALID');
          fitQueryWindow(selected, args, userId, 12 * 1024, now());
        }
        const prepared = await previews.prepare(userId, { message: request.message, scope: args.scope, snapshot: selected,
          conversationId: conversation.id, connectionId: initialConnection, provider: initialFingerprint, context: [] });
        await authorize([...new Set([...disclosed, args.domain])]);
        const approved = await previews.approveAndGet(userId, prepared.previewId, request.consent);
        const [claimed] = await executor.execute('UPDATE ai_analysis_preview SET request_id=? WHERE id=? AND user_id=? AND expires_at>? AND request_id IS NULL AND approved_at>=0',
          [request.requestId, prepared.previewId, userId, new Date(now()).getTime()]);
        if (claimed.affectedRows !== 1) throw new AiError('查询授权证物已使用，本轮已停止', 409, 'AI_PREVIEW_ALREADY_SENT');
        const payload = await previews.toProvider(userId, prepared.previewId);
        const toolResult = { scope: payload.scope, datasets: payload.datasets, choices: payload.choices, asOf: payload.asOf,
          ...(call.function.name === 'list_choices' ? { choiceCoverage: selected.choiceCoverage || choiceCoverage(args, raw, selected) } : {}),
          ...(args.queryNotice ? { queryNotice: args.queryNotice } : {}) };
        const effective = queryEffectiveArgs(call.function.name, inputArgs,
          redactContextData(args, text => egress.scrub(text)), toolResult);
        Object.assign(toolResult, effective);
        const bytes = Buffer.byteLength(JSON.stringify(toolResult));
        if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES) throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
        // Authorization is checked immediately before the next provider call too.
        disclosed.add(args.domain); disclosureBytes += bytes; snapshots.push({ ...approved, previewId: prepared.previewId, rawChoices: raw.choices, rawDatasets: raw.datasets,
          ...(call.function.name === 'list_choices' ? { choiceCoverage: toolResult.choiceCoverage } : {}) });
        for (const dataset of payload.datasets) datasets.set(dataset.queryMeta?.queryId || dataset.datasetId, dataset);
        const trace = { tool: call.function.name, domain: args.domain, ...(args.datasetId ? { datasetId: args.datasetId } : {}),
          ...(call.function.name === 'query_data' ? { queryId: args.queryId } : {}),
          records: payload.datasets.reduce((count, dataset) => count + dataset.rows.length, 0) + Object.values(payload.choices).reduce((count, rows) => count + rows.length, 0),
          bytes, digest: prepared.digest, previewId: prepared.previewId };
        toolTrace.push(trace);
        record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'tool',
          providerHost: host(initial.config), model: initial.config.model, toolName: call.function.name,
          request: inputArgs, response: { ...trace, result: toolResult, ...effective }, status: 'ok' });
        if (typeof emit === 'function') emit('tool', trace);
        seen.set(key, toolResult);
        return toolResult;
      }
      async function runContextTool(name, inputArgs) {
        if (openMode) {
          contextDisclosed = true;
          await authorize(undefined, null, isMemoryMutation(name) ? 'operate' : 'read', name === 'memory_delete'
            ? '删除你明确要求忘掉的记忆' : name === 'memory_write' ? '保存你要求记住的信息' : '读取必要的记忆或历史对话');
        }
        const key = hash({ name, args: inputArgs, ...(isContextMemoryTool(name) && !isMemoryMutation(name) ? { memoryEpoch } : {}) });
        if (seen.has(key)) return seen.get(key);
        if (toolAttempts >= MAX_TOOLS) throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
        toolAttempts++;
        // Failed calls also consume budget, and identical writes never repeat a side effect.
        seen.set(key, null);
        await authorize();
        let result;
        try {
          const args = isMemoryDeleteTool(name) ? validateMemoryDeleteTool(name, inputArgs)
            : isMemoryTool(name) ? validateMemoryTool(name, inputArgs) : validateHistoryTool(name, inputArgs);
          if (isContextMemoryTool(name) && personalState?.settings.useMemory === false)
            throw new AiError('用户已关闭使用记忆，请在 AI 个性化页面管理', 403, 'AI_MEMORY_DISABLED');
          budget.tool?.(name, isContextMemoryTool(name) && !isMemoryMutation(name) ? { args, memoryEpoch } : args);
          status({ stage: 'reading', tool: name });
          if (name === 'memory_list') {
            const index = await memoryStore.list(userId), visible = index.files.filter(item => safeMemoryPath(item.path));
            const files = visible.slice(args.offset, args.offset + args.limit);
            result = { files: files.map(memoryMetadata), count: visible.length, totalBytes: index.totalBytes,
              truncated: index.truncated === true || args.offset + files.length < visible.length,
              nextOffset: args.offset + files.length < visible.length ? args.offset + files.length : null,
              warnings: redactContextData(index.warnings?.slice(0, 3) || [], text => egress.scrub(text)), untrusted: true };
          } else if (name === 'memory_read') {
            if (!safeMemoryPath(args.path)) throw new AiError('记忆文件名含凭据或内部标识，不能对外读取', 400, 'AI_MEMORY_SENSITIVE_DATA');
            const entry = await memoryStore.read(userId, args), page = memoryReadPage(entry.content, args);
            const content = egress.scrub(page.content);
            result = { ...memoryMetadata(entry), ...page, content, contentRedacted: content !== page.content,
              source: egress.scrub(Array.from(entry.source).slice(0, 300).join('')), untrusted: true };
          } else if (name === 'memory_search') {
            const found = await memoryStore.search(userId, args);
            const visible = found.matches.filter(item => safeMemoryPath(item.path));
            result = { ...found, count: visible.length, matches: visible.map(item => {
              const text = egress.scrub(item.text);
              return { ...item, text, textRedacted: text !== item.text };
            }),
              warnings: redactContextData(found.warnings?.slice(0, 3) || [], text => egress.scrub(text)), untrusted: true };
          } else if (name === 'memory_write') {
            const evidence = args.evidence;
            const partialDeletion = args.operation === 'patch' && !args.content.replace(/^\s*>\s?/gm, '').trim();
            const source = evidence.historyRef != null ? historyRefs.get(evidence.historyRef)
              : Number.isInteger(evidence.sourceTurn) && userTurns[evidence.sourceTurn] != null ? { role: 'user', text: userTurns[evidence.sourceTurn] } : null;
            if (!source || source.role !== 'user' || !source.text.includes(evidence.quote)) {
              throw new AiError('记忆必须逐字引用本轮或历史工具返回的真实用户原话', 400, 'AI_MEMORY_SOURCE_INVALID');
            }
            if ([args.path, args.title, args.content, evidence.quote].some(value => memorySecrets.some(secret => value.includes(secret)))) {
              throw new AiError('记忆内容含凭据或内部标识，请只保存相关偏好或背景', 400, 'AI_MEMORY_SENSITIVE_DATA');
            }
            if (partialDeletion) {
              // Removing a complete record needs the same current-turn request
              // and model-visible read revision as deleting an entire file.
              validateMemoryDeleteEvidence({ path: args.path, expectedRevision: args.expectedRevision,
                evidence: { sourceTurn: evidence.sourceTurn, quote: evidence.quote }, reason: args.reason },
              { userTurns, currentTurn: userTurns.length - 1, readReceipts: memoryReadReceipts });
            }
            // Neither a previous memory nor assistant prose may authorize a new remembered fact.
            const previous = args.operation === 'patch' ? await memoryStore.read(userId, { path: args.path }) : null;
            validateMemoryContentEvidence(args, source.text, previous);
            const saved = await memoryStore.write(userId, { ...args, sourceText: source.text, signal: budget.signal });
            memoryEpoch++;
            const deletionEffect = partialDeletion && saved.changed === true ? { partialDeleted: true } : {};
            memoryReceipts.push({ saved: true, path: saved.path, revision: saved.revision, changed: saved.changed, ...deletionEffect });
            result = { status: 'saved', ...memoryMetadata(saved), changed: saved.changed, ...deletionEffect };
          } else if (name === 'memory_delete') {
            validateMemoryDeleteEvidence(args, { userTurns, currentTurn: userTurns.length - 1, readReceipts: memoryReadReceipts });
            if (!safeMemoryPath(args.path)) throw new AiError('记忆路径无效', 400, 'AI_MEMORY_SENSITIVE_DATA');
            const deleted = memoryDeletion
              ? await memoryDeletion(userId, args.path, { expectedRevision: args.expectedRevision }, { signal: budget.signal })
              : await memoryStore.remove(userId, { path: args.path, expectedRevision: args.expectedRevision, signal: budget.signal });
            memoryEpoch++; memoryReceipts.push({ ...deleted, deleted: true });
            result = { status: 'deleted', ...deleted, deleted: true };
          } else if (name === 'history_search') {
            const rows = await historyReader.search(userId, conversation.id, args);
            const matches = rows.slice(0, args.limit).filter(item => ['user', 'assistant'].includes(item.role)).map(item => {
              const ref = `h_${crypto.randomBytes(16).toString('hex')}`;
              historyRefs.set(ref, item);
              const chars = Array.from(item.text);
              return { ref, role: item.role, text: egress.scrub(chars.slice(0, 500).join('')), sourceDate: item.sourceDate,
                ...(item.sourceTime ? { sourceTime: item.sourceTime } : {}),
                status: item.status, truncated: chars.length > 500 };
            });
            result = { matches, count: matches.length, untrusted: true };
          } else {
            const item = historyRefs.get(args.ref);
            if (!item) throw new AiError('历史引用不属于本轮查询结果', 400, 'AI_HISTORY_REF_INVALID');
            const chars = Array.from(item.text);
            result = { ref: args.ref, role: item.role, text: egress.scrub(chars.slice(0, 3000).join('')),
              ...(item.sourceTime ? { sourceTime: item.sourceTime } : {}),
              sourceDate: item.sourceDate, status: item.status, truncated: chars.length > 3000, untrusted: true };
          }
        } catch (error) {
          if (['AI_LOOP_BLOCKED', 'AI_REQUEST_CANCELLED', 'AI_TURN_TIMEOUT', 'AI_SCOPE_DENIED', 'AI_CONNECTION_EXPIRED'].includes(error.code)) throw error;
          result = { status: 'error', code: error.code && /^AI_/.test(error.code) ? error.code : 'AI_CONTEXT_TOOL_FAILED',
            message: egress.scrub(error instanceof AiError ? error.message : '记忆或历史暂时无法读取，请稍后重试。') };
          if (isMemoryMutation(name)) memoryErrors.push(result);
        }
        await authorize();
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES) throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
        disclosureBytes += bytes;
        if (isContextMemoryTool(name) && result.status === 'error') failedMemoryTool = true;
        if (name === 'memory_read' && result.status !== 'error') memoryReadReceipts.push({ ...result });
        if (name === 'memory_search' && result.status !== 'error') {
          memorySearchReceipts.push({ ...result });
          memorySearchEvidence.push({ args: validateMemoryTool(name, inputArgs), result: { ...result }, epoch: memoryEpoch });
        }
        const trace = { tool: name, records: result.matches?.length ?? result.files?.length ?? (result.status === 'error' ? 0 : 1), bytes, digest: hash(result) };
        toolTrace.push(trace);
        record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'tool',
          providerHost: host(initial.config), model: initial.config.model, toolName: name,
          request: inputArgs, response: { ...trace, result }, status: result.status === 'error' ? 'error' : 'ok' });
        if (typeof emit === 'function') emit('tool', trace);
        seen.set(key, result);
        return result;
      }
      // calculate 记账口径与 runContextTool 一致：预算锁定、去重缓存、字节上限、
      // tool 事件审计（request/response 含表达式与结果）。参数或算式错误以
      // status:error 结果反馈模型重试，不中断整轮——与记忆/历史工具同语义。
      async function runCalcTool(name, inputArgs) {
        const key = hash({ name, args: inputArgs });
        if (seen.has(key)) return seen.get(key);
        if (toolAttempts >= MAX_TOOLS) throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
        toolAttempts++;
        seen.set(key, null);
        let result;
        try {
          const args = validateCalcTool(name, inputArgs);
          budget.tool?.(name, args);
          result = evaluateCalc(args);
        } catch (error) {
          if (['AI_LOOP_BLOCKED', 'AI_REQUEST_CANCELLED', 'AI_TURN_TIMEOUT', 'AI_SCOPE_DENIED', 'AI_CONNECTION_EXPIRED'].includes(error.code)) throw error;
          result = { status: 'error', code: error.code && /^AI_/.test(error.code) ? error.code : 'AI_CALC_FAILED',
            message: error instanceof AiError ? error.message : '计算服务暂时不可用，请稍后重试。' };
        }
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES) throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
        disclosureBytes += bytes;
        const trace = { tool: name, records: result.status === 'error' ? 0 : 1, bytes, digest: hash(result) };
        if (result.status !== 'error') calculations.push(result);
        toolTrace.push(trace);
        record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'tool',
          providerHost: host(initial.config), model: initial.config.model, toolName: name,
          request: inputArgs, response: { ...trace, result }, status: result.status === 'error' ? 'error' : 'ok' });
        if (typeof emit === 'function') emit('tool', trace);
        seen.set(key, result);
        return result;
      }
      let searchAttempts = 0;
      const searchSources = new Map();
      async function runSearchTool(name, inputArgs) {
        // 场景门先于参数/预算/HTTP；模型强行请求也不能越过该门。
        if (!searchEnabled) throw new AiError('本轮未开放联网搜索', 403, 'AI_TOOL_DENIED');
        // §3b：每一次联网调用都必须落在有效会话授权下——无授权=整轮带授权卡失败，
        // 用户批准（access='web_search'）后重发才继续；与数据授权同流。
        await grants.requireWebSearch(userId, conversation.id, host(initial.config));
        if (toolAttempts >= MAX_TOOLS) throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
        toolAttempts++;
        let result;
        try {
          if (++searchAttempts > 2) throw new AiError('本轮搜索次数已达上限', 429, 'AI_WEB_SEARCH_TURN_LIMIT');
          const args = validateWebSearchTool(name, inputArgs);
          budget.check();
          budget.tool?.(name, { ...args, searchAttempt: searchAttempts });
          result = await webSearchTools.search(initial.config, args, { egress, signal: budget.signal,
            reserve: input => { budget.check(); return searchBudget.reserve(input); } });
          budget.check();
        } catch (error) {
          if (['AI_LOOP_BLOCKED', 'AI_REQUEST_CANCELLED', 'AI_TURN_TIMEOUT', 'AI_SCOPE_DENIED', 'AI_CONNECTION_EXPIRED'].includes(error.code)) throw error;
          result = { status: 'error', code: /^AI_WEB_SEARCH_/.test(error.code || '') ? error.code : 'AI_WEB_SEARCH_FAILED',
            message: error instanceof AiError ? egress.scrub(error.message) : '搜索暂时不可用，请稍后重试。', untrusted: true };
        }
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES)
          throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
        disclosureBytes += bytes;
        if (result.status === 'ok') for (const item of result.results || []) searchSources.set(item.url, item);
        const trace = { tool: name, records: result.results?.length || 0, bytes, digest: hash(result) };
        toolTrace.push(trace);
        record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'web_search',
          providerHost: new URL(initial.config.searchBaseUrl).host, toolName: name,
          request: { query: result.query || egress.scrub(inputArgs?.query || '').slice(0, 120) },
          response: { ...trace, cached: result.cached === true, sourceHosts: (result.results || []).map(item => new URL(item.url).host) },
          status: result.status === 'error' ? 'error' : 'ok', errorCode: result.code || null });
        if (typeof emit === 'function') emit('tool', trace);
        return result;
      }
      for (let round = 0; round < MAX_PROVIDER_CALLS; round++) {
        await authorize();
        if (totalTokens >= (initial.config.maxUsageTokens || MAX_USAGE_TOKENS)) throw new AiError('本轮已达到token预算，已停止后续模型请求', 429, 'AI_TOKEN_BUDGET_EXCEEDED');
        const finalRound = finalizing || round === MAX_PROVIDER_CALLS - 1;
        const requestMessages = structuredClone(finalRound ? buildFinalizationMessages(messages, responseLanguage, relaxedMode ? OPEN_FINALIZE_PROMPT : FINALIZE_PROMPT) : messages);
        const roundValidation = responseValidation.forResult({ datasets: [...datasets.values()] });
        const approvedRefs = snapshots.flatMap(snapshot => Object.keys(snapshot.refMap || {}));
        const scrubModelText = text => searchAttempts
          ? scrubWithCitations(text, value => egress.scrub(value, approvedRefs), [...searchSources.values()])
          : roundValidation.privateSources ? egress.scrub(text, approvedRefs) : egress.scrubText(text, approvedRefs);
        // Intermediate provider prose is untrusted too. Re-check it after tool
        // dispatch has established the scope and before a later paid round.
        for (const message of requestMessages) if (message.role === 'assistant') {
          if (message.content != null) message.content = scrubModelText(message.content);
          if (message.reasoning_content) message.reasoning_content = scrubModelText(message.reasoning_content);
          for (const call of message.tool_calls || []) call.function.arguments = scrubModelText(call.function.arguments);
        }
        const offeredTools = openMode ? openDefinitions : memorySearchGoal ? definitions.filter(definition =>
          memorySearchEvidence.length ? ['memory_search', 'memory_read'].includes(definition.function.name)
            : definition.function.name === 'memory_search') : definitions;
        const enabledTools = personalState?.settings.useMemory === false
          ? offeredTools.filter(definition => !isContextMemoryTool(definition.function.name)) : offeredTools;
        const selectedTools = finalRound ? [] : numericRecoveryUsed ? enabledTools.filter(definition => isCalcTool(definition.function.name)) : currentTurnIntent.businessSuppressed
          ? enabledTools.filter(definition => !['query_data', 'list_choices'].includes(definition.function.name)) : enabledTools;
        status({ stage: finalRound ? 'finalizing' : round === 0 ? 'selecting' : 'reasoning', round: round + 1, maxRounds: MAX_PROVIDER_CALLS });
        const started = Date.now();
        let raw;
        let liveThought;
        try {
          // Final round sends no `tools` at all. deepseek.js only emits tool_choice
          // when tools.length > 0, so `tools=[]` is the HTTP-level guarantee;
          // toolChoice is kept as an explicit orchestration/provider-contract marker.
          // The hard constraint lives below: any tool_calls on finalRound is rejected.
          // Collect complete reasoning privately. It is scrubbed as one string
          // and only published after the result transaction and claim checks succeed.
          const thought = createReasoningRound(round + 1, text => roundValidation.privateSources ? egress.scrub(text) : egress.scrubText(text));
          const thoughtLifecycle = createReasoningLifecycle({ round: round + 1, requestId: request.requestId,
            thinkingRequested: Boolean(initial.config.thinking), onEvent: emit });
          liveThought = createLiveReasoning({ round: round + 1, requestId: request.requestId, onEvent: emit,
            scrub: text => egress.scrub(text), consumeBudget: size => {
              if (liveReasoningChars + size > 24000) return false;
              liveReasoningChars += size; return true;
            } });
          raw = await budget.invoke(signal => {
            thoughtLifecycle.start();
            return provider(initial.config, requestMessages, selectedTools, { json: finalRound && !relaxedMode,
            maxTokens: initial.config.maxOutputTokens || (relaxedMode ? 6000 : 2400), signal, ...(finalRound ? { toolChoice: 'none' } : requireQueryTool ? { toolChoice: { type: 'function', function: { name: 'query_data' } } } : {}),
            ...(finalRound && !relaxedMode && initial.config.structuredOutput === 'json_schema' ? { responseSchema: OUTPUT_JSON_SCHEMA, schemaName: 'life_assistant_v3' } : {}) },
            delta => {
              if (delta?.type === 'reasoning') { budget.check(); thought.push(delta.text); liveThought.push(delta.text); }
              if (delta?.type === 'content' && delta.text) liveThought.finish();
              thoughtLifecycle.delta(delta);
            });
          });
          thoughtLifecycle.finish(raw?.message || raw);
          liveThought.finish(raw?.message || raw);
          const completeThought = thought.finish(raw?.message || raw);
          if (completeThought && reasoningRounds.reduce((size, item) => size + item.text.length, 0) + completeThought.text.length <= 24000)
            reasoningRounds.push(completeThought);
        } catch (error) {
          liveThought?.clear();
          record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'provider',
            providerHost: host(initial.config), model: initial.config.model, thinkingEnabled: Boolean(initial.config.thinking),
            request: { promptVersion, round: round + 1, finalRound, transport: 'stream',
              maxTokens: initial.config.maxOutputTokens || (relaxedMode ? 6000 : 2400), json: finalRound && !relaxedMode,
              thinkingEnabled: Boolean(initial.config.thinking), messages: requestMessages, tools: selectedTools },
            durationMs: Date.now() - started, status: 'error', errorCode: error.code || null,
            httpStatus: Number.isFinite(error.status) ? error.status : null,
            response: { message: error.message, causeCode: error.causeCode, providerStatus: error.providerStatus,
              diagnostics: error.diagnostics || null, providerDetail: error.providerDetail || null } });
          throw error;
        }
        const response = raw?.message ?? raw;
        lastModelContent = response?.content;
        lastProviderRound = round + 1;
        validationStage = 'provider-envelope';
        logProviderReasoning(response, { requestId: request.requestId, conversationId: conversation.id,
          model: initial.config.model, round: round + 1,
          stage: finalRound ? 'finalizing' : round === 0 ? 'selecting' : 'reasoning' }, privateSecrets);
        record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'provider',
          providerHost: host(initial.config), model: initial.config.model, thinkingEnabled: Boolean(initial.config.thinking),
          request: { promptVersion, round: round + 1, finalRound, transport: 'stream',
            maxTokens: initial.config.maxOutputTokens || (relaxedMode ? 6000 : 2400), json: finalRound && !relaxedMode,
            thinkingEnabled: Boolean(initial.config.thinking), messages: requestMessages, tools: selectedTools },
          durationMs: Date.now() - started, status: 'ok', response: raw, usage: raw?.usage || null });
        for (const key of Object.keys(usage)) if (Number.isFinite(raw?.usage?.[key]) && raw.usage[key] >= 0) usage[key] += raw.usage[key];
        totalTokens = usage.total_tokens || usage.prompt_tokens + usage.completion_tokens;
        budget.check();
        if (response?.role !== 'assistant') throw new AiError('模型返回角色无效', 502, 'AI_INVALID_RESULT');
        if (response.tool_calls?.length) {
          const exhaustedCalcBatch = !finalRound && relaxedMode && responseValidation.forResult({ datasets: [...datasets.values()] }).businessRead
            && Array.isArray(response.tool_calls) && response.tool_calls.length <= MAX_TOOLS
            && response.tool_calls.length > MAX_TOOLS - toolAttempts
            && response.tool_calls.every(call => call?.function?.name === 'calculate' && call.type === 'function'
              && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 128
              && typeof call.function.arguments === 'string' && call.function.arguments.length <= 4000);
          if (finalRound || !Array.isArray(response.tool_calls) || response.tool_calls.length > MAX_TOOLS - toolAttempts && !exhaustedCalcBatch)
            throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
          if (!openMode && memorySearchGoal && response.tool_calls.some(call => typeof call.function?.name === 'string'
            && !selectedTools.some(definition => definition.function.name === call.function.name)))
            throw new AiError('纯记忆搜索选择了本轮未开放的工具', 403, 'AI_TOOL_DENIED');
          const ids = response.tool_calls.map(call => call.id);
          if (new Set(ids).size !== ids.length) throw new AiError('模型工具调用编号重复', 502, 'AI_INVALID_RESULT');
          messages.push({ role: 'assistant', content: response.content || null, tool_calls: response.tool_calls,
            ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}) });
          if (exhaustedCalcBatch) {
            // Reject the entire batch before dispatch: no extra calculation or
            // budget allowance. Pair each native call and use the remaining
            // provider round only to deliver already verified facts.
            const result = { status: 'error', code: 'AI_TOOL_BUDGET_EXCEEDED',
              message: '剩余工具额度不足，本批计算均未执行。停止工具调用，仅按已取得数据和成功计算回执回答；没有回执的比例或合计请省略。' };
            const bytes = Buffer.byteLength(JSON.stringify(result)) * response.tool_calls.length;
            if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES)
              throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
            disclosureBytes += bytes;
            for (const call of response.tool_calls) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'numeric-tool-limit',
              providerHost: host(initial.config), model: initial.config.model, status: 'error', errorCode: result.code,
              request: { requested: response.tool_calls.length, remaining: MAX_TOOLS - toolAttempts }, response: { executed: 0 } });
            finalizing = true;
            continue;
          }
          const beforeTools = toolTrace.length, beforeSeen = seen.size;
          let batchParameterError = false;
          for (const call of response.tool_calls) {
            const beforeAttempt = toolAttempts;
            let result;
            try { result = await runTool(call); }
            catch (error) {
              if (!['query_data', 'list_choices'].includes(call.function?.name) || !isToolParameterError(error)) throw error;
              budget.check();
              let originalArgs;
              try { originalArgs = JSON.parse(call.function.arguments); } catch (_) { originalArgs = { invalidJson: call.function.arguments }; }
              const failureKey = digestInput({ name: call.function.name, args: originalArgs });
              if (failedTools.has(failureKey)) throw error;
              // Failed reads never enter the successful cache. Both deduplication
              // and the 8-tool limit include validation failures.
              if (toolAttempts === beforeAttempt) {
                if (toolAttempts >= MAX_TOOLS) throw new AiError('模型超过受控工具预算', 502, 'AI_LOOP_BLOCKED');
                toolAttempts++;
                budget.tool?.(call.function.name, { failedArguments: originalArgs });
              }
              if (toolRecoveryUsed) throw error;
              failedTools.set(failureKey, error);
              batchParameterError = true;
              const retryAllowed = round < MAX_PROVIDER_CALLS - 2 && toolAttempts < MAX_TOOLS;
              result = toolErrorFeedback(error, originalArgs, retryAllowed);
              const bytes = Buffer.byteLength(JSON.stringify(result));
              if (bytes > MAX_TOOL_BYTES || disclosureBytes + bytes > MAX_DISCLOSURE_BYTES) throw new AiError('本次必要数据超过外发上限，请缩小范围', 400, 'AI_DISCLOSURE_LIMIT');
              disclosureBytes += bytes;
              record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'tool-recovery',
                providerHost: host(initial.config), model: initial.config.model, toolName: call.function.name,
                status: 'error', errorCode: error.code, request: { round: round + 1 }, response: result });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          }
          if (batchParameterError) {
            toolRecoveryUsed = true;
            if (round >= MAX_PROVIDER_CALLS - 2 || toolAttempts >= MAX_TOOLS) finalizing = true;
            status({ stage: finalizing ? 'finalizing' : 'reasoning', round: round + 1, maxRounds: MAX_PROVIDER_CALLS });
            continue;
          }
          // A whole batch that only replays approved business-query evidence
          // cannot fill a data gap. Pair every result first, then spend the next
          // provider call on the final answer rather than repeating that loop.
          // Fresh or mixed reads and context tools keep their normal workflow.
          if (toolTrace.length === beforeTools && seen.size === beforeSeen
            && response.tool_calls.every(call => ['query_data', 'list_choices'].includes(call.function.name))) finalizing = true;
          // A simple monthly-card chart has a concrete completion condition:
          // complete rows and summary for the current types and exact scope.
          // Once satisfied, chasing an older task cannot improve this answer.
          // Incomplete windows, comparisons and mixed batches still may read.
          const completionScope = effectiveGoalScope({ task: taskContext || {} }, todayShanghai(now()));
          const completeMonthly = !queryTaskBindings.length && taskContext?.mode === 'query' && taskContext.metric === 'card-consumption'
            && ['line', 'bar'].includes(taskContext.chartRequest?.type)
            && !taskContext.comparisonScopes?.length && !/同时|以及|另外|对比|比较/.test(request.message)
            && response.tool_calls.every(call => call.function.name === 'query_data'
              && JSON.parse(call.function.arguments).datasetId === 'card-monthlyConsumption')
            && [...datasets.values()].find(dataset => {
              const meta = dataset.queryMeta;
              return meta?.groupBy === 'cardMonth' && meta.rowsComplete === true && meta.summaryComplete === true
                && meta.effectiveScope.startDate === completionScope?.startDate && meta.effectiveScope.endDate === completionScope?.endDate
                && JSON.stringify(meta.filters.cardTypes || []) === JSON.stringify(taskContext.cardTypes || [])
                && (!meta.filters.text || request.message.includes(meta.filters.text));
            });
          const simpleFinance = !queryTaskBindings.length && taskContext?.mode === 'query' && taskContext.subject === 'finance'
            && !taskContext.comparisonScopes?.length && !/同时|以及|另外|对比|比较|原因|为什么|建议|分析/.test(request.message)
            && response.tool_calls.every(call => call.function.name === 'query_data');
          const completeFinance = simpleFinance && [...datasets.values()].find(dataset => {
            const meta = dataset.queryMeta;
            if (!meta || meta.summaryComplete !== true || meta.effectiveScope.startDate !== completionScope?.startDate
              || meta.effectiveScope.endDate !== completionScope?.endDate) return false;
            if (taskContext.metric === 'summary' && ['line', 'bar'].includes(taskContext.chartRequest?.type)) return dataset.datasetId === 'finance-monthly'
              && meta.rowsComplete === true && meta.filters.direction === 'both' && !meta.filters.text;
            return !taskContext.chartRequest && meta.rankingComplete === true && (taskContext.metric === 'transaction-max'
              && dataset.datasetId === 'finance-transactions' && meta.sort === 'amountDesc'
              || taskContext.metric === 'daily-max' && dataset.datasetId === 'finance-daily'
                && (meta.sort === 'expenseDesc' && meta.filters.direction === 'expense'
                  || meta.sort === 'incomeDesc' && meta.filters.direction === 'income'));
          });
          const groundedDataset = completeMonthly || completeFinance;
          if (groundedDataset && !relaxedMode && !currentTurnIntent.auxiliaryRequest
            && !toolTrace.some(item => ['memory_write', 'history_search', 'history_read'].includes(item.tool))) {
            // Facts and chart are entirely defined by the approved query, so
            // this read-only packet needs no further generative operation.
            // Validate the same output schema and use the common authorization,
            // chart, claims, persistence and receipt path below.
            const summaryChart = groundedDataset.datasetId === 'finance-monthly';
            output = validateOutput({ answer: '', proposal: null, proposals: null, clarification: null,
              chart: completeMonthly || summaryChart ? { datasetId: groundedDataset.datasetId, queryId: groundedDataset.queryMeta.queryId,
                type: taskContext.chartRequest.type, xKey: 'month', yKeys: summaryChart ? ['income', 'expense'] : ['amountCNY'], title: groundedDataset.title } : null });
            record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat',
              phase: 'grounded-done', providerHost: host(initial.config), model: initial.config.model, status: 'ok',
              request: { queryId: groundedDataset.queryMeta.queryId, reason: completeMonthly ? 'complete-monthly-card-evidence'
                : summaryChart ? 'complete-monthly-finance-evidence' : 'complete-finance-ranking-evidence' }, response: output });
            break;
          }
          const completeMemorySearch = memorySearchCompletion({ ...memorySearchContext,
            searches: memorySearchEvidence.filter(search => search.epoch === memoryEpoch) });
          if (completeMemorySearch && response.tool_calls.every(call => ['memory_search', 'memory_read'].includes(call.function.name))) {
            messages.push({ role: 'system', content: completeMemorySearch.finalizationInstruction });
            finalizing = true;
          }
          if (!relaxedMode && targetedQueriesComplete()) finalizing = true;
          requireQueryTool = false;
          continue;
        }
        if (typeof response.content !== 'string' || response.content.length > 30000) throw new AiError('模型未返回有效结构化答复', 502, 'AI_INVALID_RESULT');
        if (relaxedMode) {
          const numericScope = responseValidation.forResult({ datasets: [...datasets.values()] });
          const numericCandidate = numericScope.businessRead ? searchAttempts
            ? scrubWithCitations(response.content, value => egress.scrub(value), [...searchSources.values()]) : egress.scrub(response.content) : response.content;
          if (numericScope.businessRead) scenarioContexts.push(numericCandidate);
          const numericCheck = numericScope.businessRead ? verifyChatNumbers(numericCandidate,
            { datasets: [...datasets.values()], calculations, sourceMessage: request.message, scenarioMessage: scenarioContexts.join('\n') }) : { valid: true };
          if (!numericCheck.valid) {
            const claims = reconcileMemoryClaims(response.content, { receipts: memoryReceipts, readReceipts: memoryReadReceipts,
              searchReceipts: memorySearchReceipts, errors: memoryErrors, explicitOnly: numericScope.memoryExplicitOnly });
            assertResultClaims(normalizeSavedStateClaims(claims.businessClaimsText, [...datasets.values()]),
              { artifacts: [], currentReceipts: [], scope: numericScope.claimsScope });
          }
          if (!numericCheck.valid && !numericRecoveryUsed && !finalRound && round < MAX_PROVIDER_CALLS - 2 && toolAttempts < MAX_TOOLS) {
            numericRecoveryUsed = true;
            // Keep approved native receipts, not the unverified answer. Leave
            // one calculation round and one tool-free final round in the budget.
            messages.push({ role: 'system', content: '本轮答复含没有本轮证据的数字：' +
              numericCheck.unsupportedNumbers.slice(0, 20).join('、') + '。仅使用已发布账本数值和真实calculate回执；需要派生数字时调用calculate，算式输入也必须有来源，不能把待证明的数直接作为算式。不要再查账或写记忆；无法核验时省略该结论，保留已确认事实。' });
            if (numericCheck.scenarioInputs?.length) messages.push({ role: 'system', content:
              '本轮明确讨论的假设输入参数=' + JSON.stringify(numericCheck.scenarioInputs.slice(0, 20)) +
              '。它们只支持明确标注的情景推演，派生结果仍须calculate；重述假设，不得把假设输入或结果说成当前或已保存的账本事实。' });
            record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'numeric-recovery',
              providerHost: host(initial.config), model: initial.config.model, status: 'error', errorCode: 'AI_NUMBER_NOT_GROUNDED',
              request: { round: round + 1 }, response: { unsupportedNumbers: numericCheck.unsupportedNumbers.slice(0, 20) } });
            continue;
          }
          output = { answer: response.content, proposal: null, proposals: null, clarification: null, chart: null };
          break;
        }
        if (!finalRound) {
          // Native-tool responses are intermediate material, even if they resemble valid JSON.
          // Only one tool-free JSON finalization may be validated or persisted; no byte repair or transport retry.
          const approvedRefs = snapshots.flatMap(snapshot => Object.keys(snapshot.refMap || {}));
          messages.push({ role: 'assistant', content: egress.scrub(response.content, approvedRefs) });
          const missing = missingQueryEvidence();
          if (missing.length) {
            // Missing reads cannot turn an unauthorized action into a query
            // recovery. Check recognizable native proposal intent before
            // requesting another paid round; malformed prose still follows
            // the single tool-free schema validation path below.
            let nativePacket;
            try { nativePacket = parseSingleJsonObject(response.content); } catch {}
            const nativeProposals = nativePacket?.clarification?.items || nativePacket?.proposals
              || (nativePacket?.proposal ? [nativePacket.proposal] : []);
            if (Array.isArray(nativeProposals)) for (const proposed of nativeProposals) {
              if (typeof proposed?.kind === 'string' && proposed.kind !== 'transaction.create') {
                assertV3ProposalIntent(proposed.kind, request.message);
              }
            }
          }
          if (missing.length && !failedTools.size && !freshQueryRecoveryUsed && round < MAX_PROVIDER_CALLS - 2 && toolAttempts < MAX_TOOLS) {
            const feedback = freshQueryFeedback(missing);
            messages.push({ role: 'system', content: JSON.stringify(feedback) });
            freshQueryRecoveryUsed = true; requireQueryTool = true; finalizing = false;
            record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'query-evidence-recovery',
              status: 'pending', request: { round: round + 1 }, response: feedback });
            continue;
          }
          if (!memoryTaskAttempted() && !memoryTaskRecoveryUsed && round < MAX_PROVIDER_CALLS - 2 && toolAttempts < MAX_TOOLS) {
            messages.push({ role: 'system', content: `本轮明确要求的长期记忆${currentTurnIntent.memoryOperation}操作尚未处理。业务查询完成不等于记忆任务完成；请使用相应memory工具处理该要求，并依据实际工具回执答复，不重查已取得的数据。` });
            memoryTaskRecoveryUsed = true; finalizing = false; requireQueryTool = false;
            continue;
          }
          finalizing = true;
          continue;
        }
        try {
          validationStage = 'json-parse';
          const parsed = parseSingleJsonObject(response.content);
          validationStage = 'action-policy';
          // A model cannot disguise an explicitly excluded money operation as a normal draft, even in a malformed packet.
          const rawProposals = Array.isArray(parsed.proposals) ? parsed.proposals : parsed.proposal ? [parsed.proposal] : [];
          for (const proposed of rawProposals) if (proposed?.kind === 'transaction.create') {
            const source = Number.isInteger(proposed.evidence?.sourceTurn) ? userTurns[proposed.evidence.sourceTurn] || '' : '';
            if (SPECIAL_ACCOUNTING.test(`${request.message} ${source} ${typeof proposed.fields?.remark === 'string' ? proposed.fields.remark : ''}`)) throw new AiError('转账、还款等特殊账务不能包装成普通收支草稿，请使用原业务入口', 403, 'AI_ACTION_NOT_ALLOWED');
          }
          validationStage = 'output-schema';
          output = validateOutput(parsed);
        } catch (error) {
          logModelValidationFailure(error, { requestId: request.requestId, conversationId: conversation.id,
            model: initial.config.model, round: lastProviderRound, stage: validationStage, content: response.content }, privateSecrets);
          validationLogged = true;
          throw error;
        }
        validationStage = 'result-protocol';
        if (responseLanguageMismatch(output.answer, responseLanguage) && !languageRecoveryUsed && round < MAX_PROVIDER_CALLS - 1
          && totalTokens < (initial.config.maxUsageTokens || MAX_USAGE_TOKENS)) {
          languageRecoveryUsed = true;
          messages.push({ role: 'system', content: `The previous final answer used the wrong response language. ${languageInstruction(responseLanguage)} Preserve the user facts, original quotations and all proposal fields/evidence; change only the answer language. Return the same final JSON protocol.` });
          record({ userId, requestId: request.requestId, conversationId: conversation.id, lane: 'v3-chat', phase: 'language-recovery',
            status: 'pending', request: { round: round + 1, responseLanguage }, response: { correctionAllowed: true, toolsAllowed: false } });
          output = null; finalizing = true;
          continue;
        }
        break;
      }
      if (!output) throw new AiError('模型未在预算内完成答复', 502, 'AI_PROVIDER_CALL_LIMIT');
      status({ stage: 'validating' });
      await authorize();
      const cancelledPending = pendingTransactions && isPendingTransactionCancellation(request.message);
      const clarificationOnly = Boolean(output.clarification);
      const proposedList = cancelledPending ? [] : output.clarification?.items || output.proposals || (output.proposal ? [output.proposal] : []);
      if (openMode && proposedList.length) await authorize(undefined, null, 'operate', '准备你要求的待确认操作草稿');
      const missingFresh = missingQueryEvidence();
      if (missingFresh.length && !failedTools.size) {
        // A source-free final answer cannot claim a changed query returned zero.
        throw new AiError('本轮尚未读取到所请求的新查询结果，不能沿用之前的结果，请重试', 502, 'AI_QUERY_EVIDENCE_REQUIRED');
      }
      if (missingFresh.length && failedTools.size && output.answer.trim()) {
        // A rejected parameter packet proves a failed query, never zero matches.
        // Use server-known failure facts while preserving every approved read.
        const dateErrorsOnly = [...failedTools.values()].every(error => error.code === 'AI_SCOPE_INVALID');
        const futureNotice = dateErrorsOnly ? futureFinanceQueryNotice({ message: request.message, today: todayShanghai(now()),
          goals: currentQueryGoals, bindings: queryTaskBindings, queryContext, datasets: [...datasets.values()], queryInputs,
          failures: [...failedTools.values()], successfulQueries: toolTrace.filter(item => item.tool === 'query_data').length }) : null;
        const answer = futureNotice || (dateErrorsOnly ? '查询日期无效，请核对日期。'
          : '本轮查询未完成：工具参数未通过校验，无法确认是否有匹配记录。请核对参数后重新查询。');
        output = { ...output, answer };
      }
      const readDatasets = [...datasets.values()];
      const scopeText = snapshots.findLast(item => item.snapshot?.datasets?.length)?.scope || null;
      const chartTasks = queryTaskBindings.length ? queryTaskBindings.map(binding => binding.taskContext) : taskContext ? [taskContext] : [];
      // Chat/analysis wording ("能不能给我画个图") yields a chat-mode taskContext that still
      // carries chartRequest; relaxed mode must want a chart there too. The chart itself is
      // still derived server-side from real datasets only — the model never supplies one.
      const wantsChart = !currentTurnIntent.businessSuppressed && (relaxedMode
        ? CHART_INTENT.test(businessMessage) || Boolean(taskContext?.chartRequest)
        : chartTasks.length ? chartTasks.some(task => task.mode === 'query' && Boolean(task.chartRequest)) : CHART_INTENT.test(businessMessage));
      let proposedChart = output.chart;
      const knownChart = knownMonthlyFinanceChart(proposedChart, currentQueryGoals, readDatasets, queryInputs, todayShanghai(now()));
      if (knownChart) proposedChart = knownChart;
      if (!proposedChart && wantsChart) {
        const matching = chartTasks.filter(task => task.chartRequest).flatMap(task => readDatasets.filter(dataset =>
          task.metric === 'card-count' ? dataset.datasetId === 'card-counts'
            : task.metric === 'card-consumption' ? dataset.datasetId === 'card-monthlyConsumption'
              && dataset.queryMeta?.groupBy === 'cardMonth' && task.chartRequest.type !== 'pie'
            : task.subject === 'finance' && dataset.datasetId === 'finance-monthly').map(dataset => ({ task, dataset })));
        if (matching.length === 1 && matching[0].dataset.rows.length) {
          const { dataset, task } = matching[0], keys = task.metric === 'card-count' ? ['count']
            : task.metric === 'card-consumption' ? ['amountCNY'].filter(key => dataset.columns.some(column => column.key === key))
            : ['income', 'expense'].filter(key => dataset.columns.some(column => column.key === key));
          if (keys.length) proposedChart = { datasetId: dataset.datasetId, queryId: dataset.queryMeta?.queryId,
            type: task.chartRequest.type, xKey: task.metric === 'card-count' ? 'type' : 'month', yKeys: keys, title: dataset.title };
        }
      }
      const completedAssetPie = !proposedChart && wantsChart
        ? knownAssetCompositionPie(currentQueryGoals, readDatasets, queryInputs, todayShanghai(now())) : null;
      if (completedAssetPie) proposedChart = completedAssetPie;
      proposedChart = pinCardBillChartAxis(proposedChart, readDatasets, { message: request.message, tasks: chartTasks });
      const { chart, note: chartNote } = validateChart(proposedChart, readDatasets, scopeText, wantsChart);
      if (completedAssetPie && chart) output = { ...output, answer: clearCompletedAssetPieRetry(output.answer) };
      const requiredDomains = new Set(toolTrace.map(item => item.domain).filter(Boolean));
      // A larger history window must not turn an unrelated old purchase of the
      // same price into a competing source for this turn's missing envelope.
      const recoveryTurns = taskContext?.mode === 'record' ? new Set([userTurns.length - 1])
        : taskContext?.mode === 'pending-supplement' && pendingTransactions
          ? new Set(pendingTransactions.items.map(item => item.evidence.sourceTurn)) : null;
      const amountRecoverySources = recoveryTurns ? userTurns.map((text, index) => recoveryTurns.has(index) ? text : '') : userTurns;
      const allEntities = snapshots.flatMap(snapshot => Object.values(snapshot.snapshot.choices || {}).flat()).filter(item => item?.name);
      const resolve = async (ref, kind) => {
        if (ref == null) return null;
        const source = snapshots.find(snapshot => snapshot.refMap?.[ref]?.kind === kind);
        if (!source) throw new AiError('模型须选择本轮获准工具返回的引用', 400, 'AI_REF_INVALID');
        return previews.resolve(userId, source.previewId, ref, kind);
      };
      const preparedTransactions = [], transactionInputs = [], transactionIntents = [], businessInputs = [];
      let missingTransactionFields = [];
      let priorDraftMessage = '';
      const evidenceClaims = new Set();
      for (const outputProposal of proposedList) {
        const proposed = recoverMissingAmountEvidence(outputProposal, amountRecoverySources, allEntities);
        if (proposed.kind !== 'transaction.create') assertV3ProposalIntent(proposed.kind, request.message, { entities: allEntities });
        if (proposed.kind === 'transaction.create') {
          if (proposed.fields.amount != null) validateAmountEvidence(proposed, proposed.fields.amount, userTurns, allEntities);
          const sourceTurn = proposed.evidence?.sourceTurn, sourceText = userTurns[sourceTurn] || '';
          const prior = actualDrafts.find(draft => ['pending', 'reviewed', 'committed'].includes(draft.status)
            && draft.sourceText && draft.sourceText.includes(egress.scrub(sourceText)) && sourceText);
          if (prior && sourceTurn !== userTurns.length - 1 && /核对|草稿|修改|再|入账/.test(request.message)) {
            priorDraftMessage = prior.status === 'committed' ? '这笔已经有入账回执，请查看原记录；新交易请另发完整原话。'
              : '这笔已经有草稿，请在原卡片核对或修改；本次没有重复生成。';
            continue;
          }
          // Legacy conversations may predate persisted pending intent. Permit a
          // direct payment/date reply only to their immediately preceding,
          // unfinished user transaction, never arbitrary historical money.
          const latestPrior = priorUserTurns.at(-1);
          const legacySupplement = !pendingTransactions && sourceTurn === userTurns.length - 2
            && latestPrior?.user === sourceText && ['unknown', 'failed'].includes(latestPrior.status)
            && /支付|付的|尾号|借记卡|信用卡|现金|微信|支付宝/.test(request.message)
            && !/查|看|统计|分析|多少|哪|图|比例|支出|收入|花了|买了|[?？]/.test(request.message)
            && ['record'].includes(buildTaskContext({ message: sourceText, today: userTurnDates[sourceTurn] || todayShanghai(now()) })?.mode);
          const currentRecord = taskContext?.mode === 'record' && sourceTurn === userTurns.length - 1;
          const pendingSupplement = taskContext?.mode === 'pending-supplement' && pendingTransactions;
          if (!currentRecord && !pendingSupplement && !legacySupplement) throw new AiError('本轮未要求记录或续接这笔交易，不能自动生成历史草稿', 403, 'AI_ACTION_NOT_ALLOWED');
        }
        requiredActions.add(proposed.kind);
        if (!runtime(userId).businessPolicy?.actions.includes(proposed.kind)) throw new AiError('此业务动作尚未开放', 403, 'AI_ACTION_NOT_ALLOWED');
        const domain = KIND_DOMAIN[proposed.kind.split('.')[0]];
        if (domain) { requiredDomains.add(domain); await authorize([...requiredDomains]); }
        const fields = { ...proposed.fields };
        // These two JSON scalar spellings are equivalent protocol values, not inferred user intent.
        if (proposed.kind === 'transaction.create') {
          if (fields.direction === '0') fields.direction = 0;
          else if (fields.direction === '1') fields.direction = 1;
        }
        for (const [external, internal, kind] of [['accountRef', 'accountId', 'card'], ['categoryRef', 'categoryId', 'category'], ['fundRef', 'fundId', 'fund'],
          ['targetRef', 'targetId', proposed.kind.startsWith('todo.') ? 'todo' : proposed.kind.startsWith('card.') ? 'card' : 'fixedAsset']]) {
          if (Object.hasOwn(fields, external)) {
            fields[internal] = await resolve(fields[external], kind);
            if (proposed.kind !== 'transaction.create' && ['targetRef', 'fundRef'].includes(external)
              && fields[internal] && !uniqueBusinessTarget(fields[external], kind, snapshots, request.message, isRejectedAccountSelection)) fields[internal] = null;
            delete fields[external];
          }
        }
        const amount = proposed.kind === 'transaction.create' ? fields.amount : proposed.kind === 'budget.create' ? fields.budgetAmount : proposed.kind === 'fixedAsset.create' ? fields.buyPrice : null;
        if (amount != null) validateAmountEvidence(proposed, amount, userTurns, allEntities);
        if (proposed.kind === 'transaction.create') {
          const evidenceClaim = hash({ sourceTurn: proposed.evidence?.sourceTurn, quote: proposed.evidence?.quote, amount: fields.amount });
          if (evidenceClaims.has(evidenceClaim)) throw new AiError('多笔交易重复引用同一金额来源，请逐笔写明不同交易片段', 400, 'AI_TRANSACTION_EVIDENCE_MISMATCH');
          evidenceClaims.add(evidenceClaim);
          const sourceText = userTurns[proposed.evidence?.sourceTurn] || request.message;
          if (SPECIAL_ACCOUNTING.test(`${sourceText} ${request.message} ${fields.remark || ''}`)) throw new AiError('特殊账务不通过普通记账草稿处理', 403, 'AI_ACTION_NOT_ALLOWED');
          if (fields.accountId) {
            const candidates = [...new Map(snapshots.flatMap(snapshot => snapshot.rawChoices?.cards || []).map(row => [row.id, row])).values()];
            const selected = candidates.find(row => row.id === fields.accountId);
            const sourceUtterances = userTurns.slice(proposed.evidence.sourceTurn);
            const rejected = isRejectedAccountSelection(selected, sourceUtterances, candidates);
            const named = !rejected && (isExplicitSelectedAccount(selected, candidates, accountSelectionUtterances(sourceUtterances, candidates),
              { allowBareTail: Boolean(pendingTransactions) }) || explicitUniqueAccountSelection(selected, candidates, sourceUtterances));
            const paymentTypes = { 现金: ['virtual_cash'], 微信: ['virtual_wechat'], 支付宝: ['virtual_alipay'],
              余额: ['virtual_cash', 'virtual_wechat', 'virtual_alipay', 'virtual_balance'], 银行卡: ['debit', 'credit'] };
            const matching = candidates.filter(row => (paymentTypes[fields.payMethod] || []).includes(row.type));
            if (!selected || rejected || (!named && (matching.length !== 1 || matching[0].id !== selected.id))) {
              fields.accountId = null;
            }
          }
          if (!fields.amount || ![0, 1].includes(fields.direction) || fields.currency !== 'CNY' || !fields.transDate || !fields.accountId || !fields.categoryId || !fields.payMethod) {
            const missingFields = [...(!fields.amount ? ['金额'] : []), ...(![0, 1].includes(fields.direction) ? ['收支方向'] : []),
              ...(fields.currency !== 'CNY' ? ['人民币币种'] : []), ...(!fields.transDate ? ['日期'] : []), ...(!fields.accountId ? ['账户'] : []), ...(!fields.categoryId ? ['分类'] : []), ...(!fields.payMethod ? ['支付方式'] : [])];
            missingTransactionFields = [...new Set([...missingTransactionFields, ...missingFields])];
            transactionIntents.push({ fields, evidence: proposed.evidence, missingFields });
            continue;
          }
          if (conversation.latestDraftId) {
            const prior = actualDrafts.find(draft => ['pending', 'reviewed', 'committed'].includes(draft.status)
              && draft.sourceText?.includes(egress.scrub(sourceText)));
            if (prior) {
              priorDraftMessage = prior.status === 'committed' ? '这笔已经有入账回执，请查看原记录；新交易请另发完整原话。' : '这笔已经有草稿，请在原卡片核对或修改；本次没有重复生成。';
              continue;
            }
          }
          const hasDateEvidence = proposed.evidence.dateSourceTurn != null || proposed.evidence.dateQuote != null;
          let dateSourceTurn = proposed.evidence.sourceTurn, dateText = sourceText;
          if (hasDateEvidence) {
            dateSourceTurn = proposed.evidence.dateSourceTurn;
            dateText = proposed.evidence.dateQuote;
            if (!Number.isInteger(dateSourceTurn) || dateSourceTurn < proposed.evidence.sourceTurn || !dateText || !userTurns[dateSourceTurn]?.includes(dateText)) throw new AiError('日期补充须明确引用交易发生同轮或之后的用户原话', 400, 'AI_DATE_NOT_EXPLICIT');
          }
          validateDateEvidence(fields.transDate, dateText, userTurnDates[dateSourceTurn], todayShanghai(now()));
          if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(fields.amount) || !/[1-9]/.test(fields.amount)) throw new AiError('普通人民币收支须正数金额且最多到分', 400, 'AI_AMOUNT_INVALID');
          fields.remark ??= '';
          transactionInputs.push({ fields, evidence: proposed.evidence, missingFields: [],
            message: userTurns.slice(proposed.evidence.sourceTurn).join('\n').slice(0, 1500) });
          transactionIntents.push(transactionInputs.at(-1));
        } else {
          if (proposed.kind === 'fund.returnBatch' && fields.entries) {
            if (!Array.isArray(fields.entries) || !fields.entries.length || fields.entries.length > 31 || new Set(fields.entries.map(entry => entry.date)).size !== fields.entries.length) throw new AiError('日收益明细格式无效', 400, 'AI_AMOUNT_NOT_EXPLICIT');
            for (const entry of fields.entries) {
              const sourceTurn = userTurns.findIndex(text => text.includes(entry.date));
              const line = userTurns[sourceTurn]?.split(/[\n；;]/).find(text => text.includes(entry.date));
              if (!line) throw new AiError('收益日期和金额必须逐条来自用户原话', 400, 'AI_AMOUNT_NOT_EXPLICIT');
              validateAmountEvidence({ evidence: { sourceTurn, quote: line } }, entry.amount, userTurns, allEntities);
            }
          }
          const source = snapshots.findLast(snapshot => snapshot.scope.domains.includes(domain));
          // Null optional metadata is omitted; mandatory omissions remain visible in the shared typed proposal card.
          for (const key of Object.keys(fields)) if (fields[key] == null && !['targetId', 'fundId'].includes(key)) delete fields[key];
          // fixedAsset.create is prefill-only. If the model invents
          // tag/useYears/residualRate/buyDate to satisfy the six required
          // fields, normalizeBusinessFields rejects the whole proposal before
          // the actionUnavailable guidance card can render. Keep only the two
          // user-supplied fields; the server then reports missingFields and
          // emits the guidance card that the client contract requires.
          if (proposed.kind === 'fixedAsset.create') {
            for (const key of Object.keys(fields)) if (!['info', 'buyPrice'].includes(key)) delete fields[key];
          }
          businessInputs.push({ kind: proposed.kind, fields, source: 'user-readonly', conversationId: conversation.id,
            previewId: source?.previewId || null, sourceDigest: hash({ requestId: request.requestId, promptVersion, message: request.message, toolTrace }),
            check: connection => authorize([...new Set([...disclosed, ...(domain ? [domain] : [])])], connection) });
        }
      }
      // A batch is reviewed together. Keep incomplete intent as a clarification,
      // never persist only its complete members or fail an ordinary missing-account turn.
      const pendingContinuation = taskContext?.mode === 'pending-supplement' && pendingTransactions;
      const incompleteBatch = pendingContinuation && !pendingBatchCoverage(pendingTransactions, transactionIntents).complete;
      if (incompleteBatch && !missingTransactionFields.length) missingTransactionFields = ['完整的交易信息'];
      if (clarificationOnly && !missingTransactionFields.length && !incompleteBatch) throw new AiError('待补充意图必须有缺项，完整交易请使用草稿协议', 502, 'AI_INVALID_RESULT');
      if (!missingTransactionFields.length && !clarificationOnly) for (const input of transactionInputs) {
        status({ stage: 'drafting' });
        preparedTransactions.push(await legacyService.prepareTransactionProposal(userId, input.fields,
          { message: input.message, conversationId: conversation.id, budget }));
      }
      const pinnedPending = taskContext?.mode === 'pending-supplement' ? pinPendingTransactionSupplement(pendingContext,
        { message: request.message, sourceDate: todayShanghai(now()), turnId: request.requestId, conversationId: conversation.id, now }) : pendingContext;
      const nextPendingContext = cancelledPending ? clearPendingTransactionContext({ conversationId: conversation.id, turnId: request.requestId, now })
        : incompleteBatch ? pinnedPending : missingTransactionFields.length
        ? buildPendingTransactionContext({ transactions: transactionIntents, userTurns, userTurnDates, userTurnIds,
          previous: pinnedPending, conversationId: conversation.id, turnId: request.requestId, now })
        : transactionInputs.length || priorDraftMessage
          ? clearPendingTransactionContext({ conversationId: conversation.id, turnId: request.requestId, now })
          : currentTurnIntent.topicReset ? clearPendingTransactionContext({ conversationId: conversation.id, turnId: request.requestId, now }) : pendingContext;
      const buildResult = artifacts => {
        finalResponseValidation = responseValidation.forResult({ artifacts, datasets: readDatasets,
          memoryReceipts, memoryReadReceipts, memorySearchReceipts, memoryErrors });
        finalMemoryClaims = { receipts: memoryReceipts, readReceipts: memoryReadReceipts,
          searchReceipts: memorySearchReceipts, errors: memoryErrors, explicitOnly: finalResponseValidation.memoryExplicitOnly };
        finalReasoningScrub = text => finalResponseValidation.privateSources ? egress.scrub(text) : egress.scrubText(text);
        return assembleTurnResult({ modelAnswer: output.answer, chart, chartNote,
        relaxedMode, openMode, request, sentAt, currentTurnIntent, topicBoundary, responseLanguage, scopeText, conversationId: conversation.id,
        responseValidation: finalResponseValidation,
        calculations,
        scenarioMessage: scenarioContexts.join('\n'),
        ...(searchAttempts ? { answerScrub: text => scrubWithCitations(text, value => egress.scrub(value), [...searchSources.values()]) } : {}),
        promptVersion, promptDigest, contractDigest, disclosureBytes, usage, budget,
        maxProviderCalls: MAX_PROVIDER_CALLS, toolTrace, readDatasets, transactionIntents, businessInputs,
        proposedList, priorDraftMessage, missingTransactionFields, incompleteBatch, cancelledPending,
        clarificationOnly, asksDraftStatus, actualDrafts, actualArtifacts, nextPendingContext, pendingTransactions,
        queryContext, taskContext, queryTaskBindings, storedTaskContexts, storedCoverage, contextSummary,
        currentQueryGoals, queryInputs, financeBindings, missingFresh, memoryReceipts, memoryReadReceipts,
        memorySearchReceipts, memoryErrors, failedTools, egress, now }, artifacts);
      };
      await authorize();
      if (preparedTransactions.length) return legacyService.persistTransactionBatch(userId, preparedTransactions,
        { conversationId: conversation.id, budget, buildResult, assertAuthorization: connection => authorize([...requiredDomains], connection) });
      // Non-transaction proposal creation and chat/recovery append use the same transaction.
      if (typeof executor.getConnection !== 'function') throw new AiError('AI 结果保存必须支持事务', 503, 'AI_TRANSACTION_REQUIRED');
      return persistResult([]);
      async function persistResult(artifacts) {
        const conn = await executor.getConnection();
        try {
          await conn.beginTransaction();
          await authorize([...requiredDomains], conn);
          if (businessInputs.length) {
            const proposal = await proposals.create(userId, businessInputs[0], conn);
            const choices = {};
            for (const snapshot of snapshots) for (const [group, rows] of Object.entries(snapshot.snapshot.choices || {})) {
              choices[group] = [...(choices[group] || []), ...rows.map(row => row.ref ? { ...row, id: snapshot.refMap[row.ref]?.id } : row)].filter(row => !row.ref || row.id);
            }
            artifacts = [{ proposal: { ...proposal, choices } }];
          }
          if (actualArtifacts) {
            actualArtifacts = await loadConversationArtifactState({ executor: conn, userId, conversationId: conversation.id, now });
            budget.check();
          }
          const { result, appendPayload } = buildResult(artifacts);
          await initial.conversationStore.append(userId, conversation.id, appendPayload, conn);
          await initial.requestGuard.saveV3Recovery(conn, userId, request.requestId, result);
          await authorize([...requiredDomains], conn); budget.check(); await conn.commit();
          return result;
        } catch (error) { await conn.rollback().catch(() => {}); throw error; }
        finally { conn.release(); }
      }
    });
    return run.then(async result => {
      void settleAuxiliary(terminalActivity('completed'));
      if (typeof emit === 'function') for (const event of verifiedReasoningEvents(reasoningRounds, result,
        { scope: finalResponseValidation?.claimsScope || 'business', memoryClaims: finalMemoryClaims,
          ...(finalReasoningScrub ? { scrub: finalReasoningScrub } : {}) })) {
        try { emit('reasoning', event); } catch (_) { /* Delivery cannot undo a committed result. */ }
      }
      // Profile refresh has its own bounded model budget and never delays chat delivery.
      if (profileGeneration?.maybeGenerate) void Promise.resolve().then(() => profileGeneration.maybeGenerate(userId))
        .catch(error => record({ userId, requestId: request.requestId, lane: 'profile', phase: 'refresh',
          status: 'error', errorCode: error?.code || 'AI_PROFILE_FAILED' }));
      return result;
    }).catch(async error => {
      const terminalWrites = [terminalActivity('failed', { code: error.code || 'AI_REQUEST_FAILED',
        message: error instanceof AiError ? error.message : '本轮处理未完成，请查看请求回执。' })];
      const memoryNotice = [memoryFailureNotice(memoryReceipts), memoryDeleteFailureNotice(memoryReceipts)].filter(Boolean).join('\n');
      if (memoryNotice && typeof error?.message === 'string' && !error.message.includes(memoryNotice)) error.message += ' ' + memoryNotice;
      if (error?.code === 'AI_INVALID_RESULT' && !validationLogged && lastProviderRound != null) {
        logModelValidationFailure(error, { requestId: request.requestId, conversationId: conversationRef?.id,
          model: initial.config.model, round: lastProviderRound, stage: validationStage, content: lastModelContent }, privateSecrets);
      }
      // 负责人要求：处理失败/中止的轮次也进入服务端历史；下一轮会带着这条原话作为记忆。
      // Before open(), only an owner/input-bound durable failed receipt may
      // reconstruct the parent. Temporary refusals and rejected retry claims
      // never gain a fabricated history row. Confirmation is auxiliary too.
      if (typeof initial.conversationStore.appendFailure === 'function') {
        const appendFailure = (conversationId, authority) => initial.conversationStore.appendFailure(userId, conversationId, {
            message: request.message, notice: authority?.error?.message || error?.message || '本次请求未完成，请稍后重试。',
            requestId: request.requestId, errorCode: authority?.error?.code || error?.code || 'AI_REQUEST_FAILED',
            sentAt,
            ...(topicBoundary ? { topicBoundary } : {}),
            ...(retryClaimed ? { retryOf: request.retryOf } : {}),
            providerDetail: error?.providerDetail,
            authorizationRequest: error?.authorizationRequest, mode: request.mode,
            taskContexts: upsertTaskContext(storedTaskContexts, taskContext ? finalizeTaskContext(taskContext, { status: 'failed', turnId: request.requestId, errorCode: error?.code }) : null),
            queryCoverage: storedCoverage, contextSummary,
            ...(taskContext ? { taskContext: finalizeTaskContext(taskContext, { status: 'failed', turnId: request.requestId, errorCode: error?.code }) } : {}),
            ...(queryContext ? { queryContext: finalizeQueryContext(queryContext, { status: 'failed', turnId: request.requestId, errorCode: error?.code }) } : {}),
          });
        if (conversationRef) terminalWrites.push(Promise.resolve().then(() => appendFailure(conversationRef.id)).catch(() => {}));
        else if (request.conversationId && typeof initial.requestGuard.failureForInput === 'function'
          && !['AI_REQUEST_BUSY', 'AI_RATE_LIMIT', 'AI_REQUEST_CONFLICT'].includes(error?.code) && !String(error?.code || '').startsWith('AI_RETRY_')) {
          terminalWrites.push(Promise.resolve().then(async () => {
            const authority = await initial.requestGuard.failureForInput(userId, request.requestId, { lane: 'v3-chat', input: request });
            if (authority?.status === 'failed') await appendFailure(request.conversationId, authority);
          }).catch(() => { /* Failed confirmation or history cannot replace the original error. */ }));
        }
      }
      // Fast failure history is ready before a normal retry. Slow writes keep
      // their request/retry identity and finish in the background after delivery.
      await settleAuxiliary(Promise.all(terminalWrites), options.signal);
      throw error;
    });
  }
  return { chat, session: async (...args) => ({ ...await shared.session(...args), contractVersion: 3 }),
    getProposal: (...args) => shared.getProposal(...args), editProposal: (...args) => shared.editProposal(...args),
    actOnProposal: (...args) => shared.actOnProposal(...args), executeProposal: (...args) => shared.executeProposal(...args),
    close: async () => { if (liveRepository) await liveRepository.close(); } };
}
module.exports = { createV3Service, turnTimeoutMs, validateAmountEvidence, validateChart, buildQueryAnswer, withScopePolicy, MAX_PROVIDER_CALLS, MAX_TOOLS, MAX_TOOL_BYTES, MAX_DISCLOSURE_BYTES };
