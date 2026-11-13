// §5 C 黄金评测集 · offline 档：脚本化 provider 驱动真实 v3Service 全链路，
// 断言工具序列、答案要点与回执一致、拒答/口径/语言规则。进默认离线回归。
// live 档（真实供应商）见 live.evaltest.js，经 npm run test:ai:eval:live 单独运行。
const fs = require('fs');
const path = require('path');
const { createEvalFixture, assertCase } = require('./offlineHarness');

const cases = fs.readFileSync(path.join(__dirname, 'cases/golden-cases.jsonl'), 'utf8').split(/\r?\n/)
  .filter(line => line.trim() && !line.trim().startsWith('//'))
  .map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`golden-cases.jsonl 第 ${index + 1} 行 JSON 无效: ${error.message}`); }
  });

describe('§5 黄金评测集 · offline 档（脚本化 provider 全链路）', () => {
  test('用例数量达标（≥30）且 id 唯一', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length);
    for (const item of cases) {
      expect(item.message).toBeTruthy();
      expect(item.expect).toBeTruthy();
    }
  });

  test.each(cases.map(item => [item.id, item]))('%s', async (_, caseDef) => {
    const f = createEvalFixture(caseDef);
    const result = await f.send();
    expect(typeof result.answer).toBe('string');
    assertCase(caseDef, result, f, expect);
  });
});
