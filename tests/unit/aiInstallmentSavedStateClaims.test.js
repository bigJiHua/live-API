const {assertResultClaims}=require('../../src/modules/ai/service/v3Claims');
const {normalizeInstallmentSavedStateClaims:n}=require('../../src/modules/ai/service/queryInstallmentStateClaims');
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
const dataset=capture.dataset;
const clone=()=>structuredClone(dataset);
test('the original paid N23 body admits three same-query row-state blocks without pretending to execute',()=>{
 const result=n(capture.output.answer,[dataset]);expect(result).toContain('已入账状态： 0');expect(result).toContain('待入账/「已入账」/入账中/未知均为 0');expect(()=>assertResultClaims(result)).not.toThrow();
 expect(result).toContain('本次未触发自动作废、入账或账单对账');expect(result.split('\n').filter(l=>/^\d\./.test(l))).toHaveLength(3);
});
test.each([
 '1. 浦发新贵卡分期：启用中，范围内待入账1期，已入账0期。',
 '1. 浦发新贵卡分期：启用中，范围内待入账1，已入账0，中止0，未知0。',
 '2. 建行正青春分期：已停用，已入账/待入账/入账中/未知均为0。',
 '建行正青春分期：已停用，已入账0条。',
 '1. 浦发新贵卡分期：启用中。\n范围内已入账0期。',
])('same-row typed saved-state counts support status wording: %s',text=>{expect(()=>assertResultClaims(n(text,[dataset]))).not.toThrow();expect(n(text,[dataset])).toMatch(/已入账状态|「已入账」/);});
test.each([
 ['wrong entered count taken from pending1','1. 浦发新贵卡分期：启用中，已入账1期。',null],
 ['unknown plan name','1. 不存在的计划，已入账0期。',null],
 ['wrong ordinal name','1. 建行正青春分期，已入账0期。',null],
 ['duplicate name without row identity','浦发新贵卡分期，已入账0期。',null],
 ['wrong configuration discriminator','3. 浦发新贵卡分期：启用中，已入账0期。',null],
 ['unbound standalone status','已入账0期。',null],
 ['aggregate cannot borrow a row','所有计划合计，已入账0期。',null],
 ['another query sharing all values','1. 浦发新贵卡分期：启用中，已入账0期。',d=>{const other=structuredClone(d);other.queryMeta.queryId='q_'+ 'f'.repeat(24);return[d,other];}],
 ['missing published entered column','1. 浦发新贵卡分期：启用中，已入账0期。',d=>{d.columns=d.columns.filter(c=>c.key!=='entered');return[d];}],
 ['wrong scope','数据范围：2026-06-01至2026-06-30\n1. 浦发新贵卡分期：启用中，已入账0期。',null],
 ['wrong grouped counter','2. 建行正青春分期：已停用，已入账/待入账/入账中/未知均为1。',null],
 ['borrow another row entered1','1. 浦发新贵卡分期：启用中，已入账1期。',d=>{d.rows[1].entered=1;return[d];}],
 ['string instead of published integer','1. 浦发新贵卡分期：启用中，已入账0期。',d=>{d.rows[0].entered='0';return[d];}],
])('unproved state wording does not neutralize completion guard: %s',(_,text,change)=>{const d=clone(),sources=change?change(d):[d];expect(n(text,sources)).toBe(text);expect(()=>assertResultClaims(n(text,sources))).toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH'}));});
test.each([
 '1. 浦发新贵卡分期：启用中，范围内已入账0期。本轮已为你完成入账。',
 '1. 浦发新贵卡分期：启用中，本次已入账0期。',
 '1. 浦发新贵卡分期：启用中，我已经完成入账。',
 '1. 浦发新贵卡分期：启用中，已为你完成入账。',
 '1. 浦发新贵卡分期：启用中，范围内已入账0期。\n我已查询并完成入账。',
])('an actual current execution assertion still needs its own receipt: %s',text=>expect(()=>assertResultClaims(n(text,[dataset]))).toThrow(expect.objectContaining({code:'AI_RESULT_CLAIM_MISMATCH'})));
