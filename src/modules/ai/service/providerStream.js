const { StringDecoder } = require('string_decoder');

// Parse one bounded response. A gateway may return a complete JSON completion
// to stream:true; accepting that same response never issues a second request.
function collectProviderStream(stream, { maxBytes, maxTextBytes = maxBytes, maxFrames = 100000,
  maxFrameBytes = Math.min(maxTextBytes, 256 * 1024),
  signal, contentType = '', onDelta, onFirstByte = () => {}, providerStatus = null } = {}) {
  const message = { role: 'assistant', content: '' }, tools = new Map();
  let bytes = 0, textBytes = 0, frames = 0, finish = null, usage = null, buffer = '', eventData = [], eventName = '', done = false;
  let firstText = true, atEof = false;
  let mode = /application\/(?:[\w.+-]*\+)?json/i.test(contentType) ? 'json' : null;
  const decoder = new StringDecoder('utf8');
  const metadata = () => ({ providerStatus, transport: mode || 'unknown', responseBytes: bytes, decodedTextBytes: textBytes,
    responseFrames: frames, finishReason: finish, sawDone: done, streamStage: frames ? 'receiving' : 'waiting' });
  const failure = (code, messageText, details = {}) => Object.assign(new Error(messageText), {
    code, diagnostics: { ...metadata(), ...details } });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener('data', onData); stream.removeListener('end', onEnd);
      stream.removeListener('error', onError); stream.removeListener('aborted', onAborted);
      stream.removeListener('close', onClose); signal?.removeEventListener('abort', onAbort);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true; cleanup();
      // An axios/source error already queued when [DONE] arrives must not become
      // an unhandled EventEmitter error after removing this response's listeners.
      stream.once('error', () => {});
      if (!stream.destroyed) stream.destroy();
      if (error) {
        error.diagnostics = { ...metadata(), ...error.diagnostics };
        reject(error);
      } else {
        if (tools.size) message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
        resolve({ message, usage });
      }
    };
    const validateFinish = () => {
      if (!['stop', 'tool_calls'].includes(finish)) throw failure('ERR_PROVIDER_FINISH', 'AI response did not finish normally');
      if (finish === 'tool_calls' && !tools.size) throw failure('ERR_PROVIDER_STREAM', 'AI tool completion has no tool calls');
    };
    const parsePacket = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('ERR_PROVIDER_STREAM', 'Invalid AI stream packet');
      if (value.error) {
        const error = value.error;
        throw failure('ERR_PROVIDER_UPSTREAM', 'AI provider returned an error packet', {
          providerCode: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null,
          providerMessage: typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : null });
      }
      if (value.usage != null) {
        if (!value.usage || typeof value.usage !== 'object' || Array.isArray(value.usage)) throw failure('ERR_PROVIDER_STREAM', 'Invalid AI usage packet');
        usage = value.usage;
      }
      if (!Array.isArray(value.choices)) throw failure('ERR_PROVIDER_STREAM', 'AI stream packet has no choices');
      if (!value.choices.length) {
        if (!value.usage) throw failure('ERR_PROVIDER_STREAM', 'Empty AI stream packet');
        return;
      }
      const choice = value.choices.find(item => item.index === 0) || value.choices[0];
      if (!choice || typeof choice !== 'object' || choice.index != null && choice.index !== 0)
        throw failure('ERR_PROVIDER_STREAM', 'Invalid AI stream choice');
      if (choice.finish_reason != null) finish = choice.finish_reason;
      const delta = choice.delta;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta) || delta.role != null && delta.role !== 'assistant')
        throw failure('ERR_PROVIDER_STREAM', 'Invalid AI stream delta');
      for (const field of ['content', 'reasoning', 'reasoning_content']) {
        if (delta[field] == null) continue;
        if (typeof delta[field] !== 'string') throw failure('ERR_PROVIDER_STREAM', 'Invalid AI text delta');
        textBytes += Buffer.byteLength(delta[field]);
        if (textBytes > maxTextBytes) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI decoded output exceeds its byte limit');
        message[field] = (message[field] || '') + delta[field];
        if (delta[field]) onDelta?.({ type: field === 'content' ? 'content' : 'reasoning', text: delta[field] });
      }
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw failure('ERR_PROVIDER_STREAM', 'Invalid AI tool delta');
      for (const call of delta.tool_calls || []) {
        if (!call || !Number.isInteger(call.index) || call.index < 0 || call.index > 31)
          throw failure('ERR_PROVIDER_STREAM', 'Invalid AI tool index');
        const slot = tools.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.type != null && call.type !== 'function' || call.id != null && typeof call.id !== 'string'
          || call.function != null && (typeof call.function !== 'object' || Array.isArray(call.function)))
          throw failure('ERR_PROVIDER_STREAM', 'Invalid AI tool call');
        if (call.id) slot.id = call.id;
        for (const field of ['name', 'arguments']) if (call.function?.[field] != null) {
          if (typeof call.function[field] !== 'string') throw failure('ERR_PROVIDER_STREAM', 'Invalid AI tool function');
          textBytes += Buffer.byteLength(call.function[field]);
          if (textBytes > maxTextBytes) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI decoded output exceeds its byte limit');
          slot.function[field] += call.function[field];
        }
        tools.set(call.index, slot);
      }
    };
    const dispatch = () => {
      if (!eventData.length) { eventName = ''; return; }
      const text = eventData.join('\n'); eventData = [];
      if (Buffer.byteLength(text) > maxFrameBytes) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI stream frame exceeds its byte limit');
      frames++;
      if (frames > maxFrames) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI response exceeds its frame limit');
      if (text.trim() === '[DONE]') { done = true; validateFinish(); settle(); return; }
      let value;
      try { value = JSON.parse(text); } catch (_) { throw failure('ERR_PROVIDER_STREAM', 'Invalid JSON in AI stream'); }
      if (eventName === 'error' && !value.error) value = { error: value };
      eventName = ''; parsePacket(value);
    };
    const consume = () => {
      if (mode === 'json') return;
      let newline;
      while (!settled && (newline = /[\r\n]/.exec(buffer))) {
        const index = newline.index;
        // Keep a trailing CR until the next chunk so split CRLF is one newline.
        if (buffer[index] === '\r' && index === buffer.length - 1 && !atEof) break;
        const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + width);
        if (!line) { dispatch(); continue; }
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (!/^(?:id|retry):/.test(line)) throw failure('ERR_PROVIDER_STREAM', 'Unexpected AI stream field');
        if (Buffer.byteLength(buffer) + Buffer.byteLength(eventData.join('\n')) > maxBytes)
          throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI stream buffer exceeds its byte limit');
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI stream line exceeds its byte limit');
    };
    const onData = chunk => {
      if (settled) return;
      try {
        onFirstByte(); bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (bytes > maxBytes) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI response exceeds its byte limit');
        buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
        if (firstText && buffer.length) { buffer = buffer.replace(/^\uFEFF/, ''); firstText = false; }
        if (!mode && buffer.trim()) mode = /^[\s\uFEFF]*[\[{]/.test(buffer) ? 'json' : 'sse';
        consume();
      } catch (error) { settle(error); }
    };
    const onEnd = () => {
      if (settled) return;
      try {
        atEof = true;
        buffer += decoder.end();
        if (mode === 'json') {
          let value; try { value = JSON.parse(buffer.replace(/^\uFEFF/, '')); }
          catch (_) { throw failure('ERR_PROVIDER_STREAM', 'Invalid JSON completion from AI gateway'); }
          if (value.error) parsePacket(value);
          const choice = value.choices?.[0];
          if (!choice || choice.message?.role !== 'assistant') throw failure('ERR_PROVIDER_STREAM', 'Invalid AI completion envelope');
          finish = choice.finish_reason; usage = value.usage || null;
          Object.assign(message, choice.message);
          textBytes = Buffer.byteLength(JSON.stringify(choice.message));
          if (textBytes > maxTextBytes) throw failure('ERR_PROVIDER_RESPONSE_LIMIT', 'AI decoded output exceeds its byte limit');
          if (message.tool_calls?.length) message.tool_calls.forEach((call, index) => tools.set(index, call));
        } else {
          // Some gateways omit the final newline; process that event once at EOF.
          if (buffer) { buffer += '\n'; consume(); }
          if (!settled) dispatch();
        }
        if (!settled) { validateFinish(); settle(); }
      } catch (error) { settle(error); }
    };
    const onError = error => settle(error);
    const onAborted = () => settle(failure('ERR_PROVIDER_STREAM_ABORTED', 'AI response stream was aborted'));
    const onClose = () => { if (!settled) settle(failure('ERR_PROVIDER_STREAM_ABORTED', 'AI response stream closed before completion')); };
    const onAbort = () => settle(Object.assign(new Error('AI provider request cancelled'), { code: 'ERR_CANCELED' }));
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError);
    stream.on('aborted', onAborted); stream.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

module.exports = { collectProviderStream };
