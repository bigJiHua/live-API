const { reconcileMemoryClaims } = require('../../src/modules/ai/service/memoryClaims');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const receipt = { saved: true, path: 'preferences.md', revision: 'a'.repeat(64) };

test.each(['已记住你的图表偏好。', '我记住了。', '已保存到长期记忆。', '已将你的偏好保存到长期记忆。',
  '已更新答复偏好。', '偏好已保存。', '答复偏好保存成功。'])('missing saved receipt corrects Chinese memory completion: %s', answer => {
  const result = reconcileMemoryClaims(answer, { errors: [{ code: 'AI_MEMORY_CONFLICT' }] });
  expect(result.corrected).toBe(true);
  expect(result.answer).toContain('本轮未保存到长期记忆');
  expect(result.answer).toContain('记忆工具返回了错误');
  expect(() => assertResultClaims(result.businessClaimsText)).not.toThrow();
});

test.each(['I have saved your preferences.', "I've saved it to long-term memory.", 'Saved to memory.',
  'Your preferences have been updated.', 'Updated reply preferences.', 'I have remembered that.'])
  ('missing saved receipt corrects English memory completion: %s', answer => {
    const result = reconcileMemoryClaims(answer, { errors: [{ code: 'AI_MEMORY_CONFLICT' }] });
    expect(result.corrected).toBe(true);
    expect(result.answer).toContain('No long-term memory was saved in this turn');
    expect(result.answer).toContain('The memory tool returned an error');
  });

test.each(['尚未保存到记忆。', '我没有说已保存偏好。', '如果已保存到长期记忆，就能读取。', '确认后会保存到记忆。',
  '上次已更新偏好。', '请不要声称已记住。', '“已更新答复偏好”只是状态示例。', '`已保存偏好`',
  "I haven't saved your preferences.", 'Your preferences have not been saved.', 'If I have saved your preferences, read them.',
  'I will save your preferences.', 'Previously saved preferences remain available.', 'I remember you prefer charts.'])
  ('negation, future, quotes and earlier memories are left intact: %s', answer => {
    expect(reconcileMemoryClaims(answer)).toEqual({ answer, businessClaimsText: answer, corrected: false });
  });

test('an actual saved receipt preserves memory wording while removing only its own business-update trigger', () => {
  const result = reconcileMemoryClaims('已更新答复偏好。以后使用中文和柱状图。', { receipts: [receipt] });
  expect(result.answer).toBe('已更新答复偏好。以后使用中文和柱状图。');
  expect(result.corrected).toBe(false);
  expect(result.businessClaimsText).not.toContain('更新答复偏好');
  expect(() => assertResultClaims(result.businessClaimsText)).not.toThrow();
});

test.each(['已更新答复偏好并修改账本。', '已保存偏好，已修改账本。', '已保存偏好并完成入账。'])
  ('a memory receipt cannot authorize adjacent business execution: %s', answer => {
    const result = reconcileMemoryClaims(answer, { receipts: [receipt] });
    expect(result.answer).toBe(answer);
    expect(() => assertResultClaims(result.businessClaimsText)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });

test('unsupported memory wording is corrected without losing an accompanying business assertion', () => {
  const result = reconcileMemoryClaims('已更新答复偏好并修改账本。');
  expect(result.answer).toContain('本轮未保存到长期记忆');
  expect(result.businessClaimsText).toContain('修改账本');
  expect(() => assertResultClaims(result.businessClaimsText)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test('English business assertions remain outside the dedicated memory span', () => {
  const answer = 'I have saved your preferences and updated the ledger.';
  const result = reconcileMemoryClaims(answer, { receipts: [receipt] });
  expect(result.businessClaimsText).toContain('updated the ledger');
  expect(result.answer).toBe(answer);
});

test('an unrelated saved flag or malformed receipt does not authorize saved wording', () => {
  for (const receipts of [[{ saved: true }], [{ ...receipt, saved: false }], [{ ...receipt, revision: 'guessed' }], null])
    expect(reconcileMemoryClaims('已保存偏好。', { receipts }).corrected).toBe(true);
  expect(reconcileMemoryClaims('已保存偏好。', { receipts: [{ ...receipt, saved: undefined, status: 'saved' }] }).corrected).toBe(false);
});

test('ordinary answers and business assertions are unchanged without memory claims', () => {
  const answer = '已修改账本。支出15元。';
  expect(reconcileMemoryClaims(answer, { receipts: [receipt], errors: [{}] })).toEqual({ answer, businessClaimsText: answer, corrected: false });
});

test('a failed save shows the actual bounded reason instead of asking the user to inspect a hidden trace', () => {
  const result = reconcileMemoryClaims('已保存偏好。', { errors: [{ message: '记忆已被其他操作修改，请重新读取。' }] });
  expect(result.answer).toContain('未保存原因：记忆已被其他操作修改，请重新读取。');
  expect(result.answer).not.toContain('查看具体原因');
  const english = reconcileMemoryClaims('I have saved your preferences.', { errors: [{ message: 'Memory revision has changed; read it again.' }] });
  expect(english.answer).toContain('Save failed: Memory revision has changed; read it again.');
});

test('a displayed save failure hides filesystem paths, keys and internal refs and bounds Unicode safely', () => {
  const result = reconcileMemoryClaims('已保存偏好。', { errors: [{ message:
    `Permission denied: 'D:\\Code\\live\\api\\data\\memory\\secret.md' sk-proj-1234567890abcdef h_${'a'.repeat(32)} ` + '😀'.repeat(400) }] });
  expect(result.answer).toContain('Permission denied');
  expect(result.answer).not.toContain('D:');
  expect(result.answer).not.toContain('secret.md');
  expect(result.answer).not.toContain('sk-proj-');
  expect(result.answer).not.toContain(`h_${'a'.repeat(32)}`);
  expect(Array.from(result.answer.split('未保存原因：')[1]).length).toBeLessThanOrEqual(200);
});

test('failure reasons never echo credential assignments, private numbers, URLs or malformed Unicode', () => {
  const result = reconcileMemoryClaims('已保存偏好。', { errors: [{ message:
    'Failed: API key: abcdefgh password=secret123 6228480402564890018 https://secret.invalid/key \uD800' }] });
  expect(result.answer).toContain('Failed:');
  for (const value of ['abcdefgh', 'secret123', '6228480402564890018', 'secret.invalid', '\uD800']) expect(result.answer).not.toContain(value);
});

test.each(['没有保存你的答复偏好。', '我尚未保存到长期记忆。', '答复偏好没有保存。',
  "I haven't saved your preferences.", 'Your preferences have not been saved.', 'No memory was saved.'])
  ('a real saved receipt corrects a contradictory current generic denial: %s', answer => {
    const result = reconcileMemoryClaims(answer, { receipts: [{ ...receipt, changed: true }] });
    expect(result.corrected).toBe(true);
    expect(result.answer).toMatch(/本轮已保存到长期记忆|Long-term memory was saved in this turn/);
    expect(() => assertResultClaims(result.businessClaimsText)).not.toThrow();
  });

test.each(['上次没有保存你的答复偏好。', '如果没有保存到记忆，请重试。', '“没有保存偏好”是错误状态示例。',
  '没有保存 other.md 的偏好。', '版本冲突，没有保存你的偏好。'])
  ('a saved receipt does not rewrite history, conditions, examples, another file or revision conflict: %s', answer => {
    expect(reconcileMemoryClaims(answer, { receipts: [receipt] }).answer).toBe(answer);
  });

test('a failed second write and an unchanged receipt preserve the corresponding negative update', () => {
  const answer = '没有保存你的答复偏好。';
  expect(reconcileMemoryClaims(answer, { receipts: [receipt], errors: [{ code: 'AI_MEMORY_CONFLICT', message: '版本冲突' }] }).answer).toBe(answer);
  expect(reconcileMemoryClaims('没有更新答复偏好。', { receipts: [{ ...receipt, changed: false }] }).corrected).toBe(false);
});

test('correcting a generic denial does not rewrite a separate business denial or completion', () => {
  const result = reconcileMemoryClaims('没有保存偏好，并且未修改账本。', { receipts: [receipt] });
  expect(result.answer).toContain('未修改账本');
  expect(() => assertResultClaims(result.businessClaimsText)).not.toThrow();
  const unsafe = reconcileMemoryClaims('没有保存偏好，但是已修改账本。', { receipts: [receipt] });
  expect(unsafe.businessClaimsText).toContain('已修改账本');
  expect(() => assertResultClaims(unsafe.businessClaimsText)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each([
  '我记住了那个夏天。',
  '我已经记住了那些星光。',
  '我牢记了那阵风。',
  'I have remembered that summer.',
  "I've remembered that summer.",
  '长期记忆是本文的讨论对象。\n我记住了那个夏天。',
  '记忆库需要维护，但我记住了那个夏天。',
  'I have remembered that summer. Memory is the topic of this article.',
  'This article discusses memory. I have remembered that summer.',
])('explicit-only memory checks preserve literary remembrance and unrelated memory topics: %s', answer => {
  for (const options of [{}, { receipts: [receipt] }, { errors: [{}] }]) {
    expect(reconcileMemoryClaims(answer, { ...options, explicitOnly: true }))
      .toEqual({ answer, businessClaimsText: answer, corrected: false });
  }
});

test.each(['已保存到长期记忆。', '已更新答复偏好。', '我已经记住了你的图表偏好。',
  'I have saved your preferences.', "I've saved it to long-term memory.", 'Saved to memory.'])
  ('explicit-only mode still reconciles unsupported system memory effects: %s', answer => {
    const result = reconcileMemoryClaims(answer, { explicitOnly: true });
    expect(result.corrected).toBe(true);
    expect(result.answer).toMatch(/本轮未保存到长期记忆|No long-term memory was saved in this turn/);
    expect(reconcileMemoryClaims(answer, { explicitOnly: true, receipts: [receipt] }).answer).toBe(answer);
  });

test('explicit-only selection is local to each memory claim span in a mixed article', () => {
  const result = reconcileMemoryClaims('我记住了那个夏天。已保存到长期记忆。', { explicitOnly: true });
  expect(result.answer).toBe('我记住了那个夏天。本轮未保存到长期记忆。');
  expect(result.businessClaimsText).toContain('我记住了那个夏天。');
  const english = reconcileMemoryClaims('I have remembered that summer. I have saved your preferences.', { explicitOnly: true });
  expect(english.answer).toContain('I have remembered that summer.');
  expect(english.answer).toContain('No long-term memory was saved in this turn');
});

test('explicit-only reconciliation retains adjacent unsupported business effects', () => {
  const result = reconcileMemoryClaims('已更新答复偏好并修改账本。', { explicitOnly: true });
  expect(result.answer).toContain('本轮未保存到长期记忆');
  expect(result.businessClaimsText).toContain('修改账本');
  expect(() => assertResultClaims(result.businessClaimsText, { scope: 'prose' }))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test('the default memory checker retains bare-remembrance reconciliation', () => {
  const answer = '我记住了那个夏天。';
  expect(reconcileMemoryClaims(answer).corrected).toBe(true);
  expect(reconcileMemoryClaims(answer, { explicitOnly: false })).toEqual(reconcileMemoryClaims(answer));
});

test.each(['true', null, 1, {}])('invalid explicit-only switches fail closed: %p', explicitOnly => {
  expect(() => reconcileMemoryClaims('普通文章。', { explicitOnly }))
    .toThrow(expect.objectContaining({ code: 'AI_INVALID_RESULT' }));
});

describe.each([false, true])('tilde Markdown memory examples with explicitOnly=%s', explicitOnly => {
  test.each([
    '~~~text\n已保存到长期记忆。\n~~~\n普通文章。',
    '~~~~text\n已保存到长期记忆。\n~~~\n仍在围栏内。\n~~~~\n普通文章。',
    '  ~~~text\r\n没有保存到长期记忆。\r\n  ~~~~\r\n普通文章。',
  ])('closed tilde examples remain unchanged with or without real receipts: %s', answer => {
    for (const receipts of [[], [receipt]]) expect(reconcileMemoryClaims(answer, { explicitOnly, receipts }))
      .toEqual({ answer, businessClaimsText: answer, corrected: false });
  });
  test('an unsupported outside save is corrected without rewriting its quoted example', () => {
    const quoted = '~~~text\n已保存到长期记忆。\n~~~\n';
    const result = reconcileMemoryClaims(quoted + '已保存到长期记忆。', { explicitOnly });
    expect(result.answer).toBe(quoted + '本轮未保存到长期记忆。');
  });
  test('an outside false denial is reconciled with the actual saved receipt', () => {
    const quoted = '~~~text\n没有保存到长期记忆。\n~~~\n';
    const result = reconcileMemoryClaims(quoted + '没有保存到长期记忆。', { explicitOnly, receipts: [receipt] });
    expect(result.answer).toBe(quoted + '本轮已保存到长期记忆。');
  });
  test('an unclosed tilde fence cannot hide a system memory assertion', () => {
    const result = reconcileMemoryClaims('~~~~text\n普通文章。\n~~~\n已保存到长期记忆。', { explicitOnly });
    expect(result.answer).toContain('本轮未保存到长期记忆');
    expect(result.corrected).toBe(true);
  });
});
