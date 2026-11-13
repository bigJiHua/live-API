// Literal user-source preservation and proved memory side-effect notices.
const {AiError}=require('./errors');
const {validateMemoryPath}=require('./memoryStore');
const normalize=text=>String(text).replace(/\r\n/g,'\n').trim();
function plainRecord(text){return normalize(text).split('\n').map(line=>line.replace(/^\s*>\s?/,'')).join('\n').trim();}
function validateMemoryContentEvidence(args, sourceText, before=null){
  if(typeof sourceText!=='string'||!sourceText.trim())throw new AiError('记忆缺少真实用户原话',400,'AI_MEMORY_SOURCE_INVALID');
  const content=plainRecord(args.content),source=normalize(sourceText);
  if(args.operation==='patch'){
    if(!before||typeof before.content!=='string'||typeof args.oldText!=='string')throw new AiError('局部修改前须读取现有记忆',409,'AI_MEMORY_REVISION_REQUIRED');
    // Whole records preserve sentence context and avoid turning “不喜欢蓝色”
    // into “喜欢蓝色” through a substring-level mutation.
    const old=normalize(args.oldText),records=normalize(before.content).split(/\n\s*\n/).map(plainRecord);
    if(!records.includes(plainRecord(old)))throw new AiError('记忆局部替换必须选中完整原话记录，不能截断句意',400,'AI_MEMORY_CONTENT_NOT_SOURCED');
    if(!content)return true;
  }
  // This is literal provenance, not a claim to prove arbitrary paraphrase.
  // Keep the complete user turn, including negation, qualifications and lists.
  if(content!==source)throw new AiError('记忆新增内容必须保留完整用户原话，不能改写或截去限定语；请逐字保存原话',400,'AI_MEMORY_CONTENT_NOT_SOURCED');
  return true;
}
function memoryFailureNotice(receipts=[]){
  const paths=[...new Set(receipts.filter(r=>r&&r.saved===true&&r.partialDeleted!==true&&r.changed!==false&&typeof r.path==='string'&&typeof r.revision==='string'&&/^[a-f0-9]{64}$/.test(r.revision)).map(r=>{try{return validateMemoryPath(r.path);}catch{return null;}}).filter(Boolean))];
  return paths.length?`本轮已保存 ${paths.length} 条长期记忆（${paths.join('、')}），这些记忆修改已生效；其余处理未完成。`:'';
}
module.exports={validateMemoryContentEvidence,memoryFailureNotice};
