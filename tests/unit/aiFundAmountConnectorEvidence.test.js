jest.mock('../../src/common/config/db', () => ({execute: jest.fn(() => {throw Error('Public DB forbidden');}), getConnection: jest.fn(() => {throw Error('Public DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({deepseekChat: jest.fn(() => {throw Error('Paid provider forbidden');})}));
jest.mock('mysql2/promise', () => ({createPool: jest.fn(() => {throw Error('Public DB forbidden');})}));
const {fixture} = require('../fixtures/aiV3MemoryFixture');
const helper = require('../../src/modules/ai/service/queryFundProse');
const {buildQueryAnswer} = require('../../src/modules/ai/service/v3Service');
const capture = require('../fixtures/aiFundAmountConnectorCaptured.json'), clone = value => structuredClone(value), outcomes = [];
const partial = () => clone(capture.current.result.datasets[0]), full = () => clone(capture.previous.result.datasets[0]);
const phrase = '区间内本金增量仍为 0.00';
const rowPhrase = connector => `示例基金2号2026-11-04本金增量${connector}0.00`;
let logger, errorLogger;
beforeEach(() => {logger = jest.spyOn(console, 'log').mockImplementation(() => {}); errorLogger = jest.spyOn(console, 'error').mockImplementation(() => {});});
afterEach(() => {logger.mockRestore(); errorLogger.mockRestore();});

test('captured F22/N22 fixture preserves actual provider decision and current partial scope with anonymous identifiers', () => {
  expect(capture.current.providers).toHaveLength(3); expect(capture.previous.providers).toHaveLength(2);
  expect(capture.current.providers.at(-1).content).toContain(phrase);
  expect(capture.current.result.answer).toContain(phrase);
  expect(partial().queryMeta).toMatchObject({effectiveScope: {startDate: '2026-11-01', endDate: '2026-11-09'},
    matchedRowCount: 4, returnedRowCount: 1, sourceRecordCount: null, rowsComplete: false, summaryComplete: false});
  expect(full().queryMeta).toMatchObject({matchedRowCount: 4, returnedRowCount: 4, rowsComplete: true, summaryComplete: false});
  expect(full().rows.every(row => row.capitalDelta === '0.00')).toBe(true);
  expect(capture.current.providers.at(-1).taskInput.priorAnswers[0]).toContain('整段区间本金增量均为0.00');
  expect(capture.evidenceLimit).toContain('full raw outer provider request.messages');
});

test.each(['仍为', '仍是', '依然为', '依旧是', '始终为', '均为', '保持为', '保持在', '维持为', '维持在',
  ' is ', ' was ', ' still is ', ' remains ', ' remains at ', ' remain ', ' continues to be '])('recognized connector still needs the current fund/date proof: %s', connector => {
  for (const dataset of [partial(), full()]) {
    expect(helper.validFundAmountClaims(`区间内本金增量${connector}0.00`, [dataset])).toBe(false);
    expect(helper.validFundAmountClaims(rowPhrase(connector), [dataset])).toBe(true);
  }
});

test.each(['一共达到', '合计达到', '持续等于', '累计至', '整个区间一直都是', '持续维持在', '仍然保持在',
  ' now amounts to ', ' has reached ', ' was exactly ', ' stands at ', '，仍为', ', remains ', '的登记情况'.repeat(18) + '一共达到'])('unsupported connector cannot bypass monetary evidence: %s', connector => {
  for (const dataset of [partial(), full()]) {
    expect(helper.validFundAmountClaims(`区间累计本金增量${connector}0.00`, [dataset])).toBe(false);
    expect(helper.validFundAmountClaims(`示例基金2号2026-11-04本金增量${connector}0.00`, [dataset])).toBe(false);
  }
});

test.each([
  ['示例基金2号2026-11-04本金增量仍为 0.00', true],
  ['示例基金2号2026-11-04收益增量仍为 -3.2500', true],
  ['2026-11-04本金增量 remains 0.00', true],
  ['示例基金2号2026-11-04 capital delta remains 0.00', true],
  ['示例基金2号2026-11-04 profit remains -3.2500', true],
  ['示例基金2号2026-11-04本金增量仍为 12.50', false],
  ['示例基金2号2026-11-03收益增量仍为 -3.25', false],
  ['示例基金2号2026-11-09本金增量仍为 0.00', false],
  ['另一只基金2026-11-04本金增量仍为 0.00', false],
  ['示例基金2号本金增量仍为0.00', false],
  ['区间收益增量一共达到18.50', false],
  ['区间登记本金始终为0.00', false],
  ['示例基金2号2026-11-04本金仍为0.00', false],
])('exact field/date/name sign evidence remains mandatory: %s', (sentence, expected) => {
  expect(helper.validFundAmountClaims(sentence, [partial()])).toBe(expected);
});

test.each([
  '本次匹配4条记录，展示1条，收益与本金增量均为保存的登记值。',
  '本金增量记录共4条。', '收益记录显示1行。', 'profit data has 4 rows.', 'registered principal data has 4 records.',
  'capital delta data contains 1 entries.', '基金收益登记日期为2026-11-04。', '本金增量按2026年11月4日登记。',
  '本金增量登记日期为11月4日。', '收益按11-04登记。',
  '本金增量的登记范围是2026-11-01至2026-11-09。',
  '收益增量和本金增量仅代表已保存登记值，不补齐未登记日期。',
  '收益与本金不重建历史配置，缺失值保持未知。',
  'The profitability model v2 uses saved data.',
  '本金版本v2使用保存数据。',
  '收益记录共4条，本次展示1条。', '本金增量按日期登记，登记日期为2026-11-04。',
  '本金增量为保存的历史记录，收益增量为保存的历史记录。',
])('metadata, dates and non-monetary policy are not fabricated amount claims: %s', sentence => {
  expect(helper.validFundAmountClaims(sentence, [partial()])).toBe(true);
});

test('the helper is pure, repeatable and non-fund datasets remain outside its scope', () => {
  const dataset = partial(), before = JSON.stringify(dataset);
  expect(helper.validFundAmountClaims(phrase, [dataset])).toBe(false);
  expect(helper.validFundAmountClaims(phrase, [dataset])).toBe(false);
  expect(JSON.stringify(dataset)).toBe(before);
  expect(helper.validFundAmountClaims('收入一共达到3911.24', [{datasetId: 'finance-monthly', rows: []}])).toBe(true);
  expect(helper.validFundAmountClaims('收入一共达到3911.24', [dataset, {datasetId: 'finance-monthly', rows: []}])).toBe(true);
});

test.each([
  '基金收益增长为3.2500%', '基金本金增量一直维持在0.00％',
  '示例基金2号2026-11-04本金增量为0.00%', '示例基金2号2026-11-04收益增量为-3.2500％',
  '示例基金2号2026-11-04 profit remains -3.2500 percent', '示例基金2号2026-11-04 capital delta remains 0 percent',
  '示例基金2号2026-11-03收益增量为12.5000%', '基金收益率一共达到12.50%',
  '本次记录显示示例基金2号2026-11-04收益增量仍为-3.2500‰',
  '本次记录显示示例基金2号2026-11-04收益增量仍为-3.2500个百分点',
  'This record shows 示例基金2号2026-11-04 profit remains -3.2500 per cent',
  'This record shows 示例基金2号2026-11-04 profit remains -3.2500 percentage points',
  'This record shows 示例基金2号2026-11-04 profit remains -3.2500 bps',
  '本次记录显示示例基金2号2026-11-04本金增量仍为0.00‱',
])('profit/principal amount evidence cannot prove percentages: %s', sentence => {
  for (const dataset of [partial(), full()]) expect(helper.validFundAmountClaims(sentence, [dataset])).toBe(false);
});

test.each([['partial', partial], ['full', full]])('canonical %s facts survive rejected range money and safe policy', (_, make) => {
  const dataset = make(), answer = buildQueryAnswer(phrase + '；未登记日期不补齐，以上为保存的登记值。', [dataset]);
  expect(answer).not.toContain(phrase); expect(answer).toContain('未登记日期不补齐，以上为保存的登记值');
  for (const row of dataset.rows) expect(answer).toContain(`${row.name} · ${row.date}：收益增量 ${row.profit}，本金增量 ${row.capitalDelta}`);
  expect(answer).not.toContain('区间合计0');
  if (dataset.queryMeta.rowsComplete === false) expect(answer).toContain('部分登记记录，不能相加作为完整合计');
});

function originalReplay() {
  const scripted = capture.current.providers.map(log => () => ({role: 'assistant', content: log.content, reasoning_content: log.reasoning,
    ...(log.toolCalls.length ? {tool_calls: clone(log.toolCalls)} : {})}));
  const f = fixture(scripted, {memoryStore: {list: jest.fn(async () => ({files: [], warnings: []}))}, clock: () => new Date('2026-11-09T15:16:12.340Z')});
  f.state.businessPolicy.domains.push('fund');
  const previousHistory = capture.history.filter(turn => turn.meta?.requestId === capture.previous.requestId);
  for (const turn of previousHistory) f.history.push({role: turn.role, content: turn.content, ...clone(turn.meta), sourceDate: '2026-11-09'});
  f.state.taskContext = clone(previousHistory.find(turn => turn.role === 'assistant').meta.taskContext);
  f.repository.query.mockImplementation(async (_, input) => {
    const raw = clone(capture.current.tool.result); raw.datasets[0].queryMeta.queryId = input.queryId;
    return {scope: input.scope, datasets: raw.datasets, choices: raw.choices, asOf: raw.asOf};
  });
  return f;
}

test('actual createV3Service replays the three original provider rounds and excludes prior-answer money while inheriting scope and counts', async () => {
  const f = originalReplay(), result = await f.send(capture.current.message);
  const providerInputs = f.provider.mock.calls.map(call => clone(call[1]));
  const taskInputs = providerInputs.map(messages => JSON.parse(messages.find(item => item.content?.startsWith('TASK_INPUT:')).content.slice(11)));
  outcomes.push({mode: process.env.AI_F22_FUND_MODE || 'candidate', requestId: capture.current.requestId, sourceDigest: capture.sourceDigest,
    sourceKind: 'original-paid-response/scripted-replay/current-actual-service', originalAnswer: capture.current.result.answer,
    result, providerInputs, taskInputs, replayAudits: f.audits, scriptedProviderCalls: f.provider.mock.calls.length, repositoryCalls: f.repository.query.mock.calls});
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.repository.query).toHaveBeenCalledTimes(1);
  expect(result.answer).not.toContain(phrase);
  expect(result.answer).toContain('示例基金2号 · 2026-11-04：收益增量 -3.2500，本金增量 0.00');
  expect(result.answer).toContain('2026-11-01 至 2026-11-09');
  expect(result.answer).toContain('匹配 4 行，本次展示 1 行');
  expect(result.answer).toContain('部分登记记录，不能相加作为完整合计');
  expect(result.datasets).toHaveLength(1);
  expect(result.datasets[0].queryMeta.queryId).toMatch(/^q_[a-f0-9]{24}$/);
  expect(result.datasets[0].queryMeta).toEqual({...partial().queryMeta, queryId: result.datasets[0].queryMeta.queryId});
  expect(result.datasets[0].rows).toEqual(partial().rows.map(row => Object.fromEntries(partial().columns.map(column => [column.key, row[column.key]]))));
  expect(result.datasets[0].summary).toEqual({}); expect(result.chart).toBeNull();
  for (const input of taskInputs) {
    expect(input.taskContext.scope).toEqual({startDate: '2026-11-01', endDate: '2026-11-09'});
    expect(input.activeQuery).toBeNull();
    expect(input.priorAnswers).toEqual(capture.current.providers[0].taskInput.priorAnswers);
    expect(input.previousQueryCoverage[0]).toMatchObject({datasetId: 'fund-history', matchedRowCount: 4, returnedRowCount: 4,
      rowsComplete: true, effectiveScope: partial().queryMeta.effectiveScope});
  }
  const saved = f.state.conversationStore.append.mock.calls.at(-1)[2];
  expect(saved.answer).toBe(result.answer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.audits.filter(log => log.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.audits.find(log => log.phase === 'tool-recovery').errorCode).toBe('AI_TOOL_ARGUMENT_INVALID');
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
