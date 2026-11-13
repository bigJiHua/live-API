const { evaluateCalc } = require('../../src/modules/ai/service/calcTools');
const { verifyChatNumbers, sanitizeChatNumbers, buildPublishedNumberFacts, normalizedNumber } = require('../../src/modules/ai/service/chatNumericEvidence');

const assets = { datasetId: 'asset-composition', title: '账户余额组成', columns: [
  { key: 'name', label: '名称', type: 'text' }, { key: 'positiveAssets', label: '正资产', type: 'money' },
  { key: 'creditDebt', label: '信用卡负债', type: 'money' }],
rows: [{ name: '借记卡', positiveAssets: '52000.00', creditDebt: '0.00' },
  { name: '微信零钱', positiveAssets: '320.00', creditDebt: '0.00' },
  { name: '信用卡', positiveAssets: '0.00', creditDebt: '8500.00' }],
summary: {}, queryMeta: { matchedRowCount: 3, returnedRowCount: 3, sourceRecordCount: 4 } };
const funds = { datasetId: 'fund-holdings', title: '基金登记', columns: [
  { key: 'name', label: '基金', type: 'text' }, { key: 'principal', label: '本金', type: 'money' },
  { key: 'marketValue', label: '市值', type: 'money' }, { key: 'profit', label: '收益', type: 'decimal' }],
rows: [{ name: '沪深300指数A', principal: '12000.00', marketValue: '12850.00', profit: '850.00' },
  { name: '债基B', principal: '5400.00', marketValue: '5200.00', profit: '-200.00' }], summary: {} };
const options = { datasets: [assets, funds] };
const calc = expression => evaluateCalc({ expression, mode: 'money' });

test.each(['净资产71,370元。', '净资产七万一千三百七十元。', '净资产7.137万元。'])('rejects the captured false net worth: %s', answer => {
  expect(verifyChatNumbers(answer, options)).toMatchObject({ valid: false, unsupportedNumbers: ['71370'] });
});
test.each(['净资产61,870元。', '净资产六万一千八百七十元。', '净资产6.187万元。'])('successful sourced calculation proves correct derived amount: %s', answer => {
  const calculations = [calc('52000+12850+5200+320-8500')];
  expect(verifyChatNumbers(answer, { ...options, calculations }).valid).toBe(true);
});
test('a literal calculator call or forged result cannot launder an invented amount', () => {
  expect(verifyChatNumbers('净资产71370元。', { ...options, calculations: [calc('71370')] }).valid).toBe(false);
  expect(verifyChatNumbers('净资产71370元。', { ...options, calculations: [calc('71370*1')] }).valid).toBe(false);
  expect(verifyChatNumbers('净资产71370元。', { ...options, calculations: [{ expression: '52000+320-8500', mode: 'money', value: '71370' }] }).valid).toBe(false);
});
test('failed and stale calculation shapes do not provide values', () => {
  const successful = calc('52000+12850+5200+320-8500');
  for (const receipt of [{ ...successful, status: 'error' }, { value: '61870', mode: 'money' }, { ...successful, mode: 'unknown' }])
    expect(verifyChatNumbers('净资产61870元。', { ...options, calculations: [receipt] }).valid).toBe(false);
});
test('calculations can chain from earlier proven results but not from unproven receipts', () => {
  const calculations = [calc('12850+5200'), calc('52000+320+18050'), calc('70370-8500')];
  expect(verifyChatNumbers('正资产70370元，净资产61870元。', { ...options, calculations }).valid).toBe(true);
  expect(verifyChatNumbers('净资产61870元。', { ...options, calculations: calculations.slice(1) }).valid).toBe(false);
});
test('negative profit never automatically proves the positive number', () => {
  expect(verifyChatNumbers('债基B收益−200元。', options).valid).toBe(true);
  expect(verifyChatNumbers('债基B收益200元。', options).valid).toBe(false);
  expect(verifyChatNumbers('债基B收益-¥200元。', options).valid).toBe(true);
  expect(verifyChatNumbers('债基B收益负200元。', options).valid).toBe(true);
  expect(verifyChatNumbers('当前收益200元。', { ...options, calculations: [calc('200+0')] }).valid).toBe(false);
  expect(verifyChatNumbers('已登记利润合计650元。', { ...options, calculations: [calc('850+(-200)')] }).valid).toBe(true);
});
test('decimal canonicalization is signed and exact without floating point', () => {
  expect(normalizedNumber('9007199254740993.0001')).toBe('9007199254740993.0001');
  expect(normalizedNumber('−1,234.5000')).toBe('-1234.5');
  expect(normalizedNumber('-0.00')).toBe('0');
  expect(normalizedNumber('1,23.00')).toBeNull();
  const source = { columns: [{ key: 'amount', type: 'money' }], rows: [{ amount: '9007199254740993.0001' }] };
  expect(verifyChatNumbers('已保存金额9007199254740993.0002元。', { datasets: [source] }).valid).toBe(false);
});
test('scientific notation and malformed grouping do not silently disappear', () => {
  expect(verifyChatNumbers('净资产7.137e4元。', options).valid).toBe(false);
  expect(verifyChatNumbers('金额1,23元。', options).valid).toBe(false);
  expect(verifyChatNumbers('比例.7137%。', options).valid).toBe(false);
});
test('dataset field names, date values, metadata IDs and numeric text labels are not money', () => {
  const fake = { columns: [{ key: 'date', type: 'date' }, { key: 'title', type: 'text' }],
    rows: [{ date: '2026-11-12', title: '71370' }], summary: { year: 71370, id: 71370 }, queryMeta: { queryId: '71370' } };
  expect(verifyChatNumbers('净资产71370元。', { datasets: [fake] }).valid).toBe(false);
});
test('financial assertions embedded in source text cannot supply a numeric identity exemption', () => {
  const source = { columns: [{ key: 'name', type: 'text' }], rows: [{ name: '净资产71370元' }] };
  expect(verifyChatNumbers('净资产71370元。', { datasets: [source] }).valid).toBe(false);
  const remark = { columns: [{ key: 'remark', type: 'text' }], rows: [{ remark: '净资产71370元' }] };
  expect(verifyChatNumbers('净资产71370元。', { datasets: [remark] }).valid).toBe(false);
  const chinese = { columns: [{ key: 'name', type: 'text' }], rows: [{ name: '净资产七万一千三百七十元' }] };
  expect(verifyChatNumbers('净资产七万一千三百七十元。', { datasets: [chinese] }).valid).toBe(false);
});

test('Chinese installment and record counts are verified as complete quantities', () => {
  const saved = { columns: [{ key: 'periods', type: 'number' }], rows: [{ periods: 6 }] };
  expect(verifyChatNumbers('配置共六期。', { datasets: [saved] }).valid).toBe(true);
  expect(verifyChatNumbers('还剩三期。', { datasets: [saved] }).valid).toBe(false);
  expect(verifyChatNumbers('共有二十条记录。', { datasets: [saved] }).valid).toBe(false);
});
test('legitimate named labels and calendar syntax are preserved', () => {
  const answer = '2026/11/12沪深300指数A登记本金12,000元，市值12,850元。截至2026年11月12日，债基B收益-200元。';
  expect(verifyChatNumbers(answer, options).valid).toBe(true);
  expect(sanitizeChatNumbers(answer, options).answer).toBe(answer);
});
test('date-shaped arithmetic with a monetary suffix cannot be hidden as a date', () => {
  expect(verifyChatNumbers('金额2026-11-12元。', options).valid).toBe(false);
  expect(verifyChatNumbers('计算11/12=0.9167元。', options).valid).toBe(false);
});
test('hypothetical user inputs are accepted only in explicit condition clauses and only for calculator operands', () => {
  const work = { columns: [{ key: 'hourlyWage', type: 'money' }], rows: [{ hourlyWage: '50' }] };
  const base = { datasets: [work], calculations: [calc('50*4')] };
  expect(verifyChatNumbers('假设加班，应得200元。', { ...base, sourceMessage: '假设加班4小时，要多少钱？' }).valid).toBe(true);
  expect(verifyChatNumbers('应得200元。', { ...base, sourceMessage: '净资产是71370吗？4' }).valid).toBe(false);
  expect(verifyChatNumbers('应得200元。', { ...base, sourceMessage: '记住“假设加班4小时”这句话。' }).valid).toBe(false);
  expect(verifyChatNumbers('账本金额4元。', { ...base, sourceMessage: '假设加班4小时。' }).valid).toBe(false);
  expect(verifyChatNumbers('假设加班4小时，应得200元。', { ...base, sourceMessage: '假设加班4小时。' }).valid).toBe(true);
  expect(verifyChatNumbers('按该假设，应得200元。实际已保存工资200元。', { ...base, sourceMessage: '假设加班4小时。' }).valid).toBe(false);
  expect(verifyChatNumbers('当前净资产71370元。', { ...options, sourceMessage: '如果净资产71370元呢？', calculations: [calc('71370+0')] }).valid).toBe(false);
  expect(verifyChatNumbers('工资100元。', { datasets: [work], calculations: [calc('100')] }).valid).toBe(false);
});

test('explicit model hypothetical parameters can be calculated without laundering the predicted result', () => {
  const scenarioMessage = '收入增长值得关注。假设每月留出1000元，三个月可以积累3000元；这是一种规划。';
  const base = { ...options, scenarioMessage, calculations: [calc('1000*3')] };
  expect(verifyChatNumbers('假设每月留出1000元，三个月可以积累3000元。', base).valid).toBe(true);
  expect(verifyChatNumbers('假设每月留出1000元，三个月可以积累3000元。', { ...base, calculations: [] }).valid).toBe(false);
  expect(verifyChatNumbers('当前净资产3000元。', base).valid).toBe(false);
  expect(verifyChatNumbers('假设会积累3000元。', { ...base, calculations: [calc('3000+0')] }).valid).toBe(false);
  expect(verifyChatNumbers(scenarioMessage, base).scenarioInputs).toEqual(['1000', '3']);
  expect(verifyChatNumbers(scenarioMessage, { ...options, sourceMessage: scenarioMessage }).scenarioInputs).toEqual(['1000', '3']);
});

test('hypothetical results after a comma or equation are never accepted as inputs', () => {
  const work = { columns: [{ key: 'hourlyWage', type: 'money' }], rows: [{ hourlyWage: '50' }] };
  const captured = '举例说明（假设值，仅演示）：如果某天加班3小时，当天加班费约为3×50=150元。';
  const base = { datasets: [work], scenarioMessage: captured };
  expect(verifyChatNumbers(captured, base).scenarioInputs).toEqual(['3']);
  expect(verifyChatNumbers(captured, base).valid).toBe(false);
  expect(sanitizeChatNumbers(captured, base).answer).not.toContain('150');
  expect(verifyChatNumbers(captured, { ...base, calculations: [calc('3*50')] }).valid).toBe(true);
  expect(verifyChatNumbers('当前已保存工资150元。', { ...base, calculations: [calc('3*50')] }).valid).toBe(false);
  for (const sourceMessage of ['假设加班3小时，当天预计工资150元。', '如果加班3小时当天应得150元。', '假设3×50=150元。']) {
    const checked = verifyChatNumbers('如果应得150元。', { datasets: [work], sourceMessage });
    expect(checked.scenarioInputs).not.toContain('150');
    expect(checked.valid).toBe(false);
  }
  expect(verifyChatNumbers(captured, { ...base, calculations: [calc('150+0')] }).valid).toBe(false);
});

test('a clearly labelled hypothetical table inherits that scope but never supports current stored claims', () => {
  const base = { ...options, sourceMessage: '假设每月增加3000元。', calculations: [calc('52000+3000')] };
  const hypothetical = '按该假设：\n\n|项目|金额|\n|---|---|\n|推演结果|55000|';
  expect(verifyChatNumbers(hypothetical, base).valid).toBe(true);
  expect(sanitizeChatNumbers(hypothetical, base).answer).toBe(hypothetical);
  expect(verifyChatNumbers(hypothetical.replace('推演结果', '当前账本余额'), base).valid).toBe(false);
});
test('plain recommendations survive while unproved daily-average estimates disappear', () => {
  const budget = { columns: [{ key: 'planned', type: 'money' }, { key: 'registeredUsed', type: 'money' }, { key: 'remaining', type: 'money' }],
    rows: [{ planned: '2000', registeredUsed: '1450', remaining: '550' }] };
  const answer = '已登记使用1450元，剩余550元。平均每天只能花30元。建议核对真实餐饮流水。';
  const clean = sanitizeChatNumbers(answer, { datasets: [budget] });
  expect(clean.answer).toBe('已登记使用1450元，剩余550元。建议核对真实餐饮流水。');
  expect(clean.changed).toBe(true); expect(clean.valid).toBe(true);
});
test('table sanitation preserves sourced rows and removes only an unsupported total row', () => {
  const answer = '| 项目 | 金额 |\n|---|---|\n|借记卡|52000|\n|信用卡负债|8500|\n|净资产|71370|';
  const clean = sanitizeChatNumbers(answer, options);
  expect(clean.answer).toContain('|借记卡|52000|'); expect(clean.answer).toContain('|信用卡负债|8500|');
  expect(clean.answer).not.toContain('71370'); expect(clean.valid).toBe(true);
});
test('a numerical Mermaid title is verified and rejected blocks do not destroy ordinary prose', () => {
  const diagram = '```mermaid\npie title 正资产合计79870元\n "借记卡" : 52000\n "零钱" : 320\n```';
  expect(verifyChatNumbers(diagram, options).valid).toBe(false);
  const clean = sanitizeChatNumbers('以下是构成。\n' + diagram + '\n建议保留应急资金。', options);
  expect(clean.answer).toContain('以下是构成。'); expect(clean.answer).toContain('建议保留应急资金。');
  expect(clean.answer).not.toContain('```');
});
test('numerical Mermaid allows axis layout while checking real data points', () => {
  const diagram = '```mermaid\nxychart-beta\n x-axis ["借记卡", "微信零钱"]\n y-axis "元" 0 --> 60000\n bar [52000,320]\n```';
  expect(verifyChatNumbers(diagram, options).valid).toBe(true);
  expect(sanitizeChatNumbers(diagram, options).answer).toBe(diagram);
  expect(verifyChatNumbers(diagram.replace('52000,320', '71370,320'), options).valid).toBe(false);
  expect(verifyChatNumbers(diagram.replace('y-axis "元"', 'y-axis "净资产71370元"'), options).valid).toBe(false);
  expect(verifyChatNumbers(diagram.replace('x-axis ["借记卡", "微信零钱"]', 'x-axis ["净资产71370元"]'), options).valid).toBe(false);
});
test('structure Mermaid node IDs stay unchanged while their financial labels are verified', () => {
  const normal = '```mermaid\nflowchart TD\n A1[保存规则] --> B2[核对结果]\n classDef item fill:#fff,stroke-width:2px\n```';
  expect(verifyChatNumbers(normal, options).valid).toBe(true);
  expect(sanitizeChatNumbers(normal, options).answer).toBe(normal);
  const bad = normal.replace('核对结果', '净资产71370元');
  expect(verifyChatNumbers(bad, options).valid).toBe(false);
  expect(sanitizeChatNumbers('建议先核对。\n' + bad, options).answer).toBe('建议先核对。');
  const split = '```mermaid\nflowchart TD\n A1[净资产] --> B2[71370]\n```';
  expect(verifyChatNumbers(split, options).valid).toBe(false);
});
test('sequence diagram financial messages cannot bypass the guard', () => {
  const diagram = '```mermaid\nsequenceDiagram\n A1->>B2: 净资产71370元\n```';
  expect(verifyChatNumbers(diagram, options).valid).toBe(false);
  const alias = '```mermaid\nsequenceDiagram\n participant A1 as 净资产71370元\n A1->>B2: 核对\n```';
  expect(verifyChatNumbers(alias, options).valid).toBe(false);
});
test('JSON/code financial assertions do not bypass the guard while nonfinancial code is retained', () => {
  const code = '```js\nconsole.log(71370);\n```';
  expect(sanitizeChatNumbers(code, options).answer).toBe(code);
  const financial = '```json\n{"netAssets":71370}\n```';
  expect(verifyChatNumbers(financial, options).valid).toBe(false);
  expect(sanitizeChatNumbers(financial, options).answer).toBe('');
  for (const lang of ['text', 'plaintext', '', 'json', 'js', 'python']) {
    const bare = `当前净资产：\n\n~~~${lang}\n71370\n~~~`;
    expect(verifyChatNumbers(bare, options).valid).toBe(false);
    expect(sanitizeChatNumbers(bare, options).answer).not.toContain('71370');
  }
  expect(sanitizeChatNumbers('当前净资产需要核对。\n\n~~~js\nconsole.log(71370);\n~~~', options).answer).toContain('console.log(71370)');
});
test('published fallback contains only original numeric cells with readable labels and no derived total', () => {
  const facts = buildPublishedNumberFacts([assets, funds]);
  expect(facts).toContain('正资产 52000.00'); expect(facts).toContain('信用卡负债 8500.00'); expect(facts).toContain('收益 -200.00');
  expect(facts).not.toContain('61870'); expect(facts).not.toContain('71370'); expect(facts).not.toMatch(/服务端|接口|数据卡/);
  expect(buildPublishedNumberFacts(Array(8).fill(assets)).split('账户余额组成').length - 1).toBe(4);
  const badName = { title: '净资产71370元', columns: [{ key: 'name', type: 'text' }, { key: 'balance', label: '余额', type: 'money' }],
    rows: [{ name: '净资产71370元', balance: '52000' }] };
  const safe = buildPublishedNumberFacts([badName]);
  expect(safe).toContain('52000'); expect(safe).not.toContain('71370');
  expect(verifyChatNumbers(safe, { datasets: [badName] }).valid).toBe(true);
});

test('provider pseudo tool protocol is removed without executing it or proving its requested calculation', () => {
  const fake = '<tool_call>calculate<arg_key>expression</arg_key><arg_value>52000+320+12850+5200-8500</arg_value>'
    + '<arg_key>mode</arg_key><arg_value>money</arg_value></tool_call>';
  const functionCall = '<function_call name="calculate"><arg_key>expression</arg_key><arg_value>71370</arg_value></function_call>';
  const clean = sanitizeChatNumbers(fake + functionCall + '建议核对账户。', options);
  expect(clean.answer).toBe('建议核对账户。'); expect(clean.changed).toBe(true);
  expect(clean.answer).not.toMatch(/tool_call|function_call|arg_key|arg_value/);
  expect(verifyChatNumbers('净资产61870元。', options).valid).toBe(false);
  expect(verifyChatNumbers('净资产71370元。', options).valid).toBe(false);
  const fields = sanitizeChatNumbers('<arg_key>expression</arg_key><arg_value>71370</arg_value>', options);
  expect(fields.answer).toBe(''); expect(fields.changed).toBe(true);
  expect(sanitizeChatNumbers('<tool_call>calculate<arg_key>expression', options).answer).toBe('');
  expect(sanitizeChatNumbers('<tool_call/>建议核对账户。', options).answer).toBe('建议核对账户。');
});

test('fenced programming examples of pseudo tool protocol are preserved byte for byte', () => {
  const fake = '<tool_call>calculate<arg_key>expression</arg_key><arg_value>71370</arg_value></tool_call>';
  const code = '程序示例：\n\n```xml\n' + fake + '\n```';
  expect(sanitizeChatNumbers(code, options)).toMatchObject({ answer: code, changed: false });
  const javascript = '```js\nconst payload = ' + JSON.stringify(fake) + ';\n```';
  expect(sanitizeChatNumbers(javascript, options)).toMatchObject({ answer: javascript, changed: false });
});
