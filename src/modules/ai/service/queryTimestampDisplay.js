// Display only: source instants and business calendar fields are immutable.
const { stripVerifiedClockTokens } = require('./queryTemporalProse');
const SAVED_TIME_FIELDS = new Set(['updatedAt', 'recordedAt', 'minUpdatedAt', 'maxUpdatedAt']);
const ISO_UTC = /^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;
const legalDate = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const ZONE_LABEL = '(?:北京时间|上海时间|Asia/Shanghai|CST|UTC(?:\\+08:00)?|GMT(?:\\+08:00)?)';
function utcInstant(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const normalized = new Date(instant).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}
function sourceTextSpans(text, datasets) {
  const spans = [];
  for (const dataset of datasets) for (const column of dataset.columns || []) {
    if (column.type !== 'text' || SAVED_TIME_FIELDS.has(column.key)) continue;
    for (const row of dataset.rows || []) {
      const value = row[column.key];
      if (typeof value !== 'string' || value.length < 2) continue;
      let index = text.indexOf(value);
      while (index >= 0) {spans.push({start:index,end:index+value.length});index=text.indexOf(value,index+value.length);}
    }
  }
  return spans;
}
const protectedSpan = (spans, start, end) => spans.some(span => start < span.end && end > span.start);
function normalizeSavedTimestampDisplay(answer, datasets = []) {
  const original = String(answer || ''),protectedOriginal=sourceTextSpans(original,datasets);
  // A zone between same-day range clocks would break the existing strict
  // range verifier. Move only that presentation token to the range end,
  // then prove both original clocks together; raw text cells stay opaque.
  const rangePattern=new RegExp('(20\\d{2}-\\d{2}-\\d{2}[T ](?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,3})?)?)\\s*[（(]?('+ZONE_LABEL+')[）)]?\\s*((?:至|到|~|～|—|-)\\s*(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,3})?)?)(?:\\s*[（(]?('+ZONE_LABEL+')[）)]?)?','gi');
  const rangeSafe=original.replace(rangePattern,(match,first,zone,last,endZone,index)=>{
    if(protectedSpan(protectedOriginal,index,index+match.length))return match;
    const candidate=original.slice(0,index)+first+last+'（'+zone+'）'+original.slice(index+match.length);
    if(stripVerifiedClockTokens(candidate,datasets,{proofOnlyZoneLabels:true}).unsupported)return match;
    return first+last+'（'+zone+'）';
  });
  const text=rangeSafe, protectedText = sourceTextSpans(text, datasets), edits = [];
  // Verification still binds the same row/date/clock and trusted time field.
  // Only a zone WORD is ignored here because this function replaces that word
  // with the already-proven source zone; explicit numeric offsets stay strict.
  const proof = stripVerifiedClockTokens(text, datasets, {proofOnlyZoneLabels:true});
  if (proof.unsupported) return text;
  const spans = proof.verifiedSpans || [];
  for (const [index, span] of spans.entries()) {
    if (protectedSpan(protectedText, span.dateOffset, span.end)) continue;
    const next = spans[index+1], continues = next?.isRangeEnd && next.dateOffset === span.dateOffset;
    // Place one zone marker at the end of a same-day range; never between clocks.
    if (continues) continue;
    const first = spans.find(item => item.dateOffset === span.dateOffset) || span;
    const before = text.slice(0, first.dateOffset), after = text.slice(span.end);
    const prefix = new RegExp('(?:[（(]\\s*)?(' + ZONE_LABEL + ')(?:\\s*[）)])?\\s*$','i').exec(before);
    const suffix = new RegExp('^(?:\\s*(?:[（(]\\s*)?(?:' + ZONE_LABEL + '|时区未标明)(?:\\s*[）)])?)+(?=$|[，,。；;！？\\n|])','i').exec(after);
    const zone = span.sourceZone === 'Z' ? 'UTC' : span.sourceZone ? 'UTC' + span.sourceZone : '时区未标明';
    if (prefix && !protectedSpan(protectedText, first.dateOffset-prefix[0].length, first.dateOffset))
      edits.push({start:first.dateOffset-prefix[0].length,end:first.dateOffset,text:''});
    if (suffix && !protectedSpan(protectedText, span.end, span.end+suffix[0].length))
      edits.push({start:span.end,end:span.end+suffix[0].length,text:'（'+zone+'）'});
    else if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(span.token)) edits.push({start:span.end,end:span.end,text:'（'+zone+'）'});
    else if (prefix) edits.push({start:span.end,end:span.end,text:'（'+zone+'）'});
  }
  let output = text;
  for (const edit of edits.sort((a,b)=>b.start-a.start || b.end-a.end)) output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  return output;
}
function currentAsOfSources(datasets) {
  const duplicateIds=new Set(datasets.filter((dataset,index)=>datasets.some((other,otherIndex)=>index!==otherIndex&&other.queryMeta?.queryId===dataset.queryMeta?.queryId)).map(dataset=>dataset.queryMeta?.queryId));
  return datasets.flatMap(dataset => {
    const meta=dataset.queryMeta,instant=utcInstant(meta?.asOf);
    if (!instant || meta.version !== 1 || meta.datasetId !== dataset.datasetId || !/^q_[a-f0-9]{24}$/.test(meta.queryId || '')
      || duplicateIds.has(meta.queryId) || dataset.asOf && dataset.asOf !== meta.asOf
      || !legalDate(meta.effectiveScope?.startDate) || !legalDate(meta.effectiveScope?.endDate) || meta.effectiveScope.startDate>meta.effectiveScope.endDate) return [];
    return [{dataset,meta,instant}];
  });
}
function normalizeQueryTimestampDisplay(answer, datasets = []) {
  let text=normalizeSavedTimestampDisplay(answer,datasets);
  const sources=currentAsOfSources(datasets);if(!sources.length)return text;
  const protectedText=sourceTextSpans(text,datasets),pending=[],edits=[];
  const freshness=/(?:数据读取(?:时间|时刻)|数据查询(?:时间|时刻)|数据截至)\s*[：:]?\s*((?:20\d{2}-\d{2}-\d{2}|20\d{2}年\d{1,2}月\d{1,2}日))(?:[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)(?:Z|[+-]\d{2}:\d{2})?)?(?:\s*[（(]?(?:UTC|北京时间|上海时间)[）)]?)?/g;
  for(const match of text.matchAll(freshness)) {
    if(protectedSpan(protectedText,match.index,match.index+match[0].length))continue;
    const clause=text.slice(0,match.index).split(/[，,。；;！？\n|]/).at(-1);
    // DATE coverage is a calendar fact. Neither an explicit business cutoff
    // nor a date equal to a current scope endpoint becomes a read timestamp.
    const ChineseDate=/^(20\d{2})年(\d{1,2})月(\d{1,2})日$/.exec(match[1]);
    const claimedDate=ChineseDate?ChineseDate[1]+'-'+ChineseDate[2].padStart(2,'0')+'-'+ChineseDate[3].padStart(2,'0'):match[1];
    if(/(?:交易|历史|记录|统计|查询范围|业务范围|期间)[^，,。；;！？\n]{0,24}$/.test(clause)
      || sources.some(source=>source.meta.effectiveScope?.endDate===claimedDate))continue;
    const named=sources.map(source=>({source,index:clause.lastIndexOf(source.dataset.title)}))
      .filter(item=>item.source.dataset.title&&item.index>=0);
    const nearest=named.length?Math.max(...named.map(item=>item.index)):-1;
    const own=named.filter(item=>item.index===nearest).map(item=>item.source);
    if(!own.length&&sources.length===1)own.push(sources[0]);
    if(own.length===1) {
      const source=own[0],shown=source.instant.replace('T',' ').replace(/Z$/,' UTC');
      edits.push({start:match.index,end:match.index+match[0].length,text:'数据读取时间：'+shown});
    } else if(!own.length&&sources.length>1) {
      // An ambiguous global freshness statement cannot borrow one query's
      // clock. Replace that span only, then append each source independently.
      edits.push({start:match.index,end:match.index+match[0].length,text:'各数据集读取时刻分别见下文'});pending.push(...sources);
    }
  }
  for(const edit of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);
  if(pending.length){const unique=[...new Map(pending.map(source=>[source.meta.queryId,source])).values()];
    text+='\n\n'+unique.map(source=>source.dataset.title+'数据读取时间：'+source.instant.replace('T',' ').replace(/Z$/,' UTC')+'。').join('\n');}
  return text.trim();
}
module.exports={normalizeSavedTimestampDisplay,normalizeQueryTimestampDisplay};
