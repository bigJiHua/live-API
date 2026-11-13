const Joi = require('joi');
const { AiError } = require('./errors');

// calculate：账本数据之外的派生数字（合计、差值、均摊、换算、比较）一律确定性求值，
// 消灭模型心算这一 claims 体系管不到的幻觉面。词法级白名单（数字、+ - * / % ^、
// 括号、常量 pi/e），不用 eval/Function；内部 BigInt 十进制定点（s×10^-k）消除浮点
// 尾差，money 模式最终四舍五入到分；除不尽置 approximate=true，要求回答声明近似。
const MAX_EXPRESSION = 200, MAX_TOKENS = 120, MAX_INT_DIGITS = 12, MAX_FRAC_DIGITS = 6;
const MAX_VALUE_DIGITS = 30, MAX_SCALE = 15, DIV_GUARD = 12, MAX_POW = 999;

const schema = Joi.object({
  expression: Joi.string().min(1).max(MAX_EXPRESSION).required(),
  mode: Joi.string().valid('money', 'number').default('money'),
}).unknown(false);

const calcDefinitions = [{ type: 'function', function: { name: 'calculate',
  description: '对算式做确定性求值，用于账本数据之外的派生数字：合计、差值、均摊、汇率或单位换算、攒钱规划、百分比比较。账本工具已给出的数字不要重算。只接受数字、+ - * / % ^、半角括号和常量 pi、e；% 是取模不是百分号，百分数写成除以100（如12%写作12/100）；不接受函数调用、标识符、引号、逗号或科学计数法；整数最多12位、小数最多6位。mode 默认 money：按金额处理，结果四舍五入到分并给出整数分字符串cents；纯数量（个数、次数、百分比中间值）传 number。除不尽时 approximate=true，回答必须说明是近似值。',
  parameters: { type: 'object', properties: {
    expression: { type: 'string', minLength: 1, maxLength: MAX_EXPRESSION,
      description: '半角算式，≤200字符，例：(3200*12+15750)/12 或 149.90*0.85。' },
    mode: { type: 'string', enum: ['money', 'number'], description: 'money=金额（默认，到分）；number=纯数量，最多15位小数。' } },
  required: ['expression'], additionalProperties: false } } }];

const isCalcTool = name => name === 'calculate';

function validateCalcTool(name, args) {
  if (!isCalcTool(name)) throw new AiError('模型选择了未开放的计算能力', 403, 'AI_TOOL_DENIED');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AiError('计算工具参数必须是对象', 400, 'AI_CALC_ARGUMENT_INVALID');
  const { value, error } = schema.validate(args, { convert: false, abortEarly: false });
  if (error) throw new AiError('计算工具参数不符合开放协议', 400, 'AI_CALC_ARGUMENT_INVALID');
  return value;
}

const fail = (message, code = 'AI_CALC_INVALID_EXPRESSION') => { throw new AiError(message, 400, code); };

// Constants carry the tool's precision floor; they are exact decimals, not floats.
const WORDS = { pi: { s: 3141592653589793n, k: 15 }, e: { s: 2718281828459045n, k: 15 } };

function lex(src) {
  const tokens = [];
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
      const text = m[0]; const dot = text.indexOf('.');
      const intLen = dot < 0 ? text.length : dot, fracLen = dot < 0 ? 0 : text.length - dot - 1;
      if (intLen > MAX_INT_DIGITS || fracLen > MAX_FRAC_DIGITS) fail(`数字位数超限：整数最多${MAX_INT_DIGITS}位、小数最多${MAX_FRAC_DIGITS}位`);
      tokens.push({ t: 'num', s: BigInt(dot < 0 ? text : text.replace('.', '')), k: fracLen === 0 ? 0 : fracLen });
      i += text.length; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_]+/.exec(src.slice(i))[0];
      if (!WORDS[word]) fail('不允许标识符或函数调用，只接受常量 pi 与 e');
      tokens.push({ t: 'num', s: WORDS[word].s, k: WORDS[word].k });
      i += word.length; continue;
    }
    if ('+-*/%^()'.includes(ch)) { tokens.push({ t: ch }); i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') fail('表达式不允许引号或字符串');
    fail('表达式只允许数字、+ - * / % ^、括号和常量 pi、e');
  }
  if (!tokens.length) fail('表达式为空');
  if (tokens.length > MAX_TOKENS) fail('表达式过于复杂');
  return tokens;
}

// Values are exact decimals { s, k, a }: s×10^-k, a=近似标记（除不尽传播）。
// Magnitude overflow fails; precision overflow shrinks to MAX_SCALE with a=true.
const check = v => {
  if ((v.s < 0n ? -v.s : v.s).toString().length > MAX_VALUE_DIGITS) fail('计算溢出：结果超过30位数字，请缩小数值范围', 'AI_CALC_OVERFLOW');
  return v;
};
const roundHalfAway = (raw, d) => {
  const q = (raw < 0n ? -raw : raw) * 2n + d;
  return (raw < 0n ? -1n : 1n) * (q / (d * 2n));
};
const norm = v => {
  while (v.k > 0 && v.s % 10n === 0n) { v.s /= 10n; v.k--; }
  if (v.s === 0n) { v.k = 0; return check(v); }
  if (v.k > MAX_SCALE) {
    const d = 10n ** BigInt(v.k - MAX_SCALE);
    v.s = roundHalfAway(v.s, d); v.k = MAX_SCALE; v.a = true;
  }
  return check(v);
};
const align = (a, b) => {
  const k = Math.max(a.k, b.k);
  return [a.s * 10n ** BigInt(k - a.k), b.s * 10n ** BigInt(k - b.k), k];
};
const add = (a, b) => { const [x, y, k] = align(a, b); return norm({ s: x + y, k, a: a.a || b.a }); };
const sub = (a, b) => { const [x, y, k] = align(a, b); return norm({ s: x - y, k, a: a.a || b.a }); };
const mul = (a, b) => norm({ s: a.s * b.s, k: a.k + b.k, a: a.a || b.a });
const div = (a, b) => {
  if (b.s === 0n) fail('除数为零', 'AI_CALC_DIVIDE_BY_ZERO');
  // value = (sa×10^(kb-ka))/sb；放大守卫位求商，余数非零即近似。e=K+kb-ka≥0。
  const K = DIV_GUARD + Math.max(0, a.k - b.k);
  const raw = (a.s < 0n ? -a.s : a.s) * 10n ** BigInt(K + b.k - a.k);
  const d = b.s < 0n ? -b.s : b.s;
  const exact = raw % d === 0n;
  const s = (a.s < 0n) !== (b.s < 0n) ? -roundHalfAway(raw, d) : roundHalfAway(raw, d);
  return norm({ s, k: K, a: a.a || b.a || !exact });
};
const mod = (a, b) => {
  if (b.s === 0n) fail('除数为零', 'AI_CALC_DIVIDE_BY_ZERO');
  const [x, y, k] = align(a, b);
  return norm({ s: x % y, k, a: a.a || b.a });
};
const pow = (base, exp) => {
  if (exp.k !== 0) fail('幂指数必须是整数');
  const n = exp.s;
  if (n > BigInt(MAX_POW) || n < -BigInt(MAX_POW)) fail(`幂指数超出范围（±${MAX_POW}）`);
  if (n < 0n && base.s === 0n) fail('除数为零', 'AI_CALC_DIVIDE_BY_ZERO');
  let r = { s: 1n, k: 0, a: false };
  const times = n < 0n ? -n : n;
  for (let i = 0n; i < times; i++) r = mul(r, base);
  return n < 0n ? div({ s: 1n, k: 0, a: false }, r) : r;
};

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos], take = () => tokens[pos++];
  function expr() {
    let left = term();
    while (peek()?.t === '+' || peek()?.t === '-') { const op = take().t; left = op === '+' ? add(left, term()) : sub(left, term()); }
    return left;
  }
  function term() {
    let left = factor();
    while (['*', '/', '%'].includes(peek()?.t)) {
      const op = take().t, right = factor();
      left = op === '*' ? mul(left, right) : op === '/' ? div(left, right) : mod(left, right);
    }
    return left;
  }
  function factor() { // ^ 右结合
    const base = unary();
    if (peek()?.t === '^') { take(); return pow(base, factor()); }
    return base;
  }
  function unary() {
    if (peek()?.t === '-') { take(); const v = unary(); return { ...v, s: -v.s }; }
    if (peek()?.t === '+') { take(); return unary(); }
    return primary();
  }
  function primary() {
    const tk = take();
    if (!tk) fail('表达式不完整');
    if (tk.t === 'num') return { s: tk.s, k: tk.k, a: false };
    if (tk.t === '(') {
      const v = expr();
      if (peek()?.t !== ')') fail('括号不匹配');
      take(); return v;
    }
    fail('表达式格式不正确');
  }
  const value = expr();
  if (pos < tokens.length) fail('表达式有多余内容');
  return value;
}

// targetK=输出小数位；money 的到分是口径规则，丢位不标近似；number 丢位标近似。
function render(v, targetK, markDropped) {
  let { s, k } = v; let approx = !!v.a;
  if (k < targetK) { s *= 10n ** BigInt(targetK - k); k = targetK; }
  else if (k > targetK) {
    const d = 10n ** BigInt(k - targetK);
    if (markDropped && (s < 0n ? -s : s) % d !== 0n) approx = true;
    s = roundHalfAway(s, d); k = targetK;
  }
  const neg = s < 0n, digits = (neg ? -s : s).toString();
  const full = digits.length < k ? '0'.repeat(k - digits.length) + digits : digits;
  const intPart = k > 0 ? (full.slice(0, full.length - k) || '0') : full;
  const value = (neg ? '-' : '') + (k > 0 ? `${intPart}.${full.slice(full.length - k)}` : intPart);
  return { value, cents: s.toString(), approx };
}

function evaluateCalc(args) {
  const v = parse(lex(args.expression));
  if (args.mode === 'money') {
    const { value, cents, approx } = render(v, 2, false);
    return { expression: args.expression, mode: 'money', value, cents, ...(approx ? { approximate: true } : {}) };
  }
  const { value, approx } = render(v, v.k);
  return { expression: args.expression, mode: 'number', value, ...(approx ? { approximate: true } : {}) };
}

module.exports = { calcDefinitions, validateCalcTool, isCalcTool, evaluateCalc };
