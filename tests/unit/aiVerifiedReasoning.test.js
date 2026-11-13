jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live DB forbidden'); }), getConnection: jest.fn(() => { throw Error('Live DB forbidden'); }) }));
const { fixture, id, calls } = require('../fixtures/aiV3MemoryFixture');
const { createReasoningRound, verifiedReasoningEvents } = require('../../src/modules/ai/service/verifiedReasoning');
const { createEgressPolicy } = require('../../src/modules/ai/service/egressPolicy');
function send(f, events, message = '你好') {
  return f.service.chat('owner', { requestId: id(), conversationId: f.conversationId, mode: 'analysis', message, consent: true },
    (event, data) => events.push({ event, data }));
}
test('split credentials are scrubbed only after successful result persistence', async () => {
  const events = [], safeText = '我先确认问题。password=fixture-only';
  let f;
  const providerRound = (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: safeText.slice(0, 25) });
    onDelta({ type: 'reasoning', text: safeText.slice(25) });
    expect(events.some(item => item.event === 'reasoning')).toBe(false);
    return { role: 'assistant', content: '你好' };
  };
  f = fixture([providerRound, providerRound]);
  await send(f, events);
  const reasoning = events.filter(item => item.event === 'reasoning');
  expect(reasoning.length).toBeGreaterThan(0);
  expect(reasoning.every(item => item.data.verified === true && !item.data.text.includes('fixture-only'))).toBe(true);
  expect(f.state.conversationStore.append).toHaveBeenCalled();
});
test('false completed reasoning is omitted while a valid final answer survives', async () => {
  const providerRound = (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '我已经帮你完成入账。' }); return { role: 'assistant', content: '你好' };
  };
  const f = fixture([providerRound, providerRound]), events = [];
  await expect(send(f, events)).resolves.toMatchObject({ answer: '你好' });
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
});
test('a rejected final answer never publishes earlier reasoning', async () => {
  const providerRound = (_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '我在分析。' }); return { role: 'assistant', content: '我已经帮你完成入账。' };
  };
  const f = fixture([providerRound, providerRound]), events = [];
  await expect(send(f, events)).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
  expect(f.state.conversationStore.append).not.toHaveBeenCalled();
});
test('provider cancellation never publishes buffered reasoning', async () => {
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '我在分析。' }); throw Object.assign(new Error('cancelled'), { code: 'AI_REQUEST_CANCELLED' });
  }]), events = [];
  await expect(send(f, events)).rejects.toMatchObject({ code: 'AI_REQUEST_CANCELLED' });
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
});
test('overflow is omitted as a whole and cannot leak a truncated credential', () => {
  const round = createReasoningRound(1, value => value, 4);
  round.push('pass'); round.push('word'); expect(round.finish({})).toBeNull();
});
test('whole-round scrub hides known identifiers and non-current references', () => {
  const egress = createEgressPolicy({ userId: 'private-user', knownIds: ['private-card'], extraSecrets: ['synthetic-secret'] });
  const round = createReasoningRound(1, text => egress.scrub(text));
  round.push('private-'); round.push('user synthetic-secret private-card r_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const thought = round.finish({});
  expect(thought.text).not.toMatch(/private-user|private-card|synthetic-secret|r_aaaaaaaa/);
  expect(verifiedReasoningEvents([thought], {})).toHaveLength(1);
});
test('verified reasoning binds to real drafts in a multi-draft result', () => {
  const drafts = [{ id: id(), status: 'pending' }, { id: id(), status: 'pending' }];
  expect(verifiedReasoningEvents([{ round: 1, text: '我已生成草稿。' }], { drafts })).toHaveLength(1);
});

test('prose reasoning preserves literary wording and Markdown after successful persistence', async () => {
  const text = '我记住了那个夏天。\n我已经修改文章。\n[资料](https://example.org) writer@example.org 12345678901234567890\n';
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text }); return { role: 'assistant', content: '# 夏天\n\n正文。' };
  }]), events = [];
  await send(f, events, '写一篇散文');
  expect(events.filter(item => item.event === 'reasoning')).toEqual([{ event: 'reasoning', data: { round: 1, text, verified: true } }]);
});

test('unsupported explicit memory effects in prose reasoning are omitted', async () => {
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text: '已保存到长期记忆。' }); return { role: 'assistant', content: '我记住了那个夏天。' };
  }]), events = [];
  const result = await send(f, events, '写一篇散文'); expect(result.answer).toBe('我记住了那个夏天。');
  expect(events.filter(item => item.event === 'reasoning')).toEqual([]);
});

test.each(['list_choices', 'memory_list'])('later dispatch re-scrubs earlier complete reasoning with the final private scope: %s', tool => {
  // Covered below through the full V3 pipeline; this unit assertion also makes
  // the post-dispatch boundary independent of provider streaming behavior.
  const egress = createEgressPolicy();
  const raw = 'first@example.org 12345678901234567890 https://example.org';
  expect(verifiedReasoningEvents([{ round: 1, text: raw }], {}, { scope: tool === 'list_choices' ? 'business' : 'prose',
    memoryClaims: { receipts: [], explicitOnly: true }, scrub: egress.scrub })[0].text).not.toContain('example.org');
});

test.each(['list_choices', 'memory_list'])('full V3 reasoning and intermediate provider messages use the final tool scope: %s', async tool => {
  const text = 'first@example.org 12345678901234567890 https://example.org';
  const store = { list: jest.fn(async () => ({ files: [], warnings: [] })) };
  const response = calls(tool, tool === 'list_choices' ? { domain: 'finance' } : {});
  const f = fixture([(_config, _messages, _tools, _options, onDelta) => {
    onDelta({ type: 'reasoning', text });
    return { ...response, content: `${text} fixture-only owner`, reasoning_content: `${text} fixture-only owner` };
  }, (_config, messages) => {
    const previous = messages.find(item => item.role === 'assistant' && item.tool_calls);
    expect(previous.content).not.toMatch(/first@example\.org|12345678901234567890|fixture-only|\bowner\b/);
    expect(previous.reasoning_content).not.toMatch(/first@example\.org|12345678901234567890|fixture-only|\bowner\b/);
    expect(previous.tool_calls[0].id).toBe(response.tool_calls[0].id);
    expect(messages.find(item => item.role === 'tool').tool_call_id).toBe(response.tool_calls[0].id);
    return { role: 'assistant', content: '可以继续讨论。' };
  }], { memoryStore: store }), events = [];
  await send(f, events);
  const reasoning = events.filter(item => item.event === 'reasoning'); expect(reasoning).toHaveLength(1);
  expect(reasoning[0].data.text).not.toMatch(/example\.org|12345678901234567890/);
  expect(f.state.conversationStore.append).toHaveBeenCalled();
});
