// Explicit loopback-only synthetic sandbox. Never import app.js, dotenv or writable models.
if (process.env.NODE_ENV === 'production') throw new Error('AI sandbox is development-only');
const express = require('express');
const crypto = require('crypto');
const { createAiService } = require('../src/modules/ai/service');
const { createAiRouter } = require('../src/modules/ai/api');
const app = express();
const env = { AI_MODE: 'mock', NODE_ENV: 'development' };
const key = crypto.randomBytes(32);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.body?._p) {
    try {
      const payload = req.body._p;
      if (typeof payload !== 'string' || payload.length < 33) throw new Error('Invalid envelope');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(payload.slice(0, 32), 'hex'));
      req.body = JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.slice(32), 'base64')), decipher.final()]).toString('utf8'));
    } catch (_) { return res.status(400).json({ status: 400, message: '模拟握手已失效，请刷新页面' }); }
  }
  next();
});
app.get('/api/v1/auth/me', (_, res) => res.json({ status: 200,
  data: { id: 'ai_sandbox_user', username: 'AI 模拟联调', isAdmin: false } }));
app.get('/api/v1/auth/handshake', (_, res) => res.json({ status: 200, key: key.toString('hex') }));
const guard = (req, _, next) => { req.userId = 'ai_sandbox_user'; next(); };
app.use('/api/v1/ai', createAiRouter({ guard, env, service: createAiService({ env }) }));
app.use((_, res) => res.status(404).json({ status: 404, message: '模拟沙盒仅提供 AI 测试接口' }));
const port = Number(process.env.AI_SANDBOX_PORT || 8866);
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`AI synthetic sandbox: http://127.0.0.1:${port}`);
  console.log('No database, no external AI, no formal accounting writes.');
});
server.on('error', error => { console.error(`Sandbox start failed: ${error.code}`); process.exitCode = 1; });
