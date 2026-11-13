const gate=require('../../src/modules/ai/service/queryEvidenceGate');
const {buildQueryTaskBindings}=require('../../src/modules/ai/service/queryTaskBindings');
const paid=require('../fixtures/aiFourQueryMonthlyChartPaidRegression.json');
const mode='production',reports=[];
function input(){
 const bindings=buildQueryTaskBindings({message:paid.message,today:paid.today,tasks:structuredClone(paid.taskInput.taskContexts)});
 const datasets=paid.tools.flatMap(t=>structuredClone(t.result.datasets)),queryInputs=new Map(paid.tools.map(t=>[t.result.datasets[0].queryMeta.queryId,structuredClone(t.result.effectiveArgs)]));
 const goals=gate.queryGoals({bindings,message:paid.message,previousTasks:paid.taskInput.taskContexts,coverage:{version:1,results:paid.taskInput.previousQueryCoverage}});
 return{bindings,goals,message:paid.message,datasets,queryInputs,today:paid.today};
}
const dataset=(x,id)=>x.datasets.find(d=>d.datasetId===id),task=(x,id)=>x.bindings.find(b=>b.taskContext.targetDatasetId===id).taskContext;
test('the exact captured four query goals are proved before closing the sole monthly chart',()=>{
 const x=input();expect(x.bindings.map(b=>b.taskContext)).toEqual(paid.taskInput.currentTasks);
 expect(x.goals.every(g=>gate.goalDataset(g,x.datasets,x.queryInputs,x.today))).toBe(true);
 expect(gate.knownMonthlyFinanceChart(null,x.goals,x.datasets,x.queryInputs,x.today)).toMatchObject({datasetId:'finance-monthly',xKey:'month',yKeys:['income','expense']});
 expect(task(x,'finance-monthly').comparisonScopes).toEqual([task(x,'finance-monthly').scope]);
 expect(gate.explicitQueriesComplete(x)).toBe(true);reports.push({capturedGoals:4,mode,complete:gate.explicitQueriesComplete(x)});
});
test('the existing no-chart pure query completion is unchanged',()=>{const x=input();task(x,'finance-monthly').chartRequest=null;task(x,'finance-monthly').comparisonScopes=[];expect(gate.explicitQueriesComplete(x)).toBe(true);});
test('the existing no-chart singleton comparison remains incomplete',()=>{const x=input();task(x,'finance-monthly').chartRequest=null;expect(gate.explicitQueriesComplete(x)).toBe(false);});
const controls=[
 ['missing finance data',x=>{x.datasets=x.datasets.filter(d=>d.datasetId!=='finance-monthly');}],
 ['missing cards data',x=>{x.datasets=x.datasets.filter(d=>d.datasetId!=='card-monthlyConsumption');}],
 ['missing asset data',x=>{x.datasets=x.datasets.filter(d=>d.datasetId!=='asset-snapshots');}],
 ['missing salary data',x=>{x.datasets=x.datasets.filter(d=>d.datasetId!=='work-salary');}],
 ['wrong finance scope',x=>{dataset(x,'finance-monthly').queryMeta.effectiveScope.endDate='2026-05-31';}],
 ['wrong card scope',x=>{dataset(x,'card-monthlyConsumption').queryMeta.effectiveScope.startDate='2026-08-01';}],
 ['wrong asset scope',x=>{dataset(x,'asset-snapshots').queryMeta.effectiveScope.startDate='2026-10-01';}],
 ['wrong salary scope',x=>{dataset(x,'work-salary').queryMeta.effectiveScope.endDate='2026-11-08';}],
 ['wrong finance direction',x=>{dataset(x,'finance-monthly').queryMeta.filters.direction='expense';}],
 ['wrong card direction',x=>{dataset(x,'card-monthlyConsumption').queryMeta.filters.direction='both';}],
 ['wrong card type',x=>{dataset(x,'card-monthlyConsumption').queryMeta.filters.cardTypes=['credit'];}],
 ['unrequested card filter',x=>{const d=dataset(x,'card-monthlyConsumption');d.queryMeta.filters.text='花呗';x.queryInputs.get(d.queryMeta.queryId).filter='花呗';}],
 ['wrong finance sort',x=>{dataset(x,'finance-monthly').queryMeta.sort='monthDesc';}],
 ['incomplete finance rows',x=>{const d=dataset(x,'finance-monthly');d.queryMeta.rowsComplete=false;d.queryMeta.matchedRowCount=null;}],
 ['incomplete finance summary',x=>{dataset(x,'finance-monthly').queryMeta.summaryComplete=false;}],
 ['unknown card coverage',x=>{const d=dataset(x,'card-monthlyConsumption');d.queryMeta.rowsComplete=false;d.queryMeta.matchedRowCount=null;}],
 ['incomplete asset coverage',x=>{const d=dataset(x,'asset-snapshots');d.queryMeta.rowsComplete=false;d.queryMeta.matchedRowCount=null;}],
 ['unproved empty salary',x=>{const d=dataset(x,'work-salary');d.queryMeta.rowsComplete=false;d.queryMeta.matchedRowCount=null;}],
 ['wrong returned count',x=>{dataset(x,'work-salary').queryMeta.returnedRowCount=1;}],
 ['missing current query input',x=>{x.queryInputs.delete(dataset(x,'asset-snapshots').queryMeta.queryId);}],
 ['wrong current query input target',x=>{x.queryInputs.get(dataset(x,'asset-snapshots').queryMeta.queryId).datasetId='asset-composition';}],
 ['two charts',x=>{task(x,'card-monthlyConsumption').chartRequest={type:'line',metric:'amount'};}],
 ['unproved pie chart',x=>{task(x,'finance-monthly').chartRequest.type='pie';}],
 ['unproved chart dataset',x=>{task(x,'finance-monthly').targetDatasetId='finance-daily';}],
 ['chart missing income money column',x=>{dataset(x,'finance-monthly').columns=dataset(x,'finance-monthly').columns.filter(c=>c.key!=='income');}],
 ['duplicate candidate monthly dataset',x=>{x.datasets.push(structuredClone(dataset(x,'finance-monthly')));}],
 ['actual multiple scope comparison',x=>{task(x,'finance-monthly').comparisonScopes.push({startDate:'2026-05-01',endDate:'2026-05-31'});}],
 ['singleton with mismatched period',x=>{task(x,'finance-monthly').comparisonScopes[0]={startDate:'2026-05-01',endDate:'2026-05-31'};}],
 ['comparison on another task',x=>{task(x,'asset-snapshots').comparisonScopes=[task(x,'asset-snapshots').scope];}],
 ['ranking metric',x=>{task(x,'finance-monthly').metric='transaction-max';}],
 ['card ranking question',x=>{x.message+=' 哪张卡消费最高？';}],
 ['analysis question',x=>{x.message+=' 分析支出增加原因。';}],
 ['comparison question',x=>{x.message+=' 比较各部分。';}],
 ['unrecognized target',x=>{task(x,'asset-snapshots').targetDatasetId='unknown-dataset';}],
 ['non-query task',x=>{task(x,'work-salary').mode='record';}],
 ['no current goal',x=>{x.goals=[];}],
 ['explicit cap unfulfilled',x=>{const g=x.goals.find(g=>g.task.targetDatasetId==='asset-snapshots');g.constraints={limit:2};}]
];
test.each(controls)('completion remains false: %s',(name,mutate)=>{const x=input();mutate(x);expect(gate.explicitQueriesComplete(x)).toBe(false);reports.push({name,complete:false});});
test('a supported monthly line chart is proved using the same current query',()=>{const x=input();task(x,'finance-monthly').chartRequest.type='line';expect(gate.explicitQueriesComplete(x)).toBe(true);});
