jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw new Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw new Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw new Error('Real provider forbidden');})}));
const {fixture,final,calls}=require('../fixtures/aiV3MemoryFixture');
const reports=[];
// N04 paid capture c84ec6d9-7a44-4b83-bf0b-7762069ed7c1; original request did not specify sorting.
// This count-guard replay explicitly authorizes the captured expenseDesc rows; original rows/metadata/JSON are unchanged.
const record={message:"查看6月份逐日收入与支出的每日汇总。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。 请按支出金额降序展示。"};
const output={
  "answer": "已读取2026年6月1日至6月30日全月每日汇总，共匹配268笔收支流水（收入115笔、支出153笔），覆盖30个有记录日期；按支出金额从高到低展示前10天如下。\n\n6月支出最高的10天：\n- 6月2日：收入1472.06元，支出1093.97元，15笔，净收+378.09元\n- 6月18日：收入8.56元，支出1015.19元，13笔，净支-1006.63元\n- 6月8日：收入40.00元，支出711.30元，7笔，净支-671.30元\n- 6月22日：收入608.57元，支出617.27元，6笔，净支-8.70元\n- 6月28日：收入8.60元，支出387.28元，6笔，净支-378.68元\n- 6月26日：收入356.24元，支出358.57元，16笔，净支-2.33元\n- 6月23日：收入203.45元，支出271.66元，14笔，净支-68.21元\n- 6月15日：收入178.09元，支出186.62元，8笔，净支-8.53元\n- 6月1日：收入126.98元，支出138.53元，29笔，净支-11.55元\n- 6月17日：收入294.00元，支出120.25元，4笔，净收+173.75元\n\n数据范围与数量说明：实际读取范围为2026-06-01至2026-06-30（全月30天均有记录），匹配收支流水共268笔，本次仅展示按支出排序的前10天；全月合计为收入3911.24元、支出5784.61元、净支出1873.37元，该汇总为全范围统计，不由上述10天相加得出。",
  "proposal": null,
  "proposals": null,
  "clarification": null,
  "chart": null
};
const dataset={
  "datasetId": "finance-daily",
  "domain": "finance",
  "title": "收支每日汇总",
  "columns": [
    {
      "key": "date",
      "label": "日期",
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
      "date": "2026-06-02",
      "income": "1472.06",
      "expense": "1093.97",
      "count": 15,
      "unpricedCount": 0,
      "net": "378.09"
    },
    {
      "date": "2026-06-18",
      "income": "8.56",
      "expense": "1015.19",
      "count": 13,
      "unpricedCount": 0,
      "net": "-1006.63"
    },
    {
      "date": "2026-06-08",
      "income": "40.00",
      "expense": "711.30",
      "count": 7,
      "unpricedCount": 0,
      "net": "-671.30"
    },
    {
      "date": "2026-06-22",
      "income": "608.57",
      "expense": "617.27",
      "count": 6,
      "unpricedCount": 0,
      "net": "-8.70"
    },
    {
      "date": "2026-06-28",
      "income": "8.60",
      "expense": "387.28",
      "count": 6,
      "unpricedCount": 0,
      "net": "-378.68"
    },
    {
      "date": "2026-06-26",
      "income": "356.24",
      "expense": "358.57",
      "count": 16,
      "unpricedCount": 0,
      "net": "-2.33"
    },
    {
      "date": "2026-06-23",
      "income": "203.45",
      "expense": "271.66",
      "count": 14,
      "unpricedCount": 0,
      "net": "-68.21"
    },
    {
      "date": "2026-06-15",
      "income": "178.09",
      "expense": "186.62",
      "count": 8,
      "unpricedCount": 0,
      "net": "-8.53"
    },
    {
      "date": "2026-06-01",
      "income": "126.98",
      "expense": "138.53",
      "count": 29,
      "unpricedCount": 0,
      "net": "-11.55"
    },
    {
      "date": "2026-06-17",
      "income": "294.00",
      "expense": "120.25",
      "count": 4,
      "unpricedCount": 0,
      "net": "173.75"
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
  "policy": "查询范围 2026-06-01 至 2026-06-30。消费口径：剔除转账、信用卡还款、已删除及冲正；已知外币按每笔有效冻结汇率折人民币至分。缺失或无效币种、缺失或非正汇率未计入金额，不能视为完整总额；全部未定价时金额为空。 本次先按日期、收支方向及文本筛选全范围，再统计和排序；汇总笔数是匹配收支流水数，结果行数按数据集粒度计数。 本次返回 10 行，未返回全部匹配结果；全范围汇总不以已返回行重新相加。 返回日期只描述已返回行，边界日期可能仍有未返回记录。",
  "asOf": "2026-11-09T10:27:58.003Z",
  "isEstimated": false,
  "truncated": true,
  "queryMeta": {
    "version": 1,
    "queryId": "q_9b4b9cd800234d4560004cf7",
    "datasetId": "finance-daily",
    "requestedScope": {
      "startDate": "2026-06-01",
      "endDate": "2026-06-30"
    },
    "effectiveScope": {
      "startDate": "2026-06-01",
      "endDate": "2026-06-30"
    },
    "filters": {
      "direction": "both",
      "text": ""
    },
    "sort": "expenseDesc",
    "matchedRowCount": 30,
    "returnedRowCount": 10,
    "sourceRecordCount": 268,
    "rowsComplete": false,
    "summaryComplete": true,
    "rankingComplete": true,
    "returnedDateRange": {
      "startDate": "2026-06-01",
      "endDate": "2026-06-28"
    },
    "asOf": "2026-11-09T10:27:58.003Z"
  },
  "totalCount": 30
};
function setup(answer){
  const f=fixture([calls('query_data',{datasetId:'finance-daily',startDate:'2026-06-01',endDate:'2026-06-30',direction:'both',sort:'expenseDesc',limit:10}),final({...output,answer})],
    {memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});
  f.repository.query.mockImplementation(async(_,args)=>{const clone=structuredClone(dataset);clone.queryMeta.queryId=args.queryId;return{scope:args.scope,asOf:dataset.asOf,choices:{},datasets:[clone]};});
  return f;
}
test('actual createV3Service preserves all 10 correct daily net/count rows from the captured paid JSON',async()=>{
  const f=setup(output.answer),result=await f.send(record.message),rows=result.answer.split('\n').filter(line=>line.startsWith('- '));
  reports.push({name:'captured-paid-answer-through-actual-service',answer:result.answer,datasets:result.datasets,mockProviderInvocations:f.provider.mock.calls.length,correctDailyLines:rows.length});
  expect(rows).toHaveLength(10);expect(result.datasets[0].rows).toEqual(dataset.rows);
  expect(result.datasets[0].queryMeta).toMatchObject({matchedRowCount:30,returnedRowCount:10,sourceRecordCount:268});
  const providerPayloads=f.provider.mock.calls.flatMap(call=>call[1].filter(message=>message.role==='tool').map(message=>JSON.parse(message.content)));
  expect(providerPayloads.some(payload=>payload.datasets?.[0]?.rows.every(row=>row.net!=null))).toBe(true);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test('actual service still removes wrong daily count despite another day publishing that number',async()=>{
  const f=setup('- 6月2日：收入1472.06元，支出1093.97元，13笔，净收+378.09元'),result=await f.send(record.message);
  expect(result.answer).not.toContain('- 6月2日：');reports.push({name:'wrong-daily-count',answer:result.answer});
});
test('actual service still removes an unpublished net amount',async()=>{
  const f=setup('- 6月2日：收入1472.06元，支出1093.97元，15笔，净收+987654.32元'),result=await f.send(record.message);
  expect(result.answer).not.toContain('- 6月2日：');reports.push({name:'wrong-daily-net',answer:result.answer});
});
afterAll(()=>{
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
