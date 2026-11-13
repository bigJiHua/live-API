const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const pending={draft:{id:'pending-only',status:'pending',missingFields:[]}};
const receipt=kind=>({kind,recordId:'real-record',committedAt:1});

test.each([
 ['我已经核对，并完成入账。','ledger'],
 ['我已检查金额，并且完成了记账。','ledger'],
 ['本轮已核对，且完成入账。','ledger'],
 ['我们已查询，同时完成记入账本。','ledger'],
 ['我已读取数据，并完成入库。','ledger'],
 ['我已查询此前入账历史，并完成入账。','ledger'],
 ['我已查看历史入账记录，并完成修改账户余额。','update'],
 ['我已经查阅记录，并完成删除这个待办。','delete'],
 ['我已读取数据，并完成更新账本。','update'],
 ['我已核对，并完成入账。不会再继续操作。','ledger'],
 ['历史记录如下。现在本轮我已经核对，并完成入账。','ledger'],
 ['上月记录已读取，本轮我已经核对，并完成入账。','ledger'],
 ['`我已经核对，并完成入账。` 是示例。我已经核对，并完成入账。','ledger'],
])('explicit completed continuation needs its own receipt: %s',(answer,claimType)=>{
 expect(()=>assertResultClaims(answer,{artifacts:[pending],currentReceipts:[]}))
  .toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH',claimType}));
});

test.each([
 '并完成入账。','确认后并完成入账。','确认后完成入账。',
 '请核对草稿，并完成入账。','需核对金额，并完成入账。','必须先核对，并完成入账。',
 '我已经核对，并在确认后完成入账。','我已经核对，并将在确认后完成入账。',
 '我已经核对，请完成入账。','我已经核对，并请你完成入账。',
 '我已经核对，并未完成入账。','我已经核对，并不能声称完成入账。',
 '我已经核对，并不代表完成入账。','未核对，也未完成入账。',
 '确认后我已经核对，并完成入账。','如果我已经核对，并完成入账，就应有回执。',
 '若我已核对，并完成入账，就查看回执。','需要声明我已经核对，并完成入账。',
 '我已经核对，并完成入账后再继续。','我已经核对，并完成入账前确认。',
 '我已经核对，并完成入账时查看回执。','我已经核对，并完成入账需要确认。',
 '我已经核对，并完成入账将在确认后进行。',
 '历史记录显示我已经核对，并完成入账。','此前我已经核对，并完成入账。',
 '昨天我已经核对，并完成入账。','保存状态：我已经核对，并完成入账。',
 '保存期次状态：已入账0、中止0。','范围内已入账状态：0期。',
 '“我已经核对，并完成入账。”是一个未执行的示例。',
 '示例：「我已经核对，并完成入账。」',
 '`我已经核对，并完成入账。` 是代码里的示例。',
 '```text\n我已经核对，并完成入账。\n```',
 '我已核对，并完成入账记录分析。','我已读取，并完成入账数据校验。',
 '我已经核对；请完成入账。','我已经核对。完成入账后查看回执。',
])('future, imperative, negative, saved-state and example wording remains allowed: %s',answer=>{
 expect(()=>assertResultClaims(answer,{artifacts:[],currentReceipts:[]})).not.toThrow();
});

test.each([
 ['我已经核对，并完成入账。','transaction.create'],
 ['我已读取数据，并完成更新账本。','account.update'],
 ['我已核对，并完成删除这个待办。','todo.delete'],
])('only a valid matching current receipt supports the joined action: %s',(answer,kind)=>{
 expect(()=>assertResultClaims(answer,{currentReceipts:[receipt(kind)]})).not.toThrow();
});

test.each([
 [],[receipt('todo.update')],[{...receipt('transaction.create'),recordId:''}],
 [{...receipt('transaction.create'),committedAt:0}],
 [{...receipt('transaction.create'),committedAt:'2026-11-10'}],
].map(currentReceipts=>[currentReceipts]))('a missing, unrelated or malformed receipt cannot support posting',currentReceipts=>{
 expect(()=>assertResultClaims('我已经核对，并完成入账。',{artifacts:[pending],currentReceipts}))
  .toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH',claimType:'ledger'}));
});

test.each([
 '我已经核对，并完成入账了吗？',
 '我已经核对，并完成了入账吗？',
 '我已经核对，并完成入账的条件尚未满足。',
 '我已经核对，并完成入账的条件已满足。',
 '我已经核对，并完成入账是否需要确认？',
 '我已经核对，并完成入账能否继续？',
 '我已经核对，并完成入账可否请你确认？',
 '我已经核对，并完成入账的要求是补齐账户。',
 '我已经核对，并完成删除的前提尚未满足。',
 '我已经核对，并完成更新的条件仍需补全。',
])('a local explicit question or completion prerequisite is not a committed operation: %s',answer=>{
 expect(()=>assertResultClaims(answer,{artifacts:[],currentReceipts:[]})).not.toThrow();
});
test.each([
 '我已经核对，并完成入账的条件尚未满足。本次已入账。',
 '我已经核对，并完成入账了吗？本次已删除记录。',
 '我已经核对，并完成入账，是否需要确认？',
 '我已经核对，并完成入账；需要条件确认。',
 '我已经核对，并完成入账。请确认是否收到回执。',
 '没有完成入账，我已经核对，并完成入账。',
 '保存状态如下。我已经核对，并完成入账。',
 '历史记录如下，我已经核对，并完成入账。',
])('a question or condition does not exempt a separate completed assertion: %s',answer=>{
 expect(()=>assertResultClaims(answer,{artifacts:[],currentReceipts:[]}))
  .toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH'}));
});
test.each([
 '我已经核对8.50元，并完成入账。',
 '本次已经核对，并完成修改账户余额。',
 '我已经核对，并完成入账了吗？我已核对，并完成入库。',
])('a directly joined completed assertion still needs a matching effect receipt: %s',answer=>{
 expect(()=>assertResultClaims(answer,{currentReceipts:[{kind:'todo.delete',recordId:'valid-other-record',committedAt:1}]}))
  .toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH'}));
});
test.each([
 '我已经查询，并更新了图表。','我已经查询，并更新了展示。','我已经查询，并更新了说明。',
 '我已经查询，并完成更新图表。','我已经查询，并完成修改展示。','我已经查询，并完成更新说明。',
 '我已经查询，并完成删除多余表头。','我已经查询，并完成更新图表中的账户余额说明。',
 '我已经查询，并完成修改正文中的账本介绍。','我已经查询，并完成更新。','我已经查询，并完成修改。',
 '我已经查询，并完成删除。','我已经核对，并完成更新账本后查看回执。',
 '我已经核对，并完成修改账户余额的条件尚未满足。',
])('presentation changes and unspecified editing verbs do not create a new business completion claim: %s',answer=>{
 expect(()=>assertResultClaims(answer,{artifacts:[],currentReceipts:[]})).not.toThrow();
});
test.each([
 '我已经核对，并完成更新账本。','我已经核对，并完成修改账户余额。',
 '我已经核对，并完成删除这个待办。','我已经核对，并完成更新预算计划。',
 '我已经核对，并完成修改卡片配置。','我已经核对，并完成更新基金登记。',
 '我已经核对，并完成删除交易记录。',
])('an explicit joined business object still requires its effect receipt: %s',answer=>{
 expect(()=>assertResultClaims(answer,{artifacts:[],currentReceipts:[]}))
  .toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH'}));
});
