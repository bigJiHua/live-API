// Monthly totals can explain changes, but do not identify an individual
// transaction. A more conversational answer must keep that evidence boundary.
function validMonthlyTransactionClaims(sentence, datasets = []) {
  if (!datasets.length || !datasets.every(dataset => dataset.datasetId === 'finance-monthly')) return true;
  if (/不能|无法|不代表|不等于|未证明|并非/.test(sentence)) return true;
  const claims = [...String(sentence || '').matchAll(/(?:这|那|某|一)(?:一)?笔[^，,。；;！？\n]{0,8}?(收入|支出)/g)];
  return claims.every(claim => {
    const direction = claim[1] === '收入' ? 'income' : 'expense';
    // One proven source transaction is enough; a shared monetary value or a
    // monthly total count cannot establish a particular income/expense.
    const proven = datasets.filter(dataset => dataset.queryMeta?.summaryComplete === true
      && dataset.summary?.[direction + 'Count'] === 1 && Number(dataset.summary?.[direction]) > 0);
    return proven.length === 1;
  });
}
module.exports = { validMonthlyTransactionClaims };
