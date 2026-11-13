// 追加166：tablesRead 表引用提取器契约（纯离线）。
const { tablesRead } = require('../helpers/sqlTables');

test('FROM, JOIN, subqueries and qualified names are all captured', () => {
  const sql = 'SELECT a.x FROM fund f LEFT JOIN bus_fund_history h ON h.fund_id = f.id WHERE f.id IN (SELECT id FROM account a) UNION ALL SELECT y FROM live_ai_test.todo t';
  expect(tablesRead(sql)).toEqual(['account', 'bus_fund_history', 'fund', 'todo']);
});

test('derived tables contribute only their inner references, not the alias', () => {
  const sql = 'SELECT * FROM (SELECT id FROM card_base c) AS derived JOIN bus_category bank ON 1=1';
  expect(tablesRead(sql)).toEqual(['bus_category', 'card_base']);
});

test('column names, aliases and literals never leak into the result', () => {
  const sql = "SELECT date_from, remark FROM bus_category c -- FROM account 不算\n WHERE c.name = 'FROM fixed_asset 也不算' AND c.type = 'bank'";
  expect(tablesRead(sql)).toEqual(['bus_category']);
});

test('comment semicolons and quoted strings do not break or fake parsing', () => {
  const sql = "SELECT 1 FROM fund f /* 分号; 注释 */ WHERE f.fund_name = 'a;b' AND f.invest > 0";
  expect(tablesRead(sql)).toEqual(['fund']);
});

test('unterminated comments or strings fail loudly instead of passing silently', () => {
  expect(() => tablesRead('SELECT 1 FROM fund f /* 未闭合注释')).toThrow('未闭合的块注释');
  expect(() => tablesRead("SELECT 1 FROM fund f WHERE f.name = '未闭合")).toThrow('未闭合的字符串字面量');
});
