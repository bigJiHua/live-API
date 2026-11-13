jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Real DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid provider forbidden'); }) }));
const db = require('../../src/common/config/db');
const { fixture, final, calls, id } = require('../fixtures/aiV3MemoryFixture');
const { createHistoryReader } = require('../../src/modules/ai/service/historyReader');

test.each([undefined, 'chat'])('the full history tool path preserves the earliest article and exact time (%s)', async mode => {
  const sourceTime = '2026-11-11T01:00:01.000Z', article = '# 第一篇\n\n春天里的小路。';
  const historyExecutor = { execute: jest.fn(async (sql, params) => {
    expect(sql).toContain('WHERE user_id = ? AND conversation_id = ?');
    expect(sql).toContain('ORDER BY id ASC LIMIT ?');
    expect(sql).toContain("JSON_EXTRACT(meta, '$.failure') IS NULL");
    expect(params).toEqual(['offline-memory-owner', f.conversationId, '%篇%', 'assistant', 1]);
    return [[{ id: 'private_article_row', role: 'assistant', content: article, created_at: sourceTime, meta: null }]];
  }) };
  const reader = createHistoryReader({ executor: historyExecutor });
  const f = fixture([calls('history_search', { query: '篇', order: 'oldest', role: 'assistant', status: 'completed', limit: 1 }),
    (_, messages) => {
      const payload = JSON.parse(messages.findLast(item => item.role === 'tool').content);
      expect(payload.matches).toHaveLength(1);
      expect(payload.matches[0]).toMatchObject({ text: article, sourceTime, status: 'completed' });
      expect(JSON.stringify(payload)).not.toContain('private_article_row');
      return calls('history_read', { ref: payload.matches[0].ref });
    }, (_, messages) => {
      const payload = JSON.parse(messages.findLast(item => item.role === 'tool').content);
      expect(payload).toMatchObject({ text: article, sourceTime, untrusted: true, truncated: false });
      return mode ? { role: 'assistant', content: '第一篇描写春天里的小路。' } : final({ answer: '第一篇描写春天里的小路。' });
    }], { historyReader: reader });
  const result = await f.service.chat('offline-memory-owner', { requestId: id(), message: '概述第一篇文章',
    conversationId: f.conversationId, consent: true, ...(mode ? { mode } : {}) });
  expect(result.answer).toBe('第一篇描写春天里的小路。');
  expect(historyExecutor.execute).toHaveBeenCalledTimes(1);
  expect(f.repository.query).not.toHaveBeenCalled();
  expect(db.execute).not.toHaveBeenCalled();
  expect(db.getConnection).not.toHaveBeenCalled();
});
