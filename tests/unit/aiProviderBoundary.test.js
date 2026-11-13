jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');
const { deepseekChat } = require('../../src/modules/ai/service/deepseek');
const config = { model: 'deepseek-flash', apiKey: 'synthetic-secret' };

describe('DeepSeek response boundary', () => {
  test('provider failure never returns raw credentials or private request details', async () => {
    axios.post.mockRejectedValue(new Error('synthetic-secret private-user-input'));
    await expect(deepseekChat(config, [], [])).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    try { await deepseekChat(config, [], []); } catch (error) {
      expect(error.message).not.toMatch(/synthetic-secret|private-user-input/);
    }
  });
  test.each(['length', 'content_filter', 'insufficient_system_resource', 'aborted'])('incomplete %s response is not accepted', async finish_reason => {
    axios.post.mockResolvedValue({ data: { choices: [{ finish_reason,
      message: { role: 'assistant', content: 'partial output' } }] } });
    await expect(deepseekChat(config, [], [])).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
  });

  test('large output requests have enough transport capacity and keep truncation metadata', async () => {
    axios.post.mockClear();
    axios.post.mockResolvedValue({ status: 200, data: { choices: [{ finish_reason: 'length',
      message: { role: 'assistant', content: 'private output', reasoning_content: 'private reasoning' } }],
      usage: { prompt_tokens: 100, completion_tokens: 131072, total_tokens: 131172 } } });
    let failure;
    try { await deepseekChat({ ...config, baseUrl: 'https://api.deepseek.com' }, [], [], { maxTokens: 131072 }); } catch (error) { failure = error; }
    expect(axios.post.mock.calls[0][1].max_tokens).toBe(131072);
    expect(axios.post.mock.calls[0][2].maxContentLength).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(failure).toMatchObject({ code: 'AI_PROVIDER_FAILED', diagnostics: {
      providerStatus: 200, finishReason: 'length', maxTokens: 131072,
      usage: { completion_tokens: 131072, total_tokens: 131172 } } });
    expect(JSON.stringify(failure)).not.toMatch(/private output|private reasoning|synthetic-secret/);
  });
});
