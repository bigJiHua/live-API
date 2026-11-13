'use strict';
const { CN_MEMORY, EN_MEMORY } = require('./memoryClaimVocabulary');
// Read metadata proves an existing file state; it never proves a current write.
const timestamp = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z'));
function validRead(receipt) {
  return receipt && receipt.status!=='error' && typeof receipt.path==='string' && receipt.path.length<=80
    && /^[\p{L}\p{N}][\p{L}\p{N} _.-]*\.md$/u.test(receipt.path) && !receipt.path.includes('..')
    && typeof receipt.title==='string' && receipt.title.trim() && receipt.title.length<=80
    && /^[a-f0-9]{64}$/.test(receipt.revision||'') && timestamp(receipt.created) && timestamp(receipt.updated)
    && Date.parse(receipt.updated)>=Date.parse(receipt.created)
    && typeof receipt.content==='string' && receipt.content.trim() && typeof receipt.source==='string' && receipt.source.trim();
}
const CN_NAMED_READ = /(?:(?:我(?:们)?|本轮|本次)\s*)?(?:已经|已)?(?:读取|读到|查看|查阅)(?:了)?(?:已保存的?)?(?:长期记忆|记忆)(?:文件)?\s*[《「『](?<name>[^》」』\n]{1,80})[》」』]\s*[（(](?:保存|创建|更新)于\s*(?<date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\s*[，,]?\s*(?:UTC)?\s*[）)]/gu;
// Possessive saved-memory noun phrases also describe prior state without a
// fixed preceding preposition (for example "search over my saved memory").
const GENERIC_READ_STATE = new RegExp(`\\b(?:(?:from|according to|based on|in|per)\\s+(?:(?:your|the|my)\\s+)?|(?:your|the|my)\\s+)(?:previously\\s+)?saved\\s+${EN_MEMORY}\\b|(?:根据|依据|来自|从)(?:你(?:的)?|您(?:的)?)?(?:已保存的?|此前保存的)(?:偏好)?${CN_MEMORY}`, 'giu');
const EXPLICIT_CURRENT_WRITE = /(?:本轮|本次|这次|刚刚?|刚才|重新|新近)(?:(?!根据|依据|来自|从)[^，,。!！?？;；\n]){0,18}(?:保存|写入|更新|修改)|\b(?:I|We)\s+(?:have\s+)?(?:just|now|newly)\s+(?:saved|stored|updated|written)|\b(?:just|newly)\s+(?:saved|stored|updated|written)|\b(?:saved|stored|updated|written)(?:\s+(?:your|the|my|this|long[- ]term|persistent|memory|preferences|file|store)){0,5}\s+(?:in\s+)?(?:this turn|this time|just now|now)\b/iu;
function explicitReadNames(after, knownNames) {
  const names = [];
  // Quoted filenames may contain connector words. Bind the whole quoted name
  // before separating an unquoted list of references.
  const unquoted = after.replace(/《([^》\n]{1,80})》|「([^」\n]{1,80})」|『([^』\n]{1,80})』|"([^"\n]{1,80})"|'([^'\n]{1,80})'|`([^`\n]{1,80})`|“([^”\n]{1,80})”|‘([^’\n]{1,80})’/gu,
    (value, ...groups) => {
      const name = groups.slice(0, 8).find(group => group !== undefined);
      if (!/^[《「『]/u.test(value) && !name.endsWith('.md')) return value;
      names.push(name);
      return ' '.repeat(value.length);
    });
  for (const part of unquoted.split(/\s+(?:and|or|和|与|及|以及)\s+|[、，,;；：《》「」『』()\n]/giu)) {
    // A leading file/path label describes the reference, not the filename.
    // Quoting above still binds a real filename such as "file preferences.md"
    // in full; unquoted unknown names remain subject to exact receipt checks.
    const wholeName = part.trim();
    const reference = knownNames.includes(wholeName) ? wholeName
      : wholeName.replace(/^(?:file\s+name|filename|file|path)(?:\s*=\s*|\s+)/iu, '');
    for (const value of reference.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_ .-]{0,75}\.md/gu)) names.push(value[0].trim());
  }
  return names;
}
function supportsReadState(original, candidate, readReceipts=[], searchReceipts=[]) {
  const reads=Array.isArray(readReceipts)?readReceipts.filter(validRead):[];
  // An actual search hit proves a readable file exists, but cannot prove its
  // saved timestamp or any write in this turn. Keep those evidence separate.
  const searchPaths = Array.isArray(searchReceipts) ? searchReceipts.filter(receipt => receipt && receipt.status !== 'error' && Array.isArray(receipt.matches))
    .flatMap(receipt => receipt.matches).filter(match => typeof match?.path === 'string' && match.path.length <= 80
      && /^[\p{L}\p{N}][\p{L}\p{N} _.-]*\.md$/u.test(match.path) && !match.path.includes('..')
      && Number.isInteger(match.line) && match.line > 0 && typeof match.text === 'string' && match.text.trim()).map(match => match.path) : [];
  if(!reads.length&&!searchPaths.length)return false;
  CN_NAMED_READ.lastIndex=0;
  for(const match of String(original).matchAll(CN_NAMED_READ)){
    if(candidate.start<match.index||candidate.end>match.index+match[0].length)continue;
    const name=match.groups.name,date=match.groups.date;
    if(reads.some(receipt=>(name===receipt.path||name===receipt.title)
      &&[receipt.created,receipt.updated].some(value=>value===date||value.replace(/\.\d{3}Z$/,'Z')===date)))return true;
  }
  GENERIC_READ_STATE.lastIndex=0;
  for(const match of String(original).matchAll(GENERIC_READ_STATE)){
    if(candidate.start<match.index||candidate.end>match.index+match[0].length)continue;
    const before=String(original).slice(0,match.index).split(/[，,。!！?？;；\n]/u).at(-1),after=String(original).slice(match.index+match[0].length).split(/[，,。!！?？;；\n]/u)[0];
    if(EXPLICIT_CURRENT_WRITE.test(before+match[0]+after))continue;
    // Explicit filenames or titles in this introduction must identify a read
    // receipt; a generic proven memory introduction carries no write claim.
    const explicit = explicitReadNames(after, [...reads.flatMap(receipt => [receipt.path, receipt.title]), ...searchPaths]);
    if(explicit.length&&explicit.some(name=>!reads.some(receipt=>receipt.path===name||receipt.title===name)&&!searchPaths.includes(name)))continue;
    return true;
  }
  return false;
}
module.exports={supportsReadState};
