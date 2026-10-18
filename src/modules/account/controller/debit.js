const DebitAccount = require('../model/debit');

// 🔒 P1-10（复审批量修复）：生产环境隐藏内部报错细节，统一走 buildErrorBody
const {
  buildErrorBody,
} = require("../../../common/utils/logFields");

/**
 * 借记卡账务控制器
 * 处理借记卡/虚拟账户的收支创建、更新、冲正
 */
class DebitController {
  /**
   * 创建借记卡收支记录
   */
  async create(req, res) {
    try {
      const transaction = await DebitAccount.create({
        userId: req.userId,
        ...(req.body.data || req.body), // 🔄 2026-10-13（api.md P2-12 同模式）：双路径兼容明文/加密请求
      });

      return res.status(200).json({
        status: 200,
        message: "创建成功",
        data: transaction,
      });
    } catch (error) {
      console.error("创建借记卡收支记录错误:", error);
      return res.status(400).json({
        status: 400,
        ...buildErrorBody("创建失败", error)
      });
    }
  }

  /**
   * 更新借记卡收支记录
   */
  async update(req, res) {
    try {
      const data = req.body.data || req.body;
      const transaction = await DebitAccount.update(
        req.params.id,
        req.userId,
        data
      );

      if (!transaction) return res.status(404).json({ status: 404, message: "记录不存在" });

      return res.json({ status: 200, message: "更新成功", data: transaction });
    } catch (error) {
      console.error("更新借记卡收支记录错误:", error);
      return res.status(400).json({
        status: 400,
        ...buildErrorBody("更新失败", error)
      });
    }
  }

  /**
   * 借记卡冲正
   */
  async reverseDebit(req, res) {
    try {
      // 🔄 2026-10-13 修复（api.md F-C）：双路径兼容（同 updateRemark）。
      const { remark } = req.body.data || req.body;

      const result = await DebitAccount.reverseDebitById(req.params.id, req.userId, remark);

      return res.json({
        status: 200,
        message: "借记卡冲正成功",
        data: {
          reversed: result,
          originalId: req.params.id
        }
      });
    } catch (error) {
      console.error("借记卡冲正流水错误:", error);
      // 简化前端提示，详细信息仅在控制台输出
      let clientMsg = error.message || "冲正失败";
      if (clientMsg.includes("余额不足")) {
        clientMsg = "交易余额不足，无法冲正";
      }
      return res.status(400).json({
        status: 400,
        message: clientMsg
      });
    }
  }

  /**
   * 转账冲正
   */
  async reverseTransfer(req, res) {
    try {
      // 🔄 2026-10-13 修复（api.md F-C）：双路径兼容（同 updateRemark）。
      const { remark } = req.body.data || req.body;

      const result = await DebitAccount.reverseTransferById(req.params.id, req.userId, remark);

      return res.json({
        status: 200,
        message: "转账冲正成功",
        data: {
          reversed: result,
          originalId: req.params.id
        }
      });
    } catch (error) {
      console.error("转账冲正错误:", error);
      return res.status(400).json({
        status: 400,
        ...buildErrorBody("冲正失败", error)
      });
    }
  }
}

module.exports = new DebitController();
