jest.mock('mysql2/promise', () => ({ createPool: jest.fn() }));
const mysql = require('mysql2/promise');
const { createReadRepository } = require('../../src/modules/ai/service/readRepository');

describe('AI repository: SQL is fixed, scoped and read-only', () => {
  let connection, pool;
  beforeEach(() => {
    connection = { query: jest.fn().mockResolvedValue([]), beginTransaction: jest.fn().mockResolvedValue(),
      execute: jest.fn().mockResolvedValue([[{ income: '1.00', expense: '2.00', count: 1 }]]),
      rollback: jest.fn().mockResolvedValue(), release: jest.fn() };
    pool = { getConnection: jest.fn().mockResolvedValue(connection), end: jest.fn() };
    mysql.createPool.mockReturnValue(pool);
  });
  test('summary uses read-only transaction, owner-bound SELECTs, no writable fallback', async () => {
    const repo = createReadRepository({ user: 'readonly' });
    await repo.summary('current_user', { startDate: '2026-11-01', endDate: '2026-11-05' });
    expect(connection.query).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    expect(connection.query.mock.invocationCallOrder[0]).toBeLessThan(connection.beginTransaction.mock.invocationCallOrder[0]);
    for (const [statement, params] of connection.execute.mock.calls) {
      expect(statement.sql.trim()).toMatch(/^SELECT\b/i);
      expect(statement.sql).toContain('a.user_id = ?');
      expect(statement.sql).toContain('a.reversed_id IS NULL');
      expect(statement.sql).toContain("a.category_id <> 'CATEGORY_REPAY'");
      expect(params[0]).toBe('current_user');
      expect(statement.sql).not.toContain('current_user');
    }
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(mysql.createPool).toHaveBeenCalledWith(expect.objectContaining({ multipleStatements: false, user: 'readonly' }));
  });
  test('candidate output never selects full card or security fields', async () => {
    connection.execute.mockResolvedValue([[]]);
    await createReadRepository({}).choices('user_a');
    for (const [statement, params] of connection.execute.mock.calls) {
      expect(statement.sql).not.toMatch(/SELECT\s+\*|last4_no|card_bin|password|aes_key|token/i);
      expect(statement.sql).toContain('user_id = ?');
      expect(params).toEqual(['user_a']);
    }
  });
  test('database failure rolls back and releases, suppresses internal error details', async () => {
    connection.execute.mockRejectedValue(new Error('password=private; SQL internal detail'));
    await expect(createReadRepository({}).summary('a', { startDate: '2026-11-01', endDate: '2026-11-05' }))
      .rejects.toMatchObject({ code: 'AI_READ_FAILED' });
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });
  test('query cannot proceed if database refuses read-only transaction', async () => {
    connection.query.mockRejectedValue(new Error('read only not supported'));
    await expect(createReadRepository({}).choices('a')).rejects.toMatchObject({ code: 'AI_READ_FAILED' });
    expect(connection.execute).not.toHaveBeenCalled();
  });
});
