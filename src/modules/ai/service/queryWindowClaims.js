// Quantifiers and attribute extrema require coverage for that same source.
// A finite row window is evidence about displayed rows, not every match.
const { rowIdentityLabels } = require('./queryRowCountClaims');
const { sourceCurrencyIssues } = require('./querySourceCurrencyClaims');
const { validCountRankClaims } = require('./queryCountRankClaims');
const ALIASES={card:/卡片|信用卡|借记卡|额度|还款|账单|\bcards?\b/i,finance:/收支|收入|支出|流水|交易|消费|\btransactions?\b/i,
  account:/账户|余额|\baccounts?\b/i,fund:/基金|持仓|收益|\bfunds?\b/i,work:/工资|薪资|规则|\bsalary\b/i,
  todo:/日程|待办|任务|\btodos?\b/i,asset:/资产|快照|净值|\bassets?\b/i,fixedAsset:/固定资产|物品/i,installment:/分期/i,budget:/预算/i};
const UNIVERSAL=/所有|全部|全体|每(?:一)?(?:张|笔|条|个)|均|全都|\b(?:all|every|each)\b/i;
const EXTREME=/最早|最晚|最新|最旧|最大|最小|最高|最低|最多|最少|\b(?:earliest|latest|oldest|newest|largest|smallest|highest|lowest|most|least)\b/i;
const LOCAL=/(?:当前|本次|本轮)(?:已)?(?:展示|显示|返回)|(?:上述|这些|这几)(?:\d+)?(?:张|笔|条|行)?(?:卡片|卡|记录|结果)|前\s*\d+\s*(?:张|笔|条|行)|\b(?:shown|displayed|returned)\b|\b(?:these|listed)\s+(?:cards|rows|records)\b/i;
const GLOBAL_RESET=/(?:全部|所有|全体)(?:的)?(?:卡片|信用卡|借记卡|卡|账户|记录|交易|流水|基金|分类|类别)|全范围|整个(?:信用卡|借记卡|卡片|账户|区间|群体)|\b(?:all|every)\s+(?:(?:credit|debit)\s+)?(?:cards|accounts|records|transactions|funds|categories)\b/i;
const UNCERTAIN=/不能|无法|不代表|不表示|未证明|尚不能|尚无法|不确定|未确认|尚未|不足以|是否|不一定|cannot|can't|does not prove|unknown|whether|unconfirmed/i;
const ATTRIBUTE_FIELDS=[
  [/临时额度|temporary.*limits?|tempLimit/i,['tempLimit']],
  [/固定额度|credit\s*limits?|creditLimit/i,['creditLimit']],
  [/到期|有效期|expiration|expiry/i,['expirationMonth','expirationDate']],
  [/币种|currenc(?:y|ies)/i,['currency','sourceCurrencies']],
  [/状态|status/i,['status']],
];
const SUMMARY_FIELDS={expense:'支出',income:'收入',balance:'余额',total:'总额',count:'数量|笔数|条数|总数',unpricedCount:'未定价(?:数量|笔数|条数)',tempLimit:'临时额度',creditLimit:'固定额度'};
function relevantSources(text,datasets){
  const attributes=ATTRIBUTE_FIELDS.filter(([pattern])=>pattern.test(text));
  if(attributes.length){
    // A complete count/type projection cannot establish limits, expiry or
    // currency. Select the published attribute before looking up row labels.
    const keys=attributes.flatMap(([,keys])=>keys);
    return datasets.filter(d=>(d.columns||[]).some(c=>keys.includes(c.key))||keys.some(key=>Object.hasOwn(d.summary||{},key)));
  }
  const named=datasets.filter(d=>(d.rows||[]).some(row=>rowIdentityLabels(row).some(label=>text.includes(label))));
  if(named.length)return named;
  const matched=datasets.filter(d=>text.includes(d.datasetId)||text.includes(d.title||'\0')||ALIASES[d.domain]?.test(text));
  return matched.length?matched:datasets.length===1?datasets:[];
}
function verifiedAggregate(text,dataset){
  const meta=dataset.queryMeta;if(!meta)return false;
  // Matching/display counts are explicit metadata facts even when detail is partial.
  const count=/^(?:所有|全部)?(?:匹配(?:的)?|所查)?(?:记录|卡片|卡|交易|流水)?(?:的)?(?:总数|数量|笔数|条数|共|共有|一共|合计)(?:为|是|共)?\s*(\d+)\s*(?:张|笔|条|行|个)?[。；;]?\s*$/.exec(text.trim());
  if(count&&meta.matchedRowCount!==null&&Number(count[1])===meta.matchedRowCount)return true;
  if(meta.summaryComplete!==true)return false;
  if(/(?:全部|所有|均).*(?:已(?:经)?定价|无未定价)|all.*priced/i.test(text)
    &&dataset.summary?.unpricedCount!==null&&dataset.summary?.unpricedCount!==undefined&&Number(dataset.summary.unpricedCount)===0)return true;
  if(/(?:全部|所有|均).*(?:为|是)(?:收入|支出)/.test(text)&&Number(dataset.summary?.count)>0){
    if(/(?:为|是)支出/.test(text)&&Number(dataset.summary?.incomeCount)===0&&Number(dataset.summary?.expenseCount)===Number(dataset.summary.count))return true;
    if(/(?:为|是)收入/.test(text)&&Number(dataset.summary?.expenseCount)===0&&Number(dataset.summary?.incomeCount)===Number(dataset.summary.count))return true;
  }
  for(const [key,label]of Object.entries(SUMMARY_FIELDS)){
    if(dataset.summary?.[key]==null)continue;
    const pattern=new RegExp('(?:'+label+')(?:金额|总额)?(?:合计|总计|累计|共|总额)(?:为|是)?\\s*(?:CNY|USD|EUR|人民币|[¥￥])?\\s*([-+]?\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:元|CNY|USD|EUR|人民币|张|笔|条|行|个)?[。；;]?\\s*$','i');
    const value=pattern.exec(text);if(value&&Number(value[1].replace(/,/g,''))===Number(dataset.summary[key]))return true;
  }
  return false;
}
function verifiedRank(text,dataset){
  const meta=dataset.queryMeta;if(meta?.rankingComplete!==true)return false;
  // Published amount ordering does not establish an expiry/time/count ordering.
  if(/最早|最晚|最新|最旧|到期|更新|创建|保存时间|笔数|数量|earliest|latest|oldest|newest|expiry|timestamp/i.test(text))return false;
  const field=meta.sort==='expenseDesc'?'expense':meta.sort==='incomeDesc'?'income':['amountDesc','categoryAmountDesc'].includes(meta.sort)?'amountCNY':null;
  if(!field||!/(?:最大|最高|最多|largest|highest|most)/i.test(text))return false;
  if(field==='expense'&&/收入/.test(text)||field==='income'&&/支出/.test(text))return false;
  if(field==='amountCNY'&&(meta.filters?.direction==='expense'&&/收入|income/i.test(text)
    ||meta.filters?.direction==='income'&&/支出|expense/i.test(text)))return false;
  if(/最小|最低|最少|smallest|lowest|least/i.test(text))return false;
  const categoryDirection=meta.sort==='categoryAmountDesc'?( /支出|expense|spending/i.test(text)?0:/收入|income/i.test(text)?1:null):null;
  const winner=(dataset.rows||[]).find(row=>(categoryDirection===null||row.direction===categoryDirection)&&row[field]!==null&&row[field]!==undefined);
  if(!winner||!Number.isFinite(Number(winner[field])))return false;
  const values=[...text.matchAll(/(?:CNY|USD|EUR|人民币|[¥￥])\s*([-+]?\d[\d,]*(?:\.\d+)?)|([-+]?\d[\d,]*(?:\.\d+)?)\s*(?:元|CNY|USD|EUR|人民币)|(?:金额|为|是)\s*([-+]?\d[\d,]*(?:\.\d+)?)/gi)];
  return values.every(match=>Number((match[1]||match[2]||match[3]).replace(/,/g,''))===Number(winner[field]));
}
function publishedDateBound(text,dataset){
  if(dataset.queryMeta?.summaryComplete!==true||GLOBAL_RESET.test(text))return false;
  const field=/最早|earliest/i.test(text)?'firstDate':/最晚|latest/i.test(text)?'lastDate':null;
  if(!field||!(dataset.columns||[]).some(c=>c.key===field&&c.type==='date'))return false;
  return(dataset.rows||[]).some(row=>rowIdentityLabels(row).some(label=>text.includes(label))
    &&typeof row[field]==='string'&&row[field].length>=10&&text.includes(row[field]));
}
// A sorted date window can bound omitted dates, but ties at the last shown
// date remain possible. Full-owner baseline rows never supply this proof.
const DATE_DESC_ROWS = new Set(['finance-transactions', 'finance-daily', 'card-repayments', 'work-salary', 'fund-history', 'asset-snapshots', 'asset-registers', 'asset-comparison']);
const OMITTED_TIE_GUIDANCE = /^(?:同一|边界)日期(?:的)?(?:记录)?(?:仍)?可能(?:未(?:全部)?(?:展示|返回)|仍?有未(?:展示|返回)的?记录)[。；;]?\s*$/;
const legalDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function omittedDateBounds(dataset) {
  const meta = dataset.queryMeta, rows = dataset.rows || [], scope = meta?.effectiveScope, range = meta?.returnedDateRange;
  if (!DATE_DESC_ROWS.has(dataset.datasetId) || meta?.datasetId !== dataset.datasetId || !/^q_[a-f0-9]{24}$/.test(meta?.queryId || '')
    || meta.sort !== 'dateDesc' || meta.rowsComplete !== false || !Number.isInteger(meta.matchedRowCount)
    || meta.returnedRowCount !== rows.length || !rows.length || meta.matchedRowCount <= rows.length
    || !legalDate(scope?.startDate) || !legalDate(scope?.endDate) || scope.startDate > scope.endDate
    || !legalDate(range?.startDate) || !legalDate(range?.endDate)
    || !(dataset.columns || []).some(column => column.key === 'date' && ['date', 'text'].includes(column.type))) return null;
  const dates = rows.map(row => row.date);
  if (dates.some(date => !legalDate(date) || date < scope.startDate || date > scope.endDate)
    || dates.some((date, index) => index > 0 && date > dates[index - 1])
    || range.startDate !== dates.at(-1) || range.endDate !== dates[0]) return null;
  return {min: scope.startDate, max: range.startDate};
}
function omittedClaimDate(value, dataset) {
  if (legalDate(value)) return value;
  const parts = /^(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})日$/.exec(value);
  if (!parts) return null;
  const scope = dataset?.queryMeta?.effectiveScope;
  const year = parts[1] || (legalDate(scope?.startDate) && legalDate(scope?.endDate)
    && scope.startDate.slice(0, 4) === scope.endDate.slice(0, 4) ? scope.startDate.slice(0, 4) : null);
  if (!year) return null;
  const date = `${year}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;
  return legalDate(date) ? date : null;
}
function uncertainOmittedDateClaim(text, index) {
  // Only the date predicate's own clause can qualify it. An unrelated
  // "cannot determine the total, but ..." never authorizes a date bound.
  const prefix = text.slice(0, index).split(/[，,。；;：:\n]|但是|但|然而|\b(?:but|however)\b/i).at(-1).trim();
  if (/(?:是否|可能|或许|也许|不一定|未确认|尚未确认|无法确认|无法确定|不能确认|不能确定)\s*$/.test(prefix)
    || /\b(?:whether|may be|might be|could be)\s*$/i.test(prefix)) return true;
  return /^(?:无法|不能|尚无法|尚不能|未能)(?:确认|确定|判断|证明|断定|说)(?:这些|那些)?(?:未(?:返回|展示|显示|读取|包含)的?|剩余|余下|其余|剩下)(?:全部|所有)?(?:的)?(?:记录|明细|数据|行)(?:都|均)?\s*$/.test(prefix)
    || /^(?:cannot|can't|unable to)\s+(?:confirm|determine|prove|say)\s+(?:that\s+)?(?:the\s+)?(?:omitted|unshown|remaining)\s+(?:records|rows)(?:\s+are)?\s*$/i.test(prefix);
}
function validOmittedDateClaims(text, datasets) {
  if (!/(?:未(?:返回|展示|显示|读取|包含)|剩余|余下|其余|剩下|另有\s*\d+\s*(?:条|笔|行)\s*更早|\b(?:omitted|unshown|remaining)\b|not\s+(?:shown|returned|displayed))/i.test(text)) return true;
  const claims = [], datePattern = '(?:20\\d{2}-\\d{2}-\\d{2}|20\\d{2}年\\s*\\d{1,2}月\\s*\\d{1,2}日|\\d{1,2}月\\s*\\d{1,2}日)';
  const prefixes = new RegExp('(?:不晚于|不迟于|不早于|并非早于|不是早于|并非晚于|不是晚于|早于|晚于|(?:on\\s+or\\s+(?:before|after)|no\\s+(?:later|earlier)\\s+than|not\\s+(?:before|after|earlier\\s+than|later\\s+than)|earlier\\s+than|later\\s+than|before|after))\\s*(' + datePattern + ')', 'gi');
  for (const match of text.matchAll(prefixes)) claims.push({value: match[1], index: match.index,
    op: /不早于|并非早于|不是早于|on\s+or\s+after|no\s+earlier\s+than|not\s+(?:before|earlier\s+than)/i.test(match[0]) ? 'ge'
      : /不晚于|不迟于|并非晚于|不是晚于|on\s+or\s+before|no\s+later\s+than|not\s+(?:after|later\s+than)/i.test(match[0]) ? 'le'
        : /晚于|after|later\s+than/i.test(match[0]) ? 'gt' : 'lt'});
  for (const match of text.matchAll(new RegExp('(' + datePattern + ')\\s*(?:之)?(前|后)', 'g')))
    claims.push({value: match[1], index: match.index, op: /(?:不在|并非在|不是在|并非|不是)\s*$/.test(text.slice(0, match.index))
      ? match[2] === '前' ? 'ge' : 'le' : match[2] === '前' ? 'lt' : 'gt'});
  if (!claims.length) return true;
  const sources = relevantSources(text, datasets), source = sources.length === 1 ? sources[0] : null;
  const proof = source ? omittedDateBounds(source) : null;
  return claims.every(claim => {
    if (uncertainOmittedDateClaim(text, claim.index)) return true;
    if (/\b(?:not|never|isn't|aren't|wasn't|weren't)\s*$|(?:不|并非|不是)\s*$/i.test(text.slice(0, claim.index))) return false;
    const date = omittedClaimDate(claim.value, source);
    return date && proof && (claim.op === 'le' ? proof.max <= date : claim.op === 'lt' ? proof.max < date : claim.op === 'ge' ? proof.min >= date : proof.min > date);
  });
}
function validWindowClaims(sentence,datasets=[]){
  const text=String(sentence||'');if(!validCountRankClaims(text,datasets)||!validOmittedDateClaims(text,datasets)||sourceCurrencyIssues(text,datasets).length)return false;if(OMITTED_TIE_GUIDANCE.test(text))return true;if(!UNIVERSAL.test(text)&&!EXTREME.test(text))return true;
  let local=false;
  const clauses=text.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g,value=>value.replaceAll(',','\uE000'))
    .split(/[，,]/).map(value=>value.replaceAll('\uE000',','));
  for(const [index,clause]of clauses.entries()){
    if(LOCAL.test(clause))local=true;
    for(const reset of clause.matchAll(new RegExp(GLOBAL_RESET.source,'gi'))){
      const before=clause.slice(0,reset.index),scopes=[...before.matchAll(new RegExp(LOCAL.source,'gi'))],scope=scopes.at(-1);
      // "当前展示的所有卡" is scoped; "展示10张但所有卡" switches
      // back to the complete population within the same comma clause.
      const qualified=scope&&/^\s*(?:的|中(?:的)?|范围内(?:的)?)?\s*$/.test(before.slice(scope.index+scope[0].length));
      if(!qualified)local=false;
    }
    if(!UNIVERSAL.test(clause)&&!EXTREME.test(clause))continue;
    const firstClaim=Math.min(...[UNIVERSAL,EXTREME].map(pattern=>clause.search(pattern)).filter(index=>index>=0));
    // Epistemic negation must precede the claim; "所有卡均未确认币种"
    // is itself a population-wide attribute assertion, not a disclaimer.
    if(UNCERTAIN.test(clause.slice(0,firstClaim)))continue;
    const relevant=relevantSources(text,datasets);
    if(!relevant.length&&ATTRIBUTE_FIELDS.some(([pattern])=>pattern.test(text)))return false;
    const partial=relevant.filter(d=>d.queryMeta?.rowsComplete===false||d.truncated===true);
    if(!partial.length||local)continue;
    // A complete clause about missing rows is coverage guidance, not an all-row property assertion.
    if(/^(?:本次|当前|本轮)?(?:查询|结果)?(?:并未|没有|未)(?:返回|展示|显示|读取)(?:全部|所有)(?:的)?(?:记录|明细|数据|结果|卡片|卡)[。；;]?\s*$/.test(clause.trim()))continue;
    const comparisonScope=clause.replace(/(?:在|于)?(?:所有|全部|全体)(?:的)?(?:支出|收入)?(?:分类|类别|交易|流水|记录|卡片|卡)(?:中|里|之中|范围内)|among\s+all\s+(?:categories|transactions|records|cards)/gi,'');
    const scopedRank=comparisonScope!==clause&&!UNIVERSAL.test(comparisonScope)&&EXTREME.test(text);
    if(UNIVERSAL.test(clause)&&!partial.every(d=>verifiedAggregate(clause,d)||publishedDateBound(clause,d)||(scopedRank&&verifiedRank(text,d))))return false;
    const continuation=clauses[index+1]&&/^\s*(?:为|是|金额|收入|支出|消费|CNY|USD|EUR|人民币|[¥￥])\s*[-+]?\d/.test(clauses[index+1])?clauses[index+1]:'';
    const rankClaim=clause+(continuation?'，'+continuation:'');
    if(EXTREME.test(clause)&&!partial.every(d=>verifiedRank(rankClaim,d)||publishedDateBound(clause,d)))return false;
  }
  return true;
}
module.exports={validWindowClaims};

