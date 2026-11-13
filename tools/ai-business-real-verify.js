// Real SQL acceptance only. Never load app.js, invoke a provider, perform DDL,
// start a backup, or commit business/test data. Nested commits are savepoints.
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getConfig } = require('../src/modules/ai/service/config');
const { createBusinessReadRepository, DOMAINS } = require('../src/modules/ai/service/businessRead');
const { createAiBusinessActions } = require('../src/common/services/aiBusinessActions');
const { createBusinessProposalStore } = require('../src/modules/ai/service/businessProposals');
const { createRequestGuard } = require('../src/modules/ai/service/requestGuard');
const { createPreviewStore } = require('../src/modules/ai/service/analysisPreviews');
const { todayShanghai } = require('../src/modules/ai/service/validation');
const { toScaledInteger, scaledToString } = require('../src/common/utils/decimal');
const Fund = require('../src/modules/fund/model');
const uid = () => crypto.randomUUID();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

async function main() {
  const config = getConfig();
  assert.equal(config.dataSource, 'user-readonly');
  const conn = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost',port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',password: process.env.DB_PASSWORD || '',database: process.env.DB_NAME || 'live',
    connectTimeout: 5000,multipleStatements: false,dateStrings: true,decimalNumbers: false });
  const readPool = mysql.createPool({ ...config.db,connectionLimit: 2,multipleStatements: false,connectTimeout: 5000,decimalNumbers: false,dateStrings: true });
  let diagnostic = null, phase = 'schema', activeDomain = null, rolledBack = false, started = false, sequence = 0, tail = Promise.resolve(), unexpectedSideEffects = 0;
  const checks = [], readDomains = [];
  const readAdapter = { getConnection: async () => {
    const read = await readPool.getConnection(), original = read.execute.bind(read);
    read.execute = async (sql,params) => { try { return await original(sql,params); } catch (cause) {
      diagnostic = { domain: activeDomain,code: cause.code || 'AI_SQL_READ_FAILED',column: /Unknown column '([^']+)'/.exec(cause.sqlMessage || '')?.[1],
        tables: [...String(sql.sql || sql).matchAll(/(?:FROM|JOIN)\s+([A-Za-z_0-9]+)/gi)].map(match => match[1]) };
      throw cause;
    } };
    return read;
  } };
  const repository = createBusinessReadRepository({ executor: readAdapter });
  const executor = { execute: (...args) => conn.execute(...args),getConnection: async () => {
    let unlock;
    const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous;
    const name = `ai_real_${++sequence}`;
    return { execute: (...args) => conn.execute(...args),query: (...args) => conn.query(...args),
      beginTransaction: () => conn.query(`SAVEPOINT ${name}`),commit: () => conn.query(`RELEASE SAVEPOINT ${name}`),
      rollback: () => conn.query(`ROLLBACK TO SAVEPOINT ${name}`),release: () => unlock() };
  } };
  const forbiddenBackup = { getRunningTask: () => null,getTaskStatus: () => null,
    createSystemBackupTask: async () => { unexpectedSideEffects++; throw new Error('Real backups forbidden'); } };
  const actions = createAiBusinessActions({ backupManager: forbiddenBackup,schedule: () => { unexpectedSideEffects++; throw new Error('Backup scheduling forbidden'); } });
  const proposals = createBusinessProposalStore({ executor,actions });
  let allTables, before;
  async function snapshot() {
    const result = {};
    for (const table of allTables) {
      assert.match(table, /^[A-Za-z_0-9]+$/);
      const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
      const rowHashes = rows.map(row => crypto.createHash('sha256').update(JSON.stringify(Object.keys(row).sort().map(key => [key,row[key]]))).digest('hex')).sort();
      result[table] = { rows: rows.length,digest: crypto.createHash('sha256').update(rowHashes.join('\n')).digest('hex') };
    }
    return result;
  }
  async function executeProposal(userId,kind,fields) {
    phase = `${kind}:create`;
    const created = await proposals.create(userId,{ kind,fields });
    phase = `${kind}:review`;
    const checked = await proposals.act(userId,created.id,created.version,'review');
    phase = `${kind}:execute`;
    const committed = await proposals.execute(userId,created.id,checked.version);
    assert.equal(committed.status,'committed'); assert.equal(committed.receipt.kind,kind);
    return { proposal: committed,reviewedVersion: checked.version,receipt: committed.receipt };
  }
  try {
    const [schema] = await conn.execute('SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.ok(schema.every(row => row.engine === 'InnoDB'),'Every test table must support rollback');
    allTables = schema.map(row => row.name).sort();
    const formal = allTables.filter(table => !/^ai_|^bus_ai_draft$|^_migrations$/.test(table));
    const [owners] = await conn.execute('SELECT DISTINCT user_id FROM account WHERE is_deleted=0 LIMIT 2');
    const userId = process.env.AI_TEST_USER_ID || (owners.length === 1 ? owners[0].user_id : null);
    assert.ok(userId,'An explicit test owner is required');
    const grantConn = await readPool.getConnection();
    try {
      const [grants] = await grantConn.query('SHOW GRANTS');
      const privileges = grants.map(row => String(Object.values(row)[0]).split(' ON ')[0].replace(/^GRANT /,''));
      assert.ok(privileges.every(value => value === 'USAGE' || value.split(', ').every(p => p === 'SELECT')),'AI data connection must be SELECT only');
    } finally { grantConn.release(); }
    before = await snapshot();
    for (const domain of DOMAINS) {
      activeDomain = domain;
      phase = `read:${domain}`;
      const data = await repository.query(userId,{ domains: [domain] });
      assert.ok(data.datasets.every(dataset => dataset.domain === domain && dataset.rows.length <= 100 && dataset.asOf));
      const absent = await repository.query('ai_real_absent_owner',{ domains: [domain] });
      assert.ok(absent.datasets.every(dataset => dataset.rows.length === 0),'Another identity must not return owned rows');
      readDomains.push({ domain,datasets: data.datasets.length,passed: true });
    }
    checks.push('ten-real-readonly-domains','absent-user-isolation','read-limit-and-source-metadata');
    await conn.beginTransaction(); started = true;
    const today = todayShanghai(), stamp = String(Date.now());
    phase = 'preview:prepare-revoke-and-send-cas';
    const previewStore = createPreviewStore({ executor });
    const previewSnapshot = await repository.query(userId,{ domains: ['finance'] });
    const previewInput = { message: '真实SQL取消边界验收，不调用模型',scope: previewSnapshot.scope,snapshot: previewSnapshot,
      connectionId: 'local-cancel-fixture',provider: 'local-no-provider' };
    const cancelled = await previewStore.prepare(userId,previewInput);
    await assert.rejects(previewStore.revoke('ai_real_absent_owner',cancelled.previewId),cause => cause.status === 404);
    assert.deepEqual(await previewStore.revoke(userId,cancelled.previewId),{ previewId: cancelled.previewId,revoked: true });
    assert.equal((await previewStore.get(userId,cancelled.previewId)).approvedAt,-1);
    await assert.rejects(previewStore.approveAndGet(userId,cancelled.previewId,true),cause => cause.status === 410 && cause.code === 'AI_PREVIEW_CANCELLED');
    await assert.rejects(previewStore.toProvider(userId,cancelled.previewId),cause => cause.status === 410 && cause.code === 'AI_PREVIEW_CANCELLED');
    const cardRef = cancelled.choices.cards[0]?.ref;
    if (cardRef) await assert.rejects(previewStore.resolve(userId,cancelled.previewId,cardRef,'card'),cause => cause.status === 410 && cause.code === 'AI_PREVIEW_CANCELLED');
    const [cancelledCAS] = await conn.execute('UPDATE ai_analysis_preview SET request_id=? WHERE id=? AND user_id=? AND expires_at>? AND request_id IS NULL AND approved_at>=0',
      [uid(),cancelled.previewId,userId,Date.now()]); assert.equal(cancelledCAS.affectedRows,0);
    const sentPreview = await previewStore.prepare(userId,previewInput); await previewStore.approveAndGet(userId,sentPreview.previewId,true);
    const [sentCAS] = await conn.execute('UPDATE ai_analysis_preview SET request_id=? WHERE id=? AND user_id=? AND expires_at>? AND request_id IS NULL AND approved_at>=0',
      [uid(),sentPreview.previewId,userId,Date.now()]); assert.equal(sentCAS.affectedRows,1);
    await assert.rejects(previewStore.revoke(userId,sentPreview.previewId),cause => cause.status === 409 && cause.code === 'AI_PREVIEW_ALREADY_SENT');
    checks.push('real-preview-revoke-stops-approval-externalization-and-ref-lookup','cancelled-preview-send-cas-zero-rows','already-sent-preview-revoke-denied');
    const budget = await executeProposal(userId,'budget.create',{ title: 'AI回滚验收预算',budgetType: '行',budgetAmount: '39.91',cycle: '月',planDate: today,notes: '仅外层事务验收' });
    const [budgetRows] = await conn.execute('SELECT budget_amount,used_amount,is_excute FROM budget WHERE id=? AND user_id=?',[budget.receipt.recordId,userId]);
    assert.equal(budgetRows[0].budget_amount,'39.91'); assert.equal(budgetRows[0].used_amount,'0.00'); assert.equal(Number(budgetRows[0].is_excute),0);
    assert.equal((await proposals.execute(userId,budget.proposal.id,budget.reviewedVersion)).receipt.recordId,budget.receipt.recordId);
    checks.push('budget-39.91-exact-no-ledger-write','duplicate-action-receipt');
    let eventDate = new Date(Date.parse(today) + 200*86400000).toISOString().slice(0,10);
    const todo = await executeProposal(userId,'todo.create',{ content: 'AI回滚验收提醒',eventType: 'birthday',happenDate: eventDate,priority: 2,needRemind: true,remindDays: 1,isRecurring: true,remark: '外层回滚' });
    await executeProposal(userId,'todo.update',{ targetId: todo.receipt.recordId,content: 'AI回滚验收提醒修改',priority: 1,needRemind: false,isRecurring: false });
    await executeProposal(userId,'todo.complete',{ targetId: todo.receipt.recordId,status: '已完成' });
    await executeProposal(userId,'todo.delete',{ targetId: todo.receipt.recordId });
    const [todoRows] = await conn.execute('SELECT status,is_deleted,priority,need_remind,is_recurring FROM todo WHERE id=? AND user_id=?',[todo.receipt.recordId,userId]);
    assert.equal(todoRows[0].status,'已完成'); assert.equal(Number(todoRows[0].is_deleted),1); assert.equal(Number(todoRows[0].need_remind),0);
    checks.push('todo-create-update-complete-delete');
    const diary = await executeProposal(userId,'diary.create',{ content: 'AI回滚验收日记\n<img src=x onerror=alert(1)>',mood: '平静',date: today });
    const [diaryRows] = await conn.execute('SELECT content,mood,visible_type,parent_id FROM moment WHERE id=? AND user_id=?',[diary.receipt.recordId,userId]);
    assert.ok(!diaryRows[0].content.includes('<img')); assert.equal(JSON.parse(diaryRows[0].mood),'平静'); assert.deepEqual(JSON.parse(diaryRows[0].visible_type),{ vt: 0,vs: 0,pw: 0 }); assert.ok(diaryRows[0].parent_id);
    checks.push('diary-private-today-html-escaped');
    const [cards] = await conn.execute("SELECT id,alias,credit_limit,temp_limit,bill_day,repay_day FROM card_base WHERE user_id=? AND is_deleted=0 AND card_type NOT LIKE 'virtual_%' AND id NOT IN ('xxxx','yyyy') LIMIT 1",[userId]);
    assert.equal(cards.length,1,'A real nonvirtual card is required');
    const financialCard = { credit_limit: cards[0].credit_limit,temp_limit: cards[0].temp_limit,bill_day: cards[0].bill_day,repay_day: cards[0].repay_day };
    await executeProposal(userId,'card.metadata',{ targetId: cards[0].id,alias: 'AI回滚验收卡片别名' });
    const [changedCards] = await conn.execute('SELECT credit_limit,temp_limit,bill_day,repay_day FROM card_base WHERE id=? AND user_id=?',[cards[0].id,userId]); assert.deepEqual(changedCards[0],financialCard);
    await assert.rejects(proposals.create(userId,{ kind: 'card.metadata',fields: { targetId: cards[0].id,creditLimit: '1000' } }),e => e.code === 'AI_ACTION_NOT_ALLOWED');
    await assert.rejects(proposals.create(userId,{ kind: 'card.metadata',fields: { targetId: 'xxxx',alias: '禁止' } }),e => [403,404].includes(e.status));
    checks.push('card-metadata-excludes-financial-fields-and-virtual-accounts');
    const [assets] = await conn.execute('SELECT id,buy_price,now_val,total_deprec,last_deprec_date FROM fixed_asset WHERE user_id=? AND is_deleted=0 LIMIT 1',[userId]);
    let assetId = assets[0]?.id;
    if (!assetId) {
      assetId = uid();
      await conn.execute(`INSERT INTO fixed_asset (id,user_id,info,tag,img_url,buy_price,now_val,use_years,use_months,residual_rate,residual_val,month_deprec,total_deprec,buy_date,last_deprec_date,create_time,status,is_deleted)
        VALUES (?,?,?,?,'about:blank',100,100,'1',12,5,5,7.92,0,?,?,?,'using',0)`,[assetId,userId,'AI临时回滚验收资产','验收',today,today,today]);
    }
    const [assetBefore] = await conn.execute('SELECT buy_price,now_val,total_deprec,last_deprec_date FROM fixed_asset WHERE id=? AND user_id=?',[assetId,userId]);
    await executeProposal(userId,'fixedAsset.update',{ targetId: assetId,info: 'AI回滚验收资产名称',tag: '回滚验收' });
    const [assetAfter] = await conn.execute('SELECT buy_price,now_val,total_deprec,last_deprec_date FROM fixed_asset WHERE id=? AND user_id=?',[assetId,userId]); assert.deepEqual(assetAfter,assetBefore);
    await executeProposal(userId,'fixedAsset.delete',{ targetId: assetId }); await executeProposal(userId,'fixedAsset.restore',{ targetId: assetId });
    await executeProposal(userId,'fixedAsset.delete',{ targetId: assetId }); await executeProposal(userId,'fixedAsset.permanentDelete',{ targetId: assetId });
    const prefill = await proposals.create(userId,{ kind: 'fixedAsset.create',fields: { info: '只预填资产' } }); assert.equal(prefill.actionUnavailable,true);
    await assert.rejects(proposals.act(userId,prefill.id,prefill.version,'review'),e => e.code === 'AI_ACTION_NOT_ALLOWED');
    checks.push('asset-metadata-and-lifecycle-without-depreciation','asset-create-prefill-only');
    const [funds] = await conn.execute('SELECT id FROM fund WHERE user_id=? AND is_deleted=0 LIMIT 1',[userId]);
    let fundId = funds[0]?.id;
    if (!fundId) { fundId = uid(); await conn.execute("INSERT INTO fund (id,user_id,fund_name,share,invest,net_value,market_val,rate,create_time,is_deleted) VALUES (?,?,?,1,100,0,100,'0.00%',?,0)",[fundId,userId,'AI临时回滚验收基金',stamp]); }
    const [historyDates] = await conn.execute('SELECT record_date FROM bus_fund_history WHERE fund_id=?',[fundId]);
    const usedDates = new Set(historyDates.map(row => String(row.record_date).slice(0,10))), available = [];
    for (let i=0; i<366 && available.length<2; i++) { const d = new Date(Date.parse(today)-i*86400000).toISOString().slice(0,10); if (!usedDates.has(d)) available.push(d); }
    assert.equal(available.length,2,'Two unused explicit return dates are required');
    const summarySQL = `SELECT COALESCE(SUM(${Fund.historyProfitExpr('h','f')}),0) AS profit_sum FROM bus_fund_history h JOIN fund f ON h.fund_id=f.id WHERE h.fund_id=? AND f.user_id=? AND f.is_deleted=0`;
    const [beforeProfit] = await conn.execute(summarySQL,[fundId,userId]);
    const fund = await executeProposal(userId,'fund.returnBatch',{ fundId,entries: [{ date: available[0],amount: '1.2500' },{ date: available[1],amount: '-0.2500' }] });
    const [fundAfter] = await conn.execute('SELECT net_value FROM fund WHERE id=? AND user_id=?',[fundId,userId]);
    assert.equal(fundAfter[0].net_value,scaledToString(toScaledInteger(beforeProfit[0].profit_sum,4)+10000n,4)); assert.equal(fund.receipt.count,2);
    const conflicted = await proposals.create(userId,{ kind: 'fund.returnBatch',fields: { fundId,entries: [{ date: available[0],amount: '0' }] } });
    const conflictReviewed = await proposals.act(userId,conflicted.id,conflicted.version,'review');
    await assert.rejects(proposals.execute(userId,conflicted.id,conflictReviewed.version),e => e.code === 'AI_FUND_DATE_CONFLICT');
    await assert.rejects(proposals.get('ai_real_absent_owner',fund.proposal.id),e => e.status === 404);
    checks.push('fund-explicit-signed-returns-atomic-existing-summary','fund-existing-date-whole-batch-denied','proposal-owner-isolation');
    const clockBase = Date.now(); let logicalClock = clockBase;
    phase = 'guard:real-sql-concurrency-and-replay';
    const guardA = createRequestGuard({ executor,clock: () => logicalClock }), guardB = createRequestGuard({ executor,clock: () => logicalClock });
    const firstId = uid(), secondId = uid(), entered = deferred(), hold = deferred(); let providerCalls = 0;
    const request = id => ({ requestId: id,lane: 'business-chat',input: { previewId: 'real-no-provider-test',consent: true },maxProviderCalls: 1 });
    const guarded = guardA.run(userId,request(firstId),async () => { entered.resolve(); await hold.promise; return { answer: '仅真实SQL回执验收，未调用模型' }; });
    await Promise.race([entered.promise,guarded.then(() => { throw new Error('Guard work ended before concurrency check'); })]);
    let guardedResult;
    try {
      await assert.rejects(guardB.run(userId,request(secondId),async () => { providerCalls++; }),e => e.code === 'AI_RATE_LIMIT');
      await assert.rejects(guardB.run(userId,request(firstId),async () => { providerCalls++; }),e => e.code === 'AI_REQUEST_ALREADY_USED');
    } finally {
      hold.resolve();
      // Even a failed assertion must drain the live guard before ROLLBACK,
      // otherwise its late receipt write could outlive the outer transaction.
      guardedResult = await guarded;
    }
    assert.deepEqual(await guardB.run(userId,request(firstId),async () => { providerCalls++; }),guardedResult);
    assert.equal((await guardB.get(userId,firstId)).providerCalls,0); assert.equal(providerCalls,0);
    logicalClock += 86400001; await guardA.prune(userId);
    await assert.rejects(guardB.run(userId,request(firstId),async () => { providerCalls++; }),e => e.code === 'AI_REQUEST_EXPIRED');
    checks.push('two-guard-instances-real-sql-lane-and-duplicate-receipt','expired-request-tombstone-no-replay');
    const [admins] = await conn.execute('SELECT identity FROM user_info WHERE id=? AND is_deleted=0',[userId]);
    if (admins[0]?.identity === 'admin') {
      phase = 'backup:review-and-orphan-recovery-no-start';
      const backup = await proposals.create(userId,{ kind: 'system.backup',fields: {} }); await proposals.act(userId,backup.id,backup.version,'review');
      for (const status of ['queued','running']) {
        const jobRef = uid(), receipt = { kind: 'system.backup',jobRef,status,completed: false };
        await conn.execute('INSERT INTO ai_background_job (id,user_id,proposal_id,status,worker_id,receipt,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?)',[jobRef,userId,uid(),status,JSON.stringify(receipt),String(Date.now()-16*60000),String(Date.now()-16*60000)]);
        const current = await actions.getReceipt(executor,userId,receipt); assert.equal(current.status,'failed'); assert.equal(current.completed,false);
      }
      await actions.recoverBackupJobs(conn);
      checks.push('admin-backup-review-no-job-start','restart-queued-running-become-failed-never-restart');
    }
    assert.equal(unexpectedSideEffects,0);
    phase = 'rollback-and-all-table-hash';
    await conn.rollback(); rolledBack = true;
    const after = await snapshot();
    assert.deepEqual(after,before,'All database row hashes must be unchanged after rollback');
    const report = { passed: true,readOnlyPrivileges: true,readDomains,checks,providerCalls: 0,backupStarts: 0,
      outerTransactionRolledBack: true,formalTablesUnchanged: formal.length,allTablesUnchanged: allTables.length,
      legacyExpensePreserved: true,physicalConnectionConcurrencyTested: false,transactionAdapter: 'single-real-connection-serialized-savepoints' };
    console.log(JSON.stringify(report)); return report;
  } catch (cause) {
    cause.acceptancePhase = phase;
    throw cause;
  } finally {
    if (started && !rolledBack) await conn.rollback().catch(() => {});
    await readPool.end(); await conn.end();
    if (diagnostic) console.error(JSON.stringify({ readDiagnostic: diagnostic }));
  }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ failed: true,code: error.code || error.name,status: error.status || null,
    phase: error.acceptancePhase || 'configuration',
    assertion: error.name === 'AssertionError' ? error.message.split('\n')[0] : undefined })); process.exitCode = 1;
});
module.exports = { main };
