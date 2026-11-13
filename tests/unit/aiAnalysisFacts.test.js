const { enrichAnalysisDatasets, cents, money, percent } = require('../../src/modules/ai/service/analysisFacts');
const { loadDraftContext } = require('../../src/modules/ai/service/draftContext');
function monthly(overrides = {}) {
  return { domain: 'finance', datasetId: 'finance-monthly', columns: [
    { key: 'month', type: 'date' }, { key: 'income', type: 'money' }, { key: 'expense', type: 'money' }],
  rows: [{ month: '2026-05', income: '8160.37', expense: '6644.73', unpricedCount: 0 },
    { month: '2026-06', income: '3911.24', expense: '5784.61', unpricedCount: 0 }],
  summary: { income: '12071.61', expense: '12429.34', unpricedCount: 0, currency: 'CNY' },
  queryMeta: { rowsComplete: true, summaryComplete: true, effectiveScope: { startDate: '2026-05-01', endDate: '2026-06-30' } }, ...overrides };
}
test('publishes exact net and comparable month change without mutating source', () => {
  const source = monthly(), [result] = enrichAnalysisDatasets([source]);
  expect(result.summary).toMatchObject({ net: '-357.73', surplus: '0.00', deficit: '357.73', difference: '-860.12', changePct: '-12.9' });
  expect(result.rows[1]).toMatchObject({ net: '-1873.37', changeAmt: '-860.12', changePct: '-12.9' });
  expect(source.rows[1].net).toBeUndefined();
});
test.each([
  { isEstimated: true },
  { summary: { income: '10.00', expense: '5.00', currency: 'CNY', unpricedCount: 1 } },
  { summary: { income: '10.00', expense: '5.00', currency: 'USD', unpricedCount: 0 } },
  { summary: { income: '10.00', expense: '5.00', currency: 'CNY' } },
  { summary: { income: '10.00', expense: '5.00', currency: 'CNY', unpricedCount: 0, incomplete: true } },
])('unpriced, mixed/unknown currency or incomplete summaries do not get derived financial facts', overrides => {
  const source = monthly(overrides);
  expect(enrichAnalysisDatasets([source])[0]).toBe(source);
});
test('partial month and limited rows cannot support month change', () => {
  for (const queryMeta of [ { ...monthly().queryMeta, rowsComplete: false },
    { ...monthly().queryMeta, effectiveScope: { startDate: '2026-05-15', endDate: '2026-06-30' } }]) {
    expect(enrichAnalysisDatasets([monthly({ queryMeta })])[0].summary.difference).toBeUndefined();
  }
});
test('zero comparison baseline publishes difference and no percentage', () => {
  const source = monthly(); source.rows[0].expense = '0.00';
  expect(enrichAnalysisDatasets([source])[0].summary).toMatchObject({ difference: '5784.61', changePct: null });
});
test('shares use full trusted total even when category rows are limited', () => {
  const source = monthly({ datasetId: 'finance-categories', rows: [{ expense: '200.00', income: '10.00' }],
    summary: { expense: '1000.00', income: '100.00', currency: 'CNY', unpricedCount: 0 }, truncated: true });
  expect(enrichAnalysisDatasets([source])[0].rows[0]).toMatchObject({ expenseSharePct: '20.0', incomeSharePct: '10.0' });
});
test('actual direction/category/amountCNY grouped rows publish same-direction shares', () => {
  const source = monthly({ datasetId: 'finance-categories', columns: [{ key: 'direction', type: 'number' }, { key: 'amountCNY', type: 'money' }],
    rows: [{ direction: 0, amountCNY: '200.00', unpricedCount: 0 }, { direction: 1, amountCNY: '10.00', unpricedCount: 0 }],
    summary: { expense: '1000.00', income: '100.00', currency: 'CNY', unpricedCount: 0 }, truncated: true });
  expect(enrichAnalysisDatasets([source])[0].rows.map(row => row.sharePct)).toEqual(['20.0', '10.0']);
});
test('decimal calculations preserve cents for large values and signed results', () => {
  expect(money(cents('9999999999.99') - cents('0.01'))).toBe('9999999999.98');
  expect(percent(1n, 3n)).toBe('33.3'); expect(percent(-1n, 0n)).toBeNull();
  expect(cents('1.234')).toBeNull();
});
test('draft state is read from owner-bound current conversation and contains no internal IDs', async () => {
  const legacyService = { getDraft: jest.fn(async () => ({ conversationId: 'conversation', status: 'committed', originalText: '今天买菜30元' })) };
  const result = await loadDraftContext({ legacyService, userId: 'owner', conversation: { id: 'conversation', latestDraftId: 'private-draft' } });
  expect(result).toEqual([{ status: 'committed', sourceText: '今天买菜30元' }]);
  expect(legacyService.getDraft).toHaveBeenCalledWith('owner', 'private-draft');
  expect(JSON.stringify(result)).not.toContain('private-draft');
});
test('the dedicated draft-state reader takes precedence over financial enrichment', async () => {
  const legacyService = { getDraftState: jest.fn(async () => ({ conversationId: 'own', status: 'pending', originalText: '午餐8元' })),
    getDraft: jest.fn(() => { throw new Error('Financial enrichment must not run'); }) };
  expect(await loadDraftContext({ legacyService, userId: 'owner', conversation: { id: 'own', latestDraftId: 'private' } }))
    .toEqual([{ status: 'pending', sourceText: '午餐8元' }]);
  expect(legacyService.getDraft).not.toHaveBeenCalled();
});
test('unknown/expired or unrelated conversation drafts never imply pending or committed', async () => {
  const legacyService = { getDraft: jest.fn().mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 'pending', conversationId: 'other' }) };
  const result = await loadDraftContext({ legacyService, userId: 'owner', conversation: { id: 'own', latestDraftId: 'a' },
    history: [{ role: 'assistant', business: { draftIds: ['b'] } }] });
  expect(result).toEqual([{ status: 'unknown', sourceText: null }, { status: 'unknown', sourceText: null }]);
});
