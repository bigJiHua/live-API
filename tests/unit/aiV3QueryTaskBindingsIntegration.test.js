jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Real database forbidden'); }), getConnection: jest.fn(() => { throw new Error('Real database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw new Error('Real provider forbidden'); }) }));
const { fixture, final, calls, now } = require('../fixtures/aiV3MemoryFixture');
const source = {
  "finance-monthly": {
    "datasetId": "finance-monthly",
    "domain": "finance",
    "title": "收支月度趋势",
    "columns": [
      {
        "key": "month",
        "label": "月份",
        "type": "date"
      },
      {
        "key": "income",
        "label": "收入",
        "type": "money"
      },
      {
        "key": "expense",
        "label": "支出",
        "type": "money"
      },
      {
        "key": "count",
        "label": "笔数",
        "type": "number"
      },
      {
        "key": "unpricedCount",
        "label": "未定价笔数",
        "type": "number"
      },
      {
        "key": "net",
        "label": "净收支（收入减支出）",
        "type": "money"
      }
    ],
    "rows": [
      {
        "month": "2026-06",
        "income": "3911.24",
        "expense": "5784.61",
        "count": 268,
        "unpricedCount": 0,
        "net": "-1873.37"
      }
    ],
    "summary": {
      "income": "3911.24",
      "expense": "5784.61",
      "count": 268,
      "incomeCount": 115,
      "expenseCount": 153,
      "unpricedCount": 0,
      "currency": "CNY",
      "startDate": "2026-06-01",
      "endDate": "2026-06-30",
      "incomplete": false,
      "net": "-1873.37",
      "surplus": "0.00",
      "deficit": "1873.37"
    },
    "policy": "消费口径：剔除转账、信用卡还款、已删除及冲正；已知外币按每笔有效冻结汇率折人民币至分。缺失或无效币种、缺失或非正汇率未计入金额，不能视为完整总额；全部未定价时金额为空。 本次先按日期、收支方向及文本筛选全范围，再统计和排序；汇总笔数是匹配收支流水数，结果行数按数据集粒度计数。",
    "asOf": "2026-11-09T09:44:33.562Z",
    "isEstimated": false,
    "truncated": false,
    "fullRangeQuery": {
      "filter": "",
      "matchedRowCount": 1
    }
  },
  "card-monthlyConsumption": {
    "datasetId": "card-monthlyConsumption",
    "domain": "card",
    "title": "按卡消费月度统计（人民币）",
    "columns": [
      {
        "key": "month",
        "label": "消费月",
        "type": "date"
      },
      {
        "key": "name",
        "label": "卡片",
        "type": "text"
      },
      {
        "key": "type",
        "label": "类型",
        "type": "text"
      },
      {
        "key": "currency",
        "label": "统计币种",
        "type": "text"
      },
      {
        "key": "amountCNY",
        "label": "已定价消费",
        "type": "money"
      },
      {
        "key": "count",
        "label": "消费笔数",
        "type": "number"
      },
      {
        "key": "unpricedCount",
        "label": "未定价笔数",
        "type": "number"
      },
      {
        "key": "sourceCurrencies",
        "label": "原币种",
        "type": "text"
      }
    ],
    "rows": [
      {
        "month": "2026-11",
        "name": "卡片A",
        "type": "借记卡",
        "currency": "CNY",
        "amountCNY": "0.01",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片A"
      },
      {
        "month": "2026-11",
        "name": "卡片B",
        "type": "信用卡",
        "currency": "CNY",
        "amountCNY": "39.91",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片B"
      },
      {
        "month": "2026-11",
        "name": "卡片C",
        "type": "借记卡",
        "currency": "CNY",
        "amountCNY": "183.32",
        "count": 4,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片C"
      },
      {
        "month": "2026-11",
        "name": "卡片D",
        "type": "现金",
        "currency": "CNY",
        "amountCNY": "23.50",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片D"
      },
      {
        "month": "2026-11",
        "name": "卡片E",
        "type": "虚拟余额",
        "currency": "CNY",
        "amountCNY": "62.32",
        "count": 5,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片E"
      },
      {
        "month": "2026-10",
        "name": "卡片F",
        "type": "信用卡",
        "currency": "CNY",
        "amountCNY": "17.38",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片F"
      },
      {
        "month": "2026-10",
        "name": "卡片G",
        "type": "信用卡",
        "currency": "CNY",
        "amountCNY": "200.00",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片G"
      },
      {
        "month": "2026-10",
        "name": "卡片D",
        "type": "现金",
        "currency": "CNY",
        "amountCNY": "1.00",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片D"
      },
      {
        "month": "2026-09",
        "name": "卡片F",
        "type": "信用卡",
        "currency": "CNY",
        "amountCNY": "19.38",
        "count": 2,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片F"
      },
      {
        "month": "2026-09",
        "name": "卡片G",
        "type": "信用卡",
        "currency": "CNY",
        "amountCNY": "666.00",
        "count": 1,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片G"
      },
      {
        "month": "2026-09",
        "name": "卡片E",
        "type": "虚拟余额",
        "currency": "CNY",
        "amountCNY": "824.00",
        "count": 7,
        "unpricedCount": 0,
        "sourceCurrencies": "CNY",
        "card_id": "offline-card-卡片E"
      }
    ],
    "summary": {
      "expense": "2036.82",
      "count": 25,
      "incomeCount": 0,
      "expenseCount": 25,
      "unpricedCount": 0,
      "currency": "CNY",
      "incomplete": false
    },
    "policy": "消费流水口径而非账单：剔除转账/还款/删除/冲正，按消费月逐卡统计，已知币种按有效冻结汇率折人民币至分；币种或汇率不可靠的消费未计金额，全部未定价时金额为空，不是完整总额。只在用户明确匹配唯一别名时限制单卡，否则展示候选；有限结果不能自行合成全量。",
    "asOf": "2026-11-09T09:44:33.618Z",
    "isEstimated": false,
    "truncated": false,
    "fullRangeQuery": {
      "filter": "",
      "matchedRowCount": 11
    },
    "cardMonthlyQuery": {
      "filter": "",
      "matchedRowCount": 11,
      "summary": {
        "expense": "2036.82",
        "count": 25,
        "incomeCount": 0,
        "expenseCount": 25,
        "unpricedCount": 0,
        "currency": "CNY",
        "incomplete": false
      },
      "sort": "dateDesc",
      "groupBy": "cardMonth"
    }
  },
  "asset-snapshots": {
    "datasetId": "asset-snapshots",
    "domain": "asset",
    "title": "流动资产系统快照",
    "columns": [
      {
        "key": "date",
        "label": "日期",
        "type": "date"
      },
      {
        "key": "totalAsset",
        "label": "流动资产",
        "type": "money"
      },
      {
        "key": "creditDebt",
        "label": "信用卡负债",
        "type": "money"
      },
      {
        "key": "netAsset",
        "label": "净资产",
        "type": "money"
      },
      {
        "key": "recordedAt",
        "label": "保存时间",
        "type": "text"
      }
    ],
    "rows": [
      {
        "date": "2026-11-06",
        "totalAsset": "14886.64",
        "creditDebt": "5967.50",
        "netAsset": "8919.14",
        "recordedAt": "2026-11-05T16:43:54.000Z",
        "id": "offline-row-asset-snapshots-0"
      }
    ],
    "summary": {
      "currency": "unverified"
    },
    "policy": "已保存流动资产快照，范围不含固定资产和基金；总额无币种字段，旧生成逻辑可能混币，不能视为已证明人民币总额；不重建余额或重新清算。 按快照日期从新到旧排列，同日保留多条保存记录并保持固定顺序；保存时间单独列出。",
    "asOf": "2026-11-09T09:44:33.687Z",
    "isEstimated": false,
    "truncated": false,
    "coverage": "liquid-assets-snapshot",
    "fullRangeQuery": {
      "filter": "",
      "matchedRowCount": 1
    }
  },
  "work-salary": {
    "datasetId": "work-salary",
    "domain": "work",
    "title": "已登记每日工资",
    "columns": [
      {
        "key": "date",
        "label": "日期",
        "type": "date"
      },
      {
        "key": "company",
        "label": "工作",
        "type": "text"
      },
      {
        "key": "type",
        "label": "类型",
        "type": "text"
      },
      {
        "key": "hours",
        "label": "工时",
        "type": "decimal"
      },
      {
        "key": "daySalary",
        "label": "基本工资",
        "type": "money"
      },
      {
        "key": "subsidy",
        "label": "补贴",
        "type": "money"
      },
      {
        "key": "deductions",
        "label": "扣款合计",
        "type": "money"
      },
      {
        "key": "income",
        "label": "实得记录",
        "type": "money"
      },
      {
        "key": "status",
        "label": "保存状态",
        "type": "number"
      }
    ],
    "rows": [],
    "summary": {
      "income": "0.00",
      "count": 0
    },
    "policy": "只读已保存工资记录；实得工资记录不代表账户到账。没有记录不能当作零工资，不触发自动生成或补写。 按工作日期从新到旧排列，同日保持固定顺序。",
    "asOf": "2026-11-09T09:44:33.736Z",
    "isEstimated": false,
    "truncated": false,
    "fullRangeQuery": {
      "filter": "",
      "matchedRowCount": 0
    }
  }
};
const today = now().toISOString().slice(0, 10), day = Number(today.slice(8));
const message = '分别查询：6月份收入和支出月度汇总；最近三个月所有卡片逐卡逐月消费；11月1日至' + day + '日流动资产系统保存快照；11月1日至' + day + '日已登记工资流水。每部分保留各自日期范围与数量，不要混币，也别把工资记录当银行到账。给6月收入支出柱状图。';
const ownInput = messages => JSON.parse(messages.find(item => item.role === 'user' && item.content.startsWith('TASK_INPUT:')).content.slice('TASK_INPUT:'.length));
const replayEvidence = [];
const capture = (name, f, result) => replayEvidence.push({ name, answer: result.answer, chart: result.chart,
  datasets: result.datasets, currentTasks: ownInput(f.provider.mock.calls[0][1]).currentTasks, taskContexts: f.state.tasks, queryCoverage: f.state.coverage });
const datasetsOf = messages => messages.filter(item => item.role === 'tool').flatMap(item => JSON.parse(item.content).datasets || []);
const batch = (...items) => ({ role: 'assistant', content: null, tool_calls: items.flatMap(item => item.tool_calls) });
function replay({ modelChart = true } = {}) {
  const respond = (_, messages, __, options) => {
    const input = ownInput(messages), current = input.userTurns[input.currentTurn], datasets = datasetsOf(messages);
    if (!datasets.length && !options.json) return current === message ? batch(
      calls('query_data', { datasetId: 'finance-monthly', startDate: '2026-06-01', endDate: '2026-06-30' }),
      calls('query_data', { datasetId: 'card-monthlyConsumption', startDate: '2026-09-01', endDate: today, groupBy: 'cardMonth', sort: 'dateDesc' }),
      calls('query_data', { datasetId: 'asset-snapshots', startDate: '2026-11-01', endDate: today }),
      calls('query_data', { datasetId: 'work-salary', startDate: '2026-11-01', endDate: today }))
      : calls('query_data', { datasetId: 'work-salary', limit: 1 });
    const finance = datasets.find(dataset => dataset.datasetId === 'finance-monthly');
    return final({ answer: '财务、卡片、资产和工资分别查询完成，工资未保存记录不代表银行到账；资产快照币种未确认。',
      proposal: null, proposals: null, clarification: null,
      chart: modelChart && current === message && finance ? { datasetId: 'finance-monthly', queryId: finance.queryMeta.queryId, type: 'bar', xKey: 'month', yKeys: ['income', 'expense'], title: '6月收支' } : null });
  };
  const f = fixture(Array.from({ length: 16 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = ['finance', 'card', 'asset', 'work'];
  f.repository.query.mockImplementation(async (_, args) => {
    const dataset = structuredClone(source[args.datasetId]); if (!dataset) throw new Error('Unexpected dataset in X13 replay');
    dataset.asOf = now().toISOString(); return { scope: args.scope, asOf: dataset.asOf, datasets: [dataset], choices: {} };
  });
  const store = f.state.conversationStore, append = store.append.getMockImplementation();
  store.loadTaskContexts = jest.fn(async () => f.state.tasks || { version: 1, tasks: [] });
  store.loadQueryCoverage = jest.fn(async () => f.state.coverage || { version: 1, results: [] });
  store.append = jest.fn(async (...args) => { await append(...args); f.state.tasks = structuredClone(args[2].taskContexts); f.state.coverage = structuredClone(args[2].queryCoverage); });
  return f;
}
const task = (f, subject) => f.state.tasks.tasks.find(item => item.subject === subject);
function assertFacts(f, result) {
  expect(result.datasets.map(dataset => dataset.datasetId).sort()).toEqual(['asset-snapshots', 'card-monthlyConsumption', 'finance-monthly', 'work-salary']);
  const input = ownInput(f.provider.mock.calls[0][1]); expect(input.currentTasks.map(item => item.subject).sort()).toEqual(['asset', 'cards', 'finance', 'work']);
  expect(input.currentTasks.find(item => item.subject === 'finance').targetDatasetId).toBe('finance-monthly');
  expect(task(f, 'finance')).toMatchObject({ scope: { startDate: '2026-06-01', endDate: '2026-06-30' }, chartRequest: { type: 'bar', metric: 'amount' } });
  expect(task(f, 'cards')).toMatchObject({ metric: 'card-consumption', scope: { startDate: '2026-09-01', endDate: today }, chartRequest: null, allCardTypes: true });
  expect(task(f, 'asset')).toMatchObject({ scope: { startDate: '2026-11-01', endDate: today }, chartRequest: null });
  expect(task(f, 'work')).toMatchObject({ scope: { startDate: '2026-11-01', endDate: today }, status: 'succeeded', chartRequest: null });
  expect(f.state.coverage.results.map(item => item.datasetId).sort()).toEqual(['asset-snapshots', 'card-monthlyConsumption', 'finance-monthly', 'work-salary']);
  expect(result.answer).toContain('3911.24'); expect(result.answer).toContain('5784.61'); expect(result.answer).toContain('8919.14');
  // Per-card monthly facts do not need a second whole-range total in prose.
  const cards = result.datasets.find(dataset => dataset.datasetId === 'card-monthlyConsumption');
  expect(cards.summary).toMatchObject({ expense: '2036.82', count: 25 });
  expect(cards.rows).toHaveLength(11);
  expect(result.answer).toMatch(/工资|实得记录/); expect(result.answer).toMatch(/0|没有/); expect(result.answer).toMatch(/币种.*(?:未确认|未核验)|未确认.*币种/);
  const names = [...new Set(source['card-monthlyConsumption'].rows.map(row => row.name))];
  for (const name of names.slice(0, 6)) expect(result.answer).toContain(name);
  if (names.length > 6) expect(result.answer).toContain('正文展示部分卡片');
  expect(result.answer).toMatch(/没有记录不等于零工资/); expect(result.answer).toMatch(/不代表银行到账/);
  expect(result.answer).toMatch(/匹配 11 行，本次展示 11 行/); expect(result.answer).toMatch(/匹配 0 行，本次展示 0 行/);
  const finance = result.datasets.find(dataset => dataset.datasetId === 'finance-monthly');
  expect(result.chart).toMatchObject({ datasetId: 'finance-monthly', queryId: finance.queryMeta.queryId, type: 'bar', xKey: 'month', yKeys: ['income', 'expense'] });
  expect(result.chart.title).toContain('2026-06-01 至 2026-06-30');
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
}
let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errorSpy.mockRestore());
afterAll(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled(); expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
test('actual createV3Service preserves four scopes, source facts, empty salary and model chart', async () => {
  const f = replay(), result = await f.send(message); capture('four-subject-model-chart', f, result); assertFacts(f, result);
});
test('actual createV3Service rebuilds the unique finance chart when model returns chart null', async () => {
  const f = replay({ modelChart: false }), result = await f.send(message); capture('four-subject-synthesized-chart', f, result); assertFacts(f, result);
});
test.each(['别改查普通收入流水', '不要改查普通收入流水', '不用查询普通收入流水', '无需读取普通收入流水', '别看普通收入流水', '不要查看普通收入流水', '不查普通收入流水', '不看普通收入流水', '不读取普通收入流水', '不得查询普通收入流水'])(
  'a denied unrelated query never creates fresh finance evidence or revives its chart: %s', async denied => {
    const f = replay(); await f.send(message); const at = f.provider.mock.calls.length;
    const result = await f.send('回到刚才工资部分，范围不变，再查询已保存工资，只展示前1条。没有记录就说明，' + denied + '，也别画虚构图。');
    const input = ownInput(f.provider.mock.calls[at][1]);
    expect(input.currentTasks.map(item => item.subject)).toEqual(['work']);
    expect(input.taskContext).toMatchObject({ targetDatasetId: 'work-salary', chartRequest: null, scope: { startDate: '2026-11-01', endDate: today } });
    expect(f.repository.query.mock.calls.slice(4).map(call => call[1].datasetId)).toEqual(['work-salary']);
    expect(result.datasets.map(dataset => dataset.datasetId)).toEqual(['work-salary']);
    expect(result.datasets[0].queryMeta).toMatchObject({ matchedRowCount: 0, returnedRowCount: 0 });
    expect(result.chart).toBeNull();
  });

test('affirmative 分别 and a mixed deny-then-read clause retain their legitimate targets', () => {
  const { buildQueryTaskBindings } = require('../../src/modules/ai/service/queryTaskBindings');
  const tasks = { version: 1, tasks: [] };
  const positive = buildQueryTaskBindings({ message: '分别查询：6月份收入和支出月度汇总；11月已登记工资流水。', today, tasks });
  expect(positive.map(binding => binding.taskContext.targetDatasetId)).toEqual(['finance-monthly', 'work-salary']);
  const mixed = buildQueryTaskBindings({ message: '别查普通收入流水，改查11月已登记工资流水；查询当前账户余额。', today, tasks });
  expect(mixed.map(binding => binding.taskContext.targetDatasetId)).toEqual(['work-salary', 'account-balances']);
});

test('salary followup retains its independent range and zero-row coverage without finance chart', async () => {
  const f = replay(); await f.send(message); const at = f.provider.mock.calls.length;
  const result = await f.send('回到刚才工资部分，范围不变，再查询已保存工资，只展示前1条。没有记录就说明，别改查普通收入流水，也别画虚构图。');
  capture('salary-independent-followup', f, result);
  const input = ownInput(f.provider.mock.calls[at][1]); expect(input.taskContext).toMatchObject({ subject: 'work', scope: { startDate: '2026-11-01', endDate: today }, chartRequest: null });
  expect(input.currentTasks.map(item => item.subject)).toEqual(['work']);
  expect(f.repository.query.mock.calls).toHaveLength(5);
  expect(input.previousQueryCoverage.map(item => item.datasetId).sort()).toEqual(['asset-snapshots', 'card-monthlyConsumption', 'finance-monthly', 'work-salary']);
  expect(result.datasets.map(dataset => dataset.datasetId)).toEqual(['work-salary']); expect(result.datasets[0].rows).toEqual([]);
  expect(result.datasets[0].queryMeta).toMatchObject({ effectiveScope: { startDate: '2026-11-01', endDate: today }, matchedRowCount: 0, returnedRowCount: 0 });
  expect(result.chart).toBeNull(); expect(task(f, 'asset')).toBeDefined(); expect(task(f, 'cards')).toBeDefined();
});
