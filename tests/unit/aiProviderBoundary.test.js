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
});
