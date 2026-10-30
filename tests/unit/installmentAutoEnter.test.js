/**
 * 分期入账（自动入账共用路径）回归测试
 * =====================================================================
 * 背景（线上真实故障 2026-10-29）：
 *   enterInstallmentUnsafe 的「占坑」语句把变量名写成 occupating，
 *   抛 ReferenceError 且发生在任何写库之前 ⇒ 到期分期永远停在 pending，
 *   自动入账与手动入账全失败，列表状态却仍显示「正常」。
 * 本测试直接跑真实 enterInstallment / autoEnterPending 代码路径（DB 与账务模型打桩），
 * 任何未定义标识符都会在此处直接炸出来。
 */
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn() }));
jest.mock('../../src/modules/account/model/credit', () => ({ create: jest.fn() }));
jest.mock('../../src/modules/card/model/bill', () => ({ getBillMonthByDate: jest.fn() }));
jest.mock('../../src/modules/card/core/CreditCore', () => ({ syncCardBills: jest.fn() }));

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

const db = require('../../src/common/config/db');
const CreditAccount = require('../../src/modules/account/model/credit');
const CardBill = require('../../src/modules/card/model/bill');
const RecurringExpense = require('../../src/modules/recurring/model/index.js');

dayjs.extend(utc);
dayjs.extend(timezone);

const USER = 'U-001';
const ID = 'REC-INSTALLMENT-1';
const today = dayjs().tz('Asia/Shanghai').startOf('day');
const MONTH = today.format('YYYY-MM');
const DUE_PLAN_DATE = today.subtract(1, 'day').format('YYYY-MM-DD');
const FUTURE_MONTH = today.add(1, 'month').format('YYYY-MM');
const FUTURE_PLAN_DATE = today.add(5, 'day').format('YYYY-MM-DD');

let row;
let updates;

function buildRecords(status) {
  return {
    [MONTH]: { status, amount: 100, plan_date: DUE_PLAN_DATE },
    [FUTURE_MONTH]: { status: 'pending', amount: 100, plan_date: FUTURE_PLAN_DATE },
  };
}

function resetRow(status = 'pending') {
  row = {
    id: ID,
    user_id: USER,
    name: '测试分期',
    amount: '100.00',
    repeat_count: 2,
    account_id: JSON.stringify({
      type: 'installment',
      card_id: 'CARD-1',
      card_name: '测试卡',
      billing_day: 20,
      total_periods: 2,
    }),
    month_records: JSON.stringify(buildRecords(status)),
  };
  updates = [];
}

beforeEach(() => {
  resetRow();
  db.execute.mockReset();
  CreditAccount.create.mockReset();
  CreditAccount.create.mockResolvedValue({ id: 'FLOW-1' });
  CardBill.getBillMonthByDate.mockReset();
  CardBill.getBillMonthByDate.mockReturnValue('2099-01');
  db.execute.mockImplementation(async (sql, params = []) => {
    if (/SELECT r\.\*/i.test(sql) && /WHERE r\.id = \?/i.test(sql)) return [[row]];
    if (/UPDATE bus_recurring SET month_records/i.test(sql)) {
      row = { ...row, month_records: params[0] };
      updates.push(JSON.parse(params[0]));
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });
});

test('到期期次可正常入账并落库 entered + 流水ID', async () => {
  const result = await RecurringExpense.enterInstallment(ID, MONTH, USER);

  expect(result).toMatchObject({ flowId: 'FLOW-1', month: MONTH, idx: 1, transDate: DUE_PLAN_DATE });
  expect(CreditAccount.create).toHaveBeenCalledTimes(1);
  expect(CreditAccount.create.mock.calls[0][0]).toMatchObject({
    amount: 100,
    transDate: DUE_PLAN_DATE,
    cardId: 'CARD-1',
  });

  const saved = updates[updates.length - 1][MONTH];
  expect(saved).toMatchObject({
    status: 'entered',
    remark: 'FLOW-1',
    plan_date: DUE_PLAN_DATE,
  });
});

test('重复入账短路为 skipped，不重复建流水', async () => {
  await RecurringExpense.enterInstallment(ID, MONTH, USER);
  const wrote = updates.length;

  const again = await RecurringExpense.enterInstallment(ID, MONTH, USER);
  expect(again.skipped).toBe(true);
  expect(again.flowId).toBe('FLOW-1');
  expect(CreditAccount.create).toHaveBeenCalledTimes(1);
  expect(updates.length).toBe(wrote);
});

test('autoEnterPending（定时扫描/列表读取入口）只入到期期次，未来期跳过', async () => {
  const changed = await RecurringExpense.autoEnterPending(ID, USER);

  expect(changed).toBe(true); // 有写入 ⇒ 列表必须重查快照
  expect(CreditAccount.create).toHaveBeenCalledTimes(1);
  const records = JSON.parse(row.month_records);
  expect(records[MONTH].status).toBe('entered');
  expect(records[MONTH].remark).toBe('FLOW-1');
  expect(records[FUTURE_MONTH].status).toBe('pending');

  // 再跑一次：只剩未来期，未写入 ⇒ 返回 false（列表无需重查）
  expect(await RecurringExpense.autoEnterPending(ID, USER)).toBe(false);
  expect(CreditAccount.create).toHaveBeenCalledTimes(1);
});
