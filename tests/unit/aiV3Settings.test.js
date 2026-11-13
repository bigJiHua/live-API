// 负责人 2026-11-08 实测：浮层快捷切模型 PUT /settings 带 connectionId 被 schema unknown(false)
// 拒绝 400 AI_INVALID_INPUT（service.configure 自己解析 connectionId 却把完整 input 传入 validate）。
// 回归锁：connectionId 是路由层字段，schema 必须放行；validate 通过后 model 更新落存档。
const { createSettingsStore } = require('../../src/modules/ai/service/settings');
const { AiError } = require('../../src/modules/ai/service/errors');

const BASE = { apiUrl: 'https://api.sensenova.cn/v1', apiKey: 'fixture-key-12345', model: 'sensenova-6.8-flash' };
const freshStore = () => createSettingsStore({ now: () => 1731000000000 });

test('model switch with connectionId passes validation and updates the saved provider', () => {
  const store = freshStore();
  store.save('owner', { ...BASE });
  const saved = store.get('owner');
  expect(saved.connectionId).toEqual(expect.any(String));
  const validated = store.validate({ connectionId: saved.connectionId, model: 'deepseek-flash', apiUrl: saved.apiUrl }, saved);
  expect(validated.model).toBe('deepseek-flash');
  expect(validated.apiUrl).toBe('https://api.sensenova.cn/v1');
  store.save('owner', validated, { connectionId: saved.connectionId });
  expect(store.get('owner').model).toBe('deepseek-flash');
  expect(store.get('owner').active).toBe(true);
});

test('missing apiUrl still fails validation; configure layer fills it from the saved provider', () => {
  const store = freshStore();
  store.save('owner', { ...BASE });
  const saved = store.get('owner');
  expect(() => store.validate({ connectionId: saved.connectionId, model: 'deepseek-flash' }, saved))
    .toThrow(AiError);
});

test('unknown fields outside the schema are still rejected', () => {
  const store = freshStore();
  expect(() => store.validate({ ...BASE, rogue: 1 }, null)).toThrow();
});