const WorkJob = require("../model/job");
// 🔒 P1-10（复审批量修复）：生产环境隐藏内部报错细节，统一走 buildErrorBody
const {
  buildErrorBody,
} = require("../../../common/utils/logFields");

const WorkSalary = require("../model/salary");

/**
 * 工作与工资控制器
 */
class WorkController {
  // ========== 工作信息 CRUD ==========

  /**
   * 获取用户工作列表
   */
  async list(req, res) {
    try {
      const userId = req.userId;
      const jobs = await WorkJob.findAll(userId);
      return res.json({ status: 200, message: "查询成功", data: jobs });
    } catch (error) {
      console.error("获取工作列表错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("查询失败", error) });
    }
  }

  /**
   * 新增工作信息
   */
  async createJob(req, res) {
    try {
      const userId = req.userId;
      const {
        job_type,
        company,
        job_color,
        status,
        join_date,
        leave_date,
        pay_day,
        base_salary,
        base_work_days,
        hourly_wage,
        subsidy_meal,
        subsidy_traffic,
        subsidy_post,
        social,
        fund,
        tax_rate,
        remark,
      } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）：双路径兼容明文/加密请求

      if (!job_type || !["formal", "parttime"].includes(job_type)) {
        return res.status(400).json({
          status: 400,
          message: "job_type 必填且为 formal 或 parttime",
        });
      }

      const result = await WorkJob.create({
        userId,
        jobType: job_type,
        company,
        jobColor: job_color,
        status,
        joinDate: join_date,
        leaveDate: leave_date,
        payDay: pay_day,
        baseSalary: base_salary,
        baseWorkDays: base_work_days,
        hourlyWage: hourly_wage,
        subsidyMeal: subsidy_meal,
        subsidyTraffic: subsidy_traffic,
        subsidyPost: subsidy_post,
        social,
        fund,
        taxRate: tax_rate,
        remark,
      });

      return res.json({ status: 200, message: "创建成功", data: result });
    } catch (error) {
      console.error("创建工作错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("创建失败", error) });
    }
  }

  /**
   * 编辑工作信息
   */
  async updateJob(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const {
        company,
        job_color,
        status,
        join_date,
        leave_date,
        pay_day,
        base_salary,
        base_work_days,
        hourly_wage,
        subsidy_meal,
        subsidy_traffic,
        subsidy_post,
        social,
        fund,
        tax_rate,
        remark,
      } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）

      const existing = await WorkJob.findById(id, userId);
      if (!existing) {
        return res.status(404).json({ status: 404, message: "工作记录不存在" });
      }

      const updates = {};
      if (company !== undefined) updates.company = company;
      if (job_color !== undefined) updates.job_color = job_color;
      if (status !== undefined) updates.status = status;
      if (join_date !== undefined) updates.join_date = join_date;
      if (leave_date !== undefined) updates.leave_date = leave_date;
      if (pay_day !== undefined) updates.pay_day = pay_day;
      if (base_salary !== undefined) updates.base_salary = base_salary;
      if (base_work_days !== undefined) updates.base_work_days = base_work_days;
      if (hourly_wage !== undefined) updates.hourly_wage = hourly_wage;
      if (subsidy_meal !== undefined) updates.subsidy_meal = subsidy_meal;
      if (subsidy_traffic !== undefined)
        updates.subsidy_traffic = subsidy_traffic;
      if (subsidy_post !== undefined) updates.subsidy_post = subsidy_post;
      if (social !== undefined) updates.social = social;
      if (fund !== undefined) updates.fund = fund;
      if (tax_rate !== undefined) updates.tax_rate = tax_rate;
      if (remark !== undefined) updates.remark = remark;

      const result = await WorkJob.update(id, userId, updates);
      return res.json({ status: 200, message: "更新成功", data: result });
    } catch (error) {
      console.error("更新工作错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("更新失败", error) });
    }
  }

  /**
   * 删除工作（软删）
   */
  async deleteJob(req, res) {
    try {
      const userId = req.userId;
      const { id } = req.params;

      const result = await WorkJob.delete(id, userId);
      if (!result) {
        return res.status(404).json({ status: 404, message: "工作记录不存在" });
      }
      return res.json({ status: 200, message: "删除成功" });
    } catch (error) {
      console.error("删除工作错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("删除失败", error) });
    }
  }

  // ========== 工资查询与计算 ==========

  /**
   * 获取某一天工资
   */
  async getDaySalary(req, res) {
    try {
      const userId = req.userId;
      const { work_date, work_hours } = req.query;

      if (!work_date || !/^\d{4}-\d{2}-\d{2}$/.test(work_date)) {
        return res
          .status(400)
          .json({ status: 400, message: "work_date 必填且为 YYYY-MM-DD 格式" });
      }

      let workHoursMap = {};
      if (work_hours) {
        try {
          workHoursMap = JSON.parse(work_hours);
        } catch (e) {
          return res
            .status(400)
            .json({ status: 400, message: "work_hours 格式错误" });
        }
      }

      const result = await WorkSalary.getDaySalary(userId, work_date, workHoursMap);
      return res.json({ status: 200, message: "查询成功", data: result });
    } catch (error) {
      console.error("获取日工资错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("查询失败", error) });
    }
  }

  /**
   * 保存当日工资
   * 保存成功后，自动补充本月缺失的正式工日薪数据
   */
  async saveDaySalary(req, res) {
    try {
      const userId = req.userId;
      const { job_id, work_date, work_hours, cut, subsidy, status, remark } =
        req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）

      if (!job_id) {
        return res.status(400).json({ status: 400, message: "job_id 必填" });
      }
      if (!work_date || !/^\d{4}-\d{2}-\d{2}$/.test(work_date)) {
        return res
          .status(400)
          .json({ status: 400, message: "work_date 必填且为 YYYY-MM-DD 格式" });
      }

      const result = await WorkSalary.saveDaySalary({
        userId,
        jobId: job_id,
        workDate: work_date,
        workHours: work_hours,
        cut,
        subsidy,
        status,
        remark,
      });

      // 保存成功后，补充本月缺失的正式工日薪数据（当月1日 ~ 插入日期）
      // 🔄 2026-10-13（api.md P2-11）：原实现未 await 且无 catch ——
      //    浮空 Promise，失败即 unhandled rejection（Node 15+ 默认进程级告警/可致命），
      //    且进程退出前可能没跑完（补充静默丢失）。改为 await + try/catch：
      //    等补充完成（数据一致性），失败仅告警不阻断保存响应（保持"静默补充"语义）。
      try {
        await WorkSalary.fillMissingFormalSalary(userId, work_date);
      } catch (fillErr) {
        console.warn(
          `[work] 正式工日薪补充失败（不阻断保存）: user=${userId} date=${work_date}`,
          fillErr?.message
        );
      }

      return res.json({ status: 200, message: "保存成功", data: result });
    } catch (error) {
      console.error("保存日工资错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("保存失败", error) });
    }
  }

  /**
   * 按月统计工资
   */
  async getMonthSalary(req, res) {
    try {
      const userId = req.userId;
      const { year, month } = req.query;

      if (!year || !month) {
        return res
          .status(400)
          .json({ status: 400, message: "year 和 month 必填" });
      }

      const result = await WorkSalary.getMonthSalary(
        userId,
        parseInt(year),
        parseInt(month)
      );
      return res.json({ status: 200, message: "查询成功", data: result });
    } catch (error) {
      console.error("获取月工资错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("查询失败", error) });
    }
  }

  /**
   * 删除指定日期的所有工资记录
   */
  async deleteDaySalary(req, res) {
    try {
      const userId = req.userId;
      const { work_date } = req.body.data || req.body; // 🔄 2026-10-13（api.md P2-12 同模式）
      if (!work_date) {
        return res.status(400).json({ status: 400, message: "work_date 必填" });
      }

      const count = await WorkSalary.delete(userId, work_date);
      return res.json({ status: 200, message: `已删除${count}条记录` });
    } catch (error) {
      console.error("删除日工资错误:", error);
      return res
        .status(500)
        .json({ status: 500, ...buildErrorBody("删除失败", error) });
    }
  }
}

module.exports = new WorkController();
