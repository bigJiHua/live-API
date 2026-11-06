// Explicit real vision/database acceptance. The harness alone owns the outer transaction.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getConfig } = require('../src/modules/ai/service/config');
const { createReadRepository } = require('../src/modules/ai/service/readRepository');
const { createDraftStore } = require('../src/modules/ai/service/drafts');
const { createConversationStore } = require('../src/modules/ai/service/conversations');
const { createAiService } = require('../src/modules/ai/service');

async function main() {
  const config = getConfig();
  assert.equal(config.mode, 'deepseek');
  assert.equal(config.dataSource, 'user-readonly');
  const conn = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'live',
    multipleStatements: false, dateStrings: true, connectTimeout: 5000 });
  const repo = createReadRepository(config.db);
  let service, started = false, rolledBack = false;
  const checks = [];
  try {
    const [owners] = await conn.execute('SELECT DISTINCT user_id FROM account WHERE is_deleted=0 LIMIT 2');
    const userId = process.env.AI_TEST_USER_ID || (owners.length === 1 ? owners[0].user_id : null);
    assert.ok(userId, 'AI_TEST_USER_ID is required for multiple ledger owners');
    async function fingerprint() {
      const definitions = [
        ['ledger', 'account', "id,amount,currency,trans_date,direction,category_id,card_id,is_deleted,reversed_id"],
        ['bills', 'card_bill', 'id,bill_amount'],
        ['cards', 'card_base', 'id,card_type,status,is_deleted,credit_limit'],
        ['drafts', 'bus_ai_draft', 'id,version,status,amount,trans_date,committed_record_id'],
        ['conversations', 'ai_conversation', 'id,updated_at,latest_draft_id'],
        ['messages', 'ai_message', 'id,conversation_id,content,draft_id,meta'],
      ];
      const result = {};
      for (const [key, table, columns] of definitions) {
        const [rows] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',${columns}))) AS digest
          FROM ${table} WHERE user_id=?`, [userId]);
        result[key] = rows[0];
      }
      const [balances] = await conn.execute(`SELECT COUNT(*) AS n, BIT_XOR(CRC32(CONCAT_WS('|',b.card_id,b.balance))) AS digest
        FROM account_balance b JOIN card_base c ON c.id=b.card_id WHERE c.user_id=?`, [userId]);
      result.balances = balances[0];
      return result;
    }
    const before = await fingerprint();
    await conn.beginTransaction(); started = true;
    const adapter = { execute: (...args) => conn.execute(...args), query: (...args) => conn.query(...args),
      beginTransaction: () => conn.query('SAVEPOINT ai_ocr_commit'),
      commit: () => conn.query('RELEASE SAVEPOINT ai_ocr_commit'),
      rollback: () => conn.query('ROLLBACK TO SAVEPOINT ai_ocr_commit'), release() {} };
    const drafts = createDraftStore({ executor: conn });
    const conversations = createConversationStore({ executor: conn });
    service = createAiService({ repository: repo, draftStore: drafts, conversationStore: conversations,
      writeDb: { getConnection: async () => adapter } });
    const contract = await import('../../web/src/utils/aiContract.js');
    const profile = await service.configure(userId, { apiUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
    const image = name => ({ dataUrl: 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../tests/fixtures', name)).toString('base64') });
    const request = { image: image('ocr-payment.png'), consent: true, connectionId: profile.connectionId };
    await assert.rejects(service.runOcr(userId, { ...request, consent: false }), e => e.code === 'AI_CONSENT_REQUIRED');
    checks.push('independent-image-consent-required');
    const payment = contract.validateAiResult(await service.runOcr(userId, request));
    assert.equal(payment.ocr.documentType, 'payment');
    assert.equal(payment.ocr.items.length, 1);
    assert.equal(Number(payment.ocr.items[0].amount), 12.34);
    assert.equal(payment.ocr.items[0].transDate, '2026-11-06');
    assert.equal(payment.ocr.items[0].transactionStatus, 'completed');
    assert.equal(payment.ocr.items[0].transactionKind, 'ordinary');
    assert.ok(payment.draft, 'Clear successful ordinary payment must yield a pending draft');
    assert.equal(payment.draft.source, 'image-ocr');
    assert.equal(payment.draft.status, 'pending');
    assert.equal(payment.draft.accountId, null);
    assert.equal(payment.formalWriteEnabled, false);
    const afterExtraction = await fingerprint();
    for (const key of ['ledger', 'balances', 'bills', 'cards']) assert.deepEqual(afterExtraction[key], before[key]);
    checks.push('real-deepseek-payment-fields-and-pending-draft', 'extraction-does-not-change-financial-state');
    await assert.rejects(service.actOnDraft(userId, payment.draft.id, { version: payment.draft.version, action: 'review' }), e => e.status === 400);
    await assert.rejects(service.commitDraft(userId, payment.draft.id, { version: payment.draft.version }), e => e.code === 'AI_DRAFT_NOT_REVIEWED');
    await assert.rejects(conversations.open('ai_verify_no_such_user', payment.conversationId), e => e.status === 404);
    await assert.rejects(drafts.get('ai_verify_no_such_user', payment.draft.id), e => e.status === 404);
    assert.equal(await drafts.findByImageHash('ai_verify_no_such_user', payment.draft.trace[0].imageHash), null);
    checks.push('missing-account-and-review-prevent-commit', 'ocr-conversation-draft-hash-owner-isolation');
    const repeat = contract.validateAiResult(await service.runOcr(userId, { ...request, conversationId: payment.conversationId }));
    assert.equal(repeat.draft.id, payment.draft.id);
    assert.equal((await fingerprint()).drafts.n, afterExtraction.drafts.n);
    checks.push('same-image-reuses-existing-draft');
    const recovered = await createConversationStore({ executor: conn }).open(userId, payment.conversationId);
    assert.ok(recovered.history.some(row => row.content.includes('图片识别结果') && row.content.includes('12.34')));
    const messages = await conversations.messages(userId, payment.conversationId);
    assert.ok(messages.some(row => row.ocr?.items[0]?.amount === payment.ocr.items[0].amount));
    assert.ok(!JSON.stringify(messages).includes('base64,'));
    checks.push('ocr-history-restores-structured-result-without-image');
    const choices = await repo.choices(userId);
    const category = choices.categories.find(c => c.type === 'expense' && c.name === '交通') || choices.categories.find(c => c.type === 'expense');
    const named = c => c.name !== '未命名账户' && choices.accounts.filter(candidate => candidate.name.includes(c.name)).length === 1;
    const account = choices.accounts.find(c => c.type === 'virtual_cash' && named(c)) || choices.accounts.find(c => c.type === 'debit' && named(c));
    assert.ok(category && account, 'Ordinary acceptance candidates required');
    const chatEdit = contract.validateAiResult(await service.run(userId, { scene: 'chat', consent: true,
      connectionId: profile.connectionId, conversationId: payment.conversationId,
      message: `请补齐当前图片草稿：账户「${account.name}」，分类「${category.name}」，支出12.34元人民币，日期2026-11-06，微信付款，备注停车费验收。只更新这一份草稿，不要新建第二笔，不入账。` }));
    assert.ok(chatEdit.draft, 'Real model must update the image draft through the proposal tool');
    assert.equal(chatEdit.draft.id, payment.draft.id);
    assert.equal(chatEdit.draft.source, 'image-ocr');
    assert.equal(chatEdit.draft.version, 2);
    assert.equal(chatEdit.draft.accountId, account.id);
    assert.equal(chatEdit.draft.status, 'pending');
    assert.equal(chatEdit.draft.trace[0].imageHash, payment.draft.trace[0].imageHash);
    assert.equal((await fingerprint()).drafts.n, afterExtraction.drafts.n);
    checks.push('real-model-chat-updates-one-image-draft-and-retains-hash');
    const statement = contract.validateAiResult(await service.runOcr(userId, { image: image('ocr-statement.png'),
      consent: true, connectionId: profile.connectionId, conversationId: payment.conversationId }));
    assert.equal(statement.ocr.documentType, 'statement');
    assert.equal(statement.ocr.items.length, 3);
    assert.deepEqual(statement.ocr.items.map(item => Number(item.amount)), [10, 25, 8.5]);
    assert.equal(statement.draft, null);
    assert.equal((await conversations.open(userId, payment.conversationId)).latestDraftId, null);
    checks.push('real-deepseek-statement-three-rows-no-total-as-transaction', 'statement-does-not-create-draft-or-reuse-old-pointer');
    let draft = await service.editDraft(userId, payment.draft.id, { version: chatEdit.draft.version, fields: {
      direction: 0, amount: '12.34', currency: 'CNY', transDate: '2026-11-06', categoryId: category.id,
      accountId: account.id, payMethod: '微信', remark: 'OCR real acceptance - rolled back' } });
    assert.equal(draft.status, 'pending');
    draft = await service.actOnDraft(userId, draft.id, { version: draft.version, action: 'review' });
    const receipt = contract.validateAiDraft(await service.commitDraft(userId, draft.id, { version: draft.version }));
    assert.equal(receipt.status, 'committed');
    assert.ok(receipt.committedRecordId);
    const [records] = await conn.execute('SELECT user_id,card_id,category_id,amount FROM account WHERE id=?', [receipt.committedRecordId]);
    assert.equal(records.length, 1);
    assert.equal(records[0].user_id, userId); assert.equal(records[0].card_id, account.id);
    assert.equal(records[0].category_id, category.id); assert.equal(Number(records[0].amount), 12.34);
    await assert.rejects(service.commitDraft(userId, draft.id, { version: receipt.version }), e => e.status === 409);
    const committedRepeat = contract.validateAiResult(await service.runOcr(userId, { ...request, conversationId: payment.conversationId }));
    assert.equal(committedRepeat.draft.id, receipt.id); assert.equal(committedRepeat.draft.status, 'committed');
    assert.equal((await fingerprint()).ledger.n, Number(before.ledger.n) + 1);
    checks.push('ocr-manual-edit-review-and-formal-write-share-transaction', 'duplicate-commit-rejected', 'committed-image-restores-original-receipt');
    await conn.rollback(); rolledBack = true;
    assert.deepEqual(await fingerprint(), before, 'State changed after OCR acceptance rollback');
    checks.push('ledger-balances-bills-cards-all-ai-state-unchanged-after-rollback');
    const report = { ok: true, providerCalled: true, chatProviderCalled: true, dataSource: 'user-readonly', checks,
      recognizedPayment: { amount: '12.34', transDate: '2026-11-06' }, statementRows: 3, rolledBack,
      financialStateUnchanged: true, fixturesContainPrivateData: false };
    console.log(JSON.stringify(report));
    return report;
  } finally {
    if (started && !rolledBack) await conn.rollback().catch(() => {});
    if (service) await service.close();
    await repo.close(); await conn.end(); await require('../src/common/config/db').getPool().end();
  }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'AI_OCR_ACCEPTANCE_FAILED', name: error.name,
    status: error.status || null, assertion: error.name === 'AssertionError' ? error.message.split('\n')[0] : undefined,
    location: error.stack?.split('\n').find(line => /ai-real-ocr-acceptance\.js:\d+/.test(line))?.trim() }));
  process.exitCode = 1;
});
module.exports = { main };
