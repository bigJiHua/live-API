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
  const balanceLimits = new Map();
  router.use(guard);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // 追加163：DeepSeek 官方账户余额查询（非系统账本余额）
  router.get('/balance', async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [id, entry] of balanceLimits) if (entry.until <= now && !entry.active) balanceLimits.delete(id);
    const entry = balanceLimits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 10 || (!balanceLimits.has(userId) && balanceLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '余额查询过于频繁，请稍后重试' });
    }
    entry.active = true; entry.count++; balanceLimits.set(userId, entry);
    try { res.json({ status: 200, data: await service.getBalance(userId) }); }
    catch (error) {
      const safe = error instanceof AiError ? error : new AiError('余额查询失败，请稍后重试', 502);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  });
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
  const chatHandler = method => async (req, res) => {
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
      const result = await service[method](userId, req.body?.data ?? req.body);
      res.json({ status: 200, ismessage: true, message: 'AI 测试完成', data: result });
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError('AI 测试失败，请稍后重试', 500, 'AI_INTERNAL_ERROR');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  };
  // Chat and OCR share the same per-user rate and concurrency budget.
  router.post('/chat', chatHandler('run'));
  router.post('/ocr', chatHandler('runOcr'));
  router.get('/drafts/:id', async (req, res) => {
    try { res.json({ status: 200, data: await service.getDraft(req.userId, req.params.id) }); }
    catch (error) {
      const safe = error instanceof AiError ? error : new AiError('草稿暂时无法读取，请稍后重试', 503, 'AI_DRAFT_READ_FAILED');
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
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
  // 追加163：入账确认——只收 ID+version（不收业务字段），入账内容全部取自库存档草稿。
  // ===== 追加163 扩展：历史聊天记录 =====
  router.get('/conversations', async (req, res) => {
    try { res.json({ status: 200, data: await service.listConversations(req.userId) }); }
    catch (error) {
      const safe = error instanceof AiError ? error : new AiError('历史读取失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  router.get('/conversations/:id/messages', async (req, res) => {
    try { res.json({ status: 200, data: await service.getConversationMessages(req.userId, req.params.id) }); }
    catch (error) {
      const safe = error instanceof AiError ? error : new AiError('历史读取失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  router.delete('/conversations/:id', async (req, res) => {
    try { res.json({ status: 200, data: await service.deleteConversation(req.userId, req.params.id) }); }
    catch (error) {
      const safe = error instanceof AiError ? error : new AiError('删除失败', 500);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    }
  });
  // 多供应商：拉取厂商模型列表（Key 优先级 = 传入 > 会话级 > .env）
  router.post('/models', async (req, res) => {
    const userId = req.userId;
    const now = clock();
    for (const [id, entry] of settingsLimits) if (entry.until <= now && !entry.active) settingsLimits.delete(id);
    const entry = settingsLimits.get(userId) || { until: now + 60000, count: 0, active: false };
    if (entry.active || entry.count >= 5 || (!settingsLimits.has(userId) && settingsLimits.size >= 1000)) {
      return res.status(429).json({ status: 429, code: 'AI_RATE_LIMIT', message: '操作过于频繁，请稍后重试' });
    }
    entry.active = true; entry.count++; settingsLimits.set(userId, entry);
    try { res.json({ status: 200, data: await service.fetchProviderModels(userId, req.body?.data ?? req.body) }); }
    catch (error) {
      const safe = error instanceof AiError ? error : new AiError('模型列表获取失败', 502);
      res.status(safe.status).json({ status: safe.status, code: safe.code, message: safe.message });
    } finally { entry.active = false; }
  });
  // Review/cancel only mutate isolated proposals; formal commit requires the reviewed draft ID/version.
  router.post('/drafts/:id/commit', draftHandler('commitDraft'));
  return router;
}
module.exports = createAiRouter();
module.exports.createAiRouter = createAiRouter;
