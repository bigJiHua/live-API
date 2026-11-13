const { normalizeInstallmentSavedStateClaims: normalize } = require('../../src/modules/ai/service/queryInstallmentStateClaims');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const { normalizeInstallmentRemainingClaims: remainingProse } = require('../../src/modules/ai/service/queryInstallmentStateClaims');

const raw = `目前只找到 1 个启用中的分期计划，情况如下：

- **计划**：手机分期
- **每期金额**：416.67
- **总期数**：6 期
- **下次计划日期**：2026-11-12（就是今天）
- **2026-11-01 至 11-12 期间**：待入账 1 期，已入账 0 期

关于"还剩几期"，需要说明一下口径：分期登记里只记录了已保存的期次状态，这次全范围查询显示已入账 0 期、无中止记录，但已入账计数受数据保存情况限制，不能完全等同于你实际已还款的期数。因此无法给出精确的"剩余 X 期"这个数字。

能确定的是：这个手机分期计划仍然是启用状态，且今天的期次尚未入账（待入账 1 期）。如果你想让我按实际入账流水去逐笔核对剩余期数，可以告诉我该分期大约是从哪个月开始的，我再去查交易明细核实。`;
const source = () => ({ datasetId: 'installment-plans', columns: [
  { key: 'name', type: 'text' }, { key: 'amount', type: 'money' },
  ...['periods', 'active', 'pending', 'entered', 'void', 'entering', 'unknown'].map(key => ({ key, type: 'number' })),
  { key: 'nextDate', type: 'date' },
], rows: [{ name: '手机分期', amount: '416.67', periods: 6, active: 1, nextDate: '2026-11-12', pending: 1, entered: 0,
  void: 0, entering: 0, unknown: 0 }], queryMeta: { datasetId: 'installment-plans', queryId: 'q_' + 'a'.repeat(24),
  effectiveScope: { startDate: '2026-11-01', endDate: '2026-11-12' }, rowsComplete: true, matchedRowCount: 1, returnedRowCount: 1 } });

test('the captured live read-count wording becomes saved-state facts with scope and row proof', () => {
  const dataset = source(), before = structuredClone(dataset);
  expect(() => assertResultClaims(raw)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  const answer = normalize(raw, [dataset]);
  expect(answer).toContain('已入账状态：0期');
  expect(answer).toContain('各已返回查询窗口的已保存计数');
  expect(answer).toContain('无法给出精确的');
  expect(() => assertResultClaims(answer)).not.toThrow();
  expect(normalize(answer, [dataset])).toBe(answer);
  expect(dataset).toEqual(before);
});

test.each([
  ['wrong scoped count header', value => value.replace('2026-11-01 至 11-12', '2026-10-01 至 10-12')],
  ['unknown named plan', value => value.replaceAll('手机分期', '不存在的分期')],
  ['wrong named amount', value => value.replace('416.67', '999.00')],
  ['wrong total periods', value => value.replace('6 期', '9 期')],
])('unproved multi-line reading cannot neutralize completion wording: %s', (_, change) => {
  expect(() => assertResultClaims(normalize(change(raw), [source()]))).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each([
  ['missing entered field', data => { data.columns = data.columns.filter(column => column.key !== 'entered'); }],
  ['incorrect entered count', data => { data.rows[0].entered = 1; }],
  ['unknown card amount', data => { data.rows[0].amount = null; }],
  ['incomplete query', data => { data.queryMeta.rowsComplete = false; }],
  ['multiple matching rows', data => { data.rows.push({ ...data.rows[0] }); data.queryMeta.matchedRowCount = data.queryMeta.returnedRowCount = 2; }],
])('the read-report cannot borrow inadequate source proof: %s', (_, change) => {
  const data = source(); change(data);
  expect(() => assertResultClaims(normalize(raw, [data]))).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test.each(['我已经为你完成入账。', '本轮已入账0期。', '这次已为你入账0期。'])
  ('actual execution is still rejected beside proved saved counts: %s', execution => {
    expect(() => assertResultClaims(normalize(raw + '\n' + execution, [source()])))
      .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });

test('a dated card and matching single-plan windows support only the returned-window state counts', () => {
  const one = source(), two = source(); two.queryMeta.queryId = 'q_' + 'b'.repeat(24); two.queryMeta.effectiveScope.startDate = '2020-01-01';
  const answer = normalize(raw, [one, two]);
  expect(answer).toContain('各已返回查询窗口的已保存计数');
  expect(answer).not.toContain('这次全范围查询显示已入账');
  expect(() => assertResultClaims(answer)).not.toThrow();
  expect(answer).toContain('不能完全等同于你实际已还款的期数');
});

test.each([
  ['different saved entered count', data => { data.rows[0].entered = 1; }],
  ['different pending state count', data => { data.rows[0].pending = 0; }],
  ['different plan configuration', data => { data.rows[0].periods = 12; }],
  ['different next date', data => { data.rows[0].nextDate = '2026-12-12'; }],
  ['incomplete other window', data => { data.queryMeta.rowsComplete = false; }],
  ['missing other query scope', data => { delete data.queryMeta.effectiveScope; }],
  ['missing other state column', data => { data.columns = data.columns.filter(column => column.key !== 'unknown'); }],
])('a multi-window count cannot borrow inconsistent evidence: %s', (_, change) => {
  const one = source(), two = source(); two.queryMeta.queryId = 'q_' + 'b'.repeat(24); two.queryMeta.effectiveScope.startDate = '2020-01-01';
  change(two);
  expect(() => assertResultClaims(normalize(raw, [one, two]))).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test('complete single-plan consensus qualifies a zero count without selecting a prose scope', () => {
  const one = source(), two = source(); two.queryMeta.queryId = 'q_' + 'b'.repeat(24); two.queryMeta.effectiveScope.startDate = '2020-01-01';
  const noScope = raw.replace('- **2026-11-01 至 11-12 期间**：待入账 1 期，已入账 0 期\n', '');
  const answer = normalize(noScope, [one, two]);
  expect(answer).toContain('各已返回查询窗口的已保存计数');
  expect(answer).not.toContain('2020-01-01');
  expect(() => assertResultClaims(answer)).not.toThrow();
});

test('actual execution remains rejected after proof-bound multi-window saved counts', () => {
  const one = source(), two = source(); two.queryMeta.queryId = 'q_' + 'b'.repeat(24); two.queryMeta.effectiveScope.startDate = '2020-01-01';
  expect(() => assertResultClaims(normalize(raw + '\n我已为你完成入账。', [one, two])))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

test('an unknown second plan card cannot inherit a previous named plan', () => {
  const changed = '- **计划**：手机分期\n' + raw.replaceAll('手机分期', '不存在的分期');
  expect(() => assertResultClaims(normalize(changed, [source()])))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

const compact = `目前系统里只登记了一个分期计划，全范围查下来情况是这样的：

- **手机分期**：每期 416.67 元，总共 6 期，处于启用状态，下次计划日期就是今天（2026-11-12）。
- 期次状态计数里，待入账 1 期，已入账 0 期。

也就是说，按已保存的记录，今天这一期还没入账，之前也没有已入账的期次记录。所以「还剩几期」严格按系统数据看是 **6 期都还没入账**。

不过要提醒你：这里显示的是已保存的计划配置和期次状态，不等于实际消费流水。如果你之前已经实际还过几期、只是当时没通过分期计划入账，那系统里不会有记录，真实剩余期数需要你自己核对。`;
function returnedWindows() {
  const one = source(), two = source();
  two.queryMeta.queryId = 'q_' + 'b'.repeat(24); two.queryMeta.effectiveScope.startDate = '2016-11-12';
  return [one, two];
}
test('captured compact plan fields bind only unanimous returned-window saved counts without guessing a date scope', () => {
  const datasets = returnedWindows(), before = structuredClone(datasets);
  expect(() => assertResultClaims(compact)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  const answer = normalize(compact, datasets);
  expect(answer).toContain('待入账 1 期，已入账状态：0期');
  expect(answer).toContain('各已返回查询窗口的已保存计数');
  expect(() => assertResultClaims(answer)).not.toThrow();
  expect(answer).not.toContain('2016-11-12');
  expect(datasets).toEqual(before);
});
test.each([
  ['incorrect count', value => value.replace('已入账 0 期', '已入账 1 期')],
  ['unknown plan', value => value.replaceAll('手机分期', '其他分期')],
  ['wrong amount', value => value.replace('416.67', '999.00')],
  ['wrong total periods', value => value.replace('总共 6 期', '总共 12 期')],
  ['wrong next date', value => value.replace('2026-11-12', '2026-12-12')],
])('compact saved counts cannot borrow a nonmatching named configuration: %s', (_, change) => {
  expect(() => assertResultClaims(normalize(change(compact), returnedWindows())))
    .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});
test.each(['我已为你完成入账。', '本轮已入账0期。', '这次已为你入账0期。'])
  ('compact typed saved counts still reject current execution: %s', execution => {
    expect(() => assertResultClaims(normalize(compact + '\n' + execution, returnedWindows())))
      .toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });
test('compact consensus fails closed when any returned window lacks state evidence', () => {
  const datasets = returnedWindows(); delete datasets[1].rows[0].unknown;
  expect(normalize(compact, datasets)).toBe(compact);
});

test.each(['还剩6期。', '剩余6期。', '6期都还没入账。', '六期均尚未入账。'])
  ('published total periods cannot prove the quantified remaining conclusion: %s', conclusion => {
    const text = '手机分期总共6期，每期416.67元；已保存状态待入账1期、已入账状态0期。' + conclusion;
    const answer = remainingProse(text, returnedWindows());
    expect(answer).not.toContain(conclusion);
    expect(answer).toContain('无法仅凭已保存的计划配置和窗口状态计数确认实际剩余期数');
    expect(answer).toContain('总共6期'); expect(answer).toContain('待入账1期'); expect(answer).toContain('已入账状态0期');
  });
test.each(['无法确认是否还剩6期。', '这不代表还剩6期。', '不能因为已入账0期，就断言还剩6期。',
  '你问「还剩6期」是否正确。', '还剩6期吗？', '如果还剩6期，每期金额仍需核对。'])
  ('negated, questioned or hypothetical remaining counts are not ledger assertions: %s', text => {
    expect(remainingProse(text, returnedWindows())).toBe(text);
  });
test('the captured false remaining-period conclusion is corrected without creating a repayment fact', () => {
  const answer = remainingProse(normalize(compact, returnedWindows()), returnedWindows());
  expect(answer).not.toContain('6 期都还没入账'); expect(answer).toContain('总共 6 期');
  expect(answer).toContain('已入账状态：0期'); expect(answer).toContain('实际剩余期数');
});
test('remaining-count normalization cannot hide an explicit current execution claim', () => {
  const text = '我已经为你完成入账，还剩6期。';
  const answer = remainingProse(text, returnedWindows());
  expect(answer).toContain('我已经为你完成入账');
  expect(() => assertResultClaims(answer)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});

const report7 = `查到了你唯一在跑的分期计划，但这次返回的字段里没有「已还期数」，所以剩余期数我不能凭猜测算。能确认的只有这些（数据截至 2026-11-12）：

- 计划名称：手机分期
- 每期金额：416.67
- 总期数：6 期
- 状态：启用中
- 计划下次扣款日期：2026-11-12（就是今天）
- 本月（11-01 至 11-12）范围内：待入账 1 期，已入账 0 期，中止 0 期

从「11 月至今 0 期已入账」只能推出：11 月这笔还没进账。至于 6 期里已经走完几期、还剩几期，这次查询没有返回对应字段，我不会替你估一个数字。`;
test('captured forward and reverse zero-count wording is typed from complete source evidence without a card template', () => {
  const dataset = source(), before = structuredClone(dataset);
  expect(() => assertResultClaims(report7)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  const answer = normalize(report7, [dataset]);
  expect(() => assertResultClaims(answer)).not.toThrow();
  expect(answer).toContain('已入账状态：0期（仅指各已返回查询窗口的已保存计数）');
  expect(answer).toContain('剩余期数我不能凭猜测算'); expect(answer).toContain('每期金额：416.67');
  expect(answer).not.toContain('0 期已入账'); expect(answer).not.toContain('还剩6期');
  expect(dataset).toEqual(before); expect(normalize(answer, [dataset])).toBe(answer);
});
test.each([
  ['nonzero entered value', data => { data.rows[0].entered = 1; }],
  ['missing state field', data => { delete data.rows[0].unknown; }],
  ['missing configuration column', data => { data.columns = data.columns.filter(column => column.key !== 'nextDate'); }],
  ['incomplete query', data => { data.queryMeta.rowsComplete = false; }],
  ['multiple plans', data => { data.rows.push({ ...data.rows[0], name: '第二分期' }); data.queryMeta.matchedRowCount = data.queryMeta.returnedRowCount = 2; }],
])('source-driven zero wording requires the complete single-plan contract: %s', (_, change) => {
  const data = source(); change(data);
  expect(normalize(report7, [data])).toBe(report7);
  expect(() => assertResultClaims(normalize(report7, [data]))).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
});
test.each(['本轮已入账0期。', '我已经为你完成入账0期。', '这次已为你入账0期。', '我已经完成本次操作，已入账0期。'])
  ('source-driven zero is not an execution receipt: %s', actor => {
    const answer = normalize(report7 + '\n' + actor, [source()]);
    expect(answer).toContain(actor);
    expect(() => assertResultClaims(answer)).toThrow(expect.objectContaining({ code: 'AI_RESULT_CLAIM_MISMATCH' }));
  });
test('a zero in one query cannot silently ignore an incomplete sibling installment source', () => {
  const one = source(), two = source(); delete two.queryMeta.queryId;
  expect(normalize(report7, [one, two])).toBe(report7);
});
