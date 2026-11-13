// 追加169：从 v3Service.js createV3Service 闭包内提取的答复组装阶段（buildResult 函数体逐字搬移，零逻辑变化）。
// 输入 = facts（调用点在 v3Service 内显式逐名枚举的轮内事实快照，惰性求值）+ artifacts（本轮产物）；
// 输出 = { result, appendPayload }。声明校验（assertResultClaims）仍在本函数内、
// 于授权复验与 saveV3Recovery/commit 之间执行——四段顺序不变。
// withScopePolicy 对 readDatasets 的原地换元保持同一数组引用（result.datasets === 传入数组）。
const { AiError } = require('./errors');
const { todayShanghai } = require('./validation');
const { assertResultClaims } = require('./v3Claims');
const { reconcileMemoryClaims } = require('./memoryClaims');
const { normalizeSavedStateClaims, queryCoverageProse, readableQueryProse, hasProvenEmptyQuery } = require('./queryCoverageProse');
const { buildProvenEmptyQueryFacts } = require('./queryEmptyFacts');
const { normalizeAccountDisplayOrder } = require('./queryDisplayOrder');
const { cardLimitChartNotice, cardLimitChartExplanation } = require('./queryCardLimitChartNotice');
const { queryChartPresentation } = require('./queryChartCoverage');
const { queryRangeProse } = require('./queryRangeProse');
const { normalizeQueryTimestampDisplay } = require('./queryTimestampDisplay');
const { attachQueryResults, finalizeQueryContext } = require('./queryContext');
const { finalizeTaskContext } = require('./taskContext');
const { upsertTaskContext, attachQueryCoverage } = require('./contextState');
const { selectQueryTaskBinding } = require('./queryTaskBindings');
const { buildQueryAnswer, withScopePolicy } = require('./v3AnswerPresentation');
const { buildOperationOutcome } = require('./operationOutcome');
const { limitAnswer } = require('./responseValidation');
const { conversationArtifactStateAnswer } = require('./conversationArtifacts');
const { sanitizeChatNumbers, buildPublishedNumberFacts } = require('./chatNumericEvidence');
const { normalizeInstallmentRemainingClaims } = require('./queryInstallmentStateClaims');
const { summarizePendingTransactionTask } = require('./pendingTransactions');

// Mixed turns pass the model prose through the query-number filter, which drops
// sentences quoting a draft amount. Restate the card state as server-authored
// text so the answer never loses the draft confirmation.
function artifactConfirmation(drafts, candidates) {
  const parts = [];
  if (drafts.length === 1) {
    const draft = drafts[0];
    const amount = typeof draft?.amount === 'string' && draft.amount
      ? `（${draft.direction === 1 ? '收入' : '支出'} ${draft.amount} 元）` : '';
    parts.push(`已生成 1 张草稿${amount}，请在卡片中核对后确认入账。`);
  } else if (drafts.length > 1) {
    parts.push(`已生成 ${drafts.length} 张草稿，请在卡片中逐笔核对后确认入账。`);
  }
  if (candidates.length) {
    parts.push(candidates.length === 1 ? '已生成 1 张待补充卡片，请补齐必填项后核对。'
      : `已生成 ${candidates.length} 张待补充卡片，请补齐必填项后核对。`);
  }
  return parts.join('');
}

function assembleTurnResult(facts, artifacts) {
  const { modelAnswer, chart, chartNote, relaxedMode, openMode, request, sentAt, currentTurnIntent, topicBoundary, responseLanguage, scopeText,
    conversationId, promptVersion, promptDigest, contractDigest, disclosureBytes, usage, budget,
    maxProviderCalls, toolTrace, readDatasets, transactionIntents, businessInputs, proposedList,
    priorDraftMessage, missingTransactionFields, incompleteBatch, cancelledPending,
    asksDraftStatus, actualDrafts, actualArtifacts, nextPendingContext, pendingTransactions, queryContext, taskContext,
    queryTaskBindings, storedTaskContexts, storedCoverage, contextSummary, currentQueryGoals, queryInputs,
    financeBindings, missingFresh, memoryReceipts, memoryReadReceipts, memorySearchReceipts, memoryErrors,
    failedTools, egress, now, answerScrub, calculations = [], scenarioMessage = '', responseValidation = { claimsScope: 'business', memoryExplicitOnly: false, privateSources: true } } = facts;

  const drafts = artifacts.filter(item => item.draft).map(item => item.draft), candidates = artifacts.filter(item => item.inputCandidate);
  const operationOutcome = buildOperationOutcome(artifacts);
  const memoryClaim = reconcileMemoryClaims(modelAnswer, { receipts: memoryReceipts, readReceipts: memoryReadReceipts,
    searchReceipts: memorySearchReceipts, errors: memoryErrors, explicitOnly: responseValidation.memoryExplicitOnly });
  // Validate only model-originated completion claims against this transaction's actual artifacts.
  // V3 chat creates reviewable proposals, so it has no current business-execution receipt.
  const artifactStatusAnswer = actualArtifacts && !artifacts.length && !transactionIntents.length && !businessInputs.length
    && toolTrace.every(item => ['history_search', 'history_read', 'memory_list', 'memory_read', 'memory_search'].includes(item.tool))
    ? conversationArtifactStateAnswer(actualArtifacts, responseLanguage) : '';
  const priorStatusAnswer = artifactStatusAnswer || (asksDraftStatus && !artifacts.length && !transactionIntents.length && !businessInputs.length
    && !toolTrace.some(item => item.tool === 'query_data') && actualDrafts.length === 1 && actualDrafts[0].status !== 'unknown'
    ? ({ committed: '这笔已有入账回执。', pending: '这笔草稿仍待核对，尚未入账。', reviewed: '这笔草稿已核对，仍需确认入账。',
      discarded: '这笔草稿已放弃。' })[actualDrafts[0].status] : '');
  if (!artifacts.length && !proposedList.length && readDatasets.length) {
    memoryClaim.businessClaimsText = normalizeSavedStateClaims(memoryClaim.businessClaimsText, readDatasets);
    memoryClaim.answer = normalizeSavedStateClaims(memoryClaim.answer, readDatasets);
  }
  if (!priorDraftMessage && !priorStatusAnswer && !missingTransactionFields.length) assertResultClaims(memoryClaim.businessClaimsText,
    { artifacts, currentReceipts: [], scope: responseValidation.claimsScope });
  if (!artifacts.length && readDatasets.length)
    memoryClaim.answer = normalizeInstallmentRemainingClaims(memoryClaim.answer, readDatasets);
  // A needs_input card means nothing was created. Never let the model
  // claim "已整理成草稿/请确认入库" when the rendered card is 财务核查.
  const needsInputCard = artifacts.some(item => item.inputCandidate || item.financialCheck?.status === 'needs_input');
  const batchClarification = nextPendingContext?.status === 'awaiting_input' && nextPendingContext.items.length > 1
    ? `已保留这 ${nextPendingContext.items.length} 笔交易：${nextPendingContext.items.map(item =>
      `${item.fields.remark || (item.fields.direction === 0 ? '支出' : '收入')} ${item.fields.amount} 元`).join('；')}。` +
      (missingTransactionFields[0] === '账户' ? '请确认支付账户（卡片名称或尾号），我再生成草稿。'
        : `请补充${missingTransactionFields[0]}，我再生成草稿。`) : '';
  const baseAnswer = cancelledPending ? '已取消本批待补充记账。' : priorDraftMessage || priorStatusAnswer || (incompleteBatch
    ? `原来的 ${pendingTransactions.transactionCount} 笔交易尚未全部核对，本次未生成草稿，已保留整批待补信息。请确认这些交易都使用同一支付账户。`
    : missingTransactionFields.length ? batchClarification || `请补充${missingTransactionFields[0]}，我再给你完整草稿。` :
    needsInputCard ? '本轮信息还不完整，请在下方卡片补齐必填项后再核对；当前没有可入账的草稿。' : memoryClaim.answer);
  const queryOnly = !artifacts.length && !priorDraftMessage && !missingTransactionFields.length &&
    toolTrace.some(item => item.tool === 'query_data') && readDatasets.length > 0;
  const emptyFacts = queryOnly ? buildProvenEmptyQueryFacts(readDatasets, { message: request.message, toolTrace,
    activeMetric: queryContext?.activeQuery?.metric }) : '';
  // Mixed turns still carry query rows: rebuild/verify their prose against the
  // approved datasets instead of publishing unverified model numbers.
  const numericProse = relaxedMode && (responseValidation.businessRead || readDatasets.length > 0)
    ? sanitizeChatNumbers(answerScrub ? answerScrub(memoryClaim.answer) : egress.scrub(memoryClaim.answer),
      { datasets: readDatasets, calculations, sourceMessage: request.message, scenarioMessage })
    : { answer: memoryClaim.answer, changed: false };
  const needsNumericFallback = numericProse.changed || (relaxedMode && responseValidation.businessRead && !numericProse.answer.trim());
  const checkedOpenAnswer = needsNumericFallback ? [numericProse.answer,
    buildPublishedNumberFacts(readDatasets, { language: responseLanguage })].filter(Boolean).join('\n\n') ||
      (responseLanguage === 'en' ? 'There are no verified figures to support that conclusion yet.' : '目前没有足够的已核对数值支持这个结论。') : numericProse.answer;
  const shaped = artifactStatusAnswer || (relaxedMode ? checkedOpenAnswer
    : readDatasets.length ? normalizeAccountDisplayOrder((queryOnly && !currentTurnIntent?.auxiliaryRequest ? emptyFacts : '') || buildQueryAnswer(baseAnswer, readDatasets, queryContext, taskContext, queryTaskBindings,
      { preserveAuxiliary: currentTurnIntent?.auxiliaryRequest === true }), readDatasets)
    : baseAnswer);
  // A deterministic query formatter may replace model prose. The memory
  // outcome is a separate observed effect and must survive that replacement.
  const memoryOutcome = currentTurnIntent?.memoryOperation === 'write' && (memoryReceipts.length || memoryErrors.length)
    ? reconcileMemoryClaims(responseLanguage === 'en' ? 'Long-term memory was saved in this turn.' : '本轮已保存到长期记忆。',
      { receipts: memoryReceipts, errors: memoryErrors }).answer : '';
  if (queryOnly) withScopePolicy(readDatasets, scopeText);
  const artifactNotice = readDatasets.length && !relaxedMode && artifacts.length && !/草稿|待补充/.test(shaped)
    ? artifactConfirmation(drafts, candidates) : '';
  const coverage = queryOnly && (/数据范围|匹配数量|匹配总数|展示数量|记录总数|共有多少|多少条|展示几条|(?:每|各)(?:个)?部分[^。！？]{0,40}(?:范围|数量)/.test(request.message)
    || hasProvenEmptyQuery(readDatasets))
    ? queryCoverageProse(readDatasets) : '';
  const limitBasis = queryOnly ? cardLimitChartNotice({ message: request.message, chart, datasets: readDatasets,
    goals: currentQueryGoals, queryInputs, today: todayShanghai(now()) }) : '';
  const displayProse = limitBasis ? cardLimitChartExplanation(shaped) : shaped;
  const chartPresentation = queryOnly && !relaxedMode ? queryChartPresentation({ prose: displayProse, chart, datasets: readDatasets,
    message: request.message, language: responseLanguage }) : { prose: displayProse, notice: '' };
  const prose = queryOnly && !relaxedMode ? readableQueryProse(chartPresentation.prose, readDatasets) : chartPresentation.prose;
  const displayed = [memoryOutcome && !/记忆|偏好|\bmemor(?:y|ies)\b/i.test(prose) ? memoryOutcome : '', prose,
    artifactNotice, chartPresentation.notice, limitBasis, coverage, chartNote, queryRangeProse(readDatasets)].filter(Boolean).join('\n\n');
  const generatedText = queryOnly ? normalizeQueryTimestampDisplay(displayed, readDatasets) : displayed;
  // Server-rendered labels are still user-originated text. Check the complete
  // composed answer too, so a fallback name cannot reintroduce a rejected sum.
  const displayText = relaxedMode && (responseValidation.businessRead || readDatasets.length > 0)
    ? sanitizeChatNumbers(answerScrub ? answerScrub(generatedText) : egress.scrub(generatedText),
      { datasets: readDatasets, calculations, sourceMessage: request.message, scenarioMessage }).answer ||
      (responseLanguage === 'en' ? 'There are no verified figures to support that conclusion yet.' : '目前没有足够的已核对数值支持这个结论。')
    : generatedText;
  const answer = answerScrub ? limitAnswer(answerScrub(displayText))
    : responseValidation.privateSources ? egress.scrub(displayText) : limitAnswer(egress.scrubText(displayText));
  if (!answer.trim()) throw failedTools.values().next().value || new AiError('模型未返回可用答复', 502, 'AI_INVALID_RESULT');
  const result = { contractVersion: 3, answer, conversationId: conversationId, datasets: readDatasets, chart,
    ...(nextPendingContext?.status === 'awaiting_input' ? { pendingTask: summarizePendingTransactionTask(nextPendingContext,{conversationId,now}) } : {}),
    ...(openMode ? { mode: request.mode } : {}),
    ...(artifacts.length > 1 ? { ...(drafts.length ? { drafts } : {}), ...(candidates.length ? { candidates } : {}) } : artifacts[0] || {}),
    operationOutcome, toolTrace, promptVersion, promptDigest, contractDigest, disclosureBytes,
    request: { requestId: request.requestId, providerCalls: budget.calls, maxProviderCalls, usage,
      ...(request.retryOf ? { retryOf: request.retryOf } : {}) },
  };
  const business = { contractVersion: 3, datasets: result.datasets, chart: result.chart, operationOutcome, toolTrace, promptVersion,
    ...(openMode ? { mode: request.mode } : {}),
    promptDigest, contractDigest, disclosureBytes, request: result.request,
    ...(nextPendingContext ? { pendingTransactions: nextPendingContext } : {}),
    ...(result.proposal ? { proposal: result.proposal } : {}), ...(result.inputCandidate ? { inputCandidate: result.inputCandidate, financialCheck: result.financialCheck, financialChoices: result.financialChoices } : {}),
    // A mixed result uses arrays in result, so its one candidate is not also
    // present in result.inputCandidate. Persist every multi-card identity,
    // including singleton groups, for read-only history restoration.
    ...(artifacts.length > 1 && drafts.length ? { draftIds: drafts.map(draft => draft.id) } : {}),
    ...(artifacts.length > 1 && candidates.length ? { candidateIds: candidates.map(candidate => candidate.inputCandidate.id) } : {}) };
  const savedContext = queryContext ? finalizeQueryContext(attachQueryResults(queryContext, readDatasets,
    { turnId: request.requestId }), { status: financeBindings.length && !readDatasets.some(dataset => dataset.domain === 'finance')
      ? 'pending' : 'succeeded', turnId: request.requestId }) : null;
  const savedTask = taskContext ? finalizeTaskContext(taskContext, { status: nextPendingContext?.status === 'awaiting_input' ? 'awaiting_input'
    : missingFresh.some(goal => goal.task.targetDatasetId === taskContext.targetDatasetId) ? 'pending' : 'succeeded', turnId: request.requestId }) : null;
  return { result, appendPayload: { message: request.message, answer, draft: drafts[0] || null, business, sentAt,
    ...(topicBoundary ? { topicBoundary, queryContext: savedContext } : {}),
    ...(savedTask ? { taskContext: savedTask } : {}), taskContexts: queryTaskBindings.reduce((registry, binding) =>
      upsertTaskContext(registry, finalizeTaskContext(binding.taskContext, {
        status: readDatasets.some(dataset => selectQueryTaskBinding(queryTaskBindings, dataset.datasetId) === binding) ? 'succeeded' : 'pending',
        turnId: request.requestId })),
    upsertTaskContext(storedTaskContexts, savedTask)),
    queryCoverage: attachQueryCoverage(storedCoverage, readDatasets, { turnId: request.requestId, queryInputs }), contextSummary,
    ...(savedContext ? { queryContext: savedContext } : {}), requestId: request.requestId,
    ...(request.retryOf ? { retryOf: request.retryOf } : {}) } };
}

module.exports = { assembleTurnResult };
