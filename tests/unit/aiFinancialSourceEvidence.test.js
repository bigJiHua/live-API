/** Source conflict review uses explicit in-memory infrastructure and never opens a database or provider. */
jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw new Error('Public DB forbidden'); }),
  getConnection: jest.fn(() => { throw new Error('Public DB forbidden'); }) }));
jest.mock('mysql2/promise', () => ({ createPool: jest.fn(() => { throw new Error('MySQL forbidden'); }) }));
const crypto = require('crypto');
const sharp = require('sharp');
const { createTestService, createMemoryDraftStore, createMemoryCandidateStore } = require('../helpers/aiFixture');
let image;
beforeAll(async () => {
  image = { dataUrl: 'data:image/png;base64,' + (await sharp({ create: { width: 16, height: 16, channels: 3,
    background: '#ffffff' } }).png().toBuffer()).toString('base64') };
});
const extraction = (changes = {}) => ({ documentType: 'payment', truncated: false, warnings: [], items: [{
  direction: 0, amount: '10.00', currency: 'CNY', transDate: '2026-11-05', merchant: '停车场', payMethod: '微信',
  accountHint: null, remark: '停车费', categoryHint: '餐饮', confidence: 'high', transactionStatus: 'completed', transactionKind: 'ordinary',
  evidence: { dateText: '2026-11-05', amountText: '10.00元', statusText: '支付成功', kindText: '消费支出' }, ...changes,
}] });
function fixture(result = extraction()) {
  const recognizeImage = jest.fn(async () => structuredClone(result)), chat = jest.fn(() => { throw new Error('Chat forbidden'); });
  const draftStore = createMemoryDraftStore(); draftStore.save = jest.fn(draftStore.save.bind(draftStore));
  const candidateStore = createMemoryCandidateStore({ now: () => new Date('2026-11-05T08:00:00Z') });
  candidateStore.save = jest.fn(candidateStore.save.bind(candidateStore));
  const service = createTestService({ recognizeImage, chat, draftStore, candidateStore });
  return { service, recognizeImage, chat, draftStore, candidateStore };
}
const complete = (f, candidate) => f.service.createLocalTransactionDraft('owner', { requestId: crypto.randomUUID(), sourceCandidateId: candidate.id,
  fields: { amount: '10.00', direction: 0, currency: 'CNY', transDate: '2026-11-05', accountId: 'fixture_cash',
    categoryId: 'fixture_food', payMethod: '微信', remark: '普通停车支出' } });
afterEach(() => {
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('mysql2/promise').createPool).not.toHaveBeenCalled();
});

test.each(['USD10.00', '10.00美元', '€10.00', 'JPY10.00', '$10.00', '1,00', '1e1'])(
  'CNY model label cannot override missing/foreign/invalid amount evidence %s', async amountText => {
    const f = fixture(extraction({ evidence: { dateText: '2026-11-05', amountText, statusText: '支付成功', kindText: '消费支出' } }));
    const initial = await f.service.runOcr('owner', { image, consent: true });
    expect(initial.draft).toBeNull(); expect(initial.inputCandidate).toBeNull();
    const candidate = await f.candidateStore.save.mock.results[0].value;
    expect(candidate.eligible).toBe(false);
    await expect(complete(f, candidate)).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED' });
    const repeated = await f.service.runOcr('owner', { image, consent: true });
    expect(repeated.inputCandidate.id).toBe(candidate.id);
    expect(f.recognizeImage).toHaveBeenCalledTimes(1); expect(f.chat).not.toHaveBeenCalled(); expect(f.draftStore.save).not.toHaveBeenCalled();
  });

test.each(['明天支出10元', '2026-11-06支出10元', '2026-02-30支出10元'])(
  'future or invalid explicit source date %s cannot be laundered by a corrected local date', async message => {
    const f = fixture(), initial = await f.service.runOcr('owner', { image, consent: true, message });
    const candidate = initial.inputCandidate || await f.candidateStore.save.mock.results[0].value;
    await expect(complete(f, candidate)).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED' });
    expect(f.recognizeImage).toHaveBeenCalledTimes(1); expect(f.chat).not.toHaveBeenCalled(); expect(f.draftStore.save).not.toHaveBeenCalled();
  });

test('one malformed evidence field among otherwise confident completed payment fields keeps the whole source non-executable', async () => {
  const f = fixture(extraction({ evidence: { dateText: '11-05', amountText: '10.00元', statusText: '支付成功', kindText: '消费支出' } }));
  const initial = await f.service.runOcr('owner', { image, consent: true });
  const candidate = await f.candidateStore.save.mock.results[0].value;
  expect(initial.inputCandidate).toBeNull(); expect(candidate.eligible).toBe(false);
  await expect(complete(f, candidate)).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED' });
  expect(f.draftStore.save).not.toHaveBeenCalled(); expect(f.recognizeImage).toHaveBeenCalledTimes(1);
});

test.each([['1,00', '100.00'], ['1e2', '12.00'], ['10元或20元', '1020.00']])(
  'invalid OCR syntax %s remains ineligible even when the model amount equals the digits-only result %s', async (amountText, amount) => {
    const f = fixture(extraction({ amount, evidence: { dateText: '2026-11-05', amountText, statusText: '支付成功', kindText: '消费支出' } }));
    const initial = await f.service.runOcr('owner', { image, consent: true });
    expect(initial.ocr.items[0]).toMatchObject({ amount, evidence: { amountText: null } });
    expect(initial.inputCandidate).toBeNull(); expect(initial.draft).toBeNull();
    const candidate = await f.candidateStore.save.mock.results[0].value;
    expect(candidate.eligible).toBe(false);
    await expect(complete(f, candidate)).rejects.toMatchObject({ code: 'AI_FINANCIAL_CHECK_BLOCKED' });
    expect(f.draftStore.save).not.toHaveBeenCalled(); expect(f.chat).not.toHaveBeenCalled(); expect(f.recognizeImage).toHaveBeenCalledTimes(1);
  });
