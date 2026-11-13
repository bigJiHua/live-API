const { deriveBusinessScope } = require('../helpers/legacyBusinessScope');
const now = new Date('2026-11-06T03:00:00Z');
test.each([
  ['最近3个月信用卡消费', ['card'], '2026-09-01', '2026-11-06'],
  ['近十二个月的支出', ['finance'], '2025-12-01', '2026-11-06'],
  ['上个月的工资', ['work'], '2026-10-01', '2026-10-31'],
  ['今年收支', ['finance'], '2026-01-01', '2026-11-06'],
  ['过去7天消费', ['finance'], '2026-10-31', '2026-11-06'],
  ['未来待办', ['todo'], '2026-11-06', '2026-12-06'],
  ['明天待办', ['todo'], '2026-11-07', '2026-11-07'],
  ['查看2026-01-01到2026-02-28收益', ['fund'], '2026-01-01', '2026-02-28'],
])('visible preview resolves %s without using any provider', (message, domains, startDate, endDate) => {
  expect(deriveBusinessScope({ domains }, message, now)).toEqual({ domains, startDate, endDate });
});
test('UI explicit date bounds have priority and invalid/excessive natural scope fails closed', () => {
  expect(deriveBusinessScope({ domains: ['finance'], startDate: '2026-06-01', endDate: '2026-06-30' }, '今年', now).startDate).toBe('2026-06-01');
  for (const message of ['近13个月', '过去500天', '未来500天', '查询2026-02-30']) expect(() => deriveBusinessScope({ domains: ['todo'] }, message, now)).toThrow();
});
