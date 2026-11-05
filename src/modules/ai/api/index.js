const express = require('express');
const authGuard = require('../../../common/middleware/authGuard');
const { capabilities } = require('../service/config');
const { createAiService } = require('../service');
const { AiError } = require('../service/errors');

function createAiRouter({ guard = authGuard, service = createAiService(), env = process.env, clock = Date.now } = {}) {
  const router = express.Router();
  const limits = new Map();
  const draftLimits = new Map();
  const settingsLimits = new Map();
  router.use(guard);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/capabilities', (req, res) => res.json({ status: 200, data: service.getCapabilities?.(req.userId) || capabilities(env) }));
  router.get('/settings', (req, res) => res.json({ status: 200, data: service.getSettings(req.userId) }));
  const settingsHandler = clear => async (req, res) => {
    const now = clock();
    for (const [id, entry] of settingsLimits) if (entry.until <= now && !entry.active) settingsLimits.delete(id);
    const entry = settingsLimits.get(req.userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 5 || (!settingsLimits.has(req.userId) && settingsLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '连接设置操作过于频繁，请稍后重试' });
    }
    entry.count++; entry.active = true; settingsLimits.set(req.userId, entry);
    try {
      const data = clear ? service.clearSettings(req.userId) : await service.configure(req.userId, req.body?.data ?? req.body);
      res.json({ status: 200, ismessage: true, data });
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError('连接设置失败，请重试', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  };
  router.put('/settings', settingsHandler(false));
  router.delete('/settings', settingsHandler(true));
  router.post('/chat', async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [key, entry] of limits) if (entry.until <= now && !entry.active) limits.delete(key);
    const entry = limits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 6 || (!limits.has(userId) && limits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: 'AI 请求过于频繁，请稍后重试' });
    }
    entry.active = true;
    entry.count++;
    limits.set(userId, entry);
    try {
      const result = await service.run(userId, req.body?.data ?? req.body);
      res.json({ status: 200, ismessage: true, message: 'AI 测试完成', data: result });
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError('AI 测试失败，请稍后重试', 500, 'AI_INTERNAL_ERROR');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  });
  router.get('/drafts/:id', (req, res) => {
    try { res.json({ status: 200, data: service.getDraft(req.userId, req.params.id) }); }
    catch (_) { res.status(404).json({ status: 404, message: '草稿不存在或已过期' }); }
  });
  const draftHandler = method => async (req, res) => {
    const now = clock();
    for (const [key, entry] of draftLimits) if (entry.until <= now) draftLimits.delete(key);
    const entry = draftLimits.get(req.userId) || { until: now + 60000, count: 0 };
    if (entry.count >= 30 || (!draftLimits.has(req.userId) && draftLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '草稿操作过于频繁，请稍后重试' });
    }
    entry.count++;
    draftLimits.set(req.userId, entry);
    try {
      const draft = await service[method](req.userId, req.params.id, req.body?.data ?? req.body);
      res.json({ status: 200, ismessage: true, data: draft });
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError('草稿操作失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  };
  router.put('/drafts/:id', draftHandler('editDraft'));
  router.post('/drafts/:id/action', draftHandler('actOnDraft'));
  // Review/cancel only mutate isolated proposals. There is no formal commit endpoint.
  return router;
}
module.exports = createAiRouter();
module.exports.createAiRouter = createAiRouter;
