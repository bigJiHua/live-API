const { parseTransactionInput, normalizeTransactionAmount,containsSpecialFinancialIntent } = require('./transactionInput');
const { evaluateTransactionRisk, summarizeAmountBaseline } = require('./transactionRisk');
const { preflightTransaction } = require('../../../common/services/financialPreflight');
const { digestInput } = require('./requestGuard');
const { todayShanghai } = require('./validation');
const { AiError } = require('./errors');

const FIELDS=['amount','direction','currency','transDate','accountId','categoryId','payMethod','remark'];
const pick = value => Object.fromEntries(FIELDS.map(key=>[key,value?.[key]??(key==='remark'?'':null)]));
const messages={AI_AMOUNT_MISSING:'请填写本笔金额',AI_ACCOUNT_MISSING:'请选择资金账户',AI_ACCOUNT_AMBIGUOUS:'账户存在多个匹配，请明确选择',
  AI_MULTIPLE_TRANSACTIONS:'这条消息包含多个金额，请逐笔核对',AI_AMOUNT_INVALID:'金额须为明确正数，人民币最多到分',AI_DIRECTION_MISSING:'请选择收支方向',
  AI_ACTION_NOT_ALLOWED:'此类特殊账务不通过AI普通记账处理'};
messages.AI_OCR_TEXT_MISMATCH='图片金额与本次文字说明不一致，请对照原图手工填写完整金额';
messages.AI_OCR_DIRECTION_MISMATCH='图片与文字的收支方向不一致，请手工选择收支方向';
messages.AI_OCR_DATE_MISMATCH='图片与文字日期不一致，请对照原图手工选择日期';
messages.ACCOUNT_PAYMENT_CONFLICT='支付方式与资金账户不一致，请核对实际扣款账户';

function createFinancialWorkflow({ repository,financialRepository,draftStore,candidateStore,now=()=>new Date(),riskPolicy={} }) {
  const clock=()=>new Date(now());
  async function facts(userId,fields,executor) {
    const unavailable={available:false,baselineUnavailable:true,reasonCode:'BASELINE_UNAVAILABLE'};
    if (!fields.accountId||!fields.amount||!fields.categoryId) return {duplicates:[],baseline:unavailable};
    const work=async select=>{
      const rows=await select(`SELECT id,amount,currency,direction,DATE_FORMAT(trans_date,'%Y-%m-%d') AS transDate,category_id AS categoryId,
        remark,pay_type AS payType FROM account WHERE user_id=? AND card_id=? AND is_deleted=0 AND reversed_id IS NULL
        AND currency=? AND direction=? AND amount=? AND trans_date BETWEEN DATE_SUB(?,INTERVAL 1 DAY) AND DATE_ADD(?,INTERVAL 1 DAY)
        AND pay_type<>'转账' AND category_id<>'CATEGORY_REPAY' ORDER BY trans_date DESC,id LIMIT 21`,
      [userId,fields.accountId,fields.currency,fields.direction,fields.amount,fields.transDate,fields.transDate]);
      const history=await select(`SELECT amount,currency,direction,DATE_FORMAT(trans_date,'%Y-%m-%d') AS transDate,category_id AS categoryId,pay_type AS payType
        FROM account WHERE user_id=? AND is_deleted=0 AND reversed_id IS NULL AND currency=? AND direction=? AND category_id=?
        AND trans_date BETWEEN DATE_SUB(?,INTERVAL 90 DAY) AND ? AND pay_type<>'转账' AND category_id<>'CATEGORY_REPAY'
        ORDER BY trans_date DESC,id LIMIT 501`,[userId,fields.currency,fields.direction,fields.categoryId,todayShanghai(clock()),todayShanghai(clock())]);
      return {duplicates:rows.slice(0,20).map(row=>({date:row.transDate,amount:String(row.amount),currency:row.currency,remark:String(row.remark||'').slice(0,100)})),
        baseline:summarizeAmountBaseline(history,{currency:fields.currency,direction:fields.direction,categoryId:fields.categoryId,now:clock(),truncated:history.length>500})};
    };
    try {
      if(executor) return await work(async(sql,params)=>(await executor.execute({sql,timeout:5000},params))[0]);
      const repo=financialRepository(); return repo.read ? await repo.read(work) : {duplicates:[],baseline:unavailable};
    } catch(_) {return {duplicates:[],baseline:unavailable,duplicateCheckUnavailable:true};}
  }
  function finalize(userId,fields,funds,risk,version=0) {
    const check={...funds,...risk,sourceDigest:funds.sourceDigest||null,expiresAt:funds.expiresAt||new Date(clock().getTime()+30000).toISOString(),
      bankBalanceVerified:false,isHistorical:!!funds.isHistorical,direction:fields.direction};
    for(const key of ['requestedAmount','availableAmount','shortfall','remainingAmount']) check[key]=funds[key]??null;
    check.fieldsDigest=digestInput({userId,fields:pick(fields)});
    check.policyVersion=`${funds.policyVersion||'financial-preflight-v1'}/${risk.policyVersion||'transaction-risk-v1'}`;
    return forReviewVersion(check,version);
  }
  function forReviewVersion(check,version) {
    return {...check,riskDigest:digestInput({fieldsDigest:check.fieldsDigest,sourceDigest:check.sourceDigest,policyVersion:check.policyVersion,
      policyDigest:check.policyDigest||null,status:check.status,reasonCodes:check.reasonCodes,amount:check.requestedAmount,
      availableAmount:check.availableAmount,version})};
  }
  async function inspect(userId,input={},options={}) {
    const choices=await repository().choices(userId);
    let parsed,fields;
    if(input.message && !input.fields) {
      parsed=parseTransactionInput(input.message,{accounts:choices.accounts,today:todayShanghai(clock())});
      if(parsed.intent!=='transaction') return {intent:'other',fields:null,financialCheck:null,choices};
      fields={...pick(parsed.fields),remark:input.message.slice(0,255)};
    } else {
      fields=pick(input.fields);
      fields.amount=normalizeTransactionAmount(fields.amount);
      const reasonCodes=[];
      if(!fields.amount) reasonCodes.push('AI_AMOUNT_INVALID');
      if(![0,1].includes(fields.direction)) reasonCodes.push('AI_DIRECTION_MISSING');
      if(!fields.accountId) reasonCodes.push('AI_ACCOUNT_MISSING');
      parsed={intent:'transaction',status:reasonCodes.length?'needs_input':'pass',reasonCodes,fields};
    }
    const candidate=options.sourceCandidate;
    if(containsSpecialFinancialIntent(fields.remark||''))
      parsed={...parsed,status:'block',reasonCodes:['AI_ACTION_NOT_ALLOWED']};
    if(candidate&&containsSpecialFinancialIntent(candidate.originalText||''))
      parsed={...parsed,status:'block',reasonCodes:['AI_CANDIDATE_SOURCE_FORBIDDEN']};
    if(options.originalText&&containsSpecialFinancialIntent(options.originalText))
      parsed={...parsed,status:'block',reasonCodes:['AI_CANDIDATE_SOURCE_FORBIDDEN']};
    if(options.originalText&&/[$€£]|\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD)\b|美元|港币|港元|欧元|日元|英镑/i.test(options.originalText))
      parsed={...parsed,status:'block',reasonCodes:['AI_CURRENCY_UNSUPPORTED']};
    if(candidate&&(candidate.eligible===false||(candidate.source==='image-ocr'&&candidate.eligible!==true))) {
      parsed={...parsed,status:'block',reasonCodes:[candidate.source==='image-ocr'?'AI_OCR_NOT_ELIGIBLE':'AI_CANDIDATE_SOURCE_FORBIDDEN']};
    }
    if(candidate?.eligible===true&&candidate?.evidence?.amountConflict&&!fields.amount)
      parsed={...parsed,status:'needs_input',reasonCodes:['AI_OCR_TEXT_MISMATCH']};
    if(candidate?.eligible===true&&candidate?.evidence?.directionConflict&&![0,1].includes(fields.direction))
      parsed={...parsed,status:'needs_input',reasonCodes:[...parsed.reasonCodes,'AI_OCR_DIRECTION_MISMATCH']};
    if(candidate?.eligible===true&&candidate?.evidence?.dateConflict&&!fields.transDate)
      parsed={...parsed,status:'needs_input',reasonCodes:[...parsed.reasonCodes,'AI_OCR_DATE_MISMATCH']};
    let funds;
    if(parsed.status!=='pass') funds={status:parsed.status,reasonCodes:parsed.reasonCodes,reasons:parsed.reasonCodes.map(code=>({code,message:messages[code]||'请核对本笔字段和来源'})),
      requestedAmount:fields.amount,currency:fields.currency,availableAmount:null,shortfall:null,remainingAmount:null,coverage:'unknown',source:'authoritative-application-ledger',
      asOf:clock().toISOString(),expiresAt:new Date(clock().getTime()+30000).toISOString(),policyVersion:'financial-preflight-v1'};
    else {
      try {funds=options.executor ? await preflightTransaction(options.executor,userId,fields,{now:clock()}) : await financialRepository().check(userId,fields);}
      catch(_) {funds={status:'needs_input',reasonCodes:['FUNDS_READ_UNAVAILABLE'],reasons:[{code:'FUNDS_READ_UNAVAILABLE',message:'暂时无法可靠核验资金，请本地复查'}],
        currency:fields.currency,requestedAmount:fields.amount,coverage:'unknown',source:'authoritative-application-ledger',asOf:clock().toISOString()};}
    }
    const extras=funds.status==='pass'?await facts(userId,fields,options.executor):{duplicates:[],baseline:{available:false}};
    const risk=parsed.status==='pass'?evaluateTransactionRisk(fields,{funds,...extras,policy:riskPolicy,now:clock()}):{
      status:funds.status,reasonCodes:funds.reasonCodes,reasons:funds.reasons.map(reason=>({...reason,severity:funds.status})),
      requiresAcknowledgement:false,requiresAmountConfirmation:false,policyVersion:'transaction-risk-v1'};
    const financialCheck=finalize(userId,fields,funds,risk,options.version||0);
    const missing=[];
    if(!choices.categories.some(row=>row.id===fields.categoryId&&row.type===(fields.direction===0?'expense':'income'))) missing.push('分类');
    if(!choices.accounts.some(row=>row.id===fields.accountId)) missing.push('账户');
    if(!['现金','余额','支付宝','微信','银行卡'].includes(fields.payMethod)) missing.push('支付方式');
    return {intent:'transaction',fields,financialCheck,choices,missingFields:missing,evidence:parsed.evidence||candidate?.evidence||null,
      duplicates:extras.duplicates,baseline:extras.baseline};
  }
  const usable=check=>check&&['pass','warn'].includes(check.status);
  function assertUsable(check) {
    if(!usable(check)) throw Object.assign(new AiError(check?.reasons?.[0]?.message||'请先完成本地财务核查',409,'AI_FINANCIAL_CHECK_BLOCKED'),{financialCheck:check});
  }
  function checkAcknowledgement(check,ack) {
    assertUsable(check);
    if(check.requiresAcknowledgement&&!ack) throw new AiError('请先核对当前风险提示',409,'AI_RISK_ACK_REQUIRED');
    if(ack&&(ack.fieldsDigest!==check.fieldsDigest||ack.policyVersion!==check.policyVersion||ack.riskDigest!==check.riskDigest))
      throw new AiError('核查结果已变化，请重新核对',409,'AI_RISK_CHANGED');
    if(check.requiresAmountConfirmation&&normalizeTransactionAmount(ack?.confirmedAmount)!==normalizeTransactionAmount(check.requestedAmount))
      throw new AiError('请手工确认本笔完整金额',409,'AI_AMOUNT_CONFIRM_REQUIRED');
  }
  async function enrich(userId,draft) {
    if(!draft||['committed','discarded'].includes(draft.status)) return draft;
    const version=draft.status==='reviewed'?draft.version-1:draft.version;
    const result=await inspect(userId,{fields:pick(draft)},{version,originalText:draft.originalText});
    const reviewed=(draft.trace||[]).find(item=>item.tool==='financial_review')?.result;
    const reviewValid=draft.status==='reviewed'&&usable(result.financialCheck)&&reviewed?.riskDigest===result.financialCheck.riskDigest;
    return {...draft,financialCheck:{...result.financialCheck,reviewValid},reviewInvalid:draft.status==='reviewed'&&!reviewValid};
  }
  async function candidate(userId,result,metadata={},executor) {
    const hardSource=['AI_ACTION_NOT_ALLOWED','AI_CURRENCY_UNSUPPORTED','CURRENCY_UNSUPPORTED','AI_OCR_NOT_ELIGIBLE','AI_CANDIDATE_SOURCE_FORBIDDEN'];
    const sourceEligible=!result.financialCheck?.reasonCodes?.some(code=>hardSource.includes(code));
    const saved=await candidateStore.save(userId,{fields:result.fields,source:metadata.source||'user-readonly',
      conversationId:metadata.conversationId||null,originalText:metadata.message||'',evidence:result.evidence||null,
      eligible:sourceEligible&&(metadata.eligible??true),sourceReasonCodes:result.financialCheck?.reasonCodes||[],
      trace:metadata.trace||[],requestId:metadata.requestId||null,sourceFingerprint:metadata.sourceFingerprint||null},executor);
    return {...saved,choices:result.choices,financialCheck:result.financialCheck,missingFields:result.missingFields||[]};
  }
  return {inspect,enrich,candidate,assertUsable,usable,checkAcknowledgement,pick,forReviewVersion};
}
module.exports={createFinancialWorkflow};
