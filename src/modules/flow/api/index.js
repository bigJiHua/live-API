const express = require("express");
const router = express.Router();
const { execute } = require("../../../common/config/db");
const authGuard = require("../../../common/middleware/authGuard");

router.use(authGuard);

router.get("/calendar", async (req, res) => {
  try {
    const { year, month } = req.query;
    // 🔄 2026-10-13（api.md P3-16）：参数校验，缺参不再生成 "undefined-undefined-01"
    if (!year || !month || !/^\d{4}$/.test(String(year)) || !/^\d{1,2}$/.test(String(month))) {
      return res.say("year/month 参数不合法", 400);
    }
    const m = String(month).padStart(2, '0');
    const startDate = `${year}-${m}-01`;
    const nextMonth = parseInt(month) + 1;
    const y2 = nextMonth > 12 ? parseInt(year) + 1 : parseInt(year);
    const m2 = nextMonth > 12 ? 1 : nextMonth;
    const endDate = `${y2}-${String(m2).padStart(2, '0')}-01`;

    const [flows] = await execute(
      `SELECT DATE(trans_date) as date,
              COALESCE(SUM(CASE WHEN direction = 1 THEN amount ELSE 0 END), 0) as income,
              COALESCE(SUM(CASE WHEN direction = 0 THEN amount ELSE 0 END), 0) as expense
       FROM account
       WHERE user_id = ? AND is_deleted = 0 AND trans_date >= ? AND trans_date < ?
       GROUP BY DATE(trans_date) ORDER BY date`,
      [req.userId, startDate, endDate]
    );

    const result = {};
    flows.forEach(f => {
      result[f.date] = { income: f.income || 0, expense: f.expense || 0 };
    });
    res.json({ status: 200, data: result });
  } catch (error) {
    // 🔄 2026-10-13（api.md P2-13）：不再吞错返 200 空数据
    console.error("[Flow] calendar error:", error);
    res.say("查询失败", 500);
  }
});

// 🔒 2026-10-13（api.md §11）：GET /:id 已删——流水详情三端均走 /account/:id，无调用方。

module.exports = router;
