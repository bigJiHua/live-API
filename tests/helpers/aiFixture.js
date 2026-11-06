const crypto = require('crypto');
const { createAiService } = require('../../src/modules/ai/service');
const { AiError } = require('../../src/modules/ai/service/errors');

function testEnv(extra = {}) {
  return { NODE_ENV: 'test', AI_MODE: 'deepseek', AI_SYNTHETIC_DATA: 'false',
    DEEPSEEK_API_KEY: 'fixture-key', AI_DB_HOST: 'fixture.invalid', AI_DB_NAME: 'fixture',
    AI_DB_USER: 'fixture_reader', AI_DB_PASSWORD: 'fixture-password', ...extra };
}
function createTestRepository() {
  return {
    async summary(_, range) {
      return { ...range, currency: 'CNY', income: '95.00', expense: '51.20', count: 2,
        categories: [{ direction: 0, category: '餐饮', amount: '51.20', count: 1 }], policy: '测试查询口径' };
    },
    async transactions(_, range) { return { ...range, rows: [], total: 0, hasMore: false }; },
    async choices() {
      return { accounts: [{ id: 'fixture_balance', name: '余额账户', type: 'virtual_balance' },
        { id: 'fixture_cash', name: '现金账户', type: 'virtual_cash' }],
      categories: [{ id: 'fixture_food', name: '餐饮', type: 'expense' },
        { id: 'fixture_salary', name: '工资', type: 'income' }] };
    },
  };
}
function createMemoryDraftStore() {
  const records = new Map();
  const key = (userId, id) => `${userId}|${id}`;
  const conflict = () => new AiError('草稿版本已变化，请重新核对', 409, 'AI_DRAFT_CONFLICT');
  return {
    async save(userId, input) {
      const draft = { ...structuredClone(input), id: crypto.randomUUID(), version: 1, status: 'pending',
        expiresAt: Date.now() + 15 * 60 * 1000 };
      records.set(key(userId, draft.id), draft);
      return structuredClone(draft);
    },
    async get(userId, id) {
      const draft = records.get(key(userId, id));
      if (!draft) throw new AiError('草稿不存在或已过期', 404);
      return structuredClone(draft);
    },
    async update(userId, id, version, fields) {
      const draft = await this.get(userId, id);
      if (draft.status === 'discarded') throw new AiError('草稿已取消', 409, 'AI_DRAFT_DISCARDED');
      if (draft.status === 'committed' || draft.version !== version) throw conflict();
      const next = { ...draft, ...structuredClone(fields), version: version + 1, status: 'pending' };
      records.set(key(userId, id), next);
      return structuredClone(next);
    },
    async act(userId, id, version, action) {
      const draft = await this.get(userId, id);
      if (['discarded', 'committed'].includes(draft.status) || draft.version !== version) throw conflict();
      if (action === 'review' && draft.missingFields.length) throw new AiError('请先补齐草稿');
      draft.status = action === 'review' ? 'reviewed' : 'discarded'; draft.version++;
      records.set(key(userId, id), draft);
      return structuredClone(draft);
    },
  };
}
function createMemoryConversationStore() {
  const records = new Map();
  return {
    async open(userId, id) {
      if (id) {
        const record = records.get(id);
        if (!record || record.userId !== userId) throw new AiError('对话不存在或已过期', 404, 'AI_CONVERSATION_EXPIRED');
        return structuredClone(record);
      }
      const record = { id: crypto.randomUUID(), userId, history: [], latestDraftId: null };
      records.set(record.id, record);
      return structuredClone(record);
    },
    async append(userId, id, { message, answer, draft }) {
      await this.open(userId, id);
      const record = records.get(id);
      record.history.push({ role: 'user', content: message }, { role: 'assistant', content: answer });
      record.history = record.history.slice(-10);
      if (draft) record.latestDraftId = draft.id;
    },
    async list(userId) {
      return [...records.values()].filter(record => record.userId === userId).map(record => ({
        id: record.id, title: record.history[0]?.content || '新对话', messageCount: record.history.length,
      }));
    },
    async messages(userId, id) { return (await this.open(userId, id)).history; },
    async remove(userId, id) { await this.open(userId, id); records.delete(id); },
    async clearUser(userId) {
      for (const [id, record] of records) if (record.userId === userId) records.delete(id);
    },
  };
}
const call = (name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ type: 'function', id: crypto.randomUUID(), function: { name, arguments: JSON.stringify(args) } }] });
function createFixtureChat(today = '2026-11-05') {
  return async messages => {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') {
      const result = JSON.parse(last.content);
      return { role: 'assistant', content: result.amount ? '请核对聊天中的草稿。' : `支出${result.expense || '0.00'}元。` };
    }
    if (last.content.includes('草稿多少钱')) {
      const snapshot = messages.find(message => message.content?.startsWith('[应用提供的最近草稿状态'));
      const draft = snapshot ? JSON.parse(snapshot.content.slice(snapshot.content.indexOf('{'))) : null;
      return { role: 'assistant', content: draft ? `这份草稿是${draft.amount}元。` : '请先生成草稿。' };
    }
    if (last.content.includes('明细')) return call('query_transactions', { startDate: today.slice(0, 8) + '01', endDate: today });
    if (last.content.includes('收支')) return call('query_finance_summary', { startDate: today.slice(0, 8) + '01', endDate: today });
    if (last.content.includes('午饭') || last.content.includes('记账35元')) {
      const incomplete = last.content.includes('记账35元');
      const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
      return call('propose_transaction', { direction: 0, amount: incomplete ? '35' : '32', currency: 'CNY',
        transDate: yesterday, categoryId: incomplete ? null : 'fixture_food',
        accountId: incomplete ? null : 'fixture_balance', payMethod: incomplete ? null : '支付宝', remark: '午饭' });
    }
    return { role: 'assistant', content: '你好，可以查询账本和整理草稿。' };
  };
}
function createTestService(options = {}) {
  return createAiService({ env: testEnv(), repository: createTestRepository(), chat: createFixtureChat(),
    draftStore: createMemoryDraftStore(), conversationStore: createMemoryConversationStore(),
    checkConnection: async () => { throw new Error('Test must inject connection check'); },
    now: () => new Date('2026-11-05T08:00:00Z'), ...options });
}
module.exports = { testEnv, createTestRepository, createMemoryDraftStore, createMemoryConversationStore,
  createFixtureChat, createTestService, call };
