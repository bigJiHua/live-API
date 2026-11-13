const {normalizeTransactionAmount,extractMoneyTokens,parseTransactionInput,parseTransactionInputs}=require('../../src/modules/ai/service/transactionInput');
const {assertProposalIntent,explicitAmount,validateFundEvidence}=require('../../src/modules/ai/service/businessIntent');
const options={today:'2026-11-06',accounts:[{id:'debit-000',name:'000',type:'debit'},{id:'cash',name:'现金',type:'virtual_cash'}]};

test.each([
  ['39.91','39.91'],['39.9100','39.91'],['00039.9100','39.91'],['+0.0100','0.01'],['0.01','0.01'],['9999999999.99','9999999999.99'],
])('normalization preserves exact ordinary cents %s', (value,expected)=>expect(normalizeTransactionAmount(value)).toBe(expected));
test.each(['39.9099','0.001','0','-0','-1','1e3','Infinity','NaN','1,000','10000000000','1.12345','',1,null,{},'9'.repeat(81)])(
  'invalid ordinary amount cannot turn into zero or rounded value: %p', value=>expect(normalizeTransactionAmount(value)).toBeNull());
test('fund decimal domain remains separate from ordinary positive cents',()=>{
  expect(normalizeTransactionAmount('-0.8658',{scale:4,signed:true,allowZero:true})).toBe('-0.8658');
  expect(normalizeTransactionAmount('+9.1132',{scale:4,signed:true,allowZero:true})).toBe('9.1132');
  expect(normalizeTransactionAmount('-0.0000',{scale:4,signed:true,allowZero:true})).toBe('0');
});
test.each([
  ['借记卡000支出1000元','1000'],['卡000 支出1000元','1000'],['账户000支出1千元','1000'],['账户000支出1万元','10000'],
  ['账户000支出1,000.00元','1000'],['账户000支出0.0001万元','1'],['账户000支出39.9100元','39.91'],
  ['🚗借记卡000支出39.91元','39.91'],['账户000支出1000元，余额500元','1000'],['账户000支出1000,备注停车','1000'],
])('account entity and exact unit parsing %s', (message,amount)=>{
  const result=parseTransactionInput(message,options);
  expect(result.status).toBe('pass');expect(result.fields).toMatchObject({amount,accountId:'debit-000',direction:0,currency:'CNY',transDate:'2026-11-06'});
  expect(result.evidence.amount.normalized).toBe(amount);
});
test('money evidence expands units before matching model values',()=>{
  expect(assertProposalIntent('transaction.create','借记卡000支出1000元')).toBe(true);
  expect(explicitAmount('记一笔支出1万元','1')).toBe(false);
  expect(explicitAmount('记一笔支出1万元','10000')).toBe(true);
  expect(explicitAmount('记一笔支出1千元','1000')).toBe(true);
  expect(explicitAmount('记一笔支出1,000.00元','1000')).toBe(true);
});
test.each(['账户000支出1k元','账户000支出1w','账户000支出1,00元','账户000支出1.000,50元','账户000支出1e3元','账户000支出−100元'])(
  'ambiguous amount stops rather than choosing a substring: %s', message=>expect(parseTransactionInput(message,options).status).not.toBe('pass'));
test.each(['账户000支出39.9099元','账户000支出0.001元','账户000支出0元','账户000支出-100元','账户000支出10000000000元'])(
  'invalid precision/range is blocked %s',message=>expect(parseTransactionInput(message,options).status).toBe('block'));
test('account label leading zeroes and explicit selection are preserved',()=>{
  const accounts=[{id:'a',name:'000',type:'debit'},{id:'b',name:'000',type:'debit'}];
  expect(parseTransactionInput('账户000支出100元',{...options,accounts})).toMatchObject({status:'needs_input',reasonCodes:['AI_ACCOUNT_AMBIGUOUS']});
  expect(parseTransactionInput('账户000支出100元',{...options,accounts,accountId:'b'}).fields.accountId).toBe('b');
  expect(parseTransactionInput('账户000支出100元',{...options,accountId:'someone-else'})).toMatchObject({status:'block',reasonCodes:['AI_ACCOUNT_INVALID']});
});
test('a payment method alone cannot choose its actual funding account',()=>{
  const result=parseTransactionInput('微信支付100元',options);
  expect(result.status).toBe('needs_input');expect(result.fields.accountId).toBeNull();
});
test('trusted named entities with digits are not money, unlabeled numbers still are',()=>{
  const accounts=[{id:'a',name:'生活500卡',type:'debit'}];
  expect(parseTransactionInput('生活500卡支出100元',{...options,accounts})).toMatchObject({status:'pass',fields:{amount:'100',accountId:'a'}});
  expect(assertProposalIntent('transaction.create','生活500卡支出100元',{accounts})).toBe(true);
  expect(explicitAmount('生活500卡支出100元','500',{entities:accounts})).toBe(false);
  expect(extractMoneyTokens('2026-11-06 手机号13800138000 停车10元 2个提醒 11:39')).toHaveLength(1);
  expect(extractMoneyTokens('支出10000000元 手机号13800138000')[0].amount).toBe('10000000');
});
test.each(['账户000明天支出100元','账户000支出100元，2026-11-07','账户000支出100元，2026-02-30'])(
  'future and invalid calendar dates block %s',message=>expect(parseTransactionInput(message,options).status).toBe('block'));
test('historical record keeps original date and current-ledger semantic marker',()=>{
  const result=parseTransactionInput('昨天账户000支出100元',options);
  expect(result.fields.transDate).toBe('2026-11-05');expect(result.evidence.date.historical).toBe(true);
  expect(parseTransactionInput('账户000支出100元，2026-11-04与2026-11-05',options).status).toBe('needs_input');
});
test.each(['账户000今天和昨天支出100元','账户000支出100元，2026-11-04，昨天','账户000支出100元，11月5日','账户000支出100元，11-05'])(
  'conflicting or yearless explicit transaction dates cannot default to today: %s',message=>{
    expect(parseTransactionInput(message,options)).toMatchObject({status:'needs_input',reasonCodes:['AI_DATE_AMBIGUOUS']});
  });
test('equivalent relative and complete dates keep their agreed date',()=>{
  expect(parseTransactionInput('账户000昨日支出100元，2026年11月05日',options)).toMatchObject({status:'pass',fields:{transDate:'2026-11-05'}});
  expect(parseTransactionInput('账户000今日支出100元',options)).toMatchObject({status:'pass',fields:{transDate:'2026-11-06'}});
});
test.each(['账户000支出大概1000元','账户000支出约1000元','账户000支出1000元左右','账户000支出差不多1000元'])(
  'an approximate value is never evidence of an exact financial amount: %s',message=>{
    expect(parseTransactionInput(message,options)).toMatchObject({status:'needs_input',reasonCodes:['AI_AMOUNT_AMBIGUOUS']});
  });
test.each(['账户000支出1百元','账户000支出1亿元','账户000支出1千万元','账户000支出100角','账户000支出100分',
  '账户000支出- ￥100','账户000支出负100元','账户000支出100余元','账户000支出100多元'])(
  'unsupported unit, separated negative or approximate suffix cannot lose its meaning: %s',message=>{
    expect(parseTransactionInput(message,options)).toMatchObject({status:'needs_input',reasonCodes:['AI_AMOUNT_AMBIGUOUS']});
    expect(explicitAmount(message,'100')).toBe(false);
  });
test('remarks containing 上下班 are separate from an explicitly exact money token',()=>{
  expect(parseTransactionInput('账户000支出100元，备注上下班交通',options)).toMatchObject({status:'pass',fields:{amount:'100'}});
});
test.each(['账户000还款100元','账户000退款100元','账户000转账100元','账户000借款100元','账户000美元支出100元',
  '记账账户000贷款 loan 支出100元','记账账户000 borrowing 支出100元','记账账户000 investment 支出100元','记账账户000 depreciation 支出100元'])(
  'special money cannot become ordinary finance %s',message=>expect(parseTransactionInput(message,options).status).toBe('block'));
test('query and mixed direction are not silently transformed into a transaction',()=>{
  expect(parseTransactionInput('查询账户000支出100元',options).intent).toBe('other');
  expect(parseTransactionInput('账户000收入100元支出200元',options).reasonCodes).toContain('AI_DIRECTION_AMBIGUOUS');
  expect(parseTransactionInput('账户000收入100元，支付方式微信',options)).toMatchObject({status:'pass',fields:{direction:1}});
});
test('multi-entry boundary: 2-3 笔走拆分流，超 3 笔仍拒绝（追加165）',()=>{
  expect(parseTransactionInput('账户000支出10元，停车20元',options).status).toBe('needs_input');
  // 追加165：2-3 笔同方向由 parseTransactionInputs 拆分 + proposalFrom 逐笔 evidence-match 接管，意图层放行
  expect(()=>assertProposalIntent('transaction.create','账户000支出10元，停车20元')).not.toThrow();
  expect(()=>assertProposalIntent('transaction.create','账户000支出10元，停车20元，午餐15元，咖啡8元，打车5元'))
    .toThrow(expect.objectContaining({code:'AI_MULTIPLE_TRANSACTIONS'}));
});

test.each(['账户000支出10元、20元和约30元', '账户000支出10元、20元和30元左右',
  '账户000支出10元、20元和1百元', '账户000支出10元、20元和负30元'])(
  'an ambiguous batch item prevents clear neighbours from being silently saved: %s', message => {
    expect(extractMoneyTokens(message, { entities: options.accounts })).toHaveLength(3);
    expect(parseTransactionInputs(message, options)).toMatchObject({ status: 'needs_input', reasonCode: 'AI_AMOUNT_AMBIGUOUS', entries: null });
  });

test('an explicit two-item batch preserves original item count and exact amounts', () => {
  expect(parseTransactionInputs('账户000支出10元、20元', options)).toMatchObject({ status: 'pass', entries: [
    { amount: '10', accountId: 'debit-000' }, { amount: '20', accountId: 'debit-000' },
  ] });
});
test('fund evidence remains strict despite ordinary balance-reference filtering',()=>{
  expect(validateFundEvidence([{date:'2026-11-04',amount:'-0.8658'}],'登记收益\n中证500 2026-11-04 -0.8658')).toBe(true);
  expect(()=>validateFundEvidence([{date:'2026-11-04',amount:'2'}],'2026-11-04 收益2元，本金100元')).toThrow();
  expect(()=>validateFundEvidence([{date:'2026-11-04',amount:'2'}],'2026-11-04 收益2元，余额100元')).toThrow();
});

test('a leading-zero tail immediately followed by a card type stays an account identity', () => {
  const accounts = [{ id: 'card-a', name: '日常卡', type: 'debit', tail: '000' }];
  expect(parseTransactionInput('今天尾号000借记卡支出39.91元，餐饮，银行卡', { ...options, accounts })).toMatchObject({
    status: 'pass', fields: { amount: '39.91', accountId: 'card-a' }, evidence: { account: { source: 'explicit-unique-label' } },
  });
  expect(extractMoneyTokens('今天尾号000借记卡支出39.91元', { entities: accounts }).map(item => item.amount)).toEqual(['39.91']);
  expect(parseTransactionInput('尾号000借记卡支出10元', { ...options, accounts: [...accounts, { ...accounts[0], id: 'card-b' }] }))
    .toMatchObject({ status: 'needs_input', reasonCodes: ['AI_ACCOUNT_AMBIGUOUS'] });
});

test.each(['１，０００．００元', '￥１，０００．００', '人民币１０００元'])(
  'full-width exact money keeps its original evidence and normalized amount: %s', token => {
    const message = `账户000支出${token}`;
    expect(parseTransactionInput(message, options)).toMatchObject({ status: 'pass', fields: { amount: '1000' } });
    expect(assertProposalIntent('transaction.create', message, { accounts: options.accounts })).toBe(true);
    expect(extractMoneyTokens(message, { entities: options.accounts })[0].text).toMatch(/[０-９]/);
  });

test.each(['账户000支出10元20元合计30元', '账户000支出10元20元总共30元', '账户000支出10元20元小计30元'])(
  'a total attached to multiple amounts requires clarification before batch generation: %s', message => {
    expect(parseTransactionInputs(message, options)).toMatchObject({ status: 'needs_input', reasonCode: 'AI_MULTIPLE_TRANSACTIONS', entries: null });
  });

test('cash and stored-balance conflicts stop before provider while linked-card channels remain allowed', () => {
  expect(parseTransactionInput('账户000支出10元，用现金支付', options)).toMatchObject({ status: 'needs_input', reasonCodes: ['ACCOUNT_PAYMENT_CONFLICT'] });
  expect(parseTransactionInputs('账户000支出10元、20元，用现金支付', options)).toMatchObject({ status: 'needs_input', reasonCode: 'ACCOUNT_PAYMENT_CONFLICT' });
  for (const method of ['微信', '支付宝', '银行卡']) expect(parseTransactionInput(`账户000支出10元，用${method}支付`, options))
    .toMatchObject({ status: 'pass', fields: { payMethod: method } });
});
