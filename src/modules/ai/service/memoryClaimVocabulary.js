'use strict';
// Read-state and write claims must recognize the same memory nouns.
const CN_MEMORY = '(?:长期记忆|记忆(?:文件|库|档案|信息)?|(?:答复|回答|图表|展示|语言|用户|记账)?偏好(?:设置|配置|文件|档案)?|memory)';
const EN_MEMORY = '(?:(?:long[- ]term|persistent)\\s+memory|memory(?:\\s+(?:file|store))?|(?:(?:reply|answer|response|chart|display|language|user|your)\\s+)?preferences?)';
module.exports = { CN_MEMORY, EN_MEMORY };
