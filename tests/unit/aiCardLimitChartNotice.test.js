const paid=require('../fixtures/aiCardLimitBasisPaidRegression.json');
const {capture,extracted}=paid;
const {cardLimitChartNotice,cardLimitChartExplanation,explicitLimitBasis,NOTICE}=require('../../src/modules/ai/service/queryCardLimitChartNotice');
function setup(){const dataset=structuredClone(capture.payload.data.datasets[0]),chart=structuredClone(capture.payload.data.chart),meta=dataset.queryMeta;
 const args={datasetId:dataset.datasetId,queryId:meta.queryId,...meta.requestedScope,limit:10,direction:'both',filter:''};
 return{message:capture.message,answer:capture.payload.data.answer,chart,datasets:[dataset],today:'2026-11-09',queryInputs:new Map([[meta.queryId,args]]),goals:[{
  text:capture.message,task:structuredClone(extracted.providers[0].taskInput.taskContext),constraints:{limit:10},
  coverage:{results:structuredClone(extracted.providers[0].taskInput.previousQueryCoverage)}}]};}
test('actual C06 request is an explicit fixed-limit chart basis request',()=>expect(explicitLimitBasis(capture.message)).toBe(true));
test('captured approved ten-row truncated chart receives only the requested number-free generic basis',()=>{
 const input=setup(),saved=structuredClone({chart:input.chart,datasets:input.datasets,goals:input.goals}),note=cardLimitChartNotice(input);
 expect(note).toBe(NOTICE);expect(note).toContain('逐卡登记的配置值');expect(note).toContain('共享池额度不能逐卡相加当作可用额度');
 expect(note).not.toMatch(/\d|农业银行|浦发|兴业|poolRef|元/);expect({chart:input.chart,datasets:input.datasets,goals:input.goals}).toEqual(saved);
});
test('existing correct generic basis is not duplicated',()=>{const input=setup();input.answer=NOTICE;expect(cardLimitChartNotice(input)).toBe('');});
test('a negated general basis is not mistaken for the canonical notice',()=>{const input=setup();
 input.answer='图中额度并不是逐卡配置值，也不认为共享池额度不能相加当作可用额度。';expect(cardLimitChartNotice(input)).toBe(NOTICE);});
test.each([
 '图中额度并不是逐卡配置值，也不认为共享池额度不能相加当作可用额度。',
 '固定额度是逐卡配置值，但共享池额度可以相加为可用额度。',
 '图中固定额度并不代表逐卡登记的配置值。共享池额度不必限制相加当可用额度。',
 NOTICE,
])('proved target replaces positive and negative model basis sentences with canonical evidence: %s',basis=>{
 const factual='农业银行 6838固定额度5000。范围内匹配81张，本次展示10张。';
 const cleaned=cardLimitChartExplanation(factual+'\n'+basis);
 expect(cleaned).toContain('农业银行 6838固定额度5000。');expect(cleaned).toContain('范围内匹配81张，本次展示10张。');
 expect(cleaned).not.toContain(basis);expect(cleaned).not.toContain('共享池');
});
test('quoted labels and other policy text do not become general basis sentences',()=>{
 const text='卡片名称是“逐卡配置值”。日期不重建历史快照。此图按名称排列。';
 expect(cardLimitChartExplanation(text)).toContain('卡片名称是“逐卡配置值”。');
 expect(cardLimitChartExplanation(text)).toContain('日期不重建历史快照。');
 expect(cardLimitChartExplanation(text)).toContain('此图按名称排列。');
});
test.each([
 ['固定额度6000元，逐卡登记。','固定额度6000元'],
 ['固定额度6,000.00元，逐卡登记。','固定额度6,000.00元'],
 ['农业银行 6838固定额度5000，逐卡登记。','农业银行 6838固定额度5000'],
 ['2026-11-09 图中额度范围共10张，配置值可用于查询。','2026-11-09 图中额度范围共10张'],
 ['农业银行 6838固定额度5000,逐卡登记。','农业银行 6838固定额度5000'],
])('general basis replacement preserves adjacent numeric data clause: %s',(text,expected)=>{
 const cleaned=cardLimitChartExplanation(text);expect(cleaned).toContain(expected);expect(cleaned).not.toContain('逐卡登记');
});
test('a numeric prefix cannot exempt a contradictory basis clause',()=>{
 expect(cardLimitChartExplanation('本次展示10张，图中额度不是逐卡配置值。共享池额度6000可以相加当可用额度。')).not.toContain('不是逐卡');
 expect(cardLimitChartExplanation('本次展示10张，图中额度不是逐卡配置值。共享池额度6000可以相加当可用额度。')).not.toContain('共享池');
 expect(cardLimitChartExplanation('本次展示10张，图中额度不是逐卡配置值。')).toContain('本次展示10张');
});
test.each(['no-chart','wrong-id','missing-id','wrong-type','wrong-axis','wrong-column','two-series','wrong-dataset','no-goal','two-goals','non-query','wrong-target','comparison','empty','no-limit-value','count','column-type','duplicate-column','two-datasets','missing-input','wrong-input-id','wrong-input-dataset','input-scope','requested-scope','inherited-scope','explicit-scope','missing-inherited','wrong-filter','wrong-limit'])('no basis is added for invalid/ambiguous binding %s',mutation=>{
 const f=setup(),d=f.datasets[0],m=d.queryMeta,args=f.queryInputs.get(m.queryId),g=f.goals[0];
 if(mutation==='no-chart')f.chart=null;if(mutation==='wrong-id')f.chart.queryId='q_'+'0'.repeat(24);if(mutation==='missing-id')delete f.chart.queryId;
 if(mutation==='wrong-type')f.chart.type='pie';if(mutation==='wrong-axis')f.chart.xKey='type';if(mutation==='wrong-column')f.chart.yKeys=['tempLimit'];if(mutation==='two-series')f.chart.yKeys.push('tempLimit');
 if(mutation==='wrong-dataset'){d.datasetId='card-pools';f.chart.datasetId='card-pools';}if(mutation==='no-goal')f.goals=[];if(mutation==='two-goals')f.goals.push(structuredClone(g));
 if(mutation==='non-query')g.task.mode='record';if(mutation==='wrong-target')g.task.targetDatasetId='card-pools';if(mutation==='comparison')g.task.comparisonScopes=[m.effectiveScope];
 if(mutation==='empty'){d.rows=[];m.returnedRowCount=0;}if(mutation==='no-limit-value')for(const row of d.rows)row.creditLimit=null;if(mutation==='count')m.returnedRowCount=9;if(mutation==='column-type')d.columns.find(c=>c.key==='creditLimit').type='text';
 if(mutation==='duplicate-column')d.columns.push({...d.columns.find(c=>c.key==='creditLimit')});if(mutation==='two-datasets')f.datasets.push(structuredClone(d));
 if(mutation==='missing-input')f.queryInputs.clear();if(mutation==='wrong-input-id')args.queryId='q_'+'1'.repeat(24);if(mutation==='wrong-input-dataset')args.datasetId='card-pools';
 if(mutation==='input-scope')args.startDate='2026-10-01';if(mutation==='requested-scope')m.requestedScope.startDate='2026-10-01';
 if(mutation==='inherited-scope'){args.startDate='2026-10-01';m.requestedScope.startDate='2026-10-01';m.effectiveScope.startDate='2026-10-01';}
 if(mutation==='explicit-scope')g.task.scope={startDate:'2026-06-01',endDate:'2026-06-30'};if(mutation==='missing-inherited')g.coverage={results:[]};
 if(mutation==='wrong-filter')g.constraints.filter='其他卡';if(mutation==='wrong-limit')g.constraints.limit=1;
 expect(cardLimitChartNotice(f)).toBe('');
});
test.each([
 '查看当前卡片清单，给前10张卡固定额度柱状图，以卡片名称作横轴。',
 '不要给前10张卡固定额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。',
 '不画前10张卡固定额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。',
 '禁止给前10张卡固定额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。',
 '给前10张卡固定额度柱状图。不要说明逐卡配置值，共享池额度不能相加当可用额度。',
 '给前10张卡固定额度柱状图。禁止说明逐卡配置值，共享池额度不能相加当可用额度。',
 '给前10张卡临时额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。',
 '给前10张卡固定额度折线图。说明逐卡配置值，共享池额度不能相加当可用额度。',
 '参考示例：“给前10张卡固定额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。”',
 '示例：给前10张卡固定额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。',
 '```\n给前10张卡固定额度柱状图。说明逐卡配置值，共享池额度不能相加当可用额度。\n```',
 '给固定资产账面价值柱状图。说明配置值，不能相加当可用额度。'
])('non-target or negated request stays unchanged: %s',message=>{const f=setup();f.message=message;f.goals[0].text=message;expect(cardLimitChartNotice(f)).toBe('');});
test('pool membership is deliberately irrelevant to the generic note',()=>{const f=setup();for(const row of f.datasets[0].rows)delete row.poolRef;
 expect(cardLimitChartNotice(f)).toBe(NOTICE);expect(NOTICE).not.toContain('同一');});
