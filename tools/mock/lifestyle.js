'use strict';

const assert = require('node:assert/strict');

// These records use the current model semantics: fund history stores DAILY
// profit and principal DELTAS; automatic asset snapshots store liquid assets.
// ctx.meta.lifecycle exposes daily fund/fixed values and monthly salary totals.
module.exports = function generateLifestyle(ctx) {
  const finance = ctx.meta.finance;
  assert.ok(finance && finance.dailyTotals, 'Generate finance before lifestyle');
  const { start, end, days, months } = ctx;
  const cents = value => Math.round(Number(value || 0) * 100);
  const maxDate = (a, b) => a > b ? a : b;
  const minDate = (a, b) => a < b ? a : b;
  const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const monthEnd = month => {
    const [year, number] = month.split('-').map(Number);
    return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`;
  };
  const monthDiff = (a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return (by - ay) * 12 + bm - am;
  };
  const fundDailyCents = Object.fromEntries(days.map(date => [date, 0]));
  const fixedDailyCents = Object.fromEntries(days.map(date => [date, 0]));
  const salaryDailyCents = {};
  const assetRegisterDailyTotals = {};
  const attachment = ctx.meta.attachment;

  function attach(busType, busId, date, title) {
    if (!attachment) return;
    ctx.add('sys_attachment', {
      id: ctx.id(`attachment:${busType}:${busId}`), bus_id: busId,
      bus_type: busType, remark: `Mock示例图片：${title}`, tags: 'mock,演示',
      file_name: 'placeholder.png', file_path: attachment.filePath,
      file_size: String(attachment.fileSize), file_ext: 'png',
      file_hash: attachment.fileHash, create_time: ctx.at(date, '08:00:00'),
    });
  }

  // Three opening holdings; all money added here already existed at the range
  // boundary, so the ledger does not invent purchase payments during the range.
  const fundSpecs = [
    { key: 'bond', name: 'Mock稳健债券组合', principalCents: 2000000, min: 15, max: 65 },
    { key: 'balanced', name: 'Mock均衡指数组合', principalCents: 1500000, min: -1200, max: 1350 },
    { key: 'equity', name: 'Mock成长权益组合', principalCents: 1000000, min: -2400, max: 2700 },
  ];
  for (const [index, spec] of fundSpecs.entries()) {
    const fundId = ctx.id(`fund:${spec.key}`);
    let profitCents = 0;
    for (const date of days) {
      const weekend = [0, 6].includes(weekday(date));
      const deltaCents = weekend ? 0 : ctx.int(spec.min, spec.max);
      profitCents += deltaCents;
      ctx.add('bus_fund_history', {
        id: ctx.id(`fund-history:${spec.key}:${date}`), fund_id: fundId,
        net_value: `${ctx.money(deltaCents)}00`, market_val: '0.00',
        record_date: date, create_time: ctx.at(date, '18:00:00'),
      });
      fundDailyCents[date] += spec.principalCents + profitCents;
    }
    ctx.add('fund', {
      id: fundId, fund_name: spec.name, share: ctx.money(spec.principalCents),
      fund_account: `MOCK0${index}`, trade_account: `MOCK00000${index}`,
      sell_org: 'Mock模拟销售平台', fund_company: 'Mock模拟基金管理人',
      buy_date: start, last_report_date: end, invest: ctx.money(spec.principalCents),
      net_value: `${ctx.money(profitCents)}00`,
      market_val: ctx.money(spec.principalCents + profitCents),
      rate: `${(profitCents * 100 / spec.principalCents).toFixed(2)}%`,
      create_time: ctx.at(start, '07:00:00'),
    });
  }

  const fixedSpecs = [
    { key: 'computer', name: 'Mock工作笔记本', tag: '数码', priceCents: 980000, years: 5 },
    { key: 'phone', name: 'Mock智能手机', tag: '数码', priceCents: 420000, years: 3 },
    { key: 'bike', name: 'Mock通勤自行车', tag: '交通', priceCents: 180000, years: 8 },
    { key: 'furniture', name: 'Mock桌椅组合', tag: '家具', priceCents: 260000, years: 8 },
    { key: 'camera', name: 'Mock旅行相机', tag: '数码', priceCents: 680000, years: 6 },
  ];
  for (const spec of fixedSpecs) {
    const fixedId = ctx.id(`fixed:${spec.key}`);
    const useMonths = spec.years * 12;
    const residualCents = Math.round(spec.priceCents * 5 / 100);
    const depreciableCents = spec.priceCents - residualCents;
    const monthlyCents = Math.round(depreciableCents / useMonths);
    const valueAt = date => spec.priceCents - Math.min(depreciableCents, monthlyCents * Math.max(0, monthDiff(start, date)));
    const nowCents = valueAt(end);
    for (const date of days) fixedDailyCents[date] += valueAt(date);
    ctx.add('fixed_asset', {
      id: fixedId, info: spec.name, tag: spec.tag,
      img_url: attachment ? attachment.url : '',
      buy_price: ctx.money(spec.priceCents), now_val: ctx.money(nowCents),
      secondhand_price: ctx.money(Math.round(nowCents * 0.8)),
      use_years: String(spec.years), use_months: useMonths,
      residual_rate: '5.00', residual_val: ctx.money(residualCents),
      deprec_method: 'straight', month_deprec: ctx.money(monthlyCents),
      total_deprec: ctx.money(spec.priceCents - nowCents), buy_date: start,
      last_deprec_date: end, scrap_date: null, create_time: start,
      deprec_finished: nowCents === residualCents ? 1 : 0, status: 'using',
    });
    attach('product', fixedId, start, spec.name);
  }

  // One job per historical salary band avoids applying today's salary rule to
  // previous years. Monthly ledger receipts are the sum of earned weekdays.
  const salaryByYear = { 2023: 55000, 2024: 58000, 2025: 62000, 2026: 66000 };
  const jobs = {};
  for (const year of [...new Set(days.map(date => date.slice(0, 4)))]) {
    const joinDate = maxDate(start, `${year}-01-01`);
    const leaveDate = minDate(end, `${year}-12-31`);
    const dailyCents = salaryByYear[year] || 66000;
    const jobId = ctx.id(`job:formal:${year}`);
    jobs[year] = jobId;
    ctx.add('work_job', {
      id: jobId, job_type: 'formal', company: 'Mock生活科技有限公司',
      job_color: '#07c160', status: year === end.slice(0, 4) ? 1 : 0,
      join_date: joinDate, leave_date: year === end.slice(0, 4) ? null : leaveDate,
      pay_day: 31, base_salary: ctx.money(dailyCents * 22), base_work_days: 22,
      hourly_wage: '0.00', subsidy_meal: '0.00', subsidy_traffic: '0.00',
      subsidy_post: '0.00', social: '0.00', fund: '0.00', tax_rate: '0.00',
      remark: 'Mock税后等额简化规则，每月月底结算',
      create_at: ctx.datetime(joinDate, '09:00:00'),
    });
  }
  for (const date of days) {
    if ([0, 6].includes(weekday(date))) continue;
    const year = date.slice(0, 4);
    const dailyCents = salaryByYear[year] || 66000;
    salaryDailyCents[date] = dailyCents;
    const receipt = finance.salaryLedgerByMonth[date.slice(0, 7)];
    ctx.add('work_salary', {
      id: ctx.id(`salary:formal:${date}`), job_id: jobs[year], job_type: 'formal',
      work_date: date, work_date_dt: date, work_hours: '0.00',
      day_salary: ctx.money(dailyCents), subsidy: '0.00', cut: '0.00',
      social: '0.00', fund: '0.00', tax: '0.00', income: ctx.money(dailyCents),
      status: receipt ? 2 : 1,
      remark: receipt ? 'Mock月末工资已发放' : 'Mock本月已赚待月末发放',
      update_at: ctx.datetime(receipt ? receipt.transDate : date, '18:00:00'),
    });
  }

  const budgetSpecs = [
    { key: 'food', type: '吃', title: '餐饮', limitCents: 260000 },
    { key: 'shopping', type: '买', title: '购物', limitCents: 150000 },
    { key: 'transport', type: '行', title: '交通', limitCents: 50000 },
  ];
  for (const month of months) {
    const date = maxDate(start, `${month}-01`);
    const updated = minDate(end, monthEnd(month));
    for (const spec of budgetSpecs) {
      const category = finance.categories[spec.key];
      const usedCents = finance.monthlyExpenses[month]?.byCategory[category.id] || 0;
      ctx.add('budget', {
        id: ctx.id(`budget:${spec.key}:${month}`), title: `${month} ${spec.title}预算`,
        route: null, budget_type: spec.type, budget_amount: ctx.money(spec.limitCents),
        used_amount: ctx.money(usedCents),
        budget_details: JSON.stringify({ category: spec.type, category_id: category.id, target: `${spec.title}支出`, notes: 'Mock，已使用金额由同月同分类真实mock流水汇总' }),
        cycle: '月', plan_date: date, is_over_budget: usedCents > spec.limitCents ? 1 : 0,
        is_excute: updated < end || monthEnd(month) <= end ? 1 : 0,
        create_time: ctx.at(date, '07:30:00'), update_time: ctx.at(updated, '20:00:00'),
      });
    }
  }

  function recurringFromLedger(key, name, amountCents, day) {
    const category = finance.categories[key];
    const records = {};
    const matching = ctx.rows.account.filter(row => row.direction === 0 && row.category_id === category.id && !row.is_deleted);
    for (const month of months) {
      const flows = matching.filter(row => row.trans_date.slice(0, 7) === month);
      const sumCents = flows.reduce((sum, row) => sum + cents(row.amount), 0);
      const recordDate = `${month}-${String(day).padStart(2, '0')}`;
      if (recordDate < start) continue;
      if (flows.length) {
        const lastDate = flows.map(row => row.trans_date).sort().at(-1);
        records[month] = { status: 'done', amount: Number(ctx.money(sumCents)), done_time: ctx.datetime(lastDate, '18:00:00'), remark: `Mock流水 ${flows.map(row => row.id).join(',')}` };
      } else if (recordDate <= end) {
        records[month] = { status: 'skipped', amount: Number(ctx.money(amountCents)), done_time: ctx.datetime(recordDate, '18:00:00'), remark: 'Mock该期无对应消费，已跳过' };
      } else {
        records[month] = { status: 'pending', amount: Number(ctx.money(amountCents)), done_time: null, remark: 'Mock尚未到期' };
      }
    }
    const preferred = matching[0]?.card_id || finance.cards.find(card => card.card_type === 'debit')?.id;
    let nextDate = `${end.slice(0, 7)}-${String(day).padStart(2, '0')}`;
    if (nextDate <= end) nextDate = `${ctx.addDays(monthEnd(end.slice(0, 7)), 1).slice(0, 7)}-${String(day).padStart(2, '0')}`;
    ctx.add('bus_recurring', {
      id: ctx.id(`recurring:${key}`), name, amount: ctx.money(amountCents),
      category_id: category.id, account_id: preferred || null, cycle: 'month',
      day_of_cycle: day, month_of_cycle: null, next_date: nextDate, remind_days: 2,
      remark: 'Mock计划，历史状态依据mock账本', month_records: JSON.stringify(records),
      end_date: null, repeat_count: null, notify_channel: 'none', is_active: 1,
      create_time: ctx.at(start, '07:00:00'), update_time: ctx.at(end, '20:00:00'),
    });
  }
  recurringFromLedger('rent', 'Mock每月房租', 350000, 3);
  recurringFromLedger('utilities', 'Mock每月水电网络', 30000, 8);

  const annualRecords = {};
  for (const year of Object.keys(jobs)) {
    const date = `${year}-${start.slice(5)}`;
    if (date >= start && date <= end) annualRecords[date.slice(0, 7)] = {
      status: 'skipped', amount: 299, done_time: ctx.datetime(date, '18:00:00'),
      remark: 'Mock年度订阅已取消续费，无入账流水',
    };
  }
  ctx.add('bus_recurring', {
    id: ctx.id('recurring:annual'), name: 'Mock年度订阅续费（已停用）', amount: '299.00',
    category_id: finance.categories.entertainment.id, account_id: null,
    cycle: 'year', day_of_cycle: Number(start.slice(8)), month_of_cycle: Number(start.slice(5, 7)),
    next_date: null, remind_days: 7, remark: 'Mock历年跳过/结束年度计划',
    month_records: JSON.stringify(annualRecords), end_date: end, repeat_count: null,
    notify_channel: 'none', is_active: 0, create_time: ctx.at(start, '07:00:00'),
    update_time: ctx.at(end, '20:00:00'),
  });

  const installments = finance.installmentLedgerByMonth || {};
  const installmentMonths = Object.keys(installments).sort();
  if (installmentMonths.length) {
    const first = installments[installmentMonths[0]];
    const last = installments[installmentMonths.at(-1)];
    const card = finance.cards.find(row => row.id === first.cardId);
    const records = {};
    for (const month of installmentMonths) {
      const flow = installments[month];
      const billingDay = Number(card.bill_day);
      const billMonth = Number(flow.transDate.slice(8)) <= billingDay ? month : ctx.addDays(monthEnd(month), 1).slice(0, 7);
      records[month] = {
        status: 'entered', amount: Number(ctx.money(flow.amountCents)),
        remark: flow.ledgerId, plan_date: flow.transDate, bill_month: billMonth,
        entered_at: ctx.datetime(flow.transDate, '12:00:00'), done_time: ctx.datetime(flow.transDate, '12:00:00'),
      };
    }
    ctx.add('bus_recurring', {
      id: ctx.id('recurring:installment'), name: 'Mock数码分期（已完成）',
      amount: ctx.money(first.amountCents), category_id: finance.categories.installment.id,
      account_id: JSON.stringify({ type: 'installment', card_id: first.cardId, card_name: card.alias, billing_day: Number(card.bill_day), total_periods: installmentMonths.length }),
      cycle: 'month', day_of_cycle: Number(first.transDate.slice(8)), month_of_cycle: null,
      next_date: null, remind_days: 2, remark: 'Mock已入账分期，所有期次均关联消费流水',
      month_records: JSON.stringify(records), end_date: last.transDate,
      repeat_count: installmentMonths.length, notify_channel: 'none', is_active: 0,
      create_time: ctx.at(first.transDate, '08:00:00'), update_time: ctx.at(last.transDate, '18:00:00'),
    });
  }

  const workDiary = ['今天完成了项目评审，午后整理了本周任务。', '把复杂问题拆成几步，工作推进得很顺利。', '午休散步后精神不错，晚上读了几页书。', '下班后做了简单的晚饭，记录一下今天的收支。', '练习早点休息，保持稳定的生活节奏。'];
  const weekendDiary = ['周末在公园散步，拍了一些沿途风景。', '和朋友一起吃饭，聊了最近的计划。', '整理房间和书桌，给下周留一点余地。', '在家做饭，看了一部轻松的电影。', '骑车去附近看看，享受慢一点的节奏。'];
  const registerDates = new Set([start, end, ...months.map(month => minDate(end, monthEnd(month)))]);
  for (const [index, date] of days.entries()) {
    const liquid = finance.dailyTotals[date];
    assert.ok(liquid, `Missing finance daily total on ${date}`);
    ctx.add('asset_snapshot', {
      id: ctx.id(`asset-snapshot:${date}`), total_asset: ctx.money(liquid.assetCents),
      credit_debt: ctx.money(liquid.debtCents), total_balance: ctx.money(liquid.balanceCents),
      record_date: date, record_time: ctx.datetime(date, '23:00:00'),
      create_time: ctx.at(date, '23:00:00'), update_time: ctx.at(date, '23:00:00'),
    });
    const totalCents = liquid.assetCents + fundDailyCents[date] + fixedDailyCents[date];
    assetRegisterDailyTotals[date] = { assetCents: totalCents, debtCents: liquid.debtCents, balanceCents: totalCents - liquid.debtCents };
    if (registerDates.has(date)) ctx.add('asset_register', {
      id: ctx.id(`asset-register:${date}`), total_asset: ctx.money(totalCents),
      credit_debt: ctx.money(liquid.debtCents), total_balance: ctx.money(totalCents - liquid.debtCents),
      asset_details: JSON.stringify({ cash_and_bank: Number(ctx.money(liquid.assetCents)), fund: Number(ctx.money(fundDailyCents[date])), fixed: Number(ctx.money(fixedDailyCents[date])), scope: '现金/银行卡+期初基金持仓及累计收益+期初固定资产折旧后价值' }),
      register_date: date, register_time: ctx.datetime(date, '23:00:00'),
      remark: 'Mock月末全口径资产核算，期初基金和固定资产已持有',
      create_time: ctx.at(date, '23:00:00'), update_time: ctx.at(date, '23:00:00'),
    });
    const weekend = [0, 6].includes(weekday(date));
    const entries = weekend ? weekendDiary : workDiary;
    const mainId = ctx.id(`moment:main:${date}`);
    const photo = attachment && index % 30 === 0;
    ctx.add('moment', {
      id: mainId, parent_id: mainId,
      content: `${date}｜Mock生活日记\n${entries[index % entries.length]}`,
      img_url: photo ? JSON.stringify([attachment.url]) : null,
      mood: JSON.stringify(['平静', '开心', '充实', '轻松', '有点疲惫'][index % 5]),
      location: JSON.stringify(weekend ? 'Mock城市公园' : 'Mock居住城市'),
      visible_type: JSON.stringify({ vt: 0, vs: 0, pw: 0 }),
      create_time: ctx.at(date, '20:00:00'), update_time: ctx.at(date, '20:00:00'),
    });
    if (photo) attach('moment', mainId, date, '日记生活照片');
    if (index % 7 === 0) ctx.add('moment', {
      id: ctx.id(`moment:append:${date}`), parent_id: mainId,
      content: 'Mock补充记录：本周做到了按计划记账和运动。',
      img_url: null, mood: JSON.stringify('充实'), location: JSON.stringify('Mock家中'),
      visible_type: JSON.stringify({ vt: 0, vs: 0, pw: 0 }),
      create_time: ctx.at(date, '21:00:00'), update_time: ctx.at(date, '21:00:00'),
    });
    if (index % 3 === 0 || date === end) {
      const old = date < ctx.addDays(end, -7);
      const status = old ? (index % 13 === 0 ? '逾期' : '已完成') : '待完成';
      ctx.add('todo', {
        id: ctx.id(`todo:${date}`), content: ['Mock整理工作任务', 'Mock完成运动打卡', 'Mock阅读与学习', 'Mock检查月度预算', 'Mock购买日常用品'][index % 5],
        event_type: '日程', happen_date: date, status, priority: 1 + index % 3,
        need_remind: old ? 0 : 1, remind_time: old ? null : ctx.at(date, '09:00:00'),
        is_recurring: 0, remark: 'Mock历史状态与截止日期一致',
        create_time: ctx.at(maxDate(start, ctx.addDays(date, -2)), '08:00:00'),
        update_time: ctx.at(date, status === '已完成' ? '18:00:00' : '08:00:00'),
      });
    }
  }

  ctx.meta.lifecycle = { fundDailyCents, fixedDailyCents, salaryDailyCents, assetRegisterDailyTotals,
    openingFundCents: fundSpecs.reduce((sum, row) => sum + row.principalCents, 0),
    openingFixedCents: fixedSpecs.reduce((sum, row) => sum + row.priceCents, 0),
    automaticSnapshotScope: 'liquid assets minus credit debt',
    manualRegisterScope: 'liquid assets plus funds plus depreciated fixed assets minus credit debt',
  };
};
