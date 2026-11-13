jest.mock('../../src/common/config/db', () => ({execute: jest.fn(() => {throw Error('Public DB forbidden');}), getConnection: jest.fn(() => {throw Error('Public DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek', () => ({deepseekChat: jest.fn(() => {throw Error('Paid provider forbidden');})}));
const {fixture} = require('../fixtures/aiV3MemoryFixture');
const futureNoticeHelper = require('../../src/modules/ai/service/futureFinanceQueryNotice');
const captured = require('../fixtures/aiX10FutureFinanceProviderCapture.json'), clone = x => structuredClone(x);
let logs, errors;
beforeEach(() => {logs = jest.spyOn(console, 'log').mockImplementation(() => {}); errors = jest.spyOn(console, 'error').mockImplementation(() => {});});
afterEach(() => {logs.mockRestore(); errors.mockRestore();});
function proof() {
  return {message: captured.message, today: '2026-11-09', goals: [{task: clone(captured.providers[0].taskInput.taskContext)}],
    bindings: [], queryContext: {version: 1, activeQuery: clone(captured.providers[0].taskInput.activeQuery)},
    datasets: [], queryInputs: new Map(), failures: [{code: 'AI_SCOPE_INVALID'}], successfulQueries: 0};
}
const decide = p => futureNoticeHelper.futureFinanceQueryNotice(p);
const notice = '2026-12-01 至 2026-12-31 属于未来时段，当前（2026-11-09）该范围尚未开始，无法统计这段期间已发生的收支。本轮保留原请求日期，没有读取账本记录，也没有改用本月数据。';
function setup() {
  const scripted = captured.providers.map(log => () => ({role: 'assistant', content: log.content, reasoning_content: log.reasoning,
    ...(log.toolCalls.length ? {tool_calls: clone(log.toolCalls)} : {})}));
  const f = fixture(scripted, {memoryStore: {list: jest.fn(async () => ({files: [], warnings: []}))}, clock: () => new Date('2026-11-09T14:00:00Z')});
  f.repository.query.mockImplementation(async () => {throw Error('Rejected future query must not read records');});
  return f;
}
test('X10 original three-round provider and recovery sequence preserves dates and saves an accurate future-period notice', async () => {
  const f = setup(), result = await f.send(captured.message);
  expect(result.answer).toBe(notice); expect(result.datasets).toEqual([]); expect(result.toolTrace).toEqual([]); expect(result.chart).toBeNull();
  expect(f.provider).toHaveBeenCalledTimes(3); expect(f.repository.query).not.toHaveBeenCalled();
  expect(f.audits.filter(log => log.phase === 'tool-recovery')).toHaveLength(1);
  expect(f.audits.find(log => log.phase === 'tool-recovery').errorCode).toBe('AI_SCOPE_INVALID');
  for (const call of f.provider.mock.calls) {
    const input = JSON.parse(call[1].find(item => item.content?.startsWith('TASK_INPUT:')).content.slice(11));
    expect(input.userTurns[input.currentTurn]).toBe(captured.message);
    expect(input.activeQuery).toEqual(captured.providers[0].taskInput.activeQuery);
    expect(input.taskContext).toEqual(captured.providers[0].taskInput.taskContext);
  }
  const saved = f.state.conversationStore.append.mock.calls.at(-1)[2];
  expect(saved.answer).toBe(result.answer); expect(saved.queryContext.activeQuery).toMatchObject({startDate: '2026-12-01', endDate: '2026-12-31', periodSource: 'current'});
  expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
  expect(f.state.conversationStore.appendFailure).not.toHaveBeenCalled();
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(result.answer).not.toMatch(/(?:支出|收入|收支)(?:合计|总计)?\s*(?:CNY\s*)?0|目前尚无.*记录/);
});
test('helper is pure and uses only explicit valid current-turn future scope', () => {
  const p = proof(), before = JSON.stringify(p); expect(decide(p)).toBe(notice); expect(JSON.stringify(p)).toBe(before); expect(p.queryInputs.size).toBe(0);
});
test.each([
  ['ISO range', '查询2026-12-01至2026-12-31收入与支出汇总。'],
  ['full month', '查询2026年12月收入与支出汇总。'],
  ['explicit account journal', '查询2026年12月账本流水。'],
])('unambiguous explicit finance future request: %s', (_, message) => {
  const p = proof(); p.message = message; expect(decide(p)).toBe(notice);
});
const unsafe = [
  ['invalid today', p => {p.today = '2026-02-30';}],
  ['no today', p => {delete p.today;}],
  ['current datasets exist', p => {p.datasets.push({datasetId: 'finance-monthly', rows: []});}],
  ['successful current query', p => {p.successfulQueries = 1;}],
  ['current query identity exists', p => {p.queryInputs.set('q_' + 'a'.repeat(24), {});}],
  ['query inputs absent', p => {delete p.queryInputs;}],
  ['no failed tool', p => {p.failures = [];}],
  ['different failure code', p => {p.failures[0].code = 'AI_TOOL_ARGUMENT_INVALID';}],
  ['mixed failure code', p => {p.failures.push({code: 'AI_INVALID_INPUT'});}],
  ['no query goal', p => {p.goals = [];}],
  ['multiple tasks', p => {p.goals.push(clone(p.goals[0]));}],
  ['mixed bindings', p => {p.bindings.push({taskContext: {subject: 'budget'}});}],
  ['multiple bindings', p => {p.bindings = [{taskContext: {subject: 'finance'}}, {taskContext: {subject: 'finance'}}];}],
  ['non-query task', p => {p.goals[0].task.mode = 'write';}],
  ['non-finance task', p => {p.goals[0].task.subject = 'installment';}],
  ['future installment dataset', p => {p.goals[0].task.targetDatasetId = 'installment-plans';}],
  ['future budget dataset', p => {p.goals[0].task.targetDatasetId = 'budget-plans';}],
  ['future todo dataset', p => {p.goals[0].task.targetDatasetId = 'todo-events';}],
  ['finance forecast wording', p => {p.message = '预测2026年12月收入与支出。';}],
  ['finance budget wording', p => {p.message = '查询2026年12月收入与支出预算。';}],
  ['finance installment wording', p => {p.message = '查询2026年12月分期支出。';}],
  ['finance plan wording', p => {p.message = '查询2026年12月收入与支出计划。';}],
  ['scope from previous turn', p => {p.queryContext.activeQuery.periodSource = 'inherited';}],
  ['scope from default', p => {p.queryContext.activeQuery.periodSource = 'default';}],
  ['not explicit period', p => {p.queryContext.activeQuery.explicit.period = false;}],
  ['no active query', p => {p.queryContext = null;}],
  ['no task scope proof', p => {delete p.goals[0].task.scope;}],
  ['mismatched active start', p => {p.queryContext.activeQuery.startDate = '2026-11-01';}],
  ['mismatched active end', p => {p.queryContext.activeQuery.endDate = '2026-12-30';}],
  ['mismatched task scope', p => {p.goals[0].task.scope.endDate = '2026-12-30';}],
  ['future compared periods', p => {p.goals[0].task.comparisonScopes = [{startDate: '2026-10-01', endDate: '2026-10-31'}];}],
  ['invalid future calendar day', p => {p.message = '查询2027年2月30日收入与支出。';}],
  ['reversed calendar range', p => {p.message = '查询2026年12月31日至1日收入与支出。';}],
  ['past range', p => {p.message = '查询2026年10月1日至31日收入与支出。';}],
  ['already started through future', p => {p.message = '查询2026-11-01至2026-12-31收入与支出。';}],
  ['starts today', p => {p.message = '查询2026-11-09至2026-12-31收入与支出。';}],
  ['implicit year', p => {p.message = '查询12月收入与支出汇总。';}],
  ['implicit next month', p => {p.message = '查询下月收入与支出汇总。';}],
  ['no calendar scope', p => {p.message = '查询收入与支出汇总。';}],
  ['quoted period only', p => {p.message = '查账本备注包含“2026年12月1日至31日收入与支出汇总”。';}],
  ['quoted command only', p => {p.message = '这句话是什么意思：“查询2026年12月1日至31日收入与支出汇总”？';}],
  ['no finance request wording', p => {p.message = '查询2026年12月1日至31日天气。';}],
  ['negated query', p => {p.message = '不要查询2026年12月收入与支出汇总。';}],
  ['multiple finance periods', p => {p.message = '查询2026-12-01至2026-12-31和2027-01-01至2027-01-31收支。';}],
  ['discrete ISO dates', p => {p.message = '查询2026-12-01和2026-12-31收入与支出。';}],
  ['discrete Chinese months', p => {p.message = '查询2026年12月和2027年1月收支。';}],
  ['discrete Chinese days', p => {p.message = '查询2026年12月1日与31日收支。';}],
  ['third Chinese day', p => {p.message = '查询2026年12月1日至31日和3日收支。';}],
  ['mixed ISO and Chinese scope', p => {p.message = '查询2026-12-01至2026-12-31、2027年1月收支。';}],
  ['first year implicit', p => {p.message = '查询12月至2027年1月收支。';}],
  ['null goal', p => {p.goals[0] = null;}],
  ['null binding', p => {p.bindings = [null];}],
  ['malformed goals', p => {p.goals = null;}],
  ['mixed finance and budget', p => {p.message = '查询2026年12月收入与支出，另外查询预算。';}],
  ['mixed finance and assets', p => {p.message = '查询2026年12月收入与支出，同时给账户资产。';}],
  ['separate periods', p => {p.message = '分别查询2026年12月和2027年1月收支。';}],
];
test.each(unsafe)('future notice must stay absent: %s', (_, mutate) => {const p = proof(); mutate(p); expect(decide(p)).toBeNull();});
test.each(['finance-monthly', 'finance-daily', 'finance-categories', 'finance-transactions'])('history-only finance target: %s', datasetId => {
  const p = proof(); p.goals[0].task.targetDatasetId = datasetId; expect(decide(p)).toBe(notice);
});
