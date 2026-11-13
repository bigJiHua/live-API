'use strict';
// Quantity ranking uses only the current published card-type projection.
// A complete prior answer is not proof about a fresh, truncated query.
const ORDER = /(?:按|以|依|根据)[^。；;！？\n]{0,18}(?:类型)?(?:数量|张数|卡数|count)[^。；;！？\n]{0,12}(?:降序|升序|排序|排名|排列)|(?:数量|张数|卡数|count)[^。；;！？\n]{0,12}(?:降序|升序)|(?:descending|ascending)[^.;!?\n]{0,18}(?:count|number)/i;
const RANK = /(?:数量|张数|卡数)[^。；;！？\n]{0,12}(?:最(?:多|少|高|低)|首位|第一(?:名|类|位)(?!条|行)|排名)|(?:最(?:多|少|高|低)|首位|第一(?:名|类|位))[^。；;！？\n]{0,12}(?:数量|张数|卡数)|TYPE[^。；;！？\n]{0,12}(?:最多|最少|首位|第一名|第一类)|(?:首位|位居第一|排名第一|第一类)|\b(?:most|least|highest|lowest)\b[^.;!?\n]{0,18}(?:cards?|count|number)|(?:count|number)[^.;!?\n]{0,18}\b(?:highest|lowest|first|top)\b/i;
const DENIED = /(?:不能|无法|不代表|不表示|未证明|尚不能|尚无法|不足以|不确定|无法确认|不能确认)|cannot|can't|does not prove|unknown/i;
const date = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
function validCountRankClaims(sentence, datasets = []) {
  const original = String(sentence || ''), counts = datasets.filter(dataset => dataset.datasetId === 'card-counts');
  if (!counts.length) return true;
  // A rank word inside an actual identity is ordinary data, not a claim.
  const text = counts.reduce((value, dataset) => (dataset.rows || []).reduce((result, row) =>
    typeof row.type === 'string' && row.type ? result.split(row.type).join('TYPE') : result, value), original);
  const order = ORDER.exec(text), rank = RANK.exec(text);
  if (!order && !rank) return true;
  const first = Math.min(...[order, rank].filter(Boolean).map(match => match.index));
  const prefix = text.slice(0, first).split(/[，,。；;：:\n]|但是|但|然而|\b(?:but|however)\b/i).at(-1);
  if (DENIED.test(prefix) || /(?:无法|不能)(?:确认|判断|确定|证明)[^。；;！？\n]{0,20}$/.test(text)) return true;
  const named = counts.filter(dataset => original.includes(dataset.datasetId) || dataset.title && original.includes(dataset.title)
    || (dataset.rows || []).some(row => row.type && original.includes(row.type)));
  const sources = named.length ? named : counts;
  if (sources.length !== 1) return false;
  const dataset = sources[0], meta = dataset.queryMeta, rows = dataset.rows || [], scope = meta?.effectiveScope;
  if (meta?.datasetId !== dataset.datasetId || !/^q_[a-f0-9]{24}$/.test(meta.queryId || '')
    || meta.rowsComplete !== true || dataset.truncated === true || !rows.length
    || !Number.isInteger(meta.matchedRowCount) || meta.matchedRowCount !== rows.length || meta.returnedRowCount !== rows.length
    || !date(scope?.startDate) || !date(scope?.endDate) || scope.startDate > scope.endDate
    || !(dataset.columns || []).some(column => column.key === 'count' && column.type === 'number')
    || rows.some(row => typeof row.type !== 'string' || !Number.isInteger(row.count) || row.count < 0)) return false;
  const ascending = /升序|最少|最低|ascending|least|lowest/i.test(text);
  const amounts = rows.map(row => row.count);
  // Positive rank wording must identify a published type. A neutral rank
  // caption may accompany a separately proved returned-order caption.
  if (rank) {
    let priorNamedRank = null;
    for (const clause of original.split(/[，,]/)) {
      const masked = rows.reduce((value, row) => row.type ? value.split(row.type).join('TYPE') : value, clause);
      if (!RANK.test(masked)) continue;
      if (/信用卡|借记卡|储蓄卡|虚拟余额|现金|微信|支付宝/.test(masked)) return false;
      const targets = rows.filter(row => row.type && clause.includes(row.type));
      if (targets.length) {
        const lower = /最少|最低|ascending|least|lowest/i.test(masked);
        const extremum = lower ? Math.min(...amounts) : Math.max(...amounts);
        if (targets.some(row => row.count !== extremum)) return false;
        if (/唯一|独占|only|unique/i.test(masked) && amounts.filter(value => value === extremum).length !== 1) return false;
        priorNamedRank = extremum; continue;
      }
      if (order && /^\s*(?:首位|第一(?:名|类|位))\s*(?:如下)?[：:。.]?\s*$/.test(masked)) continue;
      if (priorNamedRank !== null && /^\s*(?:唯一|独占|only|unique)\s*(?:首位|第一(?:名|类|位))?[：:。.]?\s*$/i.test(masked)) {
        if (amounts.filter(value => value === priorNamedRank).length !== 1) return false;
        continue;
      }
      return false;
    }
  }
  // A returned-order caption requires the actual row sequence, including
  // when it names types. Labelled extrema instead use the full-row maximum.
  if (order && amounts.some((value, index) => index > 0
    && (ascending ? value < amounts[index - 1] : value > amounts[index - 1]))) return false;
  return true;
}
function cardCountsPartialRowsTable(dataset) {
  if (dataset?.datasetId !== 'card-counts' || dataset.truncated !== true) return '';
  const meta=dataset.queryMeta,rows=dataset.rows||[];
  if(meta?.datasetId!==dataset.datasetId||!/^q_[a-f0-9]{24}$/.test(meta.queryId||'')||meta.rowsComplete!==false
    ||meta.returnedRowCount!==rows.length||!rows.length||rows.length>6||!Number.isInteger(meta.matchedRowCount)||meta.matchedRowCount<=rows.length
    ||!['type','count','sharePct'].every(key=>(dataset.columns||[]).some(column=>column.key===key))
    ||rows.some(row=>typeof row.type!=='string'||!Number.isInteger(row.count)||row.count<0
      ||!/^\d+(?:\.\d+)?$/.test(String(row.sharePct))||Number(row.sharePct)>100))return '';
  const cell=value=>String(value).replace(/\|/g,'\\|').replace(/\r?\n/g,' ').trim();
  // Only published rows appear; no omitted type, ranking or total is inferred.
  return ['| 类型 | 数量 | 卡片数量占比(%) |','| --- | --- | --- |',
    ...rows.map(row=>`| ${cell(row.type)} | ${row.count} | ${cell(row.sharePct)} |`)].join('\n');
}
module.exports = { validCountRankClaims, cardCountsPartialRowsTable };
