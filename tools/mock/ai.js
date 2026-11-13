'use strict';

// Synthetic history only. No provider calls, background work, or live leases.
const AI_TABLES = [
  'bus_ai_draft', 'ai_conversation', 'ai_message', 'ai_analysis_preview',
  'ai_business_proposal', 'ai_background_job', 'ai_request_run', 'ai_request_lane',
  'ai_transaction_candidate', 'ai_data_grant', 'ai_provider_setting',
  'ai_provider_profile', 'ai_call_log', 'ai_user_preference', 'ai_chat_activity',
  'ai_config',
];

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function sqlTimestamp(stamp) {
  return new Date(Number(stamp) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

function storedDate(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10)
    : /^\d{13}$/.test(text) ? sqlTimestamp(Number(text)).slice(0, 10) : '';
}

module.exports = function generateAi(ctx) {
  const before = Object.fromEntries(AI_TABLES.map(table => [table, (ctx.rows[table] || []).length]));
  const providerHost = 'https://mock-provider.example.invalid/v1';
  const fakeKey = 'mock-not-a-real-provider-key';
  const connectionId = ctx.id('ai:disabled-provider-connection');
  const initial = Number(ctx.at(ctx.start, '08:00:00'));
  const final = Number(ctx.at(ctx.end, '20:00:00'));
  let messageId = (ctx.rows.ai_message || []).length;
  let logId = (ctx.rows.ai_call_log || []).length;
  let committedDrafts = 0;
  let seededProposals = 0;
  const financial = ctx.rows.account || [];
  const todos = ctx.rows.todo || [];
  const diaries = ctx.rows.moment || [];

  ctx.add('ai_provider_setting', {
    id: 1, provider_host: providerHost, model: 'mock-demonstration-only',
    api_key_cipher: ctx.encrypt(fakeKey, 'ai:provider-setting'),
    key_fingerprint: ctx.digest(fakeKey).slice(0, 16), connection_id: connectionId,
    created_at: initial, updated_at: final,
  });
  ctx.add('ai_provider_profile', {
    id: 1, connection_id: connectionId, name: '演示接入商（合成数据、未启用）',
    provider_host: providerHost, model: 'mock-demonstration-only',
    api_key_cipher: ctx.encrypt(fakeKey, 'ai:provider-profile'),
    key_fingerprint: ctx.digest(fakeKey).slice(0, 16), is_active: 0,
    created_at: initial, updated_at: final,
  });
  ctx.add('ai_data_grant', {
    id: 1, provider_host: 'mock-provider.example.invalid', domains: '[]',
    granted_at: initial, revoked_at: initial + 1000,
    update_time: ctx.datetime(ctx.end, '20:00:00'),
  });
  ctx.add('ai_user_preference', {
    thinking_enabled: 0, update_time: ctx.datetime(ctx.end, '20:00:00'),
  });
  ctx.add('ai_request_lane', {
    active_request_id: null, locked_until: 0, request_count: 0, window_start: 0,
    updated_at: String(final),
  });
  ctx.add('ai_config', {
    id: 1, daily_provider_calls: null, max_usage_tokens: null, max_output_tokens: null,
    provider_timeout_ms: null, turn_timeout_ms: null, history_tokens: null,
    updated_at: final,
  });

  function message(conversationId, role, content, stamp, draftId = null, meta = null) {
    ctx.add('ai_message', {
      id: ++messageId, conversation_id: conversationId, role, content,
      draft_id: draftId, meta, created_at: sqlTimestamp(stamp),
    });
  }

  for (const month of ctx.months) {
    const monthDays = ctx.days.filter(day => day.startsWith(month));
    if (!monthDays.length) continue;
    const record = financial.find(row => storedDate(row.trans_date).startsWith(month)
      && Number(row.direction) === 0 && !Number(row.is_deleted)
      && !row.transfer_group_id && row.category_id !== 'CATEGORY_REPAY');
    const date = record ? storedDate(record.trans_date) : monthDays[0];
    const recordStamp = record && Number.isFinite(Number(record.create_time))
      ? Number(record.create_time) : Number(ctx.at(date, '12:00:00'));
    const created = Math.max(Number(ctx.at(date, '00:05:00')), recordStamp - 120000);
    const finished = recordStamp + 1000;
    const conversationId = ctx.id('ai:conversation:' + month);
    const requestId = ctx.id('ai:local-draft-request:' + month);
    const candidateId = ctx.id('ai:candidate:' + month);
    const previewId = ctx.id('ai:preview:' + month);
    const draftId = record ? ctx.id('ai:draft:' + month) : null;
    const monthEnd = monthDays[monthDays.length - 1];
    const original = record
      ? `【演示合成】请记录 ${date} 的这笔 ${record.remark || '日常消费'}，金额 ${record.amount} ${record.currency || 'CNY'}；本条与 mock 流水一致。`
      : `【演示合成】查看 ${monthDays[0]} 至 ${monthEnd} 的生活记录；本轮不调用外部模型。`;
    const candidatePayload = {
      source: 'user-readonly', conversationId, originalText: original,
      fields: record ? {
        direction: Number(record.direction), amount: String(record.amount),
        currency: record.currency || 'CNY', transDate: date,
        categoryId: record.category_id, accountId: record.card_id,
        payMethod: record.pay_method, remark: record.remark || '',
      } : {},
      trace: [{ synthetic: true, source: 'mock.seed', recordId: record ? record.id : null }],
      eligible: Boolean(record), synthetic: true,
    };
    const inputDigest = ctx.digest(canonical(candidatePayload));
    const isOldCandidate = final - created > 90 * 86400000;

    ctx.add('ai_conversation', {
      id: conversationId, latest_draft_id: draftId,
      session_kind: 'manual', session_day: date,
      created_at: sqlTimestamp(created), updated_at: ctx.datetime(date, '21:00:03'),
    });
    ctx.add('ai_analysis_preview', {
      id: previewId, digest: ctx.digest(canonical({ synthetic: true, month, startDate: monthDays[0], endDate: monthEnd })),
      payload: 'expired', created_at: created, expires_at: created + 900000,
      approved_at: null, request_id: null,
    });
    ctx.add('ai_transaction_candidate', {
      id: candidateId, source: 'user-readonly', conversation_id: conversationId,
      request_id: requestId, source_fingerprint: ctx.digest('mock:candidate:' + month),
      input_digest: inputDigest,
      payload: isOldCandidate ? 'expired' : ctx.encrypt(JSON.stringify(candidatePayload), 'ai:candidate:' + month),
      status: record ? 'consumed' : 'discarded', draft_id: draftId,
      created_at: created, expires_at: created + 900000,
    });
    if (record) {
      ctx.add('bus_ai_draft', {
        id: draftId, direction: Number(record.direction), amount: String(record.amount),
        currency: record.currency || 'CNY', trans_date: date,
        category_id: record.category_id, account_id: record.card_id,
        pay_method: record.pay_method, remark: record.remark || '',
        status: 'committed', version: 3, missing_fields: [],
        trace_snapshot: [{ synthetic: true, source: 'mock.seed', sourceCandidateId: candidateId, recordId: record.id }],
        source: 'synthetic', original_text: original, conversation_id: conversationId,
        committed_record_id: record.id, expires_at: created + 900000,
        committed_at: sqlTimestamp(recordStamp), created_at: sqlTimestamp(created),
        updated_at: sqlTimestamp(recordStamp),
      });
      committedDrafts += 1;
    }
    const receipt = record ? {
      synthetic: true, kind: 'account.mockSeed', recordId: record.id,
      draftId, status: 'seeded', providerCalls: 0,
    } : { synthetic: true, status: 'discarded', providerCalls: 0 };
    message(conversationId, 'user', original, created, draftId);
    message(conversationId, 'assistant', record
      ? `【演示合成】此草稿已关联导入的 mock 流水：${date}，${record.amount} ${record.currency || 'CNY'}。这是预生成的历史回执，外部模型调用次数为 0。`
      : `【演示合成】本轮展示范围为 ${monthDays[0]} 至 ${monthEnd}，没有新增交易，也没有调用外部模型。`,
    finished, draftId, { synthetic: true, receipt, range: { startDate: monthDays[0], endDate: monthEnd } });
    ctx.add('ai_request_run', {
      id: requestId, lane: 'local-draft', input_digest: ctx.digest(canonical({ message: original, synthetic: true })),
      status: 'completed', provider_calls: 0, max_provider_calls: 0,
      created_at: created, deadline_at: created + 300000,
      expires_at: finished + 86400000, result_payload: null, error_code: null,
    });
    ctx.add('ai_chat_activity', {
      request_id: requestId, conversation_id: conversationId,
      execution_token: ctx.id('ai:execution-token:' + month),
      message_payload: ctx.encrypt(original, 'ai:activity:' + month),
      status: 'completed', stage: 'completed', error_code: null,
      notice: '演示合成历史，未调用外部模型。',
      created_at: created, updated_at: finished, deadline_at: created + 300000,
    });
    ctx.add('ai_call_log', {
      id: ++logId, request_id: requestId, conversation_id: conversationId,
      lane: 'local-draft', phase: 'commit', provider_host: null, model: null,
      thinking_enabled: 0, tool_name: null,
      request_payload: JSON.stringify({ synthetic: true, message: original, date }),
      response_payload: JSON.stringify(receipt),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: 0, status: 'ok', error_code: null, http_status: null,
      origin: 'system', created_at: finished,
    });

    const todo = todos.find(row => !Number(row.is_deleted) && storedDate(row.happen_date).startsWith(month));
    const diary = diaries.find(row => !Number(row.is_deleted) && storedDate(row.create_time).startsWith(month));
    const proposalStamp = Number(ctx.at(date, '20:00:00'));
    for (const [kind, target] of [['todo.create', todo], ['diary.create', diary]]) {
      const proposalId = ctx.id('ai:proposal:' + kind + ':' + month);
      const fields = kind === 'todo.create' ? {
        content: target ? target.content : `【演示合成】${month} 月度整理`,
        eventType: 'schedule', happenDate: target ? storedDate(target.happen_date) : date,
        priority: target ? Number(target.priority || 2) : 2, needRemind: false,
        isRecurring: false, remark: '',
      } : {
        content: target ? String(target.content).replace(/<[^>]*>/g, '') : `【演示合成】${month} 生活小结。`,
        mood: '平静', date: target ? storedDate(target.create_time) : date,
      };
      const proposalReceipt = target ? {
        kind, recordId: target.id, synthetic: true, seeded: true,
        completed: true, providerCalls: 0,
      } : null;
      // Committed means the linked object exists in this generated dataset;
      // the receipt explicitly identifies seeding instead of a live AI action.
      ctx.add('ai_business_proposal', {
        id: proposalId, kind,
        payload: { fields, missingFields: [], schemaVersion: 2, policyVersion: 1,
          sourceDigest: ctx.digest('mock:proposal:' + kind + ':' + month), synthetic: true },
        source: 'user-readonly', conversation_id: conversationId, preview_id: null,
        status: target ? 'committed' : 'discarded', version: target ? 3 : 2,
        expires_at: proposalStamp + 900000, receipt: proposalReceipt,
        target_snapshot: null, created_at: String(proposalStamp), updated_at: String(proposalStamp + 1000),
      });
      if (target) seededProposals += 1;
      message(conversationId, 'user', `【演示合成】核对 ${month} 的${kind === 'todo.create' ? '待办' : '日记'}历史提案。`, proposalStamp);
      message(conversationId, 'assistant', target
        ? `【演示合成】历史提案已关联本次预生成的${kind === 'todo.create' ? '待办' : '日记'}记录。没有执行外部模型调用。`
        : '【演示合成】此历史提案已丢弃，没有产生业务记录。',
      proposalStamp + 1000, null, { synthetic: true, proposal: { id: proposalId, kind }, receipt: proposalReceipt });
    }

    const backupStamp = Number(ctx.at(date, '21:00:00'));
    const backupProposalId = ctx.id('ai:backup-proposal:' + month);
    const jobId = ctx.id('ai:backup-job:' + month);
    const backupRequestId = ctx.id('ai:backup-request:' + month);
    const backupReceipt = {
      kind: 'system.backup', jobRef: jobId, status: 'failed', completed: false,
      synthetic: true, executed: false, errorCode: 'MOCK_NOT_EXECUTED',
    };
    const backupOriginal = '【演示合成】核对一条备份未执行的历史状态，用于演示失败回执。';
    ctx.add('ai_business_proposal', {
      id: backupProposalId, kind: 'system.backup',
      payload: { fields: {}, missingFields: [], schemaVersion: 2, policyVersion: 1,
        sourceDigest: ctx.digest(backupOriginal), synthetic: true },
      source: 'user-readonly', conversation_id: conversationId, preview_id: null,
      status: 'discarded', version: 2, expires_at: backupStamp + 900000,
      receipt: backupReceipt, target_snapshot: null,
      created_at: String(backupStamp), updated_at: String(backupStamp + 1000),
    });
    ctx.add('ai_background_job', {
      id: jobId, proposal_id: backupProposalId, status: 'failed', worker_id: null,
      receipt: backupReceipt, error_message: 'MOCK_NOT_EXECUTED：演示合成，实际备份未执行，未产生文件。',
      created_at: String(backupStamp), updated_at: String(backupStamp + 1000),
    });
    ctx.add('ai_request_run', {
      id: backupRequestId, lane: 'business-chat', input_digest: ctx.digest(canonical({ message: backupOriginal })),
      status: 'failed', provider_calls: 0, max_provider_calls: 0,
      created_at: backupStamp, deadline_at: backupStamp + 300000,
      expires_at: backupStamp + 86400000, result_payload: null, error_code: 'MOCK_NOT_EXECUTED',
    });
    ctx.add('ai_chat_activity', {
      request_id: backupRequestId, conversation_id: conversationId,
      execution_token: ctx.id('ai:backup-token:' + month),
      message_payload: ctx.encrypt(backupOriginal, 'ai:backup-activity:' + month),
      status: 'failed', stage: 'failed', error_code: 'MOCK_NOT_EXECUTED',
      notice: '演示合成：备份未实际执行，未产生文件。',
      created_at: backupStamp, updated_at: backupStamp + 1000, deadline_at: backupStamp + 300000,
    });
    ctx.add('ai_call_log', {
      id: ++logId, request_id: backupRequestId, conversation_id: conversationId,
      lane: 'business-chat', phase: 'gate', provider_host: null, model: null,
      thinking_enabled: 0, tool_name: null,
      request_payload: JSON.stringify({ message: backupOriginal, synthetic: true }),
      response_payload: JSON.stringify(backupReceipt), usage: null,
      duration_ms: 0, status: 'error', error_code: 'MOCK_NOT_EXECUTED',
      http_status: null, origin: 'system', created_at: backupStamp + 1000,
    });
    message(conversationId, 'user', backupOriginal, backupStamp);
    message(conversationId, 'assistant', '【演示合成】备份未执行，未产生任何备份文件。失败回执用于界面演示。',
      backupStamp + 1000, null, { synthetic: true, failure: { code: 'MOCK_NOT_EXECUTED' }, receipt: backupReceipt });
  }

  const counts = Object.fromEntries(AI_TABLES.map(table => [table, (ctx.rows[table] || []).length - before[table]]));
  const summary = {
    source: 'synthetic', providerCalls: 0, providerEnabled: false,
    committedDrafts, seededProposals, counts,
    note: 'AI 历史为演示合成；关联本次 mock 业务对象，无实际模型调用或备份执行。',
  };
  ctx.meta.ai = summary;
  return summary;
};
