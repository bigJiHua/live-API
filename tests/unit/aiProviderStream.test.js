jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');
const { PassThrough } = require('stream');
const { collectProviderStream } = require('../../src/modules/ai/service/providerStream');
const { deepseekChatStream } = require('../../src/modules/ai/service/deepseek');
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value, finish = null) => frame({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const done = 'data: [DONE]\n\n';
function replay(chunks, options = {}, end = true) {
  const stream = new PassThrough(), observed = [];
  const pending = collectProviderStream(stream, { maxBytes: 1024 * 1024, onDelta: value => observed.push(value), ...options });
  setImmediate(() => { for (const chunk of chunks) { if (stream.destroyed) break; stream.write(chunk); } if (end && !stream.destroyed) stream.end(); });
  return { stream, observed, pending };
}
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());
test('split UTF-8, CRLF, comments and usage-only frames preserve one completion', async () => {
  const bytes = Buffer.from(delta({ role: 'assistant', content: '中文' }).replace(/\n/g, '\r\n'));
  const offset = bytes.indexOf(Buffer.from('中')) + 1;
  const item = replay([': ping\r\n\r\n', bytes.subarray(0, offset), bytes.subarray(offset), delta({}, 'stop'),
    frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), done]);
  await expect(item.pending).resolves.toMatchObject({ message: { content: '中文' }, usage: { total_tokens: 5 } });
});
test('multi-line SSE data and missing final newline are parsed once at EOF', async () => {
  const item = replay(['data: {"choices":[\ndata: {"delta":{"content":"hello"},"finish_reason":"stop"}]}']);
  await expect(item.pending).resolves.toMatchObject({ message: { content: 'hello' } });
});
test('split BOM and CR-only or split CRLF endings are valid SSE', async () => {
  const bytes = Buffer.from('\uFEFF' + (delta({ content: '中文' }, 'stop') + done).replace(/\n/g, '\r'));
  await expect(replay([bytes.subarray(0, 2), bytes.subarray(2)]).pending).resolves.toMatchObject({ message: { content: '中文' } });
  const packet = delta({ content: 'hello' }, 'stop').replace(/\n/g, '\r\n');
  const cut = packet.indexOf('\r') + 1;
  await expect(replay([packet.slice(0, cut), packet.slice(cut), done]).pending).resolves.toMatchObject({ message: { content: 'hello' } });
});
test('DONE terminates a valid response without waiting for the socket to close', async () => {
  const item = replay([delta({ content: 'done' }, 'stop'), done], {}, false);
  await expect(item.pending).resolves.toMatchObject({ message: { content: 'done' } });
  expect(item.stream.destroyed).toBe(true);
});
test('tool calls split across packets preserve indices and arguments', async () => {
  const item = replay([delta({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'query_', arguments: '{"domain":' } }] }),
    delta({ tool_calls: [{ index: 0, function: { name: 'data', arguments: '"finance"}' } }] }, 'tool_calls'), done]);
  await expect(item.pending).resolves.toMatchObject({ message: { tool_calls: [{ id: 'call-1',
    function: { name: 'query_data', arguments: '{"domain":"finance"}' } }] } });
});
test.each([
  ['malformed JSON', 'data: {invalid}\n\n', 'ERR_PROVIDER_STREAM'],
  ['upstream error', frame({ error: { code: 'busy', message: 'fixture upstream failure' } }), 'ERR_PROVIDER_UPSTREAM'],
  ['unknown envelope', frame({ unexpected: true }), 'ERR_PROVIDER_STREAM'],
  ['non-assistant role', delta({ role: 'user' }), 'ERR_PROVIDER_STREAM'],
])('%s does not become a successful partial answer', async (_, packet, code) => {
  const item = replay([delta({ content: 'partial' }, 'stop'), packet]);
  await expect(item.pending).rejects.toMatchObject({ code, diagnostics: { responseFrames: 2, providerStatus: null } });
  expect(item.stream.destroyed).toBe(true);
});
test('length finish retains truncation metadata and does not continue or retry', async () => {
  await expect(replay([delta({ content: 'partial' }, 'length'), done]).pending).rejects.toMatchObject({
    code: 'ERR_PROVIDER_FINISH', diagnostics: { finishReason: 'length', sawDone: true } });
});
test('missing finish or early close cannot report success', async () => {
  await expect(replay([delta({ content: 'partial' })]).pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_FINISH' });
  const item = replay([], {}, false); item.stream.destroy();
  await expect(item.pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_STREAM_ABORTED' });
});
test('wire, decoded text, frame and packet counts remain independently bounded', async () => {
  await expect(replay([delta({ content: 'hello' }, 'stop')], { maxBytes: 20 }).pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_RESPONSE_LIMIT' });
  await expect(replay([delta({ content: 'hello' }, 'stop')], { maxTextBytes: 4, maxFrameBytes: 1000 }).pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_RESPONSE_LIMIT' });
  await expect(replay([delta({ content: 'hello' }, 'stop')], { maxFrameBytes: 20 }).pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_RESPONSE_LIMIT' });
  await expect(replay([delta({ content: 'hello' }), delta({}, 'stop')], { maxFrames: 1 }).pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_RESPONSE_LIMIT' });
});
test('cancellation destroys the response and cannot emit a late delta', async () => {
  const control = new AbortController(), item = replay([], { signal: control.signal }, false);
  control.abort();
  await expect(item.pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  expect(item.stream.destroyed).toBe(true); expect(item.observed).toEqual([]);
});
test('a gateway JSON completion is accepted on the same stream request, malformed JSON is rejected', async () => {
  const value = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }], usage: { total_tokens: 2 } };
  await expect(replay([JSON.stringify(value)], { contentType: 'application/json' }).pending).resolves.toMatchObject({ message: { content: 'hello' } });
  await expect(replay(['{"choices":'], { contentType: 'application/json' }).pending).rejects.toMatchObject({ code: 'ERR_PROVIDER_STREAM' });
});
test('production client reserves SSE envelope space without changing max_tokens or decoded budget', async () => {
  const stream = new PassThrough(); axios.post.mockResolvedValue({ data: stream, status: 200 });
  const pending = deepseekChatStream({ baseUrl: 'https://maas.qianwenaiapi.com/v1', model: 'qwen3.8-flash', apiKey: 'fixture-key', maxOutputTokens: 'max' }, []);
  await Promise.resolve();
  for (let index = 0; index < 1800; index++) stream.write(delta({ content: '中' }));
  stream.end(delta({}, 'stop') + done);
  await expect(pending).resolves.toMatchObject({ message: { content: '中'.repeat(1800) } });
  const [, body, options] = axios.post.mock.calls[0];
  expect(body.max_tokens).toBe(4096);
  expect(options.maxContentLength).toBe(262144 + 4096 * 512);
  expect(axios.post).toHaveBeenCalledTimes(1);
});
