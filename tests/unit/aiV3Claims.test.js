const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');

test.each(['也已更新账户余额。', '同时已修改账本。', 'I have updated the ledger.',
  'I have modified your account balance.', 'We have transferred the money.', 'I have posted the transaction.'])
  ('a separate or English business completion still requires an actual receipt: %s', answer => {
    expect(() => assertResultClaims(answer)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });

test.each(['If I have updated the ledger, show the receipt.', 'I will transfer the money after you confirm.',
  'I have saved your preferences.', 'You paid for lunch yesterday.'])
  ('English memory, user payments and conditional business text do not assert execution: %s', answer => {
    expect(() => assertResultClaims(answer)).not.toThrow();
  });

const draft = { draft: { id: 'synthetic-draft', status: 'pending', missingFields: [] } };
const proposal = { proposal: { id: 'synthetic-proposal', kind: 'todo.delete', status: 'pending', missingFields: [] } };
const candidate = { inputCandidate: { id: 'synthetic-candidate', status: 'pending' } };
const partial = { proposal: { id: 'synthetic-budget', kind: 'budget.create', status: 'pending', missingFields: ['planDate'] } };

test.each([
  ['no actual artifact', '已整理8.50元草稿，请确认。', []],
  ['read data cannot be a draft', '已经为你生成好了记账草稿。', []],
  ['candidate is not a complete draft', '这笔支出已生成完整可执行草稿。', [candidate],
    [[partial], [{ proposal: { ...proposal.proposal, actionUnavailable: true } }]]],
  ['pending draft is not a ledger receipt', '本次已完成入账。', [draft]],
  ['current bookkeeping needs a receipt', '我已经把这笔8.50元记入账本。', [draft]],
  ['ledger wording from architecture audit', '这笔款项已经写进账簿，余额也变了。', []],
  ['pending delete proposal is not deletion', '已为你删除这个待办。', [proposal]],
])('rejects unsupported current completion: %s', (_, answer, artifacts, additionalStates = []) => {
  for (const actualArtifacts of [artifacts, ...additionalStates]) {
    let failure;
    try { assertResultClaims(answer, { artifacts: actualArtifacts, currentReceipts: [] }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 502, code: 'AI_RESULT_CLAIM_MISMATCH' });
    expect(failure.message).toContain('请查看实际卡片和回执');
  }
});

test.each([
  ['classification and account question', '按零食用途归到餐饮；实际用哪个账户支付？', []],
  ['future creation', '请先确认账户，我再生成草稿。如果我已入账，则应有回执。如果已经生成了草稿，我们再核对。', []],
  ['negative and conditional wording', '尚未入账，确认草稿后才执行。不能声称我已经入账。没有生成好的草稿，请先补账户。', [draft]],
  ['real pending draft', '草稿已生成，请在卡片核对后确认。', [draft]],
  ['real incomplete proposal', '已生成待核对预算提案，请补预算日期。', [partial]],
  ['historical aggregate analysis', '本月已保存收支的支出总额是125.46元。历史记录显示之前这笔已入账。', []],
  ['quoted status names and examples', '“已入账”是状态名称，实际结果请查看回执。示例：「本次已完成入账。」', []],
  ['existing server receipt reference', '这笔已经有入账回执，请查看原记录；新交易请另发完整原话。', []],
  ['historical ledger wording', '昨天这笔款项已经写进账簿，余额也变了。', []],
  ['user-owned prior bookkeeping', '你昨天已经把这笔款项写进账簿。', []],
  ['negative ledger wording', '这笔款项还没有写进账簿，余额没有变。', []],
  ['conditional ledger wording', '如果这笔款项已经写进账簿，就应该查看原回执。', []],
])('preserves qualified analysis and supported output: %s', (_, answer, artifacts) => {
  expect(() => assertResultClaims(answer, { artifacts, currentReceipts: [] })).not.toThrow();
});

test.each([
  '这笔已用微信支付，下面是待核对草稿。',
  '已用现金支付8.50元，尚未入账。',
  '该笔已还款的登记记录显示还款账户为微信账户。',
])('existing user payments and query facts are not assistant-executed money actions: %s', answer => {
  expect(() => assertResultClaims(answer, { artifacts: [draft], currentReceipts: [] })).not.toThrow();
});

test.each([
  '我已经把这笔8.50元用微信支付完成。',
  '已为你完成本次银行卡还款。',
  '本次操作已经完成了转账。',
])('explicit assistant money execution still requires its own receipt: %s', answer => {
  expect(() => assertResultClaims(answer, { artifacts: [draft], currentReceipts: [] }))
    .toThrow(expect.objectContaining({ status: 502, code: 'AI_RESULT_CLAIM_MISMATCH', claimType: 'payment' }));
});

test.each([
  '我已查看这笔入账记录，请看明细。',
  '我已经分析了本月入账数据。',
  '我已查询还款历史，以下是登记记录。',
])('operation nouns in read-only statements do not assert a mutation: %s', answer => {
  expect(() => assertResultClaims(answer, { artifacts: [], currentReceipts: [] })).not.toThrow();
});

test.each([
  '我已查询并完成入账。',
  '我已查看记录并为你删除这个待办。',
  '我已查询还款历史并完成了本次还款。',
  '我已入账。',
  '本次已删除这个待办。',
])('read verbs cannot exempt a separate explicit completed action: %s', answer => {
  expect(() => assertResultClaims(answer, { artifacts: [draft], currentReceipts: [] }))
    .toThrow(expect.objectContaining({ status: 502, code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each([
  '我已经修改文章。',
  '我已经删除散文中重复的一段。',
  '我已经更新这篇关于预算的文章。',
  '已经生成了散文草稿。',
  '文章草稿已经形成。',
  '关于账本的科普文章已经生成了草稿。',
  '我已核对，并完成修改文章。',
])('prose scope allows literary edits and drafts without formal artifacts: %s', answer => {
  expect(() => assertResultClaims(answer, { scope: 'prose' })).not.toThrow();
});

test.each(['我已经修改文章。', '我已经删除散文中重复的一段。', '已经生成了散文草稿。'])
  ('the default business scope retains its strict old behavior: %s', answer => {
    expect(() => assertResultClaims(answer)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
    expect(() => assertResultClaims(answer, { scope: 'business' })).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });

test.each([
  '我已经帮你完成入账，账本已更新。',
  '这笔款项已经写进账簿，余额也变了。',
  '我已修改账本。',
  '已为你删除这个待办。',
  '我已把这笔交易删除。',
  '我已把账户余额更新。',
  '更新成功了这个待办。',
  '记账草稿已生成。',
  '这笔支出已生成完整记账草稿。',
  '我已查看记录并为你删除这个待办。',
  '我已经修改文章并完成入账。',
  'I have updated the ledger.',
])('prose scope still rejects unsupported explicit formal effects: %s', answer => {
  expect(() => assertResultClaims(answer, { scope: 'prose' }))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each([
  '昨天这笔款项已经写进账簿，余额也变了。',
  '你昨天已经把这笔款项写进账簿。',
  '这笔款项还没有写进账簿，余额没有变。',
  '如果这笔款项已经写进账簿，就应该查看原回执。',
  '如果我已经修改账本，就应有回执。',
  '“我已修改账本”是示例，尚未入账。',
])('prose scope preserves qualified and quoted formal statements: %s', answer => {
  expect(() => assertResultClaims(answer, { scope: 'prose' })).not.toThrow();
});

test('prose scope uses actual receipts and artifacts rather than weakening their provenance', () => {
  const currentReceipts = [{ recordId: 'server-record', committedAt: 1, kind: 'transaction.create' }];
  expect(() => assertResultClaims('这笔款项已经写进账簿。', { scope: 'prose', currentReceipts })).not.toThrow();
  expect(() => assertResultClaims('草稿已生成。', { scope: 'prose', artifacts: [draft] })).not.toThrow();
  expect(() => assertResultClaims('草稿已生成。', { scope: 'prose', artifacts: [candidate] }))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each(['', 'model', 'Business', null, true, {}, []])('invalid server claim scope fails closed: %p', scope => {
  expect(() => assertResultClaims('普通文章。', { scope }))
    .toThrow(expect.objectContaining({ code: 'AI_INVALID_RESULT' }));
});

test.each([
  '我已经支付了高昂的代价。',
  '我已经转账到他心里的孤岛。',
  '我已存入心底。',
  '我已经删去了烦恼。',
  'I have paid a high price for freedom.',
  'I have paid tribute to the poet.',
  'I have posted a poem.',
  '本文先讨论账户余额。\n我已经支付了高昂的代价。',
  '我已经删除文章中的分类说明。',
  '我已经把文章中的分类说明删除。',
])('prose permits local literary objects without using unrelated financial topics: %s', answer => {
  expect(() => assertResultClaims(answer, { scope: 'prose' })).not.toThrow();
});

test.each([
  '我已经支付了高昂的代价。',
  '我已经转账到他心里的孤岛。',
  '我已经删除文章中的分类说明。',
])('default business scope keeps its existing strict monetary and edit checks: %s', answer => {
  expect(() => assertResultClaims(answer)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each([
  '我已经把这笔8.50元用微信支付完成。',
  '已为你完成本次银行卡还款。',
  '本次操作已经完成了转账。',
  '我已经支付。',
  '我已经转账到他的账户。',
  '我已经支付了这笔款项。',
  '我已经转账给张三。',
  '我已经支付了一百元。',
  '我已经支付了高昂的代价99元。',
  '我已经支付了高昂的代价并转出账户资金。',
  'I have paid a high price of 99 USD.',
  '我已经支付了所有款项。',
  '我已经支付99美元。',
  '我已经支付了手续费。',
  'I have paid the fee.',
  'We have transferred the money.',
  'I have posted the transaction.',
  '我已经删除餐饮分类。',
  '已为你删除餐饮分类。',
  '我已把餐饮分类删除。',
  '我已核对，并完成删除餐饮分类。',
])('prose still rejects local formal money and category effects without a receipt: %s', answer => {
  expect(() => assertResultClaims(answer, { scope: 'prose' }))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

describe.each(['business', 'prose'])('explicit current balance effects in %s scope', scope => {
  test.each([
    '你的账户余额已经更新。',
    '账户余额已经变化了。',
    '余额已经变了。',
    '我已经帮你改变了余额。',
  ])('requires an actual receipt: %s', answer => {
    expect(() => assertResultClaims(answer, { scope }))
      .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH', claimType: 'update' }));
    expect(() => assertResultClaims(answer, { scope,
      currentReceipts: [{ recordId: 'actual-balance-update', committedAt: 1, kind: 'account.update' }] })).not.toThrow();
    expect(() => assertResultClaims(answer, { scope, currentReceipts: [{ kind: 'account.update' }] }))
      .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });
  test.each([
    '昨天你的账户余额已经更新。',
    '此前账户余额已经变化了。',
    '如果余额已经变了，就查看原来的记录。',
    '如果我已经帮你改变了余额，就应有回执。',
    '不要声称你的账户余额已经更新。',
    '账户余额还没有变化。',
    '余额并没有变。',
    '你昨天已经用微信支付了午餐。',
    '这笔已用微信支付，下面是待核对草稿。',
    '查询结果显示你的账户余额已经更新。',
    '查询结果显示，账户余额已经变化了。',
    '根据查询结果，余额已经变了。',
    '“我已经帮你改变了余额。”是一个错误的示例。',
    '```markdown\n余额已经变了。\n我已经写入账簿。\n```',
  ])('preserves prior facts, conditions, observations and quoted examples: %s', answer => {
    expect(() => assertResultClaims(answer, { scope })).not.toThrow();
  });
  test('an observed balance fact cannot qualify a separate current execution', () => {
    expect(() => assertResultClaims('查询结果显示余额已经变化了；我已经帮你改变了余额。', { scope }))
      .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });
});

describe.each(['business', 'prose'])('tilde Markdown examples in %s scope', scope => {
  test.each([
    '~~~text\n我已入账。\n~~~\n本轮未执行入账。',
    '~~~~markdown\n余额已经变了。\n~~~\n仍在围栏内。\n~~~~\n本轮未执行入账。',
    '  ~~~text\r\n我已经修改账户余额。\r\n  ~~~~\r\n普通文章。',
  ])('closed three-or-more tilde fences preserve source examples: %s', answer => {
    expect(() => assertResultClaims(answer, { scope })).not.toThrow();
  });
  test.each([
    '~~~text\n我已入账。\n~~~\n我已入账。',
    '~~~text\n本轮未入账。\n~~~\n余额已经变了。',
    '~~~text\n我已入账。',
    '~~~~text\n普通文章。\n~~~\n我已入账。',
  ])('outside declarations and unclosed fences still require receipts: %s', answer => {
    expect(() => assertResultClaims(answer, { scope }))
      .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });
});
