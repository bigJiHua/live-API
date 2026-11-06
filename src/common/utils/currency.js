// 货币换算工具
// 汇率约定（与前端 exchangedAmount、清算中心一致）：
//   rate = "100 外币 = rate 人民币"，即 1 外币 = rate / 100 人民币
// 入账时按交易汇率冻结折算，CNY 原值返回。
const { roundDecimal, multiplyDecimal, formatDecimal } = require('./decimal');

function toCNY(amount, currency, exchangeRate) {
  if (!currency || currency === "CNY") {
    // 人民币按“分”取整（货币最小单位），属正常口径而非随意四舍五入
    return roundDecimal(amount, 2);
  }
  const rate = Number(exchangeRate);
  // 十进制乘除后截到4位；39.91不能因倍率产生的浮点尾差变成39.9099。
  return multiplyDecimal(amount, Number.isFinite(rate) && rate !== 0 ? exchangeRate : 1, 2, 4);
}

// 金额格式化（用于展示/拼接文案）：截断到 4 位小数、最少 2 位、千分位、不四舍五入。
// 例：1234.5 → "1,234.50"；9.1132 → "9.1132"。
function formatCNY(amount) {
  return formatDecimal(amount);
}

module.exports = { toCNY, formatCNY };
