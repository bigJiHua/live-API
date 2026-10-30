/**
 * 分期列表读取回归：自动入账后必须重查快照
 * =====================================================================
 * 背景：installments 接口先用 findAll 取 rows，再 autoEnterPending 写库，
 * 若继续用入账前的 row 做 decorate，本次响应会把刚入账的期次仍标成 pending，
 * 前端表现为「已到时间却没入账」，要再刷新一次才正常。
 */
jest.mock('../../src/modules/recurring/model', () => ({
  findAll: jest.fn(),
  autoEnterPending: jest.fn(),
  decorateInstallmentStatus: jest.fn(),
}));

const RecurringExpense = require('../../src/modules/recurring/model');
const controller = require('../../src/modules/recurring/controller');

const USER = 'U-001';

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  RecurringExpense.decorateInstallmentStatus.mockImplementation(async (row) => row.month_records);
});

test('autoEnterPending 有写入 → 重新 findAll，响应使用入账后的新快照', async () => {
  const staleRow = { id: 'R1', month_records: { '2026-10': { status: 'pending' } } };
  const freshRow = { id: 'R1', month_records: { '2026-10': { status: 'entered' } } };
  RecurringExpense.findAll.mockResolvedValueOnce([staleRow]).mockResolvedValueOnce([freshRow]);
  RecurringExpense.autoEnterPending.mockResolvedValue(true);

  const res = mockRes();
  await controller.installments({ userId: USER }, res);

  expect(RecurringExpense.findAll).toHaveBeenCalledTimes(2);
  const body = res.json.mock.calls[0][0];
  expect(body.data[0].month_records['2026-10'].status).toBe('entered');
});

test('autoEnterPending 未写入 → 不重复查库，沿用首次快照', async () => {
  const row = { id: 'R1', month_records: { '2026-10': { status: 'pending' } } };
  RecurringExpense.findAll.mockResolvedValueOnce([row]);
  RecurringExpense.autoEnterPending.mockResolvedValue(false);

  const res = mockRes();
  await controller.installments({ userId: USER }, res);

  expect(RecurringExpense.findAll).toHaveBeenCalledTimes(1);
  const body = res.json.mock.calls[0][0];
  expect(body.data[0].month_records['2026-10'].status).toBe('pending');
});
