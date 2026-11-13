const {resolveResponseLanguage,languageInstruction,responseLanguageMismatch}=require('../../src/modules/ai/service/responseLanguage');
test.each([
 ['What language should you use for programming explanations, and what color do I prefer? Read my saved memory first.','en'],
 ['Search my saved memory for the literal text "English" and show me the matching original text.','en'],
 ['请在记忆里搜索“English”并返回原文。','zh'],
 ['Please reply in Chinese.','zh'],
 ['请用英文回答。','en'],
 ['Please answer in English. 本轮用中文回复。','zh'],
 ['123.60',null]
])('current request determines reply language: %s',(message,language)=>expect(resolveResponseLanguage(message)).toBe(language));
test('saved Chinese prose cannot be returned as an English explanation',()=>{
 expect(responseLanguageMismatch('根据你保存的偏好：编程说明请使用 English；你喜欢的颜色是红色，不喜欢蓝色。回复会保持简洁。','en')).toBe(true);
 expect(languageInstruction('en')).toContain('Answer in English');
});
test('original text and names can stay Chinese within an English answer',()=>{
 expect(responseLanguageMismatch('Your preferred card is 张三. Original text: 「请记住我喜欢红色，不喜欢蓝色。」','en')).toBe(false);
 expect(responseLanguageMismatch('Original text:\n> 请记住我喜欢红色，不喜欢蓝色。\nThis is the matching original text.','en')).toBe(false);
 expect(responseLanguageMismatch('I prefer red.','zh')).toBe(false);
});
