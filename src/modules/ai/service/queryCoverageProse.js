const { normalizeQueryMetadataProse } = require('./queryMetadataProse');
const { clearEmptyQueryTables } = require('./queryEmptyTableProse');
const { getDatasetCapability } = require('./datasetCapabilities');
const { normalizeInstallmentSavedStateClaims } = require('./queryInstallmentStateClaims');
const { normalizeFinanceSavedStateClaims } = require('./queryFinanceSavedStateClaims');
const { validQueryPage } = require('./queryMetadata');

function normalizeSavedStateClaims(text, datasets) {
  return normalizeFinanceSavedStateClaims(normalizeInstallmentSavedStateClaims(text, datasets), datasets);
}

function queryCoverageProse(datasets) {
  const seen = new Set(), lines = [];
  for (const dataset of datasets) {
    const meta = dataset.queryMeta;
    if (!meta) continue;
    const key = JSON.stringify([dataset.datasetId, meta.effectiveScope, meta.filters, meta.groupBy, meta.resolution, meta.page?.offset]);
    if (seen.has(key)) continue;
    seen.add(key);
    const semantics = getDatasetCapability(dataset.datasetId)?.datePolicy.semantics;
    const range = semantics === 'saved-state' ? '目前已保存状态'
      : semantics === 'mixed-plan-state' ? `目前保存计划，期次状态范围 ${meta.effectiveScope.startDate} 至 ${meta.effectiveScope.endDate}`
        : `${meta.effectiveScope.startDate} 至 ${meta.effectiveScope.endDate}`;
    const labels = [];
    if (dataset.domain === 'finance' || dataset.datasetId === 'card-monthlyConsumption') {
      const direction = { expense: '支出', income: '收入', both: '收入和支出' }[meta.filters?.direction];
      if (direction) labels.push(direction);
    }
    const grains = { 'finance-monthly': '按月汇总', 'finance-daily': '按日汇总',
      'finance-categories': '按分类汇总', 'finance-transactions': '逐笔明细', 'card-counts': '按卡片类型计数' };
    const period = meta.resolution === 'year' ? '年' : meta.resolution === 'month' ? '月' : null;
    const snapshots = ['asset-snapshots', 'asset-registers'].includes(dataset.datasetId);
    const grain = dataset.datasetId === 'card-monthlyConsumption'
      ? meta.groupBy === 'card' ? '逐卡区间累计消费' : period === '年' ? '逐卡逐年消费' : '逐卡逐月消费'
      : period ? snapshots ? `各${period}末最新保存记录` : `按${period}汇总` : grains[dataset.datasetId];
    if (grain) labels.push(grain);
    if (typeof meta.filters?.text === 'string' && meta.filters.text) labels.push(`文字筛选“${meta.filters.text.replace(/\s+/g, ' ')}”`);
    const typeLabels = { credit: '信用卡', debit: '借记卡', virtual_cash: '现金', virtual_balance: '虚拟余额',
      virtual_wechat: '微信', virtual_alipay: '支付宝' };
    if (meta.filters?.cardTypes?.length) labels.push(`卡片类型：${meta.filters.cardTypes.map(type => typeLabels[type] || '其他卡片类型').join('、')}`);
    const label = labels.length ? `（${labels.join('，')}）` : '';
    const matched = meta.matchedRowCount === null ? '全范围匹配数量尚未确定'
      : `匹配 ${meta.matchedRowCount} 行`;
    const sourceUnits = { 'card-counts': '张卡片', 'card-cards': '张卡片',
      'account-balances': '个账户', 'asset-composition': '个账户' };
    const source = meta.sourceRecordCount === null ? '' : `，来源 ${meta.sourceRecordCount} ${sourceUnits[dataset.datasetId] || '笔记录'}`;
    const page = validQueryPage(meta.page, meta) ? meta.page : null;
    const continuation = page?.hasMore ? ' 仍有匹配结果，可继续查询下一页。'
      : page?.offset > 0 ? ' 已到最后一页，本页不代表全部匹配记录。' : '';
    lines.push(`${dataset.title}${label}：${range}，${matched}，本次展示 ${meta.returnedRowCount} 行${source}。${continuation}`);
  }
  return lines.join('\n');
}

function clearOrphanQueryHeadings(text) {
  const lines = clearEmptyQueryTables(text).split('\n');
  const heading = line => /^(?:#{1,6}\s*)?(?:\*\*)?[^：:\n]{1,100}[：:](?:\*\*)?\s*$/.test(line.trim());
  const listHeading = line => /^(?:#{1,6}\s*)?(?:\*\*)?(?:收入|支出|收支|分类|账户|卡片|明细|列表)[：:](?:\*\*)?\s*$/.test(line.trim())
    || /(?:如下|明细|列表|按金额.*(?:分类|排行|排序).*|(?:展示|列出).*前\s*\d+.*)[：:](?:\*\*)?\s*$/.test(line.trim());
  const explanation = line => /^(?:实际读取|数据范围|查询范围|范围说明|本次仅|说明|注意|所有金额|不同币种|未展示)/.test(line.trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!listHeading(lines[index])) continue;
    const next = lines.slice(index + 1).find(line => line.trim());
    if (!next || heading(next) && listHeading(next) || explanation(next)) lines[index] = '';
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeQueryPagination(text, datasets = []) {
  if (datasets.some(dataset => validQueryPage(dataset.queryMeta?.page, dataset.queryMeta)
    && dataset.queryMeta.page.hasMore)) return String(text || '');
  const saved = datasets.length > 0 && datasets.every(dataset => getDatasetCapability(dataset.datasetId)?.datePolicy.semantics === 'saved-state');
  const keys = new Set(datasets.flatMap(dataset => (dataset.columns || []).filter(column => column.type === 'text').map(column => column.key)));
  const field = ['name', 'title', 'company'].some(key => keys.has(key)) ? '名称'
    : keys.has('category') ? '分类' : keys.has('content') ? '内容' : keys.has('type') ? '类型' : null;
  const action = field ? '按' + field + '筛选' + (saved ? '' : '或缩小日期范围') + '后继续查看'
    : saved ? '缩小查询范围后继续查看' : '缩小日期范围后继续查看';
  return String(text || '').replace(/(?:继续|接着)?(?:按)?(?:分页|翻页|下一页)(?:继续|接着)?(?:查看|查询|浏览|展示|读取|获取)?/g,
    (token, offset, whole) => /(?:不|不能|无法|不支持)\s*$/.test(whole.slice(0, offset)) ? token : action);
}

// Date advice is scoped to the named dataset. Current saved state is not a
// historical date window; a dated sibling query keeps its own useful advice.
const GUIDANCE_SUBJECT_ALIASES = {
  'account-balances': ['账户余额', '账户余额快照', '余额快照', 'account balances', 'balance snapshots'],
  'card-cards': ['卡片清单', '卡片配置', '卡片设置', 'card list', 'card settings'],
  'card-counts': ['卡片数量', '卡片计数', 'card counts'],
  'card-pools': ['共享额度池', '共享池配置', '共享池', 'shared limit pools'],
  'work-rules': ['工资规则', '工作规则', '工资配置', '基本工资配置', '时薪配置', 'salary rules', 'work rules', 'salary configuration'],
  'asset-composition': ['资产组成', '账户余额组成', '余额组成', 'asset composition'],
  'fixedAsset-saved': ['固定资产', '固定资产账面', 'fixed assets'],
  'fund-holdings': ['基金持仓', '基金登记汇总', '持仓登记', 'fund holdings'],
  'work-salary': ['每日工资', '工资登记', '工资流水', '工资历史', '工资记录', 'daily salary', 'salary history', 'salary records'],
  'fund-history': ['基金收益历史', '基金历史', '基金每日收益', '收益登记历史', '收益历史', 'fund history', 'daily fund profit'],
  'card-repayments': ['还款历史', '还款记录', '还款流水', 'repayment history', 'repayment records'],
  'card-bills': ['信用卡账单', '账单快照', 'credit card bills'],
  'finance-transactions': ['收支明细', '收支流水', '交易流水', 'transaction history'],
  'finance-monthly': ['月度收支', '收支月度', 'monthly income and expenses'],
  'finance-daily': ['每日收支', '收支日汇总', 'daily income and expenses'],
  'finance-categories': ['分类收支', 'category income and expenses'],
  'budget-plans': ['预算计划', 'budget plans'],
  'todo-events': ['待办日程', '日程记录', 'todo events'],
  'asset-snapshots': ['系统流动资产快照', '流动资产系统快照', 'system asset snapshots'],
  'asset-registers': ['手工资产登记', 'manual asset records'],
  'asset-comparison': ['同日资产对照', 'asset comparison'],
  'card-monthlyConsumption': ['卡片消费', '卡月消费', 'card consumption'],
  'installment-plans': ['分期计划', '分期期次', 'installment plans'],
};
function hasSavedStateDateSearchClaim(clause) {
  const outside = /(?:可能|也许|或许)[^，,。；;！？\n]{0,35}(?:保存在|记录在|登记在|存在于|落在|在)[^，,。；;！？\n]{0,25}(?:(?:范围|区间)(?:之外|外)|(?:其他|其它|别的|更早)月份)|(?:(?:范围|区间)(?:之外|外)|(?:其他|其它|别的)月份)[^，,。；;！？\n]{0,20}(?:可能有|可能存在|有记录|有规则)|(?:may|might|perhaps)[^,.;!?\n]{0,35}(?:outside[^,.;!?\n]{0,20}(?:range|period)|other months)/i;
  const search = /(?:可(?:以)?|能(?:够)?|建议|需要|再|继续|尝试|通过|请|我会)[^，,。；;！？\n]{0,25}(?:扩大|扩展|放宽|调整|更换|换|按)[^，,。；;！？\n]{0,20}(?:日期|时间|月份|范围|区间)[^，,。；;！？\n]{0,35}(?:查|找|读取|检索|获取|匹配)|(?:扩大|扩展|放宽|调整|更换|换)[^，,。；;！？\n]{0,15}(?:日期|时间|月份|范围|区间)[^，,。；;！？\n]{0,15}(?:可|能|就|会|再|继续)[^，,。；;！？\n]{0,20}(?:查|找|读取|检索|获取|匹配)|(?:can|could|should|try|need to)[^,.;!?\n]{0,20}(?:widen|expand|change|extend|other)[^,.;!?\n]{0,20}(?:date|range|period|month)[^,.;!?\n]{0,20}(?:find|query|search|read)/i;
  if (!outside.test(clause) && !search.test(clause)) return false;
  // A true denial of date expansion is useful evidence, not bad guidance.
  const denied = /(?:不能|不会|无法|不支持|不应|不要|无需|不必|不可能)[^，,。；;！？\n]{0,30}(?:扩大|扩展|放宽|调整|更换|按|查|找|增加|范围外|范围之外|其他月份)|(?:扩大|扩展|放宽|调整|更换)[^，,。；;！？\n]{0,20}(?:不会|不能|无法|不支持)[^，,。；;！？\n]{0,20}(?:查|找|增加)|(?:cannot|can't|won't|should not|do not|does not)[^,.;!?\n]{0,35}(?:expand|widen|change|find|query|search|outside)/i;
  if (denied.test(clause)) return false;
  // Matching a timestamp/name keyword is a real text filter, not a claim that
  // changing the start/end date would reveal otherwise hidden saved records.
  if (/(?:名称|名字|关键词|文字|文本|name|keyword|text|filter)[^，,。；;！？\n]{0,20}(?:筛选|匹配|包含|搜索|filter|match|contain|search)/i.test(clause)
    && !/(?:扩大|扩展|放宽|起止日期|start date|end date)/i.test(clause)) return false;
  return true;
}
function correctSavedStateDateGuidance(text, datasets = []) {
  const original = String(text || ''), notices = new Map();
  const unresolved = { saved: false };
  const subjects = datasets.map(dataset => ({ dataset,
    saved: getDatasetCapability(dataset.datasetId)?.datePolicy.semantics === 'saved-state',
    aliases: [...new Set([dataset.datasetId, dataset.title, ...(GUIDANCE_SUBJECT_ALIASES[dataset.datasetId] || [])])].filter(Boolean),
  }));
  if (!subjects.some(subject => subject.saved)) return original;
  const subjectFor = clause => {
    const lower = clause.toLowerCase();
    const matches = subjects.flatMap(subject => subject.aliases.map(alias => ({ subject, alias, index: lower.lastIndexOf(String(alias).toLowerCase()) })))
      .filter(match => match.index >= 0);
    // N15 uses “规则” immediately after describing work-rules. This narrow
    // fallback is unavailable when this clause names a dated salary subject.
    if (!matches.length && /规则|\brules\b/i.test(clause)) {
      const rules = subjects.find(subject => subject.dataset.datasetId === 'work-rules');
      if (rules) return rules;
    }
    const ids = new Set(matches.map(match => match.subject.dataset.datasetId));
    // Do not discard a date suggestion whose attribution is unresolved inside
    // one unpunctuated clause naming both saved and dated subjects.
    if (ids.size > 1 && matches.some(match => !match.subject.saved)) return unresolved;
    matches.sort((a,b) => b.index + b.alias.length - a.index - a.alias.length || b.alias.length - a.alias.length);
    return matches[0]?.subject || null;
  };
  const parts = original.match(/[^。；;！？\n]+[。；;！？]?|\n+/g) || [];
  const cleaned = parts.map(part => {
    if (/^\n+$/.test(part)) return part;
    const clauses = part.match(/[^，,]+[，,]?/g) || [], groups = [];
    for (const clause of clauses) {
      const named = subjectFor(clause), previous = groups.at(-1);
      if (named && named !== previous?.subject || !previous) groups.push({ subject: named, clauses: [clause] });
      else previous.clauses.push(clause);
    }
    return groups.map(group => {
      if (!group.subject?.saved || !group.clauses.some(hasSavedStateDateSearchClaim)) return group.clauses.join('');
      const dataset = group.subject.dataset;
      notices.set(dataset.datasetId, `${dataset.title || dataset.datasetId}读取目前已保存状态，不按查询起止日期筛选；仅扩大日期范围不会增加匹配记录。`);
      let discardedClaim = false;
      return group.clauses.filter(clause => {
        if (hasSavedStateDateSearchClaim(clause)) { discardedClaim = true; return false; }
        if (/^\s*(?:如果|假如|若|如规则)/.test(clause)) return false;
        if (discardedClaim && /^(?:\s*)(?:需要时|可以|我再|我会|告诉我|请提供)/.test(clause)
          && /入职(?:时间|日期)|对应日期|查询日期|扩大日期/.test(clause)) return false;
        return true;
      }).join('');
    }).join('').replace(/[，,]+\s*$/, '。');
  }).join('').replace(/\n{3,}/g, '\n\n').trim();
  return notices.size ? [cleaned, ...notices.values()].filter(Boolean).join('\n\n') : original;
}

function hasProvenEmptyQuery(datasets = []) {
  return datasets.some(dataset => dataset.queryMeta?.rowsComplete === true
    && dataset.queryMeta.matchedRowCount === 0 && dataset.queryMeta.returnedRowCount === 0
    && Array.isArray(dataset.rows) && dataset.rows.length === 0);
}
function clearOrphanEmptyQueryTransition(text, datasets = []) {
  const value = String(text || '');
  return hasProvenEmptyQuery(datasets) ? value.replace(/^(\s*)(?:因此|所以|由此|因而)[，,：:\s]*/, '$1') : value;
}

function readableQueryProse(text, datasets) {
  let value = clearOrphanEmptyQueryTransition(correctSavedStateDateGuidance(text, datasets), datasets);
  for (const dataset of datasets) value = value.split(dataset.datasetId).join(dataset.title);
  return normalizeQueryMetadataProse(value, datasets).replace(/\n{3,}/g, '\n\n');
}

module.exports = { normalizeSavedStateClaims, queryCoverageProse, readableQueryProse, clearOrphanQueryHeadings, normalizeQueryPagination, correctSavedStateDateGuidance, hasProvenEmptyQuery, clearOrphanEmptyQueryTransition };
