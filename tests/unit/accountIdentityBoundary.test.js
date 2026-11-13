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

test.each([true,false])('ordinary debit controller rejects forged transfer group on encrypted and plaintext input',async(nested)=>{
  debit.create.mockClear();
  const payload={payType:'餐饮',transferGroupId:'forged-group',amount:1},res={status:jest.fn().mockReturnThis(),json:jest.fn()};
  await debitController.create({userId:'authenticated',body:nested?{data:payload}:payload},res);
  expect(debit.create).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(400);
});

test('credit controller rejects transfer groups even when caller claims a transfer type',async()=>{
  credit.create.mockClear();
  const res={status:jest.fn().mockReturnThis(),json:jest.fn()};
  await creditController.create({userId:'authenticated',body:{data:{payType:'转账',transferGroupId:'forged-group'}}},res);
  expect(credit.create).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(400);
});

test('create schema rejects ordinary group but allows legacy transfer correlation for model validation',()=>{
  const rules=require('../../src/modules/account/rules');
  const fields={direction:0,categoryId:'category-id',payType:'餐饮',payMethod:'银行卡',amount:1,transDate:'2026-11-06',cardId:'card-id'};
  expect(rules.create.body.validate({data:{...fields,transferGroupId:'forged-group'}}).error).toBeDefined();
  expect(rules.create.body.validate({data:{...fields,payType:'转账',transferGroupId:'legacy-group'}}).error).toBeUndefined();
});
