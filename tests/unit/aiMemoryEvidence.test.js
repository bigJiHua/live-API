const fs=require('node:fs/promises'),path=require('node:path');
const {createMemoryStore}=require('../../src/modules/ai/service/memoryStore');
const {validateMemoryContentEvidence,memoryFailureNotice}=require('../../src/modules/ai/service/memoryEvidence');
const roots=[],base=path.resolve(__dirname,'../../../temp/ai-all23-20261109');
afterAll(async()=>{for(const root of roots){const relative=path.relative(base,path.resolve(root));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Unsafe proposed-test cleanup');await fs.rm(root,{recursive:true,force:true});}});
test('provenance rejects contradictory body and removed negation',()=>{
  for(const [source,content]of [['我喜欢红色。','我喜欢蓝色。'],['我不喜欢蓝色。','喜欢蓝色。'],['我不喜欢下面东西：\n蓝色','蓝色']])expect(()=>validateMemoryContentEvidence({operation:'create',content},source)).toThrow(expect.objectContaining({code:'AI_MEMORY_CONTENT_NOT_SOURCED'}));
});
test('literal records retain full Chinese/English meaning',()=>{
  for(const source of ['我喜欢红色。','Please reply in English and keep it concise.','我不喜欢下面东西：\n蓝色','English is preferred, except finance explanations should be in 中文。'])expect(validateMemoryContentEvidence({operation:'create',content:source},source)).toBe(true);
  expect(validateMemoryContentEvidence({operation:'append',content:'> 我喜欢红色。'},'我喜欢红色。')).toBe(true);
});
test('content gate retains create/read/append/replace/patch with actual UTF-8 store',async()=>{
  const root=await fs.mkdtemp(path.join(base,'proposed-memory-'));roots.push(root);const store=createMemoryStore({root}),user='proposed-owner';
  const write=async(source,args)=>{const before=args.operation==='create'?null:await store.read(user,{path:args.path});validateMemoryContentEvidence(args,source,before);return store.write(user,{...args,sourceText:source});};
  const common={path:'preferences.md',title:'答复偏好',type:'preference'};
  await write('我喜欢红色。',{...common,operation:'create',content:'我喜欢红色。'});
  await write('Please answer in English.',{...common,operation:'append',content:'\nPlease answer in English.'});
  let before=await store.read(user,{path:common.path});expect(before.content).toContain('红色');expect(before.content).toContain('English');
  await write('我现在喜欢蓝色。',{...common,operation:'replace',content:'我现在喜欢蓝色。',expectedRevision:before.revision});
  before=await store.read(user,{path:common.path});
  await write('Please keep answers concise.',{...common,operation:'patch',oldText:before.content,content:'Please keep answers concise.',expectedRevision:before.revision});
  expect((await store.read(user,{path:common.path})).content.trim()).toBe('Please keep answers concise.');
});
test('patch does not remove the negation from a stored record',()=>{
  expect(()=>validateMemoryContentEvidence({operation:'patch',oldText:'不',content:''},'去掉旧偏好',{content:'我不喜欢蓝色。'})).toThrow(expect.objectContaining({code:'AI_MEMORY_CONTENT_NOT_SOURCED'}));
});
test('failure notice contains only proved saved changed files, deduplicates paths, and reports no invented effects',()=>{
  const saved={saved:true,path:'preferences.md',revision:'a'.repeat(64),changed:true};
  expect(memoryFailureNotice([saved,saved,{...saved,path:'../escape.md'},{...saved,path:'unchanged.md',changed:false},{saved:false,path:'invented.md'}])).toBe('本轮已保存 1 条长期记忆（preferences.md），这些记忆修改已生效；其余处理未完成。');
  expect(memoryFailureNotice([])).toBe('');expect(memoryFailureNotice([{...saved,changed:false}])).toBe('');
  expect(memoryFailureNotice([{...saved,partialDeleted:true}])).toBe('');
});
