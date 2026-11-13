const http = require('node:http');
const { deepseekChat, deepseekChatStream } = require('../../src/modules/ai/service/deepseek');

let server, base, received;
const packet = (content, finish = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: content == null ? {} : { role: 'assistant', content }, finish_reason: finish }] }) + '\n\n';
beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  received = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body); received.push(input);
      res.writeHead(200, { 'Content-Type': input.stream ? 'text/event-stream' : 'application/json' });
      res.write(input.stream ? packet('hello') : ' ');
      // Keep delivering bytes so the socket idle timer never expires.
      const heartbeat = setInterval(() => res.write(input.stream ? ': still generating\n\n' : ' '), 100);
      const finish = setTimeout(() => res.end(input.stream ? packet(null, 'stop') + 'data: [DONE]\n\n' : JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { total_tokens: 3 } })), 1600);
      res.on('close', () => { clearInterval(heartbeat); clearTimeout(finish); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); jest.restoreAllMocks(); });
const config = timeout => ({ baseUrl: base, model: 'fixture-model', apiKey: 'fixture-key', providerTimeoutMs: timeout });

test.each([['stream', deepseekChatStream], ['JSON', deepseekChat]])('%s completion uses an absolute deadline even while the provider keeps sending bytes', async (_, chat) => {
  const started = Date.now();
  await expect(chat(config(1000), [], [], { maxTokens: 128 })).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT', status: 504 });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(received).toHaveLength(1);
  expect(received[0].max_tokens).toBe(128);
});

test('raising the provider timeout allows the same stream to finish past its previous deadline', async () => {
  await expect(deepseekChatStream(config(2200), [], [], { maxTokens: 256 })).resolves.toMatchObject({ message: { content: 'hello' } });
  expect(received).toHaveLength(1);
  expect(received[0].max_tokens).toBe(256);
});

test('caller cancellation still interrupts a streaming response before the provider deadline', async () => {
  const controller = new AbortController();
  const pending = deepseekChatStream(config(2200), [], [], { maxTokens: 128, signal: controller.signal }, delta => {
    if (delta.type === 'content') controller.abort();
  });
  await expect(pending).rejects.toMatchObject({ causeCode: 'ERR_CANCELED' });
  expect(received).toHaveLength(1);
});
