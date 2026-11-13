const mysql = require('mysql2/promise');
const { AiError } = require('./errors');
const { isSupportedDraftCategory } = require('./draftPolicy');
const { financeQueryMoney } = require('./financeQueryMoney');
const { cardNameSql, cardBankJoin, dedupeCardNames } = require('./cardNames');

const CARD_NAME = cardNameSql();
const CARD_BANK_JOIN = cardBankJoin();

// Independent pool. Never import production writable pools or business models.
function createReadRepository(dbConfig) {
  const pool = mysql.createPool({ ...dbConfig, connectionLimit: 2, queueLimit: 8,
    waitForConnections: true, multipleStatements: false, connectTimeout: 5000, decimalNumbers: false });
  async function read(work) {
    const conn = await pool.getConnection();
    try {
      await conn.query('SET TRANSACTION READ ONLY');
      await conn.beginTransaction();
      const select = async (sql, params) => {
        const [rows] = await conn.execute({ sql, timeout: 5000 }, params);
        return rows;
      };
      const result = await work(select);
      await conn.rollback();
      return result;
    } catch (_) {
      await conn.rollback().catch(() => {});
      throw new AiError('只读查询失败，请检查只读账户权限及数据库结构', 503, 'AI_READ_FAILED');
    } finally { conn.release(); }
  }
  const valid = `a.user_id = ? AND a.is_deleted = 0 AND a.reversed_id IS NULL
    AND a.pay_type <> '转账' AND a.category_id <> 'CATEGORY_REPAY'
    AND a.trans_date >= ? AND a.trans_date <= ?`;
  const { cny, unpriced, currency, total, forDirection } = financeQueryMoney();
  return {
    summary(userId, { startDate, endDate }) {
      return read(async select => {
        const params = [userId, startDate, endDate];
        const totals = await select(`SELECT
          ${forDirection(1)} AS income,
          ${forDirection(0)} AS expense,
          COUNT(*) AS count, COALESCE(SUM(${unpriced}), 0) AS unpricedCount FROM account a WHERE ${valid}`, params);
        const categories = await select(`SELECT a.direction, COALESCE(c.name, '未分类') AS category,
          ${total} AS amount, COUNT(*) AS count, COALESCE(SUM(${unpriced}), 0) AS unpricedCount FROM account a
          LEFT JOIN bus_category c ON c.id = a.category_id AND c.user_id = a.user_id AND c.is_deleted = 0
          WHERE ${valid} GROUP BY a.direction, COALESCE(c.name, '未分类') ORDER BY amount DESC LIMIT 30`, params);
        return { startDate, endDate, currency: 'CNY', ...totals[0], incomplete: Number(totals[0]?.unpricedCount || 0) > 0,
          categories: categories.map(row => ({ ...row, incomplete: Number(row.unpricedCount || 0) > 0 })), categoryLimit: 30,
          policy: '消费口径：剔除转账、信用卡还款、已删除及冲正流水；已知币种与有效冻结汇率按每笔折人民币至分。币种缺失或无效、汇率缺失或非正的记录未计金额；全部未定价时金额为空，不是完整总额。' };
      });
    },
    transactions(userId, { startDate, endDate, categoryId, limit, offset }) {
      return read(async select => {
        const filter = categoryId ? ' AND a.category_id = ?' : '';
        const params = [userId, startDate, endDate, ...(categoryId ? [categoryId] : [])];
        const totals = await select(`SELECT COUNT(*) AS count, COALESCE(SUM(${unpriced}), 0) AS unpricedCount FROM account a WHERE ${valid}${filter}`, params);
        const rows = await select(`SELECT DATE_FORMAT(a.trans_date, '%Y-%m-%d') AS date, a.direction, a.amount, ${currency} AS currency,
          ${cny} AS amountCNY, COALESCE(c.name, '未分类') AS category, a.remark FROM account a
          LEFT JOIN bus_category c ON c.id = a.category_id AND c.user_id = a.user_id AND c.is_deleted = 0
          WHERE ${valid}${filter} ORDER BY a.trans_date DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
        return { startDate, endDate, rows, total: totals[0].count, unpricedCount: totals[0].unpricedCount || 0,
          incomplete: Number(totals[0].unpricedCount || 0) > 0, limit, offset,
          hasMore: offset + rows.length < totals[0].count };
      });
    },
    choices(userId) {
      return read(async select => {
        const categories = await select(`SELECT id, name, type FROM bus_category
          WHERE user_id = ? AND is_deleted = 0 AND type IN ('income', 'expense') ORDER BY sort, id LIMIT 101`, [userId]);
        const accounts = await select(`SELECT c.id, ${CARD_NAME} AS name,
          c.card_type AS type, CASE WHEN c.last4_no REGEXP '^[0-9]{1,4}$' THEN c.last4_no ELSE NULL END AS tail
          FROM card_base c ${CARD_BANK_JOIN} WHERE c.user_id = ? AND c.is_deleted = 0 AND c.status = '正常' ORDER BY c.id LIMIT 101`, [userId]);
        if (categories.length > 100 || accounts.length > 100) throw new AiError('账户或分类过多，请先使用手动记账');
        // Same shared rule as the V3 repository: no "未命名账户" and no duplicate names.
        return { categories: categories.filter(isSupportedDraftCategory), accounts: dedupeCardNames(accounts) };
      });
    },
    close: () => pool.end(),
  };
}
module.exports = { createReadRepository };
