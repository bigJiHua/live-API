const {queryCoverageProse}=require('../../src/modules/ai/service/queryCoverageProse');
const meta=(direction='expense',text='',groupBy)=>({effectiveScope:{startDate:'2026-06-01',endDate:'2026-06-30'},filters:{direction,text},matchedRowCount:2,returnedRowCount:1,sourceRecordCount:12,...(groupBy?{groupBy}:{})});
const data=(datasetId,queryMeta,title='收支明细',domain='finance')=>({datasetId,domain,title,queryMeta});
test('same dataset and range distinguishes direction and actual literal filters',()=>{
 const text=queryCoverageProse([data('finance-transactions',meta('expense','餐饮')),data('finance-transactions',meta('income','工资'))]);
 const lines=text.split('\n');expect(lines).toHaveLength(2);expect(lines[0]).toContain('支出，逐笔明细，文字筛选“餐饮”');expect(lines[1]).toContain('收入，逐笔明细，文字筛选“工资”');
 expect(lines[0]).toContain('匹配 2 行，本次展示 1 行，来源 12 笔记录');expect(text).not.toMatch(/finance-transactions|direction|filter|groupBy|expense|income/);
});
test('same dataset date and direction distinguishes two text filters',()=>{
 const text=queryCoverageProse([data('finance-transactions',meta('expense','餐饮')),data('finance-transactions',meta('expense','购汇'))]);expect(text.split('\n')).toHaveLength(2);expect(text).toContain('文字筛选“购汇”');
});
test('the real card grouping and selected type use user-facing labels',()=>{
 const byCard=meta('expense','','card');byCard.filters.cardTypes=['debit'];const byMonth=meta('expense','','cardMonth');
 const text=queryCoverageProse([data('card-monthlyConsumption',byCard,'卡片消费','card'),data('card-monthlyConsumption',byMonth,'卡片消费','card')]);
 expect(text).toContain('逐卡区间累计消费');expect(text).toContain('卡片类型：借记卡');expect(text).toContain('逐卡逐月消费');expect(text).not.toMatch(/cardMonth|groupBy|debit/);
});
test('saved-state datasets do not claim a meaningful income/expense direction',()=>{
 const text=queryCoverageProse([data('card-counts',meta('both'),'卡片数量','card')]);expect(text).toContain('目前已保存状态');expect(text).toContain('按卡片类型计数');expect(text).not.toContain('收入和支出');
});
test('identical displayed query scopes still deduplicate and retain null-count uncertainty',()=>{
 const query=meta();query.matchedRowCount=null;query.sourceRecordCount=null;const d=data('finance-daily',query,'每日收支');const text=queryCoverageProse([d,d]);
 expect(text.split('\n')).toHaveLength(1);expect(text).toContain('全范围匹配数量尚未确定');expect(text).toContain('按日汇总');
});
