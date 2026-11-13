// Derived facts enter the same approved preview as their source values. They
// are never reconstructed from model prose or a limited detail window.
function cents(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
}
function money(value) {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
}
function percent(numerator, denominator) {
  if (denominator <= 0n) return null;
  const absolute = numerator < 0n ? -numerator : numerator;
  const tenths = (absolute * 1000n + denominator / 2n) / denominator;
  return `${numerator < 0n ? '-' : ''}${tenths / 10n}.${tenths % 10n}`;
}
function pricedSummary(dataset) {
  return dataset.isEstimated !== true && dataset.summary?.currency === 'CNY'
    && dataset.summary.unpricedCount != null && Number(dataset.summary.unpricedCount) === 0
    && dataset.summary.incomplete !== true && dataset.queryMeta?.summaryComplete !== false;
}
function fullMonth(month, effectiveScope) {
  if (!/^20\d{2}-\d{2}$/.test(month || '') || !effectiveScope) return false;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  return effectiveScope.startDate <= `${month}-01` && effectiveScope.endDate >= last;
}
function enrichAnalysisDatasets(datasets = [], { comparisonScopes = [], comparisonDatasets = [], comparisonDirection = 'expense' } = {}) {
  return datasets.map(original => {
    if (original.domain !== 'finance' || !pricedSummary(original)) return original;
    const dataset = { ...original, summary: { ...original.summary }, columns: [...original.columns],
      rows: original.rows.map(row => ({ ...row })) };
    const addColumn = (key, label, type) => {
      if (dataset.columns.length < 20 && !dataset.columns.some(column => column.key === key)) dataset.columns.push({ key, label, type });
    };
    const income = cents(dataset.summary.income), expense = cents(dataset.summary.expense);
    if (income != null && expense != null) {
      const net = income - expense;
      Object.assign(dataset.summary, { net: money(net), surplus: money(net > 0n ? net : 0n), deficit: money(net < 0n ? -net : 0n) });
    }
    if (['finance-monthly', 'finance-daily'].includes(dataset.datasetId)
      && dataset.columns.some(column => column.key === 'income') && dataset.columns.some(column => column.key === 'expense')) {
      addColumn('net', '净收支（收入减支出）', 'money');
      for (const row of dataset.rows) {
        const rowIncome = cents(row.income), rowExpense = cents(row.expense);
        row.net = row.unpricedCount != null && Number(row.unpricedCount) === 0 && rowIncome != null && rowExpense != null ? money(rowIncome - rowExpense) : null;
      }
    }
    if (dataset.datasetId === 'finance-categories') {
      if (dataset.columns.some(column => column.key === 'amountCNY') && dataset.columns.some(column => column.key === 'direction')) {
        addColumn('sharePct', '占本范围同方向收支(%)', 'decimal');
        for (const row of dataset.rows) {
          const denominator = Number(row.direction) === 0 ? expense : Number(row.direction) === 1 ? income : null;
          const amount = cents(row.amountCNY);
          row.sharePct = amount != null && denominator != null && row.unpricedCount != null && Number(row.unpricedCount) === 0 ? percent(amount, denominator) : null;
        }
      }
      if (expense > 0n && dataset.columns.some(column => column.key === 'expense')) {
        addColumn('expenseSharePct', '占本范围支出(%)', 'decimal');
        for (const row of dataset.rows) row.expenseSharePct = cents(row.expense) == null ? null : percent(cents(row.expense), expense);
      }
      if (income > 0n && dataset.columns.some(column => column.key === 'income')) {
        addColumn('incomeSharePct', '占本范围收入(%)', 'decimal');
        for (const row of dataset.rows) row.incomeSharePct = cents(row.income) == null ? null : percent(cents(row.income), income);
      }
    }
    if (dataset.datasetId === 'finance-monthly' && dataset.queryMeta?.rowsComplete === true) {
      const rows = [...dataset.rows].sort((left, right) => String(left.month).localeCompare(String(right.month)));
      const scope = dataset.queryMeta.effectiveScope;
      if (rows.length > 1 && rows.every(row => fullMonth(row.month, scope) && row.unpricedCount != null && Number(row.unpricedCount) === 0 && cents(row.expense) != null)) {
        addColumn('changeAmt', '支出比前一展示月份变化', 'money');
        addColumn('changePct', '支出比前一展示月份变化(%)', 'decimal');
        for (let index = 0; index < rows.length; index++) {
          const previous = index ? cents(rows[index - 1].expense) : null;
          const difference = previous == null ? null : cents(rows[index].expense) - previous;
          rows[index].changeAmt = difference == null ? null : money(difference);
          rows[index].changePct = difference == null ? null : percent(difference, previous);
        }
        if (rows.length === 2) Object.assign(dataset.summary, { difference: rows[1].changeAmt, changePct: rows[1].changePct });
      }
    }
    // Separate month tool results stay distinct. The later approved preview can
    // publish a comparison derived from both already-authorized full summaries.
    if (dataset.datasetId === 'finance-monthly' && comparisonScopes.length === 2) {
      const scopes = [...comparisonScopes].sort((left, right) => left.startDate.localeCompare(right.startDate));
      const sources = scopes.map(scope => [...comparisonDatasets, dataset].filter(item => item.datasetId === 'finance-monthly'
        && pricedSummary(item) && item.queryMeta?.summaryComplete === true
        && item.queryMeta.effectiveScope.startDate === scope.startDate && item.queryMeta.effectiveScope.endDate === scope.endDate
        && fullMonth(scope.startDate.slice(0, 7), scope) && scope.startDate.slice(0, 7) === scope.endDate.slice(0, 7)));
      const first = sources[0].at(-1), second = sources[1].at(-1);
      if (first && second && JSON.stringify(first.queryMeta.filters) === JSON.stringify(second.queryMeta.filters)) {
        const key = comparisonDirection === 'income' ? 'income' : 'expense';
        const before = cents(first.summary[key]), after = cents(second.summary[key]);
        if (before != null && after != null) {
          dataset.summary.difference = money(after - before);
          dataset.summary.changePct = percent(after - before, before);
          dataset.policy = `${dataset.policy || ''} difference/changePct表示${scopes[1].startDate.slice(0, 7)}比${scopes[0].startDate.slice(0, 7)}${key === 'income' ? '收入' : '支出'}变化，来源为本轮两个同口径完整月份查询。`;
        }
      }
    }
    return dataset;
  });
}
module.exports = { enrichAnalysisDatasets, cents, money, percent };
