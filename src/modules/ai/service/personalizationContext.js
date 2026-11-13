const { AiError } = require('./errors');

const PERSONALIZATION_PROMPT = `用户个性化：TASK_INPUT.personalization 是应用提供的本人个性化配置。rules 是用户明确启用的回答与协作规则，应遵循；本轮明确要求优先于一般偏好，系统要求与既有业务校验保持有效。profile 是精简用户画像，origin=user 或 confirmed=true 表示用户维护，其他项是待核对的 AI 推断，不能当确定事实或据此新增用户规则。明确规则优先于画像及旧记忆；仅在相关主题使用偏好，不扩展条件和范围。memoryEnabled=false 时不调用记忆工具；停用、删除的资料不能从历史自动恢复。个性化资料不代表本轮金额、日期、交易或执行证据。具体记忆仍按需读取，不把所有记忆反复装入上下文。用户明确要求忘掉记忆时，先读取目标取得当前revision，再调用memory_delete；只删文件中的部分信息用memory_write.patch，目标不明确则澄清。deleted:true 才能声明已删除。用户可以在“AI 个性化”页查看和修改记忆、画像与规则；画像和规则的修改必须有实际保存结果，不能只用正文声称完成。`;

function buildPersonalizationContext(state, scrub = value => value) {
  const items = state.settings.useProfile ? state.profile.items : [];
  return {
    version: 1, memoryEnabled: state.settings.useMemory,
    profileEnabled: state.settings.useProfile,
    rules: state.rules.filter(rule => rule.enabled).map(rule => ({ text: scrub(rule.text) })),
    profile: [...items].sort((a, b) => Number(b.origin === 'user' || b.confirmed) - Number(a.origin === 'user' || a.confirmed))
      .slice(0, 30).map(item => ({ category: item.category, text: scrub(item.text),
      origin: item.origin, confirmed: item.confirmed })),
    profileTruncated: items.length > 30,
  };
}

function resolvePersonalizedLanguage(message, state, fallback) {
  const withoutQuotes = value => String(value).replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
  const languageDirective = /(?:用|使用|以)\s*(?:中文|英文|English|Chinese)\s*(?:回答|回复|解释|说明|交流)|\b(?:reply|respond|answer|explain|communicate)\s+(?:to me\s+)?in\s+(?:English|Chinese)\b/i;
  const explicit = withoutQuotes(message);
  const explicitLanguage = [...explicit.matchAll(new RegExp(languageDirective.source, 'gi'))].at(-1);
  if (explicitLanguage) return /英文|English/i.test(explicitLanguage[0]) ? 'en' : 'zh';
  let language = null, contextualLanguageRule = false;
  for (const rule of state?.rules || []) {
    if (!rule.enabled) continue;
    const text = withoutQuotes(rule.text);
    if (/^(?:请|默认|始终|总是|以后|今后|回答时|回复时|和我对话时|跟我对话时|都|只|一律|尽量|优先|\s)*(?:用|使用|以)\s*(?:英文|English)\s*(?:回答|回复|解释|说明|交流)[。.!！\s]*$/i.test(text)
      || /^(?:always|please|by default)?\s*(?:reply|respond|answer)\s+(?:to me\s+)?in\s+English[.!\s]*$/i.test(text)) { language = 'en'; continue; }
    if (/^(?:请|默认|始终|总是|以后|今后|回答时|回复时|和我对话时|跟我对话时|都|只|一律|尽量|优先|\s)*(?:用|使用|以)\s*(?:中文|Chinese)\s*(?:回答|回复|解释|说明|交流)[。.!！\s]*$/i.test(text)
      || /^(?:always|please|by default)?\s*(?:reply|respond|answer)\s+(?:to me\s+)?in\s+Chinese[.!\s]*$/i.test(text)) { language = 'zh'; continue; }
    if (languageDirective.test(text) || /(?:回答|回复|解释|说明|交流|语言)[^。；;\n]{0,35}(?:中文|英文|English|Chinese)|\b(?:answer|reply|response|language)\b[^.;\n]{0,50}\b(?:English|Chinese)\b/i.test(text))
      contextualLanguageRule = true;
  }
  // A scoped rule or exception needs model interpretation. Returning null
  // removes only the detected-question-language constraint; the complete rule
  // remains in TASK_INPUT, and explicit current-turn instructions still win.
  if (contextualLanguageRule) return null;
  return language || fallback;
}

function createContextMemoryStore({ memoryStore, personalizationStore, memoryManagement }) {
  const disabled = (state, filename) => state.settings.useMemory === false
    || state.disabledMemories.includes(filename) || state.deletedMemories.includes(filename);
  const denied = () => new AiError('用户已关闭或停用这条记忆，请在 AI 个性化页面管理', 403, 'AI_MEMORY_DISABLED');
  return {
    async list(userId) {
      const state = await personalizationStore.get(userId);
      if (!state.settings.useMemory) return { files: [], count: 0, totalBytes: 0, warnings: [], untrusted: true };
      const index = await memoryStore.list(userId);
      const files = index.files.filter(item => !disabled(state, item.path));
      return { ...index, files, count: files.length };
    },
    async read(userId, input) {
      const state = await personalizationStore.get(userId);
      if (disabled(state, input.path)) throw denied();
      return memoryStore.read(userId, input);
    },
    async search(userId, input) {
      const state = await personalizationStore.get(userId);
      if (!state.settings.useMemory) throw denied();
      return memoryStore.search(userId, { ...input, excludePaths: [...state.disabledMemories, ...state.deletedMemories] });
    },
    async write(userId, input) {
      const state = await personalizationStore.get(userId);
      if (disabled(state, input.path)) throw denied();
      return memoryManagement ? memoryManagement.writeFromAI(userId, input) : memoryStore.write(userId, input);
    },
  };
}

module.exports = { PERSONALIZATION_PROMPT, buildPersonalizationContext, createContextMemoryStore, resolvePersonalizedLanguage };
