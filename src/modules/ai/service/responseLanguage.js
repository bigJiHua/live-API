'use strict';

function proseWithoutQuotes(value) {
  return String(value || '').replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|(?<![A-Za-z])'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/^\s*>.*$/gm, ' ').replace(/https?:\/\/\S+/g, ' ');
}
function resolveResponseLanguage(message) {
  const prose = proseWithoutQuotes(message), directives = [];
  for (const match of prose.matchAll(/(?:请|本轮|这次|本次)?\s*(?:用|使用|以)\s*(中文|英文|English|Chinese)\s*(?:回答|回复|解释|说明)|\b(?:reply|respond|answer)\s+(?:to me\s+)?in\s+(English|Chinese)\b/giu)) {
    directives.push({ index:match.index, language:/英文|English/i.test(match[1] || match[2])?'en':'zh' });
  }
  if (directives.length) return directives.at(-1).language;
  const chinese = (prose.match(/[\u3400-\u9fff]/g) || []).length;
  const english = (prose.match(/[A-Za-z]+/g) || []).length;
  if (chinese >= 2) return 'zh';
  return english >= 3 ? 'en' : null;
}
function languageInstruction(language) {
  return language === 'en' ? 'Answer in English. Keep quoted original text and names unchanged. Memory preferences about other subjects do not change the language of this reply.'
    : language === 'zh' ? '本轮 answer 使用中文；引用原文和名称保持原样，其它主题的长期语言偏好不改变本轮答复语言。' : '';
}
function responseLanguageMismatch(answer, language) {
  const prose = proseWithoutQuotes(answer);
  const chinese = (prose.match(/[\u3400-\u9fff]/g) || []).length;
  const englishLetters = (prose.match(/[A-Za-z]/g) || []).length;
  if (language === 'en') return chinese >= 6 && chinese > englishLetters / 4;
  if (language === 'zh') return chinese === 0 && (prose.match(/[A-Za-z]+/g) || []).length >= 8;
  return false;
}
module.exports = { resolveResponseLanguage, languageInstruction, responseLanguageMismatch };
