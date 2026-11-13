const { assertV3ProposalIntent, assertProposalIntent } = require('../../src/modules/ai/service/businessIntent');

test.each(['明天取快递', '明天去取快递', '我明天下午3点取快递', '后天去看医生', '下周一上午9:30开会', '2026-11-10去办证', '11月10号参加面试', '今晚跑步', '明天买菜', '今晚吃药', '后天打疫苗', '提醒我明天查看账单'])
  ('personal scheduled activity can create a reviewable todo: %s', message => {
    expect(assertV3ProposalIntent('todo.create', message)).toBe(true);
  });

test('natural allowance belongs only to V3 todo creation', () => {
  expect(() => assertProposalIntent('todo.create', '明天取快递')).toThrow();
  for (const kind of ['todo.update', 'todo.complete', 'todo.delete', 'fixedAsset.delete', 'fixedAsset.permanentDelete', 'system.backup']) {
    expect(() => assertV3ProposalIntent(kind, '明天取快递')).toThrow(expect.objectContaining({ code: 'AI_ACTION_NOT_REQUESTED' }));
  }
});

test.each(['明天有哪些待办', '查看明天取快递的待办', '明天取快递吗？', '明天取快递呢', '不要明天取快递', '明天不去取快递', '昨天取快递', '明天已经取快递了', '明天张三取快递', '他说“明天取快递”', '明天“删除取快递”', '示例：明天取快递', '明天取快递是个故事', '明天去取快递这句话作为测试', '明天永久删除资产', '明天修改固定资产名称', '明天收入100元', '明天傻傻的'])
  ('questions, negation, story and unrelated actions do not create todos: %s', message => {
    expect(() => assertV3ProposalIntent('todo.create', message)).toThrow(expect.objectContaining({ code: 'AI_ACTION_NOT_REQUESTED' }));
  });

test.each([
  ['todo.delete', '晚上好'], ['todo.delete', '查看我的待办'], ['todo.delete', '明天取快递'], ['todo.delete', '看看待办“删除取快递”'],
  ['todo.complete', '明天有哪些已完成待办'], ['fixedAsset.permanentDelete', '删除固定资产电脑'],
  ['fixedAsset.permanentDelete', '看看固定资产“彻底删除电脑”'], ['fixedAsset.permanentDelete', '不要彻底删除固定资产电脑'],
])('destructive actions remain bound to explicit matching intent: %s %s', (kind, message) => {
  expect(() => assertV3ProposalIntent(kind, message)).toThrow(expect.objectContaining({ code: 'AI_ACTION_NOT_REQUESTED' }));
});

test.each([
  ['todo.delete', '请删除待办「不要删除备忘」'], ['fixedAsset.permanentDelete', '彻底删除固定资产电脑'],
  ['todo.create', '新增待办，内容是「明天查看账单」'], ['todo.update', '把取快递待办日期改到明天'],
])('explicit commands retain their existing per-kind semantics: %s %s', (kind, message) => {
  expect(assertV3ProposalIntent(kind, message)).toBe(true);
});
