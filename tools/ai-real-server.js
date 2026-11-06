// Run the actual API middleware/routes without startup migrations or scheduled accounting jobs.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getConfig } = require('../src/modules/ai/service/config');
const config = getConfig();
if (config.mode !== 'deepseek' || config.dataSource !== 'user-readonly' || process.env.NODE_ENV === 'test') {
  throw new Error('Real AI verification requires DeepSeek and a real read-only database');
}
const app = require('../app');
const server = app.listen(Number(process.env.PORT || 7788), '127.0.0.1', () => {
  console.log('[AI real verification] Actual API routes ready; real-data source; authentication required.');
});
server.on('error', error => {
  console.error('[AI real verification] Server unavailable:', error.code || 'UNKNOWN');
  process.exitCode = 1;
});
