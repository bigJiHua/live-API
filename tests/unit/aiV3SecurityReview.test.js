// Independent V3 security review: no provider and no public database access.
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Public database forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('Read pool forbidden'); }) }));
const { createEgressPolicy } = require('../../src/modules/ai/service/egressPolicy');
const { validateAmountEvidence, moneyLiterals, validateDateEvidence } = require('../../src/modules/ai/service/v3Evidence');
const { createBusinessProposalStore } = require('../../src/modules/ai/service/businessProposals');
const { createAiBusinessActions } = require('../../src/common/services/aiBusinessActions');
const { selectSnapshot, validateTool } = require('../../src/modules/ai/service/v3Tools');
const { createCallLogStore } = require('../../src/modules/ai/service/callLog');
const NOW = Date.parse('2026-11-07T04:00:00Z');
const BUDGET = { title: '合成交通预算', budgetType: '行', budgetAmount: '39.91', cycle: '月', planDate: '2026-11-30' };

test('credentials in original utterances and free text are scrubbed before external calls, while money and owned refs survive', () => {
  const policy = createEgressPolicy({ userId: 'synthetic-owner', extraSecrets: ['synthetic-session-key-value'] });
  const safe = policy.project({ cards: [{ id: 'synthetic-private-card', name: '日常账户', authorization: 'Bearer synthetic-token', password: 'synthetic-password' }], amount: '8.50' });
  const ref = safe.cards[0].id;
  const text = policy.scrub(`今天买8.50元零食；sk-synthetic_review_key123；Bearer synthetic-review-token；api_key=synthetic-api-value；password=synthetic-pass-value；synthetic-session-key-value；${ref}`);
  expect(text).not.toMatch(/sk-synthetic_review_key123|synthetic-review-token|synthetic-api-value|synthetic-pass-value|synthetic-session-key-value/);
  expect(text).toContain('8.50元'); expect(text).toContain(ref);
  expect(ref).toMatch(/^r_[0-9a-f]{32}$/);
  expect(safe.amount).toBe('8.50'); expect(safe.cards[0]).not.toHaveProperty('authorization'); expect(safe.cards[0]).not.toHaveProperty('password');
});

test.each([
  ['尾号 1111 的银行卡付款', '1111'], ['卡号：5678 付款', '5678'],
  ['账号 5678付款', '5678'], ['银行卡末四位 4321', '4321'],
  ['银行卡后四位 4321', '4321'], ['2026 年买的衣服', '2026'], ['11 月去买的东西', '11'],
])('account and calendar numerals cannot become an invented amount: %s', (message, amount) => {
  expect(() => validateAmountEvidence({ evidence: { sourceTurn: 0, quote: amount } }, amount, [message])).toThrow();
});

test.each([
  ['今天买了八块五零食', '8.50', '八块五'], ['今天买了８．５元零食', '8.50', '８．５元'],
  ['今天收到1万元工资', '10000', '1万元'], ['今天收到8.5万奖金', '85000', '8.5万'],
])('literal normalization accepts legitimate oral amounts without assigning intent: %s', (message, amount, quote) => {
  expect(() => validateAmountEvidence({ evidence: { sourceTurn: 0, quote } }, amount, [message])).not.toThrow();
});

test.each([
  ['1.5万元', '15000'], ['1.05万元', '10500'], ['1.5 万元', '15000'],
  ['-1.5万元', '-15000'], ['负1.5万', '-15000'], ['十万元', '100000'], ['一万五千元', '15000'],
])('decimal unit literals contain exactly their monetary value and no partial decimal match: %s', (message, expected) => {
  expect([...moneyLiterals(message)]).toEqual([expected]);
  expect(() => validateAmountEvidence({ evidence: { sourceTurn: 0, quote: message } }, expected, [message])).not.toThrow();
});

test.each(['1.5万元', '1.05万元', '-1.5万元'])('an inner decimal digit cannot become a different money amount: %s', message => {
  expect(() => validateAmountEvidence({ evidence: { sourceTurn: 0, quote: message } }, '50000', [message])).toThrow();
});

test.each([
  ['今天去赵一鸣买了8.5的零食', '1', '一'], ['买七喜花了8.5元', '7', '七'],
  ['四喜丸子8.5元', '4', '四'],
])('Chinese numerals inside merchant or product names cannot become the transaction amount: %s', (source, amount, quote) => {
  expect(() => validateAmountEvidence({ evidence: { sourceTurn: 0, quote } }, amount, [source])).toThrow();
});

test('date validation follows the original user date anchor across midnight and rejects invented past dates', () => {
  expect(() => validateDateEvidence('2026-11-07', '今天买了8.5的零食', '2026-11-07', '2026-11-08')).not.toThrow();
  expect(() => validateDateEvidence('2026-11-08', '今天买了8.5的零食', '2026-11-07', '2026-11-08')).toThrow();
  expect(() => validateDateEvidence('2026-11-01', '今天买了8.5的零食', '2026-11-07', '2026-11-07')).toThrow();
  expect(() => validateDateEvidence('2026-11-05', '前天买了8.5的零食', '2026-11-07', '2026-11-07')).not.toThrow();
  expect(() => validateDateEvidence('2026-11-05', '2026-11-05买了8.5的零食', null, '2026-11-07')).not.toThrow();
});

function transactionFixture() {
  const committed = new Map(); let tx;
  const conn = {
    beginTransaction: jest.fn(async () => { tx = new Map(committed); }),
    commit: jest.fn(async () => { committed.clear(); for (const [id, row] of tx) committed.set(id, structuredClone(row)); tx = undefined; }),
    rollback: jest.fn(async () => { tx = undefined; }), release: jest.fn(),
    execute: jest.fn(async (sql, values) => {
      if (!tx) throw new Error('Outside caller transaction');
      if (sql.includes('FROM ai_conversation')) return [values[1] === 'synthetic-owner' ? [{ id: values[0] }] : []];
      if (sql.startsWith('INSERT INTO ai_business_proposal')) {
        const [id, user_id, kind, payload, source, conversation_id, preview_id, expires_at, target_snapshot] = values;
        tx.set(id, { id, user_id, kind, payload, source, conversation_id, preview_id, expires_at, target_snapshot, status: 'pending', version: 1, receipt: null });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM ai_business_proposal')) return [[...tx.values()].filter(row => row.id === values[0] && row.user_id === values[1])];
      throw new Error('Unexpected isolated SQL');
    }),
  };
  const executor = { execute: jest.fn(() => { throw new Error('Pool access instead of caller transaction'); }), getConnection: jest.fn(() => { throw new Error('Nested transaction forbidden'); }) };
  const store = createBusinessProposalStore({ executor, now: () => NOW, actions: createAiBusinessActions({ now: () => NOW }) });
  return { committed, conn, executor, store };
}

test('external transaction proposal creation uses only the supplied connection and never commits early', async () => {
  const f = transactionFixture(); await f.conn.beginTransaction();
  const check = jest.fn(async connection => { expect(connection).toBe(f.conn); });
  const proposal = await f.store.create('synthetic-owner', { kind: 'budget.create', fields: BUDGET, conversationId: 'synthetic-conversation', check }, f.conn);
  expect(proposal).toMatchObject({ status: 'pending', fields: { budgetAmount: '39.91' } });
  expect(f.committed.size).toBe(0); expect(f.conn.commit).not.toHaveBeenCalled(); expect(f.conn.beginTransaction).toHaveBeenCalledTimes(1);
  expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.executor.getConnection).not.toHaveBeenCalled();
  await f.conn.commit(); expect(f.committed.size).toBe(1); expect(check).toHaveBeenCalledTimes(3);
});

test('caller history or recovery failure rolls back the same transaction and leaves no orphan proposal', async () => {
  const f = transactionFixture(); await f.conn.beginTransaction();
  await f.store.create('synthetic-owner', { kind: 'budget.create', fields: BUDGET, conversationId: 'synthetic-conversation' }, f.conn);
  try { throw new Error('Synthetic history/recovery write failure'); } catch (_) { await f.conn.rollback(); }
  expect(f.committed.size).toBe(0); expect(f.conn.commit).not.toHaveBeenCalled(); expect(f.conn.rollback).toHaveBeenCalledTimes(1);
});

test('authorization revoked after proposal insertion still rolls back with no orphan card', async () => {
  const f = transactionFixture(); await f.conn.beginTransaction(); let checks = 0;
  await expect(f.store.create('synthetic-owner', { kind: 'budget.create', fields: BUDGET, conversationId: 'synthetic-conversation',
    check: async connection => { expect(connection).toBe(f.conn); if (++checks === 3) throw new Error('Synthetic revoked authorization'); },
  }, f.conn)).rejects.toThrow('revoked authorization');
  await f.conn.rollback(); expect(f.committed.size).toBe(0); expect(f.conn.commit).not.toHaveBeenCalled();
});

test('an external proposal transaction cannot target a conversation owned by another user', async () => {
  const f = transactionFixture(); await f.conn.beginTransaction();
  await expect(f.store.create('other-owner', { kind: 'budget.create', fields: BUDGET, conversationId: 'synthetic-conversation' }, f.conn))
    .rejects.toMatchObject({ code: 'AI_CONVERSATION_EXPIRED' });
  expect(f.conn.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO ai_business_proposal'))).toBe(false);
  await f.conn.rollback(); expect(f.committed.size).toBe(0);
});

test('truncated choices report ambiguity without disclosing the omitted business rows', () => {
  const args = validateTool('list_choices', { domain: 'finance', group: 'cards', filter: '微信', limit: 1 }, '2026-11-07');
  const raw = { asOf: new Date(NOW).toISOString(), choices: { cards: [{ id: 'synthetic-a', name: '微信账户一' }, { id: 'synthetic-b', name: '微信账户二' }, { id: 'synthetic-c', name: '现金账户' }] }, datasets: [] };
  const selected = selectSnapshot('list_choices', args, raw);
  expect(selected.choices.cards).toHaveLength(1);
  expect(selected.choiceCoverage.cards).toMatchObject({ total: 2, returned: 1, truncated: true });
  expect(JSON.stringify(selected)).not.toContain('synthetic-b');
});

async function recordedAudit(request, response) {
  const execute = jest.fn(async () => [{ affectedRows: 1 }]);
  createCallLogStore({ executor: { execute }, now: () => NOW }).record({ userId: 'synthetic-owner', lane: 'v3-chat', phase: 'tool', request, response });
  await new Promise(resolve => setImmediate(resolve));
  expect(execute).toHaveBeenCalledTimes(1);
  const [, params] = execute.mock.calls[0];
  return { request: JSON.parse(params[9]), response: JSON.parse(params[10]) };
}

test('audit retains public dataset column keys for data digest reconciliation while erasing credentials', async () => {
  const columns = [{ key: 'name', label: '账户名称', type: 'text' }, { key: 'balance', label: '保存余额', type: 'money' }, { key: 'cardRef', label: '本轮引用', type: 'ref' }];
  const value = await recordedAudit({ apiKey: 'synthetic-private-api-key', authorization: 'Bearer synthetic-private-token' }, { result: { datasets: [{ columns }], password: 'synthetic-private-password' } });
  expect(value.response.result.datasets[0].columns).toEqual(columns);
  expect(JSON.stringify(value)).not.toMatch(/synthetic-private-api-key|synthetic-private-token|synthetic-private-password/);
});

test('complete provider role:tool envelope retains exactly the disclosed scope, column metadata and rows inside encoded JSON', async () => {
  const toolResult = {
    scope: { domains: ['account'], startDate: '2026-11-01', endDate: '2026-11-07' },
    datasets: [{ datasetId: 'account-balances', domain: 'account', title: '账户余额快照',
      columns: [{ key: 'name', label: '账户名称', type: 'text' }, { key: 'balance', label: '保存余额', type: 'money' }, { key: 'currency', label: '币种', type: 'text' }],
      rows: [{ name: '合成微信账户', balance: '19991.50', currency: 'CNY', cardRef: 'r_0123456789abcdef0123456789abcdef' }],
      summary: { count: 1, incomplete: false }, policy: '已保存快照', asOf: '2026-11-07T04:00:00.000Z', isEstimated: false, truncated: false }],
    choices: { cards: [], categories: [], funds: [], todos: [], fixedAssets: [], moods: [] }, asOf: '2026-11-07T04:00:00.000Z',
  };
  const request = { promptVersion: 'synthetic-v3-audit', round: 2,
    messages: [{ role: 'system', content: '合成工具回灌测试' }, { role: 'user', content: '查看合成账户余额' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_synthetic', type: 'function', function: { name: 'query_data', arguments: '{"datasetId":"account-balances"}' } }] },
      { role: 'tool', tool_call_id: 'call_synthetic', content: JSON.stringify(toolResult) }],
  };
  const value = await recordedAudit(request, null);
  const message = value.request.messages.find(item => item.role === 'tool');
  expect(message.tool_call_id).toBe('call_synthetic'); expect(typeof message.content).toBe('string');
  expect(JSON.parse(message.content)).toEqual(toolResult);
  expect(message.content).not.toContain('[truncated]'); expect(message.content).not.toContain('[已擦除]');
});

test('an invalid or incomplete column DTO cannot exempt a secret key from audit erasure', async () => {
  const malformed = [
    { key: 'syntheticMissingLabelSecret', type: 'text' },
    { key: 'syntheticBadLabelSecret', label: { text: 'not a label string' }, type: 'text' },
    { key: 'syntheticWrongTypeSecret', label: '伪列', type: 'credential' },
    { key: 'syntheticExtraFieldSecret', label: '伪列', type: 'text', apiKey: 'synthetic-extra-secret' },
  ];
  const value = await recordedAudit(null, { columns: malformed });
  expect(value.response.columns.map(column => column.key)).toEqual(malformed.map(() => '[已擦除]'));
  expect(JSON.stringify(value)).not.toMatch(/syntheticMissingLabelSecret|syntheticBadLabelSecret|syntheticWrongTypeSecret|syntheticExtraFieldSecret|synthetic-extra-secret/);
});

test('generic secret key fields are erased from objects, raw JSON strings and nested model-content JSON strings', async () => {
  const value = await recordedAudit({ key: 'synthetic-request-key', nested: { key: 'synthetic-nested-key' } }, { message: { content: '{"key":"synthetic-content-key"}' } });
  const text = await recordedAudit('{"key":"synthetic-raw-string-key"}', null);
  expect(JSON.stringify({ value, text })).not.toMatch(/synthetic-request-key|synthetic-nested-key|synthetic-content-key|synthetic-raw-string-key/);
  expect(value.request.key).toBe('[已擦除]'); expect(value.request.nested.key).toBe('[已擦除]');
});
