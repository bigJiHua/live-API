jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Live database forbidden'); }) }));
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAiRouter } = require('../../src/modules/ai/api');
const { createMemoryStore } = require('../../src/modules/ai/service/memoryStore');
const { createPersonalizationStore } = require('../../src/modules/ai/service/personalizationStore');
let directory, server, base;
const profileGeneration = { generate: jest.fn() };
async function request(url, method = 'GET', data, owner = 'personalization-owner') {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-owner': owner },
    ...(data === undefined ? {} : { body: JSON.stringify({ data }) }) });
  return { status: response.status, ...(await response.json()) };
}
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'personalization-http-'));
  const app = express(); app.use(express.json());
  app.use('/ai', createAiRouter({ service: {}, agent: {}, business: {},
    memoryStore: createMemoryStore({ root: path.join(directory, 'memory') }),
    personalizationStore: createPersonalizationStore({ root: path.join(directory, 'personalization') }), profileGeneration,
    guard: (req, res, next) => { req.userId = req.headers['x-owner']; next(); } }));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/ai`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
test('editable memories share one owner-bound store, reject stale edits, and restore deleted versions', async () => {
  const initial = (await request('/personalization')).data;
  expect(initial.settings).toEqual({ useMemory: true, useProfile: true, autoProfile: true });
  const created = await request('/memories', 'POST', { title: '回答偏好', type: 'preference', content: '解释方案时先给结论。' });
  expect(created.status).toBe(200);
  const memory = created.data;
  const edited = await request(`/memories/${memory.path}`, 'PUT', { expectedRevision: memory.revision,
    title: '回答偏好', type: 'preference', content: '先给结论，再解释关键原因。' });
  expect(edited.data.content).toContain('再解释关键原因');
  expect((await request(`/memories/${memory.path}`, 'PUT', { expectedRevision: memory.revision,
    title: '回答偏好', type: 'preference', content: '旧编辑不应覆盖。' })).status).toBe(409);
  expect((await request(`/memories/${memory.path}`, 'GET', undefined, 'other-owner')).status).toBe(404);
  expect((await request(`/memories/${memory.path}`, 'DELETE', { expectedRevision: edited.data.revision })).status).toBe(200);
  expect((await request('/memories')).data.files).toEqual([]);
  const history = (await request(`/memories/history?path=${memory.path}`)).data.entries;
  const deletion = history.find(entry => entry.action === 'delete');
  const restored = await request(`/memories/${memory.path}/restore`, 'POST', { historyId: deletion.id });
  expect(restored.data.content).toContain('再解释关键原因');
  expect((await request('/memories/history', 'GET', undefined, 'other-owner')).data.entries).toEqual([]);
});
test('profile and rules revisions are persisted and profile generation receives only authenticated identity', async () => {
  const initial = (await request('/personalization')).data;
  const saved = await request('/personalization', 'PUT', { expectedRevision: initial.revision,
    settings: { autoProfile: false }, rules: [{ id: 'brief_rule', text: '先给结论。', enabled: true }] });
  expect(saved.status).toBe(200); expect(saved.data.rules[0].text).toBe('先给结论。');
  expect((await request('/personalization', 'PUT', { expectedRevision: initial.revision, rules: [] })).status).toBe(409);
  profileGeneration.generate.mockResolvedValue(saved.data);
  const generated = await request('/personalization/profile/generate', 'POST', { expectedRevision: saved.data.revision, mode: 'rebuild' });
  expect(generated.status).toBe(200);
  expect(profileGeneration.generate).toHaveBeenCalledWith('personalization-owner', expect.objectContaining({
    expectedRevision: saved.data.revision, mode: 'rebuild', requestId: expect.any(String), signal: expect.any(AbortSignal) }));
  expect((await request('/personalization/profile/generate', 'POST', { expectedRevision: saved.data.revision, userId: 'other-owner' })).status).toBe(400);
  expect((await request('/personalization')).data.settings.autoProfile).toBe(false);
});
