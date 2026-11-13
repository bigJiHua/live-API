const { AiError } = require('./errors');
const MAX_ANSWER_CHARS = 12000;

// The model chooses tools; only server dispatch and stored artifacts establish
// the response's evidence scope. Model prose/JSON cannot set these flags.
function createResponseValidation(mode) {
  if (mode != null && !['chat', 'analysis', 'operate'].includes(mode))
    throw new AiError('答复场景无效', 502, 'AI_INVALID_RESULT');
  const strictMode = mode !== 'chat' && mode !== 'analysis';
  const used = { businessRead: false, contextRead: false, memoryWrite: false, authorization: false, unknownTool: false };
  return {
    recordTool(name) {
      if (['query_data', 'list_choices'].includes(name)) used.businessRead = true;
      else if (['memory_list', 'memory_read', 'memory_search', 'history_search', 'history_read'].includes(name)) used.contextRead = true;
      else if (['memory_write', 'memory_delete'].includes(name)) used.memoryWrite = true;
      else if (name === 'request_authorization') used.authorization = true;
      // 联网回执只支持外部资讯正文，不能扩充账本 claims 的数据集。
      else if (name === 'web_search') { /* No private business evidence. */ }
      else used.unknownTool = true;
    },
    forResult({ artifacts = [], datasets = [], memoryReceipts = [], memoryReadReceipts = [],
      memorySearchReceipts = [], memoryErrors = [] } = {}) {
      const business = strictMode || used.unknownTool || used.businessRead || artifacts.length > 0 || datasets.length > 0;
      const memoryWrite = used.memoryWrite || memoryReceipts.length > 0;
      const context = used.contextRead || memoryWrite || memoryReadReceipts.length > 0
        || memorySearchReceipts.length > 0 || memoryErrors.length > 0;
      return Object.freeze({ claimsScope: business ? 'business' : 'prose',
        memoryExplicitOnly: !strictMode && !memoryWrite,
        privateSources: business || context,
        route: business ? 'business' : context ? 'context' : 'prose',
        ...used });
    },
  };
}

function limitAnswer(text, maxChars = MAX_ANSWER_CHARS) {
  if (text.length > maxChars) throw new AiError(`AI 答复超过 ${maxChars} 字符，未保存截断文章；请要求分段输出`,
    502, 'AI_ANSWER_TOO_LONG');
  return text;
}

module.exports = { createResponseValidation, limitAnswer, MAX_ANSWER_CHARS };
