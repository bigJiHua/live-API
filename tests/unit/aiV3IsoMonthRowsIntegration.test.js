jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Live DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Live DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Live provider forbidden');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const record={"message":"查询2025年11月8日至2026年11月9日收入与支出的逐月汇总，最多展示50个月。如范围被限制，请保留原请求与实际范围的说明。"};
const output={
  "answer": "已按你的要求查询逐月收支汇总。完整查询范围为2025-11-08至2026-11-09，共978笔收支流水。\n\n逐月数据（人民币）：\n- 2026-04：收入17,818.34 / 支出17,005.48 / 净+812.86（203笔）\n- 2026-05：收入8,160.37 / 支出6,644.73 / 净+1,515.64（252笔）\n- 2026-06：收入3,911.24 / 支出5,784.61 / 净-1,873.37（268笔）\n- 2026-07：收入3,258.78 / 支出2,690.97 / 净+567.81（165笔）\n- 2026-08：收入160.24 / 支出5,536.03 / 净-5,375.79（58笔）\n- 2026-09：收入13,942.98 / 支出1,509.38 / 净+12,433.60（15笔）\n- 2026-10：收入200.01 / 支出218.38 / 净-18.37（5笔）\n- 2026-11（截至11-09）：收入0.00 / 支出309.06 / 净-309.06（12笔）\n\n汇总：收入47,451.96，支出39,698.64，净结余+7,753.32，全部已定价，无未定价笔数。\n\n说明：2025-11至2026-03无收支记录行，未列示；2026-11为未结束月份，仅反映截至11月9日的数据，不代表整月。",
  "proposal": null,
  "proposals": null,
  "clarification": null,
  "chart": null
};
const args={"datasetId":"finance-monthly","startDate":"2025-11-08","endDate":"2026-11-09","limit":50,"sort":"monthAsc","direction":"both"};
const dataset={
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
      "month": "2026-04",
      "income": "17818.34",
      "expense": "17005.48",
      "count": 203,
      "unpricedCount": 0,
      "net": "812.86"
    },
    {
      "month": "2026-05",
      "income": "8160.37",
      "expense": "6644.73",
      "count": 252,
      "unpricedCount": 0,
      "net": "1515.64"
    },
    {
      "month": "2026-06",
      "income": "3911.24",
      "expense": "5784.61",
      "count": 268,
      "unpricedCount": 0,
      "net": "-1873.37"
    },
    {
      "month": "2026-07",
      "income": "3258.78",
      "expense": "2690.97",
      "count": 165,
      "unpricedCount": 0,
      "net": "567.81"
    },
    {
      "month": "2026-08",
      "income": "160.24",
      "expense": "5536.03",
      "count": 58,
      "unpricedCount": 0,
      "net": "-5375.79"
    },
    {
      "month": "2026-09",
      "income": "13942.98",
      "expense": "1509.38",
      "count": 15,
      "unpricedCount": 0,
      "net": "12433.60"
    },
    {
      "month": "2026-10",
      "income": "200.01",
      "expense": "218.38",
      "count": 5,
      "unpricedCount": 0,
      "net": "-18.37"
    },
    {
      "month": "2026-11",
      "income": "0.00",
      "expense": "309.06",
      "count": 12,
      "unpricedCount": 0,
      "net": "-309.06"
    }
  ],
  "summary": {
    "income": "47451.96",
    "expense": "39698.64",
    "count": 978,
    "incomeCount": 305,
    "expenseCount": 673,
    "unpricedCount": 0,
    "currency": "CNY",
    "startDate": "2025-11-08",
    "endDate": "2026-11-09",
    "incomplete": false,
    "net": "7753.32",
    "surplus": "7753.32",
    "deficit": "0.00"
  },
  "policy": "查询范围 2025-11-08 至 2026-11-09。消费口径：剔除转账、信用卡还款、已删除及冲正；已知外币按每笔有效冻结汇率折人民币至分。缺失或无效币种、缺失或非正汇率未计入金额，不能视为完整总额；全部未定价时金额为空。 本次先按日期、收支方向及文本筛选全范围，再统计和排序；汇总笔数是匹配收支流水数，结果行数按数据集粒度计数。",
  "asOf": "2026-11-09T11:12:21.229Z",
  "isEstimated": false,
  "truncated": false,
  "queryMeta": {
    "version": 1,
    "queryId": "q_0e0f7f542264fba7c925730f",
    "datasetId": "finance-monthly",
    "requestedScope": {
      "startDate": "2025-11-08",
      "endDate": "2026-11-09"
    },
    "effectiveScope": {
      "startDate": "2025-11-08",
      "endDate": "2026-11-09"
    },
    "filters": {
      "direction": "both",
      "text": ""
    },
    "sort": "monthAsc",
    "matchedRowCount": 8,
    "returnedRowCount": 8,
    "sourceRecordCount": 978,
    "rowsComplete": true,
    "summaryComplete": true,
    "rankingComplete": true,
    "returnedDateRange": null,
    "asOf": "2026-11-09T11:12:21.229Z",
    "resolution": "month",
    "page": { "offset": 0, "limit": 50, "hasMore": false, "nextCursor": null }
  },
  "totalCount": 8
};
test('actual combined V3 service preserves all 8 correct ISO-month/count rows including the verified November short-date annotation',async()=>{
  const f=fixture([calls('query_data',args),final(output)],{memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))},clock:()=>new Date(dataset.asOf)});
  f.repository.query.mockImplementation(async(_,input)=>{const clone=structuredClone(dataset);clone.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[clone],choices:{},asOf:dataset.asOf};});
  const result=await f.send(record.message),lines=result.answer.split('\n').filter(line=>/^[-*]\s*2026-\d{2}/.test(line));
  expect(lines).toHaveLength(8);expect(result.datasets[0].rows).toEqual(dataset.rows);
  expect(result.answer).toContain('2026-11（截至2026-11-09）');
  expect(result.datasets[0].queryMeta.effectiveScope).toEqual({startDate:args.startDate,endDate:args.endDate});
  expect(result.datasets[0].queryMeta).toMatchObject({resolution:'month',rowsComplete:true,page:{offset:0,hasMore:false,nextCursor:null}});
  expect(result.answer).not.toMatch(/最多12个月窗口|范围被系统规范/);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
