// 追加166：liveSchema DDL 解析器回归 + live.sql 表集合漂移检测（纯离线，无数据库）。
const fs = require('fs');
const path = require('path');
const { EXPECTED_TABLES, parseCreateTables, assertExpectedTables } = require('../real/liveSchema');

test('table COMMENT containing semicolons no longer ends the match early', () => {
  const ddl = "CREATE TABLE IF NOT EXISTS `ai_chat_activity` (\n  `id` CHAR(36) NOT NULL,\n  `note` VARCHAR(200) NOT NULL COMMENT '活动备注; 含分号; 多个',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='聊天活动; 分号注释';\n";
  const parsed = parseCreateTables(ddl);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].name).toBe('ai_chat_activity');
  expect(parsed[0].ddl).toContain('COMMENT=\'聊天活动; 分号注释\'');
});

test('string defaults with quotes, dashes and semicolons survive parsing', () => {
  const ddl = "CREATE TABLE IF NOT EXISTS `t_demo` (\n  `a` VARCHAR(10) DEFAULT '--不是注释; still string',\n  `b` VARCHAR(10) DEFAULT 'it''s quoted',\n  PRIMARY KEY (`a`)\n) ENGINE=InnoDB;\nCREATE TABLE IF NOT EXISTS `t_next` (\n  `id` INT NOT NULL\n) ENGINE=InnoDB;\n";
  const parsed = parseCreateTables(ddl);
  expect(parsed.map(entry => entry.name)).toEqual(['t_demo', 't_next']);
});

test('multi-line definitions and backticked names parse fully', () => {
  const ddl = 'CREATE TABLE IF NOT EXISTS `multi_line` (\n  `id` BIGINT NOT NULL AUTO_INCREMENT,\n  `payload` TEXT NULL COMMENT \'跨\n行注释也安全\',\n  PRIMARY KEY (`id`),\n  KEY `idx_a` (`payload`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n';
  expect(parseCreateTables(ddl).map(entry => entry.name)).toEqual(['multi_line']);
});

test('duplicate table names fail loudly', () => {
  const ddl = 'CREATE TABLE IF NOT EXISTS `dup` (\n  `id` INT NOT NULL\n) ENGINE=InnoDB;\nCREATE TABLE IF NOT EXISTS `dup` (\n  `id` INT NOT NULL\n) ENGINE=InnoDB;\n';
  expect(() => parseCreateTables(ddl)).toThrow('duplicate CREATE TABLE name');
});

test('current mysql/live.sql matches the expected table set exactly', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../mysql/live.sql'), 'utf8');
  const parsed = assertExpectedTables(schema);
  expect(parsed.map(entry => entry.name).sort()).toEqual([...EXPECTED_TABLES].sort());
  expect(EXPECTED_TABLES).toHaveLength(42);
});
