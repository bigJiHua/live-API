jest.mock('../../src/modules/account/model/debit', () => ({ create: jest.fn().mockResolvedValue({ id: 'record' }) }));
jest.mock('../../src/modules/account/model/credit', () => ({ create: jest.fn().mockResolvedValue({ id: 'record' }) }));
const debit = require('../../src/modules/account/model/debit');
const credit = require('../../src/modules/account/model/credit');
const debitController = require('../../src/modules/account/controller/debit');
const creditController = require('../../src/modules/account/controller/credit');

test.each([[debitController, debit], [creditController, credit]])('create identity always comes from authentication', async (controller, model) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await controller.create({ userId: 'authenticated', body: { data: { userId: 'injected', amount: 1 } } }, res);
  expect(model.create).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'authenticated' }));
});
