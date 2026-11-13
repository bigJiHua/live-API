jest.mock('../../src/common/config/db',()=>({execute:jest.fn(()=>{throw Error('Real DB forbidden');}),getConnection:jest.fn(()=>{throw Error('Real DB forbidden');})}));
jest.mock('../../src/modules/ai/service/deepseek',()=>({deepseekChat:jest.fn(()=>{throw Error('Paid provider forbidden');})}));
const {fixture,calls,final}=require('../fixtures/aiV3MemoryFixture');
const capture={
  "requestId": "a9394e67-5a22-4685-bcfd-0c1c10b448a6",
  "dataset": {
    "datasetId": "installment-plans",
    "domain": "installment",
    "title": "分期计划与保存状态",
    "columns": [
      {
        "key": "name",
        "label": "计划",
        "type": "text"
      },
      {
        "key": "amount",
        "label": "每期计划金额",
        "type": "money"
      },
      {
        "key": "periods",
        "label": "总期数",
        "type": "number"
      },
      {
        "key": "active",
        "label": "启用状态",
        "type": "number"
      },
      {
        "key": "nextDate",
        "label": "计划下次日期",
        "type": "date"
      },
      {
        "key": "pending",
        "label": "范围内待入账",
        "type": "number"
      },
      {
        "key": "entered",
        "label": "范围内已入账",
        "type": "number"
      },
      {
        "key": "void",
        "label": "范围内中止",
        "type": "number"
      },
      {
        "key": "entering",
        "label": "范围内入账中",
        "type": "number"
      },
      {
        "key": "unknown",
        "label": "范围内未知状态",
        "type": "number"
      }
    ],
    "rows": [
      {
        "name": "浦发新贵卡分期",
        "amount": "17.38",
        "periods": 12,
        "active": 1,
        "nextDate": "2026-09-26",
        "pending": 1,
        "entered": 0,
        "void": 0,
        "entering": 0,
        "unknown": 0,
        "ref": "r_84c264bb1bf8cc24373f9d80c47b02ba"
      },
      {
        "name": "建行正青春分期",
        "amount": "17.38",
        "periods": 12,
        "active": 0,
        "nextDate": "2026-08-19",
        "pending": 0,
        "entered": 0,
        "void": 1,
        "entering": 0,
        "unknown": 0,
        "ref": "r_5915dd210c8622be589cc883d932c028"
      },
      {
        "name": "浦发新贵卡分期",
        "amount": "17.38",
        "periods": 12,
        "active": 0,
        "nextDate": "2026-08-28",
        "pending": 0,
        "entered": 0,
        "void": 1,
        "entering": 0,
        "unknown": 0,
        "ref": "r_77b8f06022b2b0334e2b955eea44d9b2"
      }
    ],
    "summary": {},
    "policy": "只读已保存期次状态；不触发自动作废、入账或账单对账。计划金额不是消费；未知状态不能当已入账。 启用计划在前，再按下次计划日期升序排列。 计划清单是目前已保存配置；日期仅限定期次状态计数，不证明这段时间历史配置或实际消费。",
    "asOf": "2026-11-09T12:06:52.027Z",
    "isEstimated": false,
    "truncated": false,
    "queryMeta": {
      "version": 1,
      "queryId": "q_1c0365e1af137c8cad9e88a6",
      "datasetId": "installment-plans",
      "requestedScope": {
        "startDate": "2026-11-01",
        "endDate": "2026-11-09"
      },
      "effectiveScope": {
        "startDate": "2026-11-01",
        "endDate": "2026-11-09"
      },
      "filters": {
        "direction": "both",
        "text": ""
      },
      "sort": "dateDesc",
      "matchedRowCount": 3,
      "returnedRowCount": 3,
      "sourceRecordCount": null,
      "rowsComplete": true,
      "summaryComplete": false,
      "rankingComplete": false,
      "returnedDateRange": null,
      "asOf": "2026-11-09T12:06:52.027Z"
    },
    "totalCount": 3
  },
  "output": {
    "answer": "已读取分期计划清单，数据范围：2026-11-01 至 2026-11-09，匹配 3 条，本次展示 3 条（未达10条上限）。清单为目前保存的配置，日期仅用于限定各期次状态计数，不代表这段时间的历史配置或实际消费。\n\n1. 浦发新贵卡分期：每期 17.38 元，共 12 期，启用中。范围内待入账 1 期，已入账 0，中止 0，入账中 0，未知 0。\n2. 建行正青春分期：每期 17.38 元，共 12 期，已停用。范围内中止 1 期，待入账/已入账/入账中/未知均为 0。\n3. 浦发新贵卡分期（另一条）：每期 17.38 元，共 12 期，已停用。范围内中止 1 期，待入账/已入账/入账中/未知均为 0。\n\n说明：计划金额不是消费金额；「未知」状态不能视为已入账。本次未触发自动作废、入账或账单对账。",
    "proposal": null,
    "proposals": null,
    "clarification": null,
    "chart": null
  }
};
const reports=[];
function setup(answer){const f=fixture([calls('query_data',{datasetId:'installment-plans',startDate:'2026-11-01',endDate:'2026-11-09',limit:10}),final({...capture.output,answer})],{clock:()=>new Date(capture.dataset.asOf),memoryStore:{list:jest.fn(async()=>({files:[],warnings:[]}))}});f.state.businessPolicy.domains.push('installment');
 f.repository.query.mockImplementation(async(_,input)=>{const d=structuredClone(capture.dataset);d.queryMeta.queryId=input.queryId;return{scope:input.scope,datasets:[d],choices:{},asOf:d.asOf};});return f;}
const message='查看2026年11月1日至9日已保存的分期计划及范围内保存期次状态。最多展示10条，并说明实际读取的数据范围、匹配数量和本次展示数量。';
test('actual createV3Service preserves original N23 row-state prose and durable approved evidence',async()=>{
 const f=setup(capture.output.answer),result=await f.send(message);expect(result.datasets).toHaveLength(1);expect(result.datasets[0].rows).toEqual(capture.dataset.rows.map(({ref,...fields})=>fields));expect(result.answer).toContain('已入账状态');expect(result.answer).toContain('本次未触发自动作废');
 const saved=f.state.conversationStore.append.mock.calls[0][2];expect(saved.answer).toBe(result.answer);expect(saved.business.datasets).toEqual(result.datasets);expect(f.state.requestGuard.saveV3Recovery.mock.calls[0][3]).toEqual(result);expect(f.repository.query).toHaveBeenCalledTimes(1);expect(f.provider).toHaveBeenCalledTimes(2);const approved=f.provider.mock.calls[1][1].filter(item=>item.role==='tool').map(item=>JSON.parse(item.content)).find(item=>item.datasets?.length);expect(result.datasets[0].rows).toEqual(approved.datasets[0].rows);
 expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled();reports.push({name:'paid N23 body through actual V3 service',sourceOriginal:{requestId:capture.requestId,queryId:capture.dataset.queryMeta.queryId},answer:result.answer,queryMeta:result.datasets[0].queryMeta,rows:result.datasets[0].rows});
});
test('the actual service still rejects an appended false write claim after correctly described saved states',async()=>{
 const f=setup(capture.output.answer+'\n我已经完成入账。');await expect(f.send(message)).rejects.toMatchObject({code:'AI_RESULT_CLAIM_MISMATCH'});expect(f.state.conversationStore.append).not.toHaveBeenCalled();expect(f.state.requestGuard.saveV3Recovery).not.toHaveBeenCalled();expect(f.state.conversationStore.appendFailure).toHaveBeenCalledTimes(1);expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();reports.push({name:'false execution claim rejected',rejected:true});
});
afterAll(()=>{expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();});
