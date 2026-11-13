// 追加164：真 MySQL 集成套件配置（tests/real/*.realtest.js）。
// 与默认 jest 完全隔离：默认套件全 mock db（「不碰真库」铁律不变）；
// 本套件经 `npm run test:ai:real` 单独运行，起真服务+隔离库 live_ai_test。
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/real/**/*.realtest.js'],
  setupFilesAfterEnv: ['./tests/setup.js'],
  verbose: true,
  testTimeout: 60000,
  moduleFileExtensions: ['js', 'json'],
};
