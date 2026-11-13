'use strict';

// No database calls: these existing methods only calculate bill calendar dates.
const CardBill = require('../../src/modules/card/model/bill');

/**
 * Create coherent, seeded financial records for a single user.
 * meta.finance is shared with the lifestyle generator:
 * dailyTotals[date] = {assetCents, debtCents, balanceCents};
 * monthlyExpenses[month] = {totalCents, byCategory:{categoryId:cents}};
 * salaryLedgerByMonth[month] = {ledgerId, amountCents, transDate};
 * salaryCentsByMonth includes earned wages for incomplete boundary months.
 * Every amount is calculated as integer cents. Credit account_balance rows are
 * deliberately absent: current AccountSettlement uses card_bill for credit.
 */
module.exports = function generateFinance(ctx) {
  const categories = {};
  const categoryDefinitions = [
    ['food', '餐饮', 'expense'], ['transport', '交通', 'expense'],
    ['rent', '住房', 'expense'], ['utilities', '水电通讯', 'expense'],
    ['shopping', '购物', 'expense'], ['travel', '旅行', 'expense'],
    ['health', '医疗健康', 'expense'], ['entertainment', '休闲娱乐', 'expense'],
    ['installment', '数码分期', 'expense'],
    ['salary', '工资', 'income'], ['bonus', '奖金', 'income'],
    ['opening', '期初资金', 'income'], ['refund', '退款', 'income'],
    ['repay', '信用卡还款', 'expense'], ['transfer', '转账', 'expense'],
  ];
  categoryDefinitions.forEach(([key, name, type], index) => {
    const id = key === 'repay' ? 'CATEGORY_REPAY' : ctx.id(`category:${key}`);
    categories[key] = { id, name };
    ctx.add('bus_category', { id, name, type, sort: index + 1, remark: '合成演示分类' });
  });
  const bankDefinitions = [
    ['cash', 'xxxx', '现金'], ['digital', 'yyyy', '余额'],
    ['cmb', ctx.id('bank:cmb'), '招商银行'],
    ['icbc', ctx.id('bank:icbc'), '工商银行'],
    ['abc', ctx.id('bank:abc'), '农业银行'],
  ];
  for (const [, id, name] of bankDefinitions) {
    ctx.add('bus_category', { id, name, type: 'bank', sort: 80, remark: '合成演示银行' });
  }
  // Seed categories used by the separate asset/lifestyle modules and their UI.
  for (const [key, name, type] of [
    ['fund', '基金理财', 'asset'], ['bank_asset', '银行存款', 'asset'],
    ['digital_asset', '数字钱包', 'asset'], ['cash_asset', '现金', 'asset'],
    ['credit_debt', '信用卡负债', 'asset'],
    ['electronics', '数码设备', 'fixed'], ['vehicle', '交通工具', 'fixed'],
  ]) {
    const id = ctx.id(`category:${key}`);
    categories[key] = { id, name };
    ctx.add('bus_category', { id, name, type, sort: 100, remark: '合成演示分类' });
  }
  const poolId = ctx.id('credit-pool:abc');
  ctx.add('card_credit_pool', {
    id: poolId, bank_id: ctx.id('bank:abc'), bank_name: '农业银行',
    total_credit_limit: '40000.00', total_temp_limit: '5000.00',
    credit_report_merged: 0, currency: 'CNY', remark: '两卡共享额度，合成数据',
  });
  const specs = [
    { key: 'cash', id: 'xxxx', bank_id: 'xxxx', card_type: 'virtual_cash', alias: '现金', last4_no: '0000', opening: 120000 },
    { key: 'digital', id: 'yyyy', bank_id: 'yyyy', card_type: 'virtual_balance', alias: '微信支付宝余额', last4_no: '0001', opening: 200000 },
    { key: 'salary', bank_id: ctx.id('bank:cmb'), card_type: 'debit', alias: '工资储蓄卡', last4_no: '6001', opening: 3000000 },
    { key: 'savings', bank_id: ctx.id('bank:icbc'), card_type: 'debit', alias: '应急储蓄卡', last4_no: '6002', opening: 8000000 },
    { key: 'credit', bank_id: ctx.id('bank:cmb'), card_type: 'credit', alias: '日常信用卡', last4_no: '7001', credit_limit: '30000.00', bill_day: 15, repay_day: 25 },
    { key: 'pool_main', bank_id: ctx.id('bank:abc'), card_type: 'credit', alias: '农行共享主卡', last4_no: '7002', credit_limit: '40000.00', bill_day: 5, repay_day: 20, share_pool_id: poolId },
    { key: 'pool_sub', bank_id: ctx.id('bank:abc'), card_type: 'credit', alias: '农行共享外币卡', last4_no: '7003', credit_limit: '40000.00', bill_day: 5, repay_day: 20, share_pool_id: poolId, card_org: 'Visa' },
  ];
  const cards = specs.map((spec, index) => {
    const { key, opening, ...fields } = spec;
    return ctx.add('card_base', {
      id: spec.id || ctx.id(`card:${key}`), card_bin: '000000',
      card_length: '16', card_org: '银联', card_level: '金卡', main_sub: '主卡',
      last4_no: spec.last4_no, open_date: ctx.start,
      expire_date: `${Number(ctx.end.slice(0, 4)) + 5}-12-31`,
      credit_limit: '0.00', temp_limit: spec.share_pool_id ? '5000.00' : '0.00',
      bill_day: 0, repay_day: 0, currency: 'CNY', status: '正常',
      is_default: key === 'salary' ? 1 : 0, is_hide: 0, sort: index + 1,
      source_from: '手动', remark: '合成演示卡片，非真实卡号',
      color: ['#2E7D32', '#1565C0', '#C62828', '#6A1B9A'][index % 4],
      points_rate: '1.00', ...fields,
    });
  });
  const byKey = Object.fromEntries(specs.map((spec, index) => [spec.key, cards[index]]));
  const byId = new Map(cards.map(card => [card.id, card]));
  const balances = Object.fromEntries(cards.map(card => [card.id, 0]));
  const spentByCard = Object.fromEntries(cards.filter(card => card.card_type === 'credit').map(card => [card.id, 0]));
  const repaidByCard = Object.fromEntries(cards.filter(card => card.card_type === 'credit').map(card => [card.id, 0]));
  const groups = new Map();
  const monthlyExpenses = Object.fromEntries(ctx.months.map(month => [month, { totalCents: 0, byCategory: {} }]));
  const dailyTotals = {};
  const salaryCentsByMonth = Object.fromEntries(ctx.months.map(month => [month, 0]));
  const salaryLedgerByMonth = {};
  const installmentLedgerByMonth = {};
  const openingCentsByCard = {};
  let sequence = 0;
  const localDay = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const lastOfMonth = month => {
    const [year, number] = month.split('-').map(Number);
    return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
  };
  const dailyWage = date => ({ 2023: 55000, 2024: 58000, 2025: 62000, 2026: 66000 }[Number(date.slice(0, 4))] || 66000);
  for (const date of ctx.days) if (![0, 6].includes(localDay(date))) salaryCentsByMonth[date.slice(0, 7)] += dailyWage(date);

  function groupFor(card, date) {
    // A local noon string avoids Date('YYYY-MM-DD') becoming the previous day
    // on computers west of UTC; all helpers retain the repository's calendar.
    const month = CardBill.getBillMonthByDate(`${date}T12:00:00`, card.bill_day);
    const key = `${card.id}:${month}`;
    if (!groups.has(key)) {
      groups.set(key, { id: ctx.id(`bill:${key}`), card, month, spent: 0, repaid: 0, firstDate: date });
    }
    return groups.get(key);
  }
  function account(date, card, direction, categoryKey, cents, remark, extra = {}) {
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Mock money must be positive integer cents');
    const category = categories[categoryKey];
    const record = ctx.add('account', {
      id: ctx.id(`account:${sequence++}:${date}`), card_id: card.id,
      category_id: category.id, direction,
      pay_type: category.name,
      pay_method: card.card_type === 'credit' ? '信用卡' : card.id === 'xxxx' ? '现金' : card.id === 'yyyy' ? '余额' : '银行卡',
      account_type: card.card_type, amount: ctx.money(cents), currency: 'CNY', exchange_rate: '1.0000',
      trans_date: date, remark, create_time: ctx.at(date), update_time: ctx.at(date),
      reversed_id: null, ...extra,
    });
    if (card.card_type === 'credit') {
      if (direction !== 0) throw new Error('Ordinary mock credit cards only accept expenses');
      spentByCard[card.id] += cents;
      groupFor(card, date).spent += cents;
    } else {
      balances[card.id] += direction === 1 ? cents : -cents;
      if (balances[card.id] < 0) throw new Error(`Mock overdraft ${card.alias} ${date}`);
    }
    if (direction === 0 && !['repay', 'transfer'].includes(categoryKey)) {
      const aggregate = monthlyExpenses[date.slice(0, 7)];
      aggregate.totalCents += cents;
      aggregate.byCategory[category.id] = (aggregate.byCategory[category.id] || 0) + cents;
    }
    return record;
  }
  function transfer(date, from, to, cents, remark) {
    const groupId = ctx.id(`transfer:${from.id}:${to.id}:${date}`);
    account(date, from, 0, 'transfer', cents, remark, { id: groupId, pay_type: '转账', transfer_group_id: groupId });
    account(date, to, 1, 'transfer', cents, remark, { pay_type: '转账', transfer_group_id: groupId });
    ctx.add('account_transfer', {
      id: groupId, from_card_id: from.id, to_card_id: to.id,
      amount: ctx.money(cents), trans_date: date, remark, create_time: ctx.at(date),
    });
  }
  function repay(date, group, cents, part) {
    if (cents <= 0) return;
    const card = group.card;
    const ledger = account(date, byKey.salary, 0, 'repay', cents, `偿还${card.alias}${group.month}账单${part}`, { pay_type: '还款' });
    group.repaid += cents;
    repaidByCard[card.id] += cents;
    ctx.add('card_repay', {
      id: ctx.id(`repay:${card.id}:${group.month}:${part}`), card_id: card.id,
      account_id: ledger.id, bill_id: group.id, bill_month: group.month,
      repay_amount: ctx.money(cents), repay_method: 'bank_card', repay_card_id: byKey.salary.id,
      repay_time: date, remark: `合成账单还款${part}`, create_time: ctx.at(date), update_time: ctx.at(date),
    });
    ctx.add('card_log', { id: ctx.id(`card-log:repay:${ledger.id}`), card_id: card.id, operate_type: '还款', operate_time: ctx.at(date), operate_ip: '192.0.2.10' });
  }
  function foreignExpense(date, currency) {
    // Integer foreign prices and integer rates yield exact CNY cents while the
    // persisted source still exercises four-decimal foreign fields.
    const price = ctx.int(12, 70);
    const rate = currency === 'USD' ? ctx.int(690, 725) : ctx.int(88, 94);
    const cents = price * rate;
    const ledger = account(date, byKey.pool_sub, 0, 'shopping', cents, `合成${currency}跨境消费`, {
      amount: `${price}.0000`, currency, exchange_rate: `${rate}.0000`,
    });
    ctx.add('card_foreign_register', {
      id: ctx.id(`foreign:${ledger.id}`), card_id: byKey.pool_sub.id, account_id: ledger.id,
      currency, foreign_amount: `${price}.0000`, registered_rate: `${rate}.0000`,
      registered_rmb: `${ctx.money(cents)}00`, actual_rate: `${rate}.0000`, actual_rmb: `${ctx.money(cents)}00`,
      settle_date: date, status: 'reconciled', remark: '合成银行同日结算，原币与人民币一致',
      create_time: ctx.at(date), update_time: ctx.at(date),
    });
  }
  // Deleted original + linked reverse is the repository's reversal mechanism;
  // neither contributes to current settled totals. Same-day cancellation keeps
  // historical daily snapshots consistent with the current ledger predicate.
  function cancelledPurchase(date) {
    const card = byKey.credit;
    const original = ctx.id(`cancelled:${date}`);
    const base = { card_id: card.id, category_id: categories.shopping.id, pay_type: '购物',
      pay_method: '信用卡', account_type: 'credit', amount: '39.90', currency: 'CNY', exchange_rate: '1.0000',
      trans_date: date, create_time: ctx.at(date, '16:00:00'), update_time: ctx.at(date, '16:10:00') };
    ctx.add('account', { ...base, id: original, direction: 0, is_deleted: 1, reversed_id: null, remark: '合成订单当日取消' });
    ctx.add('account', { ...base, id: ctx.id(`reversal:${date}`), direction: 1, is_deleted: 0, reversed_id: original, remark: '冲正：合成订单当日取消' });
  }

  for (const spec of specs) {
    const card = byKey[spec.key];
    ctx.add('card_log', { id: ctx.id(`card-log:open:${card.id}`), card_id: card.id, operate_type: '新增', operate_time: ctx.at(ctx.start, '08:00:00'), operate_ip: '192.0.2.10' });
    if (spec.opening) {
      openingCentsByCard[card.id] = spec.opening;
      account(ctx.start, card, 1, 'opening', spec.opening, '三年模拟区间期初资金', { create_time: ctx.at(ctx.start, '08:01:00'), update_time: ctx.at(ctx.start, '08:01:00') });
    }
  }
  const holidays = {
    2023: [], 2024: ['02-10', '02-11', '02-12'],
    2025: ['01-29', '01-30', '01-31'], 2026: ['02-17', '02-18', '02-19'],
  };
  for (const [index, date] of ctx.days.entries()) {
    const day = Number(date.slice(8, 10));
    const month = date.slice(0, 7);
    const weekend = [0, 6].includes(localDay(date));
    if (day === 2) transfer(date, byKey.salary, byKey.digital, 210000, '补充生活钱包');
    if (day === 10) transfer(date, byKey.salary, byKey.cash, 40000, '现金备用');
    if (day === 28) transfer(date, byKey.salary, byKey.savings, 150000, '定期储蓄');
    if (day === 3) account(date, byKey.salary, 0, 'rent', 350000, '住房月租');
    if (day === 8) account(date, byKey.salary, 0, 'utilities', ctx.int(26000, 39000), '水电燃气与宽带');

    account(date, byKey.digital, 0, 'food', ctx.int(900, 1800), '早餐与咖啡');
    account(date, index % 3 === 0 ? byKey.pool_main : byKey.credit, 0, 'food', ctx.int(2200, 4200), weekend ? '周末午餐' : '工作日午餐');
    account(date, byKey.credit, 0, 'food', ctx.int(2100, 3900), '晚餐与买菜');
    if (!weekend) account(date, byKey.digital, 0, 'transport', ctx.int(600, 1400), '通勤地铁公交');
    else if (day % 2 === 0) account(date, byKey.pool_main, 0, 'entertainment', ctx.int(5500, 18000), '周末电影与朋友聚会');
    if (day % 7 === 0) account(date, byKey.cash, 0, 'food', ctx.int(1800, 4000), '社区市场采购');
    if (day === 16) account(date, byKey.pool_main, 0, 'shopping', ctx.int(18000, 65000), '日用品与服饰');
    if (day === 22 && Number(date.slice(5, 7)) % 3 === 0) account(date, byKey.salary, 0, 'health', ctx.int(18000, 49000), '体检与药品');
    if (day === 18 && Number(date.slice(5, 7)) % 2 === 0) foreignExpense(date, Number(date.slice(5, 7)) % 4 === 0 ? 'USD' : 'HKD');
    if (day === 13 && ctx.months.indexOf(month) < 6) {
      const ledger = account(date, byKey.credit, 0, 'installment', 39900, '数码设备六期付款', { pay_type: 'installment' });
      installmentLedgerByMonth[month] = { ledgerId: ledger.id, amountCents: 39900, transDate: date, cardId: byKey.credit.id };
    }
    if (day === 21 && Number(date.slice(5, 7)) % 4 === 0) cancelledPurchase(date);
    const mmdd = date.slice(5);
    if ((holidays[Number(date.slice(0, 4))] || []).includes(mmdd)) account(date, byKey.credit, 0, 'shopping', ctx.int(38000, 78000), '春节礼物与家庭采购');
    if (mmdd === '11-11') account(date, byKey.pool_main, 0, 'shopping', ctx.int(88000, 188000), '双十一计划采购');
    if (['05-02', '10-02'].includes(mmdd)) account(date, byKey.credit, 0, 'travel', ctx.int(110000, 260000), '假期短途旅行');
    if (mmdd === '01-20') account(date, byKey.salary, 1, 'bonus', ctx.int(600000, 1000000), '年度绩效奖金');
    if (date === lastOfMonth(month) && salaryCentsByMonth[month] > 0) {
      const cents = salaryCentsByMonth[month];
      const ledger = account(date, byKey.salary, 1, 'salary', cents, `${month}工作日薪酬结算`);
      salaryLedgerByMonth[month] = { ledgerId: ledger.id, amountCents: cents, transDate: date };
    }
    for (const group of groups.values()) {
      const due = CardBill.calculateRepayDate(group.month, group.card.repay_day);
      if (ctx.addDays(due, -10) === date && group.repaid === 0) repay(date, group, Math.floor(group.spent * 0.6), '第一笔');
      if (due === date) repay(date, group, group.spent - group.repaid, '结清');
    }
    const assetCents = Object.values(balances).reduce((total, amount) => total + amount, 0);
    const debtCents = Object.keys(spentByCard).reduce((total, id) => total + Math.max(0, spentByCard[id] - repaidByCard[id]), 0);
    dailyTotals[date] = { assetCents, debtCents, balanceCents: assetCents - debtCents };
  }

  const poolDebt = [byKey.pool_main, byKey.pool_sub].reduce((total, card) => total + spentByCard[card.id] - repaidByCard[card.id], 0);
  for (const card of cards.filter(row => row.card_type !== 'credit')) {
    ctx.add('account_balance', { id: ctx.id(`balance:${card.id}`), card_id: card.id, balance: ctx.money(balances[card.id]), currency: 'CNY' });
  }
  for (const card of cards.filter(row => row.card_type === 'credit')) {
    let cumulativeSpent = 0;
    let cumulativeRepaid = 0;
    let carry = 0;
    const cardGroups = [...groups.values()].filter(group => group.card.id === card.id).sort((a, b) => a.month.localeCompare(b.month));
    for (const group of cardGroups) {
      cumulativeSpent += group.spent;
      cumulativeRepaid += group.repaid;
      const applied = Math.min(group.spent, group.repaid + carry);
      carry = Math.max(0, group.repaid + carry - group.spent);
      const need = Math.max(0, group.spent - applied);
      const creditCents = card.share_pool_id ? 4000000 : 3000000;
      const tempCents = card.share_pool_id ? 500000 : 0;
      const avail = creditCents + tempCents - (card.share_pool_id ? poolDebt : cumulativeSpent - cumulativeRepaid);
      if (avail < 0) throw new Error(`Mock credit limit exceeded: ${card.alias}`);
      const period = CardBill.calculateBillPeriod(group.month, card.bill_day);
      const due = CardBill.calculateRepayDate(group.month, card.repay_day);
      const overdueDays = need > 0 && due < ctx.end ? Math.round((Date.parse(`${ctx.end}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000) : 0;
      ctx.add('card_bill', {
        id: group.id, card_id: card.id, bill_month: group.month, bill_day: card.bill_day, repay_day: card.repay_day,
        credit_limit: ctx.money(creditCents), temp_limit: ctx.money(tempCents),
        used_limit: ctx.money(group.spent), avail_limit: ctx.money(avail), bill_amount: ctx.money(group.spent),
        bill_start_date: period.billStartDate, bill_end_date: period.billEndDate,
        min_repay: ctx.money(Math.round(group.spent / 10)), repaid: ctx.money(applied), need_repay: ctx.money(need),
        points: Math.round(group.spent / 100), points_rate: '1',
        repay_status: need === 0 ? '已还清' : applied > 0 ? '部分还款' : '未还款',
        is_overdue: overdueDays > 0 ? 1 : 0, overdue_days: overdueDays,
        remind_switch: 1, remind_days: 3, create_time: ctx.at(group.firstDate), update_time: ctx.at(ctx.end),
      });
    }
  }
  ctx.meta.finance = {
    categories, cards, cardsByKey: byKey, dailyTotals, monthlyExpenses,
    incomeCategoryId: categories.salary.id, salaryLedgerByMonth, salaryCentsByMonth,
    installmentLedgerByMonth, openingCentsByCard,
    dailyWageCentsByYear: { 2023: 55000, 2024: 58000, 2025: 62000, 2026: 66000 },
    billGroups: [...groups.values()].map(({ card, ...group }) => ({ ...group, cardId: card.id })),
    finalCreditDebtCentsByCard: Object.fromEntries(Object.keys(spentByCard).map(id => [id, spentByCard[id] - repaidByCard[id]])),
  };
};
