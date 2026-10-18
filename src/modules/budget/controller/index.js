const Budget = require('../model/budget');

// 🔒 P1-10（复审批量修复）：生产环境隐藏内部报错细节，统一走 buildErrorBody
const {
  buildErrorBody,
} = require("../../../common/utils/logFields");

/**
 * 预算控制器
 */
class BudgetController {

  /**
   * 获取所有预算
   */
  async list(req, res) {
    try {
      const userId = req.userId;
      const budgets = await Budget.findAll(userId);
      return res.json({ status: 200, message: '查询成功', data: budgets });
    } catch (error) {
      console.error('获取预算错误:', error);
      return res.status(500).json({ status: 500, ...buildErrorBody('查询失败', error) });
    }
  }

  /**
   * 获取预算统计
   */
  async stats(req, res) {
    try {
      const userId = req.userId;
      const stats = await Budget.getStats(userId);
      return res.json({ status: 200, message: '查询成功', data: stats });
    } catch (error) {
      console.error('获取统计错误:', error);
      return res.status(500).json({ status: 500, ...buildErrorBody('查询失败', error) });
    }
  }

  /**
   * 获取单个预算
   */
  async getOne(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;

      const budget = await Budget.findById(id, userId);
      if (!budget) {
        return res.status(404).json({ status: 404, message: '预算记录不存在' });
      }
      return res.json({ status: 200, message: '查询成功', data: budget });
    } catch (error) {
      console.error('获取预算详情错误:', error);
      return res.status(500).json({ status: 500, ...buildErrorBody('查询失败', error) });
    }
  }

  /**
   * 创建预算
   */
  async create(req, res) {
    try {
      const userId = req.userId;
      // 🔄 2026-10-13（api.md P2-12）：双路径，非加密请求(无 data 包装)不再 TypeError 500
      const data = req.body.data || req.body;

      const budget = await Budget.create({
        userId,
        title: data.title,
        route: data.route,
        budgetType: data.budget_type,
        budgetAmount: data.budget_amount,
        budgetDetails: data.budget_details,
        cycle: data.cycle,
        planDate: data.plan_date
      });

      return res.json({ status: 200, message: '创建成功', data: budget });
    } catch (error) {
      console.error('创建预算错误:', error);
      return res.status(500).json({ status: 500, ...buildErrorBody('创建失败', error) });
    }
  }

  /**
   * 更新预算
   */
  async update(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;

      const budget = await Budget.update(id, userId, req.body.data || req.body);
      return res.json({ status: 200, message: '更新成功', data: budget });
    } catch (error) {
      console.error('更新预算错误:', error);
      return res.status(500).json({ status: 500, ...buildErrorBody('更新失败', error) });
    }
  }

  /**
   * 删除预算（硬删除）
   */
  async delete(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;

      const result = await Budget.permanentDelete(id, userId);
      if (!result) {
        return res.status(404).json({ status: 404, message: '预算记录不存在' });
      }
      return res.json({ status: 200, message: '删除成功' });
    } catch (error) {
      console.error('删除预算错误:', error);
      return res.status(500).json({ status: 500, ...buildErrorBody('删除失败', error) });
    }
  }
}

module.exports = new BudgetController();
