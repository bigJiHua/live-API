const { businessPolicy } = require('../../src/modules/ai/service/businessPolicy');
const { createBusinessService } = require('../../src/modules/ai/service/businessService');
test('production requires explicitly enabling business and separately enabling actions', () => {
  expect(businessPolicy({ NODE_ENV: 'production' })).toMatchObject({ enabled: false, actions: [] });
  expect(businessPolicy({ NODE_ENV: 'production', AI_BUSINESS_ENABLED: 'true', AI_BUSINESS_ACTIONS: 'todo.create,diary.create' })).toMatchObject({ enabled: true, actions: ['todo.create', 'diary.create'] });
});
test('domain/actions are static whitelists and false immediately disables new business', () => {
  expect(businessPolicy({ AI_BUSINESS_ENABLED: 'false' }).enabled).toBe(false);
  expect(businessPolicy({ AI_BUSINESS_DOMAINS: 'finance,fund,finance', AI_BUSINESS_ACTIONS: '' })).toMatchObject({ domains: ['finance', 'fund'], actions: [] });
  expect(() => businessPolicy({ AI_BUSINESS_ACTIONS: 'card.repay' })).toThrow();
  expect(() => businessPolicy({ AI_BUSINESS_DOMAINS: 'user_info' })).toThrow();
});
test('closed capability cannot open a session, query, or start any provider', async () => {
  const provider = jest.fn();
  const service = createBusinessService({ legacyService: { getRuntime: () => ({ config: { mode: 'deepseek', dataSource: 'user-readonly' }, businessPolicy: { enabled: false } }) }, provider });
  await expect(service.session('u')).rejects.toMatchObject({ code: 'AI_BUSINESS_DISABLED' }); expect(provider).not.toHaveBeenCalled();
});
