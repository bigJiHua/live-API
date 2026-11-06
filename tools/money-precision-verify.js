// Read-only verification of the user's reported amount and actual DECIMAL types.
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function main() {
  const connection = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'live',
    dateStrings: true, multipleStatements: false, connectTimeout: 5000 });
  try {
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,COLUMN_TYPE AS type
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND ((TABLE_NAME='account' AND COLUMN_NAME='amount')
          OR (TABLE_NAME='card_bill' AND COLUMN_NAME IN ('bill_amount','need_repay','repaid'))
          OR (TABLE_NAME='card_repay' AND COLUMN_NAME='repay_amount')) ORDER BY TABLE_NAME,COLUMN_NAME`);
    const [owners] = await connection.execute('SELECT DISTINCT user_id FROM account WHERE is_deleted=0 LIMIT 2');
    const userId = process.env.AI_TEST_USER_ID || (owners.length === 1 ? owners[0].user_id : null);
    if (!userId) throw Object.assign(new Error('Owner selection required'), { code: 'USER_SELECTION_REQUIRED' });
    const [ledger] = await connection.execute(`SELECT
      SUM(a.amount=39.9100) AS stored39_91, SUM(a.amount=39.9099) AS stored39_9099
      FROM account a JOIN card_base c ON c.id=a.card_id AND c.user_id=a.user_id
      WHERE a.user_id=? AND a.is_deleted=0 AND a.direction=0 AND a.currency='CNY' AND c.card_type='credit'
        AND a.amount IN (39.9100,39.9099)`, [userId]);
    const [bills] = await connection.execute(`SELECT SUM(bill_amount=39.9100) AS stored39_91,
      SUM(bill_amount=39.9099) AS stored39_9099 FROM card_bill
      WHERE user_id=? AND bill_amount IN (39.9100,39.9099)`, [userId]);
    const [repayments] = await connection.execute(`SELECT SUM(repay_amount=39.9100) AS stored39_91,
      SUM(repay_amount=39.9099) AS stored39_9099 FROM card_repay
      WHERE user_id=? AND is_deleted=0 AND repay_amount IN (39.9100,39.9099)`, [userId]);
    const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
    await connection.rollback();
    const report = { ok: true, readOnly: true, reportedAmount: '39.91', columns,
      matchingCounts: { creditCnyExpenses: normalize(ledger[0]), bills: normalize(bills[0]), repayments: normalize(repayments[0]) },
      recordsChanged: 0 };
    console.log(JSON.stringify(report));
    return report;
  } finally {
    await connection.rollback().catch(() => {});
    await connection.end();
  }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'MONEY_PRECISION_VERIFICATION_FAILED' }));
  process.exitCode = 1;
});
module.exports = { main };
