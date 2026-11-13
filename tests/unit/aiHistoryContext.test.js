const { selectHistoryTurns, buildHistoryContext } = require('../../src/modules/ai/service/historyContext');
const date = '2026-11-08';
const user = (id, text = '用的借记卡') => ({ role: 'user', turnId: id, content: text, sourceDate: date });
const answer = (id, text, failure) => ({ role: 'assistant', turnId: id, content: text, ...(failure ? { failure: { code: failure } } : {}) });

test('identical user sentences on one date bind to their own success or failure', () => {
  const history = [user('first'), answer('first', '第一次失败', 'AI_GRANT_REQUIRED'), user('second'), answer('second', '第二次失败', 'AI_PROVIDER_RATE_LIMIT'),
    user('third'), answer('third', '保留的三笔交易')];
  const bound = buildHistoryContext({ history, userTurns: ['用的借记卡', '用的借记卡', '用的借记卡', '下一句'],
    userTurnDates: [date, date, date, date], userTurnIds: ['first', 'second', 'third', 'current'] });
  expect(bound.turns.map(turn => [turn.turnId, turn.status, turn.answer])).toEqual([['first', 'failed', null], ['second', 'failed', null], ['third', 'completed', '保留的三笔交易']]);
  expect(bound.priorAnswers).toEqual([null, null, '保留的三笔交易']);
  expect(bound.previousFailures.map(item => item.errorCode)).toEqual(['AI_GRANT_REQUIRED', 'AI_PROVIDER_RATE_LIMIT']);
});
test('standalone assistant cards cannot replace a user turn reply or use a history slot', () => {
  const history = [user('first', '5月收支'), answer('first', '五月查询'), ...Array.from({ length: 12 }, () => ({ role: 'assistant', standalone: true, content: '更新卡片' })),
    user('second', '6月收支'), answer('second', '六月查询')];
  expect(selectHistoryTurns(history).map(turn => turn.answer)).toEqual(['五月查询', '六月查询']);
});
test('a pending source outside the prose window is identified without borrowing another reply', () => {
  const history = [user('recent', '7476那张'), answer('recent', '账户问题')];
  const bound = buildHistoryContext({ history, userTurns: ['买菜30.82元', '7476那张', '确认'],
    userTurnDates: [date, date, date], userTurnIds: ['pinned_source', 'recent', 'current'] });
  expect(bound.turns[0]).toMatchObject({ turnId: 'pinned_source', answer: null, status: 'awaiting_input' });
  expect(bound.turns[1]).toMatchObject({ turnId: 'recent', answer: '账户问题', status: 'completed' });
});
test('legacy history without turn identities remains paired by adjacency and occurrence', () => {
  const history = [{ role: 'user', content: '重复', sourceDate: date }, { role: 'assistant', content: '第一答' },
    { role: 'user', content: '重复', sourceDate: date }, { role: 'assistant', content: '第二答' }];
  const bound = buildHistoryContext({ history, userTurns: ['重复', '重复', '当前'], userTurnDates: [date, date, date] });
  expect(bound.priorAnswers).toEqual(['第一答', '第二答']);
});
test('answer ordering follows turn identity even with out of order assistant rows', () => {
  const history = [user('one', '5月'), user('two', '6月'), answer('two', '六月答案'), answer('one', '五月答案')];
  expect(selectHistoryTurns(history).map(turn => turn.answer)).toEqual(['五月答案', '六月答案']);
});
test('a zero-turn window is empty and input objects are not mutated', () => {
  const history = [user('one'), answer('one', '答案')], before = structuredClone(history);
  expect(selectHistoryTurns(history, { limit: 0 })).toEqual([]);
  selectHistoryTurns(history); expect(history).toEqual(before);
});
