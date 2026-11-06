// Explicit real DB/provider acceptance. All AI records and accounting writes are rolled back.
const assert = require('assert/strict');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getConfig } = require('../src/modules/ai/service/config');
const { createReadRepository } = require('../src/modules/ai/service/readRepository');
const { createDraftStore } = require('../src/modules/ai/service/drafts');
const { createConversationStore } = require('../src/modules/ai/service/conversations');
const { createAiService } = require('../src/modules/ai/service');
const { todayShanghai } = require('../src/modules/ai/service/validation');
const { executeTool } = require('../src/modules/ai/service/tools');

async function main() {
  const config = getConfig();
  assert.equal(config.mode, 'deepseek');
  assert.equal(config.dataSource, 'user-readonly');
  const conn = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'live',
    multipleStatements: false, dateStrings: true, connectTimeout: 5000 });
  const repo = createReadRepository(config.db);
  let service;
  const checks = [];
  let rolledBack = false;
  let started = false;
  try {
    const [owners] = await conn.execute('SELECT DISTINCT user_id FROM account WHERE is_deleted=0 LIMIT 2');
    const userId = process.env.AI_TEST_USER_ID || (owners.length === 1 ? owners[0].user_id : null);
    assert.ok(userId, 'AI_TEST_USER_ID is required when more than one ledger owner exists');
    const fingerprint = async () => {
      const [ledger] = await conn.execute(`SELECT COUNT(*) AS n,
        BIT_XOR(CRC32(CONCAT_WS('|',id,amount,currency,trans_date,direction,category_id,card_id,is_deleted,reversed_id))) AS digest
        FROM account WHERE user_id=?`, [userId]);
      const [balances] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',b.card_id,b.balance))) AS digest
        FROM account_balance b JOIN card_base c ON c.id=b.card_id WHERE c.user_id=?`, [userId]);
      const [bills] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',id,bill_amount))) AS digest
        FROM card_bill WHERE user_id=?`, [userId]);
      const [cards] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',id,card_type,status,is_deleted,credit_limit))) AS digest
        FROM card_base WHERE user_id=?`, [userId]);
      const [draftRows] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',id,version,status,amount,trans_date,committed_record_id))) AS digest
        FROM bus_ai_draft WHERE user_id=?`, [userId]);
      const [chatRows] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',id,updated_at,latest_draft_id))) AS digest
        FROM ai_conversation WHERE user_id=?`, [userId]);
      const [messages] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',id,conversation_id,content,draft_id))) AS digest
        FROM ai_message WHERE user_id=?`, [userId]);
      return { ledger: ledger[0], balances: balances[0], bills: bills[0], cards: cards[0],
        drafts: draftRows[0], conversations: chatRows[0], messages: messages[0] };
    };
    const before = await fingerprint();
    await conn.beginTransaction();
    started = true;
    // Service commits release a savepoint; only this harness owns the outer transaction.
    const adapter = {
      execute: (...args) => conn.execute(...args), query: (...args) => conn.query(...args),
      beginTransaction: () => conn.query('SAVEPOINT ai_acceptance_commit'),
      commit: () => conn.query('RELEASE SAVEPOINT ai_acceptance_commit'),
      rollback: () => conn.query('ROLLBACK TO SAVEPOINT ai_acceptance_commit'),
      release() {},
    };
    const drafts = createDraftStore({ executor: conn });
    const conversations = createConversationStore({ executor: conn });
    service = createAiService({ repository: repo, draftStore: drafts, conversationStore: conversations,
      writeDb: { getConnection: async () => adapter } });
    const validators = await import('../../web/src/utils/aiContract.js');
    const capabilities = validators.validateAiCapabilities(service.getCapabilities(userId));
    assert.equal(capabilities.dataSource, 'user-readonly');
    const profile = await service.configure(userId, { apiUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
    validators.validateAiSettings(profile);
    assert.ok(!JSON.stringify(profile).includes(config.apiKey));
    checks.push('real-provider-connection');

    const today = todayShanghai();
    const range = { startDate: today.slice(0, 7) + '-01', endDate: today };
    const expected = await repo.summary(userId, range);
    const query = validators.validateAiResult(await service.run(userId, { scene: 'chat', consent: true,
      connectionId: profile.connectionId, message: `查询${range.startDate}到${range.endDate}的收支汇总，请调用汇总工具。` }));
    const evidence = query.trace.find(item => item.tool === 'query_finance_summary');
    assert.ok(evidence, 'Real model must obtain amounts from the summary tool');
    assert.equal(evidence.result.startDate, range.startDate);
    assert.equal(evidence.result.endDate, range.endDate);
    assert.equal(Number(evidence.result.income), Number(expected.income));
    assert.equal(Number(evidence.result.expense), Number(expected.expense));
    assert.equal(Number(evidence.result.count), Number(expected.count));
    assert.equal(query.source, 'user-readonly');
    assert.equal((await conversations.messages(userId, query.conversationId)).length, 2);
    const reopened = await createConversationStore({ executor: conn }).open(userId, query.conversationId);
    assert.equal(reopened.history.length, 2);
    await assert.rejects(conversations.open('ai_verify_no_such_user', query.conversationId), e => e.status === 404);
    checks.push('real-model-summary-matches-database', 'history-persisted-before-response', 'history-user-isolation');

    for (const [tool, args] of [
      ['query_finance_summary', { ...range, userId: 'other' }],
      ['query_finance_summary', { ...range, sql: 'SELECT * FROM user_info' }],
      ['query_transactions', { ...range, limit: 21 }], ['execute_sql', {}],
    ]) {
      await assert.rejects(executeTool({ scene: 'chat', userId, repository: repo, today }, tool, args));
    }
    checks.push('tool-identity-sql-pagination-boundaries');
    const choices = await repo.choices(userId);
    const categoryIds = choices.categories.map(category => category.id);
    assert.ok(categoryIds.length, 'No supported ordinary category is available for acceptance');
    let modelDraftChecked = false;
    for (const type of ['virtual_cash', 'debit', 'credit']) {
      const accountIds = choices.accounts.filter(account => account.type === type).map(account => account.id);
      assert.ok(accountIds.length, `No normal ${type} account is available for acceptance`);
      const [templates] = await conn.execute(`SELECT a.direction,a.amount,a.currency,
          DATE_FORMAT(a.trans_date,'%Y-%m-%d') AS trans_date,a.category_id,a.card_id,
          CASE WHEN a.pay_method IN ('借记卡','信用卡') THEN '银行卡'
            WHEN a.pay_method='微信支付' THEN '微信' ELSE a.pay_method END AS pay_method,
          c.alias,cat.name AS category_name
        FROM account a JOIN card_base c ON c.id=a.card_id AND c.user_id=a.user_id AND c.is_deleted=0
          JOIN bus_category cat ON cat.id=a.category_id AND cat.user_id=a.user_id AND cat.is_deleted=0
        WHERE a.user_id=? AND a.is_deleted=0 AND a.reversed_id IS NULL AND a.currency='CNY'
          AND a.pay_type <> '转账' AND a.category_id <> 'CATEGORY_REPAY'
          AND a.pay_method IN ('现金','余额','支付宝','微信','银行卡','借记卡','信用卡','微信支付') AND a.amount > 0
          AND c.card_type=? AND c.status='正常' AND cat.type=IF(a.direction=0,'expense','income')
          AND a.category_id IN (${categoryIds.map(() => '?').join(',')})
          AND a.card_id IN (${accountIds.map(() => '?').join(',')})
          AND COALESCE(a.remark,'') NOT LIKE '%追加163%'
        ORDER BY CAST(a.amount AS DECIMAL(18,4)) ASC LIMIT 1`, [userId, type, ...categoryIds, ...accountIds]);
      const template = templates[0];
      assert.ok(template, `No existing ${type} transaction is available for acceptance`);
      const fields = { direction: template.direction, amount: String(template.amount), currency: 'CNY',
        transDate: template.trans_date, categoryId: template.category_id, accountId: template.card_id,
        payMethod: template.pay_method, remark: 'AI real acceptance - rolled back' };
      const proposal = await executeTool({ scene: 'draft', userId, repository: repo, today }, 'propose_transaction', fields);
      if (!modelDraftChecked) {
        const generated = validators.validateAiResult(await service.run(userId, { scene: 'chat', consent: true,
          connectionId: profile.connectionId, conversationId: query.conversationId,
          message: `请整理为待核对草稿：${fields.transDate}，${fields.direction === 0 ? '支出' : '收入'}${fields.amount}元人民币，账户「${template.alias}」，分类「${template.category_name}」，${fields.payMethod}付款。仅生成草稿。` }));
        assert.ok(generated.draft, 'Real model must produce a draft through the proposal tool');
        assert.equal(Number(generated.draft.amount), Number(fields.amount));
        assert.equal(generated.draft.transDate, fields.transDate);
        assert.equal(generated.draft.accountId, fields.accountId, 'Real model selected a different account from the uniquely named source');
        assert.equal(generated.draft.categoryId, fields.categoryId);
        assert.equal(generated.source, 'user-readonly');
        assert.equal(generated.draft.status, 'pending');
        modelDraftChecked = true;
        checks.push('real-model-draft-fields-match-existing-transaction');
      }
      let draft = await drafts.save(userId, { ...proposal, source: 'user-readonly', originalText: 'Real transaction acceptance', trace: [] });
      assert.equal((await drafts.get(userId, draft.id)).transDate, fields.transDate);
      await assert.rejects(drafts.get('ai_verify_no_such_user', draft.id), e => e.status === 404);
      await assert.rejects(service.commitDraft(userId, draft.id, { version: draft.version }), e => e.code === 'AI_DRAFT_NOT_REVIEWED');
      draft = await service.actOnDraft(userId, draft.id, { version: draft.version, action: 'review' });
      draft = await service.editDraft(userId, draft.id, { version: draft.version, fields });
      assert.equal(draft.status, 'pending');
      await assert.rejects(service.commitDraft(userId, draft.id, { version: draft.version }), e => e.code === 'AI_DRAFT_NOT_REVIEWED');
      draft = await service.actOnDraft(userId, draft.id, { version: draft.version, action: 'review' });
      const committed = validators.validateAiDraft(await service.commitDraft(userId, draft.id, { version: draft.version }));
      assert.equal(committed.status, 'committed');
      assert.equal(committed.needsReview, false);
      assert.ok(committed.committedRecordId);
      const [records] = await conn.execute(`SELECT user_id,card_id,category_id,amount,
        DATE_FORMAT(trans_date,'%Y-%m-%d') AS trans_date FROM account WHERE id=?`, [committed.committedRecordId]);
      assert.equal(records.length, 1);
      assert.equal(records[0].user_id, userId);
      assert.equal(records[0].card_id, fields.accountId);
      assert.equal(records[0].category_id, fields.categoryId);
      assert.equal(Number(records[0].amount), Number(fields.amount));
      assert.equal(records[0].trans_date, fields.transDate);
      await assert.rejects(service.commitDraft(userId, draft.id, { version: draft.version }), e => e.status === 409);
      checks.push(`${type}-real-write-transaction-and-receipt`, `${type}-date-roundtrip`, `${type}-edit-requires-new-review`, `${type}-duplicate-commit-rejected`);
    }
    const aiRows = await conn.execute(`SELECT COUNT(*) AS count FROM ai_message WHERE conversation_id=?`, [query.conversationId]);
    assert.equal(Number(aiRows[0][0].count), 4);
    await conn.rollback();
    rolledBack = true;
    assert.deepEqual(await fingerprint(), before, 'Accounting state changed after rollback');
    checks.push('ledger-balances-bills-cards-ai-records-unchanged-after-rollback');
    const report = { ok: true, dataSource: 'user-readonly', providerCalled: true, checks,
      summaryCount: Number(expected.count), candidates: { categories: choices.categories.length, accounts: choices.accounts.length },
      rolledBack, financialStateUnchanged: true };
    console.log(JSON.stringify(report));
    return report;
  } finally {
    if (started && !rolledBack) await conn.rollback().catch(() => {});
    if (service) await service.close();
    await repo.close();
    await conn.end();
    await require('../src/common/config/db').getPool().end();
  }
}
if (require.main === module) main().catch(error => {
  // No raw DB/provider errors, request payloads, credentials, or financial details.
  console.error(JSON.stringify({ ok: false, code: error.code || 'AI_ACCEPTANCE_FAILED',
    name: error.name, status: error.status || null,
    assertion: error.name === 'AssertionError' ? error.message.split('\n')[0] : undefined,
    location: error.stack?.split('\n').find(line => /ai-real-acceptance\.js:\d+/.test(line))?.trim() }));
  process.exitCode = 1;
});
module.exports = { main };
