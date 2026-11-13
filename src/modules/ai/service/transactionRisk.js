const { normalizeTransactionAmount } = require('./transactionInput');
const crypto = require('node:crypto');

const POLICY_VERSION = 'transaction-risk-v1';
const DEFAULT_POLICY = Object.freeze({ largeAmount:'1000',highAmount:'10000',minimumSamples:30,windowDays:90,maxRows:500 });
const units = (value, options = {}) => {
  const text=normalizeTransactionAmount(value,{scale:2,allowZero:true,signed:true,...options});
  if (text==null) return null;
  const negative=text.startsWith('-'),[integer,fraction='']=text.replace(/^-/,'').split('.');
  return BigInt(integer)*100n*(negative?-1n:1n)+BigInt(fraction.padEnd(2,'0'))*(negative?-1n:1n);
};
const money = value => `${value<0n?'-':''}${(value<0n?-value:value)/100n}.${String((value<0n?-value:value)%100n).padStart(2,'0')}`;
const statisticUnits = value => {
  const text=normalizeTransactionAmount(value,{scale:4,allowZero:true,signed:true});
  if (text==null) return null;
  const negative=text.startsWith('-'),[integer,fraction='']=text.replace(/^-/,'').split('.');
  return (BigInt(integer)*10000n+BigInt(fraction.padEnd(4,'0')))*(negative?-1n:1n);
};
const statisticMoney = value => `${value<0n?'-':''}${(value<0n?-value:value)/10000n}.${String((value<0n?-value:value)%10000n).padStart(4,'0')}`;
const fundsMoney = value => value%100n===0n ? money(value/100n) : statisticMoney(value);
const trustedAmount = value => statisticUnits(value)==null ? null : value;
const median = values => {
  const sorted=[...values].sort((a,b)=>a<b?-1:a>b?1:0),middle=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2n;
};

function summarizeAmountBaseline(rows, { currency='CNY',direction=0,categoryId=null,now=new Date(),truncated=false,
  minimumSamples=DEFAULT_POLICY.minimumSamples,windowDays=DEFAULT_POLICY.windowDays,maxRows=DEFAULT_POLICY.maxRows } = {}) {
  const unavailable = reasonCode => ({available:false,baselineUnavailable:true,reasonCode,sampleCount:0,currency,direction,categoryId});
  if (!Array.isArray(rows) || truncated || rows.length>maxRows) return unavailable('BASELINE_TRUNCATED');
  if (currency!=='CNY' || ![0,1].includes(direction) || categoryId==null || !Number.isInteger(minimumSamples) || minimumSamples<30 ||
    !Number.isInteger(windowDays) || windowDays<1 || windowDays>90) return unavailable('BASELINE_UNVERIFIED');
  const time=new Date(now).getTime();
  if (!Number.isFinite(time)) return unavailable('BASELINE_UNVERIFIED');
  const values=[];
  for (const row of rows) {
    if (!row) return unavailable('BASELINE_UNVERIFIED');
    if ([true,1,'1'].includes(row.isDeleted) || [true,1,'1'].includes(row.is_deleted) || row.status==='discarded' || row.status==='failed') continue;
    if (!row.currency || ![0,1].includes(row.direction)) return unavailable('BASELINE_UNVERIFIED');
    if (row.currency!==currency || row.direction!==direction || (categoryId!=null && (row.categoryId??row.category_id)!==categoryId)) continue;
    if (row.transactionKind && row.transactionKind!=='ordinary') continue;
    if (/转账|还款|冲正|退款|分期/.test(`${row.payType||row.pay_type||''} ${row.categoryName||''}`)) continue;
    const date=row.transDate||row.trans_date||row.date;
    if (typeof date!=='string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) return unavailable('BASELINE_UNVERIFIED');
    const recorded=Date.parse(date+'T00:00:00Z');
    if (!Number.isFinite(recorded) || new Date(recorded).toISOString().slice(0,10)!==date) return unavailable('BASELINE_UNVERIFIED');
    if (recorded>time) return unavailable('BASELINE_UNVERIFIED');
    if (time-recorded>windowDays*86400000) continue;
    const value=units(row.amount);
    if (value==null || value<=0n) return unavailable('BASELINE_UNVERIFIED');
    values.push(value*100n);
  }
  if (values.length<minimumSamples) return { ...unavailable('BASELINE_TOO_SMALL'),sampleCount:values.length };
  const center=median(values),mad=median(values.map(value=>value>=center?value-center:center-value));
  return {available:true,baselineUnavailable:false,sampleCount:values.length,currency,direction,categoryId,
    windowDays,method:'median-plus-six-mad',median:statisticMoney(center),mad:statisticMoney(mad),threshold:mad===0n?null:statisticMoney(center+6n*mad)};
}

function evaluateTransactionRisk(fields, {funds,duplicates=[],duplicateCheckUnavailable=false,baseline,policy={},now=new Date()}={}) {
  const rules={...DEFAULT_POLICY,...policy}, reasons=[];
  const result={status:'pass',reasonCodes:[],reasons,requiresAcknowledgement:false,requiresAmountConfirmation:false,
    policyVersion:POLICY_VERSION,policyDigest:crypto.createHash('sha256').update(JSON.stringify([rules.largeAmount,rules.highAmount,rules.minimumSamples,rules.windowDays])).digest('hex'),requestedAmount:null,currency:fields?.currency||null,availableAmount:null,shortfall:null,
    remainingAmount:null,source:funds?.source||null,asOf:funds?.asOf||null,coverage:funds?.coverage||'unknown',
    expiresAt:funds?.expiresAt||null,sourceDigest:funds?.sourceDigest||null,fieldsDigest:funds?.fieldsDigest||null,
    accountType:funds?.accountType||null,isHistorical:funds?.isHistorical===true,ledgerCount:funds?.ledgerCount??null,
    baselineUnavailable:!baseline?.available,duplicateCheckUnavailable:duplicateCheckUnavailable===true,
    duplicateCoverage:duplicateCheckUnavailable===true?'unknown':'complete',riskCoverage:duplicateCheckUnavailable===true?'incomplete':'complete'};
  const add=(code,message,severity='warn')=>reasons.push({code,message,severity});
  const end=()=>{result.reasonCodes=[...new Set(reasons.map(reason=>reason.code))];
    result.status=reasons.some(reason=>reason.severity==='block')?'block':reasons.some(reason=>reason.severity==='needs_input')?'needs_input':reasons.some(reason=>reason.severity==='warn')?'warn':'pass';
    result.requiresAcknowledgement=result.status==='warn';return result;};
  if (!fields || fields.currency!=='CNY') {add('AI_CURRENCY_UNSUPPORTED','普通记账仅支持明确人民币金额','block');return end();}
  if (![0,1].includes(fields.direction)) {add('AI_DIRECTION_INVALID','请确认收支方向','needs_input');return end();}
  const amount=units(fields.amount,{signed:false,allowZero:false});
  if (amount==null || amount<=0n) {add('AI_AMOUNT_INVALID','金额须为明确正数，人民币最多到分','block');return end();}
  result.requestedAmount=money(amount);
  // A funds adapter failure is authoritative. No amount, model confidence,
  // acknowledgement or soft threshold may turn it into a usable balance.
  if (!funds || funds.status!=='pass') {
    const severity=funds?.status==='block'?'block':'needs_input';
    if (funds?.currency==='CNY' && funds?.coverage==='complete') {
      result.availableAmount=trustedAmount(funds.availableAmount);
      result.remainingAmount=trustedAmount(funds.remainingAmount);
      result.shortfall=trustedAmount(funds.shortfall);
    }
    for (const reason of funds?.reasons||[]) add(reason.code||'FUNDS_UNVERIFIED',reason.message||'无法可靠核验账户资金',severity);
    if (!reasons.length) for (const code of funds?.reasonCodes?.length?funds.reasonCodes:['FUNDS_UNVERIFIED']) add(code,'无法可靠核验账户资金',severity);
    return end();
  }
  const time=new Date(now).getTime(),expiry=funds.expiresAt ? new Date(funds.expiresAt).getTime():null;
  if (expiry!=null && (!Number.isFinite(expiry)||expiry<=time)) {add('FUNDS_CHECK_EXPIRED','资金核验已过期，请重新核验','needs_input');return end();}
  if (funds.currency!=='CNY' || funds.coverage!=='complete') {add('FUNDS_UNVERIFIED','资金币种或来源不完整','needs_input');return end();}
  const available=statisticUnits(funds.availableAmount);
  if (available==null && fields.direction===0) {add('FUNDS_UNVERIFIED','无法可靠核验账户资金','needs_input');return end();}
  result.availableAmount=available==null?null:funds.availableAmount;
  if (fields.direction===0) {
    const remaining=available-amount*100n;
    result.remainingAmount=trustedAmount(funds.remainingAmount)??fundsMoney(remaining);
    if (amount*100n>available) {result.shortfall=trustedAmount(funds.shortfall)??fundsMoney(amount*100n-available);add('INSUFFICIENT_FUNDS','账户可用资金不足','block');return end();}
  } else result.remainingAmount=available==null?null:trustedAmount(funds.remainingAmount)??fundsMoney(available+amount*100n);
  const large=units(String(rules.largeAmount),{signed:false,allowZero:false}),high=units(String(rules.highAmount),{signed:false,allowZero:false});
  if (large==null||high==null||high<large) {add('RISK_POLICY_INVALID','风险规则配置无效','block');return end();}
  if (amount<100n) add('SMALL_AMOUNT','本笔为小额，金额会完整保留','info');
  if (amount>=high) {add('HIGH_AMOUNT','本笔金额较大，请核对完整金额');result.requiresAmountConfirmation=true;}
  else if (amount>=large) add('LARGE_AMOUNT','请核对本笔金额与资金账户');
  if (fields.direction===0 && available!=null && available>0n && amount*200n>=available) add('HIGH_BALANCE_USAGE','本笔将使用较大比例的账本可用资金');
  if (funds.isHistorical) add('HISTORICAL_RECORD','本笔为补记，资金核验基于当前账本余额');
  if (Array.isArray(duplicates)&&duplicates.length) {add('POSSIBLE_DUPLICATE','发现相似已登记流水，请确认是否为另一笔交易');result.duplicateCount=Math.min(duplicates.length,20);}
  if (duplicateCheckUnavailable===true) add('DUPLICATE_CHECK_UNAVAILABLE','暂未完成重复流水核查，请核对本笔是否已登记');
  if (baseline && !baseline.available) add('BASELINE_UNAVAILABLE','缺少可靠的同类金额基线，未作统计异常判断','info');
  if (baseline?.available && baseline.currency===fields.currency && baseline.direction===fields.direction &&
    (baseline.categoryId==null||baseline.categoryId===fields.categoryId)) {
    const threshold=statisticUnits(baseline.threshold),center=statisticUnits(baseline.median);
    // A robust scale of zero gives no statistical decision. Fixed thresholds
    // still apply. New categories / incomplete baselines never imply normality.
    if (threshold!=null && center!=null && threshold>center && amount*100n>threshold && (amount>=large || amount*100n>=center*3n))
      add('UNUSUAL_AMOUNT','本笔明显高于近期同类金额，请核对是否少写小数或多写零');
  }
  return end();
}

module.exports={POLICY_VERSION,DEFAULT_POLICY,evaluateTransactionRisk,summarizeAmountBaseline};
