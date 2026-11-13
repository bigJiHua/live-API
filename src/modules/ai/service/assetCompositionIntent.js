// Account composition has a different grain from one row per account balance.
// Quoted names/filter data do not establish a new query task.
const unquoted = message => String(message || '').normalize('NFKC')
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|`[^`\n]*(?:`|$)/g, ' ');
function affirmed(text, pattern) {
  for (const match of text.matchAll(new RegExp(pattern.source, 'giu'))) {
    const prefix = text.slice(0, match.index).split(/[，,；;。！？!?\n]|但是|但|而是|只要|只看|只查/).at(-1);
    if (!/(?:不要|不用|无需|不需要|不查|不看|不按|不以|(?<!分)别|排除)[^，,；;。！？!?]{0,24}$/.test(prefix)) return true;
  }
  return false;
}
function accountCompositionRequested(message) {
  const text = unquoted(message);
  return !/基金|持仓|投资组合|证券/.test(text)
    && affirmed(text, /账户(?:的)?类型|卡片(?:的)?类型/)
    && affirmed(text, /币种|currency/)
    && affirmed(text, /资产(?:组成|构成)|分组|汇总|组成|构成/);
}
function balanceDetailRequested(message) {
  const text = unquoted(message);
  return affirmed(text, /余额(?:明细|清单|列表)|账户(?:余额)?明细|(?:每个|各个|各|逐个|逐户|逐账户)(?:账户)?(?:的)?余额/)
    || affirmed(text, /余额\s*(?:和|与|及|以及|、|还有|同时|并).{0,24}(?:资产)?(?:组成|构成)/)
    || affirmed(text, /(?:资产)?(?:组成|构成)\s*(?:和|与|及|以及|、|还有|同时|并).{0,24}余额/);
}
function compositionRejected(message) {
  const text = unquoted(message);
  return /资产(?:组成|构成)/.test(text) && !affirmed(text, /资产(?:组成|构成)/);
}
function resolveAssetCompositionMetric(message, metric) {
  if (accountCompositionRequested(message)) return 'asset-composition';
  const text = unquoted(message);
  if (metric === 'asset-composition' && (compositionRejected(text)
    || /全部资产|所有资产|基金|持仓|投资组合|资产(?:快照|登记|比较)|手工资产|系统保存净值/.test(text)
    || balanceDetailRequested(text) && !affirmed(text, /资产(?:组成|构成)/))) return 'summary';
  return metric;
}
function requiresAssetCompositionDataset({ message, taskContext, bindings = [] } = {}) {
  const tasks = bindings.length ? bindings : [{ text: message, taskContext }];
  // A separate account task or an explicit balance-detail request authorizes a
  // legitimate second read. It does not turn that detail into composition.
  if (tasks.some(binding => binding.taskContext?.subject === 'account' || balanceDetailRequested(binding.text))) return false;
  const composition = tasks.filter(binding => binding.taskContext?.mode === 'query'
    && binding.taskContext.subject === 'asset' && binding.taskContext.metric === 'asset-composition');
  return composition.length === 1 && !compositionRejected(composition[0].text);
}
module.exports = { accountCompositionRequested, balanceDetailRequested, resolveAssetCompositionMetric, requiresAssetCompositionDataset };
