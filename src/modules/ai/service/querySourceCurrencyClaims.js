const ORIGINAL_FIELDS = Object.freeze({ 'finance-transactions': 'currency', 'card-monthlyConsumption': 'sourceCurrencies' });
const codes = /\b[A-Z]{3}\b/g;
const aliases = [['人民币','CNY'],['美元','USD'],['欧元','EUR'],['港币','HKD'],['日元','JPY'],['英镑','GBP']];
const localScope = /(?:本次|当前|本轮)?(?:已)?(?:展示|返回|显示)(?:的)?(?:这|前)?\s*\d*\s*(?:条|笔|行)?(?:记录|明细|流水|交易|结果)?|(?:上述|这些|这几)(?:条|笔|行)?(?:记录|明细|流水|交易|结果)/;
const globalScope = /(?:全部|所有|全范围|该范围|查询范围|范围内|区间内|整个(?:月|区间|范围)|全月|整月|每(?:一)?(?:条|笔|行))|\b(?:all|every|entire range|whole range)\b/i;
const explicitCurrency = /(?:原币(?:种)?|原始币种|原始货币|original currenc(?:y|ies)|source currenc(?:y|ies))\s*(?:均|都|全部|全都|为|是|:|：|=|are|is|in|only|exclusively|were|was)*\s*((?:[A-Z]{3}|人民币|美元|欧元|港币|日元|英镑)(?:\s*(?:[,，、/]|和|及|and)\s*(?:[A-Z]{3}|人民币|美元|欧元|港币|日元|英镑))*)/gi;
const homogeneous = /(?:未混币|没有混币|不混币|无混币|未混合币种|币种一致|相同币种|同一币种|同一种币种|单一币种|only one (?:original )?currency|not mixed currenc(?:y|ies)|no mixed currenc(?:y|ies)|same original currency)/gi;
const genericCurrency = /(?:均|都|全部|全都|所有[^，,。；;！？\n]{0,20})(?:为|是|使用)?\s*(?:CNY|人民币|USD|美元|EUR|欧元)|(?:币种|currency)\s*(?:均|都|为|是|[:：=]|is|are)\s*(?:CNY|USD|EUR|人民币|美元|欧元)/gi;
const validDate = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
};
function currencySet(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts=value.split(/\s*[,，、/]\s*/).map(part=>part.trim());
  return parts.every(part=>/^[A-Z]{3}$/.test(part)&&!['UNK','XXX'].includes(part)) ? new Set(parts) : null;
}
function claimedCodes(text) {
  const values=[...text.toUpperCase().matchAll(codes)].map(match=>match[0]);
  for(const [label,code]of aliases)if(text.includes(label))values.push(code);
  return new Set(values);
}
function hasGlobalScope(text) {
  for(const match of text.matchAll(new RegExp(globalScope.source,'gi'))){
    const local=[...text.slice(0,match.index).matchAll(new RegExp(localScope.source,'g'))].at(-1);
    if(local&&/^(?:全部|所有|每)/.test(match[0])&&/^\s*(?:的|中|中的)?\s*$/.test(text.slice(local.index+local[0].length,match.index)))continue;
    return true;
  }
  return false;
}
function scopeMatches(text,dataset) {
  const scope=dataset.queryMeta.effectiveScope;
  const stated=[...text.matchAll(/(20\d{2}-\d{2}-\d{2})\s*(?:至|到|to|~|～)\s*(20\d{2}-\d{2}-\d{2})/gi)]
    .map(match=>({startDate:match[1],endDate:match[2],index:match.index,length:match[0].length}));
  for(const match of text.matchAll(/(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日?\s*(?:至|到)\s*(?:(20\d{2})年\s*)?(?:(\d{1,2})月\s*)?(\d{1,2})日/g)){
    const year=match[1]||scope.startDate.slice(0,4);stated.push({startDate:year+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0'),
      endDate:(match[4]||year)+'-'+(match[5]||match[2]).padStart(2,'0')+'-'+match[6].padStart(2,'0'),index:match.index,length:match[0].length});
  }
  if(stated.some(range=>range.startDate!==scope.startDate||range.endDate!==scope.endDate))return false;
  let body=text;
  for(const range of stated.sort((a,b)=>b.index-a.index))body=body.slice(0,range.index)+' '.repeat(range.length)+body.slice(range.index+range.length);
  const months=[...body.matchAll(/\b(20\d{2})-(\d{2})(?![-\d])\b|(?:(20\d{2})年\s*)?(\d{1,2})月(?!\s*\d{1,2}日)/g)];
  for(const month of months){const value=(month[1]||month[3]||scope.startDate.slice(0,4))+'-'+(month[2]||month[4]).padStart(2,'0');if(value!==scope.startDate.slice(0,7)||value!==scope.endDate.slice(0,7))return false;}
  if(/全月|整月/.test(text)){const last=new Date(Date.UTC(Number(scope.endDate.slice(0,4)),Number(scope.endDate.slice(5,7)),0)).toISOString().slice(0,10);
    if(!scope.startDate.endsWith('-01')||scope.startDate.slice(0,7)!==scope.endDate.slice(0,7)||scope.endDate!==last)return false;}
  return true;
}
function originalSource(dataset) {
  const meta=dataset.queryMeta,scope=meta?.effectiveScope,field=ORIGINAL_FIELDS[dataset.datasetId];
  return Boolean(field)&&meta?.version===1&&meta.datasetId===dataset.datasetId&&/^q_[a-f0-9]{24}$/.test(meta.queryId||'')
    &&validDate(scope?.startDate)&&validDate(scope?.endDate)&&scope.startDate<=scope.endDate&&Array.isArray(dataset.rows)
    &&meta.returnedRowCount===dataset.rows.length&&Number.isSafeInteger(meta.matchedRowCount)&&meta.matchedRowCount>=meta.returnedRowCount
    &&dataset.columns?.some(column=>column.key===field&&column.type==='text')
    &&(field!=='sourceCurrencies'||['card','cardMonth'].includes(meta.groupBy));
}
function statedRows(text,dataset) {
  const named=(dataset.rows||[]).filter(row=>row.name&&text.includes(row.name));
  if(named.length){
    if(dataset.queryMeta.groupBy!=='cardMonth'&&named.length===1)return named;
    if(localScope.test(text))return named;
    const meta=dataset.queryMeta;
    if(meta.groupBy==='cardMonth'&&meta.rowsComplete===true&&dataset.truncated!==true
      &&meta.matchedRowCount===dataset.rows.length&&Number.isSafeInteger(meta.sourceRecordCount)
      &&dataset.rows.every(row=>Number.isSafeInteger(row.count)&&row.count>0)
      &&dataset.rows.reduce((sum,row)=>sum+row.count,0)===meta.sourceRecordCount)return named;
  }
  if(/(?:这|该|本)笔|最大(?:的)?一笔|单笔|(?:this|that) transaction/i.test(text)
    &&!/(?:20\d{2}-\d{2}-\d{2})\s*(?:至|到|to|~|～)\s*(?:20\d{2}-\d{2}-\d{2})/i.test(text)){
    const dates=[...text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map(match=>match[0]);
    const dated=dataset.rows.filter(row=>dates.includes(row.date));if(dated.length===1)return dated;
  }
  if(/(?:这|该|本)笔|(?:this|that) transaction/i.test(text)&&dataset.rows.length===1)return dataset.rows;
  if(localScope.test(text))return dataset.rows;
  return null;
}
function proof(text,dataset,desired,oneCurrency) {
  if(!originalSource(dataset)||!scopeMatches(text,dataset))return false;
  const meta=dataset.queryMeta,field=ORIGINAL_FIELDS[dataset.datasetId];
  const returnedSources=field==='currency'?dataset.rows.length:dataset.rows.reduce((sum,row)=>sum+(Number.isSafeInteger(row.count)?row.count:0),0);
  const widerCount=[...text.matchAll(/(\d+)\s*(?:条|笔|行)(?:支出|收入|消费|记录|明细|流水|交易)?/g)].some(match=>Number(match[1])>returnedSources);
  const whole=hasGlobalScope(text)||widerCount;
  const local=localScope.test(text)&&!whole,named=!whole?statedRows(text,dataset):null;
  const rows=named||dataset.rows;
  const global=!local&&!named;
  if(global&&(meta.rowsComplete!==true||dataset.truncated===true||meta.matchedRowCount!==dataset.rows.length))return false;
  if(global&&meta.filters?.text&&!text.includes(meta.filters.text))return false;
  if(global&&['income','expense'].includes(meta.filters?.direction)&&!new RegExp(meta.filters.direction==='expense'?'支出|消费|expense|spending':'收入|income','i').test(text))return false;
  if(!rows.length)return false;
  // Grouped card rows publish a complete original-currency set for that row.
  // Their CNY 'currency' column is a converted statistic, never original proof.
  const sets=rows.map(row=>currencySet(row[field]));
  if(sets.some(set=>set===null))return false;
  if(field==='sourceCurrencies'&&(!dataset.columns?.some(column=>column.key==='count'&&column.type==='number')||rows.some(row=>!Number.isSafeInteger(row.count)||row.count<=0)))return false;
  if(global&&field==='currency'&&meta.sourceRecordCount!==dataset.rows.length)return false;
  if(global&&field==='sourceCurrencies'&&(!Number.isSafeInteger(meta.sourceRecordCount)||dataset.rows.reduce((sum,row)=>sum+row.count,0)!==meta.sourceRecordCount))return false;
  const actual=new Set(sets.flatMap(set=>[...set]));
  if(oneCurrency&&actual.size!==1)return false;
  if(desired.size&&(desired.size!==actual.size||[...desired].some(code=>!actual.has(code))))return false;
  return true;
}
function sourceCurrencyIssues(text,datasets=[]) {
  const relevant=datasets.filter(dataset=>dataset.domain==='finance'||dataset.datasetId==='card-monthlyConsumption');
  if(!relevant.length)return [];
  const claims=[...String(text||'').matchAll(explicitCurrency)].map(match=>({match,desired:claimedCodes(match[1]),oneCurrency:false}));
  claims.push(...[...String(text||'').matchAll(homogeneous)].map(match=>{
    const suffix=/^\s*(?:为|是|[:：=])?\s*([A-Z]{3}|人民币|美元|欧元|港币|日元|英镑)/i.exec(text.slice(match.index+match[0].length));
    return{match,desired:suffix?claimedCodes(suffix[1]):new Set(),oneCurrency:true};
  }));
  // In transaction queries, a generic currency attribution denotes original
  // transaction currency unless it explicitly says the values are converted.
  if(relevant.some(dataset=>dataset.datasetId==='finance-transactions')&&!/折算|折合|换算|统计币种|按人民币|CNY.amount|converted|conversion/i.test(text))
    claims.push(...[...String(text||'').matchAll(genericCurrency)].map(match=>({match,desired:claimedCodes(match[0]),oneCurrency:false})));
  const issues=[];
  for(const {match,desired,oneCurrency}of claims){
    if(/(?:不能|无法|不代表|未证明|未确认|尚不能|尚未|无法确认|不能确认|是否)[^，,。；;！？\n]{0,35}$/.test(text.slice(0,match.index))||/[？?]\s*$/.test(text))continue;
    let candidates=relevant.filter(dataset=>validDate(dataset.queryMeta?.effectiveScope?.startDate)&&validDate(dataset.queryMeta?.effectiveScope?.endDate)&&scopeMatches(text,dataset));
    const named=candidates.filter(dataset=>text.includes(dataset.datasetId)||dataset.title&&text.includes(dataset.title));
    if(named.length)candidates=named;
    else if(/(?:这|该|本)笔|最大(?:的)?一笔|单笔|this transaction/i.test(text))candidates=candidates.filter(dataset=>dataset.datasetId==='finance-transactions');
    if(candidates.length!==1||!proof(text,candidates[0],desired,oneCurrency))issues.push({claim:match[0],index:match.index,desired:[...desired],oneCurrency,queryIds:candidates.map(dataset=>dataset.queryMeta.queryId)});
  }
  return issues;
}
function normalizeSourceCurrencyClaims(text,datasets=[]) {
  return (String(text||'').match(/[^。；;！？\n]+[。；;！？]?|\n+/g)||[]).map(sentence=>
    /^\n+$/.test(sentence)||!sourceCurrencyIssues(sentence,datasets).length?sentence:'').join('').replace(/\n{3,}/g,'\n\n');
}
module.exports={sourceCurrencyIssues,normalizeSourceCurrencyClaims};
