const {evaluateTransactionRisk,summarizeAmountBaseline}=require('../../src/modules/ai/service/transactionRisk');
const now=new Date('2026-11-06T08:00:00Z');
const fields={amount:'100',direction:0,currency:'CNY',categoryId:'traffic'};
const funds={status:'pass',reasonCodes:[],currency:'CNY',availableAmount:'500',coverage:'complete',source:'authoritative-application-ledger',asOf:now.toISOString(),expiresAt:'2026-11-06T08:00:30Z'};
const check=(fieldOverrides={},options={})=>evaluateTransactionRisk({...fields,...fieldOverrides},{funds,...options,now});

test('insufficient funds blocks independently from all soft amount thresholds',()=>{
  const result=check({amount:'1000'});
  expect(result).toMatchObject({status:'block',shortfall:'500.00',availableAmount:'500',remainingAmount:'-500.00',requiresAcknowledgement:false});
  expect(result.reasonCodes).toEqual(['INSUFFICIENT_FUNDS']);
});
test('funds exactly equal preserves exact zero without epsilon or tail noise',()=>{
  const result=check({amount:'39.91'},{funds:{...funds,availableAmount:'39.91'}});
  expect(result.status).toBe('warn');expect(result.remainingAmount).toBe('0.00');expect(result.shortfall).toBeNull();
});
test('one-cent shortfall is never silently rounded away',()=>{
  expect(check({amount:'1000'},{funds:{...funds,availableAmount:'999.99'}})).toMatchObject({status:'block',shortfall:'0.01'});
});
test('credit availability retains four legitimate places while ordinary requested amount stays cents',()=>{
  expect(check({amount:'1000'},{funds:{...funds,accountType:'credit',availableAmount:'1000.0001',remainingAmount:'0.0001'}}))
    .toMatchObject({status:'warn',requestedAmount:'1000.00',availableAmount:'1000.0001',remainingAmount:'0.0001'});
  expect(check({amount:'1000'},{funds:{...funds,accountType:'credit',availableAmount:'999.9999'}}))
    .toMatchObject({status:'block',requestedAmount:'1000.00',availableAmount:'999.9999',shortfall:'0.0001',remainingAmount:'-0.0001'});
  expect(check({amount:'1000.0001'},{funds:{...funds,availableAmount:'2000'}})).toMatchObject({status:'block',reasonCodes:['AI_AMOUNT_INVALID']});
});
test('authoritative blocked funds DTO preserves exact shortage without epsilon or rounding',()=>{
  expect(check({amount:'1000'},{funds:{...funds,status:'block',availableAmount:'999.9999',shortfall:'0.0001',remainingAmount:'-0.0001',reasonCodes:['INSUFFICIENT_FUNDS']}}))
    .toMatchObject({status:'block',availableAmount:'999.9999',shortfall:'0.0001',remainingAmount:'-0.0001'});
});
test.each(['0.01','0.99'])('small legal amount %s is fully retained',amount=>{
  const result=check({amount});expect(result.status).toBe('pass');expect(result.reasonCodes).toContain('SMALL_AMOUNT');
  expect(result.requiresAcknowledgement).toBe(false);expect(result.requestedAmount).toBe(Number(amount).toFixed(2));
});
test.each(['39.9099','0','0.001','-1','1e3','NaN','Infinity','10000000000'])('bad ordinary amount %s is blocked',amount=>{
  expect(check({amount})).toMatchObject({status:'block',reasonCodes:['AI_AMOUNT_INVALID']});
});
test.each([
  {status:'needs_input',reasonCodes:['SOURCE_MISSING']},{status:'block',reasons:[{code:'BAD_LEDGER_ROW',message:'账本源异常'}]},
  {...funds,currency:'USD'},{...funds,availableAmount:null},{...funds,availableAmount:'broken'},{...funds,coverage:'truncated'},
  {...funds,expiresAt:now.toISOString()},
])('source missing/dirty/expired does not become zero or pass: %p',invalid=>{
  const result=check({}, {funds:invalid});expect(['needs_input','block']).toContain(result.status);expect(result.availableAmount).toBeNull();
});
test('confirmed income does not require preexisting money or invent a zero balance',()=>{
  expect(check({direction:1},{funds:{...funds,availableAmount:null}})).toMatchObject({status:'pass',availableAmount:null,remainingAmount:null});
  expect(check({direction:1},{funds:{status:'block',reasonCodes:['ACCOUNT_INVALID']}}).status).toBe('block');
});
test('large and high amount warnings are not hard caps',()=>{
  const plenty={...funds,availableAmount:'100000'};
  expect(check({amount:'999.99'},{funds:plenty}).status).toBe('pass');
  expect(check({amount:'1000'},{funds:plenty})).toMatchObject({status:'warn',requiresAmountConfirmation:false,reasonCodes:['LARGE_AMOUNT']});
  expect(check({amount:'10000'},{funds:plenty})).toMatchObject({status:'warn',requiresAmountConfirmation:true,reasonCodes:['HIGH_AMOUNT']});
  expect(check({amount:'10000'},{funds:plenty}).requestedAmount).toBe('10000.00');
});
test('high balance use is precise and distinct from a bank authorization claim',()=>{
  expect(check({amount:'249.99'}).status).toBe('pass');
  expect(check({amount:'250'}).reasonCodes).toContain('HIGH_BALANCE_USAGE');
  expect(check({direction:1,amount:'250'}).reasonCodes).not.toContain('HIGH_BALANCE_USAGE');
});
test('similar payments and historical records require review but are not automatically rejected',()=>{
  const result=check({}, {funds:{...funds,isHistorical:true},duplicates:[{id:'one'},{id:'two'}]});
  expect(result.status).toBe('warn');expect(result.reasonCodes).toEqual(['HISTORICAL_RECORD','POSSIBLE_DUPLICATE']);
  expect(result.duplicateCount).toBe(2);expect(result.requestedAmount).toBe('100.00');
});
test('unavailable duplicate query is explicitly unknown and requires review, not an empty success',()=>{
  const result=check({}, {duplicates:[],duplicateCheckUnavailable:true});
  expect(result).toMatchObject({status:'warn',duplicateCoverage:'unknown',riskCoverage:'incomplete',requiresAcknowledgement:true});
  expect(result.reasonCodes).toContain('DUPLICATE_CHECK_UNAVAILABLE');
  expect(check({}, {duplicates:[]}).status).toBe('pass');
});
test('insufficient statistical samples are informational and do not imply a valid normality judgment',()=>{
  const result=check({}, {baseline:{available:false,reasonCode:'BASELINE_TOO_SMALL'}});
  expect(result.status).toBe('pass');expect(result.baselineUnavailable).toBe(true);
  expect(result.reasons).toContainEqual(expect.objectContaining({code:'BASELINE_UNAVAILABLE',severity:'info'}));
});
test('policy changes produce a different server-derived digest',()=>{
  expect(check().policyDigest).not.toBe(check({}, {policy:{largeAmount:'2000'}}).policyDigest);
  expect(check({}, {policy:{largeAmount:'bogus'}}).status).toBe('block');
});
const rows=count=>Array.from({length:count},(_,i)=>({amount:(10+(i%5)).toFixed(2),currency:'CNY',direction:0,categoryId:'traffic',transDate:'2026-11-05'}));
const baselineOptions={now,currency:'CNY',direction:0,categoryId:'traffic'};
test('sample and window thresholds prevent unfounded anomaly claims',()=>{
  expect(summarizeAmountBaseline(rows(29),baselineOptions)).toMatchObject({available:false,reasonCode:'BASELINE_TOO_SMALL'});
  expect(summarizeAmountBaseline(rows(30),baselineOptions)).toMatchObject({available:true,sampleCount:30,median:'12.0000',mad:'1.0000',threshold:'18.0000'});
  expect(summarizeAmountBaseline(rows(30),{...baselineOptions,truncated:true}).available).toBe(false);
  expect(summarizeAmountBaseline(rows(30),{...baselineOptions,minimumSamples:1}).available).toBe(false);
  expect(summarizeAmountBaseline(rows(30),{...baselineOptions,categoryId:null}).available).toBe(false);
  expect(summarizeAmountBaseline(rows(30).map(row=>({...row,transDate:'2026-01-01'})),baselineOptions).available).toBe(false);
});
test('dirty or unknowable sample cannot be passed off as a valid baseline',()=>{
  for(const row of [{amount:'39.9099'},{currency:null},{direction:2},{transDate:'2026-02-30'},{transDate:'2026-11-07'}])
    expect(summarizeAmountBaseline([...rows(30),{...rows(1)[0],...row}],baselineOptions).available).toBe(false);
});
test('zero robust scale skips statistical classification while fixed warnings stay active',()=>{
  const baseline=summarizeAmountBaseline(rows(30).map(row=>({...row,amount:'10.00'})),baselineOptions);
  expect(baseline).toMatchObject({available:true,mad:'0.0000',threshold:null});
  expect(check({amount:'100'},{baseline}).reasonCodes).not.toContain('UNUSUAL_AMOUNT');
  expect(check({amount:'1000'},{baseline,funds:{...funds,availableAmount:'10000'}}).reasonCodes).toContain('LARGE_AMOUNT');
});
test('statistical outlier is a local warning and never an amount correction',()=>{
  const baseline=summarizeAmountBaseline(rows(30),baselineOptions);
  const result=check({amount:'100'},{baseline});
  expect(result.reasonCodes).toContain('UNUSUAL_AMOUNT');expect(result.status).toBe('warn');expect(result.requestedAmount).toBe('100.00');
  expect(check({amount:'100',currency:'CNY',categoryId:'food'},{baseline}).reasonCodes).not.toContain('UNUSUAL_AMOUNT');
});
test('even samples preserve half-cent robust summaries without financial rounding',()=>{
  const baseline=summarizeAmountBaseline(Array.from({length:30},(_,i)=>({...rows(1)[0],amount:i<15?'10.00':'10.01'})),baselineOptions);
  expect(baseline.median).toBe('10.0050');expect(baseline.mad).toBe('0.0050');
});
