// Archived snapshot-service contract fixture. This is never used by the app;
// production retirement and V3 routing are tested in aiV3Contract.test.js.
const express = require('express');
const { AiError } = require('../../src/modules/ai/service/errors');
function createLegacyBusinessFixtureRouter({ guard, service, business }) {
  const router = express.Router();
  router.use(guard);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const invoke = method => async (req, res) => {
    try {
      const input = req.body?.data ?? req.body;
      let result;
      if (method === 'session') {
        if (req.method === 'POST' && (!input || input.kind !== 'manual' || Object.keys(input).some(key => key !== 'kind')))
          throw new AiError('会话参数无效');
        result = await business.session(req.userId, req.method === 'POST' ? 'manual' : 'default');
      } else if (method === 'getRequestReceipt') result = await service.getRequestReceipt(req.userId, req.params.requestId);
      else if (['getProposal', 'cancelPreview'].includes(method)) result = await business[method](req.userId, req.params.id);
      else if (['editProposal', 'actOnProposal', 'executeProposal'].includes(method)) result = await business[method](req.userId, req.params.id, input);
      else result = await business[method](req.userId, input);
      res.json({ status: 200, data: result });
    } catch (error) { res.status(error.status || 500).json({ status: error.status || 500, code: error.code, message: error.message }); }
  };
  router.post('/v2/preview', invoke('preview'));
  router.delete('/v2/previews/:id', invoke('cancelPreview'));
  router.post('/v2/chat', invoke('chat'));
  router.get('/v2/session', invoke('session'));
  router.post('/v2/session', invoke('session'));
  router.get('/v2/requests/:requestId', invoke('getRequestReceipt'));
  router.get('/v2/proposals/:id', invoke('getProposal'));
  router.put('/v2/proposals/:id', invoke('editProposal'));
  router.post('/v2/proposals/:id/action', invoke('actOnProposal'));
  router.post('/v2/proposals/:id/execute', invoke('executeProposal'));
  return router;
}
module.exports = { createAiRouter: createLegacyBusinessFixtureRouter };
