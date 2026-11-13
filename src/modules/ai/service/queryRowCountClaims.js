// Named counts are attached to approved row identities, never a shared numeric pool.
const TYPE_LABELS = {
  debit: ['debit', '借记卡', '借记'], credit: ['credit', '信用卡', '信用'],
  virtual_balance: ['virtual_balance', '虚拟余额', '余额账户'],
  virtual_cash: ['virtual_cash', '虚拟现金', '现金账户', '现金'],
  virtual_wechat: ['virtual_wechat', '微信'], virtual_alipay: ['virtual_alipay', '支付宝'],
};
function rowIdentityLabels(row) {
  const primary = ['name', 'category', 'content', 'title', 'company'].map(key => String(row[key] || '').trim()).filter(label => label.length >= 2);
  return primary.length ? primary : [...new Set([String(row.type || ''), ...(TYPE_LABELS[row.type] || [])])].filter(label => label.length >= 2);
}
function rowHasPrimaryIdentity(row) { return ['name', 'category', 'content', 'title', 'company'].some(key => String(row[key] || '').trim().length >= 2); }
function lastIdentityIndex(text, label) {
  let index = text.lastIndexOf(label);
  while (index >= 0) {
    const before = text[index - 1] || '', after = text[index + label.length] || '';
    if (!(label.startsWith('信用') && before === '非')
      && !(['信用', '借记'].includes(label) && after && !/[\s\d：:，,。；;\/|()（）]/.test(after))) return index;
    if (index === 0) return -1;
    index = text.lastIndexOf(label, index - 1);
  }
  return -1;
}
// Daily count facts belong to one approved date row, not the whole-month count.
function dailyRowCountEvidence(before, after, datasets, value, unit, fieldHint) {
  if (!fieldHint && !['笔', '条'].includes(unit)) return null;
  const daily = datasets.filter(dataset => dataset.datasetId === 'finance-daily' && dataset.queryMeta?.queryId);
  if (!daily.length) return null;
  const clause = before.split(/[。；;！？\n、]/).at(-1);
  // Period totals keep their existing full-range verification. A range or two
  // dates is not a uniquely identified daily row.
  if (/(?:全月|全期|全范围|整个(?:月|区间|范围)|合计|来源|日期范围|读取范围|截至)/.test(clause)) return null;
  const tokens = [...clause.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b|(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)];
  if (tokens.length !== 1) return null;
  const token = tokens[0], explicitYear = token[1] || token[4], month = token[2] || token[5], day = token[3] || token[6];
  const tail = clause.slice(token.index + token[0].length), lastPart = tail.split(/[，,]/).at(-1);
  const direction = /(支出|收入)(?:流水|记录|明细)?\s*(?:笔数)?\s*(?:共|共有|一共|共计|有|为|是)?\s*$/.exec(lastPart)?.[1]
    || /^\s*(支出|收入)/.exec(after)?.[1];
  const field = fieldHint && fieldHint !== 'count' ? fieldHint : /未定价/.test(lastPart) ? 'unpricedCount'
    : direction === '支出' ? 'expenseCount' : direction === '收入' ? 'incomeCount' : 'count';
  const matches = [];
  for (const dataset of daily) {
    const scope = dataset.queryMeta.effectiveScope;
    if (!scope || (!explicitYear && scope.startDate.slice(0, 4) !== scope.endDate.slice(0, 4))) continue;
    const year = explicitYear || scope.startDate.slice(0, 4);
    const date = year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0');
    const parsed = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
      || date < scope.startDate || date > scope.endDate) continue;
    if (!(dataset.columns || []).some(column => column.key === 'date' && column.type === 'date')) continue;
    for (const row of dataset.rows || []) if (row.date === date) matches.push({ dataset, row });
  }
  if (!matches.length) return false;
  const queries = new Set(matches.map(item => item.dataset.queryMeta.queryId));
  if (queries.size !== 1 || matches.length !== 1) return false;
  const { dataset, row } = matches[0];
  return (dataset.columns || []).some(column => column.key === field && column.type === 'number')
    && row[field] != null && Number(row[field]) === value;
}
function monthlyRowCountEvidence(before, after, datasets, value, unit, fieldHint) {
  if (!fieldHint && !['笔', '条'].includes(unit)) return null;
  const monthly = datasets.filter(dataset => dataset.datasetId === 'finance-monthly' && dataset.queryMeta?.queryId);
  if (!monthly.length) return null;
  const clause = before.split(/[。；;！？\n、]/).at(-1);
  const days = [...clause.matchAll(/\b20\d{2}-\d{2}-\d{2}\b|(?:(?:20\d{2})\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日/g)];
  // A monthly row cannot establish a daily count. A stated date range keeps
  // the existing complete-range count path rather than becoming a day claim.
  if (days.length === 1 && !/(?:全范围|读取范围|查询范围|截至)/.test(clause)) return false;
  if (days.length > 0) return null;
  const months = [...clause.matchAll(/\b(20\d{2})-(\d{2})\b|(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月/g)];
  if (!months.length || months.length > 1 && !/[，,]/.test(clause.slice(months.at(-2).index + months.at(-2)[0].length, months.at(-1).index))) return null;
  const token = months.at(-1), explicitYear = token[1] || token[3], month = token[2] || token[4];
  const tail = clause.slice(token.index + token[0].length), lastPart = tail.split(/[，,]/).at(-1);
  const direction = /(支出|收入)(?:流水|记录|明细)?\s*(?:笔数)?\s*(?:共|共有|一共|共计|有|为|是)?\s*$/.exec(lastPart)?.[1]
    || /^\s*(支出|收入)/.exec(after)?.[1];
  const field = fieldHint && fieldHint !== 'count' ? fieldHint : /未定价/.test(lastPart) ? 'unpricedCount'
    : direction === '支出' ? 'expenseCount' : direction === '收入' ? 'incomeCount' : 'count';
  const matches = [];
  for (const dataset of monthly) {
    const scope = dataset.queryMeta.effectiveScope;
    if (!scope || (!explicitYear && scope.startDate.slice(0,4) !== scope.endDate.slice(0,4))) continue;
    const target = (explicitYear || scope.startDate.slice(0,4)) + '-' + month.padStart(2,'0');
    if (!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(target) || target < scope.startDate.slice(0,7) || target > scope.endDate.slice(0,7)) continue;
    if (!(dataset.columns || []).some(column => column.key === 'month' && column.type === 'date')) continue;
    for (const row of dataset.rows || []) if (row.month === target) matches.push({dataset,row});
  }
  if (!matches.length || matches.length !== 1 || new Set(matches.map(item=>item.dataset.queryMeta.queryId)).size !== 1) return false;
  const {dataset,row} = matches[0];
  if ((dataset.columns || []).some(column => column.key === field && column.type === 'number')
    && row[field] != null) return Number(row[field]) === value;
  // A complete query for this exact entire month is itself the full-range
  // evidence. This exception cannot turn a multi-month total into one month.
  if (['incomeCount','expenseCount'].includes(field) && dataset.queryMeta.summaryComplete === true) {
    const scope=dataset.queryMeta.effectiveScope;
    const last=new Date(Date.UTC(Number(row.month.slice(0,4)),Number(row.month.slice(5)),0)).toISOString().slice(0,10);
    return scope.startDate===row.month+'-01' && scope.endDate===last && dataset.summary?.[field]!=null
      && Number.isSafeInteger(Number(dataset.summary[field])) && Number(dataset.summary[field])===value;
  }
  return false;
}
function validFundRecordCountClaims(sentence, datasets = []) {
  const funds = datasets.filter(dataset => ['fund-history','fund-holdings'].includes(dataset.datasetId));
  if (!funds.length) return true;
  const onlyFunds = funds.length === datasets.length;
  const aliases = ['基金','收益记录','收益历史','收益登记','fund','profit record'];
  const patterns = [
    {regex:/((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(笔|条|行|只基金|只|个基金)/g},
    {regex:/(笔数|记录数|条数)[：:]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g,labelled:true}
  ];
  for (const {regex,labelled} of patterns) for (const token of String(sentence || '').matchAll(regex)) {
    const numeric = labelled ? token[2] : token[1], value = Number(numeric.replace(/,/g,''));
    const offset = token.index + (labelled ? token[0].lastIndexOf(numeric) : 0);
    const before = sentence.slice(0,offset), after = sentence.slice(token.index+token[0].length);
    const clause = before.split(/[。；;！？\n、]/).at(-1), unit = labelled ? '笔' : token[2];
    const named = funds.flatMap(dataset => (dataset.rows || []).map(row=>String(row.name || '').trim())).filter(Boolean);
    if (!onlyFunds && !aliases.some(alias=>clause.toLowerCase().includes(alias)) && !named.some(name=>clause.includes(name))) continue;
    if (!Number.isSafeInteger(value) || /[-−负]\s*$/.test(before)) return false;
    const days = [...clause.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b|(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)];
    const periodWords = /(?:全范围|读取范围|查询范围|来源|截至)/.test(clause);
    if (days.length === 1 && !periodWords) {
      // Fund history is one record per row, not a per-date count aggregate.
      // A date-specific count needs an explicitly published numeric row cell.
      const token = days[0], year = token[1] || token[4], month = token[2] || token[5], day = token[3] || token[6], matches=[];
      const lastPart = clause.slice(token.index + token[0].length).split(/[，,]/).at(-1);
      const direction = /(支出|收入)(?:流水|记录|明细)?\s*(?:笔数)?\s*(?:共|共有|一共|共计|有|为|是)?\s*$/.exec(lastPart)?.[1]
        || /^\s*(支出|收入)/.exec(after)?.[1];
      const field = direction === '支出' ? 'expenseCount' : direction === '收入' ? 'incomeCount' : 'count';
      for (const dataset of funds) {
        const scope=dataset.queryMeta?.effectiveScope;
        if (!scope || !year && scope.startDate.slice(0,4)!==scope.endDate.slice(0,4)) continue;
        const date=(year||scope.startDate.slice(0,4))+'-'+month.padStart(2,'0')+'-'+day.padStart(2,'0');
        const rowNames=(dataset.rows || []).map(row=>String(row.name||'')).filter(name=>name&&clause.includes(name));
        if (!(dataset.columns || []).some(column=>column.key==='date'&&column.type==='date')) continue;
        for(const row of dataset.rows || [])if(row.date===date&&(!rowNames.length||rowNames.includes(row.name)))matches.push({dataset,row});
      }
      if(matches.length!==1 || !matches[0].dataset.queryMeta?.queryId
        || !(matches[0].dataset.columns || []).some(column=>column.key===field&&column.type==='number')
        || matches[0].row[field]==null || Number(matches[0].row[field])!==value) return false;
      continue;
    }
    const months = days.length ? [] : [...clause.matchAll(/\b(20\d{2})-(\d{2})\b|(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月/g)];
    if (months.length===1 && !periodWords) {
      // Date-grain fund records cannot prove a month subtotal by borrowing a
      // full-query count, even if that count also occurs as a money value.
      const token=months[0],year=token[1]||token[3],month=token[2]||token[4],matches=[];
      const lastPart=clause.slice(token.index+token[0].length).split(/[，,]/).at(-1);
      const direction=/(支出|收入)(?:流水|记录|明细)?\s*(?:笔数)?\s*(?:共|共有|一共|共计|有|为|是)?\s*$/.exec(lastPart)?.[1]
        || /^\s*(支出|收入)/.exec(after)?.[1];
      const field=direction==='支出'?'expenseCount':direction==='收入'?'incomeCount':'count';
      for(const dataset of funds){
        const scope=dataset.queryMeta?.effectiveScope;
        if(!scope||!year&&scope.startDate.slice(0,4)!==scope.endDate.slice(0,4))continue;
        const target=(year||scope.startDate.slice(0,4))+'-'+month.padStart(2,'0');
        if(!(dataset.columns||[]).some(column=>column.key==='month'&&column.type==='date'))continue;
        for(const row of dataset.rows||[])if(row.month===target)matches.push({dataset,row});
      }
      if(matches.length!==1||!(matches[0].dataset.columns||[]).some(column=>column.key===field&&column.type==='number')
        ||matches[0].row[field]==null||Number(matches[0].row[field])!==value)return false;
      continue;
    }
    const prefix = clause.split(/[，,]/).at(-1).trim();
    const returned = /(?:返回|展示|显示|列出|截取)(?:了|的)?\s*(?:前|最近)?\s*(?:共|共有|总共)?\s*$/.test(prefix);
    if (/(?:剩余|其余|未展示|未返回)\s*$/.test(prefix)) return false;
    const isHolding = /只|个基金/.test(unit), candidates = funds.filter(dataset=>!isHolding||dataset.datasetId==='fund-holdings');
    const nameMatches = named.filter(name=>clause.includes(name));
    const expected = candidates.filter(dataset=>{
      if(days.length>1||days.length&&periodWords){
        const scope=dataset.queryMeta?.effectiveScope;
        if(!scope)return false;
        const dates=days.map(token=>{
          const year=token[1]||token[4],month=token[2]||token[5],day=token[3]||token[6];
          if(!year&&scope.startDate.slice(0,4)!==scope.endDate.slice(0,4))return null;
          return(year||scope.startDate.slice(0,4))+'-'+month.padStart(2,'0')+'-'+day.padStart(2,'0');
        });
        if(dates.some(date=>date===null))return false;
        if(days.length===1){
          if(/截至/.test(clause)){if(dates[0]!==scope.endDate)return false;}
          else if(dates[0]!==scope.startDate||dates[0]!==scope.endDate)return false;
        }else if(days.length!==2||dates[0]!==scope.startDate||dates[1]!==scope.endDate)return false;
      }
      if(months.length===1&&periodWords){
        const scope=dataset.queryMeta?.effectiveScope,token=months[0];
        if(!scope)return false;
        const year=token[1]||token[3]||scope.startDate.slice(0,4),month=token[2]||token[4],target=year+'-'+month.padStart(2,'0');
        if(target!==scope.startDate.slice(0,7)||target!==scope.endDate.slice(0,7))return false;
      }
      if(nameMatches.length&&!/(?:全范围|总计|合计|本次|查询范围|匹配)/.test(clause)) {
        const names = new Set((dataset.rows || []).map(row=>row.name));
        if(!dataset.queryMeta?.rowsComplete||names.size!==1||!nameMatches.includes([...names][0]))return false;
      }
      return true;
    }).map(dataset=>returned ? dataset.queryMeta?.returnedRowCount : dataset.queryMeta?.matchedRowCount);
    if(!expected.some(count=>count!=null&&Number.isSafeInteger(count)&&count===value))return false;
  }
  return true;
}
function namedRowCountEvidence(before, after, datasets, value, unit, fieldHint = null, month = null) {
  if (!fieldHint && !['笔', '条', '账户', '个账户', '张', '张卡', '张卡片'].includes(unit)) return null;
  const clause = before.split(/[。；;！？\n、]/).at(-1);
  const lastPart = clause.split(/[，,]/).at(-1);
  if (/(?:全月|全期|全部|全范围|整个|匹配|来源|总共|总计|合计)/.test(lastPart)
    && !/(?:账户数|卡片数|笔数|未定价|缺快照)/.test(lastPart)) return null;
  const matches = [];
  for (const dataset of datasets) for (const row of dataset.rows || []) for (const label of rowIdentityLabels(row)) {
    const index = lastIdentityIndex(clause, label);
    if (index >= 0) matches.push({ dataset, row, index, end: index + label.length, label, primary: rowHasPrimaryIdentity(row) });
  }
  if (!matches.length) {
    const daily = dailyRowCountEvidence(before, after, datasets, value, unit, fieldHint);
    return daily === null ? monthlyRowCountEvidence(before, after, datasets, value, unit, fieldHint) : daily;
  }
  matches.sort((a, b) => Number(b.primary) - Number(a.primary) || b.end - a.end || b.label.length - a.label.length);
  const nearest = matches.filter(item => item.end === matches[0].end && item.label === matches[0].label);
  const labelBefore = clause.slice(0, matches[0].index), labelAfter = clause.slice(matches[0].end);
  const direction = /(支出|收入)(?:分类)?\s*[：:·-]?\s*$/.exec(labelBefore)?.[1]
    || /^(?:分类)?(?:的)?\s*(支出|收入)/.exec(labelAfter)?.[1]
    || /^\s*(支出|收入)/.exec(after)?.[1];
  const currency = /\b(?:CNY|USD|EUR|GBP|JPY|HKD|AUD|CAD|CHF|SGD)\b|未登记/.exec(labelAfter)?.[0];
  const selected = nearest.filter(item => (!direction || item.row.direction == null || item.row.direction === (direction === '支出' ? 0 : 1))
    && (!currency || !item.row.currency || item.row.currency === currency));
  const identities = new Set(selected.map(item => JSON.stringify([item.dataset.datasetId, item.dataset.queryMeta?.effectiveScope,
    item.row.name, item.row.category, item.row.month, item.row.type, item.row.currency, item.row.direction])));
  // Different scopes or months sharing a label cannot prove a unique row fact.
  if (identities.size !== 1) return false;
  const key = fieldHint || (/未定价/.test(labelAfter) ? 'unpricedCount' : /缺快照/.test(labelAfter) ? 'missingSnapshots' : 'count');
  return selected.some(item => {
    if (month && item.dataset.datasetId === 'finance-categories' && item.dataset.queryMeta) {
      const scope = item.dataset.queryMeta.effectiveScope;
      if (scope.startDate.slice(0, 7) !== scope.endDate.slice(0, 7)) return false;
    }
    const column = (item.dataset.columns || []).find(column => column.key === key && column.type === 'number');
    return Boolean(column) && item.row[key] != null && Number(item.row[key]) === value;
  });
}
function validTypedRowCountClaims(sentence, datasets = []) {
  const patterns = [
    { pattern: /((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(个账户|账户|张卡片|张卡|张)(?![\w])/g },
    { pattern: /(账户数|卡片数|笔数|未定价笔数|未定价|缺快照(?:或币种)?)[：:]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g, labelled: true },
  ];
  for (const { pattern, labelled } of patterns) for (const token of sentence.matchAll(pattern)) {
    const numberToken = labelled ? token[2] : token[1], value = Number(numberToken.replace(/,/g, ''));
    if (!Number.isSafeInteger(value)) return false;
    const numberOffset = token.index + (labelled ? token[0].lastIndexOf(numberToken) : 0);
    const before = sentence.slice(0, numberOffset), after = sentence.slice(token.index + token[0].length);
    if (/[-−负]\s*$/.test(before)) return false;
    const field = !labelled ? null : /未定价/.test(token[1]) ? 'unpricedCount' : /缺快照/.test(token[1]) ? 'missingSnapshots' : 'count';
    const supported = namedRowCountEvidence(before, after, datasets, value, labelled ? '' : token[2], field);
    if (supported === false) return false;
  }
  return true;
}
module.exports = { rowIdentityLabels, rowHasPrimaryIdentity, lastIdentityIndex, namedRowCountEvidence, validTypedRowCountClaims, monthlyRowCountEvidence, validFundRecordCountClaims };
