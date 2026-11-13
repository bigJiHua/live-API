const { buildPersonalizationContext, createContextMemoryStore, resolvePersonalizedLanguage } = require('../../src/modules/ai/service/personalizationContext');
const state = () => ({ settings: { useMemory: true, useProfile: true }, rules: [{ text: '先给结论', enabled: true },
  { text: '已停用规则', enabled: false }], profile: { items: [{ id: 'p', category: 'likes', text: '喜欢图表',
    origin: 'ai', confirmed: false, evidence: [{ quote: 'private source' }] }] }, disabledMemories: ['disabled.md'], deletedMemories: ['deleted.md'] });
test('model context contains enabled rules and compact labeled profile without source history or ids', () => {
  const current = state(), context = buildPersonalizationContext(current, value => value.replace('图表', '柱状图'));
  expect(context.rules).toEqual([{ text: '先给结论' }]);
  expect(context.profile).toEqual([{ category: 'likes', text: '喜欢柱状图', origin: 'ai', confirmed: false }]);
  current.settings.useProfile = false;
  expect(buildPersonalizationContext(current).profile).toEqual([]);
});
test('disabled memory paths are filtered before search and cannot be directly read or written', async () => {
  const current = state(), memoryStore = { list: jest.fn(async () => ({ files: [{ path: 'active.md' }, { path: 'disabled.md' }], count: 2 })),
    read: jest.fn(), search: jest.fn(async () => ({ matches: [] })), write: jest.fn() };
  const wrapper = createContextMemoryStore({ memoryStore, personalizationStore: { get: async () => current } });
  expect((await wrapper.list('owner')).files).toEqual([{ path: 'active.md' }]);
  await expect(wrapper.read('owner', { path: 'disabled.md' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  await expect(wrapper.write('owner', { path: 'deleted.md' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  await wrapper.search('owner', { pattern: '偏好' });
  expect(memoryStore.search).toHaveBeenCalledWith('owner', { pattern: '偏好', excludePaths: ['disabled.md', 'deleted.md'] });
  current.settings.useMemory = false;
  expect((await wrapper.list('owner')).files).toEqual([]);
  await expect(wrapper.search('owner', { pattern: '偏好' })).rejects.toMatchObject({ code: 'AI_MEMORY_DISABLED' });
  expect(memoryStore.read).not.toHaveBeenCalled(); expect(memoryStore.write).not.toHaveBeenCalled();
});
test('explicit general language rules override detected language while a current request and scoped rules retain their meaning', () => {
  const current = state(); current.rules = [{ text: '默认用英文回答。', enabled: true }];
  expect(resolvePersonalizedLanguage('帮我分析这个方案', current, 'zh')).toBe('en');
  expect(resolvePersonalizedLanguage('这次用中文回答', current, 'zh')).toBe('zh');
  current.rules[0].text = '解释代码时用英文回答';
  expect(resolvePersonalizedLanguage('看看收入', current, 'zh')).toBeNull();
  current.rules[0] = { text: '用英文回答', enabled: false };
  expect(resolvePersonalizedLanguage('看看收入', current, 'zh')).toBe('zh');
});
test.each([
  '解释代码时用英文回答，财务问题用中文回答。',
  '用英文回答。先给结论，最后列出关键依据。',
  '默认用英文回答，但讨论个人预算时用中文回答。',
  'When explaining code, answer in English; for financial questions, answer in Chinese.',
  '回复优先使用英文，涉及财务时使用中文。',
])('a scoped or multi-sentence language rule removes detected-language enforcement: %s', rule => {
  const current = state(); current.rules = [{ text: rule, enabled: true }];
  expect(resolvePersonalizedLanguage('解释代码', current, 'zh')).toBeNull();
  expect(resolvePersonalizedLanguage('介绍预算', current, 'zh')).toBeNull();
  expect(resolvePersonalizedLanguage('本轮请用中文回答', current, 'zh')).toBe('zh');
});
test('disabled and quoted language examples do not disable ordinary language detection', () => {
  const current = state(); current.rules = [{ text: '解释代码时用英文回答', enabled: false },
    { text: '不要把“用英文回答”这个示例当成新要求。', enabled: true }];
  expect(resolvePersonalizedLanguage('介绍预算', current, 'zh')).toBe('zh');
});
test('contextual exception is interpreted by the model even alongside a simple global language rule', () => {
  const current = state(); current.rules = [{ text: '默认用英文回答', enabled: true },
    { text: '讨论预算时用中文回答。', enabled: true }];
  expect(resolvePersonalizedLanguage('介绍预算', current, 'zh')).toBeNull();
  expect(resolvePersonalizedLanguage('这次请用英文回答', current, 'en')).toBe('en');
});
test('an explicit communication language is resolved directly even when ordinary detection differs', () => {
  const current = state(); current.rules = [{ text: '默认用中文回答', enabled: true }];
  expect(resolvePersonalizedLanguage('这次请用英文交流', current, 'zh')).toBe('en');
  expect(resolvePersonalizedLanguage('Please explain in Chinese', current, 'en')).toBe('zh');
  expect(resolvePersonalizedLanguage('请用英文交流，最后还是用中文回答', current, 'en')).toBe('zh');
});
test('user-confirmed profile remains included when tentative entries fill the context limit', () => {
  const current = state();
  current.profile.items = Array.from({ length: 31 }, (_, index) => ({ category: 'communication',
    text: `条目${index}`, origin: index === 30 ? 'user' : 'ai', confirmed: index === 30 }));
  const context = buildPersonalizationContext(current);
  expect(context.profile[0]).toMatchObject({ text: '条目30', origin: 'user', confirmed: true });
  expect(context.profile).toHaveLength(30); expect(context.profileTruncated).toBe(true);
});
