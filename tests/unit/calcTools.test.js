const { calcDefinitions, validateCalcTool, isCalcTool, evaluateCalc } = require('../../src/modules/ai/service/calcTools');
const { AiError } = require('../../src/modules/ai/service/errors');

const calc = (expression, mode) => evaluateCalc(validateCalcTool('calculate', { expression, ...(mode ? { mode } : {}) }));
const failCode = (expression, mode) => {
  try { calc(expression, mode); } catch (error) { return error.code; }
  return null;
};

describe('calculate 工具定义与参数校验', () => {
  test('definitions 是合法 OpenAI function 契约', () => {
    expect(calcDefinitions).toHaveLength(1);
    const def = calcDefinitions[0];
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('calculate');
    expect(def.function.parameters.required).toEqual(['expression']);
    expect(def.function.parameters.additionalProperties).toBe(false);
    expect(def.function.parameters.properties.expression.maxLength).toBe(200);
  });

  test('isCalcTool 只认 calculate', () => {
    expect(isCalcTool('calculate')).toBe(true);
    expect(isCalcTool('query_data')).toBe(false);
    expect(isCalcTool('calculate ')).toBe(false);
  });

  test('非法参数逐类拒绝', () => {
    expect(() => validateCalcTool('query_data', {})).toThrow(AiError);
    expect(() => validateCalcTool('calculate', null)).toThrow(AiError);
    expect(() => validateCalcTool('calculate', [1])).toThrow(AiError);
    expect(() => validateCalcTool('calculate', { expression: 42 })).toThrow(AiError);
    expect(() => validateCalcTool('calculate', { expression: 'x'.repeat(201) })).toThrow(AiError);
    expect(() => validateCalcTool('calculate', { expression: '1+1', mode: 'cny' })).toThrow(AiError);
    expect(() => validateCalcTool('calculate', { expression: '1+1', extra: true })).toThrow(AiError);
  });

  test('mode 缺省为 money', () => {
    expect(validateCalcTool('calculate', { expression: '1' }).mode).toBe('money');
    expect(validateCalcTool('calculate', { expression: '1', mode: 'number' }).mode).toBe('number');
  });
});

describe('四则、幂、括号、常量', () => {
  test('优先级与括号', () => {
    expect(calc('2+3*4', 'number').value).toBe('14');
    expect(calc('(2+3)*4', 'number').value).toBe('20');
    expect(calc('10-4-3', 'number').value).toBe('3');
    expect(calc('100/5/2', 'number').value).toBe('10');
    expect(calc('-5+10', 'number').value).toBe('5');
    expect(calc('2*-3', 'number').value).toBe('-6');
    expect(calc('-(2+3)', 'number').value).toBe('-5');
  });

  test('幂右结合、负指数', () => {
    expect(calc('2^10', 'number').value).toBe('1024');
    expect(calc('2^3^2', 'number').value).toBe('512');
    expect(calc('2^-3', 'number').value).toBe('0.125');
    expect(calc('(2+1)^2', 'number').value).toBe('9');
  });

  test('常量 pi 与 e', () => {
    expect(calc('pi', 'number').value).toBe('3.141592653589793');
    expect(calc('pi+1', 'number').value).toBe('4.141592653589793');
    expect(calc('2*pi', 'number').value).toBe('6.283185307179586');
    expect(calc('2*pi', 'number').approximate).toBeUndefined();
    expect(calc('pi', 'money').value).toBe('3.14');
    expect(calc('e', 'number').value).toBe('2.718281828459045');
  });

  test('取模与百分数习惯写法', () => {
    expect(calc('10%3', 'number').value).toBe('1');
    expect(calc('10.5%3', 'number').value).toBe('1.5');
    expect(calc('12/100*350', 'money').value).toBe('42.00');
  });
});

describe('金额定点（按分整数化）', () => {
  test('消除浮点尾差：0.1+0.2 精确到分', () => {
    const r = calc('0.1+0.2');
    expect(r.mode).toBe('money');
    expect(r.value).toBe('0.30');
    expect(r.cents).toBe('30');
    expect(r.approximate).toBeUndefined();
  });

  test('乘法与四舍五入到分', () => {
    expect(calc('19.99*0.85').value).toBe('16.99');
    expect(calc('19.995').value).toBe('20.00');
    expect(calc('149.985').cents).toBe('14999');
  });

  test('合计与均摊（整数除法）', () => {
    const r = calc('(3200*12+15750)/12');
    expect(r.value).toBe('4512.50');
    expect(r.cents).toBe('451250');
    expect(r.approximate).toBeUndefined();
  });

  test('除不尽标记近似值', () => {
    const r = calc('100/3');
    expect(r.value).toBe('33.33');
    expect(r.cents).toBe('3333');
    expect(r.approximate).toBe(true);
    const n = calc('10/3', 'number');
    expect(n.value).toBe('3.333333333333');
    expect(n.approximate).toBe(true);
  });

  test('负数金额与负数四舍五入', () => {
    expect(calc('-19.99*0.85').value).toBe('-16.99');
    expect(calc('-0.005').value).toBe('-0.01');
    expect(calc('-100/3').value).toBe('-33.33');
  });

  test('近似标记经后续运算传播', () => {
    expect(calc('100/3*3').approximate).toBe(true);
    expect(calc('100/3+67').value).toBe('100.33');
  });
});

describe('拒绝类：除零、溢出、非法表达式', () => {
  test('除零拒绝（除法、取模、负幂）', () => {
    expect(failCode('5/0')).toBe('AI_CALC_DIVIDE_BY_ZERO');
    expect(failCode('5%0')).toBe('AI_CALC_DIVIDE_BY_ZERO');
    expect(failCode('0^-2')).toBe('AI_CALC_DIVIDE_BY_ZERO');
    expect(failCode('1/(2-2)')).toBe('AI_CALC_DIVIDE_BY_ZERO');
  });

  test('大数溢出拒绝', () => {
    expect(failCode('999999999999*999999999999*999999999999')).toBe('AI_CALC_OVERFLOW');
    expect(failCode('2^100')).toBe('AI_CALC_OVERFLOW');
  });

  test('数字位数超限', () => {
    expect(failCode('1234567890123')).toBe('AI_CALC_INVALID_EXPRESSION');
    expect(failCode('0.1234567')).toBe('AI_CALC_INVALID_EXPRESSION');
  });

  test('非法表达式逐类拒绝', () => {
    expect(failCode('alert(1)')).toBe('AI_CALC_INVALID_EXPRESSION'); // 函数调用
    expect(failCode('foo')).toBe('AI_CALC_INVALID_EXPRESSION'); // 标识符
    expect(failCode('0x1f')).toBe('AI_CALC_INVALID_EXPRESSION'); // 十六进制
    expect(failCode('"abc"')).toBe('AI_CALC_INVALID_EXPRESSION'); // 引号
    expect(failCode("'1'")).toBe('AI_CALC_INVALID_EXPRESSION');
    expect(failCode('`x`')).toBe('AI_CALC_INVALID_EXPRESSION'); // 模板串
    expect(failCode('1;drop table')).toBe('AI_CALC_INVALID_EXPRESSION'); // 非法字符
    expect(failCode('1 & 2')).toBe('AI_CALC_INVALID_EXPRESSION');
    expect(failCode('2e3')).toBe('AI_CALC_INVALID_EXPRESSION'); // 科学计数法（隐式相邻）
    expect(failCode('1 2')).toBe('AI_CALC_INVALID_EXPRESSION'); // 缺运算符
    expect(failCode('1+')).toBe('AI_CALC_INVALID_EXPRESSION'); // 不完整
    expect(failCode('(1+2')).toBe('AI_CALC_INVALID_EXPRESSION'); // 括号不匹配
    expect(failCode('1+2)')).toBe('AI_CALC_INVALID_EXPRESSION');
    expect(failCode('2^3.5')).toBe('AI_CALC_INVALID_EXPRESSION'); // 非整数幂
    expect(failCode('   ')).toBe('AI_CALC_INVALID_EXPRESSION'); // 空白算式
  });
});
