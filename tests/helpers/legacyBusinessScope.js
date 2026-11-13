// Archived V2 natural-language preview scope; test-only.
const { AiError } = require('../../src/modules/ai/service/errors');
const { todayShanghai } = require('../../src/modules/ai/service/validation');
const { validateScope } = require('../../src/modules/ai/service/businessRead');
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const monthStart = (date, offset = 0) => {
  const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + offset); return value.toISOString().slice(0, 10);
};
function deriveBusinessScope(input, message, now = new Date()) {
  const today = todayShanghai(now); let startDate = monthStart(today), endDate = today;
  const numbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const number = token => /^\d+$/.test(token) ? Number(token) : numbers[token];
  let match;
  if ((match = /(?:近|最近|过去)(\d+|十二|十一|十|[一二两三四五六七八九])个?月/.exec(message))) {
    const months = number(match[1]); if (!months || months > 12) throw new AiError('单次分析最多十二个月', 400, 'AI_SCOPE_INVALID');
    startDate = monthStart(today, -(months - 1));
  } else if ((match = /(?:近|最近|过去)(\d+|十|[一二两三四五六七八九])天/.exec(message))) {
    const days = number(match[1]); if (!days || days > 365) throw new AiError('单次分析最多365天', 400, 'AI_SCOPE_INVALID');
    startDate = addDays(today, -(days - 1));
  } else if (/上个?月/.test(message)) { startDate = monthStart(today, -1); endDate = addDays(monthStart(today), -1); }
  else if (/今年|本年/.test(message)) startDate = today.slice(0, 4) + '-01-01';
  else if (/昨天/.test(message)) startDate = endDate = addDays(today, -1);
  else if (/今天|今日/.test(message)) startDate = endDate = today;
  if (input.domains.includes('todo') && /未来|明天|后天|下周|下个?月/.test(message)) {
    const futureDays = /未来(?:的)?(\d+|[一二两三四五六七八九十])天/.exec(message);
    const days = futureDays ? number(futureDays[1]) : /后天/.test(message) ? 2 : /明天/.test(message) ? 1 : /下周|未来一周/.test(message) ? 7 : 30;
    if (!days || days > 365) throw new AiError('未来待办范围最多365天', 400, 'AI_SCOPE_INVALID');
    startDate = /明天|后天/.test(message) ? addDays(today, days) : today; endDate = addDays(today, days);
  }
  const explicit = message.match(/20\d{2}-\d{2}-\d{2}/g);
  if (explicit?.length) {
    const unique = [...new Set(explicit)].sort(); startDate = unique[0]; endDate = unique.at(-1);
  }
  return validateScope({ ...input, startDate: input.startDate || startDate, endDate: input.endDate || endDate }, now);
}
module.exports = { deriveBusinessScope };
