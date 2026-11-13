const { assertProposalIntent, validateFundEvidence, explicitAmount } = require('../../src/modules/ai/service/businessIntent');

test.each([
  ['transaction.create','今天去赵一鸣买了 8.5的零食'],
  ['transaction.create','停车39.91元'],['transaction.create','午饭花了32元'],['transaction.create','帮我记一笔支出'],
  ['budget.create','创建2026年预算'],['budget.create','做一个旅游预算'],['todo.create','提醒我明天买菜'],
  ['todo.update','把买菜待办的日期改到明天'],['todo.complete','把取快递标记为已完成'],['todo.complete','完成取快递待办'],
  ['todo.delete','删除取快递待办'],['diary.create','整理今天的工作日记'],['card.metadata','把信用卡别名改成生活卡'],
  ['card.metadata','注销生活卡'],['fixedAsset.create','登记固定资产电脑'],['fixedAsset.update','修改固定资产名称'],
  ['fixedAsset.delete','把固定资产电脑移到回收站'],['fixedAsset.restore','恢复回收站里的资产电脑'],
  ['fixedAsset.permanentDelete','彻底删除固定资产电脑'],['fund.returnBatch','登记收益\n2026-11-04 -0.8658'],['system.backup','帮我备份系统数据库'],
])('explicit %s intent accepts %s', (kind,message) => { expect(assertProposalIntent(kind,message)).toBe(true); });

test.each([
  ['todo.complete','查看已完成待办'],['todo.delete','看看已删除待办'],['todo.create','看看待办'],
  ['todo.delete','取消提醒'],['todo.update','新增待办提醒买菜'],['todo.complete','任务完成过吗'],
  ['todo.delete','不要删除取快递待办'],['todo.delete','删除待办有什么风险'],
  ['card.metadata','查看已经注销的信用卡'],['card.metadata','信用卡注销后会影响余额吗'],
  ['card.metadata','生活卡已注销'],['fixedAsset.delete','我的资产回收站'],
  ['fixedAsset.permanentDelete','删除固定资产电脑'],['fixedAsset.delete','永久删除固定资产电脑'],
  ['fund.returnBatch','查询基金收益'],['fund.returnBatch','计算基金收益'],['budget.create','新增待办'],
  ['diary.create','今天工作很累'],['system.backup','查看备份记录'],['system.backup','备份会不会影响使用'],
  ['transaction.create','这顿午饭多少元'],['transaction.create','查看收入39.91元'],
])('read/negative/different action fails for %s: %s', (kind,message) => { expect(() => assertProposalIntent(kind,message)).toThrow(); });

test.each(['买了3个零食','买了2026-11-06的零食','不要买了8.5的零食','查看买了8.5的零食','账户尾号000买了3件零食','买了零食，余额100'])
  ('unit-free entries still exclude counts, dates, negation and balance amounts: %s',message=>expect(()=>assertProposalIntent('transaction.create',message)).toThrow());

test.each(['记账还款39.91元','转账39.91元','退款39.91元','分期付款39.91元','帮我记本金调整39.91元'])('special finance fails before proposing an ordinary transaction: %s', message => {
  expect(() => assertProposalIntent('transaction.create',message)).toThrow(expect.objectContaining({code:'AI_ACTION_NOT_ALLOWED'}));
});

test.each([
  ['card.metadata','请将银行卡「合成卡已核对」恢复正常状态，别名保持合成卡已核对。'],
  ['card.metadata','请修改银行卡“查看说明卡”的别名为生活卡。'],
  ['todo.update','请将待办「看看报告」的日期改到明天。'],
  ['todo.delete','请删除待办「不要删除备忘」。'],
  ['fixedAsset.restore','请恢复回收站里的固定资产「查询设备」。'],
])('quoted business names do not change the explicit %s command: %s', (kind,message) => {
  expect(assertProposalIntent(kind,message)).toBe(true);
});

test.each([
  ['card.metadata','查看银行卡「挂失卡」'],
  ['todo.delete','看看待办「删除取快递」'],
  ['todo.complete','看看待办“完成报告”'],
  ['fixedAsset.restore','查看固定资产「恢复电脑」'],
  ['card.metadata','不要将银行卡「合成卡已核对」恢复正常状态'],
])('quoted text never grants a mutation or removes outside negation: %s %s', (kind,message) => {
  expect(()=>assertProposalIntent(kind,message)).toThrow(expect.objectContaining({code:'AI_ACTION_NOT_REQUESTED'}));
});

test('unregistered precision actions are never authorized', () => {
  for(const kind of ['card.repayment','fixedAsset.depreciation','fund.recalculate','sql.execute','installment.enter']) expect(()=>assertProposalIntent(kind,'帮我执行')).toThrow();
});
test('multiple ordinary expenses stop at one-draft boundary instead of silently choosing one amount', () => {
  expect(()=>assertProposalIntent('transaction.create','今天买菜花了3块，猪肉15块，玉米5块，煎饼13块')).toThrow(expect.objectContaining({code:'AI_MULTIPLE_TRANSACTIONS'}));
  expect(()=>assertProposalIntent('system.backup','我的备份')).toThrow();
});

test('amount evidence preserves signs/four places and does not use a year/date/duration/percentage as money', () => {
  expect(explicitAmount('停车39.91元','39.9100')).toBe(true);expect(explicitAmount('停车39.91元','39.9099')).toBe(false);
  expect(explicitAmount('2026-11-04 -0.8658','-0.8658')).toBe(true);expect(explicitAmount('收益+9.1132','9.1132')).toBe(true);
  expect(explicitAmount('收益-9.1132','9.1132')).toBe(false);
  for(const [message,amount] of [['日期2026-11-04','2026'],['2026年预算','2026'],['期限30天','30'],['分31期','31'],['残值率5%','5'],['2个提醒','2'],['11:39','39']]) expect(explicitAmount(message,amount)).toBe(false);
});

test('fund entries require unique date/amount pairs and preserve exact signed decimals', () => {
  const entries=[{date:'2026-11-04',amount:'-0.8658'},{date:'2026-11-05',amount:'9.1132'}];
  expect(validateFundEvidence(entries,'登记收益\n2026-11-04 -0.8658\n2026-11-05 +9.1132')).toBe(true);
  expect(validateFundEvidence([{date:'2026-11-04',amount:'2.20'}],'登记收益\n中证500 2026-11-04 +2.2000元')).toBe(true);
  expect(validateFundEvidence([{date:'2026-11-04',amount:'0'}],'登记收益\n2026-11-04 0.0000')).toBe(true);
});

test.each([
  [[{date:'2026-11-04',amount:'9.1132'}],'2026-11-04 0.8658\n2026-11-05 9.1132'],
  [[{date:'2026-11-04',amount:'9.1132'}],'2026-11-04 0.8658 2026-11-05 9.1132'],
  [[{date:'2026-11-04',amount:'2'}],'2026-11-04 收益2元，本金100元'],
  [[{date:'2026-11-04',amount:'2'}],'2026-11-04 2\n2026-11-04 3'],
  [[{date:'2026-11-04',amount:'2'},{date:'2026-11-04',amount:'2'}],'2026-11-04 2'],
  [[{date:'2026-02-30',amount:'2'}],'2026-02-30 2'],
  [[{date:'2026-11-04',amount:'2'}],'2026-11-04 -2'],
  [[{date:'2026-11-04',amount:'2.12345'}],'2026-11-04 2.12345'],
])('ambiguous/guessed fund evidence fails closed', (entries,message) => { expect(()=>validateFundEvidence(entries,message)).toThrow(expect.objectContaining({code:'AI_AMOUNT_NOT_EXPLICIT'})); });
