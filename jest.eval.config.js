// §5 C 黄金评测集 · live 档配置（真实供应商 + 隔离库 live_ai_test）。
// 与默认 jest 完全隔离；经 `AI_EVAL_LIVE=1 npm run test:ai:eval:live` 运行，
// 报告落 api/logs/REVIEW_<日期>_AI_EVAL_<model>.md（按 provider/model 分版本，不覆盖历史）。
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/eval/*.evaltest.js'],
  setupFilesAfterEnv: ['./tests/setup.js'],
  verbose: true,
  testTimeout: 600000,
  moduleFileExtensions: ['js', 'json'],
};
