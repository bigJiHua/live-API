const crypto = require('crypto');
const { accountPaymentConflict } = require('./accountPayment');

const POLICY_VERSION = 'financial-preflight-v1';
const MAX_SOURCE_ROWS = 5000;
const MAX_CREDIT_CARDS = 100;
const TTL_MS = 30000;
const MAX_READ_MS = 15000;
const dateIsValid = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const todayShanghai = value => new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Strict parsing must precede arithmetic. Missing/invalid values never become zero.
function decimalUnits(value, scale=2, { positive=false, nonNegative=false, maxInteger=10 }={}) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const raw = String(value), match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || match[2].length > maxInteger) return null;
  const fraction = (match[3] || '').replace(/0+$/,'');
  if (fraction.length > scale) return null;
  let units = BigInt(match[2])*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0') || '0');
  if (match[1]) units = -units;
  if (positive && units<=0n || nonNegative && units<0n) return null;
  return units;
}
function moneyString(units, scale=2) {
  if (typeof units !== 'bigint') return null;
  const text=(units<0n ? -units:units).toString().padStart(scale+1,'0');
  return `${units<0n?'-':''}${text.slice(0,-scale)}.${text.slice(-scale)}`;
}
function normalizeFields(fields, now) {
  const amount = decimalUnits(fields.amount,2,{positive:true});
  return { accountId: fields.accountId || null, direction: fields.direction, amount: amount===null ? null:moneyString(amount),
    currency: fields.currency || null, transDate: fields.transDate || null,
    categoryId: fields.categoryId || null, payMethod: fields.payMethod || null, remark: fields.remark || '' };
}
function makeResult(userId, fields, now) {
  const normalized = normalizeFields(fields,now);
  return { status:'pass',reasonCodes:[],reasons:[],requestedAmount:normalized.amount,currency:normalized.currency,
    availableAmount:null,shortfall:null,remainingAmount:null,source:'authoritative-application-ledger',
    asOf:new Date(now).toISOString(),expiresAt:new Date(new Date(now).getTime()+TTL_MS).toISOString(),
    policyVersion:POLICY_VERSION,coverage:'unknown',bankBalanceVerified:false,
    fieldsDigest:digest([userId,normalized]),sourceDigest:null,accountType:null,
    isHistorical:dateIsValid(fields.transDate) && fields.transDate<todayShanghai(now),ledgerCount:0 };
}
function stop(result,code,message,status='block') {
  result.status=status;result.reasonCodes.push(code);result.reasons.push({code,message});return result;
}
async function rows(executor,sql,params) {
  if (!executor || typeof executor.execute !== 'function') throw new Error('READ_EXECUTOR_REQUIRED');
  if (!/^\s*SELECT\b/i.test(sql) || /\b(?:INSERT|UPDATE|DELETE|REPLACE|CALL)\b/i.test(sql)) throw new Error('READ_ONLY_REQUIRED');
  const [data]=await executor.execute({sql,timeout:5000},params);
  if (!Array.isArray(data)) throw new Error('READ_RESULT_INVALID');
  return data;
}
const cardSelect=`SELECT id,card_type,currency,status,share_pool_id,credit_limit,temp_limit,bill_day,repay_day,update_time
  FROM card_base WHERE user_id = ? AND id = ? AND is_deleted = 0 LIMIT 1`;
const ledgerSelect=`SELECT id,card_id,currency,direction,amount,exchange_rate,trans_date,category_id,reversed_id,create_time,update_time
  FROM account WHERE user_id = ? AND card_id = ? AND is_deleted = 0 AND reversed_id IS NULL ORDER BY id LIMIT ${MAX_SOURCE_ROWS+1}`;
function validateLedgerRows(data,{credit=false,today}) {
  if (data.length>MAX_SOURCE_ROWS) return ['SOURCE_TOO_LARGE','账户数据超过本次安全核验容量，请在原账本核查'];
  for (const row of data) {
    if (![0,1].includes(row.direction)) return ['SOURCE_INVALID_DIRECTION','账户存在收支方向异常，无法可靠核验'];
    if (!dateIsValid(row.trans_date) || row.trans_date>today)
      return ['SOURCE_INVALID_DATE','账户存在交易日期异常，无法可靠核验'];
    if (typeof row.currency!=='string' || !/^[A-Z]{3}$/.test(row.currency)) return ['SOURCE_CURRENCY_MISSING','账户存在币种缺失，无法可靠核验'];
    if (decimalUnits(row.amount,row.currency==='CNY'?2:4,{positive:true})===null) return ['SOURCE_INVALID_AMOUNT','账户存在金额或精度异常，无法可靠核验'];
    if (row.currency!=='CNY') {
      if (!credit) return ['SOURCE_CURRENCY_MISMATCH','此账户含外币估值，不能把它当作本次人民币可用资金'];
      if (decimalUnits(row.exchange_rate,4,{positive:true})===null) return ['SOURCE_RATE_MISSING','账户存在汇率缺失或异常，无法可靠核验'];
    }
  }
  return null;
}
function cardEvidence(card) { return [card.id,card.card_type,card.currency,card.status,card.share_pool_id,
  card.credit_limit,card.temp_limit,card.bill_day,card.repay_day,card.update_time]; }

async function creditAvailable(executor,userId,card,result,options) {
  const cards=await rows(executor,`SELECT id,card_type,currency,status,share_pool_id,credit_limit,temp_limit,bill_day,repay_day,update_time
    FROM card_base WHERE user_id = ? AND card_type = 'credit' AND is_deleted = 0 ORDER BY id LIMIT ${MAX_CREDIT_CARDS+1}`,[userId]);
  if (!cards.length || cards.length>MAX_CREDIT_CARDS) return stop(result,'CREDIT_SOURCE_TOO_LARGE','信用账户范围不完整，无法可靠核验');
  if (!cards.some(item=>item.id===card.id)) return stop(result,'CREDIT_GROUP_MISSING','信用账户分组缺失，无法可靠核验');
  const source=[cards.map(cardEvidence)];
  let sourceRowCount=0;
  const pools=new Set();
  for (const member of cards) {
    if (member.currency!=='CNY' || decimalUnits(member.credit_limit,2,{nonNegative:true})===null ||
      decimalUnits(member.temp_limit,2,{nonNegative:true})===null || !Number.isInteger(Number(member.bill_day)) ||
      Number(member.bill_day)<1 || Number(member.bill_day)>31 || !Number.isInteger(Number(member.repay_day)) ||
      Number(member.repay_day)<1 || Number(member.repay_day)>31)
      return stop(result,'CREDIT_CONFIG_INVALID','信用账户额度、币种或账期配置异常，无法可靠核验');
    if (member.share_pool_id && !pools.has(member.share_pool_id)) {
      const poolRows=await rows(executor,`SELECT id,currency,total_credit_limit,total_temp_limit,update_time
        FROM card_credit_pool WHERE user_id = ? AND id = ? AND is_deleted = 0 LIMIT 1`,[userId,member.share_pool_id]);
      const pool=poolRows[0];
      if (!pool || pool.currency!=='CNY' || decimalUnits(pool.total_credit_limit,2,{nonNegative:true})===null ||
        decimalUnits(pool.total_temp_limit,2,{nonNegative:true})===null)
        return stop(result,'CREDIT_POOL_MISSING','共享额度池缺失或异常，不能使用静态额度代替');
      pools.add(member.share_pool_id);source.push(pool);
    }
    const ledger=await rows(executor,ledgerSelect,[userId,member.id]);
    sourceRowCount+=ledger.length;
    if (sourceRowCount>MAX_SOURCE_ROWS) return stop(result,'SOURCE_TOO_LARGE','信用账户合计数据超过本次安全核验容量，请在原账本核查');
    const invalid=validateLedgerRows(ledger,{credit:true,today:todayShanghai(options.now)});
    if (invalid) return stop(result,...invalid);
      const registers=await rows(executor,`SELECT id,account_id,currency,foreign_amount,registered_rate,registered_rmb,actual_rate,actual_rmb,status,update_time
      FROM card_foreign_register WHERE user_id = ? AND card_id = ? AND is_deleted = 0 ORDER BY id LIMIT ${MAX_SOURCE_ROWS+1}`,[userId,member.id]);
    if (registers.length>MAX_SOURCE_ROWS) return stop(result,'SOURCE_TOO_LARGE','外币登记超过核验容量');
    sourceRowCount+=registers.length;
    if (sourceRowCount>MAX_SOURCE_ROWS) return stop(result,'SOURCE_TOO_LARGE','信用账户来源合计超过核验容量');
    const registeredAccounts=new Set();
    for (const reg of registers) {
      const original=ledger.find(item=>item.id===reg.account_id);
      if (!['pending','reconciled'].includes(reg.status) || typeof reg.currency!=='string' || reg.currency==='CNY' ||
        !original || original.direction!==0 || original.currency!==reg.currency || registeredAccounts.has(reg.account_id) ||
        decimalUnits(original.amount,4,{positive:true})!==decimalUnits(reg.foreign_amount,4,{positive:true}) ||
        decimalUnits(reg.foreign_amount,4,{positive:true})===null || decimalUnits(reg.registered_rate,4,{positive:true})===null ||
        decimalUnits(reg.registered_rmb,4,{positive:true})===null ||
        reg.status==='reconciled' && (decimalUnits(reg.actual_rate,4,{positive:true})===null || decimalUnits(reg.actual_rmb,4,{positive:true})===null))
        return stop(result,'FOREIGN_SOURCE_INVALID','外币登记数据不完整，无法可靠核验额度');
      registeredAccounts.add(reg.account_id);
    }
    if (ledger.some(item=>item.direction===0 && item.currency!=='CNY' && !registeredAccounts.has(item.id)))
      return stop(result,'FOREIGN_SOURCE_MISSING','外币消费登记缺失，不以回退汇率放行');
    const repayments=await rows(executor,`SELECT r.id,r.repay_amount,r.account_id,r.bill_month,r.update_time,a.id AS source_id,a.user_id AS source_owner,a.is_deleted AS source_deleted
      FROM card_repay r LEFT JOIN account a ON r.account_id = a.id
      WHERE r.user_id = ? AND r.card_id = ? AND r.is_deleted = 0 ORDER BY r.id LIMIT ${MAX_SOURCE_ROWS+1}`,[userId,member.id]);
    if (repayments.length>MAX_SOURCE_ROWS || repayments.some(item=>decimalUnits(item.repay_amount,2,{positive:true})===null ||
      item.account_id && (!item.source_id || item.source_owner!==userId)))
      return stop(result,'REPAYMENT_SOURCE_INVALID','信用账户还款来源异常，无法可靠核验额度');
    sourceRowCount+=repayments.length;
    if (sourceRowCount>MAX_SOURCE_ROWS) return stop(result,'SOURCE_TOO_LARGE','信用账户来源合计超过核验容量');
    source.push(ledger,registers,repayments);
    result.ledgerCount+=ledger.length;
  }
  // CreditCore remains the sole credit formula owner; the supplied executor is
  // explicitly read-only, avoiding Card.findAll's default initialization branch.
  const guarded={execute:(sql,params)=>rowsResult(executor,sql,params)};
  const aggregate=options.creditAggregate || ((owner,conn)=>require('../../modules/card/core/CreditCore').aggregate(owner,conn));
  const data=await aggregate(userId,guarded), groups=Array.isArray(data)?data:data?.cards;
  const matches=(groups || []).filter(group=>group.shared===false && group.cardId===card.id ||
    group.shared===true && Array.isArray(group.cards) && group.cards.some(item=>item.cardId===card.id));
  if (matches.length!==1) return stop(result,'CREDIT_GROUP_MISSING','信用聚合未唯一命中，不使用静态额度兜底');
  const group=matches[0], available=decimalUnits(group.avail,4);
  if (available===null || card.share_pool_id && (!group.shared || group.poolId!==card.share_pool_id) ||
    !card.share_pool_id && group.shared) return stop(result,'CREDIT_AGGREGATE_INVALID','信用可用额度来源异常');
  result.source='authoritative-credit-core';result.sourceDigest=digest([POLICY_VERSION,source,group]);result.coverage='complete';
  return {available,scale:4};
}
async function rowsResult(executor,input,params) {
  const sql=typeof input==='string'?input:input?.sql;
  return [await rows(executor,sql,params)];
}

async function preflightTransaction(executor,userId,fields={},options={}) {
  const now=options.now || new Date();
  const result=makeResult(userId,fields,now);
  if (typeof userId!=='string' || !userId || userId.length>64) return stop(result,'IDENTITY_INVALID','当前身份无效');
  if (typeof fields.accountId!=='string' || !fields.accountId || fields.accountId.length>64)
    return stop(result,'ACCOUNT_REQUIRED','请选择本人账户','needs_input');
  if (![0,1].includes(fields.direction)) return stop(result,'DIRECTION_REQUIRED','请明确收入或支出','needs_input');
  if (fields.amount==null || fields.amount==='') return stop(result,'AMOUNT_REQUIRED','请填写明确金额','needs_input');
  const requested=decimalUnits(fields.amount,2,{positive:true});
  if (requested===null) return stop(result,'AMOUNT_INVALID','普通人民币金额须大于0且最多到分');
  if (fields.currency==null || fields.currency==='') return stop(result,'CURRENCY_REQUIRED','请明确币种','needs_input');
  if (fields.currency!=='CNY') return stop(result,'CURRENCY_UNSUPPORTED','AI普通记账仅支持人民币，不自动换汇');
  if (!dateIsValid(fields.transDate)) return stop(result,'DATE_REQUIRED','请填写有效交易日期','needs_input');
  if (fields.transDate>todayShanghai(now)) return stop(result,'FUTURE_TRANSACTION','未来消费不能登记为已发生交易');
  const duration=Number.isInteger(options.timeoutMs)&&options.timeoutMs>0 ? Math.min(options.timeoutMs,MAX_READ_MS) : MAX_READ_MS;
  const deadline=Date.now()+duration,originalExecutor=executor;
  executor={execute:async(input,params)=>{
    const remaining=deadline-Date.now();
    if(remaining<=0) throw Object.assign(new Error('FINANCIAL_READ_TIMEOUT'),{code:'FINANCIAL_READ_TIMEOUT'});
    if(!originalExecutor||typeof originalExecutor.execute!=='function') throw new Error('READ_EXECUTOR_REQUIRED');
    const query=typeof input==='string'?{sql:input}:{...input};
    query.timeout=Math.min(remaining,5000);
    const data=await originalExecutor.execute(query,params);
    if(Date.now()>=deadline) throw Object.assign(new Error('FINANCIAL_READ_TIMEOUT'),{code:'FINANCIAL_READ_TIMEOUT'});
    return data;
  }};
  try {
    const card=(await rows(executor,cardSelect,[userId,fields.accountId]))[0];
    if (!card) return stop(result,'ACCOUNT_UNAVAILABLE','账户不存在、已删除或不属于当前用户');
    result.accountType=card.card_type;
    if (!['debit','credit','virtual_cash','virtual_balance'].includes(card.card_type) || card.status!=='正常')
      return stop(result,'ACCOUNT_INACTIVE','账户类型或状态不允许普通记账');
    if (card.currency!=='CNY') return stop(result,'ACCOUNT_CURRENCY_MISMATCH','账户币种不支持本次人民币资金核验');
    if (accountPaymentConflict(card.card_type, fields.payMethod))
      return stop(result,'ACCOUNT_PAYMENT_CONFLICT','支付方式与资金账户不一致，请核对实际扣款账户');
    if (card.card_type==='credit' && fields.direction===1) return stop(result,'CREDIT_INCOME_FORBIDDEN','信用卡不能登记普通收入');
    let available,scale=2;
    if (card.card_type==='credit') {
      const checked=await creditAvailable(executor,userId,card,result,{...options,now});
      if (checked.status) return checked;
      ({available,scale}=checked);
    } else {
      const ledger=await rows(executor,ledgerSelect,[userId,fields.accountId]);
      const invalid=validateLedgerRows(ledger,{today:todayShanghai(now)});
      if (invalid) return stop(result,...invalid);
      result.ledgerCount=ledger.length;result.sourceDigest=digest([POLICY_VERSION,cardEvidence(card),ledger]);result.coverage='complete';
      available=ledger.reduce((sum,row)=>sum+(row.direction===1?1n:-1n)*decimalUnits(row.amount,2,{positive:true}),0n);
      if (!ledger.length && fields.direction===0) return stop(result,'FUNDS_NOT_REGISTERED','账户尚无已登记资金，无法核验本笔支出','needs_input');
    }
    result.availableAmount=moneyString(available,scale);
    const requestedScaled=requested*10n**BigInt(scale-2);
    result.remainingAmount=moneyString(available+(fields.direction===1?requestedScaled:-requestedScaled),scale);
    if (fields.direction===0 && available<0n) return stop(result,'NEGATIVE_AVAILABLE_FUNDS','账户可用资金为负，请先核查原账本');
    if (fields.direction===0 && requestedScaled>available) {
      result.shortfall=moneyString(requestedScaled-available,scale);
      return stop(result,'INSUFFICIENT_FUNDS',`账本可用 ${result.availableAmount}，本笔 ${result.requestedAmount}，不足 ${result.shortfall}`);
    }
    return result;
  } catch (error) {
    if (['FINANCIAL_READ_TIMEOUT','PROTOCOL_SEQUENCE_TIMEOUT'].includes(error.code))
      return stop(result,'FUNDS_READ_TIMEOUT','本次资金核验超过安全时限，请稍后手动重查','needs_input');
    return stop(result,'FUNDS_READ_UNAVAILABLE','资金数据暂时无法可靠读取，请稍后在本地复查','needs_input');
  }
}
function isOrdinaryRecord(record) {
  return record.strictOrdinary===true && record.currency==='CNY' && !record.transfer_group_id && record.category_id!=='CATEGORY_REPAY';
}
async function validateOrdinaryRecord(record,executor,options={}) {
  if (/转账|还款|退款|冲正|分期|购汇|结汇|提现|初始化|余额调整/.test(record.pay_type || '')) {
    const checked=stop(makeResult(record.user_id,{},options.now || new Date()),'SPECIAL_TRANSACTION_FORBIDDEN','特殊账务不能通过普通收支入口绕过资金规则');
    return {valid:false,message:checked.reasons[0].message,currentBalance:null,financialCheck:checked};
  }
  const checked=await preflightTransaction(executor,record.user_id,{accountId:record.card_id,direction:record.direction,
    amount:record.amount,currency:record.currency,transDate:record.trans_date || todayShanghai(options.now || new Date()),
    categoryId:record.category_id,payMethod:record.pay_method,remark:record.remark},options);
  return {valid:['pass','warn'].includes(checked.status),message:checked.reasons[0]?.message || '验证通过',
    currentBalance:checked.availableAmount,financialCheck:checked};
}
module.exports={POLICY_VERSION,MAX_SOURCE_ROWS,TTL_MS,MAX_READ_MS,decimalUnits,moneyString,dateIsValid,todayShanghai,
  preflightTransaction,isOrdinaryRecord,validateOrdinaryRecord};
