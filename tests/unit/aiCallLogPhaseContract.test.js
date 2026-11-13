jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Paid model forbidden'); }) }));
const fs = require('fs');
const path = require('path');
const { createCallLogStore } = require('../../src/modules/ai/service/callLog');
const { fixture, calls, now } = require('../fixtures/aiV3MemoryFixture');
test('a grounded reply persists its audit through the actual call-log writer within the SQL phase width', async () => {
  const ddl = fs.readFileSync(path.join(__dirname, '../../mysql/migrations/019_consolidated_20261111.sql'), 'utf8');
  const width = Number(/`phase`\s+VARCHAR\((\d+)\)/i.exec(ddl)[1]);
  const stored = [];
  const executor = { execute: jest.fn(async (sql, values) => {
    expect(sql).toContain('INSERT INTO ai_call_log');
    if (values[4].length > width) throw Object.assign(new Error('phase too long'), { code: 'ER_DATA_TOO_LONG' });
    stored.push({ phase: values[4], response: JSON.parse(values[10]) });
    return [{ affectedRows: 1 }];
  }) };
  const logger = createCallLogStore({ executor });
  const f = fixture([calls('query_data', { datasetId: 'finance-monthly' })], { memoryStore: {
    list: async () => ({ files: [], warnings: [] }) } });
  f.raw.datasets = [{ datasetId: 'finance-monthly', domain: 'finance', title: '收支月度趋势',
    columns: [{ key: 'month', label: '月份', type: 'text' }, { key: 'income', label: '收入', type: 'money' },
      { key: 'expense', label: '支出', type: 'money' }, { key: 'count', label: '笔数', type: 'number' }],
    rows: [{ month: '2026-06', income: '100.00', expense: '60.00', count: 2 }],
    summary: { income: '100.00', expense: '60.00', count: 2, currency: 'CNY' }, policy: '已保存收支', truncated: false, asOf: now().toISOString() }];
  const push = f.audits.push.bind(f.audits);
  f.audits.push = entry => { logger.record(entry); return push(entry); };
  const result = await f.send('看6月收支，给柱状图。');
  await new Promise(resolve => setImmediate(resolve));
  expect(result.request.providerCalls).toBe(1);
  expect(stored.find(entry => entry.phase === 'grounded-done')).toMatchObject({ response: { chart: { datasetId: 'finance-monthly' } } });
  expect(stored).toHaveLength(f.audits.length); expect(stored.every(entry => entry.phase.length <= width)).toBe(true);
});
