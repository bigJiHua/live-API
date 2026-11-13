'use strict';

const { generate, makeExport, assertTarget, assertMockName, parseArgs } = require('../../tools/mock-database');
const { validate, isAiTable } = require('../../tools/mock/validate');
const { createStatements, threeYearsAgo } = require('../../tools/mock/context');

describe('three-year single-user mock database', () => {
  let fixture;
  beforeAll(() => { fixture = generate({ end: '2026-11-12' }); });

  test('covers the complete historical interval and all non-AI data with AI schema intact', () => {
    expect(fixture.report.coveredDays).toBe(1097);
    expect(fixture.report.tableCount).toBe(42);
    expect(Object.entries(fixture.report.counts).filter(([table]) => !isAiTable(table)).every(([, count]) => count > 0)).toBe(true);
    expect(Object.entries(fixture.report.counts).filter(([table]) => isAiTable(table)).every(([, count]) => count === 0)).toBe(true);
    expect(fixture.ctx.schema.ai_conversation).toBeDefined();
    expect(fixture.ctx.aiHistory).toBe(false);
    expect(fixture.ctx.days[0]).toBe('2023-11-12');
    expect(fixture.ctx.days.at(-1)).toBe('2026-11-12');
  });

  test('rejects altered balances and missing daily snapshots', () => {
    const original = fixture.ctx.rows.account_balance[0].balance;
    fixture.ctx.rows.account_balance[0].balance = '9999999.99';
    expect(() => validate(fixture.ctx)).toThrow('余额与流水不一致');
    fixture.ctx.rows.account_balance[0].balance = original;
    const snapshot = fixture.ctx.rows.asset_snapshot.pop();
    expect(() => validate(fixture.ctx)).toThrow('每日快照与当日累计流水不一致');
    fixture.ctx.rows.asset_snapshot.push(snapshot);
  });

  test('same seed reproduces records without adding AI history', () => {
    expect(generate({ end: '2026-11-12' }).ctx.rows).toEqual(fixture.ctx.rows);
  });

  test('AI history is generated only with explicit opt-in', () => {
    const withHistory = generate({ end: '2026-11-12', aiHistory: true });
    expect(withHistory.ctx.rows.ai_conversation.length).toBeGreaterThan(0);
    expect(withHistory.ctx.rows.ai_message.length).toBeGreaterThan(0);
    expect(withHistory.report.aiHistory).toBe(true);
    expect(withHistory.ctx.rows.account).toEqual(fixture.ctx.rows.account);
    expect(parseArgs(['generate', '--ai-history']).options.aiHistory).toBe(true);
  });

  test('SQL comments containing semicolons remain inside complete DDL', () => {
    const statements = createStatements("CREATE TABLE IF NOT EXISTS `example` (`text` TEXT COMMENT 'a;b') ENGINE=InnoDB COMMENT='c;d';\nCREATE TABLE IF NOT EXISTS `next` (`id` INT) ENGINE=InnoDB;");
    expect(Object.keys(statements)).toEqual(['example', 'next']);
    expect(statements.example).toContain("COMMENT='c;d';");
    const exported = makeExport(fixture.ctx, 'live_mock_regression');
    expect(exported).toContain("COMMENT='Cross-device queued/running chat state; never authorizes execution';");
    expect(exported).toContain('password_changed_at');
    expect(exported).not.toMatch(/DROP TABLE|DROP DATABASE|TRUNCATE/i);
  });

  test('cannot target a live or injected database name', () => {
    expect(() => assertTarget('live')).toThrow();
    expect(() => assertTarget('live_dev')).toThrow();
    expect(() => assertTarget('live_mock_test', 'LIVE_MOCK_TEST')).toThrow();
    expect(() => assertTarget('live_mock_test`; DROP DATABASE live')).toThrow();
    expect(assertTarget('live_mock_new', 'live_dev')).toBe('live_mock_new');
    expect(assertMockName('live_mock_test')).toBe('live_mock_test');
    expect(() => assertMockName('live_dev')).toThrow();
  });

  test('leap-day endpoints clamp the three-year start to February 28', () => {
    expect(threeYearsAgo('2024-02-29')).toBe('2021-02-28');
  });
});
