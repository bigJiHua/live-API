const { reconcileMemoryDeleteClaims, validDeleteReceipt, validPartialDeleteReceipt, memoryDeleteFailureNotice } = require('../../src/modules/ai/service/memoryDeleteClaims');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const receipt = { deleted: true, path: 'preferences.md', revision: 'a'.repeat(64) };
const partialReceipt = { saved: true, partialDeleted: true, changed: true, path: 'preferences.md', revision: 'b'.repeat(64) };

test.each(['已删除你的长期记忆。', '我已经删除了颜色偏好。', '记忆已删除。', '长期记忆删除完成。',
  '已将记忆清空。', '我已忘掉了。', 'I have deleted your memory.', "I've removed your preferences.",
  'Your memory has been deleted.', 'Deleted long-term memory.', 'I have forgotten it.'])
  ('only a confirmed delete receipt permits deletion completion: %s', answer => {
    const corrected = reconcileMemoryDeleteClaims(answer);
    expect(corrected.corrected).toBe(true);
    expect(corrected.answer).toMatch(/本轮未确认删除长期记忆|No long-term memory deletion was confirmed/);
    expect(reconcileMemoryDeleteClaims(answer, { receipts: [receipt] }).answer).toBe(answer);
  });

test.each(['尚未删除记忆。', '没有清空记忆。', '不要声称已删除记忆。', '如果已删除记忆，就不能读取。',
  '上次已删除记忆。', '我将删除记忆。', '“已删除记忆”只是示例。', '`已删除记忆`',
  '~~~text\n已删除记忆。\n~~~\n说明。', "I haven't deleted my memory.", 'Your memory was not deleted.',
  'If I have deleted your memory, it is absent.', 'I will delete your memory.', 'Previously deleted memory is unavailable.',
  '已删除记忆吗？', 'I have forgotten that summer.'])
  ('negative, future, hypothetical, historical and quoted statements remain intact: %s', answer => {
    const explicitOnly = answer === 'I have forgotten that summer.';
    expect(reconcileMemoryDeleteClaims(answer, { explicitOnly })).toEqual({ answer, businessClaimsText: answer, corrected: false });
  });

test('receipt identity binds an explicitly named memory, and a successful delete cannot authorize another file', () => {
  const answer = '已删除记忆文件《other.md》。';
  expect(reconcileMemoryDeleteClaims(answer, { receipts: [receipt] }).corrected).toBe(true);
  expect(reconcileMemoryDeleteClaims('已删除记忆文件《preferences.md》。', { receipts: [receipt] }).corrected).toBe(false);
  expect(reconcileMemoryDeleteClaims('I have deleted memory "other.md".', { receipts: [receipt] }).corrected).toBe(true);
  expect(reconcileMemoryDeleteClaims('已删除2条长期记忆。', { receipts: [receipt] }).corrected).toBe(true);
});

test('unrelated save, list, read or malformed delete flags cannot prove deletion', () => {
  for (const value of [{ saved: true, path: receipt.path, revision: receipt.revision }, { deleted: true },
    { ...receipt, deleted: false }, { ...receipt, path: '../wrong.md' }, { ...receipt, revision: 'bad' },
    { ...receipt, status: 'error' }]) {
    expect(validDeleteReceipt(value)).toBe(false);
    expect(reconcileMemoryDeleteClaims('已删除记忆。', { receipts: [value] }).corrected).toBe(true);
  }
});

test.each(['已删除记忆并修改账本。', '已删除记忆，已完成入账。', 'I have deleted your memory and updated the ledger.'])
  ('deletion receipt leaves adjacent business assertions for normal validation: %s', answer => {
    const result = reconcileMemoryDeleteClaims(answer, { receipts: [receipt] });
    expect(result.answer).toBe(answer);
    expect(() => assertResultClaims(result.businessClaimsText)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });

test('unsupported deletion is corrected while unrelated business effects remain in businessClaimsText', () => {
  const result = reconcileMemoryDeleteClaims('已删除记忆并修改账本。');
  expect(result.answer).toContain('本轮未确认删除长期记忆');
  expect(result.businessClaimsText).toContain('修改账本');
  expect(() => assertResultClaims(result.businessClaimsText)).toThrow();
  expect(reconcileMemoryDeleteClaims('已删除账本。', { receipts: [receipt] }).answer).toBe('已删除账本。');
});

test('a shared deletion verb for memory and another object cannot disappear from business checks', () => {
  for (const answer of ['已删除记忆和账本。', '已删除记忆及用户画像。', 'I have deleted memory and the ledger.']) {
    const result = reconcileMemoryDeleteClaims(answer, { receipts: [receipt] });
    expect(result.businessClaimsText).toMatch(/删除|deleted/);
    expect(() => assertResultClaims(result.businessClaimsText)).toThrow();
  }
});

test('explicit-only mode leaves bare literary forgetting intact but checks system memory deletion', () => {
  for (const answer of ['我已忘记那个夏天。', 'I have forgotten that summer.', 'Memory is discussed here. I have forgotten that summer.'])
    expect(reconcileMemoryDeleteClaims(answer, { explicitOnly: true })).toEqual({ answer, businessClaimsText: answer, corrected: false });
  expect(reconcileMemoryDeleteClaims('已忘掉记忆。', { explicitOnly: true }).corrected).toBe(true);
  for (const explicitOnly of [null, 'true', 1]) expect(() => reconcileMemoryDeleteClaims('说明。', { explicitOnly })).toThrow();
});

test('a failed deletion includes bounded sanitized failure information and completed delete side effects remain reportable', () => {
  const result = reconcileMemoryDeleteClaims('已删除记忆。', { errors: [{ message:
    `读取失败 D:\\Code\\secret.md sk-proj-1234567890abcdef h_${'a'.repeat(32)} ` + '😀'.repeat(250) }] });
  expect(result.answer).toContain('未删除原因');
  expect(result.answer).not.toContain('D:'); expect(result.answer).not.toContain('sk-proj-'); expect(result.answer).not.toContain('h_');
  expect(memoryDeleteFailureNotice([receipt, receipt])).toContain('已删除 1 条长期记忆');
  expect(memoryDeleteFailureNotice([{ deleted: true }])).toBe('');
});

test.each(['已删除记忆中的蓝色偏好。', '已删除记忆文件 preferences.md 中的一条记录。',
  '记忆中的蓝色偏好已删除，其他内容保留。', '我已从记忆中移除了蓝色偏好。',
  'I have removed the blue preference from memory.', 'The memory entry about blue has been deleted.'])
  ('a changed empty patch receipt permits explicitly partial deletion: %s', answer => {
    expect(validPartialDeleteReceipt(partialReceipt)).toBe(true);
    expect(validDeleteReceipt(partialReceipt)).toBe(false);
    expect(reconcileMemoryDeleteClaims(answer, { receipts: [partialReceipt] }).answer).toBe(answer);
  });

test.each(['已删除整个记忆文件 preferences.md。', '全部记忆已删除。', '已删除所有偏好。',
  '记忆已全部删除。', '已删除记忆中的所有信息。', '已删除记忆文件。', '我已忘掉了。',
  'I have deleted the entire memory file.', 'All memories have been deleted.'])
  ('a partial deletion receipt cannot prove full-file or all-memory removal: %s', answer => {
    expect(reconcileMemoryDeleteClaims(answer, { receipts: [partialReceipt] }).corrected).toBe(true);
  });

test('unchanged, failed or malformed partial deletion receipts authorize no removal', () => {
  for (const value of [{ ...partialReceipt, changed: false }, { ...partialReceipt, changed: undefined },
    { ...partialReceipt, saved: false }, { ...partialReceipt, partialDeleted: false }, { ...partialReceipt, status: 'error' },
    { ...partialReceipt, deleted: true }, { ...partialReceipt, path: '../other.md' }, { ...partialReceipt, revision: 'bad' }]) {
    expect(validPartialDeleteReceipt(value)).toBe(false);
    expect(reconcileMemoryDeleteClaims('已删除记忆中的蓝色偏好。', { receipts: [value] }).corrected).toBe(true);
  }
  expect(reconcileMemoryDeleteClaims('已删除记忆文件 other.md 中的蓝色偏好。', { receipts: [partialReceipt] }).corrected).toBe(true);
});

test.each(['已删除记忆中的蓝色偏好并删除账本。', '已删除记忆中的蓝色偏好和账本。',
  '已删除记忆中的蓝色偏好及用户画像。', 'I have removed the blue preference from memory and deleted the ledger.'])
  ('partial deletion never authorizes an adjacent or shared business deletion: %s', answer => {
    const result = reconcileMemoryDeleteClaims(answer, { receipts: [partialReceipt] });
    expect(result.answer).toBe(answer);
    expect(() => assertResultClaims(result.businessClaimsText)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });

test('a later save invalidates prior deletion claims while an unchanged same-revision save preserves partial deletion', () => {
  const saved = { saved: true, changed: true, path: receipt.path, revision: 'c'.repeat(64) };
  expect(reconcileMemoryDeleteClaims('已删除记忆文件。', { receipts: [receipt, saved] }).corrected).toBe(true);
  expect(reconcileMemoryDeleteClaims('已删除记忆中的蓝色偏好。', { receipts: [partialReceipt, saved] }).corrected).toBe(true);
  expect(reconcileMemoryDeleteClaims('已删除记忆中的蓝色偏好。', { receipts: [partialReceipt,
    { ...saved, changed: false, revision: partialReceipt.revision }] }).corrected).toBe(false);
  expect(reconcileMemoryDeleteClaims('已删除记忆文件。', { receipts: [partialReceipt, receipt] }).corrected).toBe(false);
  expect(memoryDeleteFailureNotice([receipt, saved])).toBe('');
});

test('failure notice reports changed partial records and preserves other content without claiming a file was deleted', () => {
  const notice = memoryDeleteFailureNotice([partialReceipt, partialReceipt]);
  expect(notice).toContain('1 个记忆文件中的部分记录');
  expect(notice).toContain('文件中的其他内容保留');
  expect(notice).toContain('部分记忆修改已生效');
  expect(notice).not.toContain('已删除 1 条长期记忆');
  expect(memoryDeleteFailureNotice([{ ...partialReceipt, changed: false }])).toBe('');
});
