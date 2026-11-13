// 追加166：测试侧 SQL 表引用契约工具。
//
// tablesRead(sql) 只捕获 FROM/JOIN 目标表，因此列名、别名和派生表别名
// （FROM (...) AS t）不会混入；注释和字符串字面量先剥离，未闭合的注释或
// 字符串直接抛错——解析失败必须让测试失败，而不是静默漏判。
// AI 读取测试先用法：tablesRead(sql) 与 CANDIDATE_SOURCE_TABLES[group]
// 白名单逐 SQL 比较（读取器 SQL 仍在仓库层，这里只是测试侧的允许表集合）。

function tablesRead(sql) {
  const withoutLineComments = String(sql || '').replace(/--[^\n]*/g, ' ');
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/\/\*/.test(withoutBlockComments)) throw new Error('sqlTables: 未闭合的块注释');
  const withoutStrings = withoutBlockComments
    .replace(/'(?:[^']|'')*'/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ');
  if (/['"]/.test(withoutStrings)) throw new Error('sqlTables: 未闭合的字符串字面量');
  const tables = new Set();
  const reference = /\b(?:FROM|JOIN)\s+(`[^`]+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(`[^`]+`|[A-Za-z_][\w$]*))?/gi;
  for (const match of withoutStrings.matchAll(reference)) {
    const name = (match[2] || match[1]).replace(/`/g, '');
    if (name.toLowerCase() !== 'dual') tables.add(name);
  }
  return [...tables].sort();
}

// 候选组 → 读取器允许触碰的表集合。银行名存在 bus_category（type='bank'），
// 所以 cards 候选的必要 JOIN 伙伴是 bus_category 而非独立银行表。
const CANDIDATE_SOURCE_TABLES = Object.freeze({
  cards: ['bus_category', 'card_base'],
  categories: ['bus_category'],
  todos: ['todo'],
  funds: ['fund'],
  fixedAssets: ['fixed_asset'],
});

module.exports = { tablesRead, CANDIDATE_SOURCE_TABLES };
