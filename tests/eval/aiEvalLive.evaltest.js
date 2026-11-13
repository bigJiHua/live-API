// §5 C 黄金评测集 · live 档：真实供应商 × 隔离只读库 live_ai_test。
// 门控：仅 AI_EVAL_LIVE=1 运行（不设则整体 skip，常规回归不烧 token）。
// Key 不落地明文：从正式库 live_dev 的 ai_provider_profile 只读复制密文行（优先
// .env AI_MODEL 对应行，回退最新激活行），服务经同一 .env 密钥源解密后直连供应商。
// 每次运行按 provider/model 分版本落报告 api/logs/REVIEW_<日期>_AI_EVAL_<model>.md。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { TEST_DB, TEST_USER, rebuildDatabase, grantReadOnly, seedFixtures, buildServer } = require('../real/harness');
const { liveDates, seedLiveDomains, liveCase, groundedAnswer, containsExpectedPoints, verifiedCalcReceipts } = require('./liveFixtures');

const envText = fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8');
const fileEnv = require('dotenv').parse(envText);
const SOURCE_DB = process.env.AI_EVAL_SOURCE_DB || fileEnv.AI_EVAL_SOURCE_DB || fileEnv.DB_NAME || 'live_dev';
const PROFILE_USER = process.env.AI_EVAL_PROFILE_USER || fileEnv.AI_EVAL_PROFILE_USER || '';
const PREFERRED_MODEL = process.env.AI_EVAL_MODEL || fileEnv.AI_EVAL_MODEL || fileEnv.AI_MODEL || '';
process.env.DB_NAME = TEST_DB;
process.env.AI_DB_NAME = TEST_DB;
process.env.JWT_SECRET = fileEnv.JWT_SECRET || process.env.JWT_SECRET;

jest.setTimeout(600000);
const liveTest = process.env.AI_EVAL_LIVE === '1' ? test : test.skip;
const uuid = () => crypto.randomUUID();
const allCases = fs.readFileSync(path.join(__dirname, 'cases/golden-cases.jsonl'), 'utf8').split(/\r?\n/)
  .filter(line => line.trim()).map(line => JSON.parse(line));
const requestedCases = (process.env.AI_EVAL_CASES || '').split(',').map(id => id.trim()).filter(Boolean);
if (requestedCases.some(id => !allCases.some(item => item.id === id))) throw new Error('AI_EVAL_CASES 包含未知用例');
const cases = requestedCases.length ? allCases.filter(item => requestedCases.includes(item.id)) : allCases;

const hasCJK = text => /[\u4e00-\u9fff]/.test(text);
let dbPool, server, profile, dates, searchEnabled = false, results = [];
async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${pathname}`, { method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': TEST_USER },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return response;
}
async function runCase(caseDef) {
  const started = Date.now();
  if (caseDef.requiresSearch && !searchEnabled) return { id: caseDef.id, answer: '', tools: [], skipped: true,
    skipReason: 'AI_SEARCH_* 未配置完整，未调用搜索源或模型', latencyMs: 0 };
  // 真实流程：服务端建会话 → 会话级授权（operate 覆盖 read+草稿准备，正式提交仍需确认）→ 跑问句。
  const sessionResponse = await api('/v3/session', { method: 'POST', body: { kind: 'manual' } });
  const sessionText = await sessionResponse.text();
  let sessionPayload = null; try { sessionPayload = JSON.parse(sessionText); } catch (_) { /* 非 JSON */ }
  const conversationId = sessionPayload?.data?.conversationId;
  if (!conversationId) return { id: caseDef.id, answer: '', tools: [], error: `会话创建失败 HTTP ${sessionResponse.status} body=${sessionText.slice(0, 200)}`, latencyMs: Date.now() - started };
  const grantResponse = await api('/grant', { method: 'PUT', body: { providerHost: new URL(profile.provider_host).host,
    conversationId, lifetime: '24h', access: 'operate' } });
  if (grantResponse.status !== 200) {
    const grantText = await grantResponse.text();
    return { id: caseDef.id, answer: '', tools: [], error: `会话授权失败 HTTP ${grantResponse.status}: ${grantText.slice(0, 160)}`, latencyMs: Date.now() - started };
  }
  const requestId = uuid();
  const requestBody = { requestId, message: caseDef.message, conversationId,
    mode: caseDef.scene === 'operate' ? 'operate' : 'chat', consent: true };
  const response = await api('/v3/chat/stream', { method: 'POST', body: requestBody });
  if (response.status !== 200) {
    const text = await response.text();
    return { id: caseDef.id, answer: '', tools: [], error: `HTTP ${response.status}: ${text.slice(0, 200)}`, latencyMs: Date.now() - started };
  }
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const event = {}, lines = block.split('\n');
    for (const line of lines) {
      if (line.startsWith('event: ')) event.name = line.slice(7).trim();
      if (line.startsWith('data: ')) { try { event.data = JSON.parse(line.slice(6)); } catch (_) { event.raw = line.slice(6); } }
    }
    if (event.name) events.push(event);
  }
  const done = events.find(event => event.name === 'done');
  const error = events.find(event => event.name === 'error');
  const result = done?.data?.data || {};
  const datasetsJson = JSON.stringify(result.datasets || []);
  const answer = String(result.answer || '');
  const tools = (result.toolTrace || []).map(entry => entry.tool);
  let calcReceipts = [];
  const calcTraces = (result.toolTrace || []).filter(trace => trace.tool === 'calculate' && trace.records === 1);
  if (calcTraces.length) for (let attempt = 0; attempt < 3; attempt++) {
    const [rows] = await dbPool.execute(`SELECT status,response_payload FROM ai_call_log
      WHERE user_id=? AND request_id=? AND phase='tool' AND tool_name='calculate' AND status='ok'`, [TEST_USER, requestId]);
    calcReceipts = verifiedCalcReceipts(rows, calcTraces);
    if (calcReceipts.length >= calcTraces.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const grounded = groundedAnswer(answer, result.datasets || [], caseDef, result, calcReceipts);
  const languageOk = caseDef.expect?.language === 'en' ? !hasCJK(answer)
    : caseDef.expect?.language === 'zh' ? hasCJK(answer) : true;
  const forbiddenOk = (caseDef.expect?.answerNotContains || []).every(needle => !answer.includes(needle));
  const containsOk = containsExpectedPoints(answer, caseDef.expect?.answerContains || [],
    caseDef.id === 'todo-next-month' ? { nextMonth: dates.nextMonth } : {});
  const toolsOk = !caseDef.expect?.tools || JSON.stringify(tools) === JSON.stringify(caseDef.expect.tools);
  const draftOk = !caseDef.expect?.proposalAmount || result.draft?.amount === caseDef.expect.proposalAmount;
  let recoveryOk = false, replayOk = false, historyOk = false, providerCalls = 0;
  const [runCounts] = await dbPool.execute('SELECT provider_calls FROM ai_request_run WHERE user_id=? AND id=?', [TEST_USER, requestId]);
  providerCalls = Number(runCounts[0]?.provider_calls || 0);
  if (done && !error) {
    const receipt1 = await (await api(`/v3/requests/${requestId}`)).json();
    const receipt2 = await (await api(`/v3/requests/${requestId}`)).json();
    const sameAnswer = value => value?.answer === answer && JSON.stringify(value?.datasets || []) === datasetsJson;
    recoveryOk = receipt1.data?.status === 'completed' && receipt2.data?.status === 'completed'
      && sameAnswer(receipt1.data.result) && sameAnswer(receipt2.data.result);
    const [before] = await dbPool.execute('SELECT status,provider_calls FROM ai_request_run WHERE user_id=? AND id=?', [TEST_USER, requestId]);
    providerCalls = Number(before[0]?.provider_calls || 0);
    const replayResponse = await api('/v3/chat', { method: 'POST', body: requestBody });
    const replay = await replayResponse.json();
    const [after] = await dbPool.execute('SELECT status,provider_calls FROM ai_request_run WHERE user_id=? AND id=?', [TEST_USER, requestId]);
    replayOk = replayResponse.status === 200 && sameAnswer(replay.data) && before[0]?.status === 'completed'
      && after[0]?.status === 'completed' && Number(after[0]?.provider_calls) === providerCalls;
    const [messages] = await dbPool.execute("SELECT content FROM ai_message WHERE user_id=? AND conversation_id=? AND role='assistant'", [TEST_USER, conversationId]);
    historyOk = messages.some(row => row.content === answer);
  }
  const checks = { containsOk, forbiddenOk, languageOk, grounded, draftOk, recoveryOk, replayOk, historyOk };
  let failureEvidence = null;
  if (error) {
    try {
      const [audits] = await dbPool.execute(`SELECT phase,error_code,response_payload FROM ai_call_log
        WHERE user_id=? AND request_id=? ORDER BY id DESC LIMIT 20`, [TEST_USER, requestId]);
      const latestProvider = audits.find(row => row.phase === 'provider');
      let payload = null;
      try { payload = JSON.parse(latestProvider?.response_payload || 'null'); } catch (_) {}
      const content = payload?.message?.content || payload?.choices?.[0]?.message?.content || payload?.content || '';
      const calls = payload?.message?.tool_calls || payload?.choices?.[0]?.message?.tool_calls || payload?.tool_calls || [];
      const policy = require('../../src/modules/ai/service/egressPolicy').createEgressPolicy({ userId: TEST_USER, knownIds: [conversationId] });
      failureEvidence = { phases: [...new Set(audits.map(row => row.phase))],
        codes: [...new Set(audits.map(row => row.error_code).filter(Boolean))],
        lastProviderText: policy.scrub(content).slice(0, 2000),
        lastProviderCalls: calls.slice(0, 8).map(call => ({ name: call.function?.name,
          arguments: policy.scrub(call.function?.arguments || '').slice(0, 300) })) };
    } catch (_) { /* Diagnostic capture cannot change an actual failure. */ }
  }
  const fallback = caseDef.final?.answer && answer !== caseDef.final.answer && answer !== caseDef.draft?.answer;
  return { id: caseDef.id, answer, tools, toolsOk, checks, failureEvidence, calcValues: calcReceipts.map(receipt => receipt.value), fallback, error: error?.data?.message || null,
    requestId, conversationId, providerCalls, latencyMs: Date.now() - started, datasetsJsonLength: datasetsJson.length };
}

let base;
liveTest('live 档：真实供应商跑黄金评测集并落基线报告', async () => {
  for (const originalCase of cases) {
    const caseDef = liveCase(originalCase, dates);
    let row;
    try { row = await runCase(caseDef); }
    catch (error) { row = { id: caseDef.id, answer: '', tools: [], error: error.message, latencyMs: -1 }; }
    results.push(row);
    console.log(`[eval-live] ${row.id} → ${row.skipped ? 'SKIP ' + row.skipReason : row.error ? 'ERROR ' + row.error : (Object.values(row.checks || {}).every(Boolean) ? 'PASS' : 'SOFT-FAIL')} ${row.latencyMs}ms`);
  }
  expect(results.length).toBe(cases.length);
  expect(results.filter(row => row.error).map(row => row.id)).toEqual([]);
  expect(results.filter(row => row.checks?.grounded === false).map(row => row.id)).toEqual([]);
  expect(results.filter(row => row.checks && !Object.values(row.checks).every(Boolean)).map(row => row.id)).toEqual([]);
  const seededCases = ['budget-usage', 'todo-future', 'todo-next-month', 'asset-composition', 'fund-holdings',
    'work-salary-history', 'work-rules-current', 'installment-status'];
  expect(results.filter(row => seededCases.includes(row.id) && !row.checks?.containsOk).map(row => row.id)).toEqual([]);
});

afterAll(async () => {
  if (process.env.AI_EVAL_LIVE !== '1') return;
  try {
  if (results.length) {
  const stamp = liveDates(require('../../src/modules/ai/service/validation').todayShanghai()).today;
  const model = (profile?.model || 'unknown').replace(/[^\w.-]/g, '_');
  const reportDirectory = path.resolve(__dirname, '../../../temp/api-logs-archive/ai-eval', stamp);
  fs.mkdirSync(reportDirectory, { recursive: true });
  let reportPath = path.join(reportDirectory, `REVIEW_${stamp}_AI_EVAL_${model}.md`);
  for (let suffix = 2; fs.existsSync(reportPath); suffix++) reportPath = path.join(reportDirectory, `REVIEW_${stamp}_AI_EVAL_${model}_${suffix}.md`);
  const sourceRoot = path.resolve(__dirname, '../../src');
  const sourceFiles = [];
  const collect = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(filename);
    else if (entry.isFile() && filename.endsWith('.js')) sourceFiles.push({ path: path.relative(sourceRoot, filename).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') });
  } };
  collect(sourceRoot); sourceFiles.sort((a, b) => a.path.localeCompare(b.path));
  const sourceDigest = crypto.createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex');
  fs.writeFileSync(reportPath.replace(/\.md$/, '.json'), JSON.stringify({ sourceDigest, sourceFiles,
    providerHost: profile?.provider_host, model: profile?.model, database: TEST_DB, requestedCases, results }, null, 2) + '\n', 'utf8');
  const strict = results.filter(row => row.checks).map(row => Object.values(row.checks).every(Boolean));
  const lines = [
    `# AI 黄金评测集 live 基线报告（${stamp} · ${profile?.model || 'unknown'}）`, '',
    `> provider_host：${profile?.provider_host || 'unknown'} · 用例数：${results.length} · 跳过：${results.filter(row => row.skipped).length} · 严格判定通过：${strict.filter(Boolean).length}/${strict.length}（跳过不计通过）`,
    `> 源码摘要：${sourceDigest} · 实际模型调用：${results.reduce((total, row) => total + (row.providerCalls || 0), 0)}。真实完成回执两读、同请求重放不增加模型调用、SQL历史正文一致纳入严格判定。`,
    `> 范围：${requestedCases.length ? 'AI_EVAL_CASES 定向：' + requestedCases.join(', ') : '全量用例'}。种子日期：${dates?.today || 'unknown'} · 种子版本：live-domains-v2。工具序列仅记录；严格判定：期望要点 / 禁止项 / 语言 / 数字接地 / 草稿金额。fallback 字段仅表示措辞与 scripted 基线不同，不能证明证据门接管。`, '',
    '| id | 工具调用 | 工具序列 | 要点 | 禁止项 | 语言 | 接地 | fallback | 耗时ms | 错误 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(row => `| ${row.id} | ${row.tools.join('→') || '无'} | ${row.checks ? (row.toolsOk ? '✓' : '≠（仅记录）') : 'n/a'} | ${row.checks ? (row.checks.containsOk ? '✓' : '✗') : 'n/a'} | ${row.checks ? (row.checks.forbiddenOk ? '✓' : '✗') : 'n/a'} | ${row.checks ? (row.checks.languageOk ? '✓' : '✗') : 'n/a'} | ${row.checks ? (row.checks.grounded ? '✓' : '✗') : 'n/a'} | ${row.fallback ? '是' : '否'} | ${row.latencyMs} | ${row.skipped ? 'SKIP：' + row.skipReason : row.error || ''} |`), '',
    '## 已核验计算回执', '',
    ...results.filter(row => row.calcValues?.length).map(row => `- ${row.id}：${row.calcValues.join(', ')}（仅成功回执 value；审计与工具trace摘要一致）`), '',
    '## 回执与历史回测', '',
    ...results.filter(row => row.checks).map(row => `- ${row.id}：两读回执=${row.checks.recoveryOk}，同请求重放=${row.checks.replayOk}，SQL历史=${row.checks.historyOk}，模型调用=${row.providerCalls}。`), '',
    '## 失败阶段证据（脱敏）', '',
    ...results.filter(row => row.failureEvidence).map(row => `**${row.id}**：阶段 ${row.failureEvidence.phases.join(', ')}；错误 ${row.failureEvidence.codes.join(', ')}。\n\n${row.failureEvidence.lastProviderText || '未捕获可用终稿正文'}\n\n最后工具请求：${JSON.stringify(row.failureEvidence.lastProviderCalls || [])}`), '',
    '## 答复原文', '',
    ...results.map(row => `**${row.id}**：${row.skipped ? `（跳过）${row.skipReason}` : row.error ? `（错误）${row.error}` : row.answer}`),
  ];
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
  console.log('[eval-live] 报告已落档:', reportPath);
  }
  try {
    await dbPool?.execute('DELETE FROM ai_call_log WHERE user_id=?', [TEST_USER]);
    await dbPool?.execute('DELETE FROM ai_request_run WHERE user_id=?', [TEST_USER]);
    await dbPool?.execute('DELETE FROM ai_request_lane WHERE user_id=?', [TEST_USER]);
    await dbPool?.execute('DELETE FROM ai_conversation WHERE user_id=?', [TEST_USER]);
  } catch (_) { /* 报告已落档，清理失败不影响结论 */ }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await dbPool?.end();
  }
});

beforeAll(async () => {
  if (process.env.AI_EVAL_LIVE !== '1') return;
  if (TEST_DB !== 'live_ai_test' || SOURCE_DB === TEST_DB || !/^[A-Za-z0-9_]+$/.test(SOURCE_DB))
    throw new Error('live 评测隔离库/配置源库无效');
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'AI_DB_HOST', 'AI_DB_PORT', 'AI_DB_USER', 'AI_DB_PASSWORD'])
    if (fileEnv[key] !== undefined) process.env[key] = fileEnv[key];
  // buildServer 的 env 是 process.env；providerEnv 保留站点 AI_SEARCH_* 槽位。
  // 先校验搜索配置，避免配置无效时已经重建隔离库或开始付费模型调用。
  searchEnabled = Boolean(require('../../src/modules/ai/service/config').getConfig({ ...process.env, AI_MODE: 'disabled' }).searchEnabled);
  const admin = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  let source;
  try {
  source = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: SOURCE_DB });
  // 多用户源必须显式指定，单用户 mock 源可安全识别唯一配置所有者。
  const [owners] = PROFILE_USER ? [[{ user_id: PROFILE_USER }]] : await source.execute('SELECT DISTINCT user_id FROM ai_provider_profile');
  if (owners.length !== 1) throw new Error('请显式设置 AI_EVAL_PROFILE_USER：配置源包含零个或多个用户');
  const profileUser = owners[0].user_id;
  // 运行前静态选择一个接入商密文行；不改变运行时供应商。
  const [preferred] = PREFERRED_MODEL ? await source.execute(
    'SELECT provider_host, model, api_key_cipher, key_fingerprint FROM ai_provider_profile WHERE user_id=? AND model=? ORDER BY updated_at DESC LIMIT 1', [profileUser, PREFERRED_MODEL]) : [[]];
  const [fallback] = preferred.length ? [[]] : await source.execute(
    'SELECT provider_host, model, api_key_cipher, key_fingerprint FROM ai_provider_profile WHERE user_id=? AND is_active=1 ORDER BY updated_at DESC LIMIT 1', [profileUser]);
  profile = preferred[0] || fallback[0];
  if (!profile) throw new Error('正式库无可用接入商密文行，无法执行 live 评测');
  if (process.env.AI_EVAL_PROVIDER_HOST && new URL(profile.provider_host).host !== process.env.AI_EVAL_PROVIDER_HOST)
    throw new Error('实际供应商主机与 AI_EVAL_PROVIDER_HOST 不一致，未重建隔离库或调用模型');
  const schemaPool = await rebuildDatabase(admin);
  await schemaPool.end();
  await grantReadOnly(admin);
  dbPool = await mysql.createPool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: TEST_DB, connectionLimit: 10 });
  const fixture = await seedFixtures(dbPool, new URL(profile.provider_host).host, profile.provider_host);
  dates = await seedLiveDomains(dbPool, fixture);
  await dbPool.execute('UPDATE ai_provider_profile SET model=?, api_key_cipher=?, key_fingerprint=? WHERE user_id=?',
    [profile.model, profile.api_key_cipher, profile.key_fingerprint, TEST_USER]);
  // 会话级授权由每用例的 PUT /grant 真实链路完成（等价于浏览器授权弹窗），不预播种。
  process.env.AI_MODE = 'deepseek';
  process.env.AI_SYNTHETIC_DATA = 'false';
  process.env.INIT_SKIP = 'true';
  const built = await buildServer();
  server = built.server; base = built.base;
  console.log(`[eval-live] provider=${profile.provider_host} model=${profile.model} cases=${cases.length}`);
  } finally { await source?.end(); await admin.end(); }
});
