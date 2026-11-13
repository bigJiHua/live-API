jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Live database forbidden'); }), getConnection: jest.fn(() => { throw Error('Live database forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Live provider forbidden'); }) }));
const fs = require('fs'), path = require('path');
const { fixture, final, calls, now } = require('./fixtures/aiV3DatasetIntentFixture.cjs');
const spec = {
  "datasetId": "asset-comparison",
  "isolated": true,
  "message": "查询2026年8月同日手工和系统保存资产净值，请问这些保存总额能证明是人民币吗？可以直接算人民币差额判断账务异常吗？仅查询，别执行对账。",
  "scope": {
    "startDate": "2026-08-01",
    "endDate": "2026-08-31"
  },
  "maxRows": 10,
  "rows": [
    {
      "date": "2026-08-07",
      "currency": "unverified",
      "netDifference": null
    }
  ],
  "answerPatterns": [
    "币种|同口径",
    "不能|无法|未确认|未核验"
  ],
  "dimensions": [
    "G08",
    "unverified-currency",
    "no-invented-difference",
    "no-reconciliation"
  ]
};
test('production X12 reads the entire explicit August same-day comparison and closes before unrelated November/register/fixed-asset reads', async () => {
  const respond = (_, messages, tools, options) => options.json
    ? final({ answer: '8月7日有同日手工和系统保存值，但币种未确认，不能直接计算人民币差额或判断账务异常。' })
    : !messages.some(item => item.role === 'tool') ? calls('query_data', { datasetId: 'asset-comparison', startDate: '2026-08-09', endDate: '2026-08-09', limit: 10 })
      : calls('query_data', { datasetId: 'asset-registers', startDate: '2026-11-01', endDate: '2026-11-09', limit: 10 });
  const f = fixture(Array.from({ length: 10 }, () => respond), { memoryStore: { list: jest.fn(async () => ({ files: [], warnings: [] })) } });
  f.state.businessPolicy.domains = ['asset'];
  f.repository.query.mockImplementation(async (_, args) => {
    if (!args.datasetId) return { ...f.raw, scope: args.scope };
    const rows = [{ date: '2026-08-07', manualNetAsset: '-58063.73', systemNetAsset: '1534.12', currency: 'unverified', netDifference: null }];
    const columns = [{ key: 'date', label: '保存日期', type: 'date' }, { key: 'manualNetAsset', label: '手工保存净值', type: 'money' },
      { key: 'systemNetAsset', label: '系统保存净值', type: 'money' }, { key: 'currency', label: '币种', type: 'text' }, { key: 'netDifference', label: '同币种差额', type: 'money' }];
    return { scope: args.scope, asOf: now().toISOString(), choices: {}, datasets: [{ datasetId: args.datasetId, domain: 'asset', title: '同日手工登记与系统保存值对照',
      rows, columns, summary: { currency: 'unverified' }, truncated: false, asOf: now().toISOString(), policy: '只能说明同日保存值，币种未确认，不能计算人民币差额。',
      queryMeta: { version: 1, queryId: args.queryId, datasetId: args.datasetId, requestedScope: args.requestedScope,
        effectiveScope: { startDate: args.scope.startDate, endDate: args.scope.endDate }, filters: { direction: 'both', text: args.filter || '' }, sort: 'dateDesc',
        matchedRowCount: 1, returnedRowCount: 1, sourceRecordCount: null, rowsComplete: true, summaryComplete: false, rankingComplete: false,
        returnedDateRange: { startDate: '2026-08-07', endDate: '2026-08-07' }, asOf: now().toISOString() } }] };
  });
  const result = await f.send(spec.message), queryArgs = f.repository.query.mock.calls.map(call => call[1]).filter(args => args.datasetId);
  expect(queryArgs).toHaveLength(1); expect(queryArgs[0]).toMatchObject({ datasetId: 'asset-comparison', scope: spec.scope });
  expect(result.datasets).toHaveLength(1); expect(result.datasets[0].rows[0]).toMatchObject(spec.rows[0]);
  expect(result.datasets[0].queryMeta.effectiveScope).toEqual(spec.scope);
  expect(f.provider.mock.calls[1][2]).toEqual([]); expect(f.provider.mock.calls[1][3]).toMatchObject({ json: true, toolChoice: 'none' });
  expect(result.answer).toMatch(/币种.*未确认/); expect(result.answer).toMatch(/不能/);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled(); expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
  if (process.env.AI_X12_REPORT) fs.writeFileSync(process.env.AI_X12_REPORT, JSON.stringify({ at: new Date().toISOString(), spec,
    queryArgs, result, providerCallsAdded: 0, databaseCalls: 0, productionChanges: 0, mainStateWrites: 0, passed: true }, null, 2) + '\n');
});
